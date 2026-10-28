import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, FlatList, RefreshControl } from 'react-native';
import { ActivityIndicator, Divider, HelperText, Text } from 'react-native-paper';
import { supabase } from '../lib/supabase';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { useSchool } from '../school/SchoolContext';
import CentralStoreScreen from './CentralStoreScreen';
import { FadeInScrollView } from '../components/Motion';
import { Button, ListItem } from '../components/Paper';
import { EmptyText, Field, MovementRow, ScreenHeader, StatCard, StatusPill } from '../components/ScreenParts';

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
  const { colors, styles } = useThemedStyles(makeStyles);
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
      <ScreenHeader title="Inventory" onBack={() => navigation.goBack()} />

      <StatCard
        value={items.length}
        label={`foods in stock · ${lowCount === 0 ? 'none low on stock' : `${lowCount} low on stock`}`}
        tone={lowCount > 0 ? 'warning' : 'default'}
      />

      <Text variant="bodySmall" style={styles.hint}>
        Stock arrives from the central store (confirm deliveries on the Distribution screen) and
        goes down as food used at meals is recorded there.
      </Text>

      {loadError && <HelperText type="error">Could not load inventory: {loadError}</HelperText>}

      <FlatList
        data={items}
        keyExtractor={(i) => i.item_id}
        ItemSeparatorComponent={Divider}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={loadItems} tintColor={colors.primary} />
        }
        ListEmptyComponent={
          loading ? undefined : (
            <EmptyText>No stock yet. Food appears here once a delivery is confirmed.</EmptyText>
          )
        }
        renderItem={({ item }) => (
          <ListItem
            title={item.food_items.item_name}
            description={`Reorder at ${formatQty(item.reorder_level ?? 0, item.food_items.unit)}`}
            onPress={() => setDetailId(item.item_id)}
            style={styles.row}
            contentStyle={styles.rowContent}
            right={() => (
              <View style={styles.rowRight}>
                <Text variant="titleMedium" style={styles.rowQty}>
                  {formatQty(item.quantity_available, item.food_items.unit)}
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

function StockDetailView({
  item,
  onBack,
  onChanged,
}: {
  item: Item;
  onBack: () => void;
  onChanged: () => Promise<void>;
}) {
  const { styles } = useThemedStyles(makeStyles);
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
      <ScreenHeader
        title={item.food_items.item_name}
        onBack={onBack}
        backLabel="Back to Inventory"
        backDisabled={saving}
      />

      <StatCard
        value={formatQty(item.quantity_available, unit)}
        label={`in stock · reorder at ${formatQty(item.reorder_level ?? 0, unit)}${
          isLowStock(item) ? ' · LOW' : ''
        }`}
        tone={isLowStock(item) ? 'warning' : 'default'}
      />

      {canEdit && (
        <>
          <View style={styles.inlineRow}>
            <Field
              label={`Reorder level (${unit})`}
              style={styles.inlineInput}
              value={reorderLevel}
              onChangeText={setReorderLevel}
              keyboardType="decimal-pad"
              placeholder="Warn when stock falls to this amount"
            />
            <Button
              mode="contained"
              onPress={handleSaveReorderLevel}
              loading={saving}
              disabled={saving}
              style={styles.inlineButton}
              contentStyle={styles.inlineButtonContent}
            >
              Save
            </Button>
          </View>
          <HelperText type="error" visible={!!error}>
            {error}
          </HelperText>
        </>
      )}

      <Text variant="titleSmall" style={styles.sectionTitle}>Recent movements</Text>
      {historyLoading ? (
        <ActivityIndicator style={styles.historyLoading} />
      ) : history.length === 0 ? (
        <Text variant="bodyMedium" style={styles.emptyLeft}>No stock movements recorded yet.</Text>
      ) : (
        history.map((t, index) => {
          const meal = t.food_consumption?.meal_type;
          const received = t.transaction_type === 'received';
          return (
            <MovementRow
              key={t.transaction_id}
              first={index === 0}
              title={
                received
                  ? 'Received from central store'
                  : meal
                    ? `Used at ${MEAL_LABELS[meal] ?? meal}`
                    : 'Used'
              }
              date={t.transaction_date}
              amount={formatQty(t.quantity, unit)}
              direction={received ? 'in' : 'out'}
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
  sectionTitle: { marginTop: 16, marginBottom: 4, color: c.text },
  inlineRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  inlineInput: { flex: 1 },
  // Lines the button up with the field, which has a gap above it.
  inlineButton: { marginTop: 18 },
  inlineButtonContent: { paddingVertical: 6 },
  hint: { color: c.textMuted, marginBottom: 4 },
  emptyLeft: { color: c.textMuted },
  historyLoading: { marginTop: 8 },
  row: { paddingRight: 0 },
  rowContent: { paddingLeft: 0 },
  rowRight: { alignItems: 'flex-end', justifyContent: 'center' },
  rowQty: { fontWeight: '600', color: c.text },
  lowPill: { alignSelf: 'flex-end', marginTop: 4 },
  bottomSpacer: { height: 40 },
});
