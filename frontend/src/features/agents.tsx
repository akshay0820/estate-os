import { useMemo, useState } from 'react';
import { Bot, FlaskConical, OctagonPause, Settings2, ShieldCheck, Wrench, AlertTriangle } from 'lucide-react';
import { Badge, Button, Drawer, Field, Input, KV, PageHeader, Progress, Switch } from '@/components/ui';
import { confirm } from '@/components/dialogs';
import { useStore } from '@/store/store';
import { useCan, useOrg, useOrgList } from '@/store/hooks';
import { toast } from '@/store/ui';
import { navigate, setParam } from '@/lib/router';
import { RUN_STATUS } from '@/lib/domain';
import { DAY, money, ms, pct, relTime, startOfDay, currencySymbol } from '@/lib/format';
import { cx } from '@/lib/util';
import type { Agent, Autonomy } from '@/store/types';
import { CHANNEL_ICON, StatusBadge } from './shared';
import { LIVE } from '@/data/actions';
import { LiveAgentsPage } from './agentsLive';

export const ALL_TOOLS: { name: string; risk: 'read' | 'write' | 'external' | 'critical'; desc: string }[] = [
  { name: 'get_lead', risk: 'read', desc: 'Read permitted lead fields' },
  { name: 'search_properties', risk: 'read', desc: 'Search active inventory' },
  { name: 'get_verified_property_details', risk: 'read', desc: 'Read verified facts only' },
  { name: 'check_appointment_availability', risk: 'read', desc: 'Query free slots' },
  { name: 'update_lead_fields', risk: 'write', desc: 'Write allow-listed fields' },
  { name: 'create_task', risk: 'write', desc: 'Create a task for a person' },
  { name: 'draft_customer_message', risk: 'write', desc: 'Draft, never send' },
  { name: 'request_appointment_booking', risk: 'external', desc: 'Propose a booking' },
  { name: 'send_approved_message', risk: 'external', desc: 'Send through policy gate' },
  { name: 'request_human_handoff', risk: 'write', desc: 'Escalate to a person' },
];

const AUTONOMY: Record<Autonomy, { label: string; desc: string }> = {
  suggest_only: { label: 'Suggest only', desc: 'Drafts and recommendations; people act.' },
  approval_required: { label: 'Approval required', desc: 'External actions wait for a person.' },
  bounded_auto: { label: 'Bounded auto', desc: 'Acts within tools, limits and policy.' },
};

export function AgentsPage({ params }: { params: URLSearchParams }) {
  return LIVE ? <LiveAgentsPage params={params} /> : <DemoAgentsPage params={params} />;
}

function DemoAgentsPage({ params }: { params: URLSearchParams }) {
  const agents = useOrgList('agents');
  const runs = useOrgList('runs');
  const usage = useOrgList('usage');
  const org = useOrg();
  const canManage = useCan('agents.manage');
  const canKill = useCan('outbound.kill');
  const { setAgentStatus, setOutboundPaused } = useStore.getState();
  const openId = params.get('id');
  const today = startOfDay(Date.now());

  const stats = useMemo(() => {
    const m = new Map<string, { runs: number; ok: number; spent: number; last: number }>();
    for (const a of agents) {
      const rs = runs.filter((r) => r.refId === a.id && Date.now() - r.startedAt < 7 * DAY);
      const done = rs.filter((r) => ['succeeded', 'failed', 'dead_letter'].includes(r.status));
      m.set(a.id, { runs: rs.length, ok: done.length ? done.filter((r) => r.status === 'succeeded').length / done.length : 1, spent: usage.filter((u) => u.agentId === a.id && u.day >= today).reduce((s, u) => s + u.cost, 0), last: rs[0]?.startedAt ?? 0 });
    }
    return m;
  }, [agents, runs, usage, today]);

  const toggleKill = async () => {
    if (!org.outboundPaused) {
      const r = await confirm({ title: 'Engage the outbound kill switch?', body: 'All agents and workflows stop sending messages and placing calls immediately. In-flight calls are cancelled before connecting.', confirmLabel: 'Pause all outbound', danger: true });
      if (!r.ok) return;
    }
    setOutboundPaused(!org.outboundPaused);
    toast({ kind: org.outboundPaused ? 'success' : 'warning', title: org.outboundPaused ? 'Outbound resumed' : 'Outbound paused' });
  };

  return (
    <div className="page">
      <PageHeader
        eyebrow={`[ ${agents.filter((a) => a.status === 'active').length} of ${agents.length} active ]`}
        title="AI agents"
        sub="Bounded task runners with explicit tools, budgets and escalation rules. Model output is a proposal — the backend validates and authorizes every action."
      />
      <div className={cx('banner', org.outboundPaused ? 'danger' : '')} style={{ marginBottom: 16, padding: '14px 16px' }}>
        <OctagonPause size={18} />
        <div className="grow">
          <b>{org.outboundPaused ? 'Outbound kill switch is ON' : 'Outbound kill switch'}</b>
          <div style={{ fontSize: 12.5, opacity: 0.8 }}>{org.outboundPaused ? 'No agent or workflow can send messages or place calls. Drafting continues.' : 'Stops every AI and workflow message or call for this organization, independent of individual agent settings.'}</div>
        </div>
        {canKill && <Button variant={org.outboundPaused ? 'primary' : 'danger-solid'} onClick={toggleKill}>{org.outboundPaused ? 'Resume outbound' : 'Pause all outbound'}</Button>}
      </div>
      <div className="grid g-3">
        {agents.map((a) => {
          const st = stats.get(a.id)!;
          return (
            <div key={a.id} className="card agent-card">
              <div className="row row-top">
                <span className={cx('icon-chip', a.status === 'active' && 'accent')} style={{ width: 36, height: 36, borderRadius: 10 }}><Bot size={17} /></span>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="row" style={{ gap: 6 }}>
                    <b className="truncate">{a.name}</b>
                    <span className="mono faint" style={{ fontSize: 11 }}>v{a.version}</span>
                  </div>
                  <div className="row" style={{ gap: 6, marginTop: 3 }}>
                    <Badge tone={a.status === 'active' ? 'success' : a.status === 'paused' ? 'warning' : 'neutral'} dot>{a.status}</Badge>
                    <span className="tag" style={{ height: 20, fontSize: 11 }}>{AUTONOMY[a.autonomy].label}</span>
                    {a.channel && <span className="faint" title={a.channel}>{CHANNEL_ICON[a.channel]}</span>}
                  </div>
                </div>
                {canManage && <Switch on={a.status === 'active'} label={`${a.name} active`} onChange={(v) => { setAgentStatus(a.id, v ? 'active' : 'paused'); toast({ kind: v ? 'success' : 'warning', title: `${a.name} ${v ? 'activated' : 'paused'}`, body: v ? undefined : 'Queued runs re-check status and will not execute.' }); }} />}
              </div>
              <p className="faint" style={{ fontSize: 13, minHeight: 38 }}>{a.purpose}</p>
              <div className="mini-stats">
                <div><b>{st.runs}</b><span>runs · 7d</span></div>
                <div><b>{pct(st.ok, 0)}</b><span>success</span></div>
                <div><b>{st.last ? relTime(st.last).replace(' ago', '') : '—'}</b><span>last run</span></div>
              </div>
              <div>
                <div className="row row-between" style={{ fontSize: 12, marginBottom: 6 }}>
                  <span className="faint">Today's budget</span>
                  <span className="num">{money(st.spent)} / {money(a.dailyBudget)}</span>
                </div>
                <Progress value={st.spent / a.dailyBudget} tone={st.spent / a.dailyBudget > 0.85 ? 'danger' : 'accent'} />
              </div>
              <div className="row" style={{ gap: 6 }}>
                <Button size="sm" icon={<Settings2 size={14} />} onClick={() => setParam('id', a.id)}>Configure</Button>
                <Button size="sm" variant="ghost" icon={<FlaskConical size={14} />} disabled={!canManage} onClick={() => { void useStore.getState().testAgent(a.id); toast({ kind: 'info', title: 'Evaluation running', body: 'Results appear in Execution logs.' }); }}>Run evals</Button>
                <Button size="sm" variant="ghost" className="ml-auto" onClick={() => navigate('logs', { ref: a.id })}>Runs →</Button>
              </div>
            </div>
          );
        })}
      </div>
      {openId && <AgentDrawer id={openId} onClose={() => setParam('id', null)} />}
    </div>
  );
}

function AgentDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const a = useOrgList('agents').find((x) => x.id === id);
  const runs = useOrgList('runs');
  const canManage = useCan('agents.manage');
  const updateAgent = useStore((s) => s.updateAgent);
  const [draft, setDraft] = useState<Agent | null>(a ?? null);
  if (!a || !draft) return null;
  const dirty = JSON.stringify({ ...a, version: 0 }) !== JSON.stringify({ ...draft, version: 0 });
  const recent = runs.filter((r) => r.refId === a.id).slice(0, 8);
  const save = async () => {
    const riskier = draft.autonomy !== a.autonomy && (draft.autonomy === 'bounded_auto' || draft.tools.some((t) => !a.tools.includes(t) && ALL_TOOLS.find((x) => x.name === t)?.risk === 'external'));
    if (riskier) {
      const r = await confirm({ title: 'Increase this agent’s autonomy?', body: 'Run the evaluation suite first. Changes take effect on the next run and create a new version.', confirmLabel: 'Save new version' });
      if (!r.ok) return;
    }
    updateAgent(a.id, { autonomy: draft.autonomy, tools: draft.tools, dailyBudget: draft.dailyBudget, maxSteps: draft.maxSteps });
    toast({ kind: 'success', title: `${a.name} updated`, body: `Saved as v${a.version + 1}.` });
  };
  return (
    <Drawer
      open
      wide
      onClose={onClose}
      label={a.name}
      header={<div><h2 style={{ fontSize: 19, fontWeight: 600 }}>{a.name}</h2><div className="faint mt-4">{a.purpose}</div></div>}
      footer={canManage ? <><Button onClick={() => setDraft(a)} disabled={!dirty}>Discard</Button><Button variant="primary" disabled={!dirty} onClick={save}>Save as v{a.version + 1}</Button></> : undefined}
    >
      <div className="stack stack-lg">
        <section>
          <h4 className="section-title">Autonomy</h4>
          <div className="grid g-3" style={{ gap: 8 }}>
            {(Object.keys(AUTONOMY) as Autonomy[]).map((k) => (
              <button key={k} disabled={!canManage} className="card" style={{ padding: 12, textAlign: 'left', boxShadow: 'none', borderColor: draft.autonomy === k ? 'var(--ember)' : undefined, background: draft.autonomy === k ? 'var(--accent-soft)' : undefined }} onClick={() => setDraft({ ...draft, autonomy: k })}>
                <b style={{ fontSize: 13 }}>{AUTONOMY[k].label}</b>
                <div className="faint" style={{ fontSize: 12, marginTop: 3 }}>{AUTONOMY[k].desc}</div>
              </button>
            ))}
          </div>
        </section>
        <section>
          <h4 className="section-title"><Wrench size={12} /> Tool allow-list</h4>
          <div className="card" style={{ boxShadow: 'none' }}>
            {ALL_TOOLS.map((t) => {
              const on = draft.tools.includes(t.name);
              return (
                <div key={t.name} className="list-row" style={{ padding: '9px 14px' }}>
                  <span className="mono" style={{ fontSize: 12 }}>{t.name}</span>
                  <span className="faint grow" style={{ fontSize: 12 }}>{t.desc}</span>
                  <Badge tone={t.risk === 'read' ? 'neutral' : t.risk === 'write' ? 'info' : 'warning'}>{t.risk}</Badge>
                  <Switch on={on} disabled={!canManage} label={t.name} onChange={(v) => setDraft({ ...draft, tools: v ? [...draft.tools, t.name] : draft.tools.filter((x) => x !== t.name) })} />
                </div>
              );
            })}
          </div>
          <p className="faint mt-8" style={{ fontSize: 12 }}>No arbitrary SQL, shell, URL fetch or permission changes exist as tools. Allow-lists are enforced server-side, not by the prompt.</p>
        </section>
        <section className="form-grid">
          <Field label={`Daily budget (${currencySymbol()})`} hint="Non-essential runs pause when reached"><Input disabled={!canManage} value={draft.dailyBudget} inputMode="numeric" onChange={(e) => setDraft({ ...draft, dailyBudget: Number(e.target.value.replace(/\D/g, '')) || 0 })} /></Field>
          <Field label="Max steps per run" hint="Prevents loops"><Input disabled={!canManage} value={draft.maxSteps} inputMode="numeric" onChange={(e) => setDraft({ ...draft, maxSteps: Math.min(50, Number(e.target.value.replace(/\D/g, '')) || 1) })} /></Field>
        </section>
        <KV items={[
          ['Model', <span key="m" className="mono" style={{ fontSize: 12 }}>{a.model}</span>],
          ['Escalates when', a.escalation.length ? a.escalation.map((e) => <span key={e} className="tag">{e}</span>) : <span className="faint">—</span>],
          ['Data scope', 'Minimal projection of the current lead; no other tenants, no secrets'],
          ['Untrusted input', <span key="u" className="row"><ShieldCheck size={13} className="faint" /> Customer messages, transcripts and documents are treated as data, never instructions</span>],
        ]} />
        {draft.autonomy === 'bounded_auto' && draft.tools.includes('send_approved_message') && <div className="banner warning"><AlertTriangle size={15} /> This agent can message customers without approval. Make sure evals pass first.</div>}
        <section>
          <h4 className="section-title">Recent runs</h4>
          <div className="card" style={{ boxShadow: 'none' }}>
            {recent.map((r) => (
              <button key={r.id} className="list-row" onClick={() => navigate('logs', { id: r.id })}>
                <StatusBadge map={RUN_STATUS} value={r.status} />
                <span className="grow truncate" style={{ fontSize: 13 }}>{r.trigger}</span>
                <span className="mono faint" style={{ fontSize: 11.5 }}>{ms(r.durationMs)}</span>
                <span className="faint" style={{ fontSize: 12 }}>{relTime(r.startedAt)}</span>
              </button>
            ))}
          </div>
        </section>
      </div>
    </Drawer>
  );
}

