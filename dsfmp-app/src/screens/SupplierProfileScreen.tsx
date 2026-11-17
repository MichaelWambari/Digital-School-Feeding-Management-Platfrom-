import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { ActivityIndicator, HelperText, Text } from 'react-native-paper';
import { supabase } from '../lib/supabase';
import { describeSupplierError } from '../lib/suppliers';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { useSupplier } from '../school/SchoolContext';
import { FadeInScrollView } from '../components/Motion';
import { Button, Chip } from '../components/Paper';
import { ScreenHeader } from '../components/ScreenParts';
import { SupplierFields, checkSupplierForm, supplierForm, supplierParams } from '../components/SupplierForm';

type Food = { food_id: string; item_name: string };

// The supplier edits its business details and picks the foods it supplies
// from the shared food list.
export default function SupplierProfileScreen({ navigation }: any) {
  const { styles } = useThemedStyles(makeStyles);
  const { supplier, reload } = useSupplier();
  const [form, setForm] = useState(() => supplierForm(supplier));
  const [foods, setFoods] = useState<Food[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const loadFoods = useCallback(async () => {
    const [list, mine] = await Promise.all([
      supabase.from('food_items').select('food_id, item_name').is('school_id', null).order('item_name'),
      supabase.from('supplier_foods').select('food_id').eq('supplier_id', supplier.supplier_id),
    ]);
    if (list.error || mine.error) {
      setError(describeSupplierError((list.error ?? mine.error)!));
      setFoods([]);
      return;
    }
    setFoods((list.data ?? []) as Food[]);
    setChosen(new Set(((mine.data ?? []) as { food_id: string }[]).map((r) => r.food_id)));
  }, [supplier.supplier_id]);

  useEffect(() => {
    loadFoods();
  }, [loadFoods]);

  function toggle(id: string) {
    setSaved(false);
    setChosen((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function handleSave() {
    const problem = checkSupplierForm(form);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const profileResult = await supabase.rpc('update_my_supplier', supplierParams(form));
      if (profileResult.error) {
        setError(describeSupplierError(profileResult.error));
        return;
      }
      const foodsResult = await supabase.rpc('set_my_supplier_foods', { p_food_ids: [...chosen] });
      if (foodsResult.error) {
        setError(describeSupplierError(foodsResult.error));
        return;
      }
      setSaved(true);
      await reload();
    } catch {
      setError('Unable to connect. Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <FadeInScrollView style={styles.container} keyboardShouldPersistTaps="handled">
      <ScreenHeader title="Business profile" onBack={() => navigation.goBack()} backDisabled={saving} />

      <Text variant="titleSmall" style={styles.section}>Foods you supply</Text>
      <Text variant="bodySmall" style={styles.hint}>
        Schools can find you by these. Tap to choose.
      </Text>
      {foods === null ? (
        <ActivityIndicator style={styles.loading} />
      ) : (
        <View style={styles.chips}>
          {foods.map((f) => (
            <Chip
              key={f.food_id}
              mode={chosen.has(f.food_id) ? 'flat' : 'outlined'}
              selected={chosen.has(f.food_id)}
              showSelectedCheck
              onPress={() => toggle(f.food_id)}
              disabled={saving}
            >
              {f.item_name}
            </Chip>
          ))}
        </View>
      )}

      <Text variant="titleSmall" style={styles.section}>Business details</Text>
      <SupplierFields
        form={form}
        onChange={(f) => {
          setSaved(false);
          setForm(f);
        }}
        disabled={saving}
      />

      {saved ? (
        <HelperText type="info" visible>Saved.</HelperText>
      ) : (
        <HelperText type="error" visible={!!error}>{error}</HelperText>
      )}
      <Button
        mode="contained"
        icon="content-save-outline"
        onPress={handleSave}
        loading={saving}
        disabled={saving}
        contentStyle={styles.buttonContent}
        style={styles.saveButton}
      >
        Save
      </Button>
    </FadeInScrollView>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background, padding: 20 },
  section: { color: c.text, marginTop: 16 },
  hint: { color: c.textMuted, marginTop: 2, marginBottom: 10 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  loading: { marginVertical: 16 },
  buttonContent: { paddingVertical: 6 },
  saveButton: { marginBottom: 40 },
});
