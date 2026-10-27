// Database rows → the shapes the existing components already render.
import { missingFields } from '@/lib/domain';
import type {
  Activity,
  ActorType,
  Appointment,
  AuditLog,
  Channel,
  Commission,
  ConsentState,
  Contact,
  Deal,
  DocumentRec,
  Lead,
  Member,
  Notification,
  Organization,
  Property,
  PropertyType,
  Role,
  Task,
  WebhookEvent,
} from '@/store/types';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

const ts = (v: string | null | undefined) => (v ? new Date(v).getTime() : null);
const tsReq = (v: string) => new Date(v).getTime();
const num = (v: unknown) => (v == null ? null : Number(v));

export function hue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

const LEAD_COLS = `id, organization_id, contact_id, title, status, priority, lead_type, desired_transaction, source, source_campaign, assigned_to,
  lead_score, score_reasons, budget_min, budget_max, desired_property_type, desired_locations, bedrooms, timeline, required_amenities,
  ai_extracted_fields, summary, next_follow_up_at, first_response_at, last_contact_at, lost_reason, archived_at, intake_status, duplicate_status, created_at, updated_at`;
export const CONTACT_COLS = `id, organization_id, display_name, email, phone, roles, preferred_contact_channel, lifecycle_status, source, assigned_to, tags,
  created_at, last_contacted_at, communication_consents(channel, purpose, status)`;
export const LEAD_SELECT = `${LEAD_COLS}, contact:contacts(${CONTACT_COLS})`;

export function toLead(r: Row): Lead {
  const lead: Lead = {
    id: r.id,
    orgId: r.organization_id,
    contactId: r.contact_id,
    name: r.title,
    status: r.status,
    priority: r.priority,
    type: r.lead_type,
    source: r.source,
    campaign: r.source_campaign,
    assignedTo: r.assigned_to,
    score: Math.round(Number(r.lead_score)),
    scoreReasons: r.score_reasons ?? [],
    budgetMin: num(r.budget_min),
    budgetMax: num(r.budget_max),
    locations: r.desired_locations ?? [],
    propertyType: toPropertyType(r.desired_property_type),
    bedrooms: r.bedrooms,
    timeline: r.timeline,
    intent: r.desired_transaction,
    amenities: r.required_amenities ?? [],
    aiFields: r.ai_extracted_fields ?? [],
    missing: [],
    summary: r.summary,
    nextFollowUpAt: ts(r.next_follow_up_at),
    firstResponseAt: ts(r.first_response_at),
    lastContactAt: ts(r.last_contact_at),
    lostReason: r.lost_reason,
    archived: !!r.archived_at,
    intakeStatus: r.intake_status,
    duplicateStatus: r.duplicate_status,
    createdAt: tsReq(r.created_at),
    updatedAt: tsReq(r.updated_at),
  };
  lead.missing = missingFields(lead);
  return lead;
}

export function leadToRow(p: Partial<Lead>): Row {
  const out: Row = {};
  const map: [keyof Lead, string, (v: any) => any][] = [
    ['name', 'title', (v) => v],
    ['status', 'status', (v) => v],
    ['priority', 'priority', (v) => v],
    ['type', 'lead_type', (v) => v],
    ['intent', 'desired_transaction', (v) => v],
    ['assignedTo', 'assigned_to', (v) => v],
    ['budgetMin', 'budget_min', (v) => v],
    ['budgetMax', 'budget_max', (v) => v],
    ['propertyType', 'desired_property_type', (v) => v],
    ['locations', 'desired_locations', (v) => v],
    ['bedrooms', 'bedrooms', (v) => v],
    ['timeline', 'timeline', (v) => v],
    ['amenities', 'required_amenities', (v) => v],
    ['summary', 'summary', (v) => v],
    ['nextFollowUpAt', 'next_follow_up_at', (v) => (v == null ? null : new Date(v).toISOString())],
    ['lastContactAt', 'last_contact_at', (v) => (v == null ? null : new Date(v).toISOString())],
    ['lostReason', 'lost_reason', (v) => v],
  ];
  for (const [k, col, f] of map) if (k in p) out[col] = f(p[k]);
  if ('archived' in p) out.archived_at = p.archived ? new Date().toISOString() : null;
  return out;
}

export function toContact(r: Row): Contact {
  const consents: Record<Channel, ConsentState> = { phone: 'unknown', whatsapp: 'unknown', sms: 'unknown', email: 'unknown' };
  for (const c of r.communication_consents ?? []) if (c.purpose === 'service') consents[c.channel as Channel] = c.status;
  return {
    id: r.id,
    orgId: r.organization_id,
    name: r.display_name,
    email: r.email ?? '',
    phone: r.phone ?? '',
    roles: (r.roles ?? []).filter((x: string) => ['buyer', 'seller', 'tenant', 'landlord', 'investor'].includes(x)),
    preferredChannel: r.preferred_contact_channel === 'none' ? 'email' : r.preferred_contact_channel,
    lifecycle: r.lifecycle_status,
    source: r.source ?? '',
    assignedTo: r.assigned_to,
    consents,
    tags: r.tags ?? [],
    createdAt: tsReq(r.created_at),
    lastContactedAt: ts(r.last_contacted_at),
  };
}

function toPropertyType(v: string | null): PropertyType | null {
  if (!v) return null;
  if (['apartment', 'villa', 'penthouse', 'plot', 'office', 'retail'].includes(v)) return v as PropertyType;
  if (v === 'house' || v === 'townhouse') return 'villa';
  if (v === 'commercial') return 'office';
  return 'apartment';
}

export const PROPERTY_COLS = `id, organization_id, reference_code, title, description, property_type, listing_type, status, price, bedrooms, bathrooms,
  area_value, furnishing, locality, city, amenities, owner_contact_id, listing_agent_id, verified_at, created_at, updated_at`;

export function toProperty(r: Row): Property {
  return {
    id: r.id,
    orgId: r.organization_id,
    ref: r.reference_code,
    title: r.title,
    description: r.description ?? '',
    listing: r.listing_type,
    type: toPropertyType(r.property_type) ?? 'apartment',
    status: r.status === 'withdrawn' ? 'archived' : r.status,
    price: Number(r.price),
    bedrooms: r.bedrooms,
    bathrooms: Number(r.bathrooms),
    area: Number(r.area_value),
    locality: r.locality,
    city: r.city ?? '',
    amenities: r.amenities ?? [],
    furnishing: r.furnishing,
    verified: !!r.verified_at,
    verifiedAt: ts(r.verified_at),
    agentId: r.listing_agent_id,
    ownerContactId: r.owner_contact_id,
    // No photo pipeline yet: -1 renders a neutral placeholder instead of a stock image.
    image: -1,
    createdAt: tsReq(r.created_at),
    updatedAt: tsReq(r.updated_at),
  };
}

export function propertyToRow(p: Partial<Property>): Row {
  const out: Row = {};
  if ('title' in p) out.title = p.title;
  if ('description' in p) out.description = p.description || null;
  if ('listing' in p) out.listing_type = p.listing;
  if ('type' in p) out.property_type = p.type;
  if ('status' in p) out.status = p.status;
  if ('price' in p) out.price = p.price;
  if ('bedrooms' in p) out.bedrooms = p.bedrooms;
  if ('bathrooms' in p) out.bathrooms = p.bathrooms;
  if ('area' in p) out.area_value = p.area;
  if ('locality' in p) out.locality = p.locality;
  if ('furnishing' in p) out.furnishing = p.furnishing;
  if ('amenities' in p) out.amenities = p.amenities;
  if ('agentId' in p) out.listing_agent_id = p.agentId;
  if ('ownerContactId' in p) out.owner_contact_id = p.ownerContactId;
  return out;
}

export function toDeal(r: Row): Deal {
  return {
    id: r.id,
    orgId: r.organization_id,
    title: r.title,
    leadId: r.lead_id,
    contactId: r.primary_contact_id,
    propertyId: r.property_id,
    stage: r.stage,
    value: Number(r.expected_value),
    commissionPct: Number(r.commission_pct),
    expectedClose: r.expected_close_date ? new Date(r.expected_close_date + 'T12:00:00').getTime() : tsReq(r.created_at),
    ownerId: r.owner_user_id,
    lostReason: r.lost_reason,
    createdAt: tsReq(r.created_at),
    stageChangedAt: tsReq(r.stage_changed_at),
  };
}

export function toAppointment(r: Row): Appointment {
  return {
    id: r.id,
    orgId: r.organization_id,
    title: r.title,
    type: r.appointment_type,
    status: r.status,
    leadId: r.lead_id,
    contactId: r.contact_id,
    propertyId: r.property_id,
    assignedTo: r.assigned_to,
    start: tsReq(r.starts_at),
    end: tsReq(r.ends_at),
    location: r.location_text ?? '',
    source: r.source === 'ai' ? 'ai' : r.source === 'user' ? 'user' : 'workflow',
    cancelReason: r.cancellation_reason,
    feedback: r.feedback,
    createdAt: tsReq(r.created_at),
  };
}

export function toTask(r: Row): Task {
  return {
    id: r.id,
    orgId: r.organization_id,
    title: r.title,
    status: r.status,
    priority: r.priority,
    dueAt: tsReq(r.due_at),
    assignedTo: r.assigned_to,
    related: r.related_lead_id
      ? { type: 'lead', id: r.related_lead_id }
      : r.related_deal_id
        ? { type: 'deal', id: r.related_deal_id }
        : r.related_property_id
          ? { type: 'property', id: r.related_property_id }
          : null,
    source: r.source === 'ai' ? 'ai' : r.source === 'manual' ? 'manual' : 'workflow',
    createdAt: tsReq(r.created_at),
    completedAt: ts(r.completed_at),
  };
}

const ACTOR: Record<string, ActorType> = { user: 'user', ai: 'ai_agent', system: 'system', integration: 'integration', workflow: 'workflow' };

export function toActivity(r: Row): Activity {
  return {
    id: r.id,
    orgId: r.organization_id,
    leadId: r.lead_id,
    contactId: r.contact_id,
    dealId: r.deal_id,
    kind: r.activity_type,
    title: r.title,
    body: r.description,
    actor: { type: ACTOR[r.source] ?? 'system', name: r.actor_name },
    at: tsReq(r.occurred_at),
  };
}

export function toNotification(r: Row): Notification {
  return {
    id: r.id,
    orgId: r.organization_id,
    kind: r.notification_type,
    title: r.title,
    body: r.body ?? '',
    at: tsReq(r.created_at),
    read: !!r.read_at,
    link: r.link,
  };
}

export function toMember(r: Row): Member {
  const p = r.profile ?? {};
  return {
    id: r.user_id,
    orgId: r.organization_id,
    name: p.full_name || p.email || 'Member',
    email: p.email ?? '',
    phone: p.phone_e164 ?? '',
    role: r.role as Role,
    title: r.title ?? '',
    status: r.status === 'active' ? 'active' : 'suspended',
    hue: hue(r.user_id),
    localities: r.localities ?? [],
    joinedAt: tsReq(r.joined_at),
  };
}

/** Pending invitations render as "invited" rows; the id prefix tells actions to revoke instead of suspend. */
export function invitationToMember(r: Row): Member {
  return {
    id: `inv:${r.id}`,
    orgId: r.organization_id,
    name: r.email_normalized.split('@')[0],
    email: r.email_normalized,
    phone: '',
    role: r.role,
    title: 'Invitation pending',
    status: 'invited',
    hue: hue(r.id),
    localities: [],
    joinedAt: tsReq(r.created_at),
  };
}

export function toOrganization(r: Row): Organization {
  const s = r.settings ?? {};
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    city: r.city ?? '',
    timezone: r.timezone,
    currency: 'INR',
    businessHours: { start: s.business_hours?.start ?? 9, end: s.business_hours?.end ?? 20, days: s.business_hours?.days ?? [1, 2, 3, 4, 5, 6] },
    callingHours: { start: s.calling_hours?.start ?? 9, end: s.calling_hours?.end ?? 21 },
    outboundPaused: !!s.outbound_paused,
    leadStages: ['new', 'attempting', 'contacted', 'qualified', 'matching', 'visit_scheduled', 'visit_completed', 'negotiation', 'won', 'lost', 'nurture'],
    assignment: s.assignment ?? 'least_loaded',
    slaMinutes: s.sla_minutes ?? 5,
    webhookSecretVersion: r.webhook_secret_version ?? 0,
  };
}

export function orgSettingsToJson(o: Organization): Row {
  return {
    business_hours: { start: o.businessHours.start, end: o.businessHours.end, days: o.businessHours.days },
    calling_hours: { start: o.callingHours.start, end: o.callingHours.end },
    sla_minutes: o.slaMinutes,
    assignment: o.assignment,
    outbound_paused: o.outboundPaused,
  };
}

export function toAudit(r: Row): AuditLog {
  const d = r.details ?? {};
  const parts: string[] = [];
  for (const k of ['status', 'stage', 'role', 'classification', 'lifecycle_status']) if (d[k]) parts.push(`${k}: ${d[k].from ?? '—'} → ${d[k].to}`);
  if (d.changed?.length) parts.push(`changed: ${d.changed.join(', ')}`);
  if (d.merged) parts.push('merged duplicate');
  return {
    id: r.id,
    orgId: r.organization_id,
    actor: { type: r.actor_type, name: r.actor_name },
    action: r.action,
    entity: r.entity_type ?? '—',
    entityId: r.entity_id,
    at: tsReq(r.created_at),
    meta: parts.join(' · ') || null,
  };
}

export function toCommission(r: Row): Commission {
  return {
    id: r.id,
    orgId: r.organization_id,
    dealId: r.deal_id,
    beneficiaryId: r.beneficiary_user_id,
    gross: Number(r.gross_commission),
    status: r.status,
    createdAt: tsReq(r.created_at),
    paidAt: ts(r.paid_at),
  };
}

export function toDocument(r: Row, uploaderName: (id: string | null) => string): DocumentRec {
  return {
    id: r.id,
    orgId: r.organization_id,
    name: r.name,
    kind: r.document_type,
    size: Number(r.file_size_bytes),
    classification: r.classification,
    related: r.related_property_id
      ? { type: 'property', id: r.related_property_id }
      : r.related_deal_id
        ? { type: 'deal', id: r.related_deal_id }
        : r.related_contact_id
          ? { type: 'contact', id: r.related_contact_id }
          : null,
    uploadedBy: uploaderName(r.uploaded_by),
    uploadedAt: tsReq(r.created_at),
    status: r.status === 'failed' ? 'failed' : r.status === 'uploaded' ? 'processing' : 'ready',
    expiresAt: ts(r.expires_at),
  };
}

export function toWebhookEvent(r: Row): WebhookEvent {
  return {
    id: r.id,
    orgId: r.organization_id,
    provider: r.provider,
    type: r.event_type,
    status: r.processing_status === 'received' ? 'retrying' : r.processing_status,
    receivedAt: tsReq(r.received_at),
    attempts: r.attempt_count,
    error: r.last_error,
    idempotencyKey: r.provider_event_id,
    signature: r.signature_verified ? 'valid' : 'invalid',
  };
}
