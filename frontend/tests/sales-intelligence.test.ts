import { describe, expect, it } from 'vitest';
import { formatAnswer, validateAnalystSpec, validateRecommendations } from '../../supabase/functions/_shared/sales-intelligence';

const snapshot = {
  metrics: {
    leads_created: { rows: [{ value: 42, previous_value: 30 }] },
    qualification_rate: { rows: [{ value: 0.3571, previous_value: 0.5, denominator: 42, low_sample: false }] },
  },
  findings: [{ id: '11111111-1111-1111-1111-111111111111' }],
};
const rec = (o: Record<string, unknown> = {}) => ({
  title: 'Qualification slowed', summary: 'Qualification fell to 35.7% from 50%.', category: 'qualification', priority: 'high',
  observation: '42 leads arrived (30 before); 35.71% were qualified.', interpretation: 'Fewer leads may be reaching a person in time; the data does not show why.',
  recommended_action: 'Review the qualification queue by source.', expected_direction: 'qualification_rate up',
  supporting_metrics: [{ metric: 'qualification_rate', value: 0.3571 }, { metric: 'leads_created', value: 42 }],
  finding_ids: ['11111111-1111-1111-1111-111111111111'], assumptions: [], limitations: ['Correlation, not cause'], ...o,
});

describe('recommendation validation', () => {
  it('keeps recommendations whose numbers and findings come from the snapshot', () => {
    const r = validateRecommendations({ recommendations: [rec()] }, snapshot);
    expect(r).toMatchObject({ ok: true, rejected: [] });
    expect(r.ok && r.recommendations).toHaveLength(1);
  });

  it('rejects invented values, invented numbers in prose, unknown findings and claims of executed actions', () => {
    const r = validateRecommendations({ recommendations: [
      rec({ title: 'Rec A', supporting_metrics: [{ metric: 'qualification_rate', value: 0.4 }] }),
      rec({ title: 'Rec B', observation: 'Conversion fell by 23% this week.' }),
      rec({ title: 'Rec C', finding_ids: ['22222222-2222-2222-2222-222222222222'] }),
      rec({ title: 'Rec D', recommended_action: 'Leads were assigned to Priya; a reminder has been sent.' }),
      rec({ title: 'Rec E', supporting_metrics: [{ metric: 'revenue', value: 42 }] }),
    ] }, snapshot);
    expect(r.ok && r.rejected.map((x) => [x.title, x.reason.split(':')[0]])).toEqual([
      ['Rec A', 'cited_value_not_in_snapshot'], ['Rec B', 'numbers_not_in_snapshot'], ['Rec C', 'unknown_finding'], ['Rec D', 'claims_action_taken'], ['Rec E', 'cited_value_not_in_snapshot']]);
  });

  it('requires the schema, including at least one limitation', () => {
    expect(validateRecommendations({ recommendations: [rec({ limitations: [] })] }, snapshot)).toEqual({ ok: false, reason: 'schema' });
    expect(validateRecommendations({ recommendations: [rec({ extra: 1 })] }, snapshot)).toEqual({ ok: false, reason: 'schema' });
  });
});

const catalogue = { leads_created: { dims: ['source', 'week'] }, pipeline_value: { dims: ['source'] } };
const base = { status: 'query', metric: 'leads_created', group_by: null, preset: 'this_month', from: null, to: null, compare: true,
  filters: { source: null, property_type: null, transaction: null, lead_status: null }, reason: null };

describe('analyst spec validation', () => {
  it('produces a catalogue spec and defaults the period', () => {
    expect(validateAnalystSpec(base, catalogue)).toEqual({ ok: true, spec: { metric: 'leads_created', compare: true, preset: 'this_month' } });
    expect(validateAnalystSpec({ ...base, preset: null, group_by: 'source', filters: { ...base.filters, transaction: 'buy' } }, catalogue))
      .toEqual({ ok: true, spec: { metric: 'leads_created', compare: true, group_by: 'source', preset: 'last_30_days', filters: { transaction: 'buy' } } });
  });

  it('refuses unknown metrics, disallowed dimensions, bad ranges and passes "unsupported" through', () => {
    expect(validateAnalystSpec({ ...base, metric: 'ad_spend' }, catalogue)).toEqual({ ok: false, reason: 'unknown_metric' });
    expect(validateAnalystSpec({ ...base, metric: 'pipeline_value', group_by: 'week' }, catalogue)).toEqual({ ok: false, reason: 'invalid_dimension' });
    expect(validateAnalystSpec({ ...base, preset: null, from: '2026-10-10', to: '2026-10-01' }, catalogue)).toEqual({ ok: false, reason: 'invalid_range' });
    expect(validateAnalystSpec({ ...base, sql: 'select 1' }, catalogue)).toEqual({ ok: false, reason: 'schema' });
    expect(validateAnalystSpec({ ...base, status: 'unsupported', metric: null, reason: 'No advertising spend is recorded' }, catalogue))
      .toEqual({ ok: false, unsupported: true, reason: 'No advertising spend is recorded' });
  });
});

describe('deterministic answers', () => {
  it('states values, comparisons, samples and caveats from the result only', () => {
    expect(formatAnswer({ label: 'New leads', unit: 'count', available: true, group_by: null, period: { from: '2026-10-01T00:00:00Z', to: '2026-10-27T00:00:00Z' },
      rows: [{ key: 'all', value: 42, previous_value: 30, change: 12, change_pct: 40 }], caveats: [{ text: '2 open leads may be duplicates' }] }))
      .toBe('New leads between 2026-10-01 and 2026-10-27: 42 (previous period 30, +40%). Note: 2 open leads may be duplicates.');
    expect(formatAnswer({ label: 'Lead → qualified', unit: 'rate', available: true, group_by: 'source', period: { from: '2026-10-01', to: '2026-10-27' },
      rows: [{ key: 'Website', value: 0.5, low_sample: true }] })).toBe('Lead → qualified between 2026-10-01 and 2026-10-27, by source: Website 50.0% — small sample.');
    expect(formatAnswer({ label: 'Follow-ups delivered', unit: 'count', available: false, reason: 'No messaging provider is connected.', group_by: null, rows: [] }))
      .toBe('Follow-ups delivered is not available: No messaging provider is connected.');
    expect(formatAnswer({ label: 'Closed transaction value', unit: 'money', available: true, group_by: null, period: { from: '2026-10-20', to: '2026-10-27' }, rows: [] }))
      .toBe('There is no closed transaction value data between 2026-10-20 and 2026-10-27.');
  });
});
