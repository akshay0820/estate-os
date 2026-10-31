// The integrations marketplace catalog (lib/integrationCatalog.ts): shape, merge and filter logic shared by demo and
// live mode.
import { describe, expect, it } from 'vitest';
import { CATALOG_CATEGORIES, INTEGRATION_CATALOG, catalogEntry, matchesFilter, mergeCatalog, type ConnRow } from '@/lib/integrationCatalog';

describe('catalog shape', () => {
  it('has unique ids, and every api_key entry has a field label', () => {
    const ids = INTEGRATION_CATALOG.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of INTEGRATION_CATALOG) {
      if (c.authType === 'api_key') expect(c.keyLabel, `${c.id} needs a keyLabel`).toBeTruthy();
      if (c.authType === 'oauth') expect(c.setupNote, `${c.id} needs a setupNote`).toBeTruthy();
      if (c.authType === 'env') expect(c.envVar, `${c.id} needs an envVar`).toBeTruthy();
    }
  });

  it('includes Google Workspace and Microsoft 365 tagged under email, calendar and productivity', () => {
    const g = catalogEntry('Google Workspace')!;
    expect(g.tags).toEqual(expect.arrayContaining(['email', 'calendar', 'productivity']));
    const m = catalogEntry('Microsoft 365')!;
    expect(m.tags).toEqual(expect.arrayContaining(['email', 'calendar', 'productivity']));
  });

  it('lists every category that actually has entries', () => {
    expect(CATALOG_CATEGORIES).toEqual(expect.arrayContaining(['lead_source', 'messaging', 'email', 'calendar', 'productivity', 'marketing', 'payments', 'esignature', 'voice', 'ai', 'automation']));
  });
});

describe('mergeCatalog', () => {
  it('keeps catalog order and attaches a matching row by provider name', () => {
    const rows: ConnRow[] = [{ id: 'r1', provider: 'Twilio SMS', status: 'connected', scopes: ['messages:write'], lastSync: 100, error: null }];
    const merged = mergeCatalog(rows);
    expect(merged.map((m) => m.cat.id)).toEqual(INTEGRATION_CATALOG.map((c) => c.id));
    expect(merged.find((m) => m.cat.id === 'Twilio SMS')?.row).toEqual(rows[0]);
    expect(merged.find((m) => m.cat.id === 'Redfin')?.row).toBeNull();
  });
});

describe('matchesFilter', () => {
  const stripe = catalogEntry('Stripe')!;
  const workspace = catalogEntry('Google Workspace')!;

  it('matches by category, including tags beyond the primary category', () => {
    expect(matchesFilter(stripe, 'payments', '')).toBe(true);
    expect(matchesFilter(stripe, 'email', '')).toBe(false);
    expect(matchesFilter(workspace, 'calendar', '')).toBe(true);
    expect(matchesFilter(workspace, 'productivity', '')).toBe(true);
    expect(matchesFilter(stripe, 'all', '')).toBe(true);
  });

  it('matches by name, blurb or capability text, case-insensitively', () => {
    expect(matchesFilter(workspace, 'all', 'gmail')).toBe(true); // "Gmail" appears in the blurb
    expect(matchesFilter(workspace, 'all', 'drive')).toBe(true); // "Drive files" is a capability
    expect(matchesFilter(stripe, 'all', 'STRIPE')).toBe(true);
    expect(matchesFilter(stripe, 'all', 'payment links')).toBe(true);
    expect(matchesFilter(stripe, 'all', 'nonsense')).toBe(false);
  });
});
