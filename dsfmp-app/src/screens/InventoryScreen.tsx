import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, FlatList, RefreshControl } from 'react-native';
import { ActivityIndicator, Divider, HelperText, Searchbar, Text } from 'react-native-paper';
import { supabase } from '../lib/supabase';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { useSchool } from '../school/SchoolContext';
import { FadeInScrollView } from '../components/Motion';
import { Button, Chip, ListItem } from '../components/Paper';
import {
  EmptyText,
  Field,
  MovementRow,
  QuantityField,
  ScreenHeader,
  StatCard,
  StatusPill,
} from '../components/ScreenParts';
import { formatPacks, formatQty, toBaseQuantity } from '../lib/units';

type Food = { food_id: string; item_name: string; unit: string; pack_size?: number | null };

type Item = {
  item_id: string;
  quantity_available: number;
  reorder_level: number | null;
  food_items: Food;
};

type Transaction = {
  transaction_id: string;
  transaction_type: 'received' | 'used';
  quantity: number;
  transaction_date: string;
  supplier_name?: string | null;
  distribution_id: string | null;
  food_consumption: { meal_type: string } | null;
};

const MEAL_LABELS: Record<string, string> = {
  breakfast: 'breakfast',
  lunch: 'lunch',
  supper: 'supper',
};

const NO_PERMISSION = 'Only the headteacher can change reorder levels.';
const CONNECTION_ERROR = 'Unable to connect. Check your connection and try again.';

function isLowStock(item: Item) {
  return (item.reorder_level ?? 0) > 0 && item.quantity_available <= (item.reorder_level ?? 0);
}

// The school's stock of each food.
export default function InventoryScreen({ navigation }: any) {
  const { colors, styles } = useThemedStyles(makeStyles);
  const { school, can } = useSchool();
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [receiving, setReceiving] = useState(false);

  const loadItems = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('inventory_items')
      .select('item_id, quantity_available, reorder_level, food_items(*)')
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

  if (receiving) {
    return (
      <ReceiveView
        onBack={() => setReceiving(false)}
        onReceived={async () => {
          setReceiving(false);
          await loadItems();
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
        onChanged={loadItems}
      />
    );
  }

  const lowCount = items.filter(isLowStock).length;

  return (
    <View style={styles.container}>
      <ScreenHeader
        title="Inventory"
        onBack={() => navigation.goBack()}
        right={
          can('verify_deliveries') && (
            <Button mode="text" icon="truck-check-outline" onPress={() => setReceiving(true)}>
              Received
            </Button>
          )
        }
      />

      <StatCard
        value={items.length}
        label={`foods in stock · ${lowCount === 0 ? 'none low on stock' : `${lowCount} low on stock`}`}
        tone={lowCount > 0 ? 'warning' : 'default'}
      />

      <Text variant="bodySmall" style={styles.hint}>
        Stock goes up when food received is recorded here, and down as food used at meals is
        recorded on the Distribution screen.
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
            <EmptyText>No stock yet. Food appears here once food received is recorded.</EmptyText>
          )
        }
        renderItem={({ item }) => (
          <ListItem
            title={item.food_items.item_name}
            description={[
              formatPacks(item.quantity_available, item.food_items),
              `Reorder at ${formatQty(item.reorder_level ?? 0, item.food_items.unit)}`,
            ]
              .filter(Boolean)
              .join('\n')}
            descriptionNumberOfLines={2}
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

// Recording food that arrived at the school, after checking the amount.
function ReceiveView({ onBack, onReceived }: { onBack: () => void; onReceived: () => Promise<void> }) {
  const { styles } = useThemedStyles(makeStyles);
  const [foods, setFoods] = useState<Food[]>([]);
  const [search, setSearch] = useState('');
  const [food, setFood] = useState<Food | null>(null);
  const [quantity, setQuantity] = useState('');
  const [inPacks, setInPacks] = useState(false);
  const [supplier, setSupplier] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from('food_items')
      .select('*')
      .order('item_name')
      .then(({ data, error }) => {
        if (error) setError(`Could not load the food list: ${error.message}`);
        else setFoods((data ?? []) as Food[]);
      });
  }, []);

  function choose(f: Food) {
    setFood(f);
    setInPacks(!!f.pack_size);
    setError(null);
  }

  async function handleSave() {
    if (!food) return;
    const qty = toBaseQuantity(quantity, inPacks, food);
    if (!Number.isFinite(qty) || qty <= 0) {
      setError('Enter the amount that arrived.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const { error } = await supabase.rpc('record_stock_received', {
        p_food_id: food.food_id,
        p_quantity: qty,
        p_supplier_name: supplier,
        p_note: note,
      });
      if (error) {
        setError(error.message);
        return;
      }
      await onReceived();
    } catch {
      setError(CONNECTION_ERROR);
    } finally {
      setSaving(false);
    }
  }

  const term = search.trim().toLowerCase();
  const shown = term ? foods.filter((f) => f.item_name.toLowerCase().includes(term)) : foods;

  return (
    <FadeInScrollView style={styles.container} keyboardShouldPersistTaps="handled">
      <ScreenHeader title="Food received" onBack={onBack} backLabel="Cancel" backDisabled={saving} />
      <Text variant="bodySmall" style={styles.hint}>
        Weigh or count what arrived and record the amount you checked. It is added to stock straight away.
      </Text>

      <Text variant="labelLarge" style={styles.label}>Food</Text>
      <Searchbar
        value={search}
        onChangeText={setSearch}
        placeholder="Search the food list"
        elevation={0}
        style={styles.search}
      />
      <View style={styles.chipWrap}>
        {shown.map((f) => (
          <Chip
            key={f.food_id}
            mode={food?.food_id === f.food_id ? 'flat' : 'outlined'}
            selected={food?.food_id === f.food_id}
            onPress={() => choose(f)}
          >
            {f.item_name}
          </Chip>
        ))}
      </View>

      {food && (
        <>
          <QuantityField
            style={styles.quantity}
            label="Amount received"
            value={quantity}
            onChangeText={setQuantity}
            inPacks={inPacks}
            onInPacksChange={setInPacks}
            food={food}
          />
          <Field label="Supplier" value={supplier} onChangeText={setSupplier} placeholder="Who delivered it" />
          <Field label="Note" value={note} onChangeText={setNote} placeholder="e.g. delivery note number" />
        </>
      )}

      <HelperText type="error" visible={!!error}>
        {error}
      </HelperText>
      <Button
        mode="contained"
        icon="package-variant-closed-plus"
        onPress={handleSave}
        loading={saving}
        disabled={saving || !food}
        contentStyle={styles.buttonContent}
      >
        Add to stock
      </Button>
      <View style={styles.bottomSpacer} />
    </FadeInScrollView>
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
  const { isHeadteacher } = useSchool();
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
      .select('*, food_consumption(meal_type)')
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
        label={[
          formatPacks(item.quantity_available, item.food_items),
          `in stock · reorder at ${formatQty(item.reorder_level ?? 0, unit)}${
            isLowStock(item) ? ' · LOW' : ''
          }`,
        ]
          .filter(Boolean)
          .join('\n')}
        tone={isLowStock(item) ? 'warning' : 'default'}
      />

      {isHeadteacher && (
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
                  ? t.supplier_name
                    ? `Received from ${t.supplier_name}`
                    : t.distribution_id
                      ? 'Received from the old central store'
                      : 'Received'
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
  label: { color: c.textSecondary, marginBottom: 8, marginTop: 16 },
  search: { backgroundColor: c.surface, marginBottom: 12 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  quantity: { marginTop: 16 },
  buttonContent: { paddingVertical: 6 },
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
