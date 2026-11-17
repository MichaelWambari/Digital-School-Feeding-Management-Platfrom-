import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, FlatList, RefreshControl } from 'react-native';
import { Divider, HelperText, List, Surface, Text } from 'react-native-paper';
import { supabase } from '../lib/supabase';
import {
  DOC_TYPES,
  DocType,
  SupplierDocument,
  describeSupplierError,
  documentTitle,
  formatDate,
  openDocument,
  pickAndUploadDocument,
  removeDocument,
} from '../lib/suppliers';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { useSupplier } from '../school/SchoolContext';
import { Button, Chip, IconButton } from '../components/Paper';
import { EmptyText, Field, ScreenHeader } from '../components/ScreenParts';

// The supplier's documents (PDFs or photos), which schools look at before
// approving it. Stored privately; only the supplier and schools can open them.
export default function SupplierDocumentsScreen({ navigation }: any) {
  const { colors, styles } = useThemedStyles(makeStyles);
  const { supplier } = useSupplier();
  const [docs, setDocs] = useState<SupplierDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [docType, setDocType] = useState<DocType>('business_permit');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState<string | null>(null); // 'upload' or a document ID
  const [error, setError] = useState<string | null>(null);
  // The document waiting for a second tap to confirm removal.
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('supplier_documents')
      .select('*')
      .eq('supplier_id', supplier.supplier_id)
      .order('uploaded_at', { ascending: false });
    if (error) setError(describeSupplierError(error));
    else setDocs((data ?? []) as SupplierDocument[]);
    setLoading(false);
  }, [supplier.supplier_id]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleUpload() {
    if (docType === 'other' && !title.trim()) {
      setError('Say what the document is.');
      return;
    }
    setBusy('upload');
    setError(null);
    const result = await pickAndUploadDocument(supplier.supplier_id, docType, docType === 'other' ? title : '');
    setBusy(null);
    if (result === 'cancelled') return;
    if (result) {
      setError(result);
      return;
    }
    setTitle('');
    await load();
  }

  async function handleOpen(doc: SupplierDocument) {
    setBusy(doc.document_id);
    setError(await openDocument(doc.file_path));
    setBusy(null);
  }

  async function handleRemove(doc: SupplierDocument) {
    if (confirming !== doc.document_id) {
      setConfirming(doc.document_id);
      return;
    }
    setConfirming(null);
    setBusy(doc.document_id);
    const problem = await removeDocument(doc.document_id);
    setBusy(null);
    if (problem) setError(problem);
    else await load();
  }

  return (
    <View style={styles.container}>
      <ScreenHeader title="Documents" onBack={() => navigation.goBack()} />

      <Surface style={styles.card} elevation={1}>
        <Text variant="titleSmall" style={styles.cardTitle}>Add a document</Text>
        <Text variant="bodySmall" style={styles.hint}>A PDF or a photo, up to 10 MB.</Text>
        <View style={styles.chips}>
          {DOC_TYPES.map((t) => (
            <Chip
              key={t.key}
              mode={docType === t.key ? 'flat' : 'outlined'}
              selected={docType === t.key}
              onPress={() => setDocType(t.key)}
              disabled={busy === 'upload'}
            >
              {t.label}
            </Chip>
          ))}
        </View>
        {docType === 'other' && (
          <Field label="What is it? *" value={title} onChangeText={setTitle} placeholder="e.g. Fire safety certificate" />
        )}
        <HelperText type="error" visible={!!error}>{error}</HelperText>
        <Button
          mode="contained"
          icon="upload"
          onPress={handleUpload}
          loading={busy === 'upload'}
          disabled={busy !== null}
        >
          Choose file and upload
        </Button>
      </Surface>

      <FlatList
        style={styles.list}
        data={docs}
        keyExtractor={(d) => d.document_id}
        ItemSeparatorComponent={Divider}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={colors.primary} />}
        ListEmptyComponent={
          loading ? undefined : <EmptyText>No documents yet. Schools look for them before approving you.</EmptyText>
        }
        renderItem={({ item }) => (
          <List.Item
            title={documentTitle(item)}
            description={`${item.file_name} · ${formatDate(item.uploaded_at)}`}
            style={styles.row}
            left={(props) => (
              <List.Icon {...props} icon={item.mime_type === 'application/pdf' ? 'file-pdf-box' : 'file-image-outline'} />
            )}
            right={() => (
              <View style={styles.actions}>
                <IconButton
                  icon="open-in-new"
                  onPress={() => handleOpen(item)}
                  disabled={busy !== null}
                  accessibilityLabel={`Open ${documentTitle(item)}`}
                />
                <IconButton
                  icon={confirming === item.document_id ? 'delete-alert' : 'delete-outline'}
                  iconColor={colors.danger}
                  onPress={() => handleRemove(item)}
                  disabled={busy !== null}
                  accessibilityLabel={
                    confirming === item.document_id ? 'Tap again to remove' : `Remove ${documentTitle(item)}`
                  }
                />
              </View>
            )}
          />
        )}
        ListFooterComponent={
          confirming ? <Text variant="bodySmall" style={styles.hint}>Tap the red bin again to remove it.</Text> : undefined
        }
      />
    </View>
  );
}

const makeStyles = (c: Colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background, padding: 20 },
  card: { borderRadius: 16, padding: 16 },
  cardTitle: { color: c.text },
  hint: { color: c.textMuted, marginTop: 2, marginBottom: 10 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  list: { marginTop: 12 },
  row: { paddingLeft: 0, paddingRight: 0 },
  actions: { flexDirection: 'row', alignItems: 'center' },
});
