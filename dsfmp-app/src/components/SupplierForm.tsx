import React from 'react';
import { Field } from './ScreenParts';
import type { Supplier } from '../lib/suppliers';

// The supplier's business details, used when the account is set up and
// when the profile is edited.

export type SupplierFormState = {
  business_name: string;
  contact_name: string;
  phone: string;
  email: string;
  kra_pin: string;
  registration_no: string;
  county: string;
  areas_served: string;
  description: string;
};

export function supplierForm(s?: Supplier | null, defaults?: Partial<SupplierFormState>): SupplierFormState {
  return {
    business_name: s?.business_name ?? '',
    contact_name: s?.contact_name ?? '',
    phone: s?.phone ?? '',
    email: s?.email ?? '',
    kra_pin: s?.kra_pin ?? '',
    registration_no: s?.registration_no ?? '',
    county: s?.county ?? '',
    areas_served: s?.areas_served ?? '',
    description: s?.description ?? '',
    ...defaults,
  };
}

// The same checks as the database, so mistakes show before saving.
export function checkSupplierForm(f: SupplierFormState): string | null {
  if (!f.business_name.trim()) return 'Enter the business name.';
  if (!f.contact_name.trim()) return "Enter the contact person's name.";
  if (!/^[0-9]{9,13}$/.test(f.phone.replace(/[^0-9]/g, ''))) return 'Enter a phone number, e.g. 0712 345 678.';
  if (!/^[A-Z][0-9]{9}[A-Z]$/.test(f.kra_pin.replace(/\s/g, '').toUpperCase())) {
    return 'Enter a valid KRA PIN: a letter, 9 digits and a letter (e.g. A012345678Z).';
  }
  return null;
}

// Parameters for create_my_supplier() and update_my_supplier().
export function supplierParams(f: SupplierFormState) {
  const opt = (v: string) => v.trim() || null;
  return {
    p_business_name: f.business_name.trim(),
    p_contact_name: f.contact_name.trim(),
    p_phone: f.phone.trim(),
    p_kra_pin: f.kra_pin.replace(/\s/g, '').toUpperCase(),
    p_email: opt(f.email),
    p_county: opt(f.county),
    p_areas_served: opt(f.areas_served),
    p_registration_no: opt(f.registration_no),
    p_description: opt(f.description),
  };
}

export function SupplierFields({
  form,
  onChange,
  disabled,
}: {
  form: SupplierFormState;
  onChange: (form: SupplierFormState) => void;
  disabled?: boolean;
}) {
  const set = (key: keyof SupplierFormState) => (value: string) => onChange({ ...form, [key]: value });
  return (
    <>
      <Field
        label="Business name *"
        value={form.business_name}
        onChangeText={set('business_name')}
        placeholder="e.g. Mavuno Cereals Ltd"
        disabled={disabled}
      />
      <Field
        label="Contact person *"
        value={form.contact_name}
        onChangeText={set('contact_name')}
        autoComplete="name"
        disabled={disabled}
      />
      <Field
        label="Phone *"
        value={form.phone}
        onChangeText={set('phone')}
        keyboardType="phone-pad"
        autoComplete="tel"
        placeholder="0712 345 678"
        disabled={disabled}
      />
      <Field
        label="Business email"
        value={form.email}
        onChangeText={set('email')}
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
        disabled={disabled}
      />
      <Field
        label="KRA PIN *"
        value={form.kra_pin}
        onChangeText={(v) => set('kra_pin')(v.toUpperCase())}
        autoCapitalize="characters"
        autoCorrect={false}
        placeholder="A012345678Z"
        disabled={disabled}
      />
      <Field
        label="Business registration number"
        value={form.registration_no}
        onChangeText={set('registration_no')}
        autoCapitalize="characters"
        placeholder="e.g. BN-ABC123 or PVT-XYZ789"
        disabled={disabled}
      />
      <Field
        label="County"
        value={form.county}
        onChangeText={set('county')}
        placeholder="e.g. Nakuru"
        disabled={disabled}
      />
      <Field
        label="Areas you deliver to"
        value={form.areas_served}
        onChangeText={set('areas_served')}
        placeholder="e.g. Nakuru town, Naivasha, Gilgil"
        disabled={disabled}
      />
      <Field
        label="About your business"
        value={form.description}
        onChangeText={set('description')}
        multiline
        numberOfLines={3}
        placeholder="What you supply, how often you deliver, minimum order..."
        disabled={disabled}
      />
    </>
  );
}
