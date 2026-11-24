import React, { useEffect, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { Card, Divider, HelperText, Switch, Text, TextInput } from 'react-native-paper';
import { supabase } from '../lib/supabase';
import { Colors, useThemedStyles } from '../theme/ThemeContext';
import { useSchool } from '../school/SchoolContext';
import { FadeInScrollView } from '../components/Motion';
import { Button, Chip } from '../components/Paper';
import { ScreenHeader, StatCard } from '../components/ScreenParts';
import { EXAMPLE_CSV, FIELD_LABELS, ParsedFile, parseStudentCsv } from '../lib/studentCsv';

// Import students from the school's own list (supabase/fixes/025).
// Pick a CSV file or paste cells from a spreadsheet; the database
// checks every row and shows what would change; then Import saves it
// all at once (or nothing, if any row has an error).

type Result = {
  applied: boolean;
  inserted: number;
  updated: number;
  unchanged: number;
  deactivated: number;
  error_count: number;
  errors: { row: number; admission_no: string | null; messages: string[] }[];
};

export default function ImportStudentsScreen({ navigation }: any) {
  const { colors, styles } = useThemedStyles(makeStyles);
  const { school } = useSchool();
  const [source, setSource] = useState<string | null>(null); // file name, or 'Pasted cells'
  const [parsed, setParsed] = useState<ParsedFile | null>(null);
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState('');
  const [deactivateMissing, setDeactivateMissing] = useState(false);
  const [preview, setPreview] = useState<Result | null>(null);
  const [checking, setChecking] = useState(false);
  const [importing, setImporting] = useState(false);
  const [done, setDone] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load(text: string, name: string) {
    const result = parseStudentCsv(text);
    setSource(name);
    setParsed(result);
    setPreview(null);
    setDone(null);
    setError(result.problem);
  }

  async function pickFile() {
    setError(null);
    const picked = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true, multiple: false });
    if (picked.canceled || !picked.assets?.length) return;
    const asset = picked.assets[0];
    if (/\.xlsx?$/i.test(asset.name)) {
      setError('That is an Excel workbook. In Excel choose File > Save As > "CSV UTF-8", then pick the .csv file.');
      return;
    }
    try {
      const text = Platform.OS === 'web' && asset.file ? await asset.file.text() : await (await fetch(asset.uri)).text();
      load(text, asset.name);
    } catch {
      setError('Could not read that file.');
    }
  }

  // Ask the database what the import would do (a dry run).
  useEffect(() => {
    if (!parsed || parsed.problem || parsed.rows.length === 0) return;
    let live = true;
    setChecking(true);
    supabase
      .rpc('import_students', {
        p_school_id: school.school_id,
        p_rows: parsed.rows,
        p_deactivate_missing: deactivateMissing,
        p_dry_run: true,
      })
      .then(({ data, error: rpcError }) => {
        if (!live) return;
        setChecking(false);
        if (rpcError) {
          setError(describeError(rpcError));
          setPreview(null);
        } else {
          setError(null);
          setPreview(data as Result);
        }
      });
    return () => {
      live = false;
    };
  }, [parsed, deactivateMissing, school.school_id]);

  async function runImport() {
    if (!parsed) return;
    setImporting(true);
    const { data, error: rpcError } = await supabase.rpc('import_students', {
      p_school_id: school.school_id,
      p_rows: parsed.rows,
      p_deactivate_missing: deactivateMissing,
      p_dry_run: false,
    });
    setImporting(false);
    if (rpcError) {
      setError(describeError(rpcError));
      return;
    }
    const result = data as Result;
    if (result.applied) setDone(result);
    else setPreview(result); // the data changed since the preview; show the new errors
  }

  function reset() {
    setSource(null);
    setParsed(null);
    setPreview(null);
    setDone(null);
    setError(null);
    setPasted('');
    setPasting(false);
  }

  if (done) {
    return (
      <FadeInScrollView style={styles.container} contentContainerStyle={styles.content}>
        <ScreenHeader title="Import students" onBack={() => navigation.goBack()} backLabel="Done" />
        <Text variant="titleMedium" style={styles.success}>Import finished</Text>
        <Counts result={done} styles={styles} />
        <Text variant="bodyMedium" style={styles.hint}>
          Next, link each new student's card: open the student, tap Edit, then "Link card by tapping".
        </Text>
        <Button mode="contained" onPress={() => navigation.goBack()} style={styles.button}>
          Back to students
        </Button>
        <Button mode="text" onPress={reset}>Import another file</Button>
      </FadeInScrollView>
    );
  }

  const recognised = parsed?.columns.filter((c) => c.field) ?? [];
  const ignored = parsed?.columns.filter((c) => !c.field && c.header) ?? [];
  const nothingToDo = preview && preview.inserted + preview.updated + preview.deactivated === 0;

  return (
    <FadeInScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <ScreenHeader title="Import students" onBack={() => navigation.goBack()} backDisabled={importing} />

      {!parsed && (
        <>
          <Text variant="bodyMedium" style={styles.intro}>
            Bring in the school's student list from a spreadsheet. Students are matched on admission
            number: new numbers are added, and existing students are updated with the columns in the
            file. Nothing is saved until you check the preview and press Import.
          </Text>

          <Card mode="contained" style={styles.card}>
            <Card.Content>
              <Text variant="labelLarge">Columns</Text>
              <Text variant="bodySmall" style={styles.hint}>
                Needed: Admission no, and Name (or First name and Surname).{'\n'}
                Optional: Date of birth (DD/MM/YYYY or YYYY-MM-DD), Age, Sex (M/F), Card ID, Status.
                {'\n'}Other columns, such as Class or UPI, are ignored.
              </Text>
              <Text style={styles.example}>{EXAMPLE_CSV}</Text>
            </Card.Content>
          </Card>

          <Button mode="contained" icon="file-upload-outline" onPress={pickFile} style={styles.button}>
            Choose CSV file
          </Button>
          <Text variant="bodySmall" style={styles.hint}>
            From Excel: File {'>'} Save As {'>'} "CSV UTF-8 (Comma delimited)".
          </Text>

          <Divider style={styles.divider} />
          {pasting ? (
            <>
              <TextInput
                mode="outlined"
                multiline
                value={pasted}
                onChangeText={setPasted}
                placeholder="Paste the cells here, header row first"
                style={styles.paste}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Button
                mode="contained-tonal"
                onPress={() => load(pasted, 'Pasted cells')}
                disabled={!pasted.trim()}
                style={styles.button}
              >
                Check pasted list
              </Button>
            </>
          ) : (
            <Button mode="text" icon="content-paste" onPress={() => setPasting(true)} style={styles.left}>
              Or paste cells copied from a spreadsheet
            </Button>
          )}
        </>
      )}

      {parsed && (
        <>
          <View style={styles.sourceRow}>
            <Text variant="titleSmall" style={styles.sourceName} numberOfLines={1}>
              {source}
            </Text>
            <Button mode="text" onPress={reset} disabled={importing}>Change</Button>
          </View>
          {!parsed.problem && (
            <Text variant="bodySmall" style={styles.hint}>
              {parsed.rows.length} student{parsed.rows.length === 1 ? '' : 's'} in the file.
            </Text>
          )}
          {recognised.length > 0 && (
            <View style={styles.chips}>
              {recognised.map((c) => (
                <Chip key={c.header} compact icon="check" style={styles.chip}>
                  {c.header} → {FIELD_LABELS[c.field!]}
                </Chip>
              ))}
            </View>
          )}
          {ignored.length > 0 && (
            <Text variant="bodySmall" style={styles.hint}>
              Ignored: {ignored.map((c) => c.header).join(', ')}
            </Text>
          )}

          {!parsed.problem && (
            <View style={styles.switchRow}>
              <View style={styles.switchText}>
                <Text variant="bodyMedium">Mark students not in this file as inactive</Text>
                <Text variant="bodySmall" style={styles.hint}>
                  For a full, current list: students who have left stop being served. Nobody is deleted.
                </Text>
              </View>
              <Switch value={deactivateMissing} onValueChange={setDeactivateMissing} disabled={importing} />
            </View>
          )}
        </>
      )}

      <HelperText type="error" visible={!!error}>
        {error}
      </HelperText>

      {checking && <Text variant="bodySmall" style={styles.hint}>Checking every row…</Text>}

      {preview && !checking && (
        <>
          <Counts result={preview} styles={styles} preview />
          {preview.error_count > 0 && (
            <Card mode="outlined" style={[styles.card, { borderColor: colors.danger }]}>
              <Card.Content>
                <Text variant="titleSmall" style={{ color: colors.danger }}>
                  {preview.error_count} problem{preview.error_count === 1 ? '' : 's'} to fix before importing
                </Text>
                <Text variant="bodySmall" style={styles.hint}>
                  Fix these in the spreadsheet, save it again and choose it here. Nothing has been saved.
                </Text>
                {preview.errors.map((e) => (
                  <View key={e.row} style={styles.errorRow}>
                    <Text variant="labelMedium">
                      Line {e.row}
                      {e.admission_no ? ` · ${e.admission_no}` : ''}
                    </Text>
                    {e.messages.map((m) => (
                      <Text key={m} variant="bodySmall" style={styles.errorText}>• {m}</Text>
                    ))}
                  </View>
                ))}
                {preview.errors.length < preview.error_count && (
                  <Text variant="bodySmall" style={styles.hint}>Only the first 200 lines with problems are shown.</Text>
                )}
              </Card.Content>
            </Card>
          )}
          <Button
            mode="contained"
            icon="database-import-outline"
            onPress={runImport}
            loading={importing}
            disabled={importing || preview.error_count > 0 || !!nothingToDo}
            style={styles.button}
            contentStyle={styles.buttonContent}
          >
            {nothingToDo ? 'Nothing to change' : 'Import'}
          </Button>
        </>
      )}
    </FadeInScrollView>
  );
}

function Counts({ result, styles, preview }: { result: Result; styles: any; preview?: boolean }) {
  const items = [
    { value: result.inserted, label: preview ? 'New students' : 'Added' },
    { value: result.updated, label: preview ? 'Will be updated' : 'Updated' },
    { value: result.unchanged, label: 'Already up to date' },
  ];
  if (result.deactivated > 0) {
    items.push({ value: result.deactivated, label: preview ? 'Will be made inactive' : 'Made inactive' });
  }
  return (
    <View style={styles.counts}>
      {items.map((i) => (
        <StatCard key={i.label} value={i.value} label={i.label} style={styles.count}
          tone={i.label.includes('inactive') ? 'warning' : 'default'} />
      ))}
    </View>
  );
}

function describeError(error: { code?: string; message: string }) {
  if (error.code === 'PGRST202') return 'Student import is not set up yet: run supabase/fixes/025 in Supabase.';
  if (error.code === '42501') return 'You do not have permission to manage students.';
  return error.message;
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: c.background },
    content: { padding: 20, paddingBottom: 48 },
    intro: { color: c.textSecondary, marginBottom: 12 },
    card: { marginTop: 8, marginBottom: 8 },
    hint: { color: c.textMuted, marginTop: 6 },
    example: {
      fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
      fontSize: 12,
      color: c.textSecondary,
      marginTop: 10,
    },
    button: { marginTop: 12 },
    buttonContent: { paddingVertical: 6 },
    left: { alignSelf: 'flex-start' },
    divider: { marginVertical: 16 },
    paste: { minHeight: 140, marginTop: 4 },
    sourceRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    sourceName: { flexShrink: 1 },
    chips: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 8 },
    chip: { marginRight: 6, marginBottom: 6 },
    switchRow: { flexDirection: 'row', alignItems: 'center', marginTop: 16 },
    switchText: { flex: 1, marginRight: 12 },
    counts: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 8, marginHorizontal: -4 },
    count: { flexGrow: 1, flexBasis: '45%', margin: 4 },
    errorRow: { marginTop: 10 },
    errorText: { color: c.textSecondary, marginLeft: 4 },
    success: { color: c.successText, marginBottom: 8 },
  });
