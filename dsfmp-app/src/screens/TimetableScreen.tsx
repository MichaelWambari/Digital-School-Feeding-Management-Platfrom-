import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, RefreshControl, ScrollView } from 'react-native';
import { Card, HelperText, List, Text } from 'react-native-paper';
import { supabase } from '../lib/supabase';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { useSchool } from '../school/SchoolContext';
import { FadeInScrollView } from '../components/Motion';
import { Button, Chip, IconButton } from '../components/Paper';
import { Field, ScreenHeader } from '../components/ScreenParts';

type MealType = 'breakfast' | 'lunch' | 'supper';
type Schedule = {
  schedule_id: string;
  weekday: number;
  meal_type: MealType;
  start_time: string;
  end_time: string;
  meal_id: string | null;
};
type Dish = { meal_id: string; name: string };
type Food = { food_id: string; item_name: string; unit: string };
// One food in a dish's per-student serving (grams, or ml for litre foods).
type Ingredient = { meal_id: string; food_id: string; amount_per_serving: number };
type ServingRow = { food_id: string; amount: string };

const MEAL_TYPES: MealType[] = ['breakfast', 'lunch', 'supper'];
const MEAL_LABELS: Record<MealType, string> = { breakfast: 'Breakfast', lunch: 'Lunch', supper: 'Supper' };
const MEAL_ICONS: Record<MealType, string> = {
  breakfast: 'weather-sunset-up',
  lunch: 'white-balance-sunny',
  supper: 'weather-night',
};
// ISO weekdays: 1 = Monday ... 7 = Sunday.
const DAYS = [1, 2, 3, 4, 5, 6, 7];
const DAY_SHORT = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_LONG = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DEFAULT_WINDOWS: Record<MealType, [string, string]> = {
  breakfast: ['06:00', '07:00'],
  lunch: ['12:00', '14:00'],
  supper: ['18:00', '20:00'],
};

const CONNECTION_ERROR = 'Unable to connect. Check your connection and try again.';

// Serving amounts are grams for foods counted in kg, millilitres for litres.
const servingUnit = (food?: Food) => (food?.unit === 'litres' ? 'ml' : 'g');

// Today's weekday at the school (ISO numbering).
function todayWeekday(timezone: string) {
  const name = new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: timezone }).format(new Date());
  return Math.max(1, DAY_LONG.indexOf(name));
}

// "07:00:00" -> "07:00"
const hhmm = (t: string) => t.slice(0, 5);
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

// The school's weekly feeding timetable: which meals are served on each
// day, their attendance windows, and the dish on the menu. NFC scans are
// only accepted inside these windows.
export default function TimetableScreen({ navigation }: any) {
  const { colors, styles } = useThemedStyles(makeStyles);
  const { school, can } = useSchool();
  const canEdit = can('manage_meals');
  const [day, setDay] = useState(() => todayWeekday(school.timezone));
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [dishes, setDishes] = useState<Dish[]>([]);
  const [foods, setFoods] = useState<Food[]>([]);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<MealType | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [scheduleResult, dishResult, foodResult, ingredientResult] = await Promise.all([
      supabase
        .from('meal_schedules')
        .select('schedule_id, weekday, meal_type, start_time, end_time, meal_id')
        .eq('school_id', school.school_id),
      supabase
        .from('meals')
        .select('meal_id, name')
        .eq('school_id', school.school_id)
        .eq('status', 'active')
        .order('name'),
      supabase.from('food_items').select('food_id, item_name, unit').order('item_name'),
      supabase
        .from('meal_ingredients')
        .select('meal_id, food_id, amount_per_serving')
        .eq('school_id', school.school_id),
    ]);
    // meal_ingredients arrives with fix 011; the timetable still works without it.
    const loadError = scheduleResult.error ?? dishResult.error ?? foodResult.error;
    if (loadError) {
      setError(
        loadError.code === '42P01' || loadError.code === 'PGRST205'
          ? 'The timetable isn\'t set up yet. Run supabase/fixes/010_meal_timetable.sql.'
          : `Could not load the timetable: ${loadError.message}`
      );
    } else {
      setError(null);
      setSchedules((scheduleResult.data ?? []) as Schedule[]);
      setDishes((dishResult.data ?? []) as Dish[]);
      setFoods((foodResult.data ?? []) as Food[]);
      setIngredients(ingredientResult.error ? [] : ((ingredientResult.data ?? []) as Ingredient[]));
    }
    setLoading(false);
  }, [school.school_id]);

  useEffect(() => {
    load();
  }, [load]);

  const dishName = (id: string | null) => dishes.find((d) => d.meal_id === id)?.name ?? null;
  const servingText = (id: string | null) =>
    ingredients
      .filter((i) => i.meal_id === id)
      .map((i) => {
        const f = foods.find((x) => x.food_id === i.food_id);
        return f ? `${f.item_name} ${Number(i.amount_per_serving)} ${servingUnit(f)}` : null;
      })
      .filter(Boolean)
      .join(' · ');
  const entry = (weekday: number, meal: MealType) =>
    schedules.find((s) => s.weekday === weekday && s.meal_type === meal);

  if (editing) {
    return (
      <EditMealView
        day={day}
        mealType={editing}
        current={entry(day, editing)}
        schedules={schedules}
        dishes={dishes}
        foods={foods}
        ingredients={ingredients}
        onCancel={() => setEditing(null)}
        onSaved={async () => {
          setEditing(null);
          await load();
        }}
      />
    );
  }

  const today = todayWeekday(school.timezone);

  return (
    <FadeInScrollView
      style={styles.container}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.primary} />}
    >
      <ScreenHeader
        title="Timetable"
        onBack={() => navigation.goBack()}
        right={
          <Button mode="text" icon="nutrition" onPress={() => navigation.navigate('FoodValues')}>
            Food values
          </Button>
        }
      />
      <Text variant="bodySmall" style={styles.hint}>
        Students can only register attendance inside these times ({school.timezone} time).
        {canEdit ? ' Tap a meal to change it.' : ''}
      </Text>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.dayRow}>
        {DAYS.map((d) => (
          <Chip
            key={d}
            mode={d === day ? 'flat' : 'outlined'}
            selected={d === day}
            showSelectedCheck={false}
            onPress={() => setDay(d)}
          >
            {DAY_SHORT[d] + (d === today ? ' · today' : '')}
          </Chip>
        ))}
      </ScrollView>

      {error && <HelperText type="error">{error}</HelperText>}

      <Text variant="titleMedium" style={styles.dayTitle}>{DAY_LONG[day]}</Text>
      {MEAL_TYPES.map((meal) => {
        const s = entry(day, meal);
        const dish = s ? dishName(s.meal_id) : null;
        const serving = s ? servingText(s.meal_id) : '';
        return (
          <Card
            key={meal}
            mode="contained"
            style={[styles.card, !s && styles.cardOff]}
            onPress={canEdit ? () => setEditing(meal) : undefined}
          >
            <Card.Title
              title={MEAL_LABELS[meal]}
              subtitle={
                s
                  ? `${hhmm(s.start_time)}–${hhmm(s.end_time)} · ${dish ?? 'No dish chosen yet'}` +
                    (dish ? `\nPer student: ${serving || 'serving not set'}` : '')
                  : 'Not served'
              }
              subtitleNumberOfLines={3}
              left={(props) => (
                <List.Icon {...props} icon={MEAL_ICONS[meal]} color={s ? colors.primary : colors.textFaint} />
              )}
              right={(props) =>
                canEdit ? <List.Icon {...props} icon={s ? 'pencil-outline' : 'plus'} color={colors.textMuted} /> : null
              }
            />
          </Card>
        );
      })}

      <Text variant="titleSmall" style={styles.sectionTitle}>The week</Text>
      {MEAL_TYPES.map((meal) => (
        <View key={meal} style={styles.weekRow}>
          <Text variant="labelLarge" style={styles.weekMeal}>{MEAL_LABELS[meal]}</Text>
          <Text variant="bodySmall" style={styles.weekDays}>
            {DAYS.map((d) => {
              const s = entry(d, meal);
              return s ? `${DAY_SHORT[d]} ${hhmm(s.start_time)}` : null;
            })
              .filter(Boolean)
              .join(' · ') || 'Not served'}
          </Text>
        </View>
      ))}
      <View style={styles.bottomSpacer} />
    </FadeInScrollView>
  );
}

function EditMealView({
  day,
  mealType,
  current,
  schedules,
  dishes,
  foods,
  ingredients,
  onCancel,
  onSaved,
}: {
  day: number;
  mealType: MealType;
  current: Schedule | undefined;
  schedules: Schedule[];
  dishes: Dish[];
  foods: Food[];
  ingredients: Ingredient[];
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const { colors, styles } = useThemedStyles(makeStyles);
  const { school } = useSchool();
  const [start, setStart] = useState(current ? hhmm(current.start_time) : DEFAULT_WINDOWS[mealType][0]);
  const [end, setEnd] = useState(current ? hhmm(current.end_time) : DEFAULT_WINDOWS[mealType][1]);
  const [dishId, setDishId] = useState<string | null>(current?.meal_id ?? null);
  const [newDish, setNewDish] = useState('');
  const servingOf = (id: string | null): ServingRow[] =>
    ingredients
      .filter((i) => i.meal_id === id)
      .map((i) => ({ food_id: i.food_id, amount: String(Number(i.amount_per_serving)) }));
  const [serving, setServing] = useState<ServingRow[]>(() => servingOf(current?.meal_id ?? null));
  const [servingChanged, setServingChanged] = useState(false);
  const [foodSearch, setFoodSearch] = useState('');

  function chooseDish(id: string | null) {
    setDishId(id);
    setNewDish('');
    setServing(servingOf(id));
    setServingChanged(false);
  }
  function editServing(rows: ServingRow[]) {
    setServing(rows);
    setServingChanged(true);
  }
  const [days, setDays] = useState<number[]>([day]);
  const [saving, setSaving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleDay = (d: number) =>
    setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort()));
  const servedOn = DAYS.filter((d) => schedules.some((s) => s.weekday === d && s.meal_type === mealType));

  async function handleSave() {
    if (!TIME_PATTERN.test(start) || !TIME_PATTERN.test(end)) {
      setError('Enter times as HH:MM in 24-hour time, e.g. 07:30.');
      return;
    }
    if (start >= end) {
      setError('The window must end after it starts.');
      return;
    }
    if (days.length === 0) {
      setError('Choose at least one day.');
      return;
    }
    for (const row of serving) {
      const amount = Number(row.amount.trim());
      const food = foods.find((f) => f.food_id === row.food_id);
      if (!Number.isFinite(amount) || amount <= 0 || amount > 5000) {
        setError(`Enter the ${food?.item_name ?? 'food'} per student in ${servingUnit(food)}, more than 0.`);
        return;
      }
    }
    setSaving(true);
    setError(null);
    try {
      let mealId = dishId;
      const typed = newDish.trim();
      if (typed) {
        // A new dish: reuse one with the same name, or add it.
        const existing = dishes.find((d) => d.name.toLowerCase() === typed.toLowerCase());
        if (existing) {
          mealId = existing.meal_id;
        } else {
          const { data, error } = await supabase
            .from('meals')
            .insert({ school_id: school.school_id, name: typed })
            .select('meal_id')
            .single();
          if (error) {
            setError(error.code === '23505' ? 'A dish with that name already exists.' : error.message);
            return;
          }
          mealId = data.meal_id;
        }
      }
      // The serving belongs to the dish, so it applies wherever the dish is served.
      if (mealId && (servingChanged || typed)) {
        const { error } = await supabase.rpc('set_meal_ingredients', {
          p_meal_id: mealId,
          p_items: serving.map((r) => ({ food_id: r.food_id, amount: Number(r.amount.trim()) })),
        });
        if (error) {
          setError(
            error.code === 'PGRST202'
              ? "Serving amounts aren't set up yet. Run supabase/fixes/011_meal_servings.sql."
              : error.message
          );
          return;
        }
      }
      const { error } = await supabase.rpc('set_meal_schedule', {
        p_weekdays: days,
        p_meal_type: mealType,
        p_start_time: start,
        p_end_time: end,
        p_meal_id: mealId,
      });
      if (error) {
        setError(error.code === '42501' ? 'You don\'t have permission to change the timetable.' : error.message);
        return;
      }
      await onSaved();
    } catch {
      setError(CONNECTION_ERROR);
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove() {
    if (!current) return;
    if (!confirmRemove) {
      setConfirmRemove(true);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const { data, error } = await supabase
        .from('meal_schedules')
        .delete()
        .eq('schedule_id', current.schedule_id)
        .select('schedule_id');
      if (error || !data?.length) {
        setError(error?.message ?? 'You don\'t have permission to change the timetable.');
        return;
      }
      await onSaved();
    } catch {
      setError(CONNECTION_ERROR);
    } finally {
      setSaving(false);
      setConfirmRemove(false);
    }
  }

  return (
    <FadeInScrollView style={styles.container} keyboardShouldPersistTaps="handled">
      <ScreenHeader
        title={`${MEAL_LABELS[mealType]} · ${DAY_LONG[day]}`}
        onBack={onCancel}
        backLabel="Cancel"
        backDisabled={saving}
      />

      <Text variant="labelLarge" style={styles.label}>Attendance window</Text>
      <View style={styles.timeRow}>
        <Field
          label="Opens"
          style={styles.timeField}
          value={start}
          onChangeText={setStart}
          placeholder="07:00"
          keyboardType="numbers-and-punctuation"
          maxLength={5}
        />
        <Field
          label="Closes"
          style={styles.timeField}
          value={end}
          onChangeText={setEnd}
          placeholder="08:30"
          keyboardType="numbers-and-punctuation"
          maxLength={5}
        />
      </View>
      <Text variant="bodySmall" style={styles.hint}>
        24-hour time. A scan at the closing time is too late.
      </Text>

      <Text variant="labelLarge" style={styles.label}>Dish</Text>
      <View style={styles.chipWrap}>
        {dishes.map((d) => (
          <Chip
            key={d.meal_id}
            mode={dishId === d.meal_id && !newDish.trim() ? 'flat' : 'outlined'}
            selected={dishId === d.meal_id && !newDish.trim()}
            onPress={() => chooseDish(dishId === d.meal_id ? null : d.meal_id)}
          >
            {d.name}
          </Chip>
        ))}
      </View>
      <Field
        label="Or a new dish"
        value={newDish}
        onChangeText={(text) => {
          setNewDish(text);
          if (text.trim() && dishId) setDishId(null);
        }}
        placeholder="e.g. Rice and beans"
      />

      {(dishId || newDish.trim()) && (
        <>
          <Text variant="labelLarge" style={styles.label}>Per-student serving</Text>
          <Text variant="bodySmall" style={styles.hint}>
            The food one student gets. Food used at the meal is worked out as students who
            attended × this serving. It applies wherever this dish is served.
          </Text>
          {serving.length === 0 && (
            <Text variant="bodyMedium" style={styles.emptyServing}>No food added yet.</Text>
          )}
          {serving.map((row, index) => {
            const food = foods.find((f) => f.food_id === row.food_id);
            return (
              <View key={row.food_id} style={styles.servingRow}>
                <Text variant="bodyLarge" style={styles.servingFood} numberOfLines={1}>
                  {food?.item_name ?? 'Food'}
                </Text>
                <Field
                  label={servingUnit(food)}
                  style={styles.servingAmount}
                  value={row.amount}
                  onChangeText={(amount) =>
                    editServing(serving.map((r, i) => (i === index ? { ...r, amount } : r)))
                  }
                  keyboardType="decimal-pad"
                  placeholder="0"
                />
                <IconButton
                  icon="close"
                  accessibilityLabel={`Remove ${food?.item_name ?? 'food'}`}
                  onPress={() => editServing(serving.filter((_, i) => i !== index))}
                />
              </View>
            );
          })}
          <Field
            label="Add a food"
            value={foodSearch}
            onChangeText={setFoodSearch}
            placeholder="Search the food list"
          />
          <View style={styles.chipWrap}>
            {foods
              .filter((f) => !serving.some((r) => r.food_id === f.food_id))
              .filter((f) => f.item_name.toLowerCase().includes(foodSearch.trim().toLowerCase()))
              .slice(0, 12)
              .map((f) => (
                <Chip
                  key={f.food_id}
                  mode="outlined"
                  icon="plus"
                  onPress={() => {
                    editServing([...serving, { food_id: f.food_id, amount: '' }]);
                    setFoodSearch('');
                  }}
                >
                  {f.item_name}
                </Chip>
              ))}
          </View>
        </>
      )}

      <Text variant="labelLarge" style={styles.label}>Save for</Text>
      <View style={styles.chipWrap}>
        {DAYS.map((d) => (
          <Chip
            key={d}
            mode={days.includes(d) ? 'flat' : 'outlined'}
            selected={days.includes(d)}
            onPress={() => toggleDay(d)}
          >
            {DAY_SHORT[d]}
          </Chip>
        ))}
      </View>
      <View style={styles.quickRow}>
        <Button mode="text" compact onPress={() => setDays([1, 2, 3, 4, 5])}>Mon–Fri</Button>
        <Button mode="text" compact onPress={() => setDays(DAYS)}>Every day</Button>
        <Button mode="text" compact onPress={() => setDays([day])}>Only {DAY_SHORT[day]}</Button>
      </View>
      {days.some((d) => d !== day && servedOn.includes(d)) && (
        <Text variant="bodySmall" style={styles.hint}>
          This replaces {MEAL_LABELS[mealType].toLowerCase()} on the other days you chose.
        </Text>
      )}

      <HelperText type="error" visible={!!error}>
        {error}
      </HelperText>

      <Button
        mode="contained"
        icon="content-save-outline"
        onPress={handleSave}
        loading={saving && !confirmRemove}
        disabled={saving}
        contentStyle={styles.buttonContent}
      >
        Save {MEAL_LABELS[mealType].toLowerCase()}
      </Button>

      {current && (
        <Button
          mode={confirmRemove ? 'contained' : 'text'}
          icon="close-circle-outline"
          buttonColor={confirmRemove ? colors.danger : undefined}
          textColor={confirmRemove ? undefined : colors.danger}
          onPress={handleRemove}
          disabled={saving}
          style={styles.removeButton}
        >
          {confirmRemove
            ? `Confirm: no ${MEAL_LABELS[mealType].toLowerCase()} on ${DAY_LONG[day]}s`
            : `Not served on ${DAY_LONG[day]}s`}
        </Button>
      )}
      <View style={styles.bottomSpacer} />
    </FadeInScrollView>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background, padding: 20 },
  hint: { color: c.textMuted, marginTop: 4, marginBottom: 4 },
  dayRow: { gap: 8, paddingVertical: 12 },
  dayTitle: { color: c.text, marginTop: 4, marginBottom: 8 },
  card: { borderRadius: 16, marginBottom: 10 },
  cardOff: { opacity: 0.6 },
  sectionTitle: { color: c.text, marginTop: 20, marginBottom: 6 },
  weekRow: { paddingVertical: 6 },
  weekMeal: { color: c.textSecondary },
  weekDays: { color: c.textMuted, marginTop: 2 },
  label: { color: c.textSecondary, marginBottom: 4, marginTop: 16 },
  timeRow: { flexDirection: 'row', gap: 12 },
  timeField: { flex: 1 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  quickRow: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 4 },
  buttonContent: { paddingVertical: 6 },
  removeButton: { marginTop: 12 },
  emptyServing: { color: c.textMuted, marginTop: 4 },
  servingRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  servingFood: { flex: 1, color: c.text, marginTop: 8 },
  servingAmount: { width: 96 },
  bottomSpacer: { height: 40 },
});
