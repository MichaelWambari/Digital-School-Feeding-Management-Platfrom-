import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, FlatList, RefreshControl } from 'react-native';
import { Divider, HelperText, Searchbar, Text } from 'react-native-paper';
import { supabase } from '../lib/supabase';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { useSchool } from '../school/SchoolContext';
import { FadeInScrollView } from '../components/Motion';
import { Button, ListItem } from '../components/Paper';
import { EmptyText, Field, ScreenHeader, StatusPill } from '../components/ScreenParts';

// Grouped as on the edit form. Folate is in dietary folate equivalents,
// which count folic acid added to fortified flour 1.7 times (as KFCT does).
const NUTRIENTS = [
  { key: 'iron_mg', label: 'Iron', unit: 'mg', group: 'Minerals' },
  { key: 'zinc_mg', label: 'Zinc', unit: 'mg', group: 'Minerals' },
  { key: 'calcium_mg', label: 'Calcium', unit: 'mg', group: 'Minerals' },
  { key: 'magnesium_mg', label: 'Magnesium', unit: 'mg', group: 'Minerals' },
  { key: 'vitamin_a_ug', label: 'Vitamin A', unit: 'µg RAE', group: 'Vitamins' },
  { key: 'folate_ug', label: 'Folate', unit: 'µg DFE', group: 'Vitamins' },
  { key: 'vitamin_b12_ug', label: 'Vitamin B12', unit: 'µg', group: 'Vitamins' },
  { key: 'thiamin_mg', label: 'Thiamin (B1)', unit: 'mg', group: 'Vitamins' },
  { key: 'riboflavin_mg', label: 'Riboflavin (B2)', unit: 'mg', group: 'Vitamins' },
  { key: 'niacin_mg', label: 'Niacin (B3)', unit: 'mg', group: 'Vitamins' },
  { key: 'vitamin_c_mg', label: 'Vitamin C', unit: 'mg', group: 'Vitamins' },
  { key: 'phytate_mg', label: 'Phytate', unit: 'mg', group: 'Absorption' },
  { key: 'energy_kcal', label: 'Energy', unit: 'kcal', group: 'Energy and macronutrients' },
  { key: 'protein_g', label: 'Protein', unit: 'g', group: 'Energy and macronutrients' },
  { key: 'carbohydrate_g', label: 'Carbohydrates', unit: 'g', group: 'Energy and macronutrients' },
  { key: 'fat_g', label: 'Fat', unit: 'g', group: 'Energy and macronutrients' },
  { key: 'fibre_g', label: 'Fibre', unit: 'g', group: 'Energy and macronutrients' },
] as const;
type NutrientKey = (typeof NUTRIENTS)[number]['key'];
const GROUP_NOTES: Record<string, string> = {
  Absorption:
    'Phytate, in whole grains and legumes, lowers how much iron and zinc the body absorbs. Empty means not known.',
};

type FoodValues = {
  food_id: string;
  item_name: string;
  unit: string;
  source: string | null;
  kfct_code?: string | null; // KFCT 2018 food code of the shared values (fix 017)
  is_school_value: boolean;
} & Record<NutrientKey, number | null>;

// A value for display; values not in the database yet (before fix 017) show as unknown.
const show = (v: number | null | undefined) => (v == null ? '?' : String(Number(v)));

const per100 = (f: { unit: string }) => (f.unit === 'litres' ? '100 ml' : '100 g');

// Nutrition values per 100 g (or 100 ml) of each food. Shared values come
// from the Kenya Food Composition Tables; a school can use its own.
export default function FoodValuesScreen({ navigation }: any) {
  const { colors, styles } = useThemedStyles(makeStyles);
  const { school } = useSchool();
  const [foods, setFoods] = useState<FoodValues[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<FoodValues | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc('school_food_nutrition', { p_school_id: school.school_id });
    if (error) {
      setError(
        error.code === 'PGRST202'
          ? "Nutrition values aren't set up yet. Run supabase/fixes/012_nutrition.sql."
          : error.message
      );
    } else {
      setError(null);
      setFoods((data ?? []) as FoodValues[]);
    }
    setLoading(false);
  }, [school.school_id]);

  useEffect(() => {
    load();
  }, [load]);

  if (editing) {
    return (
      <EditValuesView
        food={editing}
        onBack={() => setEditing(null)}
        onSaved={async () => {
          setEditing(null);
          await load();
        }}
      />
    );
  }

  const term = search.trim().toLowerCase();
  const shown = term ? foods.filter((f) => f.item_name.toLowerCase().includes(term)) : foods;

  return (
    <View style={styles.container}>
      <ScreenHeader title="Food values" onBack={() => navigation.goBack()} />
      <Text variant="bodySmall" style={styles.hint}>
        Nutrients per 100 g (100 ml for liquids), used to estimate what each serving provides.
        The shared values are from the Kenya Food Composition Tables 2018 (FAO/Government of
        Kenya), with the KFCT food code shown.
      </Text>
      <Searchbar
        value={search}
        onChangeText={setSearch}
        placeholder="Search foods"
        elevation={0}
        style={styles.search}
      />
      {error && <HelperText type="error">{error}</HelperText>}
      <FlatList
        style={styles.list}
        data={shown}
        keyExtractor={(f) => f.food_id}
        ItemSeparatorComponent={Divider}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.primary} />}
        ListEmptyComponent={loading ? undefined : <EmptyText>No foods found.</EmptyText>}
        renderItem={({ item }) => {
          const known = item.energy_kcal !== null;
          return (
            <ListItem
              title={item.item_name}
              description={
                known
                  ? `Per ${per100(item)}: iron ${show(item.iron_mg)} mg · zinc ${show(item.zinc_mg)} mg · ` +
                    `vitamin A ${show(item.vitamin_a_ug)} µg · folate ${show(item.folate_ug)} µg` +
                    `\n${item.kfct_code ? `KFCT ${item.kfct_code}` : item.source ?? ''}`
                  : 'No values yet'
              }
              descriptionNumberOfLines={2}
              onPress={() => setEditing(item)}
              style={styles.row}
              right={() =>
                !known ? (
                  <StatusPill label="missing" tone="warning" style={styles.pill} />
                ) : item.is_school_value ? (
                  <StatusPill label="school's own" tone="info" style={styles.pill} />
                ) : null
              }
            />
          );
        }}
      />
    </View>
  );
}

function EditValuesView({
  food,
  onBack,
  onSaved,
}: {
  food: FoodValues;
  onBack: () => void;
  onSaved: () => Promise<void>;
}) {
  const { styles } = useThemedStyles(makeStyles);
  const { can } = useSchool();
  const canEdit = can('manage_meals');
  const [values, setValues] = useState<Record<NutrientKey, string>>(
    () => Object.fromEntries(NUTRIENTS.map((n) => [n.key, food[n.key] == null ? '' : String(Number(food[n.key]))])) as Record<NutrientKey, string>
  );
  const [source, setSource] = useState(food.is_school_value ? food.source ?? '' : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    const payload: Record<string, number> = {};
    for (const n of NUTRIENTS) {
      const text = values[n.key].trim();
      if (text === '') continue; // unknown
      const v = Number(text);
      if (!Number.isFinite(v) || v < 0) {
        setError(`${n.label} must be a number, 0 or more.`);
        return;
      }
      payload[n.key] = v;
    }
    if (!source.trim()) {
      setError('Say where these values come from, e.g. "Packet label" or a food table.');
      return;
    }
    setSaving(true);
    setError(null);
    const { error } = await supabase.rpc('set_food_nutrition', {
      p_food_id: food.food_id,
      p_values: payload,
      p_source: source.trim(),
    });
    setSaving(false);
    if (error) {
      setError(error.code === '42501' ? "You don't have permission to change nutrition values." : error.message);
      return;
    }
    await onSaved();
  }

  async function handleReset() {
    setSaving(true);
    setError(null);
    const { error } = await supabase.rpc('reset_food_nutrition', { p_food_id: food.food_id });
    setSaving(false);
    if (error) {
      setError(error.message);
      return;
    }
    await onSaved();
  }

  return (
    <FadeInScrollView style={styles.container} keyboardShouldPersistTaps="handled">
      <ScreenHeader title={food.item_name} onBack={onBack} backLabel="Food values" backDisabled={saving} />
      <Text variant="bodySmall" style={styles.hint}>
        Per {per100(food)}, raw. Leave a box empty if the value isn't known.
        {food.source ? ` Current source: ${food.source}.` : ''}
      </Text>
      {!canEdit && (
        <Text variant="bodySmall" style={styles.hint}>View only. Staff who manage meals can change these.</Text>
      )}

      {NUTRIENTS.map((n, i) => (
        <View key={n.key}>
          {(i === 0 || NUTRIENTS[i - 1].group !== n.group) && (
            <>
              <Text variant="titleSmall" style={styles.groupTitle}>{n.group}</Text>
              {GROUP_NOTES[n.group] && (
                <Text variant="bodySmall" style={styles.hint}>{GROUP_NOTES[n.group]}</Text>
              )}
            </>
          )}
          <Field
            label={`${n.label} (${n.unit})`}
            value={values[n.key]}
            onChangeText={(text) => setValues({ ...values, [n.key]: text })}
            keyboardType="decimal-pad"
            disabled={!canEdit}
          />
        </View>
      ))}

      {canEdit && (
        <>
          <Field
            label="Source *"
            value={source}
            onChangeText={setSource}
            placeholder="e.g. Packet label, or KFCT 2018 code 01022"
          />
          <Text variant="bodySmall" style={styles.hint}>
            Saving makes these {'your school\'s own'} values for {food.item_name}. Other schools keep theirs.
            Meals already recorded keep the values they were worked out with.
          </Text>
          <HelperText type="error" visible={!!error}>
            {error}
          </HelperText>
          <Button mode="contained" onPress={handleSave} loading={saving} disabled={saving} contentStyle={styles.buttonContent}>
            Save for my school
          </Button>
          {food.is_school_value && (
            <Button mode="text" onPress={handleReset} disabled={saving} style={styles.resetButton}>
              Use the shared values again
            </Button>
          )}
        </>
      )}
      <View style={styles.bottomSpacer} />
    </FadeInScrollView>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background, padding: 20 },
  hint: { color: c.textMuted, marginBottom: 8 },
  groupTitle: { color: c.text, marginTop: 16, marginBottom: 4 },
  search: { backgroundColor: c.surface },
  list: { marginTop: 12 },
  row: { paddingLeft: 0, paddingRight: 0 },
  pill: { alignSelf: 'center' },
  buttonContent: { paddingVertical: 6 },
  resetButton: { marginTop: 8 },
  bottomSpacer: { height: 40 },
});
