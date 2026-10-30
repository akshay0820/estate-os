// Code-review fixes that live in the frontend: a mistyped phone still finds the same mistyped phone as a duplicate, and
// the workspace currency and country reach the money and phone helpers (and remount the open page) when they change.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findDuplicates } from '@/lib/domain';
import { money } from '@/lib/format';
import { normalizePhone, setPhoneCountry } from '@/lib/util';
import { regionKey, regionOf, syncRegion, type RegionState } from '@/store/regionSync';
import type { Contact } from '@/store/types';

const contact = (id: string, phone: string) => ({ id, name: `Contact ${id}`, phone, email: '' }) as unknown as Contact;
const state = (currency?: string, country?: string) =>
  ({ session: { orgId: 'o1' }, orgs: [{ id: 'o1', currency, country }] }) as unknown as RegionState;

afterEach(() => syncRegion(state('USD', 'US')));

describe('duplicate phones', () => {
  it('matches an invalid US number against the same invalid number, by digits', () => {
    setPhoneCountry('US');
    expect(normalizePhone('055 123 4567')).toBe('');
    const found = findDuplicates({ phone: '(055) 123-4567' }, [contact('a', '055 123 4567'), contact('b', '415 555 0134')]);
    expect(found.map((d) => [d.contact.id, d.reasons])).toEqual([['a', ['Same phone']]]);
  });

  it('still matches valid numbers by their normalized form and does not mix the two', () => {
    setPhoneCountry('US');
    expect(findDuplicates({ phone: '+1 415 555 0134' }, [contact('a', '(415) 555-0134')])).toHaveLength(1);
    expect(findDuplicates({ phone: '14155550134' }, [contact('a', '055 123 4567')])).toHaveLength(0);
  });
});

describe('workspace region sync', () => {
  it('reads the active workspace and changes its key when the currency or country changes', () => {
    expect(regionOf(state('CAD', 'CA'))).toEqual({ currency: 'CAD', country: 'CA' });
    expect(regionKey(state('USD', 'US'))).not.toBe(regionKey(state('CAD', 'US')));
    expect(regionKey(state('USD', 'US'))).not.toBe(regionKey(state('USD', 'CA')));
  });

  it('points the money and phone helpers at the workspace', () => {
    syncRegion(state('INR', 'IN'));
    expect(money(1500)).toContain('₹');
    expect(normalizePhone('98765 43210')).toBe('+919876543210');
    syncRegion(state('USD', 'US'));
    expect(money(1500)).toContain('$');
    expect(normalizePhone('415 555 0134')).toBe('+14155550134');
  });

  it('is loaded by the app entry point, and the router keys the page by region', () => {
    const src = (f: string) => readFileSync(join(__dirname, '..', 'src', f), 'utf8');
    expect(src('main.tsx')).toMatch(/import ['"]\.\/store\/region['"]/);
    expect(src('App.tsx')).toMatch(/key=\{`\$\{page\}:\$\{region\}`\}/);
  });
});
