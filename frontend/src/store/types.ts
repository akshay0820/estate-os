// Domain model. Mirrors DATABASE_SCHEMA.md, trimmed to what the client renders.
// Timestamps are epoch milliseconds (UTC); money is integer rupees.

export type ID = string;

export type Role = 'owner' | 'admin' | 'manager' | 'agent' | 'operations' | 'finance' | 'viewer';
export type Channel = 'phone' | 'whatsapp' | 'sms' | 'email';
export type ConsentState = 'granted' | 'unknown' | 'denied' | 'revoked';
export type ActorType = 'user' | 'ai_agent' | 'workflow' | 'system' | 'integration';

export interface Actor {
  type: ActorType;
  name: string;
  id?: ID;
}

export interface Organization {
  id: ID;
  name: string;
  slug: string;
  city: string;
  timezone: string;
  /** ISO 4217 code from organizations.default_currency, e.g. USD or INR. */
  currency: string;
  /** ISO 3166 code from organizations.country_code; phones without a country code take its dialling code. */
  country: string;
  businessHours: { start: number; end: number; days: number[] };
  callingHours: { start: number; end: number };
  outboundPaused: boolean;
  leadStages: LeadStatus[];
  assignment: 'round_robin' | 'least_loaded' | 'by_locality';
  slaMinutes: number;
  webhookSecretVersion: number;
}

export interface Member {
  id: ID;
  orgId: ID;
  name: string;
  email: string;
  phone: string;
  role: Role;
  title: string;
  status: 'active' | 'invited' | 'suspended';
  hue: number;
  localities: string[];
  joinedAt: number;
}

export type LeadStatus =
  | 'new'
  | 'attempting'
  | 'contacted'
  | 'qualified'
  | 'matching'
  | 'visit_scheduled'
  | 'visit_completed'
  | 'negotiation'
  | 'won'
  | 'lost'
  | 'nurture';

export type LeadType = 'buyer' | 'seller' | 'tenant' | 'landlord' | 'investor';
export type Priority = 'low' | 'normal' | 'high' | 'urgent';
export type PropertyType = 'apartment' | 'villa' | 'penthouse' | 'plot' | 'office' | 'retail';

export interface Contact {
  id: ID;
  orgId: ID;
  name: string;
  email: string;
  phone: string;
  roles: LeadType[];
  preferredChannel: Channel;
  lifecycle: 'new' | 'active' | 'nurture' | 'client' | 'inactive' | 'do_not_contact';
  source: string;
  assignedTo: ID | null;
  consents: Record<Channel, ConsentState>;
  tags: string[];
  createdAt: number;
  lastContactedAt: number | null;
}

export interface Lead {
  id: ID;
  orgId: ID;
  contactId: ID;
  name: string;
  status: LeadStatus;
  priority: Priority;
  type: LeadType;
  source: string;
  campaign: string | null;
  assignedTo: ID | null;
  score: number;
  scoreReasons: string[];
  budgetMin: number | null;
  budgetMax: number | null;
  locations: string[];
  propertyType: PropertyType | null;
  bedrooms: number | null;
  timeline: string | null;
  intent: 'buy' | 'rent' | 'sell' | 'let' | 'invest';
  amenities: string[];
  aiFields: string[];
  missing: string[];
  summary: string | null;
  nextFollowUpAt: number | null;
  firstResponseAt: number | null;
  lastContactAt: number | null;
  lostReason: string | null;
  archived: boolean;
  /** Set by the Lead Intake Agent; absent for demo data and leads created before it existed. */
  intakeStatus?: 'completed' | 'review_required' | null;
  duplicateStatus?: 'unique' | 'linked_contact' | 'possible_duplicate' | 'resolved_distinct' | 'merged' | null;
  createdAt: number;
  updatedAt: number;
}

export interface Property {
  id: ID;
  orgId: ID;
  ref: string;
  title: string;
  description: string;
  listing: 'sale' | 'rent';
  type: PropertyType;
  status: 'draft' | 'active' | 'under_offer' | 'reserved' | 'sold' | 'let' | 'archived';
  price: number;
  bedrooms: number;
  bathrooms: number;
  area: number;
  locality: string;
  city: string;
  amenities: string[];
  furnishing: 'unfurnished' | 'semi' | 'full';
  verified: boolean;
  verifiedAt: number | null;
  agentId: ID | null;
  ownerContactId: ID | null;
  image: number;
  createdAt: number;
  updatedAt: number;
}

export type DealStage =
  | 'qualification'
  | 'viewing'
  | 'offer'
  | 'negotiation'
  | 'under_contract'
  | 'won'
  | 'lost';

export interface Deal {
  id: ID;
  orgId: ID;
  title: string;
  leadId: ID | null;
  contactId: ID;
  propertyId: ID | null;
  stage: DealStage;
  value: number;
  commissionPct: number;
  expectedClose: number;
  ownerId: ID | null;
  lostReason: string | null;
  createdAt: number;
  stageChangedAt: number;
}

export type AppointmentStatus =
  | 'requested'
  | 'pending'
  | 'confirmed'
  | 'completed'
  | 'cancelled'
  | 'no_show'
  | 'reschedule_requested';

export interface Appointment {
  id: ID;
  orgId: ID;
  title: string;
  type: 'viewing' | 'consultation' | 'valuation' | 'follow_up';
  status: AppointmentStatus;
  leadId: ID | null;
  contactId: ID | null;
  propertyId: ID | null;
  assignedTo: ID | null;
  start: number;
  end: number;
  location: string;
  source: 'user' | 'ai' | 'workflow';
  cancelReason: string | null;
  feedback: string | null;
  createdAt: number;
}

export interface Task {
  id: ID;
  orgId: ID;
  title: string;
  status: 'open' | 'in_progress' | 'completed' | 'cancelled';
  priority: Priority;
  dueAt: number;
  assignedTo: ID | null;
  related: { type: 'lead' | 'deal' | 'property' | 'contact'; id: ID } | null;
  source: 'manual' | 'workflow' | 'ai';
  createdAt: number;
  completedAt: number | null;
}

export interface Message {
  id: ID;
  direction: 'in' | 'out' | 'internal' | 'system';
  sender: 'contact' | 'user' | 'ai' | 'system';
  senderName: string;
  body: string;
  at: number;
  status: 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'received' | 'blocked';
}

export interface Conversation {
  id: ID;
  orgId: ID;
  contactId: ID;
  leadId: ID | null;
  channel: Channel;
  status: 'open' | 'pending' | 'resolved';
  owner: 'ai' | 'human' | 'unassigned';
  assignedTo: ID | null;
  unread: number;
  lastMessageAt: number;
  messages: Message[];
}

export type CallStatus =
  | 'queued'
  | 'initiating'
  | 'ringing'
  | 'in_progress'
  | 'completed'
  | 'no_answer'
  | 'busy'
  | 'failed'
  | 'cancelled'
  | 'needs_review'
  | 'blocked';

export interface Call {
  id: ID;
  orgId: ID;
  leadId: ID | null;
  contactId: ID;
  direction: 'inbound' | 'outbound';
  status: CallStatus;
  agentId: ID | null;
  userId: ID | null;
  startedAt: number;
  duration: number;
  cost: number;
  outcome: string | null;
  summary: string | null;
  extracted: Record<string, string> | null;
  recording: boolean;
  policyNote: string | null;
}

/** The eight agents the product ships (agent ids in the database: lead_intake_agent … sales_intelligence_agent). */
export type AgentType =
  | 'lead_intake'
  | 'voice_calling'
  | 'qualification'
  | 'property_matching'
  | 'follow_up'
  | 'appointment'
  | 'data_quality'
  | 'sales_intelligence';

export type Autonomy = 'suggest_only' | 'approval_required' | 'bounded_auto';

export interface Agent {
  id: ID;
  orgId: ID;
  name: string;
  type: AgentType;
  purpose: string;
  status: 'active' | 'paused' | 'draft';
  autonomy: Autonomy;
  tools: string[];
  channel: Channel | null;
  model: string;
  version: number;
  dailyBudget: number;
  maxSteps: number;
  escalation: string[];
  createdAt: number;
}

export interface WorkflowStepDef {
  key: string;
  label: string;
  kind: 'trigger' | 'condition' | 'action' | 'delay' | 'ai' | 'exit';
}

export interface Workflow {
  id: ID;
  orgId: ID;
  key: string;
  name: string;
  description: string;
  trigger: string;
  status: 'active' | 'paused' | 'draft';
  version: number;
  owner: 'app' | 'n8n';
  steps: WorkflowStepDef[];
  exitRules: string[];
  maxRetries: number;
}

export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'retrying'
  | 'dead_letter'
  | 'skipped';

export interface RunStep {
  label: string;
  status: 'ok' | 'fail' | 'run' | 'skip' | 'pending';
  ms: number;
  note?: string;
}

export interface Run {
  id: ID;
  orgId: ID;
  kind: 'agent' | 'workflow';
  refId: ID;
  name: string;
  status: RunStatus;
  trigger: string;
  startedAt: number;
  durationMs: number;
  cost: number;
  tokens: number;
  steps: RunStep[];
  leadId: ID | null;
  attempt: number;
  error: string | null;
  correlationId: string;
}

export interface Approval {
  id: ID;
  orgId: ID;
  action: string;
  summary: string;
  risk: 'low' | 'medium' | 'high' | 'critical';
  requestedBy: Actor;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  createdAt: number;
  expiresAt: number;
  decidedBy: string | null;
  decidedAt: number | null;
  note: string | null;
  payload: ApprovalPayload;
}

export type ApprovalPayload =
  | { kind: 'send_message'; conversationId: ID; body: string }
  | { kind: 'deal_stage'; dealId: ID; to: DealStage }
  | { kind: 'book_appointment'; leadId: ID; propertyId: ID | null; start: number }
  | { kind: 'bulk_export'; entity: string; rows: number }
  | { kind: 'commission'; commissionId: ID; to: Commission['status'] };

export interface FollowUp {
  id: ID;
  orgId: ID;
  leadId: ID;
  workflowId: ID;
  name: string;
  status: 'active' | 'paused' | 'stopped' | 'completed';
  steps: { label: string; channel: Channel | 'task'; at: number; status: 'done' | 'scheduled' | 'cancelled' | 'skipped' }[];
  stopReason: string | null;
  createdAt: number;
}

export interface Integration {
  id: ID;
  orgId: ID;
  provider: string;
  category: 'lead_source' | 'voice' | 'messaging' | 'email' | 'calendar' | 'ai' | 'automation';
  description: string;
  status: 'connected' | 'disconnected' | 'error' | 'needs_reauth' | 'paused';
  lastSync: number | null;
  error: string | null;
  scopes: string[];
  capabilities: string[];
}

export interface WebhookEvent {
  id: ID;
  orgId: ID;
  provider: string;
  type: string;
  status: 'processed' | 'duplicate' | 'failed' | 'retrying' | 'dead_letter' | 'rejected';
  receivedAt: number;
  attempts: number;
  error: string | null;
  idempotencyKey: string;
  signature: 'valid' | 'invalid';
}

export interface UsageRecord {
  orgId: ID;
  day: number;
  category: 'voice' | 'llm' | 'messaging';
  provider: string;
  agentId: ID | null;
  units: number;
  cost: number;
}

export interface Commission {
  id: ID;
  orgId: ID;
  dealId: ID;
  beneficiaryId: ID;
  gross: number;
  status: 'estimated' | 'approved' | 'payable' | 'paid' | 'void';
  createdAt: number;
  paidAt: number | null;
}

export interface Expense {
  id: ID;
  orgId: ID;
  category: 'marketing' | 'ai_usage' | 'telephony' | 'software' | 'operations';
  vendor: string;
  amount: number;
  date: number;
  status: 'pending' | 'paid';
}

export interface DocumentRec {
  id: ID;
  orgId: ID;
  name: string;
  kind: 'agreement' | 'id_proof' | 'title_deed' | 'floor_plan' | 'brochure' | 'invoice' | 'other';
  size: number;
  classification: 'general' | 'confidential' | 'restricted';
  related: { type: 'property' | 'deal' | 'contact'; id: ID } | null;
  uploadedBy: string;
  uploadedAt: number;
  status: 'ready' | 'processing' | 'failed';
  expiresAt: number | null;
}

export interface AuditLog {
  id: ID;
  orgId: ID;
  actor: Actor;
  action: string;
  entity: string;
  entityId: ID | null;
  at: number;
  meta: string | null;
}

export interface Activity {
  id: ID;
  orgId: ID;
  leadId: ID | null;
  contactId: ID | null;
  dealId: ID | null;
  kind:
    | 'created'
    | 'status'
    | 'assigned'
    | 'call'
    | 'message'
    | 'note'
    | 'appointment'
    | 'property_sent'
    | 'ai_update'
    | 'opt_out'
    | 'deal'
    | 'task'
    | 'workflow'
    | 'updated';
  title: string;
  body: string | null;
  actor: Actor;
  at: number;
}

export interface Notification {
  id: ID;
  orgId: ID;
  kind: 'lead' | 'appointment' | 'failure' | 'approval' | 'task' | 'system';
  title: string;
  body: string;
  at: number;
  read: boolean;
  link: string | null;
}

export interface MarketingSource {
  id: ID;
  orgId: ID;
  key: string;
  name: string;
  kind: 'portal' | 'ads' | 'website' | 'referral' | 'offline';
  monthlySpend: number;
  active: boolean;
}
