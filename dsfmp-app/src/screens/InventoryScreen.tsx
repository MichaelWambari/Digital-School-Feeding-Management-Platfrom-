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
import { useSchool } from '../school/SchoolContext';
import CentralStoreScreen from './CentralStoreScreen';
import { FadeInScrollView, PressableScale } from '../components/Motion';

type Item = {
  item_id: string;
  quantity_available: number;
  reorder_level: number | null;
  food_items: { item_name: string; unit: string };
};

type Transaction = {
  transaction_id: string;
  transaction_type: 'received' | 'used';
  quantity: number;
  transaction_date: string;
  food_consumption: { meal_type: string } | null;
};

const MEAL_LABELS: Record<string, string> = {
  breakfast: 'breakfast',
  lunch: 'lunch',
  supper: 'supper',
};

const NO_PERMISSION = 'Only admins and inventory officers can change reorder levels.';
const CONNECTION_ERROR = 'Unable to connect. Check your connection and try again.';

function isLowStock(item: Item) {
  return (item.reorder_level ?? 0) > 0 && item.quantity_available <= (item.reorder_level ?? 0);
}

function formatQty(qty: number, unit: string | null) {
  return `${Number(qty).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${unit ?? ''}`.trim();
}

// Network admins manage the central store; school staff see their school's stock.
export default function InventoryScreen(props: any) {
  const { isNetworkAdmin } = useSchool();
  return isNetworkAdmin ? <CentralStoreScreen {...props} /> : <SchoolInventoryScreen {...props} />;
}

function SchoolInventoryScreen({ navigation }: any) {
  const { styles } = useThemedStyles(makeStyles);
  const { school } = useSchool();
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  const loadItems = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('inventory_items')
      .select('item_id, quantity_available, reorder_level, food_items(item_name, unit)')
      .eq('school_id', school.school_id);
    if (error) {
      setLoadError(error.message);
    } else {
      setLoadError(null);
      const loaded = (data ?? []) as unknown as Item[];
      setItems(loaded.sort((a, b) => a.food_items.item_name.localeCompare(b.food_items.item_name)));
    }
    setLoading(false);
  }, [school.school_id]);

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  const detailItem = detailId ? items.find((i) => i.item_id === detailId) : undefined;
  if (detailItem) {
    return (
      <StockDetailView
        item={detailItem}
        onBack={() => setDetailId(null)}
        onChanged={loadItems}
      />
    );
  }

  const lowCount = items.filter(isLowStock).length;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <PressableScale onPress={() => navigation.goBack()}>
          <Text style={styles.link}>‹ Back</Text>
        </PressableScale>
        <Text style={styles.headerTitle}>Inventory</Text>
        <View style={styles.headerSpacer} />
      </View>

      <View style={styles.summary}>
        <Text style={styles.summaryNumber}>{items.length}</Text>
        <Text style={styles.summaryLabel}>
          foods in stock · {lowCount === 0 ? 'none low on stock' : `${lowCount} low on stock`}
        </Text>
      </View>

      <Text style={styles.hint}>
        Stock arrives from the central store (confirm deliveries on the Distribution screen) and
        goes down as food used at meals is recorded there.
      </Text>

      {loadError && <Text style={styles.error}>Could not load inventory: {loadError}</Text>}

      <FlatList
        data={items}
        keyExtractor={(i) => i.item_id}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={loadItems} />}
        ListEmptyComponent={
          loading ? null : (
            <Text style={styles.empty}>No stock yet. Food appears here once a delivery is confirmed.</Text>
          )
        }
        renderItem={({ item }) => (
          <PressableScale style={styles.row} onPress={() => setDetailId(item.item_id)}>
            <View style={styles.rowMain}>
              <Text style={styles.rowName}>{item.food_items.item_name}</Text>
              <Text style={styles.rowMeta}>
                Reorder at {formatQty(item.reorder_level ?? 0, item.food_items.unit)}
              </Text>
            </View>
            <View style={styles.rowRight}>
              <Text style={styles.rowQty}>
                {formatQty(item.quantity_available, item.food_items.unit)}
              </Text>
              {isLowStock(item) && <Text style={styles.lowBadge}>Low stock</Text>}
            </View>
          </PressableScale>
        )}
      />
    </View>
  );
}

function StockDetailView({
  item,
  onBack,
  onChanged,
}: {
  item: Item;
  onBack: () => void;
  onChanged: () => Promise<void>;
}) {
  const { colors, styles } = useThemedStyles(makeStyles);
  const { profile } = useSchool();
  const canEdit = profile.role === 'admin' || profile.role === 'inventory_officer';
  const unit = item.food_items.unit;
  const [reorderLevel, setReorderLevel] = useState(String(item.reorder_level ?? 0));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState<Transaction[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    const { data, error } = await supabase
      .from('inventory_transactions')
      .select('transaction_id, transaction_type, quantity, transaction_date, food_consumption(meal_type)')
      .eq('item_id', item.item_id)
      .order('created_at', { ascending: false })
      .limit(15);
    if (!error) setHistory((data ?? []) as unknown as Transaction[]);
    setHistoryLoading(false);
  }, [item.item_id]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  async function handleSaveReorderLevel() {
    const level = Number(reorderLevel.trim() || '0');
    if (!Number.isFinite(level) || level < 0) {
      setError('Reorder level must be zero or a positive number.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // .select() makes RLS-blocked updates visible: they succeed with zero rows.
      const { data, error } = await supabase
        .from('inventory_items')
        .update({ reorder_level: level })
        .eq('item_id', item.item_id)
        .select('item_id');
      if (error) {
        setError(error.code === '42501' ? NO_PERMISSION : error.message);
        return;
      }
      if (!data || data.length === 0) {
        setError(NO_PERMISSION);
        return;
      }
      await onChanged();
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
          <Text style={styles.link}>‹ Inventory</Text>
        </PressableScale>
      </View>

      <Text style={styles.detailTitle}>{item.food_items.item_name}</Text>
      <View style={[styles.summary, isLowStock(item) && styles.summaryLow]}>
        <Text style={styles.summaryNumber}>{formatQty(item.quantity_available, unit)}</Text>
        <Text style={styles.summaryLabel}>
          in stock · reorder at {formatQty(item.reorder_level ?? 0, unit)}
          {isLowStock(item) ? ' · LOW' : ''}
        </Text>
      </View>

      {canEdit && (
        <>
          <Text style={styles.label}>Reorder level ({unit})</Text>
          <View style={styles.inlineRow}>
            <TextInput
              style={[styles.input, styles.inlineInput]}
              placeholderTextColor={colors.placeholder}
              value={reorderLevel}
              onChangeText={setReorderLevel}
              keyboardType="decimal-pad"
              placeholder="Warn when stock falls to this amount"
            />
            <PressableScale style={styles.inlineButton} onPress={handleSaveReorderLevel} disabled={saving}>
              {saving ? (
                <ActivityIndicator color={colors.onPrimary} />
              ) : (
                <Text style={styles.buttonText}>Save</Text>
              )}
            </PressableScale>
          </View>
          {error && <Text style={styles.error}>{error}</Text>}
        </>
      )}

      <Text style={styles.sectionTitle}>Recent movements</Text>
      {historyLoading ? (
        <ActivityIndicator style={styles.historyLoading} />
      ) : history.length === 0 ? (
        <Text style={styles.emptyLeft}>No stock movements recorded yet.</Text>
      ) : (
        history.map((t) => {
          const meal = t.food_consumption?.meal_type;
          return (
            <View key={t.transaction_id} style={styles.row}>
              <View style={styles.rowMain}>
                <Text style={styles.rowName}>
                  {t.transaction_type === 'received'
                    ? 'Received from central store'
                    : meal
                      ? `Used at ${MEAL_LABELS[meal] ?? meal}`
                      : 'Used'}
                </Text>
                <Text style={styles.rowMeta}>{t.transaction_date}</Text>
              </View>
              <Text style={t.transaction_type === 'received' ? styles.qtyIn : styles.qtyOut}>
                {t.transaction_type === 'received' ? '+' : '−'}
                {formatQty(t.quantity, unit)}
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
  inlineRow: { flexDirection: 'row', gap: 8 },
  inlineInput: { flex: 1 },
  inlineButton: {
    backgroundColor: c.primary,
    borderRadius: 8,
    paddingHorizontal: 18,
    justifyContent: 'center',
    minWidth: 76,
    alignItems: 'center',
  },
  hint: { fontSize: 13, color: c.textMuted, marginBottom: 4 },
  error: { color: c.danger, fontSize: 13, marginTop: 12 },
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
