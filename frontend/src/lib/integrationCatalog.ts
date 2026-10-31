// The integrations marketplace catalog: every tool a client can connect from Settings → Integrations. Pure data, no
// network calls. `authType` decides how Connect behaves in features/integrations.tsx:
//   - 'api_key'  self-serve: the user pastes a key, token or webhook URL; it is stored in the database Vault and the
//                integration is marked connected. Real and working in both demo and live mode — but see the note below.
//   - 'oauth'    needs a provider OAuth app (client id/secret) registered by the agency's developer first. Demo mode
//                simulates a successful consent so the product can be shown end to end; live mode says plainly that
//                setup is still needed, rather than faking a connection.
//   - 'env'      configured once, on the server, by a developer (an environment secret). Shown for context; nothing
//                to connect here.
// No provider adapter exists yet for messaging, email or calendar delivery (see _shared/follow-up-delivery.ts and
// _shared/calendar-sync.ts) — connecting one of those here only changes what this page shows; it cannot send a
// message, place a call or write to a calendar until a developer wires a real adapter.

export type IntegrationCategory = 'lead_source' | 'voice' | 'messaging' | 'email' | 'calendar' | 'productivity' | 'marketing' | 'payments' | 'esignature' | 'ai' | 'automation';
export type AuthType = 'api_key' | 'oauth' | 'env';

export interface CatalogEntry {
  /** Stable id, also the `provider` value stored in the database. Must match the demo seed's provider name exactly. */
  id: string;
  name: string;
  /** Primary category: drives the icon and the database `integration_type`. */
  category: IntegrationCategory;
  /** Every category this tool should appear under when filtering (defaults to [category]). */
  tags?: IntegrationCategory[];
  authType: AuthType;
  blurb: string;
  capabilities: string[];
  /** oauth: permissions requested at consent. api_key: what the credential grants. */
  scopes: string[];
  /** api_key only: the form field's label and placeholder. */
  keyLabel?: string;
  keyPlaceholder?: string;
  /** env only: the server environment variable(s) a developer sets. */
  envVar?: string;
  /** oauth only: one line on what a developer still needs to configure. */
  setupNote?: string;
  alwaysOn?: boolean;
}

export const CATEGORY_LABEL: Record<IntegrationCategory, string> = {
  lead_source: 'Lead sources', voice: 'Voice', messaging: 'Messaging', email: 'Email', calendar: 'Calendar',
  productivity: 'Productivity', marketing: 'Marketing', payments: 'Payments', esignature: 'E-signature', ai: 'AI', automation: 'Automation',
};

export const INTEGRATION_CATALOG: CatalogEntry[] = [
  // ── Lead sources ──────────────────────────────────────────────────────────
  { id: 'Website form', name: 'Website form', category: 'lead_source', authType: 'env', alwaysOn: true,
    blurb: 'Built into every workspace — no setup needed.', capabilities: ['Lead intake', 'Spam scoring'], scopes: [],
    envVar: 'Built into Estate OS — nothing to configure' },
  { id: 'Zillow', name: 'Zillow', category: 'lead_source', authType: 'api_key',
    blurb: 'Premier Agent leads via partner API.', capabilities: ['Lead intake'], scopes: ['leads:read'],
    keyLabel: 'Premier Agent API key', keyPlaceholder: 'Paste the key from your Zillow partner dashboard' },
  { id: 'Realtor.com', name: 'Realtor.com', category: 'lead_source', authType: 'api_key',
    blurb: 'Connections Plus lead feed.', capabilities: ['Lead intake'], scopes: ['leads:read'],
    keyLabel: 'Feed API key', keyPlaceholder: 'From your Realtor.com Connections dashboard' },
  { id: 'Redfin', name: 'Redfin', category: 'lead_source', authType: 'api_key',
    blurb: 'Partner agent referrals.', capabilities: ['Lead intake'], scopes: ['leads:read'],
    keyLabel: 'Partner API key', keyPlaceholder: 'From your Redfin Partner Program account' },
  { id: 'Trulia', name: 'Trulia', category: 'lead_source', authType: 'api_key',
    blurb: 'Buyer and renter inquiries.', capabilities: ['Lead intake'], scopes: ['leads:read'],
    keyLabel: 'API key', keyPlaceholder: 'From your Trulia advertiser account' },
  { id: 'Apartments.com', name: 'Apartments.com', category: 'lead_source', authType: 'api_key',
    blurb: 'Rental inquiries for listed units.', capabilities: ['Lead intake'], scopes: ['leads:read'],
    keyLabel: 'API key', keyPlaceholder: 'From your Apartments.com advertiser account' },
  { id: 'Meta Lead Ads', name: 'Meta Lead Ads', category: 'lead_source', authType: 'oauth',
    blurb: 'Instant-form leads from Facebook and Instagram.', capabilities: ['Lead intake', 'Campaign attribution'], scopes: ['leads_retrieval', 'pages_show_list'],
    setupNote: 'Needs a Meta developer app with Lead Ads access, reviewed by Meta.' },
  { id: 'Google Lead Form Ads', name: 'Google Lead Form Ads', category: 'lead_source', authType: 'oauth',
    blurb: 'Lead form extensions from Google Ads campaigns.', capabilities: ['Lead intake', 'Campaign attribution'], scopes: ['adwords.leads'],
    setupNote: 'Needs a Google Ads developer token and an OAuth app approved for production access.' },

  // ── Voice ─────────────────────────────────────────────────────────────────
  { id: 'Retell AI Voice', name: 'Retell AI Voice', category: 'voice', authType: 'env',
    blurb: 'Outbound and inbound AI calling with recording.', capabilities: ['Outbound calls', 'Inbound calls', 'Recording', 'Status webhooks'], scopes: [],
    envVar: 'Set as a server secret by your developer (ask them for the exact name).' },

  // ── Messaging ─────────────────────────────────────────────────────────────
  { id: 'Twilio SMS', name: 'Twilio SMS', category: 'messaging', authType: 'api_key',
    blurb: 'Two-way texting from a registered 10DLC number.', capabilities: ['Send', 'Receive', 'Opt-out handling', 'Delivery receipts'], scopes: ['messages:write', 'messages:read'],
    keyLabel: 'Account SID and Auth Token', keyPlaceholder: 'ACxxxxxxxx:your_auth_token' },
  { id: 'WhatsApp Business', name: 'WhatsApp Business', category: 'messaging', authType: 'api_key',
    blurb: 'Official Cloud API with approved templates.', capabilities: ['Send', 'Receive', 'Templates', 'Delivery receipts'], scopes: ['whatsapp_business_messaging'],
    keyLabel: 'Access token', keyPlaceholder: 'From Meta Business → WhatsApp → API setup' },
  { id: 'Slack', name: 'Slack', category: 'messaging', authType: 'api_key',
    blurb: 'Post lead alerts and daily briefings to a channel.', capabilities: ['Post alerts'], scopes: ['incoming-webhook'],
    keyLabel: 'Incoming webhook URL', keyPlaceholder: 'https://hooks.slack.com/services/…' },

  // ── Email & calendar ──────────────────────────────────────────────────────
  { id: 'Google Workspace', name: 'Google Workspace', category: 'email', tags: ['email', 'calendar', 'productivity'], authType: 'oauth',
    blurb: 'Gmail, Calendar, Drive, Sheets, Contacts and Meet in one sign-in.', capabilities: ['Send', 'Receive', 'Calendar sync', 'Drive files', 'Sheets export', 'Contacts'],
    scopes: ['gmail.send', 'gmail.readonly', 'calendar.events', 'drive.file', 'spreadsheets', 'contacts.readonly'],
    setupNote: 'Needs a Google Cloud OAuth client (id and secret) verified for these scopes.' },
  { id: 'Microsoft 365', name: 'Microsoft 365', category: 'email', tags: ['email', 'calendar', 'productivity'], authType: 'oauth',
    blurb: 'Outlook mail, calendar and Teams in one sign-in.', capabilities: ['Send', 'Receive', 'Calendar sync', 'Teams meetings'],
    scopes: ['Mail.Send', 'Mail.Read', 'Calendars.ReadWrite', 'OnlineMeetings.ReadWrite'],
    setupNote: 'Needs a Microsoft Entra app registration with these Graph permissions granted.' },
  { id: 'Postmark', name: 'Postmark', category: 'email', authType: 'api_key',
    blurb: 'Transactional email and inbound parsing.', capabilities: ['Send', 'Receive'], scopes: ['send', 'inbound'],
    keyLabel: 'Server API token', keyPlaceholder: 'From your Postmark server’s API Tokens tab' },
  { id: 'Calendly', name: 'Calendly', category: 'calendar', authType: 'api_key',
    blurb: 'Share a booking link and pull confirmed times in.', capabilities: ['Availability', 'Event sync'], scopes: ['default'],
    keyLabel: 'Personal access token', keyPlaceholder: 'From Calendly → Integrations → API & Webhooks' },

  // ── Productivity ──────────────────────────────────────────────────────────
  { id: 'Zoom', name: 'Zoom', category: 'productivity', authType: 'oauth',
    blurb: 'Create video meeting links for virtual showings.', capabilities: ['Create meetings'], scopes: ['meeting:write'],
    setupNote: 'Needs a Zoom OAuth app (client id and secret) from the Zoom App Marketplace.' },
  { id: 'Dropbox', name: 'Dropbox', category: 'productivity', authType: 'api_key',
    blurb: 'Back up contracts and brochures to a shared folder.', capabilities: ['Upload files'], scopes: ['files.content.write'],
    keyLabel: 'Access token', keyPlaceholder: 'A generated access token from the Dropbox App Console' },
  { id: 'Notion', name: 'Notion', category: 'productivity', authType: 'api_key',
    blurb: 'Mirror listings or tasks into a Notion workspace.', capabilities: ['Create pages'], scopes: ['insert'],
    keyLabel: 'Internal integration token', keyPlaceholder: 'secret_…' },

  // ── Marketing ─────────────────────────────────────────────────────────────
  { id: 'Mailchimp', name: 'Mailchimp', category: 'marketing', authType: 'api_key',
    blurb: 'Sync contacts to an email marketing audience.', capabilities: ['Sync contacts', 'Campaign stats'], scopes: ['audience:write'],
    keyLabel: 'API key', keyPlaceholder: 'From Mailchimp → Account → Extras → API keys' },
  { id: 'HubSpot', name: 'HubSpot', category: 'marketing', authType: 'api_key',
    blurb: 'Two-way contact and deal sync with HubSpot CRM.', capabilities: ['Sync contacts', 'Sync deals'], scopes: ['crm.objects.contacts', 'crm.objects.deals'],
    keyLabel: 'Private app access token', keyPlaceholder: 'From a HubSpot private app' },

  // ── Payments ──────────────────────────────────────────────────────────────
  { id: 'Stripe', name: 'Stripe', category: 'payments', authType: 'api_key',
    blurb: 'Collect application or deposit payments.', capabilities: ['Create payment links'], scopes: ['payment_links:write'],
    keyLabel: 'Restricted API key', keyPlaceholder: 'rk_live_… — create one scoped to Payment Links only' },
  { id: 'QuickBooks', name: 'QuickBooks', category: 'payments', authType: 'oauth',
    blurb: 'Send paid commissions to your books.', capabilities: ['Create invoices', 'Sync payments'], scopes: ['com.intuit.quickbooks.accounting'],
    setupNote: 'Needs an Intuit developer app (client id and secret).' },

  // ── E-signature ───────────────────────────────────────────────────────────
  { id: 'DocuSign', name: 'DocuSign', category: 'esignature', authType: 'oauth',
    blurb: 'Send agreements for signature and track status.', capabilities: ['Send for signature', 'Status webhooks'], scopes: ['signature'],
    setupNote: 'Needs a DocuSign integration key (client id and secret) from your DocuSign developer account.' },

  // ── AI & automation ───────────────────────────────────────────────────────
  { id: 'Anthropic', name: 'Anthropic', category: 'ai', authType: 'env',
    blurb: 'Model provider for the 8 AI agents (no training on customer data).', capabilities: ['Extraction', 'Drafting', 'Summaries'], scopes: [],
    envVar: 'Set as a server secret by your developer (ask them for the exact name).' },
  { id: 'n8n', name: 'n8n', category: 'automation', authType: 'env',
    blurb: 'Connector-heavy workflows with run tracking, for anything not built in.', capabilities: ['Integration alerts'], scopes: [],
    envVar: 'Configured by your developer, outside this page' },
];

export const catalogEntry = (id: string): CatalogEntry | undefined => INTEGRATION_CATALOG.find((c) => c.id === id);

/** A connection row, normalised from either the demo store's Integration[] or live.IntegrationRow[]. */
export interface ConnRow {
  id: string;
  provider: string;
  status: 'connected' | 'disconnected' | 'error' | 'needs_reauth' | 'paused';
  scopes: string[];
  lastSync: number | null;
  error: string | null;
}

export interface MergedEntry { cat: CatalogEntry; row: ConnRow | null }

/** Every catalog entry, in catalog order, joined to its connection row (if any) by provider name. */
export function mergeCatalog(rows: ConnRow[]): MergedEntry[] {
  const byProvider = new Map(rows.map((r) => [r.provider, r]));
  return INTEGRATION_CATALOG.map((cat) => ({ cat, row: byProvider.get(cat.id) ?? null }));
}

/** Whether an entry matches the category filter ('all' or one tag) and a free-text search of name/blurb/capabilities. */
export function matchesFilter(cat: CatalogEntry, category: IntegrationCategory | 'all', query: string): boolean {
  if (category !== 'all' && !(cat.tags ?? [cat.category]).includes(category)) return false;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return cat.name.toLowerCase().includes(q) || cat.blurb.toLowerCase().includes(q) || cat.capabilities.some((c) => c.toLowerCase().includes(q));
}

/** Categories actually present in the catalog, in CATEGORY_LABEL's declared order. */
export const CATALOG_CATEGORIES: IntegrationCategory[] = (Object.keys(CATEGORY_LABEL) as IntegrationCategory[])
  .filter((cat) => INTEGRATION_CATALOG.some((c) => (c.tags ?? [c.category]).includes(cat)));

// The frontend's 'voice' reads better in this UI than the database's historical 'telephony'; everything else matches
// public.integrations' integration_type check constraint (migration 0030) one for one.
const DB_INTEGRATION_TYPE: Record<IntegrationCategory, string> = {
  lead_source: 'lead_source', voice: 'telephony', messaging: 'messaging', email: 'email', calendar: 'calendar',
  productivity: 'productivity', marketing: 'marketing', payments: 'payments', esignature: 'esignature', ai: 'ai', automation: 'automation',
};
export const dbIntegrationType = (category: IntegrationCategory): string => DB_INTEGRATION_TYPE[category];

