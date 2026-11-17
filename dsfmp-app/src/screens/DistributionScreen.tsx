import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, RefreshControl } from 'react-native';
import { Card, Divider, HelperText, List, Text, TextInput } from 'react-native-paper';
import { useNavigation } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { useSchool } from '../school/SchoolContext';
import { FadeInScrollView } from '../components/Motion';
import { Button, Chip, SegmentedButtons } from '../components/Paper';
import { Field, ScreenHeader, StatCard, StatusPill } from '../components/ScreenParts';
import { formatPacks, formatQty, formatStock } from '../lib/units';
import { formatDate } from '../lib/suppliers';
import {
  REQUEST_LABELS,
  REQUEST_TONES,
  SchoolRequest,
  describeRequestError,
  isOpen,
} from '../lib/supplyRequests';
import type { DirectorySupplier } from './SuppliersScreen';

// Food used at each meal, food running low (with requests to the school's
// suppliers), and dispatches from the old central store (those still in
// transit can be received; nothing new is dispatched).

type Item = {
  item_id: string;
  quantity_available: number;
  reorder_level: number | null;
  food_items: { food_id: string; item_name: string; unit: string; pack_size?: number | null };
};

// A food that is at or below its reorder level, or short of what the
// selected meal needs.
type LowItem = {
  food_id: string;
  item_name: string;
  unit: string;
  pack_size: number | null;
  stock: number;
  reorder: number;
  needed: number; // for the selected meal; 0 if not known
};

// Food a meal should have used: students who attended x the dish's serving.
type Estimate = {
  meal_name: string;
  students: number;
  rows: { food_id: string; item_name: string; unit: string; quantity: number }[];
};

type Delivery = {
  distribution_id: string;
  quantity_dispatched: number;
  dispatch_date: string;
  status: 'in_transit' | 'received' | 'cancelled';
  quantity_received: number | null;
  received_date: string | null;
  food_items: { item_name: string; unit: string; pack_size?: number | null };
};

type UsageRow = { item_id: string; meal_type: MealType; consumption_date: string; quantity: number };

const MEAL_TYPES = ['breakfast', 'lunch', 'supper'] as const;
type MealType = (typeof MEAL_TYPES)[number];
const MEAL_LABELS: Record<MealType, string> = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  supper: 'Supper',
};

const HISTORY_DAYS = 7;
const CONNECTION_ERROR = 'Unable to connect. Check your connection and try again.';

// Local calendar date as YYYY-MM-DD, daysAgo days back, so "today" matches the
// school's day rather than the database server's UTC date.
function localDate(daysAgo = 0) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ISO weekday of a YYYY-MM-DD date: 1 = Monday ... 7 = Sunday.
function isoWeekday(date: string) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).getDay() || 7;
}

function formatDay(date: string) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

export default function DistributionScreen({ navigation }: any) {
  const { styles } = useThemedStyles(makeStyles);
  const { can } = useSchool();
  const seesRequests = can('view_procurement') || can('verify_deliveries');
  const [tab, setTab] = useState<'usage' | 'requests' | 'deliveries'>('usage');

  return (
    <View style={styles.container}>
      <ScreenHeader title="Distribution" onBack={() => navigation.goBack()} />

      <SegmentedButtons
        value={tab}
        onValueChange={(t) => setTab(t as typeof tab)}
        buttons={[
          { value: 'usage', label: 'Food used', icon: 'silverware-fork-knife' },
          ...(seesRequests ? [{ value: 'requests', label: 'Requests', icon: 'cart-arrow-down' }] : []),
          { value: 'deliveries', label: 'Old dispatches', icon: 'truck-outline' },
        ]}
      />

      {tab === 'usage' ? (
        <UsageTab onOpenRequests={seesRequests ? () => setTab('requests') : undefined} />
      ) : tab === 'requests' ? (
        <RequestsTab />
      ) : (
        <DeliveriesTab />
      )}
    </View>
  );
}

// Rounds a suggested amount up to whole kg/litres, or whole bags if bagged.
function suggestQuantity(low: LowItem) {
  const target = Math.max(low.reorder * 2, low.needed + low.reorder);
  let qty = target - low.stock;
  if (qty <= 0) qty = low.reorder || 1;
  return low.pack_size ? Math.ceil(qty / low.pack_size) * low.pack_size : Math.ceil(qty);
}

// Food running low, each with a button to ask one of the school's
// approved suppliers for more.
function LowStockCard({
  items,
  estimate,
  onOpenRequests,
}: {
  items: Item[];
  estimate: Estimate | null;
  onOpenRequests?: () => void;
}) {
  const { colors, styles } = useThemedStyles(makeStyles);
  const navigation = useNavigation<any>();
  const { can } = useSchool();
  const canRequest = can('view_procurement');
  const [suppliers, setSuppliers] = useState<DirectorySupplier[]>([]);
  const [requests, setRequests] = useState<SchoolRequest[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The food whose request form is open, and the form's values.
  const [openFood, setOpenFood] = useState<string | null>(null);
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!canRequest) return;
    const [directory, sent] = await Promise.all([
      supabase.rpc('school_supplier_directory'),
      supabase.rpc('school_supply_requests'),
    ]);
    const problem = directory.error ?? sent.error;
    if (problem) {
      setLoadError(describeRequestError(problem));
      return;
    }
    setLoadError(null);
    setSuppliers(((directory.data ?? []) as DirectorySupplier[]).filter((s) => s.status === 'approved'));
    setRequests((sent.data ?? []) as SchoolRequest[]);
  }, [canRequest]);

  // Reloads whenever the screen reloads its stock.
  useEffect(() => {
    load();
  }, [load, items]);

  const needs = new Map(
    estimate && estimate.students > 0 ? estimate.rows.map((r) => [r.food_id, r] as const) : []
  );
  const low: LowItem[] = [];
  for (const i of items) {
    const stock = Number(i.quantity_available);
    const reorder = Number(i.reorder_level ?? 0);
    const needed = needs.get(i.food_items.food_id)?.quantity ?? 0;
    if ((reorder > 0 && stock <= reorder) || needed > stock) {
      low.push({
        food_id: i.food_items.food_id,
        item_name: i.food_items.item_name,
        unit: i.food_items.unit,
        pack_size: i.food_items.pack_size ?? null,
        stock,
        reorder,
        needed,
      });
    }
  }
  // Foods the menu needs that the school has none of.
  for (const r of needs.values()) {
    if (r.quantity > 0 && !items.some((i) => i.food_items.food_id === r.food_id)) {
      low.push({ food_id: r.food_id, item_name: r.item_name, unit: r.unit, pack_size: null, stock: 0, reorder: 0, needed: r.quantity });
    }
  }
  if (low.length === 0) return null;

  // Suppliers that list this food come first.
  function suppliersFor(food: LowItem) {
    const name = food.item_name.trim().toLowerCase();
    const listsIt = (s: DirectorySupplier) => s.foods.some((f) => f.trim().toLowerCase() === name);
    return [...suppliers.filter(listsIt), ...suppliers.filter((s) => !listsIt(s))].map((s) => ({
      supplier: s,
      listsIt: listsIt(s),
    }));
  }

  function startRequest(food: LowItem) {
    setOpenFood(food.food_id);
    setSupplierId(suppliersFor(food)[0]?.supplier.supplier_id ?? null);
    setQuantity(String(suggestQuantity(food)));
    setNote('');
    setError(null);
  }

  async function sendRequest(food: LowItem) {
    const qty = Number(quantity.trim());
    if (!supplierId) {
      setError('Choose a supplier.');
      return;
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      setError(`Enter how much ${food.item_name} you need, in ${food.unit}.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { error } = await supabase.rpc('request_supply', {
        p_supplier_id: supplierId,
        p_food_id: food.food_id,
        p_quantity: qty,
        p_note: note.trim() || null,
      });
      if (error) {
        setError(describeRequestError(error));
        return;
      }
      setOpenFood(null);
      await load();
    } catch {
      setError(CONNECTION_ERROR);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card mode="outlined" style={[styles.estimateCard, styles.lowCard]}>
      <Card.Title
        title="Running low"
        titleStyle={styles.lowTitle}
        subtitle={
          canRequest
            ? 'Request more from one of your suppliers.'
            : 'The headteacher or a coordinator can request more from a supplier.'
        }
        subtitleNumberOfLines={2}
        left={(props) => <List.Icon {...props} icon="alert-outline" color={colors.warning} />}
      />
      <Card.Content>
        {loadError && <HelperText type="error">{loadError}</HelperText>}
        {low.map((food, index) => {
          const open = requests.find((r) => r.food_id === food.food_id && isOpen(r.status));
          const formOpen = openFood === food.food_id;
          const details = [
            `${formatStock(food.stock, food)} in stock`,
            food.reorder > 0 ? `reorder at ${formatQty(food.reorder, food.unit)}` : null,
            food.needed > food.stock ? `this meal needs ${formatQty(food.needed, food.unit)}` : null,
          ]
            .filter(Boolean)
            .join(' · ');
          return (
            <View key={food.food_id}>
              {index > 0 && <Divider />}
              <List.Item
                title={food.item_name}
                description={
                  open
                    ? `${details}\nRequested ${formatQty(open.quantity, open.unit)} from ${open.business_name}`
                    : details
                }
                descriptionNumberOfLines={4}
                style={styles.row}
                contentStyle={styles.rowContent}
                right={() =>
                  open ? (
                    <StatusPill
                      label={REQUEST_LABELS[open.status]}
                      tone={REQUEST_TONES[open.status]}
                      style={styles.lowPill}
                    />
                  ) : canRequest && !formOpen ? (
                    <Button mode="contained-tonal" icon="cart-plus" compact onPress={() => startRequest(food)} style={styles.lowButton}>
                      Request
                    </Button>
                  ) : null
                }
              />
              {formOpen && (
                <View style={styles.requestForm}>
                  {suppliers.length === 0 ? (
                    <>
                      <Text variant="bodySmall" style={styles.meta}>
                        Your school hasn't approved any suppliers yet. The headteacher approves them on the
                        Suppliers screen.
                      </Text>
                      <Button mode="text" icon="truck-outline" onPress={() => navigation.navigate('Suppliers')} style={styles.smallButton}>
                        Go to Suppliers
                      </Button>
                    </>
                  ) : (
                    <>
                      <Text variant="labelLarge" style={styles.estimateTitle}>Supplier</Text>
                      <View style={styles.supplierChips}>
                        {suppliersFor(food).map(({ supplier, listsIt }) => (
                          <Chip
                            key={supplier.supplier_id}
                            mode={supplierId === supplier.supplier_id ? 'flat' : 'outlined'}
                            selected={supplierId === supplier.supplier_id}
                            icon={listsIt ? 'check-decagram-outline' : undefined}
                            onPress={() => setSupplierId(supplier.supplier_id)}
                            disabled={busy}
                          >
                            {supplier.business_name}
                          </Chip>
                        ))}
                      </View>
                      {suppliersFor(food).some((s) => s.listsIt) && (
                        <Text variant="bodySmall" style={styles.meta}>
                          A tick means the supplier lists {food.item_name}.
                        </Text>
                      )}
                      <Field
                        label={`Amount needed (${food.unit})`}
                        value={quantity}
                        onChangeText={setQuantity}
                        keyboardType="decimal-pad"
                      />
                      <Field
                        label="Note to the supplier (optional)"
                        value={note}
                        onChangeText={setNote}
                        placeholder="e.g. Please deliver by Friday"
                        multiline
                      />
                    </>
                  )}
                  <HelperText type="error" visible={!!error}>{error}</HelperText>
                  <View style={styles.inlineRow}>
                    {suppliers.length > 0 && (
                      <Button mode="contained" icon="send-outline" onPress={() => sendRequest(food)} loading={busy} disabled={busy}>
                        Send request
                      </Button>
                    )}
                    <Button mode="text" onPress={() => setOpenFood(null)} disabled={busy}>
                      Cancel
                    </Button>
                  </View>
                </View>
              )}
            </View>
          );
        })}
        {onOpenRequests && requests.some((r) => isOpen(r.status)) && (
          <Button mode="text" icon="cart-arrow-down" onPress={onOpenRequests} style={styles.smallButton}>
            See all supply requests
          </Button>
        )}
      </Card.Content>
    </Card>
  );
}

// The school's supply requests: open ones first, with recording the delivery.
function RequestsTab() {
  const { colors, styles } = useThemedStyles(makeStyles);
  const { can } = useSchool();
  const canReceive = can('verify_deliveries');
  const canCancel = can('view_procurement');
  const [requests, setRequests] = useState<SchoolRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The request being received (with the amount that arrived) or cancelled.
  const [receivingId, setReceivingId] = useState<string | null>(null);
  const [received, setReceived] = useState('');
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc('school_supply_requests');
    if (error) setError(describeRequestError(error));
    else {
      setError(null);
      setRequests((data ?? []) as SchoolRequest[]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function run(fn: string, args: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const { error } = await supabase.rpc(fn, args);
      if (error) {
        setError(describeRequestError(error));
        return;
      }
      setReceivingId(null);
      setCancellingId(null);
      await load();
    } catch {
      setError(CONNECTION_ERROR);
    } finally {
      setBusy(false);
    }
  }

  function handleReceive(r: SchoolRequest) {
    const qty = Number(received.trim());
    if (received.trim() === '' || !Number.isFinite(qty) || qty < 0) {
      setError(`Enter the amount of ${r.item_name} that arrived (0 if none).`);
      return;
    }
    run('receive_supply_request', { p_request_id: r.request_id, p_quantity: qty });
  }

  function handleCancel(r: SchoolRequest) {
    if (cancellingId !== r.request_id) {
      setCancellingId(r.request_id);
      return;
    }
    run('cancel_supply_request', { p_request_id: r.request_id });
  }

  const open = requests.filter((r) => isOpen(r.status));
  const past = requests.filter((r) => !isOpen(r.status));

  return (
    <FadeInScrollView
      style={styles.tabBody}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.primary} />}
    >
      {error && <HelperText type="error">{error}</HelperText>}

      <Text variant="titleSmall" style={[styles.sectionTitle, styles.firstSection]}>Open requests</Text>
      {open.length === 0 ? (
        <Text variant="bodyMedium" style={styles.emptyLeft}>
          No open requests. Food that runs low shows on the Food used tab, with a button to request more.
        </Text>
      ) : (
        open.map((r) => {
          const receiving = receivingId === r.request_id;
          return (
            <Card key={r.request_id} mode="contained" style={styles.card}>
              <Card.Title
                title={`${r.item_name} · ${formatQty(r.quantity, r.unit)}`}
                subtitle={`${r.business_name} · ${r.phone}`}
                left={(props) => <List.Icon {...props} icon="cart-arrow-down" color={colors.primary} />}
                right={() => (
                  <StatusPill label={REQUEST_LABELS[r.status]} tone={REQUEST_TONES[r.status]} style={styles.lowPill} />
                )}
              />
              <Card.Content>
                <Text variant="bodySmall" style={styles.meta}>
                  Requested {formatDate(r.created_at)}
                  {r.requested_by_name ? ` by ${r.requested_by_name}` : ''}
                  {r.note ? `\nYour note: "${r.note}"` : ''}
                  {r.response_note ? `\nSupplier: "${r.response_note}"` : ''}
                </Text>
                {receiving ? (
                  <>
                    <View style={styles.inlineRow}>
                      <Field
                        label={`Amount that arrived (${r.unit})`}
                        style={styles.inlineInput}
                        value={received}
                        onChangeText={setReceived}
                        keyboardType="decimal-pad"
                      />
                      <Button mode="contained" onPress={() => handleReceive(r)} loading={busy} disabled={busy}
                        style={styles.inlineButton} contentStyle={styles.buttonContent}>
                        Add to stock
                      </Button>
                    </View>
                    <Button mode="text" onPress={() => setReceivingId(null)} disabled={busy} style={styles.cancelButton}>
                      Cancel
                    </Button>
                  </>
                ) : (
                  <View style={[styles.inlineRow, styles.requestActions]}>
                    {canReceive && (
                      <Button mode="contained" icon="package-variant-closed-check" disabled={busy}
                        onPress={() => {
                          setReceivingId(r.request_id);
                          setCancellingId(null);
                          setReceived(String(r.quantity));
                          setError(null);
                        }}>
                        Record delivery
                      </Button>
                    )}
                    {canCancel && (
                      <Button mode="text" textColor={colors.danger} disabled={busy}
                        loading={busy && cancellingId === r.request_id} onPress={() => handleCancel(r)}>
                        {cancellingId === r.request_id ? 'Tap again to cancel' : 'Cancel request'}
                      </Button>
                    )}
                  </View>
                )}
              </Card.Content>
            </Card>
          );
        })
      )}

      <Text variant="titleSmall" style={styles.sectionTitle}>Past requests</Text>
      {past.length === 0 ? (
        <Text variant="bodyMedium" style={styles.emptyLeft}>None yet.</Text>
      ) : (
        past.map((r, index) => (
          <View key={r.request_id}>
            {index > 0 && <Divider />}
            <List.Item
              title={`${r.item_name} · ${r.business_name}`}
              description={
                r.status === 'delivered'
                  ? `Asked ${formatQty(r.quantity, r.unit)} · received ${formatQty(r.quantity_received ?? 0, r.unit)} on ${formatDate(r.received_at!)}`
                  : `Asked ${formatQty(r.quantity, r.unit)} on ${formatDate(r.created_at)}` +
                    (r.response_note ? ` · "${r.response_note}"` : '')
              }
              descriptionNumberOfLines={3}
              style={styles.row}
              right={() => (
                <StatusPill label={REQUEST_LABELS[r.status]} tone={REQUEST_TONES[r.status]} style={styles.lowPill} />
              )}
            />
          </View>
        ))
      )}
      <View style={styles.bottomSpacer} />
    </FadeInScrollView>
  );
}

function UsageTab({ onOpenRequests }: { onOpenRequests?: () => void }) {
  const { colors, styles } = useThemedStyles(makeStyles);
  const { school, profile } = useSchool();
  // The database lets the headteacher and coordinators record food used.
  const canRecord = profile.role === 'headteacher' || profile.role === 'coordinator';
  const [daysAgo, setDaysAgo] = useState<0 | 1>(0);
  const [servedMeals, setServedMeals] = useState<MealType[]>([...MEAL_TYPES]);
  const [mealType, setMealType] = useState<MealType>('lunch');
  const [items, setItems] = useState<Item[]>([]);
  const [fed, setFed] = useState<number | null>(null);
  const [usage, setUsage] = useState<UsageRow[]>([]);
  // item_id -> quantity typed for the selected meal
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Food used can't be edited or deleted, so saving takes two taps: Save, then Confirm.
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);

  const date = localDate(daysAgo);
  const historyStart = localDate(HISTORY_DAYS - 1);

  const loadData = useCallback(async () => {
    setLoading(true);
    const [scheduleResult, itemResult, usageResult, fedResult, estimateResult] = await Promise.all([
      // The meals the timetable serves on that day.
      supabase
        .from('meal_schedules')
        .select('meal_type')
        .eq('school_id', school.school_id)
        .eq('weekday', isoWeekday(date)),
      supabase
        .from('inventory_items')
        .select('item_id, quantity_available, reorder_level, food_items(*)')
        .eq('school_id', school.school_id),
      supabase
        .from('food_consumption')
        .select('item_id, meal_type, consumption_date, quantity')
        .eq('school_id', school.school_id)
        .gte('consumption_date', historyStart)
        .order('consumption_date', { ascending: false }),
      supabase
        .from('meal_attendance')
        .select('*', { count: 'exact', head: true })
        .eq('school_id', school.school_id)
        .eq('attendance_date', date)
        .eq('meal_type', mealType),
      // Not there before fix 011; the screen then works without the estimate.
      supabase.rpc('expected_food_use', {
        p_school_id: school.school_id,
        p_date: date,
        p_meal_type: mealType,
      }),
    ]);
    const loadError = scheduleResult.error ?? itemResult.error ?? usageResult.error ?? fedResult.error;
    if (loadError) {
      setError(`Could not load food used: ${loadError.message}`);
    } else {
      setError(null);
      // A meal that isn't on that day's timetable isn't served.
      const scheduled = new Set((scheduleResult.data ?? []).map((s) => s.meal_type));
      const served = MEAL_TYPES.filter((m) => scheduled.has(m));
      setServedMeals(served.length > 0 ? served : [...MEAL_TYPES]);
      if (served.length > 0 && !served.includes(mealType)) setMealType(served[0]);
      const loaded = (itemResult.data ?? []) as unknown as Item[];
      const loadedUsage = (usageResult.data ?? []) as UsageRow[];
      setItems(loaded.sort((a, b) => a.food_items.item_name.localeCompare(b.food_items.item_name)));
      setUsage(loadedUsage);
      setFed(fedResult.count ?? 0);

      const rows = estimateResult.error ? [] : (estimateResult.data ?? []);
      const next: Estimate | null =
        rows.length > 0
          ? {
              meal_name: rows[0].meal_name,
              students: rows[0].students,
              rows: rows.map((r: any) => ({
                food_id: r.food_id,
                item_name: r.item_name,
                unit: r.unit,
                quantity: Number(r.quantity),
              })),
            }
          : null;
      setEstimate(next);
      // Fill in the estimate for foods not yet recorded at this meal.
      if (next && next.students > 0) {
        const recorded = new Set(
          loadedUsage
            .filter((u) => u.consumption_date === date && u.meal_type === mealType)
            .map((u) => u.item_id)
        );
        const filled: Record<string, string> = {};
        for (const r of next.rows) {
          const item = loaded.find((i) => i.food_items.food_id === r.food_id);
          if (item && !recorded.has(item.item_id) && r.quantity > 0) {
            filled[item.item_id] = String(Math.min(r.quantity, Number(item.quantity_available)));
          }
        }
        setAmounts(filled);
      }
    }
    setLoading(false);
  }, [school.school_id, date, mealType, historyStart]);

  useEffect(() => {
    // Amounts belong to one day's meal; start afresh when either changes.
    setConfirming(false);
    setAmounts({});
    loadData();
  }, [loadData]);

  const itemById = new Map(items.map((i) => [i.item_id, i]));
  const recordedForMeal = new Map<string, number>();
  for (const u of usage) {
    if (u.consumption_date === date && u.meal_type === mealType) {
      recordedForMeal.set(u.item_id, (recordedForMeal.get(u.item_id) ?? 0) + Number(u.quantity));
    }
  }

  // The amounts typed so far, checked against what's in stock.
  const entries = items
    .map((i) => ({ item: i, text: (amounts[i.item_id] ?? '').trim() }))
    .filter((e) => e.text !== '');

  function validate() {
    if (entries.length === 0) return 'Enter the amount used for at least one food.';
    for (const { item, text } of entries) {
      const qty = Number(text);
      if (!Number.isFinite(qty) || qty <= 0) {
        return `Enter a number greater than zero for ${item.food_items.item_name}.`;
      }
      if (qty > item.quantity_available) {
        return `Not enough ${item.food_items.item_name}: only ${formatQty(item.quantity_available, item.food_items.unit)} in stock.`;
      }
    }
    return null;
  }

  async function handleSave() {
    const problem = validate();
    if (problem) {
      setError(problem);
      setConfirming(false);
      return;
    }
    setError(null);
    if (!confirming) {
      setConfirming(true);
      return;
    }

    setSaving(true);
    try {
      const { data: auth } = await supabase.auth.getUser();
      // One insert for all foods, so either every amount is saved or none is.
      // A database trigger takes each amount out of stock.
      const { error } = await supabase.from('food_consumption').insert(
        entries.map(({ item, text }) => ({
          item_id: item.item_id,
          meal_type: mealType,
          consumption_date: date,
          quantity: Number(text),
          recorded_by: auth.user?.id ?? null,
        }))
      );
      if (error) {
        if (error.code === '23514') {
          setError('Not enough stock for one of these foods. Refresh and check the amounts.');
        } else if (error.code === '42501') {
          setError('You do not have permission to record food used.');
        } else {
          setError(error.message);
        }
        return;
      }
      setAmounts({});
      await loadData();
    } catch {
      setError(CONNECTION_ERROR);
    } finally {
      setSaving(false);
      setConfirming(false);
    }
  }

  // Food used per day and meal over the last week, newest first.
  const history = new Map<string, Map<MealType, { item: Item; quantity: number }[]>>();
  for (const u of usage) {
    const item = itemById.get(u.item_id);
    if (!item) continue;
    const day = history.get(u.consumption_date) ?? new Map();
    history.set(u.consumption_date, day);
    const meal = day.get(u.meal_type) ?? [];
    day.set(u.meal_type, meal);
    const existing = meal.find((m: { item: Item }) => m.item.item_id === u.item_id);
    if (existing) existing.quantity += Number(u.quantity);
    else meal.push({ item, quantity: Number(u.quantity) });
  }

  return (
    <FadeInScrollView
      style={styles.tabBody}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl refreshing={loading} onRefresh={loadData} tintColor={colors.primary} />
      }
    >
      <View style={styles.chipRow}>
        {([0, 1] as const).map((d) => (
          <Chip
            key={d}
            mode={daysAgo === d ? 'flat' : 'outlined'}
            selected={daysAgo === d}
            showSelectedCheck={false}
            icon="calendar-outline"
            onPress={() => setDaysAgo(d)}
          >
            {d === 0 ? 'Today' : 'Yesterday'}
          </Chip>
        ))}
      </View>

      <SegmentedButtons
        value={mealType}
        onValueChange={(meal) => setMealType(meal as MealType)}
        buttons={servedMeals.map((meal) => ({ value: meal, label: MEAL_LABELS[meal] }))}
      />

      <StatCard
        style={styles.summary}
        value={fed ?? '—'}
        label={`students at ${MEAL_LABELS[mealType].toLowerCase()} · ${formatDay(date)}`}
      />

      {estimate && (
        <Card mode="outlined" style={styles.estimateCard}>
          <Card.Content>
            <Text variant="titleSmall" style={styles.estimateTitle}>
              Menu: {estimate.meal_name}
            </Text>
            <Text variant="bodySmall" style={styles.meta}>
              {estimate.students === 0
                ? 'Expected use appears here once students are recorded at this meal.'
                : `Expected use for ${estimate.students} students × one serving: ` +
                  estimate.rows.map((r) => `${r.item_name} ${formatQty(r.quantity, r.unit)}`).join(', ') +
                  '. Filled in below; check it against what the kitchen used before saving.'}
            </Text>
            {estimate.students > 0 &&
              estimate.rows.some((r) => !items.some((i) => i.food_items.food_id === r.food_id)) && (
                <Text variant="bodySmall" style={styles.estimateWarning}>
                  Not in stock:{' '}
                  {estimate.rows
                    .filter((r) => !items.some((i) => i.food_items.food_id === r.food_id))
                    .map((r) => r.item_name)
                    .join(', ')}
                </Text>
              )}
          </Card.Content>
        </Card>
      )}

      {!loading && <LowStockCard items={items} estimate={estimate} onOpenRequests={onOpenRequests} />}

      {!loading && items.length === 0 ? (
        <Text variant="bodyMedium" style={styles.emptyLeft}>
          No food in stock yet. Record food received on the Inventory screen first.
        </Text>
      ) : !canRecord ? (
        <Text variant="bodyMedium" style={styles.emptyLeft}>
          The headteacher or a coordinator records food used after each meal.
        </Text>
      ) : (
        items.map((item, index) => {
          const recorded = recordedForMeal.get(item.item_id);
          const unit = item.food_items.unit;
          return (
            <View key={item.item_id}>
              {index > 0 && <Divider />}
              <List.Item
                title={item.food_items.item_name}
                description={
                  `${formatStock(item.quantity_available, item.food_items)} in stock` +
                  (recorded
                    ? ` · ${formatQty(recorded, unit)} used` +
                      (fed ? ` (${formatQty(recorded / fed, unit)} per student)` : '')
                    : '')
                }
                descriptionNumberOfLines={3}
                style={styles.row}
                contentStyle={styles.rowContent}
                right={() => (
                  <TextInput
                    mode="outlined"
                    dense
                    style={styles.amountInput}
                    contentStyle={styles.amountText}
                    value={amounts[item.item_id] ?? ''}
                    onChangeText={(text) => {
                      setAmounts({ ...amounts, [item.item_id]: text });
                      setConfirming(false);
                    }}
                    keyboardType="decimal-pad"
                    placeholder={unit}
                    accessibilityLabel={`${item.food_items.item_name} used, in ${unit}`}
                  />
                )}
              />
            </View>
          );
        })
      )}

      <HelperText type="error" visible={!!error}>
        {error}
      </HelperText>

      {items.length > 0 && canRecord && (
        <Button
          mode="contained"
          icon={confirming ? 'check-all' : 'content-save-outline'}
          buttonColor={confirming ? colors.warning : undefined}
          onPress={handleSave}
          loading={saving}
          disabled={saving}
          contentStyle={styles.buttonContent}
          labelStyle={styles.buttonLabel}
        >
          {confirming
            ? `Confirm: ${entries
                .map((e) => `${e.item.food_items.item_name} ${formatQty(Number(e.text), e.item.food_items.unit)}`)
                .join(', ')}`
            : `Save food used at ${MEAL_LABELS[mealType].toLowerCase()}`}
        </Button>
      )}

      <Text variant="titleSmall" style={styles.sectionTitle}>Food used, last {HISTORY_DAYS} days</Text>
      {history.size === 0 ? (
        <Text variant="bodyMedium" style={styles.emptyLeft}>Nothing recorded yet.</Text>
      ) : (
        [...history.entries()].map(([day, meals], index) => (
          <View key={day}>
            {index > 0 && <Divider />}
            <View style={styles.historyDay}>
              <Text variant="labelLarge" style={styles.historyDate}>{formatDay(day)}</Text>
              {MEAL_TYPES.filter((m) => meals.has(m)).map((m) => (
                <Text key={m} variant="bodyMedium" style={styles.historyLine}>
                  <Text variant="bodyMedium" style={styles.historyMeal}>{MEAL_LABELS[m]}: </Text>
                  {meals
                    .get(m)!
                    .map((u) => `${u.item.food_items.item_name} ${formatQty(u.quantity, u.item.food_items.unit)}`)
                    .join(', ')}
                </Text>
              ))}
            </View>
          </View>
        ))
      )}
      <View style={styles.bottomSpacer} />
    </FadeInScrollView>
  );
}

function DeliveriesTab() {
  const { colors, styles } = useThemedStyles(makeStyles);
  const { school, can } = useSchool();
  const canConfirm = can('verify_deliveries');
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The delivery being confirmed, and the amount that arrived.
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [received, setReceived] = useState('');
  const [busy, setBusy] = useState(false);

  const loadDeliveries = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('food_distribution')
      .select(
        'distribution_id, quantity_dispatched, dispatch_date, status, quantity_received, received_date, food_items(*)'
      )
      .eq('school_id', school.school_id)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) {
      setError(`Could not load deliveries: ${error.message}`);
    } else {
      setError(null);
      setDeliveries((data ?? []) as unknown as Delivery[]);
    }
    setLoading(false);
  }, [school.school_id]);

  useEffect(() => {
    loadDeliveries();
  }, [loadDeliveries]);

  function startConfirm(d: Delivery) {
    setConfirmId(d.distribution_id);
    setReceived(String(d.quantity_dispatched));
    setError(null);
  }

  async function handleConfirm(d: Delivery) {
    const qty = Number(received.trim());
    if (!Number.isFinite(qty) || qty < 0 || qty > d.quantity_dispatched) {
      setError(`Enter the amount that arrived, from 0 to ${formatQty(d.quantity_dispatched, d.food_items.unit)}.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Adds the amount to the school's stock and records any shortfall.
      const { error } = await supabase.rpc('receive_distribution', {
        p_distribution_id: d.distribution_id,
        p_quantity_received: qty,
      });
      if (error) {
        setError(error.message);
        return;
      }
      setConfirmId(null);
      await loadDeliveries();
    } catch {
      setError(CONNECTION_ERROR);
    } finally {
      setBusy(false);
    }
  }

  const inTransit = deliveries.filter((d) => d.status === 'in_transit');
  const past = deliveries.filter((d) => d.status !== 'in_transit');

  return (
    <FadeInScrollView
      style={styles.tabBody}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl refreshing={loading} onRefresh={loadDeliveries} tintColor={colors.primary} />
      }
    >
      {error && <HelperText type="error">{error}</HelperText>}

      <Text variant="titleSmall" style={[styles.sectionTitle, styles.firstSection]}>On the way</Text>
      {inTransit.length === 0 ? (
        <Text variant="bodyMedium" style={styles.emptyLeft}>
          Nothing on the way. The central store is closed; record new food on the Inventory screen.
        </Text>
      ) : (
        inTransit.map((d) => {
          const unit = d.food_items.unit;
          const isConfirming = confirmId === d.distribution_id;
          return (
            <Card key={d.distribution_id} mode="contained" style={styles.card}>
              <Card.Title
                title={`${d.food_items.item_name} · ${formatQty(d.quantity_dispatched, unit)}`}
                subtitle={[`Sent ${formatDay(d.dispatch_date)}`, formatPacks(d.quantity_dispatched, d.food_items)]
                  .filter(Boolean)
                  .join(' · ')}
                left={(props) => <List.Icon {...props} icon="truck-fast-outline" color={colors.primary} />}
              />
              <Card.Content>
                {!canConfirm ? (
                  <Text variant="bodySmall" style={styles.meta}>
                    Staff who confirm deliveries record it on arrival.
                  </Text>
                ) : isConfirming ? (
                  <>
                    <View style={styles.inlineRow}>
                      <Field
                        label={`Amount that arrived (${unit})`}
                        style={styles.inlineInput}
                        value={received}
                        onChangeText={setReceived}
                        keyboardType="decimal-pad"
                      />
                      <Button
                        mode="contained"
                        onPress={() => handleConfirm(d)}
                        loading={busy}
                        disabled={busy}
                        style={styles.inlineButton}
                        contentStyle={styles.buttonContent}
                      >
                        Confirm
                      </Button>
                    </View>
                    <Button
                      mode="text"
                      onPress={() => setConfirmId(null)}
                      disabled={busy}
                      style={styles.cancelButton}
                    >
                      Cancel
                    </Button>
                  </>
                ) : (
                  <Button
                    mode="contained"
                    icon="package-variant-closed-check"
                    onPress={() => startConfirm(d)}
                    style={styles.smallButton}
                  >
                    Confirm receipt
                  </Button>
                )}
              </Card.Content>
            </Card>
          );
        })
      )}

      <Text variant="titleSmall" style={styles.sectionTitle}>Received</Text>
      {past.length === 0 ? (
        <Text variant="bodyMedium" style={styles.emptyLeft}>Nothing received yet.</Text>
      ) : (
        past.map((d, index) => {
          const unit = d.food_items.unit;
          const short = d.status === 'received' ? d.quantity_dispatched - (d.quantity_received ?? 0) : 0;
          const cancelled = d.status === 'cancelled';
          return (
            <View key={d.distribution_id}>
              {index > 0 && <Divider />}
              <List.Item
                title={d.food_items.item_name}
                description={
                  cancelled
                    ? `Sent ${formatDay(d.dispatch_date)} · cancelled by the central store`
                    : `Received ${formatDay(d.received_date!)}` +
                      (short > 0 ? ` · ${formatQty(short, unit)} short of ${formatQty(d.quantity_dispatched, unit)}` : '')
                }
                descriptionNumberOfLines={3}
                style={styles.row}
                left={(props) => (
                  <List.Icon
                    {...props}
                    icon={cancelled ? 'close-circle-outline' : 'check-circle-outline'}
                    color={cancelled ? colors.textFaint : colors.successText}
                  />
                )}
                right={() => (
                  <Text variant="titleSmall" style={[styles.qty, cancelled ? styles.qtyMuted : styles.qtyIn]}>
                    {cancelled
                      ? formatQty(d.quantity_dispatched, unit)
                      : `+${formatQty(d.quantity_received ?? 0, unit)}`}
                  </Text>
                )}
              />
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
  tabBody: { flex: 1, marginTop: 16 },
  chipRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  summary: { marginTop: 16 },
  estimateCard: { borderRadius: 16, marginTop: 12 },
  estimateTitle: { color: c.text, marginBottom: 4 },
  estimateWarning: { color: c.warning, marginTop: 6 },
  lowCard: { borderColor: c.warning },
  lowTitle: { color: c.text },
  lowPill: { alignSelf: 'center', marginRight: 8 },
  lowButton: { alignSelf: 'center' },
  requestForm: { paddingBottom: 12 },
  supplierChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6, marginBottom: 4 },
  requestActions: { marginTop: 10, flexWrap: 'wrap' },
  sectionTitle: { marginTop: 24, marginBottom: 10, color: c.text },
  firstSection: { marginTop: 4 },
  meta: { color: c.textMuted },
  amountInput: { width: 104, alignSelf: 'center' },
  amountText: { textAlign: 'right' },
  inlineRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  inlineInput: { flex: 1, marginTop: 0 },
  // Lines the button up with the field's outline, below its floating label.
  inlineButton: { marginTop: 6 },
  smallButton: { alignSelf: 'flex-start' },
  cancelButton: { alignSelf: 'flex-start', marginTop: 4 },
  buttonContent: { paddingVertical: 6 },
  // Long "Confirm: …" labels wrap instead of being cut off.
  buttonLabel: { flexShrink: 1, textAlign: 'center' },
  emptyLeft: { color: c.textMuted },
  row: { paddingRight: 0 },
  rowContent: { paddingLeft: 0 },
  card: { borderRadius: 16, marginBottom: 10 },
  historyDay: { paddingVertical: 10 },
  historyDate: { color: c.text, marginBottom: 4 },
  historyLine: { color: c.textSecondary, marginTop: 2 },
  historyMeal: { color: c.textMuted },
  qty: { alignSelf: 'center', fontWeight: '600' },
  qtyIn: { color: c.successText },
  qtyMuted: { color: c.textMuted, textDecorationLine: 'line-through' },
  bottomSpacer: { height: 40 },
});
