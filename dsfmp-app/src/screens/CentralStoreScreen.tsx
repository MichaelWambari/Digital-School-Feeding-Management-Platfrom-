import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  FlatList,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { supabase } from '../lib/supabase';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { FadeInScrollView, PressableScale } from '../components/Motion';

// The network admin's Inventory: the central store that food is
// dispatched from. Each food on the network's food list has one row.

type Food = {
  food_id: string;
  item_name: string;
  quantity_available: number;
  unit: string;
  reorder_level: number;
};

type Movement = {
  transaction_id: string;
  transaction_type: 'received' | 'written_off' | 'dispatched' | 'returned';
  quantity: number;
  transaction_date: string;
  food_distribution: { schools: { name: string } | null } | null;
};

type FoodForm = { item_name: string; unit: string; reorder_level: string };

const EMPTY_FOOD_FORM: FoodForm = { item_name: '', unit: 'kg', reorder_level: '0' };

const MOVEMENT_LABELS: Record<Movement['transaction_type'], string> = {
  received: 'Delivery received',
  written_off: 'Written off',
  dispatched: 'Dispatched',
  returned: 'Dispatch cancelled',
};

const NO_PERMISSION = 'Only network admins can change the central store.';
const CONNECTION_ERROR = 'Unable to connect. Check your connection and try again.';

function isLowStock(food: Food) {
  return food.reorder_level > 0 && food.quantity_available <= food.reorder_level;
}

function formatQty(qty: number, unit: string | null) {
  return `${Number(qty).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${unit ?? ''}`.trim();
}

// Local calendar date as YYYY-MM-DD, matching how the rest of the app saves dates.
function todayLocal() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default function CentralStoreScreen({ navigation }: any) {
  const { styles } = useThemedStyles(makeStyles);
  const [foods, setFoods] = useState<Food[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Which view is showing: the list, the add/edit food form, or one food's stock detail.
  const [formTarget, setFormTarget] = useState<Food | 'new' | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  const loadFoods = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('food_items')
      .select('food_id, item_name, quantity_available, unit, reorder_level')
      .order('item_name');
    if (error) {
      setLoadError(error.message);
    } else {
      setLoadError(null);
      setFoods(data ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadFoods();
  }, [loadFoods]);

  if (formTarget) {
    return (
      <FoodFormView
        target={formTarget}
        onDone={async (saved) => {
          setFormTarget(null);
          if (saved) await loadFoods();
        }}
      />
    );
  }

  const detailFood = detailId ? foods.find((f) => f.food_id === detailId) : undefined;
  if (detailFood) {
    return (
      <StockDetailView
        food={detailFood}
        onBack={() => setDetailId(null)}
        onEdit={() => setFormTarget(detailFood)}
        onStockChanged={loadFoods}
      />
    );
  }

  const lowCount = foods.filter(isLowStock).length;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <PressableScale onPress={() => navigation.goBack()}>
          <Text style={styles.link}>‹ Back</Text>
        </PressableScale>
        <Text style={styles.headerTitle}>Central store</Text>
        <PressableScale onPress={() => setFormTarget('new')}>
          <Text style={[styles.link, styles.linkStrong]}>+ Food</Text>
        </PressableScale>
      </View>

      <View style={styles.summary}>
        <Text style={styles.summaryNumber}>{foods.length}</Text>
        <Text style={styles.summaryLabel}>
          foods · {lowCount === 0 ? 'none low on stock' : `${lowCount} low on stock`}
        </Text>
      </View>

      <Text style={styles.hint}>
        Food dispatched from here goes to the schools. Each school's own stock is on the
        Distribution screen.
      </Text>

      {loadError && <Text style={styles.error}>Could not load the central store: {loadError}</Text>}

      <FlatList
        data={foods}
        keyExtractor={(f) => f.food_id}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={loadFoods} />}
        ListEmptyComponent={
          loading ? null : (
            <Text style={styles.empty}>No foods yet. Add the foods the network supplies.</Text>
          )
        }
        renderItem={({ item }) => (
          <PressableScale style={styles.row} onPress={() => setDetailId(item.food_id)}>
            <View style={styles.rowMain}>
              <Text style={styles.rowName}>{item.item_name}</Text>
              <Text style={styles.rowMeta}>Reorder at {formatQty(item.reorder_level, item.unit)}</Text>
            </View>
            <View style={styles.rowRight}>
              <Text style={styles.rowQty}>{formatQty(item.quantity_available, item.unit)}</Text>
              {isLowStock(item) && <Text style={styles.lowBadge}>Low stock</Text>}
            </View>
          </PressableScale>
        )}
      />
    </View>
  );
}

function FoodFormView({
  target,
  onDone,
}: {
  target: Food | 'new';
  onDone: (saved: boolean) => void;
}) {
  const { colors, styles } = useThemedStyles(makeStyles);
  const [form, setForm] = useState<FoodForm>(
    target === 'new'
      ? EMPTY_FOOD_FORM
      : {
          item_name: target.item_name,
          unit: target.unit,
          reorder_level: String(target.reorder_level),
        }
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    const itemName = form.item_name.trim();
    const unit = form.unit.trim();
    const reorderLevel = Number(form.reorder_level.trim() || '0');
    if (!itemName || !unit) {
      setError('Name and unit are required.');
      return;
    }
    if (!Number.isFinite(reorderLevel) || reorderLevel < 0) {
      setError('Reorder level must be zero or a positive number.');
      return;
    }

    // Only these columns are writable; quantity_available changes through movements.
    const payload = { item_name: itemName, unit, reorder_level: reorderLevel };

    setSaving(true);
    setError(null);
    try {
      const query =
        target === 'new'
          ? supabase.from('food_items').insert(payload)
          : supabase.from('food_items').update(payload).eq('food_id', target.food_id);
      // .select() makes RLS-blocked updates visible: they succeed with zero rows.
      const { data, error } = await query.select('food_id');
      if (error) {
        if (error.code === '23505') setError(`${itemName} is already on the food list.`);
        else setError(error.code === '42501' ? NO_PERMISSION : error.message);
        return;
      }
      if (!data || data.length === 0) {
        setError(NO_PERMISSION);
        return;
      }
      onDone(true);
    } catch {
      setError(CONNECTION_ERROR);
    } finally {
      setSaving(false);
    }
  }

  return (
    <FadeInScrollView style={styles.container} keyboardShouldPersistTaps="handled">
      <View style={styles.header}>
        <PressableScale onPress={() => onDone(false)} disabled={saving}>
          <Text style={styles.link}>‹ Cancel</Text>
        </PressableScale>
        <Text style={styles.headerTitle}>{target === 'new' ? 'Add food' : 'Edit food'}</Text>
        <View style={styles.headerSpacer} />
      </View>

      <Text style={styles.label}>Name *</Text>
      <TextInput
        style={styles.input}
        placeholderTextColor={colors.placeholder}
        value={form.item_name}
        onChangeText={(item_name) => setForm({ ...form, item_name })}
        placeholder="e.g. Maize flour"
      />

      <Text style={styles.label}>Unit *</Text>
      <TextInput
        style={styles.input}
        placeholderTextColor={colors.placeholder}
        value={form.unit}
        onChangeText={(unit) => setForm({ ...form, unit })}
        autoCapitalize="none"
        placeholder="e.g. kg, litres, packets"
      />

      <Text style={styles.label}>Reorder level</Text>
      <TextInput
        style={styles.input}
        placeholderTextColor={colors.placeholder}
        value={form.reorder_level}
        onChangeText={(reorder_level) => setForm({ ...form, reorder_level })}
        keyboardType="decimal-pad"
        placeholder="Warn when the central store falls to this amount"
      />

      <Text style={styles.hint}>
        {target === 'new'
          ? "New foods start at zero. Record a delivery from the food's page to add stock."
          : 'Schools use the same name and unit, so change them only to correct a mistake.'}
      </Text>

      {error && <Text style={styles.error}>{error}</Text>}

      <PressableScale style={styles.button} onPress={handleSave} disabled={saving}>
        {saving ? (
          <ActivityIndicator color={colors.onPrimary} />
        ) : (
          <Text style={styles.buttonText}>Save</Text>
        )}
      </PressableScale>
    </FadeInScrollView>
  );
}

function StockDetailView({
  food,
  onBack,
  onEdit,
  onStockChanged,
}: {
  food: Food;
  onBack: () => void;
  onEdit: () => void;
  onStockChanged: () => Promise<void>;
}) {
  const { colors, styles } = useThemedStyles(makeStyles);
  const [type, setType] = useState<'received' | 'written_off'>('received');
  const [quantity, setQuantity] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState<Movement[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    const { data, error } = await supabase
      .from('central_transactions')
      .select(
        'transaction_id, transaction_type, quantity, transaction_date, food_distribution(schools(name))'
      )
      .eq('food_id', food.food_id)
      .order('created_at', { ascending: false })
      .limit(15);
    if (!error) setHistory((data ?? []) as unknown as Movement[]);
    setHistoryLoading(false);
  }, [food.food_id]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  async function handleRecord() {
    const qty = Number(quantity.trim());
    if (!Number.isFinite(qty) || qty <= 0) {
      setError('Enter a quantity greater than zero.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const { data: auth } = await supabase.auth.getUser();
      // A database trigger updates quantity_available and rejects overdrawn stock.
      const { error } = await supabase.from('central_transactions').insert({
        food_id: food.food_id,
        transaction_type: type,
        quantity: qty,
        transaction_date: todayLocal(),
        recorded_by: auth.user?.id ?? null,
      });
      if (error) {
        if (error.code === '23514') {
          setError(`Not enough stock: only ${formatQty(food.quantity_available, food.unit)} in the store.`);
        } else if (error.code === '42501') {
          setError(NO_PERMISSION);
        } else {
          setError(error.message);
        }
        return;
      }
      setQuantity('');
      await Promise.all([onStockChanged(), loadHistory()]);
    } catch {
      setError(CONNECTION_ERROR);
    } finally {
      setSaving(false);
    }
  }

  return (
    <FadeInScrollView style={styles.container} keyboardShouldPersistTaps="handled">
      <View style={styles.header}>
        <PressableScale onPress={onBack} disabled={saving}>
          <Text style={styles.link}>‹ Central store</Text>
        </PressableScale>
        <PressableScale onPress={onEdit} disabled={saving}>
          <Text style={styles.link}>Edit</Text>
        </PressableScale>
      </View>

      <Text style={styles.detailTitle}>{food.item_name}</Text>
      <View style={[styles.summary, isLowStock(food) && styles.summaryLow]}>
        <Text style={styles.summaryNumber}>{formatQty(food.quantity_available, food.unit)}</Text>
        <Text style={styles.summaryLabel}>
          in the central store · reorder at {formatQty(food.reorder_level, food.unit)}
          {isLowStock(food) ? ' · LOW' : ''}
        </Text>
      </View>

      <Text style={styles.sectionTitle}>Record stock movement</Text>
      <View style={styles.segment}>
        {(['received', 'written_off'] as const).map((t) => (
          <PressableScale
            key={t}
            style={[styles.segmentItem, type === t && styles.segmentItemActive]}
            onPress={() => setType(t)}
            accessibilityState={{ selected: type === t }}
          >
            <Text style={[styles.segmentText, type === t && styles.segmentTextActive]}>
              {t === 'received' ? 'Delivery received' : 'Write off'}
            </Text>
          </PressableScale>
        ))}
      </View>
      <Text style={styles.hint}>
        {type === 'received'
          ? 'Food delivered to the store by a supplier or donor.'
          : 'Food lost, spoiled or counted short. Use Distribution to send food to a school.'}
      </Text>

      <Text style={styles.label}>Quantity ({food.unit})</Text>
      <TextInput
        style={styles.input}
        placeholderTextColor={colors.placeholder}
        value={quantity}
        onChangeText={setQuantity}
        keyboardType="decimal-pad"
        placeholder="0"
      />

      {error && <Text style={styles.error}>{error}</Text>}

      <PressableScale style={styles.button} onPress={handleRecord} disabled={saving}>
        {saving ? (
          <ActivityIndicator color={colors.onPrimary} />
        ) : (
          <Text style={styles.buttonText}>
            {type === 'received' ? 'Add to store' : 'Remove from store'}
          </Text>
        )}
      </PressableScale>

      <Text style={styles.sectionTitle}>Recent movements</Text>
      {historyLoading ? (
        <ActivityIndicator style={styles.historyLoading} />
      ) : history.length === 0 ? (
        <Text style={styles.emptyLeft}>No stock movements recorded yet.</Text>
      ) : (
        history.map((t) => {
          const isIn = t.transaction_type === 'received' || t.transaction_type === 'returned';
          const school = t.food_distribution?.schools?.name;
          return (
            <View key={t.transaction_id} style={styles.row}>
              <View style={styles.rowMain}>
                <Text style={styles.rowName}>
                  {MOVEMENT_LABELS[t.transaction_type]}
                  {school ? (t.transaction_type === 'returned' ? ` (${school})` : ` to ${school}`) : ''}
                </Text>
                <Text style={styles.rowMeta}>{t.transaction_date}</Text>
              </View>
              <Text style={isIn ? styles.qtyIn : styles.qtyOut}>
                {isIn ? '+' : '−'}
                {formatQty(t.quantity, food.unit)}
              </Text>
            </View>
          );
        })
      )}
      <View style={styles.bottomSpacer} />
    </FadeInScrollView>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background, padding: 20 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  headerTitle: { fontSize: 20, fontWeight: '700', color: c.text },
  headerSpacer: { width: 60 },
  link: { color: c.primary, fontSize: 15 },
  linkStrong: { fontWeight: '600' },
  detailTitle: { fontSize: 22, fontWeight: '700', marginBottom: 12, color: c.text },
  sectionTitle: { fontSize: 15, fontWeight: '600', marginTop: 24, marginBottom: 10, color: c.text },
  summary: { backgroundColor: c.surface, borderRadius: 12, padding: 16, marginBottom: 12 },
  summaryLow: { backgroundColor: c.warningBg },
  summaryNumber: { fontSize: 26, fontWeight: '700', color: c.text },
  summaryLabel: { fontSize: 13, color: c.textMuted, marginTop: 2 },
  label: { fontSize: 13, color: c.textSecondary, marginBottom: 6, marginTop: 12 },
  input: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: c.text,
  },
  hint: { fontSize: 13, color: c.textMuted, marginTop: 8, marginBottom: 4 },
  segment: { flexDirection: 'row', borderWidth: 1, borderColor: c.border, borderRadius: 8 },
  segmentItem: { flex: 1, paddingVertical: 10, alignItems: 'center' },
  segmentItemActive: { backgroundColor: c.primary, borderRadius: 7 },
  segmentText: { fontSize: 14, color: c.textSecondary },
  segmentTextActive: { color: c.onPrimary, fontWeight: '600' },
  error: { color: c.danger, fontSize: 13, marginTop: 12 },
  button: {
    backgroundColor: c.primary,
    borderRadius: 8,
    paddingVertical: 14,
    marginTop: 20,
    alignItems: 'center',
  },
  buttonText: { color: c.onPrimary, fontSize: 16, fontWeight: '600' },
  empty: { textAlign: 'center', color: c.textMuted, marginTop: 32 },
  emptyLeft: { color: c.textMuted },
  historyLoading: { marginTop: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: c.divider,
  },
  rowMain: { flex: 1 },
  rowName: { fontSize: 16, color: c.text },
  rowMeta: { fontSize: 13, color: c.textMuted, marginTop: 2 },
  rowRight: { alignItems: 'flex-end' },
  rowQty: { fontSize: 16, fontWeight: '600', color: c.text },
  lowBadge: {
    fontSize: 12,
    color: c.warningText,
    backgroundColor: c.warningBg,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
    overflow: 'hidden',
    marginTop: 4,
  },
  qtyIn: { color: c.successText, fontWeight: '600' },
  qtyOut: { color: c.danger, fontWeight: '600' },
  bottomSpacer: { height: 40 },
});
