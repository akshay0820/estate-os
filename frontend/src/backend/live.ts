// Live data access. Every call runs as the signed-in user; Postgres RLS decides what is visible.
// Lists that can grow without bound (leads, contacts, audit) are paged on the server; working sets
// the UI needs for lookups are loaded with explicit caps and refreshed after mutations.
import { create } from 'zustand';
import { useStore } from '@/store/store';
import type { OrgData } from '@/store/seed';
import type { Channel, ConsentState, Deal, DealStage, Lead, LeadStatus, Organization, Property, Role, Task } from '@/store/types';
import { can } from '@/lib/permissions';
import { ImportStopped, runImport, type ImportOptions, type ImportResult, type ImportRowOutcome } from '@/lib/leadImport';
import { supabase, functionsUrl } from './client';
import { ApiError, check, checkMaybe, toApiError, type ErrorCode } from './errors';
import {
  CONTACT_COLS,
  LEAD_SELECT,
  PROPERTY_COLS,
  invitationToMember,
  leadToRow,
  orgSettingsToJson,
  propertyToRow,
  toActivity,
  toAppointment,
  toAudit,
  toCommission,
  toContact,
  toDeal,
  toDocument,
  toLead,
  toMember,
  toNotification,
  toOrganization,
  toProperty,
  toTask,
  toWebhookEvent,
} from './mappers';

export const LIMITS = {
  leadsCache: 2000,
  properties: 2000,
  deals: 1000,
  appointments: 2000,
  tasks: 2000,
  activities: 300,
  audit: 500,
  documents: 500,
  notifications: 50,
  pageMax: 100,
} as const;

/** Bumped after every mutation so server-paged lists refetch. */
export const useLiveRev = create<{ rev: number; bump: () => void }>((set) => ({ rev: 0, bump: () => set((s) => ({ rev: s.rev + 1 })) }));

const sb = () => supabase();
const iso = (t: number) => new Date(t).toISOString();
const daysAgo = (d: number) => new Date(Date.now() - d * 864e5).toISOString();

function ctx() {
  const s = useStore.getState();
  const orgId = s.session.orgId;
  const userId = s.session.userId;
  if (!orgId || !userId) throw new ApiError('UNAUTHENTICATED', 'Choose a workspace first.');
  const role = (s.members.find((m) => m.id === userId && m.orgId === orgId)?.role ?? 'viewer') as Role;
  return { orgId, userId, role };
}

function setCollection<K extends keyof OrgData>(key: K, rows: OrgData[K]) {
  useStore.setState({ [key]: rows } as Partial<OrgData>);
}

function upsertRows<K extends keyof OrgData>(key: K, rows: OrgData[K]) {
  const incoming = rows as unknown as { id: string }[];
  const ids = new Set(incoming.map((r) => r.id));
  useStore.setState((s) => ({ [key]: [...incoming, ...(s[key] as unknown as { id: string }[]).filter((x) => !ids.has(x.id))] }) as unknown as Partial<OrgData>);
}

/* ─────────────────────────── loaders ─────────────────────────── */

export async function loadOrganizations(orgIds: string[]) {
  if (!orgIds.length) return [];
  const rows = check(await sb().from('organizations').select('*').in('id', orgIds));
  const orgs = rows.map(toOrganization);
  useStore.setState({ orgs });
  return orgs;
}

export async function loadMembers(orgId: string) {
  const rows = check(
    await sb()
      .from('organization_memberships')
      .select('user_id, organization_id, role, status, title, localities, joined_at, profile:profiles!organization_memberships_user_id_fkey(full_name, email, phone_e164)')
      .eq('organization_id', orgId)
      .in('status', ['active', 'suspended'])
      .order('joined_at'),
  );
  const members = rows.map(toMember);
  const me = useStore.getState().session.userId;
  const myRole = members.find((m) => m.id === me)?.role;
  if (myRole && can(myRole, 'team.manage')) {
    const inv = check(
      await sb().from('invitations').select('id, organization_id, email_normalized, role, created_at, expires_at')
        .eq('organization_id', orgId).is('accepted_at', null).is('revoked_at', null).gt('expires_at', new Date().toISOString()),
    );
    members.push(...inv.map(invitationToMember));
  }
  setCollection('members', members);
}

export async function loadLeadsCache(orgId: string) {
  const rows = check(
    await sb().from('leads').select(LEAD_SELECT).eq('organization_id', orgId).is('archived_at', null)
      .or(`status.not.in.(won,lost,nurture),created_at.gte.${daysAgo(120)}`)
      .order('created_at', { ascending: false }).limit(LIMITS.leadsCache),
  );
  setCollection('leads', rows.map(toLead));
  const contacts = rows.map((r) => r.contact).filter(Boolean).map(toContact);
  upsertRows('contacts', contacts);
}

export async function loadProperties(orgId: string) {
  const rows = check(await sb().from('properties').select(PROPERTY_COLS).eq('organization_id', orgId).order('created_at', { ascending: false }).limit(LIMITS.properties));
  setCollection('properties', rows.map(toProperty));
}

export async function loadDeals(orgId: string) {
  const rows = check(
    await sb().from('deals').select('*').eq('organization_id', orgId)
      .or(`stage.not.in.(won,lost),stage_changed_at.gte.${daysAgo(180)}`)
      .order('stage_changed_at', { ascending: false }).limit(LIMITS.deals),
  );
  setCollection('deals', rows.map(toDeal));
}

let apptWindow: [number, number] = [0, 0];
export async function loadAppointments(orgId: string, from = Date.now() - 60 * 864e5, to = Date.now() + 60 * 864e5) {
  const rows = check(
    await sb().from('appointments').select('*').eq('organization_id', orgId).gte('starts_at', iso(from)).lt('starts_at', iso(to))
      .order('starts_at').limit(LIMITS.appointments),
  );
  apptWindow = [from, to];
  setCollection('appointments', rows.map(toAppointment));
}

/** Calendar navigation outside the loaded window fetches that range. */
export async function ensureAppointmentRange(from: number, to: number) {
  if (from >= apptWindow[0] && to <= apptWindow[1]) return;
  await loadAppointments(ctx().orgId, Math.min(from, apptWindow[0] || from), Math.max(to, apptWindow[1]));
}

export async function loadTasks(orgId: string) {
  const rows = check(
    await sb().from('tasks').select('*').eq('organization_id', orgId)
      .or(`status.in.(open,in_progress),completed_at.gte.${daysAgo(30)}`)
      .order('due_at').limit(LIMITS.tasks),
  );
  setCollection('tasks', rows.map(toTask));
}

export async function loadActivities(orgId: string) {
  const rows = check(await sb().from('activities').select('*').eq('organization_id', orgId).order('occurred_at', { ascending: false }).limit(LIMITS.activities));
  upsertRows('activities', rows.map(toActivity));
}

export async function loadNotifications(orgId: string) {
  const rows = check(
    await sb().from('notifications').select('*').eq('organization_id', orgId).eq('user_id', ctx().userId)
      .order('created_at', { ascending: false }).limit(LIMITS.notifications),
  );
  setCollection('notifications', rows.map(toNotification));
}

export async function loadAudit(orgId: string) {
  const rows = check(await sb().from('audit_logs').select('*').eq('organization_id', orgId).order('created_at', { ascending: false }).limit(LIMITS.audit));
  setCollection('audit', rows.map(toAudit));
}

export async function loadCommissions(orgId: string) {
  const rows = check(await sb().from('commissions').select('*').eq('organization_id', orgId).order('created_at', { ascending: false }).limit(1000));
  setCollection('commissions', rows.map(toCommission));
}

export async function loadDocuments(orgId: string) {
  const rows = check(await sb().from('documents').select('*').eq('organization_id', orgId).neq('status', 'archived').order('created_at', { ascending: false }).limit(LIMITS.documents));
  const members = useStore.getState().members;
  setCollection('documents', rows.map((r) => toDocument(r, (id) => members.find((m) => m.id === id)?.name ?? 'Former member')));
}

export async function loadWebhookEvents(orgId: string) {
  const rows = check(await sb().from('webhook_events').select('*').eq('organization_id', orgId).order('received_at', { ascending: false }).limit(100));
  setCollection('webhookEvents', rows.map(toWebhookEvent));
}

type Loader = 'members' | 'leads' | 'properties' | 'deals' | 'appointments' | 'tasks' | 'activities' | 'notifications' | 'audit' | 'commissions' | 'documents' | 'webhookEvents';

/** Reload working sets the signed-in role may read. Unknown/forbidden sets stay empty. */
export async function refresh(...keys: Loader[]) {
  const { orgId, role } = ctx();
  const all: Record<Loader, () => Promise<unknown>> = {
    members: () => loadMembers(orgId),
    leads: () => loadLeadsCache(orgId),
    properties: () => loadProperties(orgId),
    deals: () => loadDeals(orgId),
    appointments: () => (apptWindow[1] ? loadAppointments(orgId, apptWindow[0], apptWindow[1]) : loadAppointments(orgId)),
    tasks: () => loadTasks(orgId),
    activities: () => loadActivities(orgId),
    notifications: () => loadNotifications(orgId),
    audit: () => (can(role, 'audit.view') ? loadAudit(orgId) : Promise.resolve()),
    commissions: () => loadCommissions(orgId),
    documents: () => (can(role, 'documents.edit') ? loadDocuments(orgId) : Promise.resolve()),
    webhookEvents: () => (can(role, 'integrations.manage') ? loadWebhookEvents(orgId) : Promise.resolve()),
  };
  const list = keys.length ? keys : (Object.keys(all) as Loader[]);
  await Promise.all(list.map((k) => all[k]()));
  useLiveRev.getState().bump();
}

/** Lead drawer: fetch a lead (and its timeline) that may be outside the cached working set. */
export async function ensureLead(id: string) {
  const row = checkMaybe(await sb().from('leads').select(LEAD_SELECT).eq('id', id).maybeSingle());
  if (!row) return null;
  upsertRows('leads', [toLead(row)]);
  if (row.contact) upsertRows('contacts', [toContact(row.contact)]);
  const acts = check(await sb().from('activities').select('*').eq('lead_id', id).order('occurred_at', { ascending: false }).limit(200));
  upsertRows('activities', acts.map(toActivity));
  return toLead(row);
}

export async function ensureContact(id: string) {
  const row = checkMaybe(await sb().from('contacts').select(CONTACT_COLS).eq('id', id).maybeSingle());
  if (!row) return null;
  upsertRows('contacts', [toContact(row)]);
  const leads = check(await sb().from('leads').select(LEAD_SELECT).eq('contact_id', id).limit(50));
  upsertRows('leads', leads.map(toLead));
  const acts = check(await sb().from('activities').select('*').eq('contact_id', id).order('occurred_at', { ascending: false }).limit(200));
  upsertRows('activities', acts.map(toActivity));
  return toContact(row);
}

/* ─────────────────────────── server-paged queries ─────────────────────────── */

export type LeadQuick = 'open' | 'mine' | 'new' | 'hot' | 'overdue' | 'closed' | 'archived';
export interface LeadQuery {
  quick: LeadQuick;
  q: string;
  status: string;
  source: string;
  owner: string;
  sort: { key: 'name' | 'status' | 'score' | 'budgetMax' | 'createdAt' | 'nextFollowUpAt'; dir: 1 | -1 };
  page: number;
  pageSize: number;
}

const LEAD_SORT: Record<LeadQuery['sort']['key'], string> = {
  name: 'title',
  status: 'status_rank',
  score: 'lead_score',
  budgetMax: 'budget_max',
  createdAt: 'created_at',
  nextFollowUpAt: 'next_follow_up_at',
};

/** Search text is used inside PostgREST filter syntax, so strip its control characters. */
export const safeTerm = (q: string) => q.replace(/[,()*%\\:."']/g, ' ').trim().slice(0, 80);

export async function queryLeads(p: LeadQuery) {
  const { orgId, userId } = ctx();
  const size = Math.min(Math.max(1, p.pageSize), LIMITS.pageMax);
  let q = sb().from('leads').select(LEAD_SELECT, { count: 'exact' }).eq('organization_id', orgId);
  const open = '(won,lost,nurture)';
  if (p.quick === 'archived') q = q.not('archived_at', 'is', null);
  else {
    q = q.is('archived_at', null);
    if (p.quick === 'open') q = q.not('status', 'in', open);
    if (p.quick === 'mine') q = q.not('status', 'in', open).eq('assigned_to', userId);
    if (p.quick === 'new') q = q.eq('status', 'new');
    if (p.quick === 'hot') q = q.not('status', 'in', open).gte('lead_score', 75);
    if (p.quick === 'overdue') q = q.not('status', 'in', open).lt('next_follow_up_at', new Date().toISOString());
    if (p.quick === 'closed') q = q.in('status', ['won', 'lost', 'nurture']);
  }
  if (p.status) q = q.eq('status', p.status);
  if (p.source) q = q.eq('source', p.source);
  if (p.owner === 'none') q = q.is('assigned_to', null);
  else if (p.owner) q = q.eq('assigned_to', p.owner);
  const term = safeTerm(p.q);
  if (term) q = q.or(`title.ilike.*${term}*,source_campaign.ilike.*${term}*,desired_locations.cs.{"${term}"}`);
  q = q.order(LEAD_SORT[p.sort.key], { ascending: p.sort.dir === 1, nullsFirst: false }).order('id').range(p.page * size, p.page * size + size - 1);
  const res = await q;
  const rows = check(res);
  const leads = rows.map(toLead);
  upsertRows('contacts', rows.map((r) => r.contact).filter(Boolean).map(toContact));
  return { rows: leads, total: res.count ?? leads.length };
}

export async function leadCounts() {
  const { orgId } = ctx();
  return check(await sb().rpc('lead_view_counts', { p_org: orgId })) as Record<LeadQuick, number>;
}

export async function leadSources() {
  const { orgId } = ctx();
  const rows = check(await sb().from('leads').select('source').eq('organization_id', orgId).order('source').limit(1000));
  return [...new Set(rows.map((r) => r.source as string))];
}

/** Every matching row for CSV export, fetched in pages (bounded at 10k). */
export async function exportLeads(p: Omit<LeadQuery, 'page' | 'pageSize'>) {
  const out: Lead[] = [];
  for (let page = 0; page < 100; page++) {
    const { rows, total } = await queryLeads({ ...p, page, pageSize: 100 });
    out.push(...rows);
    if (out.length >= total || rows.length < 100) break;
  }
  return out;
}

export interface ContactQuery {
  q: string;
  role: string;
  lifecycle: string;
  page: number;
  pageSize: number;
}

export async function queryContacts(p: ContactQuery) {
  const { orgId } = ctx();
  const size = Math.min(Math.max(1, p.pageSize), LIMITS.pageMax);
  let q = sb().from('contacts').select(CONTACT_COLS, { count: 'exact' }).eq('organization_id', orgId);
  if (p.role) q = q.contains('roles', [p.role]);
  if (p.lifecycle) q = q.eq('lifecycle_status', p.lifecycle);
  const term = safeTerm(p.q);
  if (term) {
    const digits = term.replace(/\D/g, '');
    q = q.or([`display_name.ilike.*${term}*`, `email_normalized.ilike.*${term.toLowerCase()}*`, ...(digits.length >= 4 ? [`phone_e164.ilike.*${digits}*`] : [])].join(','));
  }
  const res = await q.order('created_at', { ascending: false }).order('id').range(p.page * size, p.page * size + size - 1);
  const rows = check(res);
  const contacts = rows.map(toContact);
  upsertRows('contacts', contacts);
  const ids = contacts.map((c) => c.id);
  const counts = new Map<string, number>();
  if (ids.length) {
    const lr = check(await sb().from('leads').select('contact_id').in('contact_id', ids).limit(1000));
    for (const r of lr) counts.set(r.contact_id, (counts.get(r.contact_id) ?? 0) + 1);
  }
  return { rows: contacts, total: res.count ?? contacts.length, leadCounts: counts };
}

export async function dashboardMetrics(from: number, to: number, bucket: 'day' | 'week' | 'month') {
  const { orgId } = ctx();
  return check(await sb().rpc('dashboard_metrics', { p_org: orgId, p_from: iso(from), p_to: iso(to), p_bucket: bucket })) as DashboardMetrics;
}

export interface DashboardMetrics {
  range: { from: string; to: string; bucket: string; timezone: string };
  kpis: {
    new_leads: { current: number; previous: number };
    qualified: { current: number; previous: number };
    viewings_booked: { current: number; previous: number };
    lead_to_visit: { current: number; previous: number };
    active_deals: { current: number; pipeline_value: number; opened: number; opened_previous: number };
    won_value: { current: number; previous: number };
    active_properties: number;
    tasks_completed: number;
  };
  series: { start: string; leads: number; qualified: number; previous_leads: number; viewings: number; won_value: number }[];
  sources: { source: string; leads: number; qualified: number }[];
  funnel: { label: string; n: number }[];
  arrivals: { dow: number; block: number; n: number }[];
  response: { median_minutes: number | null; previous_median_minutes: number | null; within_sla: number; sla_minutes: number; awaiting_first_contact: number };
}

/* ─────────────────────────── mutations ─────────────────────────── */

export interface CreateLeadInput {
  name: string;
  phone: string;
  email: string;
  source: string;
  type: Lead['type'];
  budgetMax?: number | null;
  locations?: string[];
  propertyType?: Lead['propertyType'] | null;
  bedrooms?: number | null;
  timeline?: string | null;
  notes?: string;
  assignedTo?: string | null;
  existingContactId?: string | null;
  consentChannels?: Channel[];
}

export type CreateLeadResult =
  | { status: 'created'; lead: Lead | null; leadId: string }
  | { status: 'duplicate'; candidates: { contactId: string; name: string; reasons: string[] }[] };

export async function createLead(input: CreateLeadInput, onDuplicate: 'ask' | 'link' | 'create'): Promise<CreateLeadResult> {
  const { orgId } = ctx();
  const payload: Record<string, unknown> = {
    name: input.name, phone: input.phone, email: input.email, source: input.source, type: input.type,
    budget_max: input.budgetMax ?? null, locations: input.locations ?? [], property_type: input.propertyType ?? null, bedrooms: input.bedrooms ?? null,
    timeline: input.timeline ?? null, notes: input.notes ?? '', consent_channels: input.consentChannels ?? [],
  };
  if (input.assignedTo !== undefined) payload.assigned_to = input.assignedTo;
  if (input.existingContactId) payload.contact_id = input.existingContactId;
  const r = check(await sb().rpc('create_lead', { p_org: orgId, p_input: payload, p_on_duplicate: onDuplicate })) as {
    status: string; lead_id: string; candidates?: { contact_id: string; name: string; reasons: string[] }[];
  };
  if (r.status === 'duplicate') return { status: 'duplicate', candidates: (r.candidates ?? []).map((c) => ({ contactId: c.contact_id, name: c.name, reasons: c.reasons })) };
  const lead = await ensureLead(r.lead_id);
  await refresh('leads', 'activities', 'notifications');
  return { status: 'created', lead, leadId: r.lead_id };
}

export async function updateLead(id: string, patch: Partial<Lead>) {
  check(await sb().from('leads').update(leadToRow(patch)).eq('id', id).select('id').single());
  await ensureLead(id);
  useLiveRev.getState().bump();
}

export async function setLeadStatus(id: string, status: LeadStatus, reason?: string) {
  await updateLead(id, { status, ...(status === 'lost' ? { lostReason: reason ?? 'Other' } : {}) });
}

export async function assignLeads(ids: string[], memberId: string | null) {
  // One statement per lead keeps per-row permission errors precise; small batches only.
  for (const id of ids) check(await sb().from('leads').update({ assigned_to: memberId }).eq('id', id).select('id').single());
  await refresh('leads', 'activities');
}

export async function archiveLeads(ids: string[], archived: boolean) {
  check(await sb().from('leads').update({ archived_at: archived ? new Date().toISOString() : null }).in('id', ids).select('id'));
  await refresh('leads');
}

export async function mergeLeads(keep: string, drop: string) {
  checkMaybe(await sb().rpc('merge_leads', { p_keep: keep, p_drop: drop }));
  await ensureLead(keep);
  await refresh('leads');
}

export interface IntakeSummary {
  intake_status: 'completed' | 'review_required' | null;
  duplicate_status: string | null;
  run: {
    id: string; status: string; source_kind: string; provider: string; received_at: string; completed_at: string | null; attempts: number;
    warnings: string[] | null; missing: string[] | null; assignment: string | null; duplicate: string | null; ai_fields: string[] | null;
    model: string | null; model_outcome: string | null;
  } | null;
  handoff: { status: string; created_at: string; delivered_at: string | null; attempts: number } | null;
  review: {
    id: string; status: 'open' | 'resolved'; reasons: string[]; resolution: 'distinct' | 'duplicate' | null; resolved_at: string | null;
    candidates: { contact_id: string; name: string; leads: { id: string; title: string; status: string; source: string; created_at: string }[] }[];
  } | null;
}

/* ─────────────────────────── voice calls (Agent 02) ─────────────────────────── */

export interface PolicyCheck { key: string; label: string; ok: boolean; detail: string }

export interface VoiceCallRow {
  id: string; organization_id: string; lead_id: string | null; contact_id: string | null; direction: 'outbound' | 'inbound';
  status: 'initiating' | 'dialing' | 'in_progress' | 'completed' | 'no_answer' | 'busy' | 'voicemail' | 'failed' | 'unknown' | 'blocked';
  outcome: string | null; summary: string | null; requested_at: string; started_at: string | null; ended_at: string | null;
  duration_seconds: number | null; disconnection_reason: string | null; analysis_status: string; human_handoff_status: string | null;
  opt_out_detected: boolean; block_reason: string | null; last_provider_error: string | null; recording_available: boolean;
  transcript_stored: boolean; initiated_by: string; initiated_by_user_id: string | null;
  analysis: { filled?: string[]; conflicts?: string[]; unanswered_questions?: string[]; next_recommended_action?: string; summary?: string; intent?: string; preferred_locations?: string[]; budget_max?: number; currency?: string; property_type?: string; bedrooms?: number; timeline?: string } | null;
}

export interface VoiceSettings {
  enabled: boolean; outbound_agent_id: string | null; inbound_agent_id: string | null; from_number: string | null; agency_spoken_name: string | null;
  consent_basis: 'ai_call' | 'phone'; store_transcripts: boolean; analysis_enabled: boolean; recording_access: boolean;
  transcript_retention_days: number; max_attempts_per_lead_per_day: number; min_minutes_between_attempts: number; max_calls_per_day: number;
}

const VOICE_COLS = 'id, organization_id, lead_id, contact_id, direction, status, outcome, summary, requested_at, started_at, ended_at, duration_seconds, disconnection_reason, analysis_status, human_handoff_status, opt_out_detected, block_reason, last_provider_error, recording_available, transcript_stored, initiated_by, initiated_by_user_id, analysis';

/** Calls an Edge Function and turns its JSON error envelope into an ApiError. */
async function invokeFn<T>(name: string, opts: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<T> {
  const { data, error } = await sb().functions.invoke(name, { method: opts.method ?? 'POST', body: opts.body as Record<string, unknown> | undefined });
  if (error) {
    let code = 'UNKNOWN';
    let message = 'The server could not complete the request.';
    try {
      const b = (await (error as { context?: Response }).context?.json()) as { error?: { code?: string; message?: string } } | undefined;
      code = b?.error?.code ?? code;
      message = b?.error?.message ?? message;
    } catch { /* no JSON body */ }
    throw new ApiError((['NOT_FOUND', 'FORBIDDEN', 'VALIDATION_ERROR', 'CONFLICT', 'UNAUTHENTICATED'].includes(code) ? code : 'UNKNOWN') as never, message);
  }
  return data as T;
}

export async function voiceStatus() {
  return invokeFn<{ retell_configured: boolean; analysis_configured: boolean }>('voice-calls/status', { method: 'GET' });
}

export async function voicePreflight(leadId: string) {
  return check(await sb().rpc('voice_call_preflight', { p_lead: leadId })) as { allowed: boolean; checks: PolicyCheck[] };
}

export async function requestAiCall(leadId: string, idempotencyKey: string) {
  const r = await invokeFn<{ status: string; call_id: string; reason?: string; checks?: PolicyCheck[] }>('voice-calls/call', { body: { lead_id: leadId, idempotency_key: idempotencyKey } });
  useLiveRev.getState().bump();
  return r;
}

export async function setAiCallConsent(contactId: string, status: 'granted' | 'revoked', source: string) {
  checkMaybe(await sb().rpc('set_ai_call_consent', { p_contact: contactId, p_status: status, p_source: source }));
  await ensureContact(contactId);
  useLiveRev.getState().bump();
}

export async function leadVoiceCalls(leadId: string) {
  return check(await sb().from('voice_calls').select(VOICE_COLS).eq('lead_id', leadId).neq('status', 'blocked').order('requested_at', { ascending: false }).limit(20)) as VoiceCallRow[];
}

export async function listVoiceCalls(p: { status?: string; direction?: string; page: number; pageSize: number }) {
  const { orgId } = ctx();
  let q = sb().from('voice_calls').select(VOICE_COLS, { count: 'exact' }).eq('organization_id', orgId);
  if (p.status === 'live') q = q.in('status', ['initiating', 'dialing', 'in_progress']);
  else if (p.status === 'attention') q = q.or('status.in.(unknown,failed),human_handoff_status.not.is.null,analysis_status.eq.failed');
  else if (p.status) q = q.eq('status', p.status);
  if (p.direction) q = q.eq('direction', p.direction);
  const res = await q.order('requested_at', { ascending: false }).range(p.page * p.pageSize, p.page * p.pageSize + p.pageSize - 1);
  return { rows: check(res) as VoiceCallRow[], total: res.count ?? 0 };
}

export async function voiceCallDetail(callId: string) {
  return check(await sb().rpc('voice_call_detail', { p_call: callId })) as { call: VoiceCallRow & { provider_analysis: Record<string, unknown> }; transcript: string | null; can_view_transcript: boolean; recording_access: boolean };
}

export async function voiceRecordingUrl(callId: string) {
  return invokeFn<{ url: string }>(`voice-calls/recording?call_id=${callId}`, { method: 'GET' });
}

export async function loadVoiceSettings(): Promise<VoiceSettings | null> {
  const { orgId } = ctx();
  return checkMaybe(await sb().from('voice_settings').select('*').eq('organization_id', orgId).maybeSingle()) as VoiceSettings | null;
}

export async function saveVoiceSettings(s: VoiceSettings) {
  const { orgId } = ctx();
  checkMaybe(await sb().rpc('voice_settings_save', { p_org: orgId, p: s }));
  useLiveRev.getState().bump();
}

/* ─────────────────────────── qualification (Agent 03) ─────────────────────────── */

export type QualStatus = 'unqualified' | 'in_progress' | 'needs_information' | 'qualified' | 'high_intent' | 'nurture' | 'human_review_required' | 'disqualified';
export interface QualField { value: unknown; certainty: 'confirmed' | 'ai_extracted' | 'stated' | 'inferred'; source: string }
export interface Qualification {
  id: string; lead_id: string; status: QualStatus; score: number | null; trigger: string; created_at: string;
  score_breakdown: { key: string; label: string; weight: number; value: number; points: number | null; evidence: string }[];
  requirements: Partial<Record<'intent' | 'locations' | 'budget' | 'property_type' | 'bedrooms' | 'timeline', QualField>>;
  missing: string[]; conflicts: { field: string; crm?: unknown; proposed?: unknown; source?: string; note?: string }[];
  questions: { field: string; question: string }[]; recommended_action: string; human_review_required: boolean; review_reasons: string[];
  review_status: string; reviewed_at: string | null; review_note: string | null; analysis_status: string; summary: string | null; ruleset_version: number;
}
export interface LeadQualificationView {
  status: QualStatus | null;
  current: Qualification | null;
  history: { id: string; status: QualStatus; score: number | null; trigger: string; review_status: string; created_at: string }[];
  run: { id: string; status: string; received_at: string; completed_at: string | null; attempts: number; error_category: string | null; awaiting_analysis: boolean; analysis_outcome: string | null } | null;
  can_review: boolean; can_run: boolean;
}

export async function leadQualification(leadId: string) {
  return check(await sb().rpc('lead_qualification', { p_lead: leadId })) as LeadQualificationView;
}

export async function requestQualification(leadId: string) {
  const r = check(await sb().rpc('qualification_request', { p_lead: leadId, p_idempotency_key: `ui_${crypto.randomUUID().replace(/-/g, '')}` })) as { run_id: string; status: string };
  useLiveRev.getState().bump();
  return r;
}

export async function reviewQualification(qualificationId: string, decision: 'approve' | 'reject' | 'override' | 'edit', opts: { status?: QualStatus; edits?: Record<string, unknown>; note?: string } = {}) {
  const r = check(await sb().rpc('qualification_review', { p_qualification: qualificationId, p_decision: decision, p_status: opts.status ?? null, p_edits: opts.edits ?? null, p_note: opts.note ?? null }));
  await refresh('leads', 'activities', 'tasks');
  useLiveRev.getState().bump();
  return r as { status: string; review_status: string; requalify_run: string | null };
}

/** Last 7 days of qualification results for the AI agents page (counts only). */
export async function qualificationAgentOverview() {
  const { orgId } = ctx();
  const since = new Date(Date.now() - 7 * 864e5).toISOString();
  const [quals, pendingMatching, pendingInput] = await Promise.all([
    sb().from('lead_qualifications').select('status, review_status, created_at').eq('organization_id', orgId).gte('created_at', since).order('created_at', { ascending: false }).limit(1000)
      .then((r) => check(r) as { status: QualStatus; review_status: string; created_at: string }[]),
    sb().from('outbox_events').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).eq('event_type', 'lead.qualification.completed').in('status', ['pending', 'processing']).then((r) => r.count ?? 0),
    sb().from('outbox_events').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).eq('consumer', 'sales_qualification_agent').in('status', ['pending', 'processing']).then((r) => r.count ?? 0),
  ]);
  return {
    runs7d: quals.length,
    qualified7d: quals.filter((q) => q.status === 'qualified' || q.status === 'high_intent').length,
    reviewsPending: quals.filter((q) => q.review_status === 'pending').length,
    last: quals[0] ? new Date(quals[0].created_at).getTime() : null,
    pendingMatching, pendingInput,
  };
}

/* ─────────────────────────── property matching (Agent 04) ─────────────────────────── */

export type MatchRunStatus = 'completed' | 'completed_with_warnings' | 'needs_more_information' | 'no_matches' | 'not_applicable';
export type MatchStatus = 'recommended' | 'viewed' | 'shortlisted' | 'rejected' | 'shared' | 'appointment_requested' | 'invalidated';
export interface MatchNote { code: string; text: string }
export interface PropertyMatch {
  id: string; rank: number; score: number; band: 'strong' | 'good' | 'partial';
  breakdown: { key: string; label: string; weight: number; value: number; points: number | null; status: 'matched' | 'partial' | 'unmet' | 'unknown' }[];
  strengths: MatchNote[]; tradeoffs: MatchNote[]; caveats: MatchNote[];
  availability: 'verified' | 'stale' | 'unverified'; budget_fit: string; explanation: string; ai_summary: string | null;
  status: MatchStatus; status_reason: string | null; decided_at: string | null; price_changed: boolean;
  snapshot: { price: number; currency: string; status: string; verified_at: string | null };
  property: { id: string; reference_code: string; title: string; property_type: string; listing_type: 'sale' | 'rent'; status: string; price: number; currency: string;
    bedrooms: number; bathrooms: number; area_value: number; area_unit: string; furnishing: string; locality: string; city: string | null; amenities: string[];
    verified_at: string | null; updated_at: string };
}
export interface MatchRun {
  id: string; status: MatchRunStatus; trigger: string; created_at: string; inventory_count: number; candidate_count: number; eligible_count: number;
  recommended_count: number; rejections: Record<string, number>; warnings: string[]; missing: string[]; ruleset_version: number;
  explanation_status: string; criteria: { prepared: Record<string, unknown> };
}
export interface LeadMatchesView {
  current: MatchRun | null; outdated: boolean; matches: PropertyMatch[];
  history: { id: string; status: MatchRunStatus; recommended_count: number; eligible_count: number; candidate_count: number; trigger: string; created_at: string }[];
  run: { id: string; status: string; received_at: string; completed_at: string | null; attempts: number; error_category: string | null } | null;
  can_act: boolean;
}

export async function leadPropertyMatches(leadId: string) {
  return check(await sb().rpc('lead_property_matches', { p_lead: leadId })) as LeadMatchesView;
}

/** Leads whose current Agent 04 run recommends this listing (server-ranked, RLS-scoped; rejected / invalidated excluded). */
export async function propertyCurrentMatches(propertyId: string) {
  return check(
    await sb()
      .from('property_matches')
      .select('lead_id, score, band, strengths, status, property_match_runs!inner(is_current)')
      .eq('property_id', propertyId)
      .eq('property_match_runs.is_current', true)
      .not('status', 'in', '(rejected,invalidated)')
      .order('score', { ascending: false })
      .limit(6),
  ) as unknown as { lead_id: string; score: number; band: PropertyMatch['band']; strengths: MatchNote[]; status: MatchStatus }[];
}

export async function requestPropertyMatching(leadId: string) {
  const r = check(await sb().rpc('property_matching_request', { p_lead: leadId, p_idempotency_key: `ui_${crypto.randomUUID().replace(/-/g, '')}` })) as { run_id: string; status: string };
  useLiveRev.getState().bump();
  return r;
}

export async function propertyMatchAction(matchId: string, action: 'view' | 'shortlist' | 'reject' | 'share' | 'restore' | 'request_review', note?: string) {
  const r = check(await sb().rpc('property_match_action', { p_match: matchId, p_action: action, p_note: note ?? null })) as { status: MatchStatus | 'invalidated'; reason?: string };
  if (action !== 'view') { await refresh('leads', 'activities', 'tasks'); useLiveRev.getState().bump(); }
  return r;
}

/** Last 7 days of matching runs for the AI agents page (counts only). */
export async function matchingAgentOverview() {
  const { orgId } = ctx();
  const since = new Date(Date.now() - 7 * 864e5).toISOString();
  const [runs, pendingInput, pendingFollowUp] = await Promise.all([
    sb().from('property_match_runs').select('status, recommended_count, created_at').eq('organization_id', orgId).gte('created_at', since).order('created_at', { ascending: false }).limit(1000)
      .then((r) => check(r) as { status: MatchRunStatus; recommended_count: number; created_at: string }[]),
    sb().from('outbox_events').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).eq('consumer', 'property_matching_agent').in('status', ['pending', 'processing']).then((r) => r.count ?? 0),
    sb().from('outbox_events').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).eq('event_type', 'property_matching.completed').in('status', ['pending', 'processing']).then((r) => r.count ?? 0),
  ]);
  return {
    runs7d: runs.length,
    withMatches7d: runs.filter((r) => r.recommended_count > 0).length,
    noMatches7d: runs.filter((r) => r.status === 'no_matches').length,
    needsInfo7d: runs.filter((r) => r.status === 'needs_more_information').length,
    last: runs[0] ? new Date(runs[0].created_at).getTime() : null,
    pendingInput, pendingFollowUp,
  };
}

/* ─────────────────────────── follow-ups (Agent 05) ─────────────────────────── */

export type FollowUpStatus = 'pending_approval' | 'approved' | 'scheduled' | 'processing' | 'sent' | 'delivered' | 'failed' | 'cancelled' | 'suppressed' | 'expired' | 'handed_off';
export type FollowUpPurpose = 'share_property_recommendations' | 'clarify_requirements' | 'answer_call_questions' | 'callback_request' | 're_engagement';
export interface FollowUpItem {
  id: string; lead_id: string; purpose: FollowUpPurpose; kind: 'message' | 'task'; channel: 'whatsapp' | 'sms' | 'email' | 'task'; status: FollowUpStatus;
  status_reason: string | null; reason: string; scheduled_for: string | null; timezone: string | null; subject: string | null; body: string | null;
  content_version: number; generated_by: 'template' | 'ai' | 'human'; draft_status: string; approved_at: string | null; approved_version: number | null;
  rejection_note: string | null; sent_at: string | null; sent_via: 'manual' | 'provider' | null; delivered_at: string | null; provider: string | null;
  last_error_category: string | null; task_id: string | null; call_id: string | null; created_at: string; trigger: string;
  properties: { id: string; title: string; reference_code: string; status: string }[];
}
export interface ChannelPolicy { allowed: boolean; blocked: boolean; defer_until: string | null; failed: string[] }
export interface LeadFollowUpsView {
  items: FollowUpItem[];
  channels: Record<'whatsapp' | 'sms' | 'email', { policy: ChannelPolicy; provider: string | null }>;
  run: { id: string; status: string; trigger: string; received_at: string; outcome: Record<string, unknown> | null } | null;
  can_act: boolean; can_view_drafts: boolean;
}

export async function leadFollowUps(leadId: string) {
  return check(await sb().rpc('lead_follow_ups', { p_lead: leadId })) as LeadFollowUpsView;
}

export async function requestFollowUp(leadId: string, purpose: 'share_property_recommendations' | 'clarify_requirements' | 're_engagement') {
  const r = check(await sb().rpc('follow_up_request', { p_lead: leadId, p_purpose: purpose, p_idempotency_key: `ui_${crypto.randomUUID().replace(/-/g, '')}` }));
  useLiveRev.getState().bump();
  return r as { run_id: string };
}

export async function updateFollowUpDraft(id: string, subject: string | null, body: string) {
  return check(await sb().rpc('follow_up_update_draft', { p_follow_up: id, p_subject: subject, p_body: body })) as { status: FollowUpStatus; content_version: number };
}

export async function decideFollowUp(id: string, decision: 'approve' | 'reject' | 'cancel', version: number | null, note?: string) {
  const r = check(await sb().rpc('follow_up_decide', { p_follow_up: id, p_decision: decision, p_expected_version: version, p_note: note ?? null }));
  useLiveRev.getState().bump();
  return r as { status: FollowUpStatus };
}

/** Records that a person sent the approved text through their own channel. The backend re-checks policy first. */
export async function markFollowUpSent(id: string, version: number) {
  const r = check(await sb().rpc('follow_up_mark_sent', { p_follow_up: id, p_expected_version: version })) as { status: FollowUpStatus; reason?: unknown };
  await refresh('leads', 'activities');
  useLiveRev.getState().bump();
  return r;
}

export async function retryFollowUp(id: string) {
  return check(await sb().rpc('follow_up_retry', { p_follow_up: id })) as { status: FollowUpStatus };
}

export interface FollowUpQueueRow { id: string; lead_id: string; purpose: FollowUpPurpose; kind: string; channel: string; status: FollowUpStatus; status_reason: string | null;
  reason: string; created_at: string; sent_at: string | null; sent_via: string | null; generated_by: string; leads: { title: string } | null }

/** Org-wide queue for the Follow-ups page (RLS-scoped). */
export async function followUpQueue(statuses: FollowUpStatus[]) {
  const { orgId } = ctx();
  return check(await sb().from('follow_ups').select('id, lead_id, purpose, kind, channel, status, status_reason, reason, created_at, sent_at, sent_via, generated_by, leads(title)')
    .eq('organization_id', orgId).in('status', statuses).order('created_at', { ascending: false }).limit(200)) as unknown as FollowUpQueueRow[];
}

/** Last 7 days of follow-ups for the AI agents page (counts only). */
export async function followUpAgentOverview() {
  const { orgId } = ctx();
  const since = new Date(Date.now() - 7 * 864e5).toISOString();
  const [rows, pendingInput] = await Promise.all([
    sb().from('follow_ups').select('status, created_at').eq('organization_id', orgId).gte('created_at', since).order('created_at', { ascending: false }).limit(1000)
      .then((r) => check(r) as { status: FollowUpStatus; created_at: string }[]),
    sb().from('outbox_events').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).eq('consumer', 'follow_up_agent').in('status', ['pending', 'processing']).then((r) => r.count ?? 0),
  ]);
  const n = (s: FollowUpStatus[]) => rows.filter((x) => s.includes(x.status)).length;
  return { planned7d: rows.length, awaiting: n(['pending_approval']), ready: n(['approved', 'scheduled']), sent7d: n(['sent', 'delivered']), stopped7d: n(['suppressed', 'cancelled', 'expired']),
    handedOff7d: n(['handed_off']), last: rows[0] ? new Date(rows[0].created_at).getTime() : null, pendingInput };
}

/** Last 7 days of voice calls for the AI agents page (counts only). */
export async function voiceAgentOverview() {
  const { orgId } = ctx();
  const since = new Date(Date.now() - 7 * 864e5).toISOString();
  const [calls, settings, status, pending] = await Promise.all([
    sb().from('voice_calls').select('status, outcome, human_handoff_status, requested_at').eq('organization_id', orgId).neq('status', 'blocked').gte('requested_at', since).order('requested_at', { ascending: false }).limit(1000).then((r) => check(r) as { status: string; outcome: string | null; human_handoff_status: string | null; requested_at: string }[]),
    loadVoiceSettings(),
    voiceStatus().catch(() => ({ retell_configured: false, analysis_configured: false })),
    sb().from('outbox_events').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).eq('event_type', 'voice_call.completed').in('status', ['pending', 'processing']).then((r) => r.count ?? 0),
  ]);
  return {
    calls7d: calls.length,
    connected7d: calls.filter((c) => c.status === 'completed').length,
    callbacks7d: calls.filter((c) => c.human_handoff_status).length,
    lastCall: calls[0] ? new Date(calls[0].requested_at).getTime() : null,
    enabled: !!settings?.enabled,
    retellConfigured: status.retell_configured,
    handoffPending: pending,
  };
}

export interface AgentRunRow {
  id: string; status: string; source_kind: string; provider: string; received_at: string; completed_at: string | null;
  duration_ms: number | null; attempt_count: number; lead_id: string | null; agent_version: string; error_category: string | null;
  outcome: { duplicate?: { outcome?: string }; assignment?: { rule?: string }; errors?: string[]; action?: string } | null;
  model_meta: { outcome?: string; model?: string } | null;
}

export interface AgentOverview {
  runs: AgentRunRow[];
  handoffPending: number;
  handoffFailed: number;
  openReviews: number;
}

/** Last 7 days of Lead Intake Agent runs plus queue counts. Readable by roles with logs.view (RLS). */
export async function leadIntakeAgentOverview(): Promise<AgentOverview> {
  const { orgId } = ctx();
  const since = new Date(Date.now() - 7 * 864e5).toISOString();
  const count = async (q: PromiseLike<{ count: number | null; error: unknown }>) => {
    const r = await q;
    if (r.error) throw r.error;
    return r.count ?? 0;
  };
  const [runs, handoffPending, handoffFailed, openReviews] = await Promise.all([
    sb().from('agent_runs')
      .select('id, status, source_kind, provider, received_at, completed_at, duration_ms, attempt_count, lead_id, agent_version, error_category, outcome, model_meta')
      .eq('organization_id', orgId).eq('agent_id', 'lead_intake_agent').gte('received_at', since)
      .order('received_at', { ascending: false }).limit(500)
      .then((r) => check(r) as AgentRunRow[]),
    count(sb().from('outbox_events').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).eq('consumer', 'sales_qualification_agent').in('status', ['pending', 'processing'])),
    count(sb().from('outbox_events').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).eq('status', 'dead_letter')),
    count(sb().from('review_items').select('id', { count: 'exact', head: true }).eq('organization_id', orgId).eq('status', 'open')),
  ]);
  return { runs, handoffPending, handoffFailed, openReviews };
}

export async function leadIntakeSummary(leadId: string): Promise<IntakeSummary> {
  return check(await sb().rpc('lead_intake_summary', { p_lead: leadId })) as IntakeSummary;
}

export async function resolveIntakeReview(reviewId: string, decision: 'distinct' | 'duplicate', keepLeadId?: string) {
  const r = check(await sb().rpc('resolve_intake_review', { p_review: reviewId, p_decision: decision, p_keep_lead: keepLeadId ?? null })) as { lead_id: string };
  await ensureLead(r.lead_id);
  await refresh('leads', 'activities', 'notifications');
  useLiveRev.getState().bump();
  return r.lead_id;
}

export async function addNote(leadId: string, body: string) {
  const { orgId, userId } = ctx();
  checkMaybe(await sb().from('activities').insert({ organization_id: orgId, lead_id: leadId, activity_type: 'note', title: 'Note added', description: body, source: 'user', created_by: userId }));
  await ensureLead(leadId);
}

export async function importLeads(rows: Record<string, string>[], opts: ImportOptions = {}): Promise<ImportResult> {
  const { orgId } = ctx();
  let result: ImportResult;
  try {
    result = await runImport(rows, async (batch) => check(await sb().rpc('import_leads', {
      p_org: orgId,
      p_rows: batch.map((x) => ({
        name: x.name, phone: x.phone, email: x.email, source: x.source, type: x.type, budget_max: x.budgetMax,
        locations: x.locations, bedrooms: x.bedrooms, notes: x.notes ?? null,
      })),
    })) as ImportRowOutcome[], opts);
  } catch (e) {
    if (e instanceof ImportStopped) throw new ApiError(e.code as ErrorCode, e.message);
    throw e;
  }
  if (result.created) await refresh('leads', 'activities');
  return result;
}

export async function updateContact(id: string, patch: { name?: string; phone?: string; email?: string; preferredChannel?: Channel }) {
  const row: Record<string, unknown> = {};
  if (patch.name !== undefined) row.display_name = patch.name;
  if (patch.phone !== undefined) row.phone = patch.phone || null;
  if (patch.email !== undefined) row.email = patch.email || null;
  if (patch.preferredChannel !== undefined) row.preferred_contact_channel = patch.preferredChannel;
  check(await sb().from('contacts').update(row).eq('id', id).select('id').single());
  if (patch.name) check(await sb().from('leads').update({ title: patch.name }).eq('contact_id', id).select('id'));
  await ensureContact(id);
  useLiveRev.getState().bump();
}

export async function setConsent(contactId: string, channel: Channel, state: ConsentState, source = 'Staff update') {
  checkMaybe(await sb().rpc('set_contact_consent', { p_contact: contactId, p_channel: channel, p_status: state, p_source: source }));
  await ensureContact(contactId);
}

export async function optOutAll(contactId: string) {
  checkMaybe(await sb().rpc('opt_out_contact', { p_contact: contactId }));
  await ensureContact(contactId);
  useLiveRev.getState().bump();
}

export async function saveProperty(p: Partial<Property> & { id?: string }) {
  const { orgId } = ctx();
  const row = propertyToRow(p);
  let saved: Record<string, unknown>;
  if (p.id) {
    saved = check(await sb().from('properties').update(row).eq('id', p.id).select(PROPERTY_COLS).single());
  } else {
    const ref = `${(useStore.getState().orgs.find((o) => o.id === orgId)?.slug ?? 'pr').slice(0, 2).toUpperCase()}-${Date.now().toString(36).slice(-5).toUpperCase()}`;
    saved = check(await sb().from('properties').insert({ ...row, organization_id: orgId, reference_code: ref, city: useStore.getState().orgs.find((o) => o.id === orgId)?.city || null }).select(PROPERTY_COLS).single());
  }
  const prop = toProperty(saved);
  upsertRows('properties', [prop]);
  return prop;
}

export async function verifyProperty(id: string) {
  const saved = check(await sb().from('properties').update({ verified_at: new Date().toISOString() }).eq('id', id).select(PROPERTY_COLS).single());
  upsertRows('properties', [toProperty(saved)]);
}

export async function createDeal(d: Omit<Deal, 'id' | 'orgId' | 'createdAt' | 'stageChangedAt' | 'lostReason'>) {
  const { orgId } = ctx();
  const row = check(await sb().from('deals').insert({
    organization_id: orgId, title: d.title, lead_id: d.leadId, primary_contact_id: d.contactId, property_id: d.propertyId, stage: d.stage,
    expected_value: d.value, commission_pct: d.commissionPct, expected_close_date: new Date(d.expectedClose).toISOString().slice(0, 10), owner_user_id: d.ownerId,
  }).select('*').single());
  await refresh('deals', 'activities');
  return toDeal(row);
}

export async function moveDeal(id: string, stage: DealStage, lostReason?: string) {
  check(await sb().from('deals').update({ stage, lost_reason: stage === 'lost' ? lostReason ?? 'Other' : null }).eq('id', id).select('id').single());
  await refresh('deals', 'leads', 'properties', 'commissions', 'activities', 'notifications');
}

export async function updateDeal(id: string, patch: Partial<Deal>) {
  const row: Record<string, unknown> = {};
  if (patch.expectedClose !== undefined) row.expected_close_date = new Date(patch.expectedClose).toISOString().slice(0, 10);
  if (patch.value !== undefined) row.expected_value = patch.value;
  if (patch.ownerId !== undefined) row.owner_user_id = patch.ownerId;
  check(await sb().from('deals').update(row).eq('id', id).select('id').single());
  await refresh('deals');
}

export interface BookInput {
  title: string;
  type: 'viewing' | 'consultation' | 'valuation' | 'follow_up';
  status: 'requested' | 'pending' | 'confirmed';
  leadId: string | null;
  contactId: string | null;
  propertyId: string | null;
  assignedTo: string | null;
  start: number;
  end: number;
  location: string;
}

/* ─────────────────────────── appointments (Agent 06) ─────────────────────────── */

// Availability and booking go through the scheduling RPCs: the server picks the status, re-checks every rule under a
// lock and is idempotent per key. These codes mean "that time is taken" (alternatives are offered); others are errors.
const SLOT_CONFLICTS = ['APPOINTMENT_CONFLICT', 'PROPERTY_BOOKED', 'STAFF_UNAVAILABLE', 'CLOSED', 'PROPERTY_UNAVAILABLE', 'OUTSIDE_WORKING_HOURS', 'OUTSIDE_BUSINESS_HOURS'];
const CONFLICT_LABEL: Record<string, string> = {
  APPOINTMENT_CONFLICT: 'another appointment (or its buffer)', PROPERTY_BOOKED: 'another viewing of this property', STAFF_UNAVAILABLE: 'time off or calendar busy time',
  CLOSED: 'an office closure', PROPERTY_UNAVAILABLE: 'a viewing restriction on this property', OUTSIDE_WORKING_HOURS: "this person's working hours", OUTSIDE_BUSINESS_HOURS: 'business hours',
};

export interface Slot { starts_at: string; ends_at: string; assignee_id: string; assignee_name: string; local_label: string; preferred: boolean }
export interface Availability {
  status: 'ok' | 'no_slots' | 'unverified' | 'invalid'; slots?: Slot[]; reasons?: string[]; timezone: string; duration?: number; buffer_minutes?: number;
  unverified_staff?: number; calendar_provider?: string | null;
}

export async function appointmentAvailability(p: { leadId: string | null; type: BookInput['type']; propertyId?: string | null; assigneeId?: string | null;
  dateFrom?: string; dateTo?: string; prefStart?: string; prefEnd?: string; duration?: number }) {
  return check(await sb().rpc('appointment_availability', {
    p_lead: p.leadId, p_org: p.leadId ? null : ctx().orgId, p_type: p.type, p_property: p.propertyId ?? null, p_assignee: p.assigneeId ?? null,
    p_date_from: p.dateFrom ?? null, p_date_to: p.dateTo ?? null, p_pref_start: p.prefStart ?? null, p_pref_end: p.prefEnd ?? null, p_duration: p.duration ?? null,
  })) as Availability;
}

export async function bookAppointment(a: BookInput) {
  const { orgId } = ctx();
  const minutes = Math.round((a.end - a.start) / 60000);
  try {
    const r = check(await sb().rpc('appointment_book', {
      p_lead: a.leadId, p_org: a.leadId ? null : orgId, p_type: a.type, p_starts_at: iso(a.start), p_assignee: a.assignedTo,
      p_idempotency_key: `ui_${crypto.randomUUID().replace(/-/g, '')}`, p_property: a.propertyId, p_duration: minutes, p_location: a.location, p_title: a.title,
    })) as { appointment_id: string };
    const row = check(await sb().from('appointments').select('*').eq('id', r.appointment_id).single());
    await refresh('appointments', 'leads', 'activities', 'tasks');
    return { ok: true as const, appointment: toAppointment(row) };
  } catch (e) {
    const err = toApiError(e);
    if (!SLOT_CONFLICTS.includes(err.code) || !a.assignedTo) throw err;
    // Real alternatives from the same availability engine, starting that day.
    const day = new Date(a.start).toISOString().slice(0, 10);
    const av = await appointmentAvailability({ leadId: a.leadId, type: a.type, propertyId: a.propertyId, assigneeId: a.assignedTo, dateFrom: day, duration: minutes }).catch(() => null);
    return { ok: false as const, conflictTitle: CONFLICT_LABEL[err.code] ?? 'another appointment', alternatives: (av?.slots ?? []).slice(0, 4).map((s) => new Date(s.starts_at).getTime()) };
  }
}

async function appointmentVersion(id: string) {
  return (check(await sb().from('appointments').select('version').eq('id', id).single()) as { version: number }).version;
}

export async function setAppointmentStatus(id: string, status: string, extra?: { reason?: string; feedback?: string }) {
  if (status === 'cancelled') check(await sb().rpc('appointment_cancel', { p_appt: id, p_reason: extra?.reason ?? '' }));
  else if (status === 'confirmed') check(await sb().rpc('appointment_confirm', { p_appt: id, p_version: await appointmentVersion(id) }));
  else check(await sb().rpc('appointment_set_outcome', { p_appt: id, p_outcome: status, p_feedback: extra?.feedback ?? null }));
  await refresh('appointments', 'leads', 'activities', 'tasks');
}

export async function rescheduleAppointment(id: string, start: number, _end: number) {
  try {
    check(await sb().rpc('appointment_reschedule', { p_appt: id, p_starts_at: iso(start), p_version: await appointmentVersion(id) }));
    await refresh('appointments', 'activities');
    return { ok: true as const };
  } catch (e) {
    const err = toApiError(e);
    if (SLOT_CONFLICTS.includes(err.code)) return { ok: false as const, conflictTitle: CONFLICT_LABEL[err.code] ?? 'another appointment' };
    throw err;
  }
}

export interface AppointmentDetail {
  appointment: { id: string; status: string; version: number; booking_reference: string; pending_reason: string | null; calendar_sync_status: string;
    calendar_sync_error: string | null; external_event_id: string | null; timezone: string; confirmed_at: string | null; source: string };
  history: { version: number; action: string; from_status: string | null; to_status: string | null; from_starts_at: string | null; to_starts_at: string | null; reason: string | null; created_at: string }[];
  messages: { id: string; purpose: string; status: string; status_reason: string | null; channel: string; appointment_version: number; scheduled_for: string | null; sent_at: string | null; sent_via: string | null }[];
  assignee_name: string | null; calendar_provider: string | null; can_edit: boolean;
}

export async function appointmentDetail(id: string) {
  return check(await sb().rpc('appointment_detail', { p_appt: id })) as AppointmentDetail;
}

/** Appointment counts for the AI agents page (next 14 days and last 7). */
export async function appointmentAgentOverview() {
  const { orgId } = ctx();
  const from = new Date(Date.now() - 7 * 864e5).toISOString();
  const to = new Date(Date.now() + 14 * 864e5).toISOString();
  const rows = check(await sb().from('appointments').select('status, starts_at, calendar_sync_status, source, pending_reason').eq('organization_id', orgId)
    .gte('starts_at', from).lt('starts_at', to).limit(2000)) as { status: string; starts_at: string; calendar_sync_status: string; source: string; pending_reason: string | null }[];
  const now = Date.now();
  const upcoming = rows.filter((r) => new Date(r.starts_at).getTime() >= now);
  return {
    upcomingConfirmed: upcoming.filter((r) => r.status === 'confirmed').length,
    awaiting: upcoming.filter((r) => ['requested', 'pending', 'reschedule_requested'].includes(r.status)).length,
    syncFailed: rows.filter((r) => r.calendar_sync_status === 'failed').length,
    cancelled7d: rows.filter((r) => r.status === 'cancelled' && new Date(r.starts_at).getTime() < now).length,
    completed7d: rows.filter((r) => r.status === 'completed').length,
  };
}

/* ─────────────────────────── Agent 07: CRM data quality ─────────────────────────── */

export type DqSeverity = 'info' | 'warning' | 'high' | 'critical';
export type DqStatus = 'open' | 'under_review' | 'proposed' | 'resolved' | 'dismissed' | 'reopened';
export type DqEntity = 'contact' | 'lead' | 'property' | 'appointment' | 'integration' | 'organization';
export interface DqIssue {
  id: string; entity_type: DqEntity; entity_id: string; entity_label: string | null; rule_id: string; origin: 'rule' | 'provenance' | 'ai_extraction' | 'anomaly';
  dimension: string; severity: DqSeverity; status: DqStatus; message: string; evidence: Record<string, unknown>; recommended_action: string | null;
  proposed_fix: { field: string; value: unknown } | null; detection_count: number; first_detected_at: string; last_detected_at: string;
  assigned_to: string | null; assignee_name: string | null; resolution: string | null; resolution_note: string | null; resolved_at: string | null;
}
export interface DqOverview {
  generated_at: string;
  records: { contacts: number; leads: number; properties: number; appointments_active: number };
  issues: { open: number; critical: number; high: number; warning: number; info: number; records_affected: number; incomplete_records: number; invalid_records: number;
    stale_records: number; sync_problems: number; proposed_corrections: number; by_entity: Record<string, number> };
  resolved_since: number; since: string; merges_since: number;
  duplicates: { open: number; awaiting_review: number; strong: number; possible: number; weak: number };
  score: { version: string; average: number | null; records: number; note: string };
  last_scan: { id: string; kind: string; status: string; requested_at: string; completed_at: string | null; counts: Record<string, number>; cursor: { entity: string } } | null;
  queue: { pending: number; failing: number; oldest: string | null };
  baseline: { evaluated: boolean; baseline_days: number; reason?: string; detected?: string[] } | null;
  integrations: { connected: number; failing: number; total: number };
  can: { merge: boolean; scan: boolean; settings: boolean };
}
export interface DqCandidate {
  id: string; entity_type: 'contact' | 'lead' | 'property'; record_a: string; record_b: string; label_a: string | null; label_b: string | null; score: number;
  strength: 'strong' | 'possible' | 'weak'; signals: { signal: string; weight: number }[]; conflicts: { signal: string; weight: number }[]; explanation: string;
  proposed_canonical: string; state_hash: string; status: 'open' | 'merged' | 'rejected' | 'stale'; last_detected_at: string; merge_id: string | null; review_note: string | null;
}
export interface DqCandidateDetail {
  candidate: DqCandidate;
  records: { id: string; fields: Record<string, string | number | null>; related: Record<string, number>; consents?: Record<string, string>; merged_into?: string | null; archived?: boolean }[];
  current_state_hash: string; can_merge: boolean; revertible: boolean;
  merge: { id: string; status: string; merged_at: string; conflicts: string[]; consent_changes: Record<string, string>[]; moved: Record<string, string[]> } | null;
}
export interface DqRecordQuality {
  score: number; score_version: string; evaluated: boolean; issues: DqIssue[]; can_edit: boolean;
  provenance: { field: string; source_type: string | null; source_label: string | null; captured_at: string | null; verification_status: 'verified' | 'unverified';
    verified_at: string | null; previous_source_type: string | null; change_count: number | null; recorded: boolean }[];
  duplicates: { id: string; strength: string; score: number; explanation: string; other_id: string; other_label: string | null }[];
  merges: { id: string; status: string; role: 'canonical' | 'merged'; merged_at: string; other_label: string | null }[];
}
export interface DqMerge { id: string; entity_type: string; canonical_id: string; merged_id: string; status: 'completed' | 'reverted'; revertible: boolean; merged_at: string; conflicts: string[] }

/* ─────────────────────────── pilot operations ─────────────────────────── */

export type PilotAgentId = 'voice_calling_agent' | 'sales_qualification_agent' | 'property_matching_agent' | 'follow_up_agent' | 'appointment_agent' | 'crm_data_agent' | 'sales_intelligence_agent';
export interface PilotAgentStats { runs: number; succeeded: number; review_required: number; invalid: number; dead_letter: number; waiting: number; held: number; retried: number; p50_seconds: number | null; p95_seconds: number | null; last_succeeded_at: string | null }
export interface PilotOverview {
  organization: { id: string; name: string; timezone: string; outbound_paused: boolean };
  period: { from: string; to: string }; computed_at: string;
  controls: { agent_id: PilotAgentId; paused: boolean; reason: string | null; changed_at: string | null }[];
  settings: { voice_enabled: boolean; follow_up_enabled: boolean; intake_extraction_enabled: boolean; qualification_llm_enabled: boolean };
  intake: { leads_created: number; webhooks_processed: number; webhooks_rejected: number; by_source_kind: Record<string, number>; open_duplicate_reviews: number };
  agents: Record<string, PilotAgentStats>;
  events: { pending: number; oldest_pending_seconds: number | null; dead_letter: number };
  qualification: { results: number; by_status: Record<string, number>; review_pending: number; approved: number; corrected: number; ai_succeeded: number; ai_failed: number; ai_not_configured: number };
  matching: { recommendations: number; accepted: number; rejected_by_staff: number; invalidated: number; unverified_listing: number; runs_without_matches: number };
  follow_ups: { created: number; pending_approval: number; approved: number; sent: number; delivered: number; failed: number; suppressed: number; handed_off: number; edited_by_staff: number; ai_drafted: number };
  appointments: { created: number; confirmed: number; by_status: Record<string, number> };
  data_quality: { open_issues: Record<string, number>; duplicates_open: number; duplicates_merged: number; duplicates_rejected: number };
  voice: { calls: number; by_status: Record<string, number> };
  ai_requests: Record<string, { requests: number; ok: number; failed: number; p50_ms: number | null }>;
  review_backlog: { intake_duplicates: number; qualifications: number; follow_ups: number; duplicate_candidates: number; data_quality_proposals: number };
  unavailable: { metric: string; reason: string }[];
}

export async function pilotOverview(days: number) {
  const to = new Date();
  const from = new Date(to.getTime() - days * 864e5);
  return check(await sb().rpc('pilot_overview', { p_org: ctx().orgId, p_from: from.toISOString(), p_to: to.toISOString() })) as PilotOverview;
}

/** Pause or resume one agent for this workspace (owners and admins; enforced on the server). */
export async function setAgentPaused(agent: PilotAgentId, paused: boolean, reason: string) {
  const r = check(await sb().rpc('agent_control_set', { p_org: ctx().orgId, p_agent: agent, p_paused: paused, p_reason: reason })) as { agent_id: string; paused: boolean; held_runs?: number; released_runs?: number };
  useLiveRev.getState().bump();
  return r;
}

export async function dataQualityOverview() {
  return check(await sb().rpc('crm_data_quality_overview', { p_org: ctx().orgId, p_since: null })) as DqOverview;
}

export async function dataQualityIssues(p: { status?: DqStatus[]; severity?: DqSeverity[]; entity?: DqEntity | null; rule?: string | null; entityId?: string | null; page: number; pageSize: number }) {
  return check(await sb().rpc('dq_issues', { p_org: ctx().orgId, p_status: p.status?.length ? p.status : null, p_severity: p.severity?.length ? p.severity : null,
    p_entity: p.entity ?? null, p_rule: p.rule ?? null, p_assigned: null, p_since: null, p_entity_id: p.entityId ?? null, p_page: p.page, p_page_size: p.pageSize })) as
    { total: number; items: DqIssue[] };
}

export async function dataQualityIssueAction(id: string, action: 'start_review' | 'dismiss' | 'reopen' | 'resolve', note?: string) {
  check(await sb().rpc('dq_issue_action', { p_issue: id, p_action: action, p_note: note ?? null, p_assignee: null }));
  useLiveRev.getState().bump();
}

export async function dataQualityApplyFix(id: string) {
  check(await sb().rpc('dq_issue_apply_fix', { p_issue: id }));
  await refresh('leads', 'properties');
  useLiveRev.getState().bump();
}

export async function duplicateCandidates(p: { status: DqCandidate['status']; entity?: DqCandidate['entity_type'] | null; strength?: DqCandidate['strength'][]; page: number; pageSize: number }) {
  return check(await sb().rpc('dq_duplicates', { p_org: ctx().orgId, p_status: p.status, p_entity: p.entity ?? null, p_strength: p.strength?.length ? p.strength : null,
    p_page: p.page, p_page_size: p.pageSize })) as { total: number; items: DqCandidate[] };
}

export async function duplicateCandidateDetail(id: string) {
  return check(await sb().rpc('duplicate_candidate_detail', { p_candidate: id })) as DqCandidateDetail;
}

export async function decideDuplicate(c: DqCandidate, decision: 'merge' | 'reject', canonical: string | null, note?: string) {
  const r = check(await sb().rpc('duplicate_decide', { p_candidate: c.id, p_decision: decision, p_canonical: canonical, p_state_hash: c.state_hash,
    p_idempotency_key: `ui:dup:${c.id}:${decision}:${c.state_hash.slice(0, 12)}`, p_note: note ?? null })) as { status: string; merge_id?: string };
  if (decision === 'merge') await refresh('leads', 'properties');
  useLiveRev.getState().bump();
  return r;
}

export async function recentMerges() {
  return check(await sb().from('record_merges').select('id, entity_type, canonical_id, merged_id, status, revertible, merged_at, conflicts')
    .eq('organization_id', ctx().orgId).order('merged_at', { ascending: false }).limit(50)) as DqMerge[];
}

export async function revertMerge(id: string, note: string) {
  check(await sb().rpc('record_merge_revert', { p_merge: id, p_note: note }));
  await refresh('leads', 'properties');
  useLiveRev.getState().bump();
}

export async function recordQuality(entityType: 'contact' | 'lead' | 'property', id: string) {
  return check(await sb().rpc('crm_record_quality', { p_entity_type: entityType, p_entity_id: id })) as DqRecordQuality;
}

export async function verifyField(entityType: 'contact' | 'lead' | 'property', id: string, field: string, verified: boolean) {
  check(await sb().rpc('dq_verify_field', { p_entity_type: entityType, p_entity_id: id, p_field: field, p_verified: verified }));
  useLiveRev.getState().bump();
}

export async function requestDataQualityScan() {
  const r = check(await sb().rpc('data_quality_scan_request', { p_org: ctx().orgId, p_idempotency_key: `ui:scan:${Date.now()}` })) as { scan_id: string; status: string; already_running?: boolean };
  useLiveRev.getState().bump();
  return r;
}

export async function cancelDataQualityScan(id: string) {
  check(await sb().rpc('data_quality_scan_cancel', { p_scan: id }));
  useLiveRev.getState().bump();
}

/** Ask Claude for facts stated in the lead's notes; results become proposals a person applies (503 when no key is configured). */
export async function proposeEnrichment(leadId: string): Promise<{ status: string; proposed?: number; skipped?: number; rejected?: { reason: string }[] }> {
  const { data, error } = await sb().functions.invoke('crm-enrichment', { body: { lead_id: leadId } });
  if (error) {
    // 503 not_configured, 502 timeout / model_error, 422 invalid_output: reported as they are.
    const body = (await (error as { context?: Response }).context?.json().catch(() => null)) as { status?: string } | null;
    return { status: body?.status ?? 'error' };
  }
  useLiveRev.getState().bump();
  return data;
}

/* ─────────────────────────── Agent 08: sales intelligence ─────────────────────────── */

export type SiPreset = 'last_7_days' | 'last_30_days' | 'last_90_days' | 'this_month' | 'last_month' | 'this_quarter' | 'last_quarter' | 'this_year';
export interface SiFilters { source?: string; assignee?: string; property_type?: string; transaction?: string; lead_status?: string }
export interface SiRow { key: string; label?: string; currency?: string; value?: number; numerator?: number; denominator?: number; previous_value?: number; change?: number; change_pct?: number; low_sample?: boolean }
export interface SiResult {
  metric: string; label: string; unit: 'count' | 'rate' | 'minutes' | 'days' | 'money'; basis?: 'cohort' | 'period' | 'snapshot'; definition?: string; group_by?: string | null;
  available?: boolean; reason?: string; restricted?: boolean; rows: SiRow[]; caveats?: { code: string; text: string }[];
  period?: { from?: string; to?: string; as_of?: string; timezone?: string }; previous_period?: { from: string; to: string } | null; computed_at?: string;
}
export interface SiOverview {
  period: { from: string; to: string; timezone: string; preset: string }; previous_period: { from: string; to: string }; kpis: Record<string, SiResult>;
  targets: Record<string, number>; caveats: { code: string; text: string }[]; can: { finance: boolean; team: boolean; settings: boolean };
  unavailable: Record<string, string | null>; computed_at: string;
}
export interface SiFunnelStage { stage: string; label: string; leads: number; share_of_cohort: number | null; step_conversion?: number; step_base?: number; drop_off?: number; median_days_from_capture: number | null; low_sample: boolean }
export interface SiFunnel { cohort: { from: string; to: string; leads: number; immature: number; maturity_days: number; mature_only: boolean }; stages: SiFunnelStage[]; definition: string; caveats: { text: string }[]; computed_at: string }
export interface SiInsight {
  id: string; kind: 'anomaly' | 'finding' | 'recommendation'; rule_id: string | null; category: string; priority: 'low' | 'medium' | 'high';
  status: 'new' | 'reviewed' | 'accepted' | 'dismissed' | 'in_progress' | 'completed' | 'expired'; title: string; summary: string; observation: string | null;
  interpretation: string | null; recommended_action: string | null; expected_direction: string | null; evidence: Record<string, unknown>;
  supporting_metrics: { metric: string; value: number }[]; limitations: string[]; observation_from: string | null; observation_to: string | null;
  generated_by: 'rules' | 'ai'; model: string | null; feedback_note: string | null; last_detected_at: string; created_at: string;
}
export interface SiForecast {
  id: string; status: 'queued' | 'completed' | 'insufficient_data' | 'failed'; horizon_start: string; horizon_end: string; method: string | null;
  results: Record<string, { status: string; method: string | null; forecast_value: number | null; commission_forecast: number | null; scenario_low_committed: number;
    scenario_high_all_open: number; open_deals_in_window: number; open_deals_without_close_date: number; open_deals_overdue: number; historical_win_rate: number | null;
    closed_deals_in_history: number; min_closed_deals: number }>;
  assumptions: string[]; caveats: (string | Record<string, unknown>)[]; computed_at: string | null; actuals: Record<string, number> | null; abs_error: Record<string, number> | null; created_at: string;
}
export interface SiReport { id: string; kind: string; status: 'queued' | 'completed' | 'failed'; period_from: string; period_to: string; includes_financials: boolean; created_at: string; completed_at: string | null; error: string | null }

const siSpec = (preset: SiPreset, filters: SiFilters) => ({ p_org: ctx().orgId, p_preset: preset, p_from: null, p_to: null, p_filters: filters });

export async function siOverview(preset: SiPreset, filters: SiFilters) {
  return check(await sb().rpc('si_overview', siSpec(preset, filters))) as SiOverview;
}

export async function siFunnel(preset: SiPreset, filters: SiFilters, matureOnly: boolean) {
  return check(await sb().rpc('si_funnel', { ...siSpec(preset, filters), p_mature_only: matureOnly })) as SiFunnel;
}

export async function siBreakdown(dim: string, metrics: string[], preset: SiPreset, filters: SiFilters) {
  return check(await sb().rpc('si_breakdown', { p_org: ctx().orgId, p_dim: dim, p_metrics: metrics, p_preset: preset, p_from: null, p_to: null, p_filters: filters })) as
    { dimension: string; metrics: Record<string, SiResult>; notes: string[]; computed_at: string };
}

export async function siQuery(spec: Record<string, unknown>) {
  return check(await sb().rpc('si_query', { p_org: ctx().orgId, p_spec: spec, p_log: false })) as SiResult;
}

export async function siCatalogue() {
  return check(await sb().rpc('si_metric_catalogue')) as Record<string, { label: string; unit: string; basis: string; perm: string; definition: string; dims: string[] }>;
}

export async function siInsights(statuses: SiInsight['status'][]) {
  return check(await sb().from('sales_insights').select('*').eq('organization_id', ctx().orgId).in('status', statuses)
    .order('last_detected_at', { ascending: false }).limit(100)) as SiInsight[];
}

export async function siInsightFeedback(id: string, status: SiInsight['status'], note?: string) {
  check(await sb().rpc('si_insight_feedback', { p_insight: id, p_status: status, p_note: note ?? null }));
  useLiveRev.getState().bump();
}

export async function siEvaluateNow() {
  const r = check(await sb().rpc('si_evaluate_now', { p_org: ctx().orgId })) as { detected: string[] };
  useLiveRev.getState().bump();
  return r;
}

/** Claude recommendations from a stored snapshot. Statuses are reported as they are (503 not_configured without a key). */
export async function siGenerateRecommendations(): Promise<{ status: string; saved?: number; rejected?: { title: string; reason: string }[]; message?: string }> {
  const { data, error } = await sb().functions.invoke('sales-intelligence-recommend', { body: { org_id: ctx().orgId } });
  if (error) {
    const body = (await (error as { context?: Response }).context?.json().catch(() => null)) as { status?: string; message?: string } | null;
    return { status: body?.status ?? 'error', message: body?.message };
  }
  useLiveRev.getState().bump();
  return data;
}

export async function siAsk(question: string, previousSpec: unknown): Promise<{ status: string; answer?: string; spec?: Record<string, unknown>; result?: SiResult; message?: string }> {
  const { data, error } = await sb().functions.invoke('sales-analyst', { body: { org_id: ctx().orgId, question, previous_spec: previousSpec ?? null } });
  if (error) {
    const body = (await (error as { context?: Response }).context?.json().catch(() => null)) as { status?: string; message?: string; error?: string } | null;
    return { status: body?.status ?? 'error', message: body?.message ?? body?.error };
  }
  return data;
}

/** The workspace assistant: plain text turns in, a reply plus any proposed actions out (nothing is changed server-side). */
export async function assistantAsk(turns: { role: 'user' | 'assistant'; text: string }[]): Promise<{ status: string; reply?: string; actions?: unknown[]; message?: string }> {
  const { data, error } = await sb().functions.invoke('assistant', { body: { org_id: ctx().orgId, messages: turns } });
  if (error) {
    const body = (await (error as { context?: Response }).context?.json().catch(() => null)) as { status?: string; message?: string; error?: string } | null;
    return { status: body?.status ?? 'error', message: body?.message ?? body?.error };
  }
  return data;
}

/* ─────────── agent automations and the AI call queue (migration 0029) ─────────── */

export interface AutomationRow {
  id: string; name: string; kind: 'daily_briefing' | 'overdue_follow_ups' | 'call_new_leads' | 'reengage_stale'; enabled: boolean;
  run_at: string; days: number[]; settings: Record<string, unknown>; next_run_at: string | null; last_run_at: string | null; last_result: Record<string, unknown> | null;
}
export interface CallQueueRow { id: string; lead_id: string; reason: string; status: 'pending' | 'approved' | 'declined' | 'expired'; created_at: string; call_id: string | null; lead: { title: string; contact: { display_name: string | null } | null } | null }

export async function automations() {
  return check(await sb().from('agent_automations').select('id, name, kind, enabled, run_at, days, settings, next_run_at, last_run_at, last_result').eq('organization_id', ctx().orgId).order('run_at')) as AutomationRow[];
}

export async function automationSave(input: { id?: string; name: string; kind: AutomationRow['kind']; enabled?: boolean; run_at: string; days: number[]; settings?: Record<string, unknown> }) {
  const r = check(await sb().rpc('automation_save', { p_org: ctx().orgId, p_input: input })) as AutomationRow;
  useLiveRev.getState().bump();
  return r;
}

export async function automationDelete(id: string) {
  checkMaybe(await sb().rpc('automation_delete', { p_id: id }));
  useLiveRev.getState().bump();
}

export async function automationRunNow(id: string) {
  const r = check(await sb().rpc('automation_run_now', { p_id: id })) as Record<string, unknown>;
  useLiveRev.getState().bump();
  return r;
}

export async function callQueue() {
  return check(await sb().from('agent_call_queue').select('id, lead_id, reason, status, created_at, call_id, lead:leads(title, contact:contacts(display_name))')
    .eq('organization_id', ctx().orgId).order('created_at', { ascending: false }).limit(50)) as unknown as CallQueueRow[];
}

/** Approve = place the AI call (the call policy runs again in voice-calls) and record it; decline = no call. */
export async function callQueueDecide(item: CallQueueRow, decision: 'approved' | 'declined'): Promise<{ ok: boolean; reason?: string }> {
  if (decision === 'declined') {
    check(await sb().rpc('call_queue_decide', { p_item: item.id, p_decision: 'declined' }));
    useLiveRev.getState().bump();
    return { ok: true };
  }
  const r = await requestAiCall(item.lead_id, `queue_${item.id.replace(/-/g, '')}`);
  if (!r.call_id || r.status === 'blocked') return { ok: false, reason: r.reason ?? 'The call policy did not allow this call right now.' };
  check(await sb().rpc('call_queue_decide', { p_item: item.id, p_decision: 'approved', p_call: r.call_id }));
  useLiveRev.getState().bump();
  return { ok: true };
}

export async function siForecastRequest(start: string, end: string) {
  const r = check(await sb().rpc('si_forecast_request', { p_org: ctx().orgId, p_horizon_start: start, p_horizon_end: end, p_idempotency_key: `ui:fc:${Date.now()}` })) as { forecast_id: string; status: string };
  useLiveRev.getState().bump();
  return r;
}

export async function siForecasts() {
  return check(await sb().from('sales_forecast_runs').select('*').eq('organization_id', ctx().orgId).order('created_at', { ascending: false }).limit(20)) as SiForecast[];
}

export async function siReportRequest(kind: string, preset: SiPreset, filters: SiFilters) {
  const r = check(await sb().rpc('si_report_request', { p_org: ctx().orgId, p_kind: kind, p_preset: preset, p_from: null, p_to: null, p_filters: filters,
    p_idempotency_key: `ui:rep:${Date.now()}` })) as { report_id: string; status: string };
  useLiveRev.getState().bump();
  return r;
}

export async function siReports() {
  return check(await sb().from('sales_report_runs').select('id, kind, status, period_from, period_to, includes_financials, created_at, completed_at, error')
    .eq('organization_id', ctx().orgId).order('created_at', { ascending: false }).limit(50)) as SiReport[];
}

export async function siReportResult(id: string) {
  return (check(await sb().from('sales_report_runs').select('result').eq('id', id).single()) as { result: Record<string, unknown> | null }).result;
}

export async function saveTask(t: Partial<Task> & { title: string }) {
  const { orgId } = ctx();
  const row: Record<string, unknown> = {
    title: t.title, priority: t.priority ?? 'normal', due_at: iso(t.dueAt ?? Date.now() + 864e5), assigned_to: t.assignedTo ?? null,
  };
  if (t.status) row.status = t.status;
  let saved: Record<string, unknown>;
  if (t.id) saved = check(await sb().from('tasks').update(row).eq('id', t.id).select('*').single());
  else {
    const rel = t.related;
    saved = check(await sb().from('tasks').insert({
      ...row, organization_id: orgId,
      related_lead_id: rel?.type === 'lead' ? rel.id : null, related_deal_id: rel?.type === 'deal' ? rel.id : null, related_property_id: rel?.type === 'property' ? rel.id : null,
    }).select('*').single());
  }
  await refresh('tasks', 'activities');
  return toTask(saved);
}

export async function setTaskStatus(id: string, status: Task['status']) {
  check(await sb().from('tasks').update({ status }).eq('id', id).select('id').single());
  await refresh('tasks', 'activities');
}

export async function inviteMember(email: string, role: Role) {
  const { orgId } = ctx();
  const r = check(await sb().rpc('invite_member', { p_org: orgId, p_email: email, p_role: role })) as { token: string };
  await refresh('members');
  return `${location.origin}${location.pathname}#/invite?token=${r.token}`;
}

export async function changeRole(memberId: string, role: Role) {
  const { orgId } = ctx();
  const rows = check(await sb().from('organization_memberships').update({ role }).eq('organization_id', orgId).eq('user_id', memberId).select('id'));
  if (!rows.length) throw new ApiError('FORBIDDEN', 'You can’t change this member’s role.');
  await refresh('members');
}

export async function setMemberStatus(memberId: string, status: 'active' | 'suspended') {
  const { orgId } = ctx();
  if (memberId.startsWith('inv:')) {
    checkMaybe(await sb().rpc('revoke_invitation', { p_invitation: memberId.slice(4) }));
  } else {
    const rows = check(await sb().from('organization_memberships').update({ status }).eq('organization_id', orgId).eq('user_id', memberId).select('id'));
    if (!rows.length) throw new ApiError('FORBIDDEN', 'You can’t change this member.');
  }
  await refresh('members');
}

export async function updateOrg(org: Organization, patch: Partial<Organization>) {
  const next = { ...org, ...patch };
  const row: Record<string, unknown> = { settings: orgSettingsToJson(next) };
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.timezone !== undefined) row.timezone = patch.timezone;
  if (patch.city !== undefined) row.city = patch.city;
  if (patch.currency !== undefined) row.default_currency = patch.currency;
  if (patch.country !== undefined) row.country_code = patch.country;
  const saved = checkMaybe(await sb().from('organizations').update(row).eq('id', org.id).select('*').maybeSingle());
  if (!saved) throw new ApiError('FORBIDDEN', 'You can’t change organization settings.');
  const o = toOrganization(saved);
  useStore.setState((s) => ({ orgs: s.orgs.map((x) => (x.id === o.id ? o : x)) }));
}

export async function markNotification(id: string) {
  check(await sb().from('notifications').update({ read_at: new Date().toISOString() }).eq('id', id).select('id'));
  useStore.setState((s) => ({ notifications: s.notifications.map((n) => (n.id === id ? { ...n, read: true } : n)) }));
}

export async function markAllNotifications() {
  checkMaybe(await sb().rpc('mark_all_notifications_read', { p_org: ctx().orgId }));
  useStore.setState((s) => ({ notifications: s.notifications.map((n) => ({ ...n, read: true })) }));
}

export async function advanceCommission(id: string, to: string) {
  const rows = check(await sb().from('commissions').update({ status: to }).eq('id', id).select('id'));
  if (!rows.length) throw new ApiError('FORBIDDEN', 'Only finance can change commission status.');
  await refresh('commissions');
}

/* ─────────────────────────── documents (Storage) ─────────────────────────── */

const ALLOWED_MIME = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
const MAX_BYTES = 20 * 1024 * 1024;

/** Checks the file's leading bytes, not just its extension or browser-reported type. */
export async function sniffMime(file: File): Promise<string | null> {
  const b = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const starts = (...sig: number[]) => sig.every((v, i) => b[i] === v);
  if (starts(0x25, 0x50, 0x44, 0x46)) return 'application/pdf';
  if (starts(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (starts(0x50, 0x4b, 0x03, 0x04) && file.name.toLowerCase().endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  return null;
}

export async function uploadDocument(
  file: File,
  meta: { kind: string; classification: string; related: { type: 'property' | 'deal' | 'contact'; id: string } | null; expiresAt: number | null },
) {
  const { orgId, userId } = ctx();
  const mime = await sniffMime(file);
  if (!mime || !ALLOWED_MIME.includes(mime)) throw new ApiError('VALIDATION_ERROR', `${file.name}: only PDF, DOCX, PNG, JPG or WEBP files are allowed.`);
  if (file.size > MAX_BYTES || file.size === 0) throw new ApiError('VALIDATION_ERROR', `${file.name}: files must be between 1 byte and 20 MB.`);
  const id = crypto.randomUUID();
  const safeName = file.name.replace(/[^\w.-]+/g, '_').slice(-120) || 'file';
  const path = `${orgId}/${id}/${safeName}`;
  // Metadata first: storage policies only accept objects that have an authorized row.
  checkMaybe(await sb().from('documents').insert({
    id, organization_id: orgId, name: file.name.slice(0, 200), document_type: meta.kind, storage_path: path, mime_type: mime, file_size_bytes: file.size,
    uploaded_by: userId, classification: meta.classification, expires_at: meta.expiresAt ? iso(meta.expiresAt) : null,
    related_property_id: meta.related?.type === 'property' ? meta.related.id : null,
    related_deal_id: meta.related?.type === 'deal' ? meta.related.id : null,
    related_contact_id: meta.related?.type === 'contact' ? meta.related.id : null,
  }));
  const up = await sb().storage.from('documents').upload(path, file, { contentType: mime, upsert: false });
  if (up.error) {
    await sb().from('documents').update({ status: 'failed' }).eq('id', id);
    throw new ApiError('UNKNOWN', `${file.name}: upload failed. Please retry.`);
  }
  check(await sb().from('documents').update({ status: 'ready' }).eq('id', id).select('id'));
}

export async function documentLink(id: string) {
  const row = check(await sb().from('documents').select('storage_path').eq('id', id).single());
  const r = await sb().storage.from('documents').createSignedUrl(row.storage_path as string, 300);
  if (r.error || !r.data) throw new ApiError('FORBIDDEN', 'You can’t open this document.');
  return r.data.signedUrl;
}

export async function updateDocument(id: string, patch: { classification?: string; status?: string }) {
  check(await sb().from('documents').update(patch).eq('id', id).select('id'));
  await refresh('documents');
}

export async function recordExport(entity: 'leads' | 'audit_logs', rows: number) {
  checkMaybe(await sb().rpc('record_export', { p_org: ctx().orgId, p_entity: entity, p_rows: rows }));
}

/* ─────────────────────────── integrations ─────────────────────────── */

export async function rotateWebhookSecret() {
  const secret = check(await sb().rpc('rotate_webhook_secret', { p_org: ctx().orgId })) as string;
  const { orgId } = ctx();
  await loadOrganizations(useStore.getState().orgs.map((o) => o.id).concat(orgId).filter((v, i, a) => a.indexOf(v) === i));
  return secret;
}

export function intakeEndpoint(slug: string) {
  return `${functionsUrl('lead-intake')}?org=${encodeURIComponent(slug)}`;
}
