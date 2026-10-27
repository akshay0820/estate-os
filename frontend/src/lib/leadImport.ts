// Lead import from a spreadsheet export (Google Sheets, Excel, other CRMs). Maps the usual header spellings to lead
// fields and checks each row the way create_lead will, so a rejected row says why instead of counting as "invalid".

import type { Lead } from '@/store/types';

export interface ImportLeadInput {
  name: string;
  phone: string;
  email: string;
  source: string;
  type: Lead['type'];
  budgetMax: number | null;
  locations: string[];
  bedrooms: number | null;
  notes?: string;
}

export interface ImportRowError {
  row: number; // spreadsheet row number (header = 1)
  reason: string;
}

export interface ImportResult {
  created: number;
  duplicates: number;
  invalid: number;
  errors: ImportRowError[];
}

export const IMPORT_MAX_ROWS = 1000;

// Header → field. Headers are compared after lower-casing and dropping everything but letters and digits,
// so "Phone Number", "phone_number" and "PHONE-NUMBER" are all "phonenumber".
const ALIASES: Record<string, keyof typeof FIELDS> = {};
const FIELDS = {
  name: ['name', 'fullname', 'leadname', 'clientname', 'customername', 'contactname', 'buyername', 'enquirername'],
  firstName: ['firstname', 'givenname', 'fname'],
  lastName: ['lastname', 'surname', 'familyname', 'lname'],
  phone: ['phone', 'phonenumber', 'phoneno', 'mobile', 'mobilenumber', 'mobileno', 'contactnumber', 'contactno', 'whatsapp', 'whatsappnumber', 'cell', 'cellnumber', 'telephone', 'tel'],
  email: ['email', 'emailaddress', 'emailid', 'mail', 'mailid'],
  source: ['source', 'leadsource', 'channel', 'campaign', 'portal'],
  type: ['type', 'leadtype', 'clienttype', 'customertype', 'category'],
  budget: ['budget', 'budgetmax', 'maxbudget', 'budgetinr', 'price', 'pricerange', 'maxprice'],
  location: ['location', 'locations', 'locality', 'area', 'city', 'preferredlocation', 'preferredlocations', 'preferredarea', 'region', 'sector'],
  bedrooms: ['bedrooms', 'bhk', 'beds', 'configuration'],
  notes: ['notes', 'note', 'remarks', 'remark', 'comments', 'comment', 'requirement', 'requirements', 'message'],
} as const;
for (const [field, names] of Object.entries(FIELDS)) for (const n of names) ALIASES[n] = field as keyof typeof FIELDS;

const key = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Which lead field each column feeds; unknown columns are ignored. */
export function mapHeaders(headers: string[]): Partial<Record<keyof typeof FIELDS, string>> {
  const out: Partial<Record<keyof typeof FIELDS, string>> = {};
  for (const h of headers) {
    const f = ALIASES[key(h)];
    if (f && !out[f]) out[f] = h;
  }
  return out;
}

const TYPES: Record<string, Lead['type']> = {
  buyer: 'buyer', buy: 'buyer', purchase: 'buyer',
  seller: 'seller', sell: 'seller', owner: 'seller',
  tenant: 'tenant', rent: 'tenant', renter: 'tenant', lease: 'tenant',
  landlord: 'landlord', let: 'landlord',
  investor: 'investor', invest: 'investor', investment: 'investor',
};

/** "50 L", "1.5 Cr", "₹ 75,00,000", "2 crore", "80k", "50-60 L" (the top of a range) → rupees; null when blank or unreadable. */
export function parseBudget(raw: string): number | null {
  const s = raw.toLowerCase().replace(/,/g, '').trim();
  const nums = (s.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  if (!nums.length) return null;
  const unit = s.match(/(?<=\d|\s)(crores?|cr|lakhs?|lacs?|lac|l|k|thousand|mn|million)\b/)?.[1] ?? '';
  const mult = /^(crores?|cr)$/.test(unit) ? 1e7
    : /^(lakhs?|lacs?|lac|l)$/.test(unit) ? 1e5
    : /^(k|thousand)$/.test(unit) ? 1e3
    : /^(mn|million)$/.test(unit) ? 1e6
    : 1;
  const v = Math.round(Math.max(...nums) * mult);
  return v > 0 ? v : null;
}

/** Spreadsheet phone cells: a leading apostrophe, "9.81E+09" from a number-formatted column, spaces and dashes. */
export function cleanPhone(raw: string): string {
  let s = raw.trim().replace(/^'+/, '');
  if (/^\d(\.\d+)?e\+\d+$/i.test(s)) s = Number(s).toFixed(0);
  return s;
}

/** One spreadsheet row → a lead to create, or the reason it cannot be one. */
export function mapLeadRow(raw: Record<string, string>, cols: ReturnType<typeof mapHeaders>): { input: ImportLeadInput } | { error: string } {
  const get = (f: keyof typeof FIELDS) => (cols[f] ? (raw[cols[f]!] ?? '').trim() : '');
  const name = get('name') || [get('firstName'), get('lastName')].filter(Boolean).join(' ');
  const phone = cleanPhone(get('phone'));
  const email = get('email').toLowerCase();
  if (!name) return { error: 'Name is missing' };
  if (name.length > 160) return { error: 'Name is longer than 160 characters' };
  if (!phone && !email) return { error: 'Needs a phone number or an email' };
  if (phone && phone.replace(/\D/g, '').length < 10) return { error: `Phone "${phone}" has fewer than 10 digits` };
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: `Email "${email}" is not valid` };
  const bhk = get('bedrooms').match(/\d+/);
  const bedrooms = bhk ? Number(bhk[0]) : null;
  return {
    input: {
      name, phone, email,
      source: get('source') || 'Import',
      type: TYPES[key(get('type'))] ?? 'buyer',
      budgetMax: parseBudget(get('budget')),
      locations: get('location').split(/[;|/]/).map((x) => x.trim()).filter(Boolean),
      bedrooms: bedrooms !== null && bedrooms > 0 && bedrooms < 50 ? bedrooms : null,
      notes: get('notes') || undefined,
    },
  };
}

/** Checks the header row before anything is sent: a file without a name or contact column is rejected whole. */
export function checkImportHeaders(rows: Record<string, string>[]): string | null {
  const cols = mapHeaders(Object.keys(rows[0] ?? {}));
  if (!cols.name && !cols.firstName) return 'No name column found. Add a column called "Name".';
  if (!cols.phone && !cols.email) return 'No phone or email column found. Add a column called "Phone" or "Email".';
  return null;
}
