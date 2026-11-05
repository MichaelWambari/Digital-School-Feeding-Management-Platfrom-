import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, FlatList, RefreshControl } from 'react-native';
import { Divider, HelperText, Searchbar, Text } from 'react-native-paper';
import { supabase } from '../lib/supabase';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { useSchool } from '../school/SchoolContext';
import { FadeInScrollView } from '../components/Motion';
import { Button, ListItem } from '../components/Paper';
import { EmptyText, Field, ScreenHeader, StatusPill } from '../components/ScreenParts';

const NUTRIENTS = [
  { key: 'energy_kcal', label: 'Energy', unit: 'kcal' },
  { key: 'protein_g', label: 'Protein', unit: 'g' },
  { key: 'carbohydrate_g', label: 'Carbohydrates', unit: 'g' },
  { key: 'fat_g', label: 'Fat', unit: 'g' },
  { key: 'fibre_g', label: 'Fibre', unit: 'g' },
  { key: 'calcium_mg', label: 'Calcium', unit: 'mg' },
  { key: 'iron_mg', label: 'Iron', unit: 'mg' },
  { key: 'zinc_mg', label: 'Zinc', unit: 'mg' },
  { key: 'vitamin_a_ug', label: 'Vitamin A', unit: 'µg RAE' },
  { key: 'vitamin_c_mg', label: 'Vitamin C', unit: 'mg' },
] as const;
type NutrientKey = (typeof NUTRIENTS)[number]['key'];

type FoodValues = {
  food_id: string;
  item_name: string;
  unit: string;
  source: string | null;
  is_school_value: boolean;
} & Record<NutrientKey, number | null>;

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
        The shared values are approximate figures from the Kenya Food Composition Tables 2018.
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
                  ? `Per ${per100(item)}: ${Number(item.energy_kcal)} kcal · ${Number(item.protein_g ?? 0)} g protein` +
                    `\n${item.source ?? ''}`
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
    () => Object.fromEntries(NUTRIENTS.map((n) => [n.key, food[n.key] === null ? '' : String(Number(food[n.key]))])) as Record<NutrientKey, string>
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

      {NUTRIENTS.map((n) => (
        <Field
          key={n.key}
          label={`${n.label} (${n.unit})`}
          value={values[n.key]}
          onChangeText={(text) => setValues({ ...values, [n.key]: text })}
          keyboardType="decimal-pad"
          disabled={!canEdit}
        />
      ))}

      {canEdit && (
        <>
          <Field
            label="Source *"
            value={source}
            onChangeText={setSource}
            placeholder="e.g. Packet label, or KFCT 2018 code 01_001"
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
  search: { backgroundColor: c.surface },
  list: { marginTop: 12 },
  row: { paddingLeft: 0, paddingRight: 0 },
  pill: { alignSelf: 'center' },
  buttonContent: { paddingVertical: 6 },
  resetButton: { marginTop: 8 },
  bottomSpacer: { height: 40 },
});
