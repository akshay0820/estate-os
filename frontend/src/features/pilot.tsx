// Pilot operations: the per-agent pause controls (server-enforced by agent_control_set) and an operational overview built
// by pilot_overview from persisted records only. Metrics the system does not record are listed as unavailable, never zero.
import { useState } from 'react';
import { AlertTriangle, Gauge, Pause, Play } from 'lucide-react';
import { Badge, Button, Empty, Modal, PageHeader, Segmented, Textarea } from '@/components/ui';
import { toast } from '@/store/ui';
import { relTime } from '@/lib/format';
import { useCan } from '@/store/hooks';
import { LIVE } from '@/store/store';
import { useServerQuery } from '@/data/useServerQuery';
import { attempt } from '@/data/actions';
import * as live from '@/backend/live';

const AGENTS: Record<live.PilotAgentId, { label: string; effect: string }> = {
  voice_calling_agent: { label: '2 · Voice calling', effect: 'New calls are refused.' },
  sales_qualification_agent: { label: '3 · Sales & qualification', effect: 'New leads wait unqualified; staff requests are held.' },
  property_matching_agent: { label: '4 · Property matching', effect: 'Qualified leads wait for matching.' },
  follow_up_agent: { label: '5 · Follow-up', effect: 'No new follow-ups are planned. Existing drafts can still be approved or sent manually.' },
  appointment_agent: { label: '6 · Appointment', effect: 'The AI scheduling assistant is refused. Staff can still book.' },
  crm_data_agent: { label: '7 · CRM & data intelligence', effect: 'AI enrichment suggestions are refused. Rule checks continue.' },
  sales_intelligence_agent: { label: '8 · Sales intelligence', effect: 'AI recommendations and questions are refused. Metrics continue.' },
};
const RUN_AGENT: Record<string, string> = {
  lead_intake_agent: '1 · Lead intake', sales_qualification_agent: '3 · Qualification', property_matching_agent: '4 · Matching', follow_up_agent: '5 · Follow-up', voice_calling_agent: '2 · Voice',
};

const n = (v: number | null | undefined) => (v === null || v === undefined ? '—' : String(v));
const secs = (v: number | null) => (v === null ? '—' : v < 120 ? `${v} s` : `${Math.round(v / 60)} min`);

function Kpi({ label, value, foot, tone }: { label: string; value: string; foot?: string; tone?: 'danger' | 'warning' }) {
  return (
    <div className="card kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value" style={tone ? { color: `var(--${tone})` } : undefined}>{value}</div>
      {foot && <div className="kpi-foot faint" style={{ fontSize: 12 }}>{foot}</div>}
    </div>
  );
}

export function PilotPage() {
  const [days, setDays] = useState<'1' | '7' | '30'>('7');
  const canManage = useCan('agents.manage');
  const q = useServerQuery(LIVE, () => live.pilotOverview(Number(days)), [days]);
  const [editing, setEditing] = useState<{ agent: live.PilotAgentId; pause: boolean } | null>(null);
  const o = q.data;

  if (!LIVE) {
    return (
      <div className="page">
        <PageHeader eyebrow="[ Pilot ]" title="Pilot operations" />
        <Empty icon={<Gauge size={20} />} title="Available with live data" description="Pilot controls and metrics read the workspace database; the demo has no server." />
      </div>
    );
  }
  return (
    <div className="page">
      <PageHeader eyebrow="[ Pilot ]" title="Pilot operations"
        sub="Agent controls and operational metrics for this workspace, from recorded data only. Business outcomes (response time, conversion) are on Sales intelligence."
        actions={<Segmented value={days} onChange={setDays} options={[{ value: '1', label: '24 h' }, { value: '7', label: '7 days' }, { value: '30', label: '30 days' }]} />} />

      {q.error ? <Empty icon={<Gauge size={20} />} title="Couldn't load the pilot overview" description={q.error} action={<Button onClick={q.reload}>Retry</Button>} />
        : !o ? <div className="skeleton" style={{ height: 160 }} /> : (
          <>
            {o.organization.outbound_paused && <div className="banner danger"><AlertTriangle size={14} /> All outbound communication is paused for this workspace (AI agents page).</div>}

            <section className="mt-12">
              <h4 className="section-title">Agent controls</h4>
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Agent</th><th>State</th><th>When paused</th><th>Last change</th><th /></tr></thead>
                  <tbody>
                    <tr>
                      <td>1 · Lead intake</td><td><Badge tone="success">Always on</Badge></td>
                      <td className="faint">Cannot be paused: captured leads are never dropped. Stop a source by rotating its webhook secret.</td><td /><td />
                    </tr>
                    {o.controls.map((c) => (
                      <tr key={c.agent_id}>
                        <td>{AGENTS[c.agent_id].label}</td>
                        <td>{c.paused ? <Badge tone="warning" dot>Paused</Badge> : <Badge tone="success" dot>Active</Badge>}</td>
                        <td className="faint" style={{ maxWidth: 360 }}>{AGENTS[c.agent_id].effect}</td>
                        <td className="faint" style={{ maxWidth: 260 }}>{c.changed_at ? `${relTime(new Date(c.changed_at).getTime())} — ${c.reason}` : 'Never changed'}</td>
                        <td>{canManage && (
                          <Button size="xs" icon={c.paused ? <Play size={12} /> : <Pause size={12} />} onClick={() => setEditing({ agent: c.agent_id, pause: !c.paused })}>
                            {c.paused ? 'Resume' : 'Pause'}
                          </Button>)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="row wrap mt-8" style={{ gap: 6, fontSize: 12 }}>
                <span className="tag">AI calling setting: {o.settings.voice_enabled ? 'on' : 'off'}</span>
                <span className="tag">Follow-up automation setting: {o.settings.follow_up_enabled ? 'on' : 'off'}</span>
                <span className="tag">Intake AI extraction: {o.settings.intake_extraction_enabled ? 'on' : 'off'}</span>
                <span className="tag">Qualification AI step: {o.settings.qualification_llm_enabled ? 'on' : 'off'}</span>
              </div>
            </section>

            <section className="mt-16">
              <h4 className="section-title">Operations · last {days === '1' ? '24 hours' : `${days} days`}</h4>
              <div className="grid g-kpi-6">
                <Kpi label="Leads created" value={n(o.intake.leads_created)} foot={Object.entries(o.intake.by_source_kind).map(([k, v]) => `${v} ${k}`).join(' · ') || 'no intake runs'} />
                <Kpi label="Rejected webhook attempts" value={n(o.intake.webhooks_rejected)} foot={`attempts (repeats counted) · ${o.intake.webhooks_processed} webhooks processed`} tone={o.intake.webhooks_rejected > 0 ? 'warning' : undefined} />
                <Kpi label="Events waiting" value={n(o.events.pending)} foot={o.events.oldest_pending_seconds === null ? 'none pending' : `oldest ${secs(o.events.oldest_pending_seconds)}`} />
                <Kpi label="Failed events" value={n(o.events.dead_letter)} foot="dead-lettered, need a person" tone={o.events.dead_letter > 0 ? 'danger' : undefined} />
                <Kpi label="Human review backlog" value={n(Object.values(o.review_backlog).reduce((a, b) => a + b, 0))}
                  foot={`${o.review_backlog.follow_ups} drafts · ${o.review_backlog.qualifications} qualifications · ${o.review_backlog.intake_duplicates + o.review_backlog.duplicate_candidates} duplicates`} />
                <Kpi label="Appointments confirmed" value={n(o.appointments.confirmed)} foot={`${o.appointments.created} created`} />
              </div>
              <div className="table-wrap mt-8">
                <table className="table">
                  <thead><tr><th>Agent runs</th><th>Runs</th><th>Succeeded</th><th>Review</th><th>Invalid</th><th>Failed</th><th>Waiting</th><th>Held (paused)</th><th>Retried</th><th>p50 / p95</th><th>Last success</th></tr></thead>
                  <tbody>
                    {Object.keys(o.agents).length === 0 ? <tr><td colSpan={11} className="faint">No agent runs in this period.</td></tr>
                      : Object.entries(o.agents).map(([id, a]) => (
                        <tr key={id}>
                          <td>{RUN_AGENT[id] ?? id}</td><td>{a.runs}</td><td>{a.succeeded}</td><td>{a.review_required}</td><td>{a.invalid}</td>
                          <td style={a.dead_letter ? { color: 'var(--danger)' } : undefined}>{a.dead_letter}</td><td>{a.waiting}</td><td>{a.held}</td><td>{a.retried}</td>
                          <td>{secs(a.p50_seconds)} / {secs(a.p95_seconds)}</td><td className="faint">{a.last_succeeded_at ? relTime(new Date(a.last_succeeded_at).getTime()) : '—'}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="mt-16">
              <h4 className="section-title">Quality signals · staff decisions on agent output</h4>
              <div className="grid g-kpi-6">
                <Kpi label="Qualifications" value={n(o.qualification.results)} foot={`${o.qualification.corrected} corrected · ${o.qualification.approved} approved · ${o.qualification.review_pending} pending`} />
                <Kpi label="Match recommendations" value={n(o.matching.recommendations)} foot={`${o.matching.accepted} accepted · ${o.matching.rejected_by_staff} rejected · ${o.matching.invalidated} invalidated`} />
                <Kpi label="Follow-ups planned" value={n(o.follow_ups.created)} foot={`${o.follow_ups.edited_by_staff} edited · ${o.follow_ups.sent} sent · ${o.follow_ups.failed} failed · ${o.follow_ups.suppressed} suppressed`} />
                <Kpi label="Duplicates" value={n(o.data_quality.duplicates_open)} foot={`open · ${o.data_quality.duplicates_merged} merged · ${o.data_quality.duplicates_rejected} rejected in period`} />
                <Kpi label="Open data issues" value={n(Object.values(o.data_quality.open_issues).reduce((a, b) => a + b, 0))}
                  foot={Object.entries(o.data_quality.open_issues).map(([k, v]) => `${v} ${k}`).join(' · ') || 'none'} />
                <Kpi label="AI requests (user-triggered)" value={n(Object.values(o.ai_requests).reduce((a, b) => a + b.requests, 0))}
                  foot={`${Object.values(o.ai_requests).reduce((a, b) => a + b.failed, 0)} failed · AI step in qualification: ${o.qualification.ai_succeeded} ok, ${o.qualification.ai_not_configured} not configured`} />
              </div>
            </section>

            <section className="mt-16">
              <h4 className="section-title">Not measured by the system</h4>
              <ul className="faint" style={{ fontSize: 13, paddingLeft: 18 }}>
                {o.unavailable.map((u) => <li key={u.metric}><b>{u.metric.replace(/_/g, ' ')}</b>: {u.reason}</li>)}
              </ul>
              <p className="faint" style={{ fontSize: 12 }}>Computed {relTime(new Date(o.computed_at).getTime())} for {o.organization.name} ({o.organization.timezone}).</p>
            </section>
          </>
        )}
      {editing && <ControlModal {...editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function ControlModal({ agent, pause, onClose }: { agent: live.PilotAgentId; pause: boolean; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = reason.trim().length >= 5 && reason.trim().length <= 300;
  return (
    <Modal open onClose={onClose} title={`${pause ? 'Pause' : 'Resume'} ${AGENTS[agent].label}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant={pause ? 'danger' : 'primary'} disabled={!valid} loading={busy} onClick={async () => {
          setBusy(true);
          const r = await attempt(() => live.setAgentPaused(agent, pause, reason.trim()));
          setBusy(false);
          if (!r) return;
          toast({ kind: pause ? 'warning' : 'success', title: pause ? 'Agent paused' : 'Agent resumed',
            body: pause ? `${r.held_runs ?? 0} queued runs held. ${AGENTS[agent].effect}` : `${r.released_runs ?? 0} held runs released for processing.` });
          onClose();
        }}>{pause ? 'Pause agent' : 'Resume agent'}</Button></>}>
      <p className="faint" style={{ fontSize: 13 }}>{pause ? AGENTS[agent].effect + ' Nothing is deleted; resuming processes the held work.' : 'Held runs and waiting events will be processed on the next cycle (within a minute).'}</p>
      <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (recorded in the audit log)" rows={3} />
    </Modal>
  );
}
