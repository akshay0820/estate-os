import type {
  Appointment,
  AppointmentStatus,
  CallStatus,
  Channel,
  Contact,
  DealStage,
  Lead,
  LeadStatus,
  Organization,
  Property,
  RunStatus,
} from '@/store/types';
import { DAY, money } from './format';
import { normalizeEmail, normalizePhone } from './util';

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'accent' | 'solid';

/* ─────────────── Status vocabularies ─────────────── */

export const LEAD_STATUS: Record<LeadStatus, { label: string; tone: Tone }> = {
  new: { label: 'New', tone: 'accent' },
  attempting: { label: 'Attempting contact', tone: 'warning' },
  contacted: { label: 'Contacted', tone: 'info' },
  qualified: { label: 'Qualified', tone: 'success' },
  matching: { label: 'Property matching', tone: 'info' },
  visit_scheduled: { label: 'Visit scheduled', tone: 'accent' },
  visit_completed: { label: 'Visit completed', tone: 'info' },
  negotiation: { label: 'Negotiation', tone: 'warning' },
  won: { label: 'Won', tone: 'solid' },
  lost: { label: 'Lost', tone: 'neutral' },
  nurture: { label: 'Nurture', tone: 'neutral' },
};

export const LEAD_FLOW: LeadStatus[] = [
  'new',
  'attempting',
  'contacted',
  'qualified',
  'matching',
  'visit_scheduled',
  'visit_completed',
  'negotiation',
  'won',
  'lost',
  'nurture',
];

export const OPEN_LEAD: LeadStatus[] = LEAD_FLOW.filter((s) => !['won', 'lost', 'nurture'].includes(s));

export const DEAL_STAGES: { key: DealStage; label: string; probability: number }[] = [
  { key: 'qualification', label: 'Qualification', probability: 0.1 },
  { key: 'viewing', label: 'Viewing', probability: 0.25 },
  { key: 'offer', label: 'Offer', probability: 0.45 },
  { key: 'negotiation', label: 'Negotiation', probability: 0.6 },
  { key: 'under_contract', label: 'Under contract', probability: 0.85 },
  { key: 'won', label: 'Won', probability: 1 },
  { key: 'lost', label: 'Lost', probability: 0 },
];

export const APPT_STATUS: Record<AppointmentStatus, { label: string; tone: Tone }> = {
  requested: { label: 'Requested', tone: 'info' },
  pending: { label: 'Pending confirmation', tone: 'warning' },
  confirmed: { label: 'Confirmed', tone: 'accent' },
  completed: { label: 'Completed', tone: 'success' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  no_show: { label: 'No show', tone: 'danger' },
  reschedule_requested: { label: 'Reschedule requested', tone: 'warning' },
};

export const CALL_STATUS: Record<CallStatus, { label: string; tone: Tone }> = {
  queued: { label: 'Queued', tone: 'neutral' },
  initiating: { label: 'Initiating', tone: 'info' },
  ringing: { label: 'Ringing', tone: 'info' },
  in_progress: { label: 'In progress', tone: 'accent' },
  completed: { label: 'Completed', tone: 'success' },
  no_answer: { label: 'No answer', tone: 'warning' },
  busy: { label: 'Busy', tone: 'warning' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  needs_review: { label: 'Needs review', tone: 'warning' },
  blocked: { label: 'Blocked by policy', tone: 'danger' },
};

export const RUN_STATUS: Record<RunStatus, { label: string; tone: Tone }> = {
  queued: { label: 'Queued', tone: 'neutral' },
  running: { label: 'Running', tone: 'accent' },
  waiting_approval: { label: 'Awaiting approval', tone: 'warning' },
  succeeded: { label: 'Succeeded', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  retrying: { label: 'Retrying', tone: 'warning' },
  dead_letter: { label: 'Dead letter', tone: 'danger' },
  skipped: { label: 'Skipped', tone: 'neutral' },
};

export const PRIORITY_TONE: Record<string, Tone> = {
  low: 'neutral',
  normal: 'neutral',
  high: 'warning',
  urgent: 'danger',
};

export const CHANNEL_LABEL: Record<Channel, string> = {
  phone: 'Phone',
  whatsapp: 'WhatsApp',
  sms: 'SMS',
  email: 'Email',
};

export const LOST_REASONS = [
  'Budget mismatch',
  'Bought elsewhere',
  'Not responsive',
  'Location preference changed',
  'Financing fell through',
  'Timeline postponed',
  'Other',
];

/* ─────────────── Duplicate detection (PRD §8.3) ─────────────── */

export function findDuplicates(
  input: { phone?: string; email?: string; name?: string },
  contacts: Contact[],
): { contact: Contact; reasons: string[] }[] {
  const phone = input.phone ? normalizePhone(input.phone) : '';
  const email = input.email ? normalizeEmail(input.email) : '';
  const name = input.name?.trim().toLowerCase() ?? '';
  const out: { contact: Contact; reasons: string[] }[] = [];
  for (const c of contacts) {
    const reasons: string[] = [];
    if (phone && normalizePhone(c.phone) === phone) reasons.push('Same phone');
    if (email && normalizeEmail(c.email) === email) reasons.push('Same email');
    if (!reasons.length && name && c.name.toLowerCase() === name) reasons.push('Same name');
    if (reasons.length) out.push({ contact: c, reasons });
  }
  return out;
}

/* ─────────────── Lead scoring — explainable, deterministic ─────────────── */

export function scoreLead(lead: Pick<Lead, 'budgetMax' | 'locations' | 'timeline' | 'propertyType' | 'bedrooms' | 'source' | 'status'>) {
  let score = 20;
  const reasons: string[] = [];
  if (lead.budgetMax) {
    score += 20;
    reasons.push('Budget confirmed');
  }
  if (lead.locations.length) {
    score += 12;
    reasons.push('Preferred locations given');
  }
  if (lead.propertyType && lead.bedrooms != null) {
    score += 12;
    reasons.push('Configuration specified');
  }
  if (lead.timeline && /immediate|1 month|0-3/i.test(lead.timeline)) {
    score += 20;
    reasons.push('Near-term timeline');
  } else if (lead.timeline) {
    score += 8;
    reasons.push('Timeline stated');
  }
  if (lead.source === 'Referral') {
    score += 10;
    reasons.push('Referral source');
  }
  if (['qualified', 'matching', 'visit_scheduled', 'visit_completed', 'negotiation'].includes(lead.status)) {
    score += 6;
    reasons.push('Progressed past qualification');
  }
  return { score: Math.min(99, score), reasons };
}

export function missingFields(lead: Lead): string[] {
  const out: string[] = [];
  if (!lead.budgetMax) out.push('Budget');
  if (!lead.locations.length) out.push('Locations');
  if (!lead.propertyType) out.push('Property type');
  if (lead.bedrooms == null && lead.propertyType && !['plot', 'office', 'retail'].includes(lead.propertyType)) out.push('Bedrooms');
  if (!lead.timeline) out.push('Timeline');
  return out;
}

/* ─────────────── Property matching (PRD §8.5, ARCH §15) ─────────────── */

export const STALE_AFTER = 30 * DAY;

export interface Match {
  property: Property;
  score: number;
  reasons: string[];
  gaps: string[];
  stale: boolean;
}

export function matchProperties(lead: Lead, properties: Property[], now = Date.now()): Match[] {
  const wantsRent = lead.intent === 'rent';
  const out: Match[] = [];
  for (const p of properties) {
    // Hard constraints first — never overridden by ranking.
    if (p.status !== 'active') continue;
    if (wantsRent ? p.listing !== 'rent' : p.listing !== 'sale') continue;
    if (lead.budgetMax && p.price > lead.budgetMax * 1.05) continue;
    if (lead.budgetMin && p.price < lead.budgetMin * 0.7) continue;

    const reasons: string[] = [];
    const gaps: string[] = [];
    let score = 40;
    if (lead.budgetMax) {
      reasons.push(`Within budget (${money(p.price)} of ${money(lead.budgetMax)})`);
      score += 15;
    }
    if (lead.locations.length) {
      if (lead.locations.includes(p.locality)) {
        reasons.push(`In ${p.locality}`);
        score += 20;
      } else gaps.push(`Outside preferred areas`);
    }
    if (lead.propertyType) {
      if (lead.propertyType === p.type) {
        reasons.push(`Matches type: ${p.type}`);
        score += 10;
      } else gaps.push(`Type is ${p.type}`);
    }
    if (lead.bedrooms != null) {
      if (p.bedrooms === lead.bedrooms) {
        reasons.push(`${p.bedrooms} BHK as requested`);
        score += 10;
      } else if (Math.abs(p.bedrooms - lead.bedrooms) === 1) {
        gaps.push(`${p.bedrooms} BHK vs ${lead.bedrooms} requested`);
        score += 3;
      } else gaps.push(`${p.bedrooms} BHK`);
    }
    const amen = lead.amenities.filter((a) => p.amenities.includes(a));
    if (amen.length) {
      reasons.push(`Has ${amen.slice(0, 2).join(', ')}`);
      score += Math.min(8, amen.length * 3);
    }
    const stale = !p.verified || !p.verifiedAt || now - p.verifiedAt > STALE_AFTER;
    if (stale) gaps.push('Availability not recently verified');
    out.push({ property: p, score: Math.min(99, score), reasons, gaps, stale });
  }
  return out.sort((a, b) => b.score - a.score);
}

/* ─────────────── Outbound policy gate (SECURITY §9.1) ─────────────── */

export interface PolicyResult {
  allowed: boolean;
  checks: { label: string; ok: boolean; detail?: string }[];
  reason?: string;
}

export function outboundPolicy(
  org: Organization,
  contact: Contact | undefined,
  channel: Channel,
  opts: { purpose?: 'ai_call' | 'service' | 'reminder'; at?: number; humanOwned?: boolean; byAi?: boolean } = {},
): PolicyResult {
  const at = opts.at ?? Date.now();
  const hour = new Date(at).getHours() + new Date(at).getMinutes() / 60;
  const checks: PolicyResult['checks'] = [];

  checks.push({
    label: 'Organization outbound switch',
    ok: !org.outboundPaused,
    detail: org.outboundPaused ? 'All outbound paused by kill switch' : 'Enabled',
  });
  checks.push({ label: 'Recipient resolved from trusted record', ok: !!contact });
  const consent = contact?.consents[channel] ?? 'unknown';
  checks.push({
    label: `${CHANNEL_LABEL[channel]} consent`,
    ok: consent === 'granted',
    detail: consent === 'granted' ? 'Granted' : consent === 'unknown' ? 'Unknown — not treated as permission' : `Consent ${consent}`,
  });
  checks.push({
    label: 'Suppression list',
    ok: contact?.lifecycle !== 'do_not_contact',
    detail: contact?.lifecycle === 'do_not_contact' ? 'Contact is on the do-not-contact list' : 'Not suppressed',
  });
  if (channel === 'phone' || opts.purpose === 'ai_call') {
    const inHours = hour >= org.callingHours.start && hour < org.callingHours.end;
    checks.push({
      label: 'Calling hours',
      ok: inHours,
      detail: `${fmtHour(org.callingHours.start)}–${fmtHour(org.callingHours.end)} ${org.timezone}`,
    });
  }
  if (opts.byAi) {
    checks.push({
      label: 'Conversation ownership',
      ok: !opts.humanOwned,
      detail: opts.humanOwned ? 'A person has taken over — AI paused' : 'AI may respond',
    });
  }
  const failed = checks.find((c) => !c.ok);
  return { allowed: !failed, checks, reason: failed ? `${failed.label}: ${failed.detail ?? 'failed'}` : undefined };
}

export function fmtHour(h: number): string {
  const hh = Math.floor(h);
  const suffix = hh >= 12 ? 'pm' : 'am';
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}${suffix}`;
}

/* ─────────────── Appointment conflicts (ARCH §16) ─────────────── */

export function findConflict(
  appts: Appointment[],
  candidate: { assignedTo: string | null; start: number; end: number; id?: string },
): Appointment | undefined {
  if (!candidate.assignedTo) return undefined;
  return appts.find(
    (a) =>
      a.id !== candidate.id &&
      a.assignedTo === candidate.assignedTo &&
      ['requested', 'pending', 'confirmed'].includes(a.status) &&
      a.start < candidate.end &&
      candidate.start < a.end,
  );
}

export function nextFreeSlots(
  appts: Appointment[],
  assignedTo: string,
  from: number,
  durationMin: number,
  org: Organization,
  count = 3,
): number[] {
  const out: number[] = [];
  let t = Math.ceil(from / (30 * 60_000)) * 30 * 60_000;
  for (let i = 0; i < 400 && out.length < count; i++, t += 30 * 60_000) {
    const d = new Date(t);
    const h = d.getHours() + d.getMinutes() / 60;
    if (!org.businessHours.days.includes(d.getDay())) continue;
    if (h < org.businessHours.start || h + durationMin / 60 > org.businessHours.end) continue;
    if (!findConflict(appts, { assignedTo, start: t, end: t + durationMin * 60_000 })) out.push(t);
  }
  return out;
}

/* ─────────────── Opt-out detection (PRD §9.3) ─────────────── */

export function isOptOut(text: string): boolean {
  return /^\s*(stop|unsubscribe|opt[\s-]?out|don'?t (call|message|contact) me|remove me)\b/i.test(text);
}

/* ─────────────── Simulated AI extraction ─────────────── */
// Stands in for the qualification agent. Output follows a fixed schema and
// leaves anything it can't find as unknown instead of guessing.

const LOCALITY_WORDS = [
  'Bandra West', 'Powai', 'Andheri West', 'Worli', 'Lower Parel', 'Juhu', 'Thane West',
  'Chembur', 'Goregaon East', 'Malad West', 'Vashi', 'Kharghar', 'Kandivali', 'Santacruz',
];

export function extractRequirements(text: string) {
  const fields: Record<string, string> = {};
  const lower = text.toLowerCase();
  const budget = lower.match(/(\d+(?:\.\d+)?)\s*(crore|cr|lakh|lac|l|million|m|k)\b/);
  if (budget) {
    const n = parseFloat(budget[1]);
    const unit = budget[2];
    const mult = /^c/.test(unit) ? 1e7 : /^l/.test(unit) ? 1e5 : /^m/.test(unit) ? 1e6 : 1e3;
    fields.budget = String(Math.round(n * mult));
  }
  const bhk = lower.match(/(\d)\s*bhk/);
  if (bhk) fields.bedrooms = bhk[1];
  const loc = LOCALITY_WORDS.find((l) => lower.includes(l.toLowerCase().split(' ')[0]));
  if (loc) fields.location = loc;
  if (/rent|lease/.test(lower)) fields.intent = 'rent';
  else if (/buy|purchase|invest/.test(lower)) fields.intent = 'buy';
  if (/villa/.test(lower)) fields.propertyType = 'villa';
  else if (/apartment|flat|bhk/.test(lower)) fields.propertyType = 'apartment';
  if (/immediate|asap|this month|urgent/.test(lower)) fields.timeline = 'Immediate';
  else if (/(\d)\s*months?/.test(lower)) fields.timeline = `${lower.match(/(\d)\s*months?/)![1]} months`;
  return fields;
}
