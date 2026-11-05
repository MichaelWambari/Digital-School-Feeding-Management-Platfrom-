import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, FlatList, RefreshControl } from 'react-native';
import { ActivityIndicator, Divider, HelperText, Text } from 'react-native-paper';
import { supabase } from '../lib/supabase';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { FadeInScrollView } from '../components/Motion';
import { Button, ListItem, SegmentedButtons } from '../components/Paper';
import {
  EmptyText,
  Field,
  MovementRow,
  QuantityField,
  ScreenHeader,
  StatCard,
  StatusPill,
} from '../components/ScreenParts';
import { formatPacks, formatQty, formatStock, packDescription, packName, toBaseQuantity } from '../lib/units';

// The network admin's Inventory: the central store that food is
// dispatched from. Each food on the network's food list has one row.

type Food = {
  food_id: string;
  item_name: string;
  quantity_available: number;
  unit: string;
  reorder_level: number;
  // kg per bag (litres per jerrycan); null if the food isn't bagged.
  pack_size: number | null;
};

type Movement = {
  transaction_id: string;
  transaction_type: 'received' | 'written_off' | 'dispatched' | 'returned';
  quantity: number;
  transaction_date: string;
  food_distribution: { schools: { name: string } | null } | null;
};

type FoodForm = { item_name: string; unit: string; reorder_level: string; pack_size: string };

const EMPTY_FOOD_FORM: FoodForm = { item_name: '', unit: 'kg', reorder_level: '0', pack_size: '' };

// Every food is measured in one of these (the database allows no others).
const UNITS = [
  { value: 'kg', label: 'Kilograms (kg)', icon: 'weight-kilogram' },
  { value: 'litres', label: 'Litres', icon: 'water-outline' },
];

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

// Local calendar date as YYYY-MM-DD, matching how the rest of the app saves dates.
function todayLocal() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default function CentralStoreScreen({ navigation }: any) {
  const { colors, styles } = useThemedStyles(makeStyles);
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
      // '*' rather than a column list, so the screen still loads before
      // fix 008 adds pack_size (food then just shows as not bagged).
      .select('*')
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
      <ScreenHeader
        title="Central store"
        onBack={() => navigation.goBack()}
        right={
          <Button mode="text" icon="plus" onPress={() => setFormTarget('new')}>
            Food
          </Button>
        }
      />

      <StatCard
        value={foods.length}
        label={`foods · ${lowCount === 0 ? 'none low on stock' : `${lowCount} low on stock`}`}
        tone={lowCount > 0 ? 'warning' : 'default'}
      />

      <Text variant="bodySmall" style={styles.hint}>
        Food dispatched from here goes to the schools. Each school's own stock is on the
        Distribution screen.
      </Text>

      {loadError && <HelperText type="error">Could not load the central store: {loadError}</HelperText>}

      <FlatList
        data={foods}
        keyExtractor={(f) => f.food_id}
        ItemSeparatorComponent={Divider}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={loadFoods} tintColor={colors.primary} />
        }
        ListEmptyComponent={
          loading ? undefined : <EmptyText>No foods yet. Add the foods the network supplies.</EmptyText>
        }
        renderItem={({ item }) => (
          <ListItem
            title={item.item_name}
            description={[
              formatPacks(item.quantity_available, item),
              `Reorder at ${formatQty(item.reorder_level, item.unit)}`,
            ]
              .filter(Boolean)
              .join('\n')}
            descriptionNumberOfLines={2}
            onPress={() => setDetailId(item.food_id)}
            style={styles.row}
            contentStyle={styles.rowContent}
            right={() => (
              <View style={styles.rowRight}>
                <Text variant="titleMedium" style={styles.rowQty}>
                  {formatQty(item.quantity_available, item.unit)}
                </Text>
                {isLowStock(item) && <StatusPill label="Low stock" tone="warning" style={styles.lowPill} />}
              </View>
            )}
          />
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
  const { styles } = useThemedStyles(makeStyles);
  const [form, setForm] = useState<FoodForm>(
    target === 'new'
      ? EMPTY_FOOD_FORM
      : {
          item_name: target.item_name,
          unit: target.unit,
          reorder_level: String(target.reorder_level),
          pack_size: target.pack_size ? String(target.pack_size) : '',
        }
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    const itemName = form.item_name.trim();
    const unit = form.unit;
    const reorderLevel = Number(form.reorder_level.trim() || '0');
    if (!itemName) {
      setError('Name is required.');
      return;
    }
    if (!UNITS.some((u) => u.value === unit)) {
      setError('Choose kg or litres.');
      return;
    }
    if (!Number.isFinite(reorderLevel) || reorderLevel < 0) {
      setError('Reorder level must be zero or a positive number.');
      return;
    }
    // Empty means the food isn't bagged.
    const packSize = form.pack_size.trim() ? Number(form.pack_size.trim()) : null;
    if (packSize !== null && (!Number.isFinite(packSize) || packSize <= 0)) {
      setError(`The ${packName({ unit })} size must be a number greater than zero, or empty.`);
      return;
    }

    // Only these columns are writable; quantity_available changes through movements.
    const payload = { item_name: itemName, unit, reorder_level: reorderLevel, pack_size: packSize };

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
      <ScreenHeader
        title={target === 'new' ? 'Add food' : 'Edit food'}
        onBack={() => onDone(false)}
        backLabel="Cancel"
        backDisabled={saving}
      />

      <Field
        label="Name *"
        value={form.item_name}
        onChangeText={(item_name) => setForm({ ...form, item_name })}
        placeholder="e.g. Maize flour"
      />
      <Text variant="labelLarge" style={styles.label}>Measured in</Text>
      <SegmentedButtons
        value={form.unit}
        onValueChange={(unit) => setForm({ ...form, unit })}
        buttons={UNITS.map((u) => ({ value: u.value, label: u.label, icon: u.icon }))}
      />
      <Field
        label={`${form.unit === 'litres' ? 'Litres per jerrycan' : 'Kg per bag'}`}
        value={form.pack_size}
        onChangeText={(pack_size) => setForm({ ...form, pack_size })}
        keyboardType="decimal-pad"
        placeholder={`e.g. ${form.unit === 'litres' ? '20' : '90'}; leave empty if not bagged`}
      />
      <Field
        label={`Reorder level (${form.unit})`}
        value={form.reorder_level}
        onChangeText={(reorder_level) => setForm({ ...form, reorder_level })}
        keyboardType="decimal-pad"
        placeholder="Warn when the central store falls to this amount"
      />

      <Text variant="bodySmall" style={styles.hint}>
        {target === 'new'
          ? "New foods start at zero. Record a delivery from the food's page to add stock."
          : 'Schools use the same name and unit, so change them only to correct a mistake.'}
      </Text>

      <HelperText type="error" visible={!!error}>
        {error}
      </HelperText>

      <Button
        mode="contained"
        onPress={handleSave}
        loading={saving}
        disabled={saving}
        contentStyle={styles.buttonContent}
      >
        Save
      </Button>
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
  const { styles } = useThemedStyles(makeStyles);
  const [type, setType] = useState<'received' | 'written_off'>('received');
  const [quantity, setQuantity] = useState('');
  // Deliveries usually arrive in bags, so bagged food starts in bags.
  const [inPacks, setInPacks] = useState(!!food.pack_size);
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
    const qty = toBaseQuantity(quantity, inPacks, food);
    if (!quantity.trim() || !Number.isFinite(qty) || qty <= 0) {
      setError('Enter a quantity greater than zero.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const { data: auth } = await supabase.auth.getUser();
      // A database trigger updates quantity_available and rejects overdrawn stock.
      // The amount is always saved in kg or litres.
      const { error } = await supabase.from('central_transactions').insert({
        food_id: food.food_id,
        transaction_type: type,
        quantity: qty,
        transaction_date: todayLocal(),
        recorded_by: auth.user?.id ?? null,
      });
      if (error) {
        if (error.code === '23514') {
          setError(`Not enough stock: only ${formatStock(food.quantity_available, food)} in the store.`);
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
      <ScreenHeader
        title={food.item_name}
        onBack={onBack}
        backLabel="Back to Central store"
        backDisabled={saving}
        right={
          <Button mode="text" icon="pencil-outline" onPress={onEdit} disabled={saving}>
            Edit
          </Button>
        }
      />

      <StatCard
        value={formatQty(food.quantity_available, food.unit)}
        label={[
          formatPacks(food.quantity_available, food),
          `in the central store · reorder at ${formatQty(food.reorder_level, food.unit)}${
            isLowStock(food) ? ' · LOW' : ''
          }`,
          packDescription(food) ? `Comes in ${packDescription(food)}` : null,
        ]
          .filter(Boolean)
          .join('\n')}
        tone={isLowStock(food) ? 'warning' : 'default'}
      />

      <Text variant="titleSmall" style={styles.sectionTitle}>Record stock movement</Text>
      <SegmentedButtons
        value={type}
        onValueChange={(t) => setType(t as typeof type)}
        buttons={[
          { value: 'received', label: 'Delivery received', icon: 'truck-check-outline' },
          { value: 'written_off', label: 'Write off', icon: 'delete-outline' },
        ]}
      />
      <Text variant="bodySmall" style={styles.hint}>
        {type === 'received'
          ? 'Food delivered to the store by a supplier or donor.'
          : 'Food lost, spoiled or counted short. Use Distribution to send food to a school.'}
      </Text>

      <QuantityField
        label="Quantity"
        value={quantity}
        onChangeText={setQuantity}
        inPacks={inPacks}
        onInPacksChange={setInPacks}
        food={food}
      />

      <HelperText type="error" visible={!!error}>
        {error}
      </HelperText>

      <Button
        mode="contained"
        icon={type === 'received' ? 'plus' : 'minus'}
        onPress={handleRecord}
        loading={saving}
        disabled={saving}
        contentStyle={styles.buttonContent}
      >
        {type === 'received' ? 'Add to store' : 'Remove from store'}
      </Button>

      <Text variant="titleSmall" style={styles.sectionTitle}>Recent movements</Text>
      {historyLoading ? (
        <ActivityIndicator style={styles.historyLoading} />
      ) : history.length === 0 ? (
        <Text variant="bodyMedium" style={styles.emptyLeft}>No stock movements recorded yet.</Text>
      ) : (
        history.map((t, index) => {
          const isIn = t.transaction_type === 'received' || t.transaction_type === 'returned';
          const school = t.food_distribution?.schools?.name;
          return (
            <MovementRow
              key={t.transaction_id}
              first={index === 0}
              title={
                MOVEMENT_LABELS[t.transaction_type] +
                (school ? (t.transaction_type === 'returned' ? ` (${school})` : ` to ${school}`) : '')
              }
              date={t.transaction_date}
              amount={formatQty(t.quantity, food.unit)}
              direction={isIn ? 'in' : 'out'}
            />
          );
        })
      )}
      <View style={styles.bottomSpacer} />
    </FadeInScrollView>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background, padding: 20 },
  sectionTitle: { marginTop: 20, marginBottom: 10, color: c.text },
  hint: { color: c.textMuted, marginTop: 8, marginBottom: 4 },
  label: { color: c.textSecondary, marginTop: 16, marginBottom: 8 },
  buttonContent: { paddingVertical: 6 },
  emptyLeft: { color: c.textMuted },
  historyLoading: { marginTop: 8 },
  row: { paddingRight: 0 },
  rowContent: { paddingLeft: 0 },
  rowRight: { alignItems: 'flex-end', justifyContent: 'center' },
  rowQty: { fontWeight: '600', color: c.text },
  lowPill: { alignSelf: 'flex-end', marginTop: 4 },
  bottomSpacer: { height: 40 },
});
