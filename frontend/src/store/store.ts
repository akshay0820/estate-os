import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { DAY, HOUR, MIN, money } from '@/lib/format';
import {
  extractRequirements,
  findConflict,
  findDuplicates,
  isOptOut,
  missingFields,
  nextFreeSlots,
  outboundPolicy,
  scoreLead,
  type PolicyResult,
} from '@/lib/domain';
import { IMPORT_MAX_ROWS, mapHeaders, mapLeadRow, type ImportResult } from '@/lib/leadImport';
import { correlationId, downloadCsv, normalizeEmail, normalizePhone, sleep, uid } from '@/lib/util';
import { catalogEntry } from '@/lib/integrationCatalog';
import { generateAll, type OrgData } from './seed';
import { toast } from './ui';
import { backendConfigured } from '@/backend/client';

/** Live mode: data comes from Supabase and is never persisted to localStorage. */
export const LIVE = backendConfigured;
import type {
  Activity,
  Actor,
  Agent,
  Appointment,
  AppointmentStatus,
  Approval,
  Call,
  Channel,
  Commission,
  ConsentState,
  Contact,
  Conversation,
  Deal,
  DealStage,
  DocumentRec,
  Expense,
  FollowUp,
  ID,
  Integration,
  Lead,
  LeadStatus,
  Member,
  Message,
  Notification,
  Organization,
  Property,
  Role,
  Run,
  RunStep,
  Task,
  WebhookEvent,
} from './types';

export interface Session {
  orgId: ID;
  /** Live mode: the verified Supabase user id. Demo mode: null. */
  userId?: ID | null;
  /** "View as" role for demonstrating permission-aware UI. Null = membership role. */
  roleOverride: Role | null;
  seededAt: number;
}

export interface NewLeadInput {
  name: string;
  phone: string;
  email: string;
  source: string;
  campaign?: string;
  type: Lead['type'];
  intent?: Lead['intent'];
  budgetMax?: number | null;
  locations?: string[];
  propertyType?: Lead['propertyType'];
  bedrooms?: number | null;
  timeline?: string | null;
  notes?: string;
  assignedTo?: ID | null;
  existingContactId?: ID | null;
}

type State = OrgData & { orgs: Organization[]; session: Session };

interface Actions {
  // session
  switchOrg: (orgId: ID) => void;
  setRoleOverride: (role: Role | null) => void;
  resetDemo: () => void;
  // helpers
  me: () => Member;
  org: () => Organization;
  log: (action: string, entity: string, entityId: ID | null, meta?: string | null, actor?: Actor) => void;
  activity: (a: Omit<Activity, 'id' | 'orgId' | 'at'> & { at?: number }) => void;
  notify: (n: Omit<Notification, 'id' | 'orgId' | 'at' | 'read'>) => void;
  // leads
  createLead: (input: NewLeadInput, actor?: Actor) => Lead;
  updateLead: (id: ID, patch: Partial<Lead>, actor?: Actor) => void;
  setLeadStatus: (id: ID, status: LeadStatus, reason?: string) => void;
  assignLeads: (ids: ID[], memberId: ID | null) => void;
  archiveLeads: (ids: ID[], archived?: boolean) => void;
  mergeLeads: (keepId: ID, dropId: ID) => void;
  importLeads: (rows: Record<string, string>[]) => ImportResult;
  addNote: (leadId: ID, body: string) => void;
  // contacts
  updateContact: (id: ID, patch: Partial<Contact>) => void;
  setConsent: (contactId: ID, channel: Channel, state: ConsentState, source?: string) => void;
  optOutAll: (contactId: ID) => void;
  // properties
  saveProperty: (p: Partial<Property> & { id?: ID }) => Property;
  verifyProperty: (id: ID) => void;
  // deals
  createDeal: (d: Omit<Deal, 'id' | 'orgId' | 'createdAt' | 'stageChangedAt' | 'lostReason'>) => Deal;
  moveDeal: (id: ID, stage: DealStage, lostReason?: string) => void;
  updateDeal: (id: ID, patch: Partial<Deal>) => void;
  // appointments
  bookAppointment: (a: Omit<Appointment, 'id' | 'orgId' | 'createdAt' | 'cancelReason' | 'feedback'>) =>
    | { ok: true; appointment: Appointment }
    | { ok: false; conflict: Appointment; alternatives: number[] };
  setAppointmentStatus: (id: ID, status: AppointmentStatus, extra?: { reason?: string; feedback?: string }) => void;
  rescheduleAppointment: (id: ID, start: number, end: number) => { ok: boolean; conflict?: Appointment };
  // tasks
  saveTask: (t: Partial<Task> & { title: string }) => Task;
  setTaskStatus: (id: ID, status: Task['status']) => void;
  // inbox
  sendMessage: (convId: ID, body: string, opts?: { internal?: boolean }) => PolicyResult | null;
  receiveMessage: (convId: ID, body: string) => void;
  takeOver: (convId: ID) => void;
  resumeAi: (convId: ID) => void;
  setConversationStatus: (convId: ID, status: Conversation['status']) => void;
  markConversationRead: (convId: ID) => void;
  startConversation: (contactId: ID, channel: Channel) => ID;
  // calls
  placeCall: (leadId: ID, opts?: { byAi?: boolean }) => PolicyResult;
  // agents & workflows
  setAgentStatus: (id: ID, status: Agent['status']) => void;
  updateAgent: (id: ID, patch: Partial<Agent>) => void;
  setOutboundPaused: (paused: boolean) => void;
  setWorkflowStatus: (id: ID, status: 'active' | 'paused') => void;
  runWorkflow: (id: ID, opts?: { leadId?: ID | null; test?: boolean }) => Promise<Run | null>;
  retryRun: (runId: ID) => void;
  testAgent: (id: ID) => Promise<void>;
  setFollowUpStatus: (id: ID, status: FollowUp['status'], reason?: string) => void;
  // approvals
  decideApproval: (id: ID, approve: boolean, note?: string) => void;
  // integrations
  setIntegrationStatus: (id: ID, status: Integration['status']) => void;
  connectIntegration: (catalogId: string) => void;
  testIntegration: (id: ID) => Promise<boolean>;
  rotateWebhookSecret: () => string;
  simulateInboundLead: (opts?: { duplicate?: boolean; badSignature?: boolean; source?: string }) => Promise<void>;
  replayEvent: (id: ID) => void;
  // team
  inviteMember: (email: string, role: Role, name?: string) => { ok: boolean; error?: string };
  changeRole: (id: ID, role: Role) => { ok: boolean; error?: string };
  setMemberStatus: (id: ID, status: Member['status']) => { ok: boolean; error?: string };
  // finance
  advanceCommission: (id: ID, to: Commission['status']) => void;
  addExpense: (e: Omit<Expense, 'id' | 'orgId'>) => void;
  setExpenseStatus: (id: ID, status: Expense['status']) => void;
  // documents
  addDocuments: (docs: Omit<DocumentRec, 'id' | 'orgId' | 'uploadedAt' | 'uploadedBy' | 'status'>[]) => void;
  removeDocument: (id: ID) => void;
  updateDocument: (id: ID, patch: Partial<DocumentRec>) => void;
  // notifications
  markNotification: (id: ID) => void;
  markAllNotifications: () => void;
  // settings
  updateOrg: (patch: Partial<Organization>) => void;
  updateSource: (id: ID, patch: { monthlySpend?: number; active?: boolean }) => void;
}

export type Store = State & Actions;

const ME_EMAIL = 'jordan@skylinerealty.com';

function empty(): State {
  const keys: (keyof OrgData)[] = ['members', 'contacts', 'leads', 'properties', 'deals', 'appointments', 'tasks', 'conversations', 'calls', 'agents', 'workflows', 'runs', 'approvals', 'followUps', 'integrations', 'webhookEvents', 'usage', 'commissions', 'expenses', 'documents', 'audit', 'activities', 'notifications', 'sources'];
  return { ...(Object.fromEntries(keys.map((k) => [k, []])) as unknown as OrgData), orgs: [], session: { orgId: '', userId: null, roleOverride: null, seededAt: Date.now() } };
}

function fresh(): State {
  if (LIVE) return empty();
  const now = Date.now();
  const data = generateAll(now);
  return { ...data, session: { orgId: 'org_skyline', roleOverride: null, seededAt: now } };
}

const mapIn = <T extends { id: ID }>(list: T[], id: ID, fn: (x: T) => T): T[] => list.map((x) => (x.id === id ? fn(x) : x));

export const useStore = create<Store>()(
  persist(
    (set, get) => {
      const orgId = () => get().session.orgId;
      const myActor = (): Actor => ({ type: 'user', name: get().me().name, id: get().me().id });

      /** Simulated worker step: updates a run in place. */
      const patchRun = (runId: ID, fn: (r: Run) => Run) => set((s) => ({ runs: mapIn(s.runs, runId, fn) }));

      const pushMessage = (convId: ID, m: Omit<Message, 'id'>) =>
        set((s) => ({
          conversations: mapIn(s.conversations, convId, (c) => ({
            ...c,
            messages: [...c.messages, { ...m, id: uid('msg') }],
            lastMessageAt: m.at,
            unread: m.direction === 'in' ? c.unread + 1 : c.unread,
          })),
        }));

      const cancelFollowUpsFor = (contactId: ID, reason: string) => {
        const leadIds = get().leads.filter((l) => l.contactId === contactId).map((l) => l.id);
        let cancelled = 0;
        set((s) => ({
          followUps: s.followUps.map((f) => {
            if (!leadIds.includes(f.leadId) || f.status !== 'active') return f;
            cancelled++;
            return { ...f, status: 'stopped', stopReason: reason, steps: f.steps.map((st) => (st.status === 'scheduled' ? { ...st, status: 'cancelled' } : st)) };
          }),
        }));
        return cancelled;
      };

      return {
        ...fresh(),

        /* ─────────── session ─────────── */
        switchOrg: (id) => {
          set((s) => ({ session: { ...s.session, orgId: id, roleOverride: null } }));
          get().log('session.organization_switched', 'organization', id);
        },
        setRoleOverride: (role) => set((s) => ({ session: { ...s.session, roleOverride: role } })),
        resetDemo: () => set(fresh()),

        me: () => {
          const s = get();
          if (LIVE) return s.members.find((x) => x.id === s.session.userId && x.orgId === s.session.orgId)!;
          const m = s.members.find((x) => x.orgId === s.session.orgId && x.email === ME_EMAIL) ?? s.members.find((x) => x.orgId === s.session.orgId)!;
          return s.session.roleOverride ? { ...m, role: s.session.roleOverride } : m;
        },
        org: () => get().orgs.find((o) => o.id === orgId())!,

        log: (action, entity, entityId, meta = null, actor) =>
          set((s) => ({ audit: [{ id: uid('aud'), orgId: orgId(), actor: actor ?? myActor(), action, entity, entityId, at: Date.now(), meta }, ...s.audit] })),
        activity: (a) => set((s) => ({ activities: [{ ...a, id: uid('act'), orgId: orgId(), at: a.at ?? Date.now() }, ...s.activities] })),
        notify: (n) => set((s) => ({ notifications: [{ ...n, id: uid('ntf'), orgId: orgId(), at: Date.now(), read: false }, ...s.notifications] })),

        /* ─────────── leads ─────────── */
        createLead: (input, actor) => {
          const s = get();
          const now = Date.now();
          const oid = orgId();
          let contactId = input.existingContactId ?? null;
          if (!contactId) {
            contactId = uid('con');
            const contact: Contact = {
              id: contactId, orgId: oid, name: input.name.trim(), email: normalizeEmail(input.email), phone: normalizePhone(input.phone) || input.phone.trim(),
              roles: [input.type], preferredChannel: 'whatsapp', lifecycle: 'new', source: input.source, assignedTo: null,
              consents: { phone: 'granted', whatsapp: 'granted', sms: 'unknown', email: input.email ? 'granted' : 'unknown' },
              tags: [], createdAt: now, lastContactedAt: null,
            };
            set((st) => ({ contacts: [contact, ...st.contacts] }));
          }
          const locations = input.locations ?? [];
          // Assignment rule (org-configured).
          const org = s.org();
          const agents = s.members.filter((m) => m.orgId === oid && m.role === 'agent' && m.status === 'active');
          let assignedTo = input.assignedTo ?? null;
          let rule = 'manual';
          if (input.assignedTo === undefined && agents.length) {
            const load = (mid: ID) => s.leads.filter((l) => l.assignedTo === mid && !['won', 'lost', 'nurture'].includes(l.status) && !l.archived).length;
            const byLoc = org.assignment === 'by_locality' ? agents.find((a) => locations.some((l) => a.localities.includes(l))) : undefined;
            if (byLoc) {
              assignedTo = byLoc.id;
              rule = `locality match (${locations[0]})`;
            } else {
              assignedTo = [...agents].sort((a, b) => load(a.id) - load(b.id))[0].id;
              rule = 'least loaded';
            }
          }
          const intent = input.intent ?? (input.type === 'tenant' ? 'rent' : input.type === 'seller' ? 'sell' : input.type === 'landlord' ? 'let' : input.type === 'investor' ? 'invest' : 'buy');
          const base: Lead = {
            id: uid('lead'), orgId: oid, contactId, name: input.name.trim(), status: 'new', priority: 'normal', type: input.type, source: input.source,
            campaign: input.campaign ?? null, assignedTo, score: 0, scoreReasons: [], budgetMin: input.budgetMax ? Math.round(input.budgetMax * 0.75) : null,
            budgetMax: input.budgetMax ?? null, locations, propertyType: input.propertyType ?? null, bedrooms: input.bedrooms ?? null, timeline: input.timeline ?? null,
            intent, amenities: [], aiFields: [], missing: [], summary: input.notes?.trim() || null, nextFollowUpAt: now + 2 * HOUR, firstResponseAt: null,
            lastContactAt: null, lostReason: null, archived: false, createdAt: now, updatedAt: now,
          };
          const sc = scoreLead(base);
          const lead = { ...base, score: sc.score, scoreReasons: sc.reasons, missing: missingFields(base) };
          set((st) => ({ leads: [lead, ...st.leads] }));
          const who = actor ?? myActor();
          get().activity({ leadId: lead.id, contactId, dealId: null, kind: 'created', title: `Lead created${actor?.type === 'integration' ? ` from ${input.source}` : ' manually'}`, body: input.notes ?? null, actor: who });
          if (assignedTo) {
            const name = s.members.find((m) => m.id === assignedTo)?.name;
            get().activity({ leadId: lead.id, contactId, dealId: null, kind: 'assigned', title: `Assigned to ${name}`, body: `Rule: ${rule}`, actor: { type: 'system', name: 'Assignment rules' } });
          }
          get().log('lead.created', 'lead', lead.id, `source=${input.source}`, who);
          return lead;
        },

        updateLead: (id, patch, actor) => {
          set((s) => ({
            leads: mapIn(s.leads, id, (l) => {
              const next = { ...l, ...patch, updatedAt: Date.now() };
              const sc = scoreLead(next);
              // Fields a person edits are no longer "AI-extracted".
              const aiFields = actor?.type === 'ai_agent' ? next.aiFields : next.aiFields.filter((f) => !(f in patch) && !(f === 'budget' && 'budgetMax' in patch));
              return { ...next, score: sc.score, scoreReasons: sc.reasons, missing: missingFields(next), aiFields };
            }),
          }));
          const keys = Object.keys(patch).filter((k) => k !== 'updatedAt');
          if (keys.length && !keys.every((k) => ['nextFollowUpAt'].includes(k)))
            get().log('lead.fields_updated', 'lead', id, keys.join(', '), actor);
        },

        setLeadStatus: (id, status, reason) => {
          const lead = get().leads.find((l) => l.id === id);
          if (!lead || lead.status === status) return;
          get().updateLead(id, { status, lostReason: status === 'lost' ? reason ?? 'Other' : lead.lostReason, firstResponseAt: lead.firstResponseAt ?? (status !== 'new' ? Date.now() : null) });
          get().activity({ leadId: id, contactId: lead.contactId, dealId: null, kind: 'status', title: `Status → ${status.replace(/_/g, ' ')}`, body: reason ?? null, actor: myActor() });
          get().log('lead.status_changed', 'lead', id, `${lead.status} → ${status}`);
          if (['won', 'lost'].includes(status)) {
            // Terminal: stop sequences for this opportunity.
            set((s) => ({ followUps: s.followUps.map((f) => (f.leadId === id && f.status === 'active' ? { ...f, status: 'stopped', stopReason: `Lead ${status}` } : f)) }));
          }
        },

        assignLeads: (ids, memberId) => {
          const name = get().members.find((m) => m.id === memberId)?.name ?? 'Unassigned';
          set((s) => ({ leads: s.leads.map((l) => (ids.includes(l.id) ? { ...l, assignedTo: memberId, updatedAt: Date.now() } : l)) }));
          ids.forEach((lid) => {
            const l = get().leads.find((x) => x.id === lid)!;
            get().activity({ leadId: lid, contactId: l.contactId, dealId: null, kind: 'assigned', title: `Reassigned to ${name}`, body: null, actor: myActor() });
          });
          get().log('lead.assigned', 'lead', ids.length === 1 ? ids[0] : null, `${ids.length} → ${name}`);
          if (memberId && memberId !== get().me().id)
            get().notify({ kind: 'lead', title: `${ids.length} lead${ids.length > 1 ? 's' : ''} assigned to ${name}`, body: 'Assignment notification sent.', link: 'leads' });
        },

        archiveLeads: (ids, archived = true) => {
          set((s) => ({ leads: s.leads.map((l) => (ids.includes(l.id) ? { ...l, archived, updatedAt: Date.now() } : l)) }));
          get().log(archived ? 'lead.archived' : 'lead.restored', 'lead', ids.length === 1 ? ids[0] : null, `${ids.length} record(s)`);
        },

        mergeLeads: (keepId, dropId) => {
          const s = get();
          const keep = s.leads.find((l) => l.id === keepId)!;
          const drop = s.leads.find((l) => l.id === dropId)!;
          // Preserve history: move activities, calls and appointments to the surviving record.
          set((st) => ({
            leads: st.leads.filter((l) => l.id !== dropId).map((l) =>
              l.id === keepId
                ? { ...l, budgetMax: l.budgetMax ?? drop.budgetMax, locations: [...new Set([...l.locations, ...drop.locations])], timeline: l.timeline ?? drop.timeline, bedrooms: l.bedrooms ?? drop.bedrooms, updatedAt: Date.now() }
                : l,
            ),
            activities: st.activities.map((a) => (a.leadId === dropId ? { ...a, leadId: keepId } : a)),
            calls: st.calls.map((c) => (c.leadId === dropId ? { ...c, leadId: keepId } : c)),
            appointments: st.appointments.map((a) => (a.leadId === dropId ? { ...a, leadId: keepId } : a)),
            tasks: st.tasks.map((t) => (t.related?.id === dropId ? { ...t, related: { type: 'lead', id: keepId } } : t)),
          }));
          get().activity({ leadId: keepId, contactId: keep.contactId, dealId: null, kind: 'note', title: 'Merged duplicate enquiry', body: `${drop.source} enquiry from ${new Date(drop.createdAt).toLocaleDateString('en-US')} merged; history preserved.`, actor: myActor() });
          get().log('lead.merged', 'lead', keepId, `merged ${dropId}`);
        },

        importLeads: (rows) => {
          const result: ImportResult = { created: 0, duplicates: 0, invalid: 0, errors: [] };
          const cols = mapHeaders(Object.keys(rows[0] ?? {}));
          for (const [i, r] of rows.slice(0, IMPORT_MAX_ROWS).entries()) {
            const mapped = mapLeadRow(r, cols);
            if ('error' in mapped) {
              result.invalid++;
              result.errors.push({ row: i + 2, reason: mapped.error });
              continue;
            }
            const { input } = mapped;
            const contacts = get().contacts.filter((c) => c.orgId === orgId());
            if (findDuplicates({ phone: input.phone, email: input.email }, contacts).length) {
              result.duplicates++;
              continue;
            }
            get().createLead(input, { type: 'user', name: `${get().me().name} (import)` });
            result.created++;
          }
          get().log('lead.imported', 'lead', null, `${result.created} created, ${result.duplicates} duplicates skipped, ${result.invalid} invalid`);
          return result;
        },

        addNote: (leadId, body) => {
          const l = get().leads.find((x) => x.id === leadId);
          if (!l) return;
          get().activity({ leadId, contactId: l.contactId, dealId: null, kind: 'note', title: 'Note added', body, actor: myActor() });
        },

        /* ─────────── contacts ─────────── */
        updateContact: (id, patch) => {
          set((s) => ({ contacts: mapIn(s.contacts, id, (c) => ({ ...c, ...patch })) }));
          if (patch.name) set((s) => ({ leads: s.leads.map((l) => (l.contactId === id ? { ...l, name: patch.name! } : l)) }));
          get().log('contact.updated', 'contact', id, Object.keys(patch).join(', '));
        },

        setConsent: (contactId, channel, state, source = 'Staff update') => {
          set((s) => ({ contacts: mapIn(s.contacts, contactId, (c) => ({ ...c, consents: { ...c.consents, [channel]: state } })) }));
          get().log(state === 'granted' ? 'consent.granted' : 'consent.revoked', 'contact', contactId, `${channel} → ${state} (${source})`);
          if (state === 'revoked' || state === 'denied') {
            const n = cancelFollowUpsFor(contactId, `${channel} opt-out`);
            const lead = get().leads.find((l) => l.contactId === contactId);
            get().activity({ leadId: lead?.id ?? null, contactId, dealId: null, kind: 'opt_out', title: `Opted out of ${channel}`, body: `Source: ${source}. ${n} pending follow-up${n === 1 ? '' : 's'} cancelled.`, actor: source === 'Inbound message' ? { type: 'system', name: 'Opt-out handler' } : myActor() });
          }
        },

        optOutAll: (contactId) => {
          (['phone', 'whatsapp', 'sms', 'email'] as Channel[]).forEach((ch) => get().setConsent(contactId, ch, 'revoked'));
          set((s) => ({ contacts: mapIn(s.contacts, contactId, (c) => ({ ...c, lifecycle: 'do_not_contact' })) }));
        },

        /* ─────────── properties ─────────── */
        saveProperty: (p) => {
          const now = Date.now();
          if (p.id) {
            const prev = get().properties.find((x) => x.id === p.id)!;
            set((s) => ({ properties: mapIn(s.properties, p.id!, (x) => ({ ...x, ...p, updatedAt: now })) }));
            if (p.price && p.price !== prev.price) get().log('property.price_changed', 'property', p.id, `${prev.price} → ${p.price}`);
            else get().log('property.updated', 'property', p.id);
            return get().properties.find((x) => x.id === p.id)!;
          }
          const count = get().properties.filter((x) => x.orgId === orgId()).length;
          const prop: Property = {
            id: uid('prop'), orgId: orgId(), ref: `${get().org().slug.slice(0, 2).toUpperCase()}-${1040 + count + Math.floor(Math.random() * 50)}`,
            title: p.title ?? 'Untitled listing', description: p.description ?? '', listing: p.listing ?? 'sale', type: p.type ?? 'apartment', status: p.status ?? 'draft',
            price: p.price ?? 0, bedrooms: p.bedrooms ?? 2, bathrooms: p.bathrooms ?? 2, area: p.area ?? 900, locality: p.locality ?? '', city: get().org().city,
            amenities: p.amenities ?? [], furnishing: p.furnishing ?? 'semi', verified: false, verifiedAt: null, agentId: p.agentId ?? get().me().id,
            ownerContactId: null, image: Math.floor(Math.random() * 14), createdAt: now, updatedAt: now,
          };
          set((s) => ({ properties: [prop, ...s.properties] }));
          get().log('property.created', 'property', prop.id, prop.ref);
          return prop;
        },

        verifyProperty: (id) => {
          set((s) => ({ properties: mapIn(s.properties, id, (p) => ({ ...p, verified: true, verifiedAt: Date.now() })) }));
          get().log('property.verified', 'property', id, 'availability confirmed with owner');
        },

        /* ─────────── deals ─────────── */
        createDeal: (d) => {
          const now = Date.now();
          const deal: Deal = { ...d, id: uid('deal'), orgId: orgId(), createdAt: now, stageChangedAt: now, lostReason: null };
          set((s) => ({ deals: [deal, ...s.deals] }));
          get().activity({ leadId: d.leadId, contactId: d.contactId, dealId: deal.id, kind: 'deal', title: `Deal opened: ${d.title}`, body: null, actor: myActor() });
          get().log('deal.created', 'deal', deal.id);
          return deal;
        },

        moveDeal: (id, stage, lostReason) => {
          const d = get().deals.find((x) => x.id === id);
          if (!d || d.stage === stage) return;
          set((s) => ({ deals: mapIn(s.deals, id, (x) => ({ ...x, stage, stageChangedAt: Date.now(), lostReason: stage === 'lost' ? lostReason ?? 'Other' : null })) }));
          get().activity({ leadId: d.leadId, contactId: d.contactId, dealId: id, kind: 'deal', title: `Deal stage → ${stage.replace(/_/g, ' ')}`, body: lostReason ?? null, actor: myActor() });
          get().log('deal.stage_changed', 'deal', id, `${d.stage} → ${stage}`);
          if (stage === 'won') {
            const gross = Math.round((d.value * d.commissionPct) / 100);
            if (!get().commissions.some((c) => c.dealId === id)) {
              set((s) => ({ commissions: [{ id: uid('com'), orgId: orgId(), dealId: id, beneficiaryId: d.ownerId ?? get().me().id, gross, status: 'estimated', createdAt: Date.now(), paidAt: null }, ...s.commissions] }));
            }
            if (d.leadId) get().setLeadStatus(d.leadId, 'won');
            if (d.propertyId) {
              const p = get().properties.find((x) => x.id === d.propertyId);
              if (p) set((s) => ({ properties: mapIn(s.properties, p.id, (x) => ({ ...x, status: x.listing === 'rent' ? 'let' : 'sold' })) }));
            }
            get().notify({ kind: 'system', title: 'Deal won 🎉', body: `${d.title} — commission estimate recorded for finance review.`, link: 'finance' });
          }
          if (stage === 'lost' && d.leadId) get().setLeadStatus(d.leadId, 'lost', lostReason);
          if (stage === 'under_contract' && d.propertyId)
            set((s) => ({ properties: mapIn(s.properties, d.propertyId!, (x) => (x.status === 'active' ? { ...x, status: 'under_offer' } : x)) }));
        },

        updateDeal: (id, patch) => {
          set((s) => ({ deals: mapIn(s.deals, id, (x) => ({ ...x, ...patch })) }));
          get().log('deal.updated', 'deal', id, Object.keys(patch).join(', '));
        },

        /* ─────────── appointments ─────────── */
        bookAppointment: (a) => {
          const s = get();
          const orgAppts = s.appointments.filter((x) => x.orgId === orgId());
          const conflict = findConflict(orgAppts, a);
          if (conflict) {
            const alternatives = a.assignedTo ? nextFreeSlots(orgAppts, a.assignedTo, a.start, Math.round((a.end - a.start) / MIN), s.org()) : [];
            return { ok: false, conflict, alternatives };
          }
          const appt: Appointment = { ...a, id: uid('apt'), orgId: orgId(), createdAt: Date.now(), cancelReason: null, feedback: null };
          set((st) => ({ appointments: [...st.appointments, appt] }));
          get().activity({ leadId: a.leadId, contactId: a.contactId, dealId: null, kind: 'appointment', title: `${a.title} booked`, body: new Date(a.start).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }), actor: a.source === 'ai' ? { type: 'ai_agent', name: 'AI Follow-Up Agent' } : myActor() });
          get().log('appointment.booked', 'appointment', appt.id);
          if (a.leadId) {
            const l = get().leads.find((x) => x.id === a.leadId);
            if (l && ['new', 'attempting', 'contacted', 'qualified', 'matching'].includes(l.status)) get().setLeadStatus(l.id, 'visit_scheduled');
          }
          // Confirmation + reminders are owned by the reminder workflow.
          const wf = get().workflows.find((w) => w.orgId === orgId() && w.key === 'reminder');
          if (wf?.status === 'active') void get().runWorkflow(wf.id, { leadId: a.leadId });
          const assignee = s.members.find((m) => m.id === a.assignedTo);
          if (assignee && assignee.id !== s.me().id) get().notify({ kind: 'appointment', title: `Visit booked for ${assignee.name.split(' ')[0]}`, body: a.title, link: 'appointments' });
          return { ok: true, appointment: appt };
        },

        setAppointmentStatus: (id, status, extra) => {
          const a = get().appointments.find((x) => x.id === id);
          if (!a) return;
          set((s) => ({ appointments: mapIn(s.appointments, id, (x) => ({ ...x, status, cancelReason: extra?.reason ?? x.cancelReason, feedback: extra?.feedback ?? x.feedback })) }));
          get().activity({ leadId: a.leadId, contactId: a.contactId, dealId: null, kind: 'appointment', title: `${a.title} — ${status.replace(/_/g, ' ')}`, body: extra?.reason ?? extra?.feedback ?? null, actor: myActor() });
          get().log(`appointment.${status}`, 'appointment', id, extra?.reason ?? null);
          if (status === 'completed' && a.leadId) {
            const l = get().leads.find((x) => x.id === a.leadId);
            if (l?.status === 'visit_scheduled') get().setLeadStatus(l.id, 'visit_completed');
            const wf = get().workflows.find((w) => w.orgId === orgId() && w.key === 'feedback');
            if (wf?.status === 'active') void get().runWorkflow(wf.id, { leadId: a.leadId });
          }
          if (status === 'cancelled') {
            // Cancel reminder runs that haven't fired.
            set((s) => ({ runs: s.runs.map((r) => (r.leadId === a.leadId && r.status === 'running' && r.name.includes('reminder') ? { ...r, status: 'cancelled' } : r)) }));
          }
        },

        rescheduleAppointment: (id, start, end) => {
          const a = get().appointments.find((x) => x.id === id)!;
          const conflict = findConflict(get().appointments.filter((x) => x.orgId === orgId()), { assignedTo: a.assignedTo, start, end, id });
          if (conflict) return { ok: false, conflict };
          set((s) => ({ appointments: mapIn(s.appointments, id, (x) => ({ ...x, start, end, status: 'confirmed' })) }));
          get().activity({ leadId: a.leadId, contactId: a.contactId, dealId: null, kind: 'appointment', title: `${a.title} rescheduled`, body: new Date(start).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }), actor: myActor() });
          get().log('appointment.rescheduled', 'appointment', id);
          return { ok: true };
        },

        /* ─────────── tasks ─────────── */
        saveTask: (t) => {
          if (t.id) {
            set((s) => ({ tasks: mapIn(s.tasks, t.id!, (x) => ({ ...x, ...t })) }));
            return get().tasks.find((x) => x.id === t.id)!;
          }
          const task: Task = {
            id: uid('task'), orgId: orgId(), title: t.title, status: 'open', priority: t.priority ?? 'normal', dueAt: t.dueAt ?? Date.now() + DAY,
            assignedTo: t.assignedTo ?? get().me().id, related: t.related ?? null, source: t.source ?? 'manual', createdAt: Date.now(), completedAt: null,
          };
          set((s) => ({ tasks: [task, ...s.tasks] }));
          if (task.related?.type === 'lead') {
            const l = get().leads.find((x) => x.id === task.related!.id);
            get().activity({ leadId: task.related.id, contactId: l?.contactId ?? null, dealId: null, kind: 'task', title: `Task: ${task.title}`, body: null, actor: myActor() });
          }
          return task;
        },

        setTaskStatus: (id, status) =>
          set((s) => ({ tasks: mapIn(s.tasks, id, (t) => ({ ...t, status, completedAt: status === 'completed' ? Date.now() : null })) })),

        /* ─────────── inbox ─────────── */
        sendMessage: (convId, body, opts) => {
          const s = get();
          const conv = s.conversations.find((c) => c.id === convId)!;
          const me = s.me();
          if (opts?.internal) {
            pushMessage(convId, { direction: 'internal', sender: 'user', senderName: me.name, body, at: Date.now(), status: 'sent' });
            return null;
          }
          const contact = s.contacts.find((c) => c.id === conv.contactId);
          const policy = outboundPolicy(s.org(), contact, conv.channel, { purpose: 'service' });
          if (!policy.allowed) {
            pushMessage(convId, { direction: 'system', sender: 'system', senderName: 'Policy', body: `Not sent — ${policy.reason}`, at: Date.now(), status: 'blocked' });
            get().log('message.blocked', 'conversation', convId, policy.reason ?? null);
            return policy;
          }
          const at = Date.now();
          const msgId = uid('msg');
          set((st) => ({
            conversations: mapIn(st.conversations, convId, (c) => ({
              ...c, owner: c.owner === 'ai' ? 'human' : c.owner === 'unassigned' ? 'human' : c.owner, assignedTo: c.assignedTo ?? me.id, status: 'open',
              messages: [...c.messages, { id: msgId, direction: 'out', sender: 'user', senderName: me.name, body, at, status: 'queued' }], lastMessageAt: at,
            })),
          }));
          // Delivery receipts arrive asynchronously from the provider.
          const progress = (status: Message['status'], delay: number) =>
            setTimeout(() => set((st) => ({ conversations: mapIn(st.conversations, convId, (c) => ({ ...c, messages: c.messages.map((m) => (m.id === msgId ? { ...m, status } : m)) })) })), delay);
          progress('sent', 500);
          progress('delivered', 1400);
          if (conv.leadId) {
            set((st) => ({ contacts: mapIn(st.contacts, conv.contactId, (c) => ({ ...c, lastContactedAt: at })), leads: mapIn(st.leads, conv.leadId!, (l) => ({ ...l, lastContactAt: at, firstResponseAt: l.firstResponseAt ?? at })) }));
          }
          return policy;
        },

        receiveMessage: (convId, body) => {
          const s = get();
          const conv = s.conversations.find((c) => c.id === convId)!;
          const contact = s.contacts.find((c) => c.id === conv.contactId)!;
          pushMessage(convId, { direction: 'in', sender: 'contact', senderName: contact.name, body, at: Date.now(), status: 'received' });
          if (isOptOut(body)) {
            get().setConsent(contact.id, conv.channel, 'revoked', 'Inbound message');
            pushMessage(convId, { direction: 'system', sender: 'system', senderName: 'System', body: `Opt-out recorded for ${conv.channel}. Pending follow-ups cancelled; no further automated messages.`, at: Date.now() + 1, status: 'sent' });
            set((st) => ({ conversations: mapIn(st.conversations, convId, (c) => ({ ...c, owner: 'unassigned' })) }));
            toast({ kind: 'warning', title: 'Opt-out received', body: `${contact.name} opted out of ${conv.channel}.` });
            return;
          }
          // Structured extraction from the message (untrusted input — values validated, unknowns left unknown).
          if (conv.leadId) {
            const ex = extractRequirements(body);
            const patch: Partial<Lead> = {};
            const fields: string[] = [];
            if (ex.budget) { patch.budgetMax = Number(ex.budget); fields.push('budget'); }
            if (ex.bedrooms) { patch.bedrooms = Number(ex.bedrooms); fields.push('bedrooms'); }
            if (ex.location) { patch.locations = [ex.location]; fields.push('locations'); }
            if (ex.timeline) { patch.timeline = ex.timeline; fields.push('timeline'); }
            if (fields.length) {
              const l = get().leads.find((x) => x.id === conv.leadId)!;
              get().updateLead(l.id, { ...patch, aiFields: [...new Set([...l.aiFields, ...fields])] }, { type: 'ai_agent', name: 'Qualification Agent' });
              get().activity({ leadId: l.id, contactId: l.contactId, dealId: null, kind: 'ai_update', title: `Extracted ${fields.join(', ')} from ${conv.channel}`, body: `“${body.slice(0, 120)}”`, actor: { type: 'ai_agent', name: 'Qualification Agent' } });
            }
          }
          if (conv.owner !== 'ai') return;
          const agent = s.agents.find((a) => a.orgId === orgId() && a.channel === conv.channel && a.status === 'active');
          if (!agent) return;
          const policy = outboundPolicy(s.org(), get().contacts.find((c) => c.id === contact.id), conv.channel, { byAi: true, humanOwned: false });
          setTimeout(() => {
            const latest = get().conversations.find((c) => c.id === convId)!;
            // Re-check ownership immediately before sending (race with human takeover).
            if (latest.owner !== 'ai') return;
            if (!policy.allowed) {
              pushMessage(convId, { direction: 'system', sender: 'system', senderName: 'Policy', body: `AI reply suppressed — ${policy.reason}`, at: Date.now(), status: 'blocked' });
              return;
            }
            const reply = draftReply(get(), convId);
            if (agent.autonomy === 'bounded_auto') {
              pushMessage(convId, { direction: 'out', sender: 'ai', senderName: agent.name, body: reply, at: Date.now(), status: 'delivered' });
            } else {
              const appr: Approval = { id: uid('apr'), orgId: orgId(), action: 'send_approved_message', summary: `Reply to ${contact.name} on ${conv.channel}`, risk: 'low', requestedBy: { type: 'ai_agent', name: agent.name }, status: 'pending', createdAt: Date.now(), expiresAt: Date.now() + 4 * HOUR, decidedBy: null, decidedAt: null, note: null, payload: { kind: 'send_message', conversationId: convId, body: reply } };
              set((st) => ({ approvals: [appr, ...st.approvals] }));
              pushMessage(convId, { direction: 'system', sender: 'system', senderName: 'System', body: `${agent.name} drafted a reply — waiting for approval.`, at: Date.now(), status: 'sent' });
              get().notify({ kind: 'approval', title: 'Reply waiting for approval', body: `${agent.name} → ${contact.name}`, link: 'approvals' });
            }
          }, 1600);
        },

        takeOver: (convId) => {
          const me = get().me();
          set((s) => ({ conversations: mapIn(s.conversations, convId, (c) => ({ ...c, owner: 'human', assignedTo: me.id })) }));
          pushMessage(convId, { direction: 'system', sender: 'system', senderName: 'System', body: `${me.name} took over. AI paused for this conversation; pending AI sends cancelled.`, at: Date.now(), status: 'sent' });
          // Cancel pending approvals tied to this conversation.
          set((s) => ({ approvals: s.approvals.map((a) => (a.status === 'pending' && a.payload.kind === 'send_message' && a.payload.conversationId === convId ? { ...a, status: 'rejected', decidedBy: 'System', decidedAt: Date.now(), note: 'Superseded by human takeover' } : a)) }));
          get().log('conversation.taken_over', 'conversation', convId);
        },

        resumeAi: (convId) => {
          set((s) => ({ conversations: mapIn(s.conversations, convId, (c) => ({ ...c, owner: 'ai' })) }));
          pushMessage(convId, { direction: 'system', sender: 'system', senderName: 'System', body: `${get().me().name} handed the conversation back to AI.`, at: Date.now(), status: 'sent' });
          get().log('conversation.ai_resumed', 'conversation', convId);
        },

        setConversationStatus: (convId, status) => set((s) => ({ conversations: mapIn(s.conversations, convId, (c) => ({ ...c, status })) })),
        markConversationRead: (convId) => set((s) => ({ conversations: mapIn(s.conversations, convId, (c) => (c.unread ? { ...c, unread: 0 } : c)) })),

        startConversation: (contactId, channel) => {
          const existing = get().conversations.find((c) => c.contactId === contactId && c.channel === channel);
          if (existing) return existing.id;
          const lead = get().leads.find((l) => l.contactId === contactId);
          const conv: Conversation = { id: uid('conv'), orgId: orgId(), contactId, leadId: lead?.id ?? null, channel, status: 'open', owner: 'human', assignedTo: get().me().id, unread: 0, lastMessageAt: Date.now(), messages: [] };
          set((s) => ({ conversations: [conv, ...s.conversations] }));
          return conv.id;
        },

        /* ─────────── calls ─────────── */
        placeCall: (leadId, opts) => {
          const s = get();
          const lead = s.leads.find((l) => l.id === leadId)!;
          const contact = s.contacts.find((c) => c.id === lead.contactId);
          const byAi = opts?.byAi ?? true;
          const policy = outboundPolicy(s.org(), contact, 'phone', { purpose: 'ai_call' });
          const agent = s.agents.find((a) => a.orgId === orgId() && a.type === 'qualification');
          if (byAi && agent?.status !== 'active') {
            policy.allowed = false;
            policy.checks.push({ label: 'Agent status', ok: false, detail: `${agent?.name ?? 'Agent'} is paused` });
            policy.reason = `${agent?.name ?? 'Agent'} is paused`;
          }
          const call: Call = {
            id: uid('call'), orgId: orgId(), leadId, contactId: lead.contactId, direction: 'outbound', status: policy.allowed ? 'queued' : 'blocked',
            agentId: byAi ? agent?.id ?? null : null, userId: byAi ? null : s.me().id, startedAt: Date.now(), duration: 0, cost: 0, outcome: null,
            summary: null, extracted: null, recording: false, policyNote: policy.allowed ? null : policy.reason ?? null,
          };
          set((st) => ({ calls: [call, ...st.calls] }));
          get().log(policy.allowed ? 'call.requested' : 'call.blocked', 'call', call.id, policy.reason ?? `idempotency=${call.id}`);
          if (!policy.allowed) return policy;

          const patch = (p: Partial<Call>) => set((st) => ({ calls: mapIn(st.calls, call.id, (c) => ({ ...c, ...p })) }));
          const runSim = async () => {
            await sleep(700); patch({ status: 'initiating' });
            await sleep(900); patch({ status: 'ringing' });
            await sleep(1600);
            // Re-check the kill switch right before connecting.
            if (get().org().outboundPaused) { patch({ status: 'cancelled', policyNote: 'Kill switch engaged mid-flight' }); return; }
            const answered = Math.random() > 0.22;
            if (!answered) {
              patch({ status: 'no_answer', cost: 0.2 });
              get().activity({ leadId, contactId: lead.contactId, dealId: null, kind: 'call', title: 'Call not answered', body: 'No-answer sequence will retry with backoff (max 3 attempts).', actor: byAi ? { type: 'ai_agent', name: agent?.name ?? 'AI' } : myActor() });
              if (lead.status === 'new') get().setLeadStatus(leadId, 'attempting');
              toast({ kind: 'warning', title: 'No answer', body: `Retry scheduled for ${lead.name}.` });
              return;
            }
            patch({ status: 'in_progress' });
            await sleep(2600);
            const duration = Math.round(90 + Math.random() * 200);
            const fields: Record<string, string> = {};
            const updates: Partial<Lead> = {};
            const extractedKeys: string[] = [];
            // Only fill what is missing; never overwrite verified human edits.
            if (!lead.budgetMax) { const b = lead.intent === 'rent' ? 75000 : Math.round((1.2 + Math.random() * 1.6) * 1e7 / 1e5) * 1e5; updates.budgetMax = b; updates.budgetMin = Math.round(b * 0.8); fields.budget = String(b); extractedKeys.push('budget'); }
            if (lead.bedrooms == null) { updates.bedrooms = 2 + Math.round(Math.random()); fields.bedrooms = String(updates.bedrooms); extractedKeys.push('bedrooms'); }
            if (!lead.timeline) { updates.timeline = '0-3 months'; fields.timeline = '0-3 months'; extractedKeys.push('timeline'); }
            if (!lead.propertyType) { updates.propertyType = 'apartment'; extractedKeys.push('propertyType'); }
            fields.location = lead.locations[0] ?? 'unknown';
            const confident = Math.random() > 0.12;
            const summary = `Spoke with ${lead.name.split(' ')[0]}. ${lead.intent === 'rent' ? 'Wants to rent' : 'Wants to buy'} a ${updates.bedrooms ?? lead.bedrooms ?? 2}-bed home${lead.locations.length ? ` in ${lead.locations.join(' or ')}` : ''}. Timeline ${updates.timeline ?? lead.timeline}. Open to a showing this weekend.${lead.locations.length ? '' : ' Location not stated — marked unknown.'}`;
            patch({ status: confident ? 'completed' : 'needs_review', duration, cost: Math.round((duration / 60) * 0.12 * 100) / 100 + 0.02, outcome: confident ? 'Requirements captured' : 'Low confidence extraction', summary, extracted: fields, recording: byAi });
            if (confident) {
              get().updateLead(leadId, { ...updates, aiFields: [...new Set([...lead.aiFields, ...extractedKeys])], summary, lastContactAt: Date.now(), firstResponseAt: lead.firstResponseAt ?? Date.now() }, { type: 'ai_agent', name: agent?.name ?? 'AI' });
              if (['new', 'attempting', 'contacted'].includes(lead.status)) get().setLeadStatus(leadId, 'qualified', 'AI qualification call');
              get().saveTask({ title: `Share matching properties with ${lead.name.split(' ')[0]}`, related: { type: 'lead', id: leadId }, assignedTo: lead.assignedTo, dueAt: Date.now() + 4 * HOUR, priority: 'high', source: 'ai' });
            }
            get().activity({ leadId, contactId: lead.contactId, dealId: null, kind: 'call', title: confident ? 'AI qualification call completed' : 'Call needs review', body: summary, actor: byAi ? { type: 'ai_agent', name: agent?.name ?? 'AI' } : myActor() });
            const run: Run = {
              id: uid('run'), orgId: orgId(), kind: 'agent', refId: agent?.id ?? '', name: agent?.name ?? 'Call', status: confident ? 'succeeded' : 'failed', trigger: 'manual',
              startedAt: call.startedAt, durationMs: Date.now() - call.startedAt, cost: 1.6, tokens: 6400,
              steps: [
                { label: 'Policy check: consent, hours, suppression', status: 'ok', ms: 18 },
                { label: 'Provider call via voice adapter', status: 'ok', ms: duration * 1000 },
                { label: 'Transcript → structured extraction', status: 'ok', ms: 2100 },
                { label: 'Validate output against schema v3', status: confident ? 'ok' : 'fail', ms: 12, note: confident ? undefined : 'Confidence below 0.7 for budget' },
                { label: 'Update permitted CRM fields', status: confident ? 'ok' : 'pending', ms: 40 },
              ],
              leadId, attempt: 1, error: confident ? null : 'Escalated for human review', correlationId: correlationId(),
            };
            set((st) => ({ runs: [run, ...st.runs] }));
            toast({ kind: confident ? 'success' : 'warning', title: confident ? 'Call completed' : 'Call needs review', body: confident ? `${extractedKeys.length} field(s) captured for ${lead.name}.` : 'Extraction confidence was low — a person should check it.' });
          };
          void runSim();
          return policy;
        },

        /* ─────────── agents & workflows ─────────── */
        setAgentStatus: (id, status) => {
          set((s) => ({ agents: mapIn(s.agents, id, (a) => ({ ...a, status })) }));
          get().log(status === 'paused' ? 'agent.paused' : 'agent.activated', 'agent', id);
        },
        updateAgent: (id, patch) => {
          set((s) => ({ agents: mapIn(s.agents, id, (a) => ({ ...a, ...patch, version: patch.autonomy || patch.tools ? a.version + 1 : a.version })) }));
          get().log('agent.configuration_changed', 'agent', id, Object.keys(patch).join(', '));
        },
        setOutboundPaused: (paused) => {
          set((s) => ({ orgs: mapIn(s.orgs, orgId(), (o) => ({ ...o, outboundPaused: paused })) }));
          if (paused) {
            set((s) => ({ calls: s.calls.map((c) => (c.orgId === orgId() && ['queued', 'initiating'].includes(c.status) ? { ...c, status: 'cancelled', policyNote: 'Kill switch engaged' } : c)) }));
          }
          get().log(paused ? 'outbound.kill_switch_engaged' : 'outbound.kill_switch_released', 'organization', orgId());
          get().notify({ kind: 'system', title: paused ? 'All outbound paused' : 'Outbound resumed', body: paused ? 'Calls and messages will not be sent until resumed.' : 'Queued work will re-check policy before sending.', link: 'agents' });
        },
        setWorkflowStatus: (id, status) => {
          set((s) => ({ workflows: mapIn(s.workflows, id, (w) => ({ ...w, status })) }));
          get().log(status === 'paused' ? 'workflow.paused' : 'workflow.activated', 'workflow', id);
        },

        runWorkflow: async (id, opts) => {
          const w = get().workflows.find((x) => x.id === id);
          if (!w) return null;
          const run: Run = {
            id: uid('run'), orgId: w.orgId, kind: 'workflow', refId: w.id, name: opts?.test ? `${w.name} (test)` : w.name, status: 'running', trigger: opts?.test ? 'manual test' : w.trigger,
            startedAt: Date.now(), durationMs: 0, cost: 0, tokens: 0, steps: w.steps.map((st) => ({ label: st.label, status: 'pending', ms: 0 })),
            leadId: opts?.leadId ?? null, attempt: 1, error: null, correlationId: correlationId(),
          };
          set((s) => ({ runs: [run, ...s.runs] }));
          const lead = opts?.leadId ? get().leads.find((l) => l.id === opts.leadId) : undefined;
          const contact = lead ? get().contacts.find((c) => c.id === lead.contactId) : undefined;
          for (let i = 0; i < w.steps.length; i++) {
            const step = w.steps[i];
            patchRun(run.id, (r) => ({ ...r, steps: r.steps.map((x, idx) => (idx === i ? { ...x, status: 'run' } : x)) }));
            const t = step.kind === 'ai' ? 900 : step.kind === 'delay' ? 500 : 350;
            await sleep(t);
            const current = get().runs.find((r) => r.id === run.id);
            if (!current || current.status === 'cancelled') return current ?? null;
            let status: RunStep['status'] = 'ok';
            let note: string | undefined;
            if (step.kind === 'condition' && /consent|hours/i.test(step.label) && contact) {
              const p = outboundPolicy(get().org(), contact, 'whatsapp');
              if (!p.allowed) { status = 'skip'; note = p.reason; }
            }
            if (step.kind === 'delay') note = opts?.test ? 'Skipped in test mode' : 'Scheduled (durable timer)';
            if ((step.kind === 'action' || step.kind === 'ai') && get().org().outboundPaused && /send|call|retry|attempt/i.test(step.label)) { status = 'skip'; note = 'Outbound kill switch engaged'; }
            patchRun(run.id, (r) => ({ ...r, durationMs: Date.now() - r.startedAt, steps: r.steps.map((x, idx) => (idx === i ? { ...x, status, ms: t + Math.round(Math.random() * 80), note } : x)) }));
            if (status === 'skip') {
              patchRun(run.id, (r) => ({ ...r, status: 'skipped', steps: r.steps.map((x, idx) => (idx > i ? { ...x, status: 'pending' } : x)) }));
              return get().runs.find((r) => r.id === run.id) ?? null;
            }
          }
          patchRun(run.id, (r) => ({ ...r, status: 'succeeded', durationMs: Date.now() - r.startedAt, cost: Math.round(Math.random() * 400) / 100 }));
          return get().runs.find((r) => r.id === run.id) ?? null;
        },

        retryRun: (runId) => {
          const r = get().runs.find((x) => x.id === runId);
          if (!r) return;
          if (r.attempt >= 3) {
            patchRun(runId, (x) => ({ ...x, status: 'dead_letter', error: `${x.error ?? 'Failed'} — max attempts reached` }));
            toast({ kind: 'error', title: 'Moved to dead letter', body: 'Retry limit reached. Needs manual review.' });
            return;
          }
          patchRun(runId, (x) => ({ ...x, status: 'retrying', attempt: x.attempt + 1 }));
          get().log('run.retried', 'run', runId, `attempt ${r.attempt + 1}`);
          setTimeout(() => {
            const ok = Math.random() > 0.25;
            patchRun(runId, (x) => ({ ...x, status: ok ? 'succeeded' : 'failed', error: ok ? null : x.error, steps: x.steps.map((st) => (ok && (st.status === 'fail' || st.status === 'pending') ? { ...st, status: 'ok', note: st.status === 'fail' ? 'Succeeded on retry' : st.note } : st)) }));
            toast({ kind: ok ? 'success' : 'error', title: ok ? 'Retry succeeded' : 'Retry failed', body: ok ? r.name : 'Backoff applied before the next attempt.' });
          }, 1800);
        },

        testAgent: async (id) => {
          const a = get().agents.find((x) => x.id === id)!;
          const run: Run = { id: uid('run'), orgId: orgId(), kind: 'agent', refId: id, name: `${a.name} (eval)`, status: 'running', trigger: 'evaluation suite', startedAt: Date.now(), durationMs: 0, cost: 0, tokens: 0, steps: [
            { label: 'Extraction accuracy (24 cases)', status: 'pending', ms: 0 },
            { label: 'Refuses to invent property facts', status: 'pending', ms: 0 },
            { label: 'Prompt-injection resistance (12 cases)', status: 'pending', ms: 0 },
            { label: 'Opt-out handling', status: 'pending', ms: 0 },
            { label: 'Structured output compliance', status: 'pending', ms: 0 },
          ], leadId: null, attempt: 1, error: null, correlationId: correlationId() };
          set((s) => ({ runs: [run, ...s.runs] }));
          for (let i = 0; i < run.steps.length; i++) {
            patchRun(run.id, (r) => ({ ...r, steps: r.steps.map((x, idx) => (idx === i ? { ...x, status: 'run' } : x)) }));
            await sleep(500);
            const pass = !(i === 0 && Math.random() < 0.2);
            patchRun(run.id, (r) => ({ ...r, steps: r.steps.map((x, idx) => (idx === i ? { ...x, status: pass ? 'ok' : 'fail', ms: 480, note: pass ? (i === 0 ? '23/24 passed' : 'All passed') : '21/24 — 3 budget parses off' } : x)) }));
          }
          const failed = get().runs.find((r) => r.id === run.id)!.steps.some((s) => s.status === 'fail');
          patchRun(run.id, (r) => ({ ...r, status: failed ? 'failed' : 'succeeded', durationMs: Date.now() - r.startedAt, tokens: 48000, cost: 9.4, error: failed ? 'Eval below threshold — rollout blocked' : null }));
          toast({ kind: failed ? 'warning' : 'success', title: failed ? 'Evaluation below threshold' : 'Evaluation passed', body: failed ? 'Rollout blocked until extraction cases pass.' : `${a.name} v${a.version} is safe to roll out.` });
        },

        setFollowUpStatus: (id, status, reason) => {
          set((s) => ({
            followUps: mapIn(s.followUps, id, (f) => ({
              ...f, status, stopReason: status === 'stopped' ? reason ?? 'Stopped manually' : f.stopReason,
              steps: status === 'stopped' ? f.steps.map((st) => (st.status === 'scheduled' ? { ...st, status: 'cancelled' } : st)) : f.steps,
            })),
          }));
          get().log(`follow_up.${status}`, 'follow_up', id, reason ?? null);
        },

        /* ─────────── approvals ─────────── */
        decideApproval: (id, approve, note) => {
          const a = get().approvals.find((x) => x.id === id);
          if (!a || a.status !== 'pending') return;
          const me = get().me();
          if (a.expiresAt < Date.now()) {
            set((s) => ({ approvals: mapIn(s.approvals, id, (x) => ({ ...x, status: 'expired' })) }));
            toast({ kind: 'warning', title: 'Approval expired', body: 'The request is no longer valid. Ask the agent to re-propose.' });
            return;
          }
          set((s) => ({ approvals: mapIn(s.approvals, id, (x) => ({ ...x, status: approve ? 'approved' : 'rejected', decidedBy: me.name, decidedAt: Date.now(), note: note ?? null })) }));
          get().log(approve ? 'approval.approved' : 'approval.rejected', 'approval', id, note ?? a.action);
          if (!approve) {
            toast({ kind: 'info', title: 'Rejected', body: 'The agent will not perform this action.' });
            return;
          }
          // Execute with re-authorization at execution time — approval never overrides a later opt-out.
          const p = a.payload;
          if (p.kind === 'send_message') {
            const conv = get().conversations.find((c) => c.id === p.conversationId);
            const contact = conv && get().contacts.find((c) => c.id === conv.contactId);
            const policy = conv ? outboundPolicy(get().org(), contact, conv.channel, { byAi: true, humanOwned: conv.owner === 'human' }) : null;
            if (!conv || !policy?.allowed) {
              toast({ kind: 'error', title: 'Approved, but not sent', body: policy?.reason ?? 'Conversation not found' });
              set((s) => ({ approvals: mapIn(s.approvals, id, (x) => ({ ...x, note: `Blocked at execution: ${policy?.reason}` })) }));
              return;
            }
            pushMessage(conv.id, { direction: 'out', sender: 'ai', senderName: a.requestedBy.name, body: p.body, at: Date.now(), status: 'delivered' });
            toast({ kind: 'success', title: 'Approved and sent', body: `Delivered via ${conv.channel}.` });
          } else if (p.kind === 'deal_stage') {
            get().moveDeal(p.dealId, p.to);
            toast({ kind: 'success', title: 'Deal stage updated' });
          } else if (p.kind === 'book_appointment') {
            const lead = get().leads.find((l) => l.id === p.leadId)!;
            const res = get().bookAppointment({ title: 'Site visit', type: 'viewing', status: 'confirmed', leadId: lead.id, contactId: lead.contactId, propertyId: p.propertyId, assignedTo: lead.assignedTo, start: p.start, end: p.start + 45 * MIN, location: 'Property site', source: 'ai' });
            toast(res.ok ? { kind: 'success', title: 'Visit booked', body: new Date(p.start).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }) } : { kind: 'error', title: 'Slot no longer free', body: 'Conflict detected at execution — the agent will propose new times.' });
          } else if (p.kind === 'bulk_export') {
            if (p.entity === 'leads') {
              const leads = get().leads.filter((l) => l.orgId === orgId());
              downloadCsv('leads-export.csv', [['Name', 'Status', 'Source', 'Budget max', 'Locations', 'Created'], ...leads.map((l) => [l.name, l.status, l.source, l.budgetMax, l.locations.join('; '), new Date(l.createdAt).toISOString()])]);
              toast({ kind: 'success', title: 'Export generated', body: `${leads.length} rows · access logged.` });
            }
          } else if (p.kind === 'commission') {
            get().advanceCommission(p.commissionId, p.to);
          }
        },

        /* ─────────── integrations ─────────── */
        setIntegrationStatus: (id, status) => {
          set((s) => ({ integrations: mapIn(s.integrations, id, (i) => ({ ...i, status, error: status === 'connected' ? null : i.error, lastSync: status === 'connected' ? Date.now() : i.lastSync })) }));
          const i = get().integrations.find((x) => x.id === id)!;
          get().log(status === 'connected' ? 'integration.connected' : status === 'disconnected' ? 'integration.disconnected' : 'integration.paused', 'integration', id, i.provider);
        },
        connectIntegration: (catalogId) => {
          const cat = catalogEntry(catalogId);
          if (!cat) return;
          const existing = get().integrations.find((i) => i.orgId === orgId() && i.provider === catalogId);
          if (existing) {
            set((s) => ({ integrations: mapIn(s.integrations, existing.id, (i) => ({ ...i, status: 'connected', error: null, lastSync: Date.now() })) }));
          } else {
            const row: Integration = {
              id: uid('int'), orgId: orgId(), provider: cat.id, category: cat.category, description: cat.blurb,
              status: 'connected', lastSync: Date.now(), error: null, scopes: cat.scopes, capabilities: cat.capabilities,
            };
            set((s) => ({ integrations: [...s.integrations, row] }));
          }
          get().log('integration.connected', 'integration', existing?.id ?? null, cat.name);
          toast({ kind: 'success', title: `${cat.name} connected`, body: 'Credentials stored in the secret vault, never in the database.' });
        },
        testIntegration: async (id) => {
          await sleep(1100);
          const i = get().integrations.find((x) => x.id === id)!;
          const ok = i.status === 'connected' || i.status === 'paused';
          set((s) => ({ integrations: mapIn(s.integrations, id, (x) => ({ ...x, lastSync: ok ? Date.now() : x.lastSync })) }));
          return ok;
        },
        rotateWebhookSecret: () => {
          const secret = `whsec_${Array.from(crypto.getRandomValues(new Uint8Array(18))).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
          set((s) => ({ orgs: mapIn(s.orgs, orgId(), (o) => ({ ...o, webhookSecretVersion: o.webhookSecretVersion + 1 })) }));
          get().log('webhook.secret_rotated', 'integration', null, 'previous secret valid for 24h overlap');
          return secret;
        },

        simulateInboundLead: async (opts) => {
          const s = get();
          const now = Date.now();
          const source = opts?.source ?? 'Meta Lead Ads';
          const orgContacts = s.contacts.filter((c) => c.orgId === orgId());
          const existing = opts?.duplicate ? orgContacts[0] : undefined;
          const first = ['Emma', 'Noah', 'Ava', 'Liam', 'Sofia', 'Mason', 'Chloe', 'Ethan'][Math.floor(Math.random() * 8)];
          const last = ['Carter', 'Reyes', 'Bennett', 'Nguyen', 'Coleman', 'Hughes'][Math.floor(Math.random() * 6)];
          const payload = existing
            ? { name: existing.name, phone: existing.phone, email: existing.email }
            : { name: `${first} ${last}`, phone: `+1512${Math.floor(200 + Math.random() * 800)}${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`, email: `${first.toLowerCase()}.${last.toLowerCase()}@gmail.com` };
          const evt: WebhookEvent = { id: uid('evt'), orgId: orgId(), provider: source, type: 'lead.created', status: 'processed', receivedAt: now, attempts: 1, error: null, idempotencyKey: `meta_${Math.random().toString(36).slice(2, 12)}`, signature: opts?.badSignature ? 'invalid' : 'valid' };
          if (opts?.badSignature) {
            evt.status = 'rejected';
            evt.error = 'Invalid signature';
            set((st) => ({ webhookEvents: [evt, ...st.webhookEvents] }));
            get().log('webhook.signature_failed', 'webhook', evt.id, source, { type: 'integration', name: source });
            toast({ kind: 'error', title: 'Webhook rejected', body: 'Signature verification failed — nothing was created.' });
            return;
          }
          const dupes = findDuplicates(payload, orgContacts);
          if (dupes.length) {
            evt.status = 'duplicate';
            evt.error = `Possible duplicate of ${dupes[0].contact.name} (${dupes[0].reasons.join(', ')})`;
          }
          set((st) => ({ webhookEvents: [evt, ...st.webhookEvents] }));
          const locs = orgId() === 'org_harbor' ? ['La Jolla', 'Pacific Beach', 'North Park'] : ['Downtown', 'Zilker', 'Mueller', 'East Austin', 'Round Rock'];
          const loc = locs[Math.floor(Math.random() * locs.length)];
          const lead = get().createLead({
            name: payload.name, phone: payload.phone, email: payload.email, source: source === 'Meta Lead Ads' ? 'Meta Ads' : source, campaign: 'Spring Buyers ’26', type: 'buyer',
            locations: [loc], existingContactId: dupes[0]?.contact.id ?? null,
          }, { type: 'integration', name: source });
          get().notify({ kind: 'lead', title: dupes.length ? `Repeat enquiry: ${payload.name}` : `New lead: ${payload.name}`, body: dupes.length ? 'Linked to the existing contact — review for merge.' : `From ${source}. Qualification workflow started.`, link: 'leads' });
          toast({ kind: 'success', title: dupes.length ? 'Repeat enquiry linked' : 'Lead received', body: `${payload.name} · ${source}`, action: { label: 'Open', run: () => { location.hash = `#/leads?id=${lead.id}`; } } });
          const wf = get().workflows.find((w) => w.orgId === orgId() && w.key === 'new_lead');
          if (wf?.status === 'active') await get().runWorkflow(wf.id, { leadId: lead.id });
        },

        replayEvent: (id) => {
          const e = get().webhookEvents.find((x) => x.id === id);
          if (!e) return;
          set((s) => ({ webhookEvents: mapIn(s.webhookEvents, id, (x) => ({ ...x, status: 'retrying', attempts: x.attempts + 1 })) }));
          setTimeout(() => {
            const ok = e.provider !== 'Realtor.com' || get().integrations.find((i) => i.provider === 'Realtor.com' && i.orgId === orgId())?.status === 'connected';
            set((s) => ({ webhookEvents: mapIn(s.webhookEvents, id, (x) => ({ ...x, status: ok ? 'processed' : x.attempts >= 5 ? 'dead_letter' : 'failed', error: ok ? null : x.error })) }));
            toast({ kind: ok ? 'success' : 'error', title: ok ? 'Event reprocessed' : 'Replay failed', body: ok ? `Idempotency key ${e.idempotencyKey} — no duplicate created.` : e.error ?? undefined });
          }, 1200);
          get().log('webhook.replayed', 'webhook', id, e.idempotencyKey);
        },

        /* ─────────── team ─────────── */
        inviteMember: (email, role, name) => {
          const e = normalizeEmail(email);
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return { ok: false, error: 'Enter a valid email address' };
          if (get().members.some((m) => m.orgId === orgId() && m.email === e && m.status !== 'suspended')) return { ok: false, error: 'This person is already a member or invited' };
          const m: Member = { id: uid('mem'), orgId: orgId(), name: name?.trim() || e.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), email: e, phone: '', role, title: role === 'agent' ? 'Property Consultant' : role[0].toUpperCase() + role.slice(1), status: 'invited', hue: Math.floor(Math.random() * 360), localities: [], joinedAt: Date.now() };
          set((s) => ({ members: [...s.members, m] }));
          get().log('member.invited', 'member', m.id, `${e} as ${role} · single-use token, expires in 7 days`);
          return { ok: true };
        },
        changeRole: (id, role) => {
          const m = get().members.find((x) => x.id === id)!;
          const owners = get().members.filter((x) => x.orgId === orgId() && x.role === 'owner' && x.status === 'active');
          if (m.role === 'owner' && role !== 'owner' && owners.length <= 1) return { ok: false, error: 'An organization needs at least one active owner. Transfer ownership first.' };
          if (m.id === get().me().id && role !== m.role && get().me().role !== 'owner') return { ok: false, error: 'You cannot change your own role.' };
          set((s) => ({ members: mapIn(s.members, id, (x) => ({ ...x, role })) }));
          get().log('member.role_changed', 'member', id, `${m.role} → ${role}`);
          return { ok: true };
        },
        setMemberStatus: (id, status) => {
          const m = get().members.find((x) => x.id === id)!;
          const owners = get().members.filter((x) => x.orgId === orgId() && x.role === 'owner' && x.status === 'active');
          if (m.role === 'owner' && status !== 'active' && owners.length <= 1) return { ok: false, error: 'You cannot suspend the last active owner.' };
          if (status === 'suspended' && m.status === 'invited') {
            set((s) => ({ members: s.members.filter((x) => x.id !== id) }));
            get().log('member.invite_revoked', 'member', id, m.email);
            return { ok: true };
          }
          set((s) => ({ members: mapIn(s.members, id, (x) => ({ ...x, status })) }));
          if (status === 'suspended') {
            // Reassign their open leads so nothing is orphaned.
            const open = get().leads.filter((l) => l.assignedTo === id && !['won', 'lost'].includes(l.status));
            if (open.length) set((s) => ({ leads: s.leads.map((l) => (l.assignedTo === id && !['won', 'lost'].includes(l.status) ? { ...l, assignedTo: null } : l)) }));
            get().log('member.suspended', 'member', id, `sessions revoked; ${open.length} open leads unassigned`);
          } else get().log('member.reactivated', 'member', id);
          return { ok: true };
        },

        /* ─────────── finance ─────────── */
        advanceCommission: (id, to) => {
          set((s) => ({ commissions: mapIn(s.commissions, id, (c) => ({ ...c, status: to, paidAt: to === 'paid' ? Date.now() : c.paidAt })) }));
          get().log(`commission.${to}`, 'commission', id);
        },
        addExpense: (e) => {
          set((s) => ({ expenses: [{ ...e, id: uid('exp'), orgId: orgId() }, ...s.expenses] }));
          get().log('expense.created', 'expense', null, `${e.vendor} ${money(e.amount, { compact: false })}`);
        },
        setExpenseStatus: (id, status) => set((s) => ({ expenses: mapIn(s.expenses, id, (e) => ({ ...e, status })) })),

        /* ─────────── documents ─────────── */
        addDocuments: (docs) => {
          const me = get().me();
          const recs: DocumentRec[] = docs.map((d) => ({ ...d, id: uid('doc'), orgId: orgId(), uploadedAt: Date.now(), uploadedBy: me.name, status: 'processing' }));
          set((s) => ({ documents: [...recs, ...s.documents] }));
          recs.forEach((r) => {
            get().log('document.uploaded', 'document', r.id, `${r.classification} · private bucket`);
            setTimeout(() => set((s) => ({ documents: mapIn(s.documents, r.id, (x) => ({ ...x, status: 'ready' })) })), 1500 + Math.random() * 1500);
          });
        },
        removeDocument: (id) => {
          set((s) => ({ documents: s.documents.filter((d) => d.id !== id) }));
          get().log('document.deleted', 'document', id);
        },
        updateDocument: (id, patch) => {
          set((s) => ({ documents: mapIn(s.documents, id, (d) => ({ ...d, ...patch })) }));
          get().log('document.updated', 'document', id, Object.keys(patch).join(', '));
        },

        /* ─────────── notifications & settings ─────────── */
        markNotification: (id) => set((s) => ({ notifications: mapIn(s.notifications, id, (n) => ({ ...n, read: true })) })),
        markAllNotifications: () => set((s) => ({ notifications: s.notifications.map((n) => (n.orgId === orgId() ? { ...n, read: true } : n)) })),
        updateOrg: (patch) => {
          set((s) => ({ orgs: mapIn(s.orgs, orgId(), (o) => ({ ...o, ...patch })) }));
          get().log('settings.updated', 'organization', orgId(), Object.keys(patch).join(', '));
        },
        updateSource: (id, patch) => {
          set((s) => ({ sources: mapIn(s.sources, id, (x) => ({ ...x, ...patch })) }));
          get().log('marketing_source.updated', 'marketing_source', id, Object.keys(patch).join(', '));
        },
      };
    },
    {
      name: 'estate-os:data:v6', // v6: Google Calendar renamed to Google Workspace for the integrations marketplace
      // Live mode keeps business data in memory only; nothing tenant-owned is written to the browser.
      storage: createJSONStorage(() => (LIVE ? { getItem: () => null, setItem: () => undefined, removeItem: () => undefined } : localStorage)),
      partialize: (s) => {
        // Persist data only; functions are recreated.
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(s)) if (typeof v !== 'function') out[k] = v;
        return out as unknown as Store;
      },
      merge: (persisted, current) => {
        const p = persisted as State | undefined;
        if (LIVE || !p?.session) return current;
        // Keep the demo feeling current: shift stored timestamps forward by whole days.
        const delta = Math.floor((Date.now() - p.session.seededAt) / DAY) * DAY;
        const shifted = delta > 0 ? shiftTimestamps(p, delta) : p;
        if (delta > 0) shifted.session = { ...shifted.session, seededAt: p.session.seededAt + delta };
        // Work that was in flight when the tab closed: the lease expired, surface it.
        shifted.runs = shifted.runs.map((r) => (r.status === 'running' || r.status === 'retrying' ? { ...r, status: 'failed', error: 'Worker lease expired — interrupted' } : r));
        shifted.calls = shifted.calls.map((c) => (['queued', 'initiating', 'ringing', 'in_progress'].includes(c.status) ? { ...c, status: 'failed', policyNote: 'Interrupted' } : c));
        return { ...current, ...shifted };
      },
    },
  ),
);

function shiftTimestamps<T>(value: T, delta: number): T {
  if (typeof value === 'number') return (value > 1e12 && value < 4e12 ? value + delta : value) as T;
  if (Array.isArray(value)) return value.map((v) => shiftTimestamps(v, delta)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = shiftTimestamps(v, delta);
    return out as T;
  }
  return value;
}

/** Deterministic stand-in for the drafting agent: grounded in the lead record only. */
export function draftReply(s: Store, convId: ID): string {
  const conv = s.conversations.find((c) => c.id === convId)!;
  const lead = s.leads.find((l) => l.id === conv.leadId);
  const contact = s.contacts.find((c) => c.id === conv.contactId)!;
  const first = contact.name.split(' ')[0];
  if (!lead) return `Hi ${first}, thanks for your message — a consultant will get back to you shortly.`;
  const missing = missingFields(lead);
  if (missing.length) {
    const ask = missing.slice(0, 2).map((m) => m.toLowerCase()).join(' and ');
    return `Thanks ${first}! To shortlist the right homes, could you tell me your ${ask}?`;
  }
  const props = s.properties.filter((p) => p.orgId === lead.orgId && p.status === 'active' && lead.locations.includes(p.locality) && p.verified).slice(0, 2);
  if (props.length) {
    return `Thanks ${first} — I've found ${props.length} verified option${props.length > 1 ? 's' : ''} in ${lead.locations[0]} that fit: ${props.map((p) => p.title).join('; ')}. Would you like to see ${props.length > 1 ? 'them' : 'it'} this weekend?`;
  }
  return `Thanks ${first}. I don't have a verified listing that matches all of your requirements right now — I'll ask ${s.members.find((m) => m.id === lead.assignedTo)?.name.split(' ')[0] ?? 'a consultant'} to check new inventory and get back to you.`;
}
