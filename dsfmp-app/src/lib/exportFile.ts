// Saving reports as CSV or PDF files.
//
// Web: the CSV downloads, and the PDF opens the browser's print dialog
// (choose "Save as PDF"). Phones: the file is written to the app's cache
// and the share sheet opens, to save it or send it on.
import { Platform } from 'react-native';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { File, Paths } from 'expo-file-system';

export type Cell = string | number | null | undefined;

// RFC 4180 CSV. A byte-order mark makes Excel read it as UTF-8.
export function toCsv(rows: Cell[][]): string {
  const cell = (v: Cell) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

export function escapeHtml(v: Cell): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// A file name without characters phones or Windows refuse.
export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '_').slice(0, 80);
}

async function share(uri: string, mimeType: string, UTI: string) {
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('Sharing is not available on this device.');
  }
  await Sharing.shareAsync(uri, { mimeType, UTI, dialogTitle: 'Save or send the report' });
}

export async function saveCsv(fileName: string, csv: string): Promise<void> {
  if (Platform.OS === 'web') {
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return;
  }
  const file = new File(Paths.cache, fileName);
  if (file.exists) file.delete();
  file.create();
  file.write(csv);
  await share(file.uri, 'text/csv', 'public.comma-separated-values-text');
}

export async function savePdf(fileName: string, html: string): Promise<void> {
  if (Platform.OS === 'web') {
    // expo-print on the web prints the whole app, so print the report
    // from a hidden frame instead.
    const frame = document.createElement('iframe');
    frame.style.position = 'fixed';
    frame.style.width = '0';
    frame.style.height = '0';
    frame.style.border = '0';
    document.body.appendChild(frame);
    const doc = frame.contentWindow!.document;
    doc.open();
    doc.write(html.replace('<title>', `<title>${escapeHtml(fileName.replace(/\.pdf$/, ''))}`));
    doc.close();
    await new Promise((resolve) => setTimeout(resolve, 250));
    frame.contentWindow!.focus();
    frame.contentWindow!.print();
    setTimeout(() => frame.remove(), 60000);
    return;
  }
  const { uri } = await Print.printToFileAsync({ html });
  // Give the file a readable name before sharing it.
  const named = new File(Paths.cache, fileName);
  if (named.exists) named.delete();
  new File(uri).move(named);
  await share(named.uri, 'application/pdf', 'com.adobe.pdf');
}

// A plain, printable page around the report's body.
export function reportHtml(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title></title>
<style>
  @page { margin: 16mm; }
  body { font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; color: #111; font-size: 11pt; }
  h1 { font-size: 18pt; margin: 0 0 2pt; }
  h2 { font-size: 13pt; margin: 18pt 0 6pt; border-bottom: 1px solid #ccc; padding-bottom: 3pt; }
  .meta { color: #555; margin: 0 0 4pt; }
  table { border-collapse: collapse; width: 100%; margin-top: 4pt; }
  th, td { border: 1px solid #ccc; padding: 4pt 6pt; text-align: left; }
  th { background: #f2f2f2; }
  td.num, th.num { text-align: right; }
  .note { color: #555; font-size: 9pt; margin-top: 4pt; }
  .low { color: #b42318; font-weight: 600; }
</style></head><body>${body}</body></html>`;
}

export function htmlTable(head: Cell[], rows: Cell[][], numeric: number[] = []): string {
  const cls = (i: number) => (numeric.includes(i) ? ' class="num"' : '');
  return `<table><thead><tr>${head.map((h, i) => `<th${cls(i)}>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((v, i) => `<td${cls(i)}>${escapeHtml(v)}</td>`).join('')}</tr>`)
    .join('')}</tbody></table>`;
}
