import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  FlatList,
  ScrollView,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { supabase } from '../lib/supabase';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { useSchool } from '../school/SchoolContext';

type Item = {
  item_id: string;
  item_name: string;
  quantity_available: number;
  unit: string | null;
  reorder_level: number | null;
};

type Transaction = {
  transaction_id: string;
  transaction_type: 'received' | 'used';
  quantity: number;
  transaction_date: string;
};

type ItemForm = { item_name: string; unit: string; reorder_level: string };

const EMPTY_ITEM_FORM: ItemForm = { item_name: '', unit: 'kg', reorder_level: '0' };

const NO_PERMISSION = 'Only admins and inventory officers can change stock.';
const CONNECTION_ERROR = 'Unable to connect. Check your connection and try again.';

function isLowStock(item: Item) {
  return (item.reorder_level ?? 0) > 0 && item.quantity_available <= (item.reorder_level ?? 0);
}

function formatQty(qty: number, unit: string | null) {
  return `${Number(qty).toLocaleString()} ${unit ?? ''}`.trim();
}

export default function InventoryScreen({ navigation }: any) {
  const { styles } = useThemedStyles(makeStyles);
  const { school } = useSchool();
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Which view is showing: the list, the add/edit item form, or one item's stock detail.
  const [formTarget, setFormTarget] = useState<Item | 'new' | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  const loadItems = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('inventory_items')
      .select('item_id, item_name, quantity_available, unit, reorder_level')
      .eq('school_id', school.school_id)
      .order('item_name');
    if (error) {
      setLoadError(error.message);
    } else {
      setLoadError(null);
      setItems(data ?? []);
    }
    setLoading(false);
  }, [school.school_id]);

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  if (formTarget) {
    return (
      <ItemFormView
        target={formTarget}
        onDone={async (saved) => {
          setFormTarget(null);
          if (saved) await loadItems();
        }}
      />
    );
  }

  const detailItem = detailId ? items.find((i) => i.item_id === detailId) : undefined;
  if (detailItem) {
    return (
      <StockDetailView
        item={detailItem}
        onBack={() => setDetailId(null)}
        onEdit={() => setFormTarget(detailItem)}
        onStockChanged={loadItems}
      />
    );
  }

  const lowCount = items.filter(isLowStock).length;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={styles.link}>‹ Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Inventory</Text>
        <TouchableOpacity onPress={() => setFormTarget('new')}>
          <Text style={[styles.link, styles.linkStrong]}>+ Add</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.summary}>
        <Text style={styles.summaryNumber}>{items.length}</Text>
        <Text style={styles.summaryLabel}>
          items · {lowCount === 0 ? 'none low on stock' : `${lowCount} low on stock`}
        </Text>
      </View>

      {loadError && <Text style={styles.error}>Could not load inventory: {loadError}</Text>}

      <FlatList
        data={items}
        keyExtractor={(i) => i.item_id}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={loadItems} />}
        ListEmptyComponent={
          loading ? null : <Text style={styles.empty}>No inventory items yet.</Text>
        }
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.row} onPress={() => setDetailId(item.item_id)}>
            <View style={styles.rowMain}>
              <Text style={styles.rowName}>{item.item_name}</Text>
              <Text style={styles.rowMeta}>
                Reorder at {formatQty(item.reorder_level ?? 0, item.unit)}
              </Text>
            </View>
            <View style={styles.rowRight}>
              <Text style={styles.rowQty}>{formatQty(item.quantity_available, item.unit)}</Text>
              {isLowStock(item) && <Text style={styles.lowBadge}>Low stock</Text>}
            </View>
          </TouchableOpacity>
        )}
      />
    </View>
  );
}

function ItemFormView({
  target,
  onDone,
}: {
  target: Item | 'new';
  onDone: (saved: boolean) => void;
}) {
  const { colors, styles } = useThemedStyles(makeStyles);
  const { school } = useSchool();
  const [form, setForm] = useState<ItemForm>(
    target === 'new'
      ? EMPTY_ITEM_FORM
      : {
          item_name: target.item_name,
          unit: target.unit ?? '',
          reorder_level: String(target.reorder_level ?? 0),
        }
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    const itemName = form.item_name.trim();
    const reorderLevel = Number(form.reorder_level.trim() || '0');
    if (!itemName) {
      setError('Item name is required.');
      return;
    }
    if (!Number.isFinite(reorderLevel) || reorderLevel < 0) {
      setError('Reorder level must be zero or a positive number.');
      return;
    }

    // Only these columns are writable; quantity_available changes through transactions.
    const payload = {
      item_name: itemName,
      unit: form.unit.trim() || null,
      reorder_level: reorderLevel,
    };

    setSaving(true);
    setError(null);
    try {
      const query =
        target === 'new'
          ? supabase.from('inventory_items').insert({ ...payload, school_id: school.school_id })
          : supabase.from('inventory_items').update(payload).eq('item_id', target.item_id);
      // .select() makes RLS-blocked updates visible: they succeed with zero rows.
      const { data, error } = await query.select('item_id');
      if (error) {
        setError(error.code === '42501' ? NO_PERMISSION : error.message);
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
    <ScrollView style={styles.container} keyboardShouldPersistTaps="handled">
      <View style={styles.header}>
        <TouchableOpacity onPress={() => onDone(false)} disabled={saving}>
          <Text style={styles.link}>‹ Cancel</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{target === 'new' ? 'Add item' : 'Edit item'}</Text>
        <View style={styles.headerSpacer} />
      </View>

      <Text style={styles.label}>Item name *</Text>
      <TextInput
        style={styles.input}
        placeholderTextColor={colors.placeholder}
        value={form.item_name}
        onChangeText={(item_name) => setForm({ ...form, item_name })}
        placeholder="e.g. Maize flour"
      />

      <Text style={styles.label}>Unit</Text>
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
        placeholder="Warn when stock falls to this amount"
      />

      {target === 'new' && (
        <Text style={styles.hint}>
          New items start at zero. Record a delivery from the item's page to add stock.
        </Text>
      )}

      {error && <Text style={styles.error}>{error}</Text>}

      <TouchableOpacity style={styles.button} onPress={handleSave} disabled={saving}>
        {saving ? (
          <ActivityIndicator color={colors.onPrimary} />
        ) : (
          <Text style={styles.buttonText}>Save</Text>
        )}
      </TouchableOpacity>
    </ScrollView>
  );
}

function StockDetailView({
  item,
  onBack,
  onEdit,
  onStockChanged,
}: {
  item: Item;
  onBack: () => void;
  onEdit: () => void;
  onStockChanged: () => Promise<void>;
}) {
  const { colors, styles } = useThemedStyles(makeStyles);
  const [type, setType] = useState<'received' | 'used'>('received');
  const [quantity, setQuantity] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState<Transaction[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    const { data, error } = await supabase
      .from('inventory_transactions')
      .select('transaction_id, transaction_type, quantity, transaction_date')
      .eq('item_id', item.item_id)
      .order('created_at', { ascending: false })
      .limit(10);
    if (!error) setHistory(data ?? []);
    setHistoryLoading(false);
  }, [item.item_id]);

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
      const { error } = await supabase.from('inventory_transactions').insert({
        item_id: item.item_id,
        transaction_type: type,
        quantity: qty,
        recorded_by: auth.user?.id ?? null,
      });
      if (error) {
        if (error.code === '23514') {
          setError(
            `Not enough stock: only ${formatQty(item.quantity_available, item.unit)} available.`
          );
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
    <ScrollView style={styles.container} keyboardShouldPersistTaps="handled">
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} disabled={saving}>
          <Text style={styles.link}>‹ Inventory</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onEdit} disabled={saving}>
          <Text style={styles.link}>Edit</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.detailTitle}>{item.item_name}</Text>
      <View style={[styles.summary, isLowStock(item) && styles.summaryLow]}>
        <Text style={styles.summaryNumber}>{formatQty(item.quantity_available, item.unit)}</Text>
        <Text style={styles.summaryLabel}>
          in stock · reorder at {formatQty(item.reorder_level ?? 0, item.unit)}
          {isLowStock(item) ? ' · LOW' : ''}
        </Text>
      </View>

      <Text style={styles.sectionTitle}>Record stock movement</Text>
      <View style={styles.segment}>
        {(['received', 'used'] as const).map((t) => (
          <TouchableOpacity
            key={t}
            style={[styles.segmentItem, type === t && styles.segmentItemActive]}
            onPress={() => setType(t)}
            accessibilityState={{ selected: type === t }}
          >
            <Text style={[styles.segmentText, type === t && styles.segmentTextActive]}>
              {t === 'received' ? 'Received (delivery)' : 'Used'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={styles.label}>Quantity{item.unit ? ` (${item.unit})` : ''}</Text>
      <TextInput
        style={styles.input}
        placeholderTextColor={colors.placeholder}
        value={quantity}
        onChangeText={setQuantity}
        keyboardType="decimal-pad"
        placeholder="0"
      />

      {error && <Text style={styles.error}>{error}</Text>}

      <TouchableOpacity style={styles.button} onPress={handleRecord} disabled={saving}>
        {saving ? (
          <ActivityIndicator color={colors.onPrimary} />
        ) : (
          <Text style={styles.buttonText}>
            {type === 'received' ? 'Add to stock' : 'Remove from stock'}
          </Text>
        )}
      </TouchableOpacity>

      <Text style={styles.sectionTitle}>Recent movements</Text>
      {historyLoading ? (
        <ActivityIndicator style={styles.historyLoading} />
      ) : history.length === 0 ? (
        <Text style={styles.emptyLeft}>No stock movements recorded yet.</Text>
      ) : (
        history.map((t) => (
          <View key={t.transaction_id} style={styles.row}>
            <Text style={styles.historyDate}>{t.transaction_date}</Text>
            <Text style={t.transaction_type === 'received' ? styles.qtyIn : styles.qtyOut}>
              {t.transaction_type === 'received' ? '+' : '−'}
              {formatQty(t.quantity, item.unit)}
            </Text>
          </View>
        ))
      )}
      <View style={styles.bottomSpacer} />
    </ScrollView>
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
  summary: { backgroundColor: c.surface, borderRadius: 12, padding: 16, marginBottom: 16 },
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
  hint: { fontSize: 13, color: c.textMuted, marginTop: 12 },
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
  historyDate: { flex: 1, color: c.text },
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
