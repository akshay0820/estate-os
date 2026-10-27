import { useMemo, useState } from 'react';
import { ArrowDown, Bot, Clock3, FlaskConical, GitBranch, LogOut, Play, Workflow as WorkflowIcon, Zap, Filter } from 'lucide-react';
import { Badge, Button, Drawer, Field, KV, Modal, PageHeader, Select, Switch } from '@/components/ui';
import { useStore } from '@/store/store';
import { useCan, useOrgList } from '@/store/hooks';
import { toast } from '@/store/ui';
import { navigate, setParam } from '@/lib/router';
import { RUN_STATUS } from '@/lib/domain';
import { DAY, ms, pct, relTime } from '@/lib/format';
import { cx } from '@/lib/util';
import type { Workflow, WorkflowStepDef } from '@/store/types';
import { StatusBadge } from './shared';

const KIND_ICON: Record<WorkflowStepDef['kind'], React.ReactNode> = {
  trigger: <Zap size={13} />, condition: <Filter size={13} />, action: <Play size={12} />, delay: <Clock3 size={13} />, ai: <Bot size={13} />, exit: <LogOut size={13} />,
};

export function WorkflowsPage({ params }: { params: URLSearchParams }) {
  const workflows = useOrgList('workflows');
  const runs = useOrgList('runs');
  const canManage = useCan('workflows.manage');
  const setStatus = useStore((s) => s.setWorkflowStatus);
  const openId = params.get('id');
  const stats = useMemo(() => {
    const m = new Map<string, { n: number; ok: number; last: number; failed: number }>();
    workflows.forEach((w) => {
      const rs = runs.filter((r) => r.refId === w.id && Date.now() - r.startedAt < 7 * DAY);
      const terminal = rs.filter((r) => ['succeeded', 'failed', 'dead_letter'].includes(r.status));
      m.set(w.id, { n: rs.length, ok: terminal.length ? terminal.filter((r) => r.status === 'succeeded').length / terminal.length : 1, last: rs[0]?.startedAt ?? 0, failed: rs.filter((r) => ['failed', 'dead_letter'].includes(r.status)).length });
    });
    return m;
  }, [workflows, runs]);

  return (
    <div className="page">
      <PageHeader
        eyebrow="[ Curated templates · single execution owner each ]"
        title="Workflows"
        sub="Versioned automations with triggers, conditions, bounded retries and exit rules. Each one is owned by exactly one engine so steps never run twice."
      />
      <div className="card">
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Workflow</th><th>Trigger</th><th>Owner</th><th className="right">Runs · 7d</th><th className="right">Success</th><th>Last run</th><th>Active</th></tr></thead>
            <tbody>
              {workflows.map((w) => {
                const st = stats.get(w.id)!;
                return (
                  <tr key={w.id} className="clickable" onClick={() => setParam('id', w.id)}>
                    <td>
                      <div className="cell-main">
                        <span className={cx('icon-chip', w.status === 'active' && 'accent')}><WorkflowIcon size={14} /></span>
                        <div style={{ minWidth: 0 }}>
                          <div className="cell-title truncate" style={{ maxWidth: 340 }}>{w.name}</div>
                          <div className="cell-sub truncate" style={{ maxWidth: 340 }}>{w.description}</div>
                        </div>
                      </div>
                    </td>
                    <td><span className="mono" style={{ fontSize: 11.5 }}>{w.trigger}</span></td>
                    <td><Badge tone={w.owner === 'n8n' ? 'info' : 'neutral'}>{w.owner === 'n8n' ? 'n8n' : 'App'} · v{w.version}</Badge></td>
                    <td className="right num">{st.n}{st.failed > 0 && <span className="badge badge-danger" style={{ marginLeft: 6 }}>{st.failed} failed</span>}</td>
                    <td className="right num">{pct(st.ok, 0)}</td>
                    <td className="faint">{st.last ? relTime(st.last) : '—'}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <Switch on={w.status === 'active'} disabled={!canManage} label={`${w.name} active`} onChange={(v) => { setStatus(w.id, v ? 'active' : 'paused'); toast({ kind: v ? 'success' : 'warning', title: `${w.name} ${v ? 'activated' : 'paused'}`, body: v ? undefined : 'New triggers are ignored; in-flight runs finish their current step.' }); }} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      {openId && <WorkflowDrawer id={openId} onClose={() => setParam('id', null)} />}
    </div>
  );
}

function WorkflowDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const w = useOrgList('workflows').find((x) => x.id === id);
  const runs = useOrgList('runs');
  const canManage = useCan('workflows.manage');
  const [testing, setTesting] = useState(false);
  if (!w) return null;
  const recent = runs.filter((r) => r.refId === w.id).slice(0, 10);
  return (
    <Drawer
      open
      wide
      onClose={onClose}
      label={w.name}
      header={
        <div>
          <h2 style={{ fontSize: 19, fontWeight: 600 }}>{w.name}</h2>
          <div className="row mt-8"><Badge tone={w.status === 'active' ? 'success' : 'warning'} dot>{w.status}</Badge><span className="faint">v{w.version} · owned by {w.owner === 'n8n' ? 'n8n (tracked here)' : 'Estate OS'}</span></div>
        </div>
      }
      footer={canManage ? <Button variant="primary" icon={<FlaskConical size={15} />} onClick={() => setTesting(true)}>Run in test mode</Button> : undefined}
    >
      <div className="stack stack-lg">
        <p className="faint">{w.description}</p>
        <section>
          <h4 className="section-title"><GitBranch size={12} /> Steps</h4>
          <div className="stack" style={{ gap: 0 }}>
            {w.steps.map((s, i) => (
              <div key={s.key}>
                <div className="card row" style={{ padding: '10px 14px', boxShadow: 'none', gap: 12 }}>
                  <span className={cx('icon-chip', s.kind === 'ai' && 'accent')}>{KIND_ICON[s.kind]}</span>
                  <span className="grow">{s.label}</span>
                  <span className="mono faint" style={{ fontSize: 11 }}>{s.kind}</span>
                </div>
                {i < w.steps.length - 1 && <div style={{ display: 'grid', placeItems: 'center', height: 22, color: 'var(--text-3)' }}><ArrowDown size={13} /></div>}
              </div>
            ))}
          </div>
        </section>
        <KV items={[
          ['Exit rules', w.exitRules.length ? w.exitRules.map((r) => <span key={r} className="tag">{r}</span>) : <span className="faint">Runs to completion</span>],
          ['Retries', `Up to ${w.maxRetries} attempts · exponential backoff with jitter · then dead-letter for review`],
          ['Idempotency', 'Each side effect carries a scoped key — duplicate triggers never send twice'],
          ['Policy', 'Consent, calling hours and suppression are re-checked right before any send'],
        ]} />
        <section>
          <h4 className="section-title">Recent runs</h4>
          <div className="card" style={{ boxShadow: 'none' }}>
            {recent.length === 0 && <div className="list-row faint">No runs yet.</div>}
            {recent.map((r) => (
              <button key={r.id} className="list-row" onClick={() => navigate('logs', { id: r.id })}>
                <StatusBadge map={RUN_STATUS} value={r.status} />
                <span className="grow truncate faint" style={{ fontSize: 12.5 }}>{r.error ?? r.correlationId}</span>
                <span className="mono faint" style={{ fontSize: 11.5 }}>{ms(r.durationMs)}</span>
                <span className="faint" style={{ fontSize: 12 }}>{relTime(r.startedAt)}</span>
              </button>
            ))}
          </div>
        </section>
      </div>
      {testing && <TestRunModal workflow={w} onClose={() => setTesting(false)} />}
    </Drawer>
  );
}

function TestRunModal({ workflow, onClose }: { workflow: Workflow; onClose: () => void }) {
  const leads = useOrgList('leads');
  const runWorkflow = useStore((s) => s.runWorkflow);
  const candidates = leads.filter((l) => !l.archived && !['won', 'lost'].includes(l.status)).slice(0, 100);
  const [leadId, setLeadId] = useState(candidates[0]?.id ?? '');
  const [running, setRunning] = useState(false);
  return (
    <Modal open onClose={onClose} title="Test run" description="Delays are skipped and every step is logged. Sends still pass the real policy gate." footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={running} icon={<Play size={14} />} onClick={async () => {
      setRunning(true);
      const r = await runWorkflow(workflow.id, { leadId, test: true });
      setRunning(false);
      onClose();
      toast({ kind: r?.status === 'succeeded' ? 'success' : 'warning', title: r?.status === 'succeeded' ? 'Test run succeeded' : `Test run ${r?.status ?? 'ended'}`, body: r?.steps.find((s) => s.note && s.status === 'skip')?.note, action: r ? { label: 'View log', run: () => navigate('logs', { id: r.id }) } : undefined });
    }}>Run test</Button></>}>
      <Field label="Sample lead">
        <Select value={leadId} onChange={(e) => setLeadId(e.target.value)}>
          {candidates.map((l) => <option key={l.id} value={l.id}>{l.name} — {l.status.replace(/_/g, ' ')}</option>)}
        </Select>
      </Field>
    </Modal>
  );
}
