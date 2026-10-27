// One async API for pages. Live mode calls Supabase; demo mode (no backend configured, explicitly
// chosen by the user) uses the local sample store. Pages never branch on the mode for writes.
import * as live from '@/backend/live';
import { ApiError, toApiError } from '@/backend/errors';
import { LIVE, useStore } from '@/store/store';
import { toast } from '@/store/ui';
import { findDuplicates } from '@/lib/domain';
import type { Channel, ConsentState, Deal, DealStage, Lead, LeadStatus, Organization, Property, Role, Task } from '@/store/types';

export { LIVE };
export type { CreateLeadInput, CreateLeadResult, BookInput } from '@/backend/live';

const s = () => useStore.getState();

type BookResult =
  | { ok: true; appointmentId: string }
  | { ok: false; conflictTitle: string; alternatives: number[] };

export const actions = {
  async createLead(input: live.CreateLeadInput, onDuplicate: 'ask' | 'link' | 'create'): Promise<live.CreateLeadResult> {
    if (LIVE) return live.createLead(input, onDuplicate);
    if (onDuplicate === 'ask' && !input.existingContactId) {
      const d = findDuplicates({ phone: input.phone, email: input.email }, s().contacts.filter((c) => c.orgId === s().session.orgId));
      if (d.length) return { status: 'duplicate', candidates: d.map((x) => ({ contactId: x.contact.id, name: x.contact.name, reasons: x.reasons })) };
    }
    const existing = onDuplicate === 'link' && !input.existingContactId
      ? findDuplicates({ phone: input.phone, email: input.email }, s().contacts.filter((c) => c.orgId === s().session.orgId))[0]?.contact.id
      : input.existingContactId;
    const lead = s().createLead({ ...input, existingContactId: existing ?? null });
    return { status: 'created', lead, leadId: lead.id };
  },
  async updateLead(id: string, patch: Partial<Lead>) {
    if (LIVE) return live.updateLead(id, patch);
    s().updateLead(id, patch);
  },
  async setLeadStatus(id: string, status: LeadStatus, reason?: string) {
    if (LIVE) return live.setLeadStatus(id, status, reason);
    s().setLeadStatus(id, status, reason);
  },
  async assignLeads(ids: string[], memberId: string | null) {
    if (LIVE) return live.assignLeads(ids, memberId);
    s().assignLeads(ids, memberId);
  },
  async archiveLeads(ids: string[], archived: boolean) {
    if (LIVE) return live.archiveLeads(ids, archived);
    s().archiveLeads(ids, archived);
  },
  async mergeLeads(keep: string, drop: string) {
    if (LIVE) return live.mergeLeads(keep, drop);
    s().mergeLeads(keep, drop);
  },
  async addNote(leadId: string, body: string) {
    if (LIVE) return live.addNote(leadId, body);
    s().addNote(leadId, body);
  },
  async importLeads(rows: Record<string, string>[]) {
    if (LIVE) return live.importLeads(rows);
    return s().importLeads(rows);
  },
  async updateContact(id: string, patch: { name?: string; phone?: string; email?: string; preferredChannel?: Channel }) {
    if (LIVE) return live.updateContact(id, patch);
    s().updateContact(id, patch);
  },
  async setConsent(contactId: string, channel: Channel, state: ConsentState, source?: string) {
    if (LIVE) return live.setConsent(contactId, channel, state, source);
    s().setConsent(contactId, channel, state, source);
  },
  async optOutAll(contactId: string) {
    if (LIVE) return live.optOutAll(contactId);
    s().optOutAll(contactId);
  },
  async saveProperty(p: Partial<Property> & { id?: string }): Promise<Property> {
    if (LIVE) return live.saveProperty(p);
    return s().saveProperty(p);
  },
  async verifyProperty(id: string) {
    if (LIVE) return live.verifyProperty(id);
    s().verifyProperty(id);
  },
  async createDeal(d: Omit<Deal, 'id' | 'orgId' | 'createdAt' | 'stageChangedAt' | 'lostReason'>): Promise<Deal> {
    if (LIVE) return live.createDeal(d);
    return s().createDeal(d);
  },
  async moveDeal(id: string, stage: DealStage, lostReason?: string) {
    if (LIVE) return live.moveDeal(id, stage, lostReason);
    s().moveDeal(id, stage, lostReason);
  },
  async updateDeal(id: string, patch: Partial<Deal>) {
    if (LIVE) return live.updateDeal(id, patch);
    s().updateDeal(id, patch);
  },
  async bookAppointment(a: live.BookInput): Promise<BookResult> {
    if (LIVE) {
      const r = await live.bookAppointment(a);
      return r.ok ? { ok: true, appointmentId: r.appointment.id } : { ok: false, conflictTitle: r.conflictTitle, alternatives: r.alternatives };
    }
    const r = s().bookAppointment({ ...a, source: 'user' });
    return r.ok ? { ok: true, appointmentId: r.appointment.id } : { ok: false, conflictTitle: r.conflict.title, alternatives: r.alternatives };
  },
  async setAppointmentStatus(id: string, status: 'confirmed' | 'completed' | 'cancelled' | 'no_show', extra?: { reason?: string; feedback?: string }) {
    if (LIVE) return live.setAppointmentStatus(id, status, extra);
    s().setAppointmentStatus(id, status, extra);
  },
  async rescheduleAppointment(id: string, start: number, end: number): Promise<{ ok: boolean; conflictTitle?: string }> {
    if (LIVE) return live.rescheduleAppointment(id, start, end);
    const r = s().rescheduleAppointment(id, start, end);
    return r.ok ? { ok: true } : { ok: false, conflictTitle: r.conflict?.title };
  },
  async saveTask(t: Partial<Task> & { title: string }): Promise<Task> {
    if (LIVE) return live.saveTask(t);
    return s().saveTask(t);
  },
  async setTaskStatus(id: string, status: Task['status']) {
    if (LIVE) return live.setTaskStatus(id, status);
    s().setTaskStatus(id, status);
  },
  /** Returns an invite link in live mode (email delivery is not configured yet). */
  async inviteMember(email: string, role: Role, name?: string): Promise<string | null> {
    if (LIVE) return live.inviteMember(email, role);
    const r = s().inviteMember(email, role, name);
    if (!r.ok) throw new ApiError('VALIDATION_ERROR', r.error ?? 'Could not invite');
    return null;
  },
  async changeRole(id: string, role: Role) {
    if (LIVE) return live.changeRole(id, role);
    const r = s().changeRole(id, role);
    if (!r.ok) throw new ApiError('FORBIDDEN', r.error ?? 'Role not changed');
  },
  async setMemberStatus(id: string, status: 'active' | 'suspended') {
    if (LIVE) return live.setMemberStatus(id, status);
    const r = s().setMemberStatus(id, status);
    if (!r.ok) throw new ApiError('FORBIDDEN', r.error ?? 'Not changed');
  },
  async updateOrg(org: Organization, patch: Partial<Organization>) {
    if (LIVE) return live.updateOrg(org, patch);
    s().updateOrg(patch);
  },
  async setOutboundPaused(org: Organization, paused: boolean) {
    if (LIVE) return live.updateOrg(org, { outboundPaused: paused });
    s().setOutboundPaused(paused);
  },
  async markNotification(id: string) {
    if (LIVE) return live.markNotification(id);
    s().markNotification(id);
  },
  async markAllNotifications() {
    if (LIVE) return live.markAllNotifications();
    s().markAllNotifications();
  },
  async advanceCommission(id: string, to: 'approved' | 'payable' | 'paid' | 'void') {
    if (LIVE) return live.advanceCommission(id, to);
    s().advanceCommission(id, to);
  },
};

/**
 * Runs a backend action; on failure shows a readable toast and returns undefined.
 * Pages use this so every write reports success or failure honestly.
 */
export async function attempt<T>(fn: () => Promise<T>, onError?: (message: string) => void): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    reportError(e, onError);
    return undefined;
  }
}

/** Like attempt, for actions without a result: true when the server accepted the change. */
export async function ok(fn: () => Promise<unknown>, onError?: (message: string) => void): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (e) {
    reportError(e, onError);
    return false;
  }
}

function reportError(e: unknown, onError?: (message: string) => void) {
  const err = toApiError(e);
  if (onError) onError(err.message);
  else toast({ kind: 'error', title: titleFor(err.code), body: err.message });
}

function titleFor(code: string) {
  switch (code) {
    case 'FORBIDDEN':
      return 'Not allowed';
    case 'VALIDATION_ERROR':
      return 'Check the details';
    case 'NETWORK':
      return 'Connection problem';
    case 'UNAUTHENTICATED':
      return 'Signed out';
    case 'INVALID_TRANSITION':
      return 'Not possible from this stage';
    default:
      return 'Couldn’t save';
  }
}
