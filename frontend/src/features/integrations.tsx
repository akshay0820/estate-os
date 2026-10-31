// Integrations: the lead-intake webhook (unchanged, fully live), plus a marketplace of tools a client can connect —
// Google Workspace, Microsoft 365, lead portals, messaging, calendars, marketing, payments, e-signature and more.
// Self-serve (authType 'api_key') tools store their credential in the database Vault via integration_connect_api_key
// (migration 0030) and are genuinely connected right now. OAuth tools need a developer to register a provider app
// first — this page says so plainly rather than faking a connection. See lib/integrationCatalog.ts for the full list
// and CLAUDE.md's "Workspace assistant" / "Automations" notes for why a connected row alone never sends anything.
import { useMemo, useState, type ReactNode } from 'react';
import {
  Bot, Calendar, CheckCircle2, Copy, CreditCard, FileSignature, Info, KeyRound, Link2, Mail, Megaphone,
  MessageCircle, Phone, Plug, RefreshCw, RotateCw, ShieldAlert, Unplug, Webhook,
  Workflow as WorkflowIcon, Zap, type LucideIcon,
} from 'lucide-react';
import { Badge, Button, Card, Empty, Field, Input, Modal, PageHeader, SearchInput } from '@/components/ui';
import { confirm } from '@/components/dialogs';
import { useStore } from '@/store/store';
import { useCan, useOrg, useOrgList } from '@/store/hooks';
import { toast } from '@/store/ui';
import { relTime } from '@/lib/format';
import { cx, maskSecret } from '@/lib/util';
import { LIVE, attempt } from '@/data/actions';
import * as live from '@/backend/live';
import {
  CATALOG_CATEGORIES, CATEGORY_LABEL, INTEGRATION_CATALOG, dbIntegrationType, matchesFilter, mergeCatalog,
  type CatalogEntry, type ConnRow, type IntegrationCategory, type MergedEntry,
} from '@/lib/integrationCatalog';
import { useServerQuery } from '@/data/useServerQuery';
import type { Integration, WebhookEvent } from '@/store/types';

const CAT_ICON: Record<IntegrationCategory, LucideIcon> = {
  lead_source: Webhook, voice: Phone, messaging: MessageCircle, email: Mail, calendar: Calendar,
  productivity: WorkflowIcon, marketing: Megaphone, payments: CreditCard, esignature: FileSignature, ai: Bot, automation: WorkflowIcon,
};
const STATUS_TONE = { connected: 'success', disconnected: 'neutral', error: 'danger', needs_reauth: 'warning', paused: 'warning' } as const;
const EVT_TONE = { processed: 'success', duplicate: 'info', failed: 'danger', retrying: 'warning', dead_letter: 'danger', rejected: 'danger' } as const;

export function IntegrationsPage() {
  return LIVE ? <LiveIntegrations /> : <DemoIntegrations />;
}

/* ─────────────────────────── live mode ─────────────────────────── */

function LiveIntegrations() {
  const events = useOrgList('webhookEvents');
  const org = useOrg();
  const canManage = useCan('integrations.manage');
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<CatalogEntry | null>(null);
  const endpoint = live.intakeEndpoint(org.slug);
  const hasSecret = org.webhookSecretVersion > 0;
  const sample = `curl -X POST '${endpoint}' \
  -H 'Content-Type: application/json' \
  -H 'X-Estate-Event-Id: evt_123' \
  -H 'X-Estate-Timestamp: <unix seconds>' \
  -H 'X-Estate-Signature: sha256=<hex HMAC of "timestamp.body">' \
  -d '{"name":"Emma Carter","phone":"(512) 555-0142","source":"Website form","locations":["Downtown"]}'`;

  const q = useServerQuery(canManage, () => live.integrations(), []);
  const merged = useMemo(() => mergeCatalog((q.data ?? []).map(toConnRowLive)), [q.data]);

  const connectApiKey = async (cat: CatalogEntry, credential: string) => {
    const r = await attempt(() => live.connectIntegrationApiKey(cat.id, dbIntegrationType(cat.category), cat.name, credential, cat.scopes));
    if (r) { toast({ kind: 'success', title: `${cat.name} connected`, body: 'The credential is stored in the database Vault, never in a plain column.' }); setOpen(null); q.reload(); }
    return !!r;
  };
  const disconnect = async (row: ConnRow, name: string) => {
    const c = await confirm({ title: `Disconnect ${name}?`, body: 'The connection stops being used. Its history stays on this page.', confirmLabel: 'Disconnect', danger: true });
    if (!c.ok) return;
    if (await attempt(() => live.disconnectIntegration(row.id)).then((x) => x !== undefined)) { toast({ kind: 'info', title: `${name} disconnected` }); setOpen(null); q.reload(); }
  };
  const check = async (row: ConnRow, name: string) => {
    const r = await attempt(() => live.checkIntegration(row.id));
    if (r) toast(r.ok ? { kind: 'success', title: `${name} is healthy`, body: 'The stored credential still reads back fine.' } : { kind: 'error', title: `${name} needs attention`, body: 'The stored credential could not be read — reconnect it.' });
    q.reload();
  };

  return (
    <div className="page">
      <PageHeader
        eyebrow={`[ ${merged.filter((m) => m.row?.status === 'connected').length} connected · ${INTEGRATION_CATALOG.length} tools available ]`}
        title="Integrations"
        sub="Send leads from any portal, ad platform or website form, and connect the rest of your stack. Credentials live in the database vault and are shown once."
      />
      <Card title="Lead intake webhook" icon={<Link2 size={14} />} sub="POST JSON signed with HMAC-SHA256. Repeated event IDs are ignored, so retries never create duplicates.">
        <div className="grid g-2" style={{ gap: 12 }}>
          <div>
            <div className="field-label" style={{ marginBottom: 6 }}>Endpoint</div>
            <div className="code"><span>{endpoint}</span><Button size="xs" variant="ghost" iconOnly icon={<Copy size={13} />} aria-label="Copy endpoint" onClick={() => { void navigator.clipboard?.writeText(endpoint); toast({ kind: 'success', title: 'Endpoint copied' }); }} /></div>
          </div>
          <div>
            <div className="field-label" style={{ marginBottom: 6 }}>Signing secret {hasSecret && `· v${org.webhookSecretVersion}`}</div>
            <div className="code">
              <span>{hasSecret ? 'whsec_' + '•'.repeat(24) : 'Not generated yet — intake is disabled'}</span>
              {canManage && <Button size="xs" loading={busy} icon={<KeyRound size={12} />} onClick={async () => {
                if (hasSecret) {
                  const r = await confirm({ title: 'Rotate signing secret?', body: 'The old secret stops working immediately. Update every sender with the new one.', confirmLabel: 'Rotate', danger: true });
                  if (!r.ok) return;
                }
                setBusy(true);
                const s = await attempt(() => live.rotateWebhookSecret());
                setBusy(false);
                if (s) setSecret(s);
              }}>{hasSecret ? 'Rotate' : 'Generate'}</Button>}
            </div>
          </div>
        </div>
        <div className="mt-12">
          <div className="field-label" style={{ marginBottom: 6 }}>Example request</div>
          <pre className="code" style={{ height: 'auto', padding: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 11.5 }}>{sample}</pre>
        </div>
      </Card>

      {canManage ? (
        <Marketplace merged={merged} onOpen={setOpen} />
      ) : (
        <div className="card mt-16" style={{ padding: 18 }}>
          <h4 className="section-title">Connected tools</h4>
          <p className="faint" style={{ fontSize: 13 }}>Ask an owner or admin to view and connect integrations.</p>
        </div>
      )}

      <div className="card mt-16">
        <div className="row" style={{ padding: '14px 18px 6px' }}>
          <b>Event log</b>
          <span className="faint" style={{ fontSize: 12 }}>Last 100 deliveries</span>
          <Button size="sm" className="ml-auto" icon={<RefreshCw size={13} />} onClick={() => void attempt(() => live.refresh('webhookEvents', 'leads'))}>Refresh</Button>
        </div>
        <EventLog events={events} onReplay={() => undefined} canManage={false} />
      </div>

      {secret && (
        <Modal open onClose={() => setSecret(null)} title="Your signing secret" description="Copy it now — it won’t be shown again. Store it in the sender’s secret manager." footer={<Button variant="primary" onClick={() => setSecret(null)}>I’ve saved it</Button>}>
          <div className="code"><span>{secret}</span><Button size="xs" icon={<Copy size={12} />} onClick={() => { void navigator.clipboard?.writeText(secret); toast({ kind: 'success', title: 'Secret copied' }); }}>Copy</Button></div>
        </Modal>
      )}
      {open && (
        <ConnectModal
          entry={merged.find((m) => m.cat.id === open.id) ?? { cat: open, row: null }} mode="live" canManage={canManage}
          onClose={() => setOpen(null)} onConnectApiKey={(cred) => connectApiKey(open, cred)}
          onDisconnect={(row) => disconnect(row, open.name)} onCheck={(row) => check(row, open.name)}
        />
      )}
    </div>
  );
}

const toConnRowLive = (i: live.IntegrationRow): ConnRow => ({ id: i.id, provider: i.provider, status: i.status, scopes: i.scopes, lastSync: i.last_synced_at ? Date.parse(i.last_synced_at) : null, error: i.last_error });

/* ─────────────────────────── demo mode ─────────────────────────── */

function DemoIntegrations() {
  const integrations = useOrgList('integrations');
  const events = useOrgList('webhookEvents');
  const org = useOrg();
  const canManage = useCan('integrations.manage');
  const { setIntegrationStatus, connectIntegration, testIntegration, rotateWebhookSecret, simulateInboundLead, replayEvent } = useStore.getState();
  const [testing, setTesting] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [open, setOpen] = useState<CatalogEntry | null>(null);
  const endpoint = `https://api.estateos.com/v1/webhooks/leads/${org.slug}`;

  const merged = useMemo(() => mergeCatalog(integrations.map(toConnRowDemo)), [integrations]);
  const connected = merged.filter((m) => m.row?.status === 'connected').length;

  const test = async (row: ConnRow, name: string) => {
    setTesting(row.id);
    const ok = await testIntegration(row.id);
    setTesting(null);
    toast(ok ? { kind: 'success', title: `${name} is healthy`, body: 'Credentials valid · test event round-tripped.' } : { kind: 'error', title: `${name} test failed`, body: row.error ?? 'Reconnect to restore access.' });
  };

  return (
    <div className="page">
      <PageHeader
        eyebrow={`[ ${connected} connected · ${INTEGRATION_CATALOG.length} tools available ]`}
        title="Integrations"
        sub="Lead sources, voice, messaging, Google Workspace and the rest of your stack. Secrets stay server-side; this page only ever shows status, scopes and masked references."
        actions={canManage && <Button variant="accent" icon={<Zap size={15} />} onClick={() => void simulateInboundLead({ source: 'Generic webhook' })}>Send test lead</Button>}
      />
      <Card title="Lead intake webhook" icon={<Link2 size={14} />} sub="POST JSON signed with HMAC-SHA256 in the X-Estate-Signature header. Duplicate event IDs are ignored.">
        <div className="grid g-2" style={{ gap: 12 }}>
          <div>
            <div className="field-label" style={{ marginBottom: 6 }}>Endpoint</div>
            <div className="code"><span>{endpoint}</span><Button size="xs" variant="ghost" iconOnly icon={<Copy size={13} />} aria-label="Copy endpoint" onClick={() => { void navigator.clipboard?.writeText(endpoint); toast({ kind: 'success', title: 'Endpoint copied' }); }} /></div>
          </div>
          <div>
            <div className="field-label" style={{ marginBottom: 6 }}>Signing secret · v{org.webhookSecretVersion}</div>
            <div className="code"><span>{maskSecret('whsec_live_' + org.slug.replace(/-/g, '') + 'a91f')}</span>
              {canManage && <Button size="xs" icon={<KeyRound size={12} />} onClick={async () => {
                const r = await confirm({ title: 'Rotate signing secret?', body: 'A new secret is generated. The current one keeps working for 24 hours so senders can switch over.', confirmLabel: 'Rotate' });
                if (r.ok) setSecret(rotateWebhookSecret());
              }}>Rotate</Button>}
            </div>
          </div>
        </div>
        {canManage && (
          <div className="row wrap mt-12" style={{ gap: 6 }}>
            <span className="faint" style={{ fontSize: 12.5 }}>Try the pipeline:</span>
            <Button size="xs" onClick={() => void simulateInboundLead({ source: 'Generic webhook' })}>Valid lead</Button>
            <Button size="xs" onClick={() => void simulateInboundLead({ source: 'Generic webhook', duplicate: true })}>Repeat enquiry</Button>
            <Button size="xs" onClick={() => void simulateInboundLead({ source: 'Generic webhook', badSignature: true })}>Bad signature</Button>
          </div>
        )}
      </Card>

      <Marketplace merged={merged} onOpen={canManage ? setOpen : () => undefined} />

      <div className="card mt-16">
        <div className="row" style={{ padding: '14px 18px 6px' }}>
          <b>Event log</b>
          <span className="faint" style={{ fontSize: 12 }}>Last 100 deliveries</span>
        </div>
        <EventLog events={events} onReplay={(e) => replayEvent(e.id)} canManage={canManage} />
      </div>

      {secret && (
        <Modal open onClose={() => setSecret(null)} title="New signing secret" description="Copy it now — for security it won't be shown again." footer={<Button variant="primary" onClick={() => setSecret(null)}>I've saved it</Button>}>
          <div className="code"><span>{secret}</span><Button size="xs" icon={<Copy size={12} />} onClick={() => { void navigator.clipboard?.writeText(secret); toast({ kind: 'success', title: 'Secret copied' }); }}>Copy</Button></div>
        </Modal>
      )}
      {open && (
        <ConnectModal
          entry={merged.find((m) => m.cat.id === open.id) ?? { cat: open, row: null }} mode="demo" canManage={canManage} testing={testing === merged.find((m) => m.cat.id === open.id)?.row?.id}
          onClose={() => setOpen(null)}
          onConnectApiKey={() => { connectIntegration(open.id); setOpen(null); return Promise.resolve(true); }}
          onConnectOauthDemo={() => { connectIntegration(open.id); setOpen(null); }}
          onDisconnect={(row) => { setIntegrationStatus(row.id, 'disconnected'); toast({ kind: 'info', title: `${open.name} disconnected` }); setOpen(null); }}
          onCheck={(row) => void test(row, open.name)}
        />
      )}
    </div>
  );
}

const toConnRowDemo = (i: Integration): ConnRow => ({ id: i.id, provider: i.provider, status: i.status, scopes: i.scopes, lastSync: i.lastSync, error: i.error });

/* ─────────────────────────── marketplace grid (shared) ─────────────────────────── */

function Marketplace({ merged, onOpen }: { merged: MergedEntry[]; onOpen: (cat: CatalogEntry) => void }) {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<IntegrationCategory | 'all'>('all');
  const filtered = useMemo(() => merged.filter((m) => matchesFilter(m.cat, cat, q)), [merged, cat, q]);

  return (
    <div className="card mt-16" style={{ padding: 0 }}>
      <div className="row wrap" style={{ padding: '16px 18px 10px', gap: 10 }}>
        <h4 className="section-title" style={{ marginRight: 'auto' }}>Marketplace</h4>
        <SearchInput value={q} onChange={setQ} placeholder="Search tools…" width={220} />
      </div>
      <div className="row wrap" style={{ padding: '0 18px 16px', gap: 6 }}>
        <button key="all" className={cx('cat-chip', cat === 'all' && 'on')} onClick={() => setCat('all')}>All</button>
        {CATALOG_CATEGORIES.map((c) => <button key={c} className={cx('cat-chip', cat === c && 'on')} onClick={() => setCat(c)}>{CATEGORY_LABEL[c]}</button>)}
      </div>
      {filtered.length === 0 ? (
        <div style={{ padding: '0 18px 24px' }}><Empty icon={<WorkflowIcon size={18} />} title="No tools match" description="Try a different search or category." /></div>
      ) : (
        <div className="int-grid" style={{ padding: '0 18px 18px' }}>
          {filtered.map((m) => <ProviderTile key={m.cat.id} entry={m} onOpen={() => onOpen(m.cat)} />)}
        </div>
      )}
    </div>
  );
}

function ProviderTile({ entry: { cat, row }, onOpen }: { entry: MergedEntry; onOpen: () => void }) {
  const Icon = CAT_ICON[cat.category];
  const status = row?.status;
  return (
    <button className="int-tile" onClick={onOpen}>
      <span className="icon-chip" style={{ width: 36, height: 36, borderRadius: 10 }}><Icon size={16} /></span>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="row" style={{ gap: 6 }}>
          <b className="truncate" style={{ fontWeight: 600, fontSize: 13.5 }}>{cat.name}</b>
          {cat.authType === 'env' ? <Badge tone="neutral">{cat.alwaysOn ? 'Built in' : 'Server'}</Badge>
            : status ? <Badge tone={STATUS_TONE[status]} dot>{status.replace('_', ' ')}</Badge>
            : <Badge tone="neutral">Not connected</Badge>}
        </div>
        <div className="faint truncate" style={{ fontSize: 12 }}>{cat.blurb}</div>
      </div>
    </button>
  );
}

/* ─────────────────────────── connect / manage modal (shared) ─────────────────────────── */

function ConnectModal({ entry: { cat, row }, mode, canManage, testing, onClose, onConnectApiKey, onConnectOauthDemo, onDisconnect, onCheck }: {
  entry: MergedEntry; mode: 'live' | 'demo'; canManage: boolean; testing?: boolean; onClose: () => void;
  onConnectApiKey: (credential: string) => Promise<boolean>;
  onConnectOauthDemo?: () => void;
  onDisconnect: (row: ConnRow) => void;
  onCheck: (row: ConnRow) => void;
}) {
  const [credential, setCredential] = useState('');
  const [busy, setBusy] = useState(false);
  const Icon = CAT_ICON[cat.category];
  const connected = row?.status === 'connected' || row?.status === 'paused' || row?.status === 'needs_reauth';

  const header = (
    <div className="row" style={{ gap: 10, marginBottom: 2 }}>
      <span className="icon-chip" style={{ width: 34, height: 34, borderRadius: 10 }}><Icon size={16} /></span>
      <div>
        <div style={{ fontWeight: 600 }}>{cat.name}</div>
        <div className="faint" style={{ fontSize: 12 }}>{CATEGORY_LABEL[cat.category]}</div>
      </div>
    </div>
  );

  const scopesList = (cat.authType === 'oauth' ? cat.scopes : (row?.scopes.length ? row.scopes : cat.scopes)) ?? [];

  let footer: ReactNode = <Button onClick={onClose}>Close</Button>;
  if (canManage) {
    if (cat.authType === 'env') {
      // Nothing to connect: informational only.
    } else if (connected && row) {
      footer = (
        <>
          <Button variant="ghost" icon={<Unplug size={14} />} onClick={() => onDisconnect(row)}>Disconnect</Button>
          <Button variant="primary" icon={<RotateCw size={14} />} loading={testing} onClick={() => onCheck(row)}>Check connection</Button>
        </>
      );
    } else if (cat.authType === 'api_key') {
      footer = (
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<Plug size={14} />} loading={busy} disabled={!credential.trim()} onClick={async () => {
            setBusy(true);
            const ok = await onConnectApiKey(credential.trim());
            setBusy(false);
            if (!ok) return;
          }}>Connect</Button>
        </>
      );
    } else if (cat.authType === 'oauth' && mode === 'demo') {
      footer = (
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<CheckCircle2 size={14} />} onClick={onConnectOauthDemo}>Authorize</Button>
        </>
      );
    }
  }

  return (
    <Modal open onClose={onClose} title={header} description={cat.blurb} footer={footer}>
      <div className="stack stack-sm">
        {cat.authType === 'env' && (
          <div className="banner info">
            <Info size={14} />
            <span>{cat.alwaysOn ? 'Always available — nothing to set up.' : <>Configured by your developer on the server{cat.envVar ? <> (<code className="mono">{cat.envVar}</code>)</> : ''}. There is nothing to connect from this page.</>}</span>
          </div>
        )}

        {cat.authType === 'oauth' && !connected && (
          <div className="banner warning">
            <ShieldAlert size={14} />
            <span>{mode === 'live' ? cat.setupNote : 'This OAuth connection needs a provider app in production. This demo simulates the consent so you can show the full flow.'}</span>
          </div>
        )}

        {cat.authType === 'api_key' && !connected && canManage && (
          <Field label={cat.keyLabel} hint={mode === 'demo' ? 'Demo mode: any value connects it — nothing is sent anywhere.' : 'Stored only in the database Vault, never in a plain table.'}>
            <Input value={credential} onChange={(e) => setCredential(e.target.value)} placeholder={cat.keyPlaceholder} autoComplete="off" data-autofocus />
          </Field>
        )}

        {connected && row && (
          <div className="grid g-2" style={{ gap: 10 }}>
            <div><div className="field-label" style={{ marginBottom: 4 }}>Status</div><Badge tone={STATUS_TONE[row.status]} dot>{row.status.replace('_', ' ')}</Badge></div>
            <div><div className="field-label" style={{ marginBottom: 4 }}>Last synced</div><span style={{ fontSize: 13 }}>{row.lastSync ? relTime(row.lastSync) : 'Never'}</span></div>
          </div>
        )}
        {connected && row?.error && <div className="banner danger"><ShieldAlert size={14} /><span>{row.error}</span></div>}

        {scopesList.length > 0 && (
          <div>
            <div className="field-label" style={{ marginBottom: 6 }}>{cat.authType === 'oauth' ? 'Permissions requested' : 'What this grants'}</div>
            <div className="stack stack-sm">{scopesList.map((s) => <div key={s} className="code"><span>{s}</span></div>)}</div>
          </div>
        )}
        <p className="faint" style={{ fontSize: 12 }}>Least privilege: only the scopes needed for {cat.capabilities.join(', ').toLowerCase()}.</p>
        {!canManage && <p className="faint" style={{ fontSize: 12 }}>Ask an owner or admin to connect or change this integration.</p>}
      </div>
    </Modal>
  );
}

/* ─────────────────────────── event log (shared) ─────────────────────────── */

function EventLog({ events, onReplay, canManage }: { events: WebhookEvent[]; onReplay: (e: WebhookEvent) => void; canManage: boolean }) {
  if (!events.length) return <Empty icon={<Webhook size={20} />} title="No events yet" />;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr><th>Provider</th><th>Event</th><th>Status</th><th>Signature</th><th>Idempotency key</th><th className="right">Attempts</th><th>Received</th><th /></tr></thead>
        <tbody>
          {events.slice(0, 80).map((e) => (
            <tr key={e.id}>
              <td>{e.provider}</td>
              <td className="mono" style={{ fontSize: 12 }}>{e.type}</td>
              <td><Badge tone={EVT_TONE[e.status]} dot title={e.error ?? undefined}>{e.status.replace('_', ' ')}</Badge>{e.error && <div className="cell-sub truncate" style={{ maxWidth: 260 }}>{e.error}</div>}</td>
              <td>{e.signature === 'valid' ? <Badge tone="success">valid</Badge> : <Badge tone="danger">invalid</Badge>}</td>
              <td className="mono faint" style={{ fontSize: 11.5 }}>{e.idempotencyKey}</td>
              <td className="right num">{e.attempts}</td>
              <td className="faint">{relTime(e.receivedAt)}</td>
              <td className="right">{canManage && ['failed', 'dead_letter'].includes(e.status) && <Button size="xs" icon={<RotateCw size={12} />} onClick={() => onReplay(e)}>Replay</Button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
