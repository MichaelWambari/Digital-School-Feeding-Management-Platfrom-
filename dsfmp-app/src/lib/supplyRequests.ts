import type { PillTone } from '../components/ScreenParts';

// Requests a school sends a supplier for food that's running low (fix 015).

export type RequestStatus = 'pending' | 'accepted' | 'declined' | 'delivered' | 'cancelled';

export const REQUEST_LABELS: Record<RequestStatus, string> = {
  pending: 'Waiting for supplier',
  accepted: 'Accepted',
  declined: 'Declined',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

export const REQUEST_TONES: Record<RequestStatus, PillTone> = {
  pending: 'warning',
  accepted: 'info',
  declined: 'danger',
  delivered: 'success',
  cancelled: 'muted',
};

export function isOpen(status: RequestStatus) {
  return status === 'pending' || status === 'accepted';
}

type RequestBase = {
  request_id: string;
  item_name: string;
  unit: string;
  pack_size: number | null;
  quantity: number;
  status: RequestStatus;
  note: string | null;
  response_note: string | null;
  requested_by_name: string | null;
  created_at: string;
  responded_at: string | null;
  quantity_received: number | null;
  received_at: string | null;
};

// A row of school_supply_requests().
export type SchoolRequest = RequestBase & {
  supplier_id: string;
  business_name: string;
  phone: string;
  food_id: string;
};

// A row of supplier_supply_requests().
export type SupplierRequest = RequestBase & {
  school_id: string;
  school_name: string;
  county: string | null;
  location: string | null;
};

export function describeRequestError(error: { code?: string; message: string }) {
  if (error.code === 'PGRST202' || error.code === '42P01' || error.code === 'PGRST205') {
    return 'The database needs updating. Run supabase/fixes/015_supply_requests.sql.';
  }
  return error.message;
}
