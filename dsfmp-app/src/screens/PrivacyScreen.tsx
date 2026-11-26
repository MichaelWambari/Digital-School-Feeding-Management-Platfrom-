import React, { useEffect, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { Checkbox, HelperText, Surface, Text } from 'react-native-paper';
import { supabase } from '../lib/supabase';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { FadeInScrollView } from '../components/Motion';
import { Button } from '../components/Paper';
import { ScreenHeader } from '../components/ScreenParts';

// The privacy notice (Kenya Data Protection Act, 2019). Anyone can read
// it, also before signing in. Opened with { acceptFor: school_id } by a
// headteacher, it also records that the school accepts the terms
// (accept_data_terms, fix 030).
const SECTIONS: { title: string; body: string[] }[] = [
  {
    title: 'Who is responsible',
    body: [
      "Each school decides what personal data it records in DSFMP and is responsible for it (the data controller). The school's headteacher answers questions and requests about it.",
      "DSFMP stores the data for the school in a cloud database (Supabase). Schools can't see each other's data, and suppliers never see learners' data.",
    ],
  },
  {
    title: 'What is recorded',
    body: [
      "Learners: name, admission number, NEMIS UPI, date of birth or age, sex, school card ID, the meals they were recorded at, and the nutrients those meals gave them.",
      'Staff: name, email address, role and actions in the app (an audit log).',
      'Suppliers: business and contact details, KRA PIN, registration number and uploaded documents.',
      'Card readers log each tap: the card ID, the reader and the time.',
    ],
  },
  {
    title: 'Why',
    body: [
      "Only to run the school's feeding programme: knowing who ate each meal, planning and accounting for food, and checking that meals meet learners' nutritional needs. Age and sex are needed because those needs depend on them.",
      'The data is not sold, used for advertising or shared with anyone outside the school, other than the hosting service that stores it.',
    ],
  },
  {
    title: "Children's data",
    body: [
      "Under section 33 of the Data Protection Act, a child's data may only be processed with the consent of a parent or guardian, and in the child's best interests. Before adding learners, the school tells parents or guardians how the data is used and gets their consent. The headteacher confirms this in the app.",
    ],
  },
  {
    title: 'Who can see it',
    body: [
      "Only signed-in staff of the learner's school, and only the parts their role allows (set by the headteacher on the Permissions screen). Every change to a learner's record is logged.",
      'Data travels over encrypted connections, and each card reader has its own secret.',
    ],
  },
  {
    title: 'How long it is kept',
    body: [
      "Records stay while the school needs them for the feeding programme. When a learner leaves, the school marks them inactive. The headteacher can erase a learner completely (Students → edit → Erase student), which removes their attendance and nutrition records and their details in the audit log.",
    ],
  },
  {
    title: 'Your rights',
    body: [
      "Learners, parents and guardians, and staff can ask the school's headteacher to see the data held about them, correct it, or erase it, and can object to how it is used.",
      'Complaints can be made to the Office of the Data Protection Commissioner (www.odpc.go.ke).',
    ],
  },
];

export default function PrivacyScreen({ navigation, route }: any) {
  const { colors, styles } = useThemedStyles(makeStyles);
  const acceptFor: string | undefined = route?.params?.acceptFor;
  const [acceptedAt, setAcceptedAt] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!acceptFor) return;
    supabase
      .from('schools')
      .select('data_terms_accepted_at')
      .eq('school_id', acceptFor)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) {
          setError(
            error.code === '42703'
              ? 'Run supabase/fixes/030_data_protection.sql to record that the terms were accepted.'
              : error.message
          );
          return;
        }
        setAcceptedAt(data?.data_terms_accepted_at ?? null);
      });
  }, [acceptFor]);

  async function accept() {
    setSaving(true);
    setError(null);
    const { data, error } = await supabase.rpc('accept_data_terms', { p_school_id: acceptFor });
    setSaving(false);
    if (error) {
      setError(
        error.code === 'PGRST202'
          ? 'Run supabase/fixes/030_data_protection.sql first.'
          : error.message
      );
      return;
    }
    setAcceptedAt(data as string);
  }

  return (
    <FadeInScrollView style={styles.container} contentContainerStyle={styles.content}>
      <ScreenHeader title="Privacy notice" onBack={() => navigation.goBack()} />
      <Text variant="bodyMedium" style={styles.intro}>
        How DSFMP uses personal data, under Kenya's Data Protection Act, 2019.
      </Text>

      {SECTIONS.map((s) => (
        <View key={s.title} style={styles.section}>
          <Text variant="titleSmall" style={styles.sectionTitle}>{s.title}</Text>
          {s.body.map((p, i) => (
            <Text key={i} variant="bodyMedium" style={styles.paragraph}>{p}</Text>
          ))}
        </View>
      ))}

      {acceptFor && (
        <Surface style={styles.acceptCard} elevation={1}>
          {acceptedAt ? (
            <Text variant="bodyMedium" style={{ color: colors.successText }}>
              Accepted on {new Date(acceptedAt).toLocaleString()}.
            </Text>
          ) : (
            <>
              <Checkbox.Item
                status={checked ? 'checked' : 'unchecked'}
                onPress={() => setChecked((c) => !c)}
                position="leading"
                labelStyle={styles.checkLabel}
                labelVariant="bodyMedium"
                label="I confirm that the school has told parents or guardians how their children's data is used, has their consent, and will use the data only for the feeding programme."
              />
              <Button mode="contained" onPress={accept} disabled={!checked || saving} loading={saving} style={styles.acceptButton}>
                Accept for the school
              </Button>
            </>
          )}
          <HelperText type="error" visible={!!error}>{error}</HelperText>
        </Surface>
      )}
    </FadeInScrollView>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background },
  content: { padding: 20, paddingBottom: 40, width: '100%', maxWidth: 720, alignSelf: 'center' },
  intro: { color: c.textSecondary, marginBottom: 8 },
  section: { marginTop: 16 },
  sectionTitle: { color: c.text, fontWeight: '700', marginBottom: 4 },
  paragraph: { color: c.textSecondary, marginTop: 4, lineHeight: 21 },
  acceptCard: { borderRadius: 16, padding: 12, marginTop: 24 },
  checkLabel: { textAlign: 'left', color: c.text },
  acceptButton: { marginTop: 8, borderRadius: 12 },
});
