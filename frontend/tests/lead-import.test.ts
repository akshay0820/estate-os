// Lead import from spreadsheet exports: CSV parsing and header / value mapping (create_lead does the server checks).
import { describe, expect, it } from 'vitest';
import { parseCsv } from '@/lib/util';
import { ImportStopped, checkImportHeaders, cleanPhone, mapHeaders, mapLeadRow, parseBudget, runImport } from '@/lib/leadImport';

const map = (rows: Record<string, string>[]) => {
  const cols = mapHeaders(Object.keys(rows[0]));
  return rows.map((r) => mapLeadRow(r, cols));
};

describe('parseCsv', () => {
  it('reads a Google Sheets export with title-case headers', () => {
    const rows = parseCsv('Name,Phone Number,Email Address,Budget,Location\r\nRavi Kumar,98765 43210,ravi@example.com,1.2 Cr,Worli\r\n');
    expect(rows).toEqual([{ name: 'Ravi Kumar', 'phone number': '98765 43210', 'email address': 'ravi@example.com', budget: '1.2 Cr', location: 'Worli' }]);
  });

  it('strips the Excel UTF-8 BOM, so the first column is still found', () => {
    const rows = parseCsv('\uFEFFName,Mobile\nAsha,9811100001\n');
    expect(Object.keys(rows[0])).toEqual(['name', 'mobile']);
  });

  it('keeps commas and line breaks inside quoted cells', () => {
    const rows = parseCsv('Name,Phone,Notes\n"Mehta, Priya",9811100002,"Wants sea view\nCall after 6"\n');
    expect(rows).toEqual([{ name: 'Mehta, Priya', phone: '9811100002', notes: 'Wants sea view\nCall after 6' }]);
  });

  it('detects semicolon and tab delimiters', () => {
    expect(parseCsv('Name;Phone\nA;9811100003')[0]).toEqual({ name: 'A', phone: '9811100003' });
    expect(parseCsv('Name\tPhone\nB\t9811100004')[0]).toEqual({ name: 'B', phone: '9811100004' });
  });

  it('drops blank rows and returns nothing for a header-only file', () => {
    expect(parseCsv('Name,Phone\n,\n\n')).toEqual([]);
  });
});

describe('lead row mapping', () => {
  it('maps common header spellings to lead fields', () => {
    const [r] = map(parseCsv('Client Name,Mobile No.,E-mail ID,Lead Source,Lead Type,Max Budget,Preferred Location,BHK,Remarks\n'
      + 'Neha Shah,+91 98111 00005,NEHA@Example.com,99acres,Tenant,80k,Bandra; Khar,2 BHK,Pet friendly'));
    expect(r).toEqual({ input: {
      name: 'Neha Shah', phone: '+91 98111 00005', email: 'neha@example.com', source: '99acres', type: 'tenant',
      budgetMax: 80000, locations: ['Bandra', 'Khar'], bedrooms: 2, notes: 'Pet friendly',
    } });
  });

  it('joins first and last name columns', () => {
    const [r] = map(parseCsv('First Name,Last Name,Phone\nAmit,Rao,9811100006'));
    expect('input' in r && r.input.name).toBe('Amit Rao');
  });

  it('says why a row cannot be imported', () => {
    const out = map(parseCsv('Name,Phone,Email\n,9811100007,\nNo Contact,,\nShort,12345,\nBad Mail,,x@y'));
    expect(out).toEqual([
      { error: 'Name is missing' },
      { error: 'Needs a phone number or an email' },
      { error: 'Phone "12345" has fewer than 10 digits' },
      { error: 'Email "x@y" is not valid' },
    ]);
  });

  it('rejects a file without a name or contact column before sending anything', () => {
    expect(checkImportHeaders(parseCsv('Customer,Number\nA,9811100008'))).toMatch(/No name column/);
    expect(checkImportHeaders(parseCsv('Name,City\nA,Pune'))).toMatch(/No phone or email column/);
    expect(checkImportHeaders(parseCsv('Full Name,WhatsApp\nA,9811100009'))).toBeNull();
  });
});

describe('cell values', () => {
  it('reads Indian budget notation and ranges', () => {
    expect(parseBudget('1.5 Cr')).toBe(15_000_000);
    expect(parseBudget('50 Lakh')).toBe(5_000_000);
    expect(parseBudget('50-60 L')).toBe(6_000_000);
    expect(parseBudget('₹ 75,00,000')).toBe(7_500_000);
    expect(parseBudget('80k')).toBe(80_000);
    expect(parseBudget('$750,000')).toBe(750_000);
    expect(parseBudget('1.2M')).toBe(1_200_000);
    expect(parseBudget('$1.5 million')).toBe(1_500_000);
    expect(parseBudget('')).toBeNull();
    expect(parseBudget('negotiable')).toBeNull();
  });

  it('cleans spreadsheet phone cells', () => {
    expect(cleanPhone("'9811100010")).toBe('9811100010');
    expect(cleanPhone('9.81110001E+09')).toBe('9811100010');
  });
});

describe('runImport (batched upload)', () => {
  const sheet = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `Lead ${i}`, phone: `98111${String(i).padStart(5, '0')}` }));

  it('sends valid rows in batches of 100, maps results back to sheet rows, and reports progress', async () => {
    const rows = [...sheet(150), { name: '', phone: '9811199999' }];
    const sizes: number[] = [];
    const progress: [number, number][] = [];
    const r = await runImport(rows, async (batch) => {
      sizes.push(batch.length);
      return batch.map((b) => (b.name === 'Lead 120' ? { status: 'error', code: 'VALIDATION_ERROR', message: 'Enter a valid phone number' } : b.name === 'Lead 5' ? { status: 'duplicate' } : { status: 'created' }));
    }, { onProgress: (d, t) => progress.push([d, t]) });
    expect(sizes).toEqual([100, 50]);
    expect(r).toMatchObject({ created: 148, duplicates: 1, invalid: 2 });
    expect(r.errors).toEqual([{ row: 152, reason: 'Name is missing' }, { row: 122, reason: 'Enter a valid phone number' }]);
    expect(progress).toEqual([[0, 150], [100, 150], [150, 150]]);
  });

  it('stops between batches when cancelled, keeping what was imported', async () => {
    const control = { cancelled: false };
    const r = await runImport(sheet(250), async (batch) => {
      control.cancelled = true;
      return batch.map(() => ({ status: 'created' }));
    }, { control });
    expect(r).toMatchObject({ created: 100, cancelled: true });
  });

  it('stops the whole import on a permission problem', async () => {
    await expect(runImport(sheet(3), async (batch) => batch.map(() => ({ status: 'error', code: 'FORBIDDEN', message: 'You cannot create leads' }))))
      .rejects.toBeInstanceOf(ImportStopped);
  });
});
