// Pure logic for the lead-intake webhook: signature verification and payload validation.
// No Deno- or Node-specific APIs, so it runs in the Edge Function and in unit tests.
import { z } from 'zod';
import { safeEqual } from './crypto.ts';

export const MAX_BODY_BYTES = 64 * 1024;
export const TOLERANCE_SECONDS = 300;

const enc = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}


export function signatureFor(secret: string, timestamp: string, rawBody: string) {
  return hmacHex(secret, `${timestamp}.${rawBody}`).then((h) => `sha256=${h}`);
}

export type VerifyResult = { ok: true } | { ok: false; reason: 'missing_headers' | 'stale_timestamp' | 'bad_signature' };

/**
 * Signature = "sha256=" + hex(HMAC_SHA256(secret, `${timestamp}.${rawBody}`)).
 * The timestamp (unix seconds) must be within ±5 minutes to limit replay.
 */
export async function verifySignature(secret: string, header: string | null, timestamp: string | null, rawBody: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<VerifyResult> {
  if (!header || !timestamp || !/^\d{9,11}$/.test(timestamp)) return { ok: false, reason: 'missing_headers' };
  if (Math.abs(nowSeconds - Number(timestamp)) > TOLERANCE_SECONDS) return { ok: false, reason: 'stale_timestamp' };
  const expected = await signatureFor(secret, timestamp, rawBody);
  return safeEqual(expected, header.trim()) ? { ok: true } : { ok: false, reason: 'bad_signature' };
}

const str = (max: number) => z.string().trim().min(1).max(max);
const num = z.union([z.number(), z.string().regex(/^\s*\d{1,15}(\.\d{1,4})?\s*$/)]);

// Shape only. Normalization (E.164, case, ranges, enums, budget order) is done by the database
// (private.intake_normalize), which is the single authority for every intake path.
export const LeadPayload = z
  .object({
    name: str(160).optional(),
    first_name: str(80).optional(),
    last_name: str(80).optional(),
    phone: z.string().trim().max(32).optional(),
    phone_country: z.string().trim().regex(/^[A-Za-z]{2}$/).optional(),
    email: z.string().trim().email().max(254).optional(),
    preferred_contact_method: z.enum(['phone', 'email', 'sms', 'whatsapp']).optional(),
    preferred_language: z.string().trim().regex(/^[A-Za-z]{2,3}(-[A-Za-z]{2})?$/).optional(),
    source: str(80).optional(),
    campaign: z.string().trim().max(120).optional(),
    external_lead_id: z.string().trim().regex(/^[A-Za-z0-9._:/-]{1,200}$/).optional(),
    message: z.string().max(4000).optional(),
    intent: z.enum(['buy', 'rent', 'sell', 'let', 'invest', 'other']).optional(),
    lead_type: z.enum(['buyer', 'seller', 'tenant', 'landlord', 'investor']).optional(),
    locations: z.array(str(120)).max(10).optional(),
    budget_min: num.optional(),
    budget_max: num.optional(),
    currency: z.string().trim().regex(/^[A-Za-z]{3}$/).optional(),
    property_type: str(40).optional(),
    bedrooms: z.number().int().min(0).max(20).optional(),
    amenities: z.array(str(60)).max(20).optional(),
    timeline: str(40).optional(),
    property_ref: z.string().trim().regex(/^[A-Za-z0-9._/-]{1,40}$/).optional(),
    consent_channels: z.array(z.enum(['phone', 'whatsapp', 'sms', 'email'])).max(4).optional(),
  })
  .strict()
  .refine((p) => !!p.phone || !!p.email, { message: 'phone or email is required' })
  .refine((p) => !p.phone || p.phone.replace(/\D/g, '').length >= 8, { message: 'phone must have at least 8 digits', path: ['phone'] });

export type LeadPayload = z.infer<typeof LeadPayload>;

export function parsePayload(rawBody: string): { ok: true; value: LeadPayload } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return { ok: false, error: 'Body must be valid JSON' };
  }
  const r = LeadPayload.safeParse(json);
  if (!r.success) return { ok: false, error: r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') };
  return { ok: true, value: r.data };
}

export const EVENT_ID = /^[A-Za-z0-9._:-]{1,200}$/;
export const ORG_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
