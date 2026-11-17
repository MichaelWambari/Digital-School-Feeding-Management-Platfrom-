import { Linking, Platform } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { supabase } from './supabase';
import type { PillTone } from '../components/ScreenParts';

// Shared by the supplier's screens and the school's Suppliers screens.

export type Supplier = {
  supplier_id: string;
  user_id: string;
  business_name: string;
  contact_name: string;
  phone: string;
  email: string | null;
  county: string | null;
  areas_served: string | null;
  kra_pin: string;
  registration_no: string | null;
  description: string | null;
  created_at: string;
};

// Where a supplier stands with a school (school_suppliers.status);
// null when neither side has done anything yet.
export type LinkStatus = 'requested' | 'approved' | 'declined' | 'removed' | null;

export const LINK_LABELS: Record<Exclude<LinkStatus, null>, string> = {
  requested: 'Requested',
  approved: 'Approved',
  declined: 'Declined',
  removed: 'Removed',
};

export const LINK_TONES: Record<Exclude<LinkStatus, null>, PillTone> = {
  requested: 'warning',
  approved: 'success',
  declined: 'danger',
  removed: 'muted',
};

export type DocType = 'business_permit' | 'kra_pin' | 'registration' | 'kebs' | 'health' | 'other';

export const DOC_TYPES: { key: DocType; label: string }[] = [
  { key: 'business_permit', label: 'Business permit' },
  { key: 'kra_pin', label: 'KRA PIN certificate' },
  { key: 'registration', label: 'Business registration' },
  { key: 'kebs', label: 'KEBS certificate' },
  { key: 'health', label: 'Health / food handling certificate' },
  { key: 'other', label: 'Other' },
];

export function docTypeLabel(type: DocType) {
  return DOC_TYPES.find((d) => d.key === type)?.label ?? type;
}

export type SupplierDocument = {
  document_id: string;
  supplier_id: string;
  doc_type: DocType;
  title: string | null;
  file_path: string;
  file_name: string;
  mime_type: string | null;
  size_bytes: number | null;
  uploaded_at: string;
};

export function documentTitle(d: Pick<SupplierDocument, 'doc_type' | 'title'>) {
  return d.doc_type === 'other' && d.title ? d.title : docTypeLabel(d.doc_type);
}

const BUCKET = 'supplier-documents';
const MAX_BYTES = 10 * 1024 * 1024;

// Opens a stored document in the browser (or the phone's viewer) using a
// link that works for five minutes.
export async function openDocument(path: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 300);
  if (error || !data) return describeStorageError(error?.message ?? 'Could not open the document.');
  if (Platform.OS === 'web') {
    window.open(data.signedUrl, '_blank', 'noopener');
  } else {
    await Linking.openURL(data.signedUrl);
  }
  return null;
}

// Lets the supplier pick a PDF or photo, uploads it to their folder and
// records it. Returns an error message, 'cancelled', or null when done.
export async function pickAndUploadDocument(
  supplierId: string,
  docType: DocType,
  title: string
): Promise<string | 'cancelled' | null> {
  const picked = await DocumentPicker.getDocumentAsync({
    type: ['application/pdf', 'image/*'],
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (picked.canceled || !picked.assets?.length) return 'cancelled';
  const asset = picked.assets[0];
  if (asset.size && asset.size > MAX_BYTES) return 'That file is bigger than 10 MB. Pick a smaller one.';

  const mimeType = asset.mimeType ?? guessMime(asset.name);
  if (!mimeType || !(mimeType === 'application/pdf' || mimeType.startsWith('image/'))) {
    return 'Pick a PDF or a photo.';
  }

  try {
    // On the web the picker gives a File; on a phone, a local file to read.
    const body =
      Platform.OS === 'web' && asset.file ? asset.file : await (await fetch(asset.uri)).arrayBuffer();
    const extension = (asset.name.split('.').pop() ?? 'pdf').toLowerCase().replace(/[^a-z0-9]/g, '');
    const path = `${supplierId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension || 'pdf'}`;

    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(path, body, { contentType: mimeType, upsert: false });
    if (uploadError) return describeStorageError(uploadError.message);

    const { error } = await supabase.rpc('add_supplier_document', {
      p_doc_type: docType,
      p_file_path: path,
      p_file_name: asset.name,
      p_title: title.trim() || null,
      p_mime_type: mimeType,
      p_size_bytes: asset.size ?? null,
    });
    if (error) {
      // Don't leave an unrecorded file behind.
      await supabase.storage.from(BUCKET).remove([path]);
      return describeSupplierError(error);
    }
    return null;
  } catch {
    return 'Unable to upload. Check your connection and try again.';
  }
}

export async function removeDocument(documentId: string): Promise<string | null> {
  const { data: path, error } = await supabase.rpc('remove_supplier_document', { p_document_id: documentId });
  if (error) return describeSupplierError(error);
  if (path) await supabase.storage.from(BUCKET).remove([path as string]);
  return null;
}

function guessMime(name: string) {
  const ext = name.split('.').pop()?.toLowerCase();
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'heic') return 'image/heic';
  return null;
}

function describeStorageError(message: string) {
  const m = message.toLowerCase();
  if (m.includes('bucket not found')) {
    return 'Document storage is not set up yet. Run supabase/fixes/014_suppliers.sql.';
  }
  if (m.includes('row-level security') || m.includes('unauthorized')) {
    return "You don't have permission to do that with this document.";
  }
  if (m.includes('mime type') || m.includes('not supported')) return 'Pick a PDF or a photo.';
  if (m.includes('exceeded') || m.includes('too large')) return 'That file is bigger than 10 MB.';
  return message;
}

export function describeSupplierError(error: { code?: string; message: string }) {
  if (error.code === 'PGRST202' || error.code === '42P01' || error.code === 'PGRST205') {
    return 'The database needs updating. Run supabase/fixes/014_suppliers.sql.';
  }
  return error.message;
}

export function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
