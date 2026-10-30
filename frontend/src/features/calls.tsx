import { useMemo, useState } from 'react';
import { Bot, Download, Headphones, Lock, PhoneCall, PhoneIncoming, PhoneOutgoing, Sparkles, Timer, CircleDollarSign, ShieldAlert } from 'lucide-react';
import { Badge, Button, Card, Drawer, Empty, Field, KV, Modal, PageHeader, Pager, SearchInput, Select, Tabs } from '@/components/ui';
import { useStore } from '@/store/store';
import { useCan, useLookup, useOrg, useOrgList } from '@/store/hooks';
import { toast } from '@/store/ui';
import { navigate, setParam } from '@/lib/router';
import { CALL_STATUS, outboundPolicy } from '@/lib/domain';
import { duration, fmtDateTime, moneyPrecise, pct, relTime, currencySymbol, money } from '@/lib/format';
import { downloadCsv } from '@/lib/util';
import { PolicyChecks, StatusBadge } from './shared';
import { LIVE } from '@/data/actions';
import { LiveCallsPage } from './voice';

type Tab = 'all' | 'live' | 'review' | 'blocked';

export function CallsPage({ params }: { params: URLSearchParams }) {
  return LIVE ? <LiveCallsPage params={params} /> : <DemoCallsPage params={params} />;
}

function DemoCallsPage({ params }: { params: URLSearchParams }) {
  const calls = useOrgList('calls');
  const leads = useLookup('leads');
  const canCall = useCan('calls.place');
  const [tab, setTab] = useState<Tab>('all');
  const [q, setQ] = useState('');
  const [who, setWho] = useState('');
  const [page, setPage] = useState(0);
  const [dialing, setDialing] = useState(false);
  const openId = params.get('id');
  const live = ['queued', 'initiating', 'ringing', 'in_progress'];

  const filtered = useMemo(() => {
    const t = q.toLowerCase();
    return calls.filter((c) => {
      if (tab === 'live' && !live.includes(c.status)) return false;
      if (tab === 'review' && c.status !== 'needs_review') return false;
      if (tab === 'blocked' && c.status !== 'blocked') return false;
      if (who === 'ai' && !c.agentId) return false;
      if (who === 'human' && c.agentId) return false;
      return !t || (c.leadId && leads.get(c.leadId)?.name.toLowerCase().includes(t));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calls, tab, q, who, leads]);

  const last30 = calls.filter((c) => Date.now() - c.startedAt < 30 * 864e5);
  const connected = last30.filter((c) => c.status === 'completed' || c.status === 'needs_review');
  const talk = connected.reduce((s, c) => s + c.duration, 0);
  const cost = last30.reduce((s, c) => s + c.cost, 0);
  const rows = filtered.slice(page * 25, page * 25 + 25);

  return (
    <div className="page">
      <PageHeader
        eyebrow="[ Voice ]"
        title="Calls"
        sub="AI and manual calls with outcomes, summaries and cost. Every call passes consent, calling-hour and suppression checks right before dialing."
        actions={
          <>
            <Button icon={<Download size={15} />} onClick={() => { downloadCsv('calls.csv', [['Lead', 'Direction', 'By', 'Status', 'Started', 'Duration (s)', `Cost (${currencySymbol()})`, 'Outcome'], ...filtered.map((c) => [c.leadId ? leads.get(c.leadId)?.name : '', c.direction, c.agentId ? 'AI' : 'Human', c.status, new Date(c.startedAt).toISOString(), c.duration, c.cost, c.outcome])]); toast({ kind: 'success', title: 'Call log exported' }); }}>Export</Button>
            {canCall && <Button variant="accent" icon={<PhoneCall size={15} />} onClick={() => setDialing(true)}>New AI call</Button>}
          </>
        }
      />
      <div className="grid g-kpi" style={{ marginBottom: 16 }}>
        <Mini icon={<PhoneOutgoing size={14} />} label="Calls · 30 days" value={last30.length.toLocaleString('en-IN')} sub={`${last30.filter((c) => c.agentId).length} by AI`} />
        <Mini icon={<PhoneIncoming size={14} />} label="Connect rate" value={pct(connected.length / (last30.length || 1), 0)} sub={`${last30.filter((c) => c.status === 'no_answer').length} unanswered`} />
        <Mini icon={<Timer size={14} />} label="Avg talk time" value={duration(Math.round(talk / (connected.length || 1)))} sub={`${Math.round(talk / 3600)} h total`} />
        <Mini icon={<CircleDollarSign size={14} />} label="Telephony + AI cost" value={moneyPrecise(cost)} sub="Estimated · provider-reported" />
      </div>
      <div className="card">
        <div style={{ padding: '4px 14px 0' }}>
          <Tabs value={tab} onChange={(v) => { setTab(v); setPage(0); }} tabs={[
            { value: 'all', label: 'All calls', count: calls.length },
            { value: 'live', label: 'Live', count: calls.filter((c) => live.includes(c.status)).length },
            { value: 'review', label: 'Needs review', count: calls.filter((c) => c.status === 'needs_review').length },
            { value: 'blocked', label: 'Blocked by policy', count: calls.filter((c) => c.status === 'blocked').length },
          ]} />
        </div>
        <div className="toolbar">
          <SearchInput value={q} onChange={(v) => { setQ(v); setPage(0); }} placeholder="Search lead" />
          <Select selectSize="sm" value={who} onChange={(e) => setWho(e.target.value)} style={{ width: 130 }} aria-label="Caller">
            <option value="">AI & human</option>
            <option value="ai">AI only</option>
            <option value="human">Human only</option>
          </Select>
        </div>
        {rows.length === 0 ? <Empty icon={<PhoneCall size={20} />} title="No calls here" /> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Lead</th><th>By</th><th>Status</th><th>Outcome</th><th className="right">Duration</th><th className="right">Cost</th><th>When</th></tr></thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} className="clickable" onClick={() => setParam('id', c.id)}>
                    <td>
                      <div className="cell-main">
                        <span className="icon-chip">{c.direction === 'inbound' ? <PhoneIncoming size={13} /> : <PhoneOutgoing size={13} />}</span>
                        <div><div className="cell-title">{c.leadId ? leads.get(c.leadId)?.name ?? 'Unknown' : 'Unknown caller'}</div><div className="cell-sub">{c.direction}</div></div>
                      </div>
                    </td>
                    <td>{c.agentId ? <span className="badge badge-ai"><Bot size={10} /> AI</span> : <Badge>Human</Badge>}</td>
                    <td><StatusBadge map={CALL_STATUS} value={c.status} /></td>
                    <td className="truncate" style={{ maxWidth: 220 }}>{c.outcome ?? c.policyNote ?? <span className="faint">—</span>}</td>
                    <td className="right num">{c.duration ? duration(c.duration) : '—'}</td>
                    <td className="right num">{c.cost ? moneyPrecise(c.cost) : '—'}</td>
                    <td className="faint">{relTime(c.startedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager page={page} pageSize={25} total={filtered.length} onPage={setPage} />
      </div>
      {dialing && <DialModal onClose={() => setDialing(false)} />}
      {openId && <CallDrawer id={openId} onClose={() => setParam('id', null)} />}
    </div>
  );
}

function Mini({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub: string }) {
  return (
    <div className="card kpi">
      <div className="kpi-label"><span className="icon-chip">{icon}</span>{label}</div>
      <div className="kpi-value" style={{ fontSize: 24 }}>{value}</div>
      <div className="kpi-foot">{sub}</div>
    </div>
  );
}

function DialModal({ onClose }: { onClose: () => void }) {
  const leads = useOrgList('leads');
  const contacts = useLookup('contacts');
  const org = useOrg();
  const placeCall = useStore((s) => s.placeCall);
  const candidates = useMemo(() => leads.filter((l) => !l.archived && ['new', 'attempting', 'contacted', 'qualified'].includes(l.status)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 150), [leads]);
  const [leadId, setLeadId] = useState(candidates[0]?.id ?? '');
  const lead = leads.find((l) => l.id === leadId);
  const policy = lead ? outboundPolicy(org, contacts.get(lead.contactId), 'phone', { purpose: 'ai_call' }) : null;
  return (
    <Modal
      open
      onClose={onClose}
      title="Start an AI qualification call"
      description="The agent introduces itself as an AI assistant, asks the standard questions and offers a human callback anytime."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="accent" icon={<PhoneCall size={15} />} disabled={!policy?.allowed} onClick={() => {
        const r = placeCall(leadId, { byAi: true });
        if (r.allowed) toast({ kind: 'info', title: 'Call queued', body: `Calling ${lead?.name}…` });
        else toast({ kind: 'error', title: 'Blocked', body: r.reason });
        onClose();
      }}>{policy?.allowed ? 'Place call' : 'Blocked by policy'}</Button></>}
    >
      <div className="stack">
        <Field label="Lead">
          <select className="select" value={leadId} onChange={(e) => setLeadId(e.target.value)}>
            {candidates.map((l) => <option key={l.id} value={l.id}>{l.name} — {l.status.replace(/_/g, ' ')} · {l.source}</option>)}
          </select>
        </Field>
        {policy && <PolicyChecks result={policy} />}
      </div>
    </Modal>
  );
}

function CallDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const c = useOrgList('calls').find((x) => x.id === id);
  const leads = useLookup('leads');
  const agents = useLookup('agents');
  const canRecord = useCan('calls.recordings');
  const [playing, setPlaying] = useState(false);
  if (!c) return null;
  const lead = c.leadId ? leads.get(c.leadId) : undefined;
  return (
    <Drawer
      open
      onClose={onClose}
      label="Call"
      header={
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 600 }}>{c.direction === 'inbound' ? 'Inbound' : 'Outbound'} call · {lead?.name}</h2>
          <div className="row mt-8"><StatusBadge map={CALL_STATUS} value={c.status} /><span className="faint">{fmtDateTime(c.startedAt)}</span></div>
        </div>
      }
      footer={lead ? <Button variant="primary" onClick={() => navigate('leads', { id: lead.id })}>Open lead</Button> : undefined}
    >
      <div className="stack stack-lg">
        <KV items={[
          ['Handled by', c.agentId ? <span key="a" className="row"><Bot size={13} /> {agents.get(c.agentId)?.name ?? 'AI agent'}</span> : 'Team member'],
          ['Duration', c.duration ? duration(c.duration) : '—'],
          ['Cost', c.cost ? `${moneyPrecise(c.cost)} (estimate)` : '—'],
          ['Outcome', c.outcome ?? '—'],
          ['Provider ID', <span key="p" className="mono faint" style={{ fontSize: 12 }}>{c.id.replace('call_', 'CA')}</span>],
        ]} />
        {c.policyNote && <div className="banner danger"><ShieldAlert size={15} /> {c.policyNote}</div>}
        {c.summary && (
          <section>
            <h4 className="section-title"><Sparkles size={12} /> AI summary</h4>
            <div className="tl-body" style={{ marginTop: 0 }}>{c.summary}</div>
          </section>
        )}
        {c.extracted && (
          <section>
            <h4 className="section-title">Extracted fields · schema v3</h4>
            <div className="card" style={{ boxShadow: 'none' }}>
              {Object.entries(c.extracted).map(([k, v]) => (
                <div key={k} className="list-row" style={{ padding: '9px 14px' }}>
                  <span className="mono faint grow" style={{ fontSize: 12 }}>{k}</span>
                  <span style={{ color: v === 'unknown' ? 'var(--text-3)' : undefined }}>{v === 'unknown' ? 'unknown (not guessed)' : k === 'budget' ? money(Number(v), { compact: false }) : v}</span>
                </div>
              ))}
            </div>
          </section>
        )}
        {c.status === 'needs_review' && <div className="banner warning">Extraction confidence was below threshold, so CRM fields were not updated automatically. Check the summary and edit the lead.</div>}
        {c.recording && (
          <Card title="Recording" icon={<Headphones size={14} />} style={{ boxShadow: 'none' }}>
            {canRecord ? (
              <div className="stack">
                <div className="row">
                  <Button size="sm" variant="primary" onClick={() => { setPlaying(!playing); if (!playing) useStore.getState().log('recording.accessed', 'call', c.id, 'signed URL · 5 min expiry'); }}>{playing ? 'Pause' : 'Play'}</Button>
                  <div className="progress grow accent"><i style={{ width: playing ? '38%' : '0%', transition: 'width 6s linear' }} /></div>
                  <span className="mono faint" style={{ fontSize: 12 }}>{duration(c.duration)}</span>
                </div>
                <span className="faint" style={{ fontSize: 12 }}>Access is logged. Retention: 90 days, then deleted automatically.</span>
              </div>
            ) : (
              <span className="faint row"><Lock size={13} /> Recordings are restricted to roles with explicit permission.</span>
            )}
          </Card>
        )}
      </div>
    </Drawer>
  );
}
