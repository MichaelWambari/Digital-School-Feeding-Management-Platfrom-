// Reads a school's student list (CSV saved from Excel, or cells pasted
// from a spreadsheet) into rows for import_students()
// (supabase/fixes/025_student_import.sql). Values are tidied here
// (dates, sex, status); the database checks them again.

export type ImportRow = {
  row: number; // line in the file, for error messages
  admission_no?: string;
  full_name?: string;
  date_of_birth?: string;
  age?: string;
  sex?: string;
  nfc_tag_id?: string;
  status?: string;
};

export type Field = Exclude<keyof ImportRow, 'row'> | 'first_name' | 'middle_name' | 'last_name';

export type ParsedFile = {
  rows: ImportRow[];
  columns: { header: string; field: Field | null }[];
  problem: string | null; // set when the file can't be imported at all
};

export const FIELD_LABELS: Record<Field, string> = {
  admission_no: 'Admission no.',
  full_name: 'Full name',
  first_name: 'First name',
  middle_name: 'Middle name',
  last_name: 'Surname',
  date_of_birth: 'Date of birth',
  age: 'Age',
  sex: 'Sex',
  nfc_tag_id: 'Card ID',
  status: 'Status',
};

// Header names schools use, compared without case, spaces or punctuation.
const ALIASES: Record<Field, string[]> = {
  admission_no: ['admissionno', 'admissionnumber', 'admno', 'adm', 'admnumber', 'admission', 'regno',
    'registrationno', 'registrationnumber', 'studentno', 'studentnumber', 'learnerno', 'pupilno'],
  full_name: ['fullname', 'name', 'names', 'studentname', 'learnername', 'pupilname', 'studentsname'],
  first_name: ['firstname', 'givenname', 'first', 'fname'],
  middle_name: ['middlename', 'othername', 'othernames', 'middle'],
  last_name: ['lastname', 'surname', 'familyname', 'last', 'lname'],
  date_of_birth: ['dateofbirth', 'dob', 'birthdate', 'birthday', 'born', 'dateofbirthddmmyyyy', 'dobddmmyyyy'],
  age: ['age', 'ageyears'],
  sex: ['sex', 'gender'],
  nfc_tag_id: ['nfctagid', 'nfctag', 'nfc', 'cardid', 'card', 'carduid', 'uid', 'tagid', 'cardno', 'cardnumber'],
  status: ['status', 'active'],
};

const normalise = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');

export function fieldForHeader(header: string): Field | null {
  const key = normalise(header);
  for (const field of Object.keys(ALIASES) as Field[]) {
    if (ALIASES[field].includes(key)) return field;
  }
  return null;
}

// Splits CSV text into records, each with the line it starts on.
// Handles quoted fields (with commas, quotes and line breaks inside).
export function splitCsv(text: string, delimiter: string): { line: number; cells: string[] }[] {
  const records: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let start = 1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
    } else if (ch === '"' && cell === '') {
      quoted = true;
    } else if (ch === delimiter) {
      cells.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      cells.push(cell);
      records.push({ line: start, cells });
      cells = [];
      cell = '';
      line++;
      start = line;
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || cells.length > 0) {
    cells.push(cell);
    records.push({ line: start, cells });
  }
  return records.filter((r) => r.cells.some((c) => c.trim() !== ''));
}

// Comma, semicolon (Excel in many regions) or tab (pasted cells),
// whichever the header line has most of.
export function detectDelimiter(text: string): string {
  const header = text.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  const counts = [',', ';', '\t'].map((d) => ({ d, n: header.split(d).length - 1 }));
  counts.sort((a, b) => b.n - a.n);
  return counts[0].n > 0 ? counts[0].d : ',';
}

// To YYYY-MM-DD. Day comes before month (as in Kenya): 21/03/2014.
// Anything else is passed on as typed, so the database can say which
// row is wrong.
export function normaliseDate(value: string): string {
  const v = value.trim();
  let m = v.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = v.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  // Excel sometimes adds a time: "21/03/2014 00:00".
  m = v.match(/^(.+?)\s+\d{1,2}:\d{2}(:\d{2})?$/);
  if (m) return normaliseDate(m[1]);
  return v;
}

export function normaliseSex(value: string): string {
  const v = value.trim().toLowerCase();
  if (['f', 'female', 'girl', 'g'].includes(v)) return 'female';
  if (['m', 'male', 'boy', 'b'].includes(v)) return 'male';
  return value.trim();
}

export function normaliseStatus(value: string): string {
  const v = value.trim().toLowerCase();
  if (['active', 'yes', 'y', '1', 'true', 'current', 'enrolled'].includes(v)) return 'active';
  if (['inactive', 'no', 'n', '0', 'false', 'left', 'transferred', 'graduated'].includes(v)) return 'inactive';
  return value.trim();
}

export function parseStudentCsv(rawText: string): ParsedFile {
  const text = rawText.replace(/^﻿/, '');
  const records = splitCsv(text, detectDelimiter(text));
  if (records.length === 0) return { rows: [], columns: [], problem: 'The file is empty.' };

  const [header, ...body] = records;
  const columns = header.cells.map((h) => ({ header: h.trim(), field: fieldForHeader(h) }));
  const has = (f: Field) => columns.some((c) => c.field === f);

  if (!has('admission_no')) {
    return {
      rows: [],
      columns,
      problem: 'No admission number column found. Name the column "Admission no" (or "Adm No").',
    };
  }
  if (!has('full_name') && !has('first_name') && !has('last_name')) {
    return {
      rows: [],
      columns,
      problem: 'No name column found. Use "Name", or "First name" and "Surname".',
    };
  }
  if (body.length === 0) return { rows: [], columns, problem: 'The file has a header but no students.' };

  const rows = body.map(({ line, cells }) => {
    const get = (f: Field) => {
      const i = columns.findIndex((c) => c.field === f);
      return i >= 0 ? (cells[i] ?? '').trim() : '';
    };
    const row: ImportRow = { row: line };
    const adm = get('admission_no');
    if (adm) row.admission_no = adm;
    const name = get('full_name') || [get('first_name'), get('middle_name'), get('last_name')].filter(Boolean).join(' ');
    if (name) row.full_name = name.replace(/\s+/g, ' ');
    const dob = get('date_of_birth');
    if (dob) row.date_of_birth = normaliseDate(dob);
    const age = get('age');
    if (age) row.age = age;
    const sex = get('sex');
    if (sex) row.sex = normaliseSex(sex);
    const card = get('nfc_tag_id');
    if (card) row.nfc_tag_id = card.replace(/[\s:]/g, '').toUpperCase();
    const status = get('status');
    if (status) row.status = normaliseStatus(status);
    return row;
  });

  return { rows, columns, problem: null };
}

export const EXAMPLE_CSV = `Admission no,Name,Date of birth,Sex,Card ID
JAS-011,Jane Wanjiku,21/03/2014,F,
JAS-012,Peter Otieno,2013-07-02,M,04A1B2C3`;
