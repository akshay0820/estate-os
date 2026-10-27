import { describe, expect, it } from 'vitest';
import { buildUserContent, validateExtraction } from '../../supabase/functions/_shared/extraction';
import { parsePayload } from '../../supabase/functions/_shared/intake';

const message = 'Hi, I am looking for a 2 BHK apartment in Pune around 75 to 85 lakh. I would like to buy in the next three months.';
const good = {
  intent: 'buy', preferred_locations: ['Pune'], property_type: 'apartment', bedrooms: 2, budget_min: 7500000, budget_max: 8500000,
  currency: 'INR', timeline: '0-3 months', amenities: [], missing_information: [], contradictions: [],
  evidence: [
    { field: 'intent', source_text: 'I would like to buy' },
    { field: 'preferred_locations', source_text: 'in Pune' },
    { field: 'property_type', source_text: 'apartment' },
    { field: 'bedrooms', source_text: '2 BHK' },
    { field: 'budget_min', source_text: '75 to 85 lakh' },
    { field: 'budget_max', source_text: '75 to 85 lakh' },
    { field: 'timeline', source_text: 'in the next three months' },
  ],
};

describe('model output validation', () => {
  it('accepts a well-formed extraction backed by evidence', () => {
    const r = validateExtraction(good, message);
    expect(r).toEqual({
      ok: true, dropped: [],
      value: { intent: 'buy', preferred_locations: ['Pune'], property_type: 'apartment', bedrooms: 2, budget_min: 7500000, budget_max: 8500000, currency: 'INR', timeline: '0-3 months' },
    });
  });

  it('drops fields whose evidence is not in the customer text', () => {
    const r = validateExtraction({ ...good, evidence: good.evidence.filter((e) => e.field !== 'timeline').concat({ field: 'timeline', source_text: 'by Diwali' }) }, message);
    expect(r.ok && r.dropped).toEqual(['timeline']);
    expect(r.ok && 'timeline' in r.value).toBe(false);
  });

  it('rejects wrong shapes, out-of-range values, inverted budgets and extra keys', () => {
    expect(validateExtraction('nope', message).ok).toBe(false);
    expect(validateExtraction({ ...good, bedrooms: 40 }, message).ok).toBe(false);
    expect(validateExtraction({ ...good, budget_min: 9e6, budget_max: 1e6 }, message).ok).toBe(false);
    expect(validateExtraction({ ...good, organization_id: 'x' }, message).ok).toBe(false);
    expect(validateExtraction({ ...good, intent: 'steal' }, message).ok).toBe(false);
  });

  it('sends only the message and organization defaults to the model', () => {
    const c = buildUserContent('call me', { currency: 'INR', country: 'IN' });
    expect(c).toBe('Organization default currency: INR. Country: IN.\n<enquiry>\ncall me\n</enquiry>');
  });
});

describe('webhook payload shape', () => {
  it('accepts the richer intake fields and still refuses unknown ones', () => {
    expect(parsePayload(JSON.stringify({ phone: '+44 20 7946 0958', intent: 'rent', budget_max: '50000', currency: 'gbp', external_lead_id: 'P-1', property_ref: 'SKY-101' })).ok).toBe(true);
    expect(parsePayload(JSON.stringify({ email: 'a@b.co', assigned_to: 'someone' })).ok).toBe(false);
  });
});
