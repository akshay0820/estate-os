import { useEffect, useMemo, useState } from 'react';
import { Ban, Bot, Check, Copy, RotateCw, SquareTerminal, Workflow as WorkflowIcon, X, Loader2, Minus, SkipForward } from 'lucide-react';
import { Badge, Button, Drawer, Empty, KV, PageHeader, Pager, SearchInput, Select, Tabs } from '@/components/ui';
import { useStore } from '@/store/store';
import { useCan, useLookup, useOrgList } from '@/store/hooks';
import { toast } from '@/store/ui';
import { navigate, setParam } from '@/lib/router';
import { RUN_STATUS } from '@/lib/domain';
import { fmtDateTime, moneyPrecise, ms, relTime } from '@/lib/format';
import type { RunStatus } from '@/store/types';
import { StatusBadge } from './shared';

export function LogsPage({ params }: { params: URLSearchParams }) {
  const runs = useOrgList('runs');
  const leads = useLookup('leads');
  const [kind, setKind] = useState<'all' | 'agent' | 'workflow'>('all');
  const [status, setStatus] = useState(params.get('status') ?? '');
  const [ref, setRef] = useState(params.get('ref') ?? '');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  const openId = params.get('id');
  const names = useMemo(() => [...new Map(runs.map((r) => [r.refId, r.name.replace(/ \((test|eval)\)$/, '')])).entries()], [runs]);

  const filtered = useMemo(() => {
    const t = q.toLowerCase();
    return runs.filter((r) =>
      (kind === 'all' || r.kind === kind) &&
      (!status || (status === 'failed' ? ['failed', 'dead_letter'].includes(r.status) : r.status === status)) &&
      (!ref || r.refId === ref) &&
      (!t || r.name.toLowerCase().includes(t) || r.correlationId.includes(t) || (r.error ?? '').toLowerCase().includes(t) || (r.leadId && leads.get(r.leadId)?.name.toLowerCase().includes(t))),
    );
  }, [runs, kind, status, ref, q, leads]);
  useEffect(() => setPage(0), [kind, status, ref, q]);
  const rows = filtered.slice(page * 30, page * 30 + 30);
  const failed = runs.filter((r) => ['failed', 'dead_letter'].includes(r.status)).length;

  return (
    <div className="page">
      <PageHeader eyebrow={`[ ${runs.length} runs · ${failed} need review ]`} title="Execution logs" sub="One place for every agent run and workflow run: trigger, steps, duration, cost and sanitized errors. Search by correlation ID to trace a lead's journey." />
      <div className="card">
        <div style={{ padding: '4px 14px 0' }}>
          <Tabs value={kind} onChange={setKind} tabs={[{ value: 'all', label: 'All runs', count: runs.length }, { value: 'agent', label: 'Agent runs', count: runs.filter((r) => r.kind === 'agent').length }, { value: 'workflow', label: 'Workflow runs', count: runs.filter((r) => r.kind === 'workflow').length }]} />
        </div>
        <div className="toolbar">
          <SearchInput value={q} onChange={setQ} placeholder="Name, lead, error or cor_ id" width={260} />
          <Select selectSize="sm" value={status} onChange={(e) => { setStatus(e.target.value); setParam('status', e.target.value || null); }} style={{ width: 150 }} aria-label="Status">
            <option value="">Any status</option>
            <option value="failed">Failed / dead letter</option>
            {(Object.keys(RUN_STATUS) as RunStatus[]).map((s) => <option key={s} value={s}>{RUN_STATUS[s].label}</option>)}
          </Select>
          <Select selectSize="sm" value={ref} onChange={(e) => { setRef(e.target.value); setParam('ref', e.target.value || null); }} style={{ width: 220 }} aria-label="Agent or workflow">
            <option value="">All agents & workflows</option>
            {names.map(([id, n]) => <option key={id} value={id}>{n}</option>)}
          </Select>
        </div>
        {rows.length === 0 ? <Empty icon={<SquareTerminal size={20} />} title="No runs match" /> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Run</th><th>Status</th><th>Trigger</th><th>Lead</th><th className="right">Duration</th><th className="right">Cost</th><th>Started</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="clickable" onClick={() => setParam('id', r.id)}>
                    <td>
                      <div className="cell-main">
                        <span className={r.kind === 'agent' ? 'icon-chip accent' : 'icon-chip'}>{r.kind === 'agent' ? <Bot size={13} /> : <WorkflowIcon size={13} />}</span>
                        <div style={{ minWidth: 0 }}>
                          <div className="cell-title truncate" style={{ maxWidth: 280 }}>{r.name}</div>
                          <div className="cell-sub mono">{r.correlationId}</div>
                        </div>
                      </div>
                    </td>
                    <td><StatusBadge map={RUN_STATUS} value={r.status} /></td>
                    <td className="mono" style={{ fontSize: 11.5 }}>{r.trigger}</td>
                    <td>{r.leadId ? leads.get(r.leadId)?.name ?? '—' : '—'}</td>
                    <td className="right num mono" style={{ fontSize: 12 }}>{r.status === 'running' ? '…' : ms(r.durationMs)}</td>
                    <td className="right num mono" style={{ fontSize: 12 }}>{r.cost ? moneyPrecise(r.cost) : '—'}</td>
                    <td className="faint">{relTime(r.startedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager page={page} pageSize={30} total={filtered.length} onPage={setPage} />
      </div>
      {openId && <RunDrawer id={openId} onClose={() => setParam('id', null)} />}
    </div>
  );
}

function RunDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const r = useOrgList('runs').find((x) => x.id === id);
  const leads = useLookup('leads');
  const canManage = useCan('workflows.manage');
  const retry = useStore((s) => s.retryRun);
  if (!r) return null;
  const lead = r.leadId ? leads.get(r.leadId) : undefined;
  const canRetry = canManage && ['failed', 'skipped'].includes(r.status);
  return (
    <Drawer
      open
      onClose={onClose}
      label="Run"
      header={
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 600 }}>{r.name}</h2>
          <div className="row mt-8"><StatusBadge map={RUN_STATUS} value={r.status} /><span className="faint">{fmtDateTime(r.startedAt)} · attempt {r.attempt}</span></div>
        </div>
      }
      footer={
        <>
          {lead && <Button onClick={() => navigate('leads', { id: lead.id })}>Open lead</Button>}
          {canRetry && <Button variant="primary" icon={<RotateCw size={14} />} onClick={() => { retry(r.id); toast({ kind: 'info', title: 'Retry scheduled', body: `Attempt ${r.attempt + 1} of 3 · same idempotency key` }); }}>Retry</Button>}
        </>
      }
    >
      <div className="stack stack-lg">
        {r.error && <div className="banner danger"><X size={15} /> {r.error}</div>}
        {r.status === 'dead_letter' && <div className="banner warning">Retries exhausted. Fix the cause (for example reconnect the integration) and retry manually — the idempotency key prevents duplicate side effects.</div>}
        <KV items={[
          ['Correlation', <span key="c" className="row mono" style={{ fontSize: 12 }}>{r.correlationId}<button className="text-btn" onClick={() => { void navigator.clipboard?.writeText(r.correlationId); toast({ kind: 'success', title: 'Copied' }); }} aria-label="Copy correlation id"><Copy size={12} /></button></span>],
          ['Trigger', <span key="t" className="mono" style={{ fontSize: 12 }}>{r.trigger}</span>],
          ['Duration', r.status === 'running' ? 'Running…' : ms(r.durationMs)],
          ['Tokens', r.tokens ? r.tokens.toLocaleString('en-IN') : '—'],
          ['Cost', r.cost ? `${moneyPrecise(r.cost)} (estimate)` : '—'],
          ['Lead', lead?.name ?? '—'],
        ]} />
        <section>
          <h4 className="section-title">Steps</h4>
          <div className="steps">
            {r.steps.map((s, i) => (
              <div key={i} className="step" style={{ alignItems: 'flex-start' }}>
                <span className={`step-dot ${s.status}`}>{s.status === 'ok' ? <Check size={12} /> : s.status === 'fail' ? <X size={12} /> : s.status === 'run' ? <Loader2 size={12} className="spin" style={{ animation: 'spin .8s linear infinite' }} /> : s.status === 'skip' ? <SkipForward size={11} /> : <Minus size={12} />}</span>
                <div>
                  <div style={{ color: s.status === 'pending' ? 'var(--text-3)' : undefined }}>{s.label}</div>
                  {s.note && <div className="faint" style={{ fontSize: 12, marginTop: 2 }}>{s.note}</div>}
                </div>
                <span className="mono faint" style={{ fontSize: 11.5 }}>{s.ms ? ms(s.ms) : ''}</span>
              </div>
            ))}
          </div>
        </section>
        <p className="faint" style={{ fontSize: 12 }}>Logs hold concise summaries and policy decisions — never full message bodies, transcripts or secrets.</p>
        {r.status === 'cancelled' && <Badge><Ban size={11} /> Cancelled before completion</Badge>}
      </div>
    </Drawer>
  );
}
