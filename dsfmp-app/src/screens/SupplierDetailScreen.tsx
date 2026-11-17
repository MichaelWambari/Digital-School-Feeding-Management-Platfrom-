import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, Linking } from 'react-native';
import { Card, Divider, HelperText, List, Text } from 'react-native-paper';
import { supabase } from '../lib/supabase';
import {
  LINK_LABELS,
  LINK_TONES,
  SupplierDocument,
  describeSupplierError,
  documentTitle,
  formatDate,
  openDocument,
} from '../lib/suppliers';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { useSchool } from '../school/SchoolContext';
import { FadeInScrollView } from '../components/Motion';
import { Button, IconButton } from '../components/Paper';
import { EmptyText, Field, ScreenHeader, StatusPill } from '../components/ScreenParts';
import type { DirectorySupplier } from './SuppliersScreen';

// One supplier's profile and documents. The headteacher approves,
// declines or removes it here; others with the permission can look.
export default function SupplierDetailScreen({ navigation, route }: any) {
  const { colors, styles } = useThemedStyles(makeStyles);
  const { isHeadteacher } = useSchool();
  const [supplier, setSupplier] = useState<DirectorySupplier>(route.params.supplier);
  const [docs, setDocs] = useState<SupplierDocument[] | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadDocs = useCallback(async () => {
    const { data, error } = await supabase
      .from('supplier_documents')
      .select('*')
      .eq('supplier_id', supplier.supplier_id)
      .order('uploaded_at', { ascending: false });
    if (error) setError(describeSupplierError(error));
    setDocs((data ?? []) as SupplierDocument[]);
  }, [supplier.supplier_id]);

  useEffect(() => {
    loadDocs();
  }, [loadDocs]);

  async function decide(status: 'approved' | 'declined' | 'removed') {
    setBusy(status);
    setError(null);
    const { error } = await supabase.rpc('set_school_supplier', {
      p_supplier_id: supplier.supplier_id,
      p_status: status,
      p_note: note.trim() || null,
    });
    if (error) {
      setBusy(null);
      setError(describeSupplierError(error));
      return;
    }
    // Reload this supplier's row so the status shown is the saved one.
    const { data } = await supabase.rpc('school_supplier_directory');
    const fresh = ((data ?? []) as DirectorySupplier[]).find((r) => r.supplier_id === supplier.supplier_id);
    if (fresh) setSupplier(fresh);
    setNote('');
    setBusy(null);
  }

  async function handleOpen(doc: SupplierDocument) {
    setBusy(doc.document_id);
    setError(await openDocument(doc.file_path));
    setBusy(null);
  }

  const s = supplier;
  const details: [string, string, string | null][] = [
    ['account-outline', 'Contact person', s.contact_name],
    ['phone-outline', 'Phone', s.phone],
    ['email-outline', 'Email', s.email],
    ['card-account-details-outline', 'KRA PIN', s.kra_pin],
    ['domain', 'Business registration', s.registration_no],
    ['map-marker-outline', 'County', s.county],
    ['truck-delivery-outline', 'Delivers to', s.areas_served],
  ];

  return (
    <FadeInScrollView style={styles.container} keyboardShouldPersistTaps="handled">
      <ScreenHeader title={s.business_name} onBack={() => navigation.goBack()} backDisabled={busy !== null} />

      <View style={styles.statusRow}>
        {s.status ? (
          <StatusPill label={LINK_LABELS[s.status]} tone={LINK_TONES[s.status]} />
        ) : (
          <StatusPill label="Not approved" tone="muted" />
        )}
        <Text variant="bodySmall" style={styles.muted}>Registered {formatDate(s.registered_at)}</Text>
      </View>

      {s.status === 'requested' && (
        <Card mode="contained" style={styles.card}>
          <Card.Content>
            <Text variant="titleSmall" style={styles.text}>Asked to supply your school</Text>
            <Text variant="bodyMedium" style={styles.muted}>
              {s.message ? `"${s.message}"` : 'No note was added.'}
            </Text>
          </Card.Content>
        </Card>
      )}
      {(s.status === 'declined' || s.status === 'removed') && s.decision_note && (
        <Text variant="bodySmall" style={styles.muted}>Note: "{s.decision_note}"</Text>
      )}

      {s.description && <Text variant="bodyMedium" style={styles.description}>{s.description}</Text>}

      <Text variant="titleSmall" style={styles.section}>Foods</Text>
      <Text variant="bodyMedium" style={styles.text}>{s.foods.length ? s.foods.join(', ') : 'None listed yet.'}</Text>

      <Text variant="titleSmall" style={styles.section}>Details</Text>
      {details.map(([icon, label, value]) => (
        <List.Item
          key={label}
          title={value || 'Not given'}
          titleStyle={!value ? styles.muted : undefined}
          description={label}
          style={styles.row}
          left={(props) => <List.Icon {...props} icon={icon} />}
          right={
            value && label === 'Phone'
              ? () => (
                  <IconButton icon="phone" onPress={() => Linking.openURL(`tel:${value.replace(/\s/g, '')}`)}
                    accessibilityLabel={`Call ${s.business_name}`} />
                )
              : undefined
          }
        />
      ))}

      <Text variant="titleSmall" style={styles.section}>Documents</Text>
      {docs === null ? null : docs.length === 0 ? (
        <EmptyText>No documents uploaded.</EmptyText>
      ) : (
        docs.map((d, i) => (
          <View key={d.document_id}>
            {i > 0 && <Divider />}
            <List.Item
              title={documentTitle(d)}
              description={`${d.file_name} · ${formatDate(d.uploaded_at)}`}
              style={styles.row}
              onPress={() => handleOpen(d)}
              disabled={busy !== null}
              left={(props) => (
                <List.Icon {...props} icon={d.mime_type === 'application/pdf' ? 'file-pdf-box' : 'file-image-outline'} />
              )}
              right={(props) => <List.Icon {...props} icon="open-in-new" />}
            />
          </View>
        ))
      )}

      {isHeadteacher ? (
        <View style={styles.decision}>
          {(s.status === 'requested' || s.status === 'approved') && (
            <Field
              label={s.status === 'requested' ? 'Note if you decline (optional)' : 'Reason for removing (optional)'}
              value={note}
              onChangeText={setNote}
              multiline
            />
          )}
          <HelperText type="error" visible={!!error}>{error}</HelperText>
          {s.status !== 'approved' && (
            <Button mode="contained" icon="check" onPress={() => decide('approved')}
              loading={busy === 'approved'} disabled={busy !== null} contentStyle={styles.buttonContent}>
              {s.status === 'requested' ? 'Approve request' : 'Approve this supplier'}
            </Button>
          )}
          {s.status === 'requested' && (
            <Button mode="outlined" icon="close" textColor={colors.danger} onPress={() => decide('declined')}
              loading={busy === 'declined'} disabled={busy !== null} style={styles.secondButton}
              contentStyle={styles.buttonContent}>
              Decline
            </Button>
          )}
          {s.status === 'approved' && (
            <Button mode="outlined" icon="account-remove-outline" textColor={colors.danger}
              onPress={() => decide('removed')} loading={busy === 'removed'} disabled={busy !== null}
              contentStyle={styles.buttonContent}>
              Remove from your suppliers
            </Button>
          )}
        </View>
      ) : (
        <View style={styles.decision}>
          <HelperText type="error" visible={!!error}>{error}</HelperText>
          <Text variant="bodySmall" style={styles.muted}>Only the headteacher can approve suppliers.</Text>
        </View>
      )}
    </FadeInScrollView>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background, padding: 20 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  card: { borderRadius: 12, marginBottom: 12 },
  text: { color: c.text },
  muted: { color: c.textMuted },
  description: { color: c.textSecondary, marginTop: 4 },
  section: { color: c.text, marginTop: 20, marginBottom: 4 },
  row: { paddingLeft: 0, paddingRight: 0 },
  decision: { marginTop: 16, marginBottom: 40 },
  buttonContent: { paddingVertical: 6 },
  secondButton: { marginTop: 10 },
});
