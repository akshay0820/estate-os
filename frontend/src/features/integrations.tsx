import { useMemo, useState } from 'react';
import { Bot, Calendar, Copy, Eye, KeyRound, Link2, Mail, MessageCircle, Phone, Plug, RefreshCw, RotateCw, ShieldAlert, Unplug, Webhook, Workflow as WorkflowIcon, Zap, CheckCircle2 } from 'lucide-react';
import { Badge, Button, Card, Empty, Modal, PageHeader, Tabs } from '@/components/ui';
import { confirm } from '@/components/dialogs';
import { useStore } from '@/store/store';
import { useCan, useOrg, useOrgList } from '@/store/hooks';
import { toast } from '@/store/ui';
import { relTime } from '@/lib/format';
import { maskSecret } from '@/lib/util';
import { LIVE, attempt } from '@/data/actions';
import * as live from '@/backend/live';
import type { Integration, WebhookEvent } from '@/store/types';

const CAT_ICON: Record<Integration['category'], React.ReactNode> = {
  lead_source: <Webhook size={16} />, voice: <Phone size={16} />, messaging: <MessageCircle size={16} />, email: <Mail size={16} />, calendar: <Calendar size={16} />, ai: <Bot size={16} />, automation: <WorkflowIcon size={16} />,
};
const STATUS_TONE = { connected: 'success', disconnected: 'neutral', error: 'danger', needs_reauth: 'warning', paused: 'warning' } as const;
const EVT_TONE = { processed: 'success', duplicate: 'info', failed: 'danger', retrying: 'warning', dead_letter: 'danger', rejected: 'danger' } as const;

export function IntegrationsPage() {
  return LIVE ? <LiveIntegrations /> : <DemoIntegrations />;
}

function LiveIntegrations() {
  const events = useOrgList('webhookEvents');
  const org = useOrg();
  const canManage = useCan('integrations.manage');
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const endpoint = live.intakeEndpoint(org.slug);
  const hasSecret = org.webhookSecretVersion > 0;
  const sample = `curl -X POST '${endpoint}' \
  -H 'Content-Type: application/json' \
  -H 'X-Estate-Event-Id: evt_123' \
  -H 'X-Estate-Timestamp: <unix seconds>' \
  -H 'X-Estate-Signature: sha256=<hex HMAC of "timestamp.body">' \
  -d '{"name":"Riya Shah","phone":"9820012345","source":"Website form","locations":["Powai"]}'`;
  return (
    <div className="page">
      <PageHeader
        eyebrow="[ Lead intake ]"
        title="Integrations"
        sub="Send leads from any portal, ad platform or website form to a signed endpoint. Secrets live in the database vault and are shown once."
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
      <div className="card mt-16">
        <div className="row" style={{ padding: '14px 18px 6px' }}>
          <b>Event log</b>
          <span className="faint" style={{ fontSize: 12 }}>Last 100 deliveries</span>
          <Button size="sm" className="ml-auto" icon={<RefreshCw size={13} />} onClick={() => void attempt(() => live.refresh('webhookEvents', 'leads'))}>Refresh</Button>
        </div>
        <EventLog events={events} onReplay={() => undefined} canManage={false} />
      </div>
      <div className="card mt-16" style={{ padding: 18 }}>
        <h4 className="section-title">Provider connections</h4>
        <p className="faint" style={{ fontSize: 13 }}>Voice, WhatsApp, email, calendar and portal connectors need provider accounts and credentials. They are not connected in this release, so nothing is shown as active.</p>
      </div>
      {secret && (
        <Modal open onClose={() => setSecret(null)} title="Your signing secret" description="Copy it now — it won’t be shown again. Store it in the sender’s secret manager." footer={<Button variant="primary" onClick={() => setSecret(null)}>I’ve saved it</Button>}>
          <div className="code"><span>{secret}</span><Button size="xs" icon={<Copy size={12} />} onClick={() => { void navigator.clipboard?.writeText(secret); toast({ kind: 'success', title: 'Secret copied' }); }}>Copy</Button></div>
        </Modal>
      )}
    </div>
  );
}

function DemoIntegrations() {
  const integrations = useOrgList('integrations');
  const events = useOrgList('webhookEvents');
  const org = useOrg();
  const canManage = useCan('integrations.manage');
  const { setIntegrationStatus, testIntegration, rotateWebhookSecret, simulateInboundLead, replayEvent } = useStore.getState();
  const [tab, setTab] = useState<'connections' | 'events'>('connections');
  const [testing, setTesting] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [scopesFor, setScopesFor] = useState<Integration | null>(null);
  const endpoint = `https://api.estateos.in/v1/webhooks/leads/${org.slug}`;
  const healthy = integrations.filter((i) => i.status === 'connected').length;
  const problems = integrations.filter((i) => ['error', 'needs_reauth'].includes(i.status));

  const groups = useMemo(() => {
    const order: Integration['category'][] = ['lead_source', 'voice', 'messaging', 'email', 'calendar', 'ai', 'automation'];
    return order.map((c) => [c, integrations.filter((i) => i.category === c)] as const).filter(([, l]) => l.length);
  }, [integrations]);

  const test = async (i: Integration) => {
    setTesting(i.id);
    const ok = await testIntegration(i.id);
    setTesting(null);
    toast(ok ? { kind: 'success', title: `${i.provider} is healthy`, body: 'Credentials valid · test event round-tripped.' } : { kind: 'error', title: `${i.provider} test failed`, body: i.error ?? 'Reconnect to restore access.' });
  };

  return (
    <div className="page">
      <PageHeader
        eyebrow={`[ ${healthy}/${integrations.length} healthy ]`}
        title="Integrations"
        sub="Lead sources, voice, messaging and calendars. Secrets stay server-side; this page only ever shows status, scopes and masked references."
        actions={canManage && <Button variant="accent" icon={<Zap size={15} />} onClick={() => void simulateInboundLead({ source: 'Generic webhook' })}>Send test lead</Button>}
      />
      {problems.length > 0 && (
        <div className="banner danger" style={{ marginBottom: 16 }}>
          <ShieldAlert size={15} />
          <span>{problems.map((p) => `${p.provider}: ${p.error}`).join(' · ')}</span>
        </div>
      )}
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
      <div className="card mt-16">
        <div style={{ padding: '4px 14px 0' }}>
          <Tabs value={tab} onChange={setTab} tabs={[{ value: 'connections', label: 'Connections', count: integrations.length }, { value: 'events', label: 'Event log', count: events.length }]} />
        </div>
        {tab === 'connections' ? (
          groups.map(([cat, list]) => (
            <div key={cat}>
              <div className="menu-label" style={{ padding: '14px 18px 6px' }}>{cat.replace('_', ' ')}</div>
              {list.map((i) => (
                <div key={i.id} className="list-row" style={{ padding: '14px 18px' }}>
                  <span className="icon-chip" style={{ width: 36, height: 36, borderRadius: 10 }}>{CAT_ICON[i.category]}</span>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="row" style={{ gap: 8 }}>
                      <b style={{ fontWeight: 600 }}>{i.provider}</b>
                      <Badge tone={STATUS_TONE[i.status]} dot>{i.status.replace('_', ' ')}</Badge>
                    </div>
                    <div className="faint truncate" style={{ fontSize: 12.5 }}>{i.error ?? i.description}</div>
                    <div className="row wrap mt-4" style={{ gap: 4 }}>{i.capabilities.map((c) => <span key={c} className="tag" style={{ height: 20, fontSize: 11 }}>{c}</span>)}</div>
                  </div>
                  <span className="faint desktop-only" style={{ fontSize: 12, width: 110, textAlign: 'right' }}>{i.lastSync ? `Synced ${relTime(i.lastSync)}` : 'Never synced'}</span>
                  {canManage && (
                    <div className="row" style={{ gap: 6 }}>
                      {i.status !== 'disconnected' && <Button size="sm" variant="ghost" iconOnly icon={<Eye size={14} />} title="Scopes" aria-label="View scopes" onClick={() => setScopesFor(i)} />}
                      {i.status === 'connected' || i.status === 'paused' ? (
                        <>
                          <Button size="sm" icon={<RefreshCw size={13} />} loading={testing === i.id} onClick={() => void test(i)}>Test</Button>
                          <Button size="sm" variant="ghost" iconOnly icon={<Unplug size={14} />} aria-label="Disconnect" title="Disconnect" onClick={async () => {
                            const r = await confirm({ title: `Disconnect ${i.provider}?`, body: 'Sync stops and dependent workflows pause. Provider access is revoked where supported.', confirmLabel: 'Disconnect', danger: true });
                            if (r.ok) { setIntegrationStatus(i.id, 'disconnected'); toast({ kind: 'info', title: `${i.provider} disconnected` }); }
                          }} />
                        </>
                      ) : (
                        <Button size="sm" variant="primary" icon={i.status === 'disconnected' ? <Plug size={13} /> : <RotateCw size={13} />} onClick={() => setScopesFor({ ...i, status: 'disconnected' })}>
                          {i.status === 'disconnected' ? 'Connect' : 'Reconnect'}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))
        ) : (
          <EventLog events={events} onReplay={(e) => replayEvent(e.id)} canManage={canManage} />
        )}
      </div>
      {secret && (
        <Modal open onClose={() => setSecret(null)} title="New signing secret" description="Copy it now — for security it won't be shown again." footer={<Button variant="primary" onClick={() => setSecret(null)}>I've saved it</Button>}>
          <div className="code"><span>{secret}</span><Button size="xs" icon={<Copy size={12} />} onClick={() => { void navigator.clipboard?.writeText(secret); toast({ kind: 'success', title: 'Secret copied' }); }}>Copy</Button></div>
        </Modal>
      )}
      {scopesFor && (
        <Modal
          open
          onClose={() => setScopesFor(null)}
          title={scopesFor.status === 'disconnected' ? `Connect ${scopesFor.provider}` : `${scopesFor.provider} permissions`}
          description={scopesFor.status === 'disconnected' ? 'You will be sent to the provider to approve exactly these permissions.' : 'Scopes granted to Estate OS by this connection.'}
          footer={scopesFor.status === 'disconnected' ? <><Button onClick={() => setScopesFor(null)}>Cancel</Button><Button variant="primary" icon={<CheckCircle2 size={14} />} onClick={() => { setIntegrationStatus(scopesFor.id, 'connected'); toast({ kind: 'success', title: `${scopesFor.provider} connected`, body: 'Credentials stored in the secret vault, never in the database.' }); setScopesFor(null); }}>Authorize</Button></> : <Button onClick={() => setScopesFor(null)}>Close</Button>}
        >
          <div className="stack stack-sm">
            {(scopesFor.scopes.length ? scopesFor.scopes : ['enquiries:read']).map((s) => <div key={s} className="code"><span>{s}</span></div>)}
            <p className="faint" style={{ fontSize: 12.5 }}>Least privilege: only the scopes needed for {scopesFor.capabilities.join(', ').toLowerCase()}.</p>
          </div>
        </Modal>
      )}
    </div>
  );
}

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
