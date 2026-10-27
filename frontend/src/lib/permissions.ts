import type { Role } from '@/store/types';

// Capabilities, not role-name checks scattered through the UI (PRD §8.1).
// The database (role_permissions + RLS) is the authority; this copy only shapes the UI.
// tests/permissions.test.ts fails if the two drift apart.
export type Capability =
  | 'leads.view'
  | 'leads.edit'
  | 'leads.edit_any'
  | 'leads.assign'
  | 'leads.import'
  | 'leads.export'
  | 'leads.merge'
  | 'contacts.edit'
  | 'properties.edit'
  | 'properties.verify'
  | 'deals.edit'
  | 'appointments.edit'
  | 'tasks.edit'
  | 'inbox.reply'
  | 'calls.place'
  | 'calls.recordings'
  | 'agents.manage'
  | 'workflows.manage'
  | 'approvals.decide'
  | 'outbound.kill'
  | 'logs.view'
  | 'usage.view'
  | 'marketing.view'
  | 'team.view'
  | 'team.manage'
  | 'finance.view'
  | 'finance.edit'
  | 'reports.view'
  | 'documents.edit'
  | 'documents.restricted'
  | 'integrations.manage'
  | 'audit.view'
  | 'settings.manage';

export const MATRIX: Record<Role, Capability[]> = {
  owner: ['leads.view', 'leads.edit', 'leads.edit_any', 'leads.assign', 'leads.import', 'leads.export', 'leads.merge', 'contacts.edit', 'properties.edit', 'properties.verify', 'deals.edit', 'appointments.edit', 'tasks.edit', 'inbox.reply', 'calls.place', 'calls.recordings', 'agents.manage', 'workflows.manage', 'approvals.decide', 'outbound.kill', 'logs.view', 'usage.view', 'marketing.view', 'team.view', 'team.manage', 'finance.view', 'finance.edit', 'reports.view', 'documents.edit', 'documents.restricted', 'integrations.manage', 'audit.view', 'settings.manage'],
  admin: ['leads.view', 'leads.edit', 'leads.edit_any', 'leads.assign', 'leads.import', 'leads.export', 'leads.merge', 'contacts.edit', 'properties.edit', 'properties.verify', 'deals.edit', 'appointments.edit', 'tasks.edit', 'inbox.reply', 'calls.place', 'calls.recordings', 'agents.manage', 'workflows.manage', 'approvals.decide', 'outbound.kill', 'logs.view', 'usage.view', 'marketing.view', 'team.view', 'team.manage', 'finance.view', 'reports.view', 'documents.edit', 'documents.restricted', 'integrations.manage', 'audit.view', 'settings.manage'],
  manager: ['leads.view', 'leads.edit', 'leads.edit_any', 'leads.assign', 'leads.import', 'leads.export', 'leads.merge', 'contacts.edit', 'properties.edit', 'properties.verify', 'deals.edit', 'appointments.edit', 'tasks.edit', 'inbox.reply', 'calls.place', 'calls.recordings', 'approvals.decide', 'logs.view', 'usage.view', 'marketing.view', 'team.view', 'reports.view', 'documents.edit'],
  agent: ['leads.view', 'leads.edit', 'contacts.edit', 'properties.edit', 'deals.edit', 'appointments.edit', 'tasks.edit', 'inbox.reply', 'calls.place', 'documents.edit'],
  operations: ['leads.view', 'leads.edit', 'leads.edit_any', 'contacts.edit', 'properties.edit', 'properties.verify', 'appointments.edit', 'tasks.edit', 'logs.view', 'team.view', 'documents.edit', 'audit.view'],
  finance: ['leads.view', 'finance.view', 'finance.edit', 'usage.view', 'reports.view', 'audit.view', 'marketing.view'],
  viewer: ['leads.view', 'reports.view'],
};

export function can(role: Role, cap: Capability): boolean {
  return MATRIX[role].includes(cap);
}

export const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  manager: 'Manager',
  agent: 'Agent',
  operations: 'Operations',
  finance: 'Finance',
  viewer: 'Read-only',
};

export const ROLE_DESC: Record<Role, string> = {
  owner: 'Full control, billing and sensitive configuration',
  admin: 'Settings, users, integrations and operations',
  manager: 'Team data, assignment, pipelines and approvals',
  agent: 'Assigned leads, conversations, visits and tasks',
  operations: 'Inventory, verification and operational records',
  finance: 'Commissions, expenses and cost reports',
  viewer: 'Read-only access to permitted records',
};
