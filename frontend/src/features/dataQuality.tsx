// Agent 07 — CRM & Data Intelligence: the data quality workspace (findings, duplicate review, merges) and the quality
// panel shown on lead, contact and property records. Everything here reads persisted server state; merges, corrections
// and dismissals are server-authorized RPCs, and nothing is merged or corrected without a person choosing to.
import { useMemo, useState } from 'react';
import { AlertTriangle, BadgeCheck, Check, DatabaseZap, GitMerge, RefreshCw, ShieldCheck, Sparkles, Undo2, X } from 'lucide-react';
import { Badge, Button, Empty, Modal, PageHeader, Pager, Select, Tabs } from '@/components/ui';
import { confirm } from '@/components/dialogs';
import { toast } from '@/store/ui';
import { fmtDateTime, relTime } from '@/lib/format';
import { navigate } from '@/lib/router';
import type { Tone } from '@/lib/domain';
import { LIVE } from '@/store/store';
import { usePollWhile, useServerQuery } from '@/data/useServerQuery';
import { attempt, ok } from '@/data/actions';
import * as live from '@/backend/live';

export const SEVERITY: Record<live.DqSeverity, { label: string; tone: Tone }> = {
  critical: { label: 'Critical', tone: 'danger' }, high: { label: 'High', tone: 'danger' }, warning: { label: 'Warning', tone: 'warning' }, info: { label: 'Info', tone: 'neutral' },
};
const STATUS: Record<live.DqStatus, string> = {
  open: 'Open', reopened: 'Reopened', under_review: 'In review', proposed: 'Suggested correction', resolved: 'Resolved', dismissed: 'Dismissed',
};
const ENTITY: Record<live.DqEntity, string> = { contact: 'Contact', lead: 'Lead', property: 'Listing', appointment: 'Appointment', integration: 'Integration', organization: 'Workspace' };
const STRENGTH: Record<live.DqCandidate['strength'], { label: string; tone: Tone }> = {
  strong: { label: 'Strong match', tone: 'danger' }, possible: { label: 'Possible match', tone: 'warning' }, weak: { label: 'Weak match', tone: 'neutral' },
};
const SOURCE: Record<string, string> = {
  user_entry: 'Entered by a person', lead_intake: 'Lead intake', ai_extraction: 'AI extraction (unverified)', system: 'Automated', correction: 'Approved correction',
  merge: 'Merged record', legacy: 'Recorded before tracking',
};
const FIELD: Record<string, string> = {
  display_name: 'Name', email: 'Email', phone: 'Phone', budget_min: 'Budget (min)', budget_max: 'Budget (max)', budget_currency: 'Currency', desired_transaction: 'Transaction',
  desired_property_type: 'Property type', desired_locations: 'Locations', bedrooms: 'Bedrooms', timeline: 'Timeline', source: 'Source', price: 'Price', currency: 'Currency',
  status: 'Status', address_line_1: 'Address', locality: 'Locality', city: 'City', area_value: 'Area',
};
// The server returns comparison fields as a JSON object (unordered); show them in reading order.
const FIELD_ORDER = ['Name', 'Title', 'Reference', 'Phone', 'Email', 'Status', 'Type', 'Listing', 'Transaction', 'Price', 'Budget', 'Bedrooms', 'Area',
  'Address', 'Locality', 'Locations', 'City', 'Source', 'Preferred channel', 'Verified', 'Created'];
const PAGE_OF: Partial<Record<live.DqEntity, string>> = { contact: 'contacts', lead: 'leads', property: 'properties', appointment: 'appointments', integration: 'integrations' };

function openRecord(type: live.DqEntity, id: string) {
  const page = PAGE_OF[type];
  if (page) navigate(page, type === 'integration' ? {} : { id });
}

/* ─────────────────────────── page ─────────────────────────── */

type PageTab = 'issues' | 'duplicates' | 'merges';

export function DataQualityPage() {
  const [tab, setTab] = useState<PageTab>('issues');
  const ov = useServerQuery(LIVE, () => live.dataQualityOverview(), []);
  const o = ov.data;
  usePollWhile(!!o?.last_scan && ['requested', 'running'].includes(o.last_scan.status), ov.reload, 10_000, 15 * 60_000);
  if (!LIVE) {
    return (
      <div className="page">
        <PageHeader eyebrow="[ CRM & Data Intelligence Agent ]" title="Data quality" />
        <Empty icon={<DatabaseZap size={20} />} title="Available with live data" description="Data quality checks run on the workspace database; the demo has no server to evaluate." />
      </div>
    );
  }
  const scanActive = o?.last_scan && ['requested', 'running'].includes(o.last_scan.status);
  return (
    <div className="page">
      <PageHeader eyebrow="[ CRM & Data Intelligence Agent ]" title="Data quality"
        sub="Deterministic checks on contacts, leads, listings, appointments and integrations. Findings explain themselves; corrections and merges always need a person."
        actions={o?.can.scan ? (
          scanActive ? (
            <Button icon={<X size={14} />} onClick={async () => { if (await ok(() => live.cancelDataQualityScan(o.last_scan!.id))) toast({ kind: 'info', title: 'Scan cancelled' }); }}>
              Scan {o.last_scan!.status === 'running' ? `running · ${o.last_scan!.counts.evaluated ?? 0} checked` : 'queued'} — cancel
            </Button>
          ) : (
            <Button icon={<RefreshCw size={14} />} onClick={async () => {
              const r = await attempt(() => live.requestDataQualityScan());
              if (r) toast({ kind: 'info', title: 'Full scan queued', body: 'It runs in the background in batches; results appear as records are checked.' });
            }}>Run full scan</Button>
          )) : undefined} />

      {ov.error ? <Empty icon={<DatabaseZap size={20} />} title="Couldn't load data quality" description={ov.error} action={<Button onClick={ov.reload}>Retry</Button>} />
        : !o ? <div className="skeleton" style={{ height: 110 }} /> : (
          <>
            <div className="grid g-kpi-6">
              <Kpi label="Average record score" value={o.score.average === null ? '—' : String(o.score.average)} foot={`${o.score.records} records · ${o.score.version}`} title={o.score.note} />
              <Kpi label="Critical / high issues" value={`${o.issues.critical} / ${o.issues.high}`} foot={`${o.issues.open} open in total`} tone={o.issues.critical > 0 ? 'danger' : undefined} />
              <Kpi label="Records with issues" value={String(o.issues.records_affected)} foot={`${o.issues.invalid_records} invalid · ${o.issues.incomplete_records} incomplete`} />
              <Kpi label="Duplicates to review" value={String(o.duplicates.awaiting_review)} foot={`${o.duplicates.strong} strong · ${o.duplicates.weak} weak`} />
              <Kpi label="Stale records" value={String(o.issues.stale_records)} foot={`${o.issues.proposed_corrections} suggested corrections`} />
              <Kpi label="Sync problems" value={String(o.issues.sync_problems)} foot={`${o.integrations.connected} integrations connected`} />
            </div>
            <div className="row wrap mt-8" style={{ gap: 6, fontSize: 12 }}>
              <span className="tag">{o.resolved_since} resolved · {o.merges_since} merged in 30 days</span>
              <span className="tag">{o.queue.pending} changes waiting to be checked{o.queue.oldest ? ` (oldest ${relTime(new Date(o.queue.oldest).getTime())})` : ''}</span>
              {o.last_scan && <span className="tag">Last scan: {o.last_scan.status}{o.last_scan.completed_at ? ` ${relTime(new Date(o.last_scan.completed_at).getTime())}` : ''}</span>}
              {o.baseline && !o.baseline.evaluated && <span className="tag">Anomaly checks need 7 days of history ({o.baseline.baseline_days} so far)</span>}
            </div>
            {o.queue.failing > 0 && <div className="banner warning mt-8"><AlertTriangle size={14} /> {o.queue.failing} records could not be checked and will be retried automatically.</div>}
          </>
        )}

      <div className="mt-12">
        <Tabs value={tab} onChange={setTab} tabs={[
          { value: 'issues', label: 'Issues', count: o?.issues.open },
          { value: 'duplicates', label: 'Duplicates', count: o?.duplicates.awaiting_review },
          { value: 'merges', label: 'Merge history' },
        ]} />
      </div>
      {tab === 'issues' && <IssuesTab />}
      {tab === 'duplicates' && <DuplicatesTab />}
      {tab === 'merges' && <MergesTab canMerge={o?.can.merge ?? false} />}
    </div>
  );
}

function Kpi({ label, value, foot, tone, title }: { label: string; value: string; foot: string; tone?: 'danger'; title?: string }) {
  return (
    <div className="card kpi" title={title}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value" style={tone === 'danger' ? { color: 'var(--danger)' } : undefined}>{value}</div>
      <div className="kpi-foot faint" style={{ fontSize: 12 }}>{foot}</div>
    </div>
  );
}

const ACTIVE: live.DqStatus[] = ['open', 'reopened', 'under_review', 'proposed'];

function IssuesTab() {
  const [severity, setSeverity] = useState('');
  const [entity, setEntity] = useState('');
  const [status, setStatus] = useState('active');
  const [page, setPage] = useState(0);
  const q = useServerQuery(true, () => live.dataQualityIssues({
    status: status === 'active' ? ACTIVE : [status as live.DqStatus], severity: severity ? [severity as live.DqSeverity] : undefined,
    entity: (entity || null) as live.DqEntity | null, page, pageSize: 25,
  }), [severity, entity, status, page]);
  return (
    <div className="card mt-8">
      <div className="toolbar">
        <Select selectSize="sm" value={status} onChange={(e) => { setStatus(e.target.value); setPage(0); }} style={{ width: 170 }} aria-label="Status">
          <option value="active">Needs attention</option>
          <option value="proposed">Suggested corrections</option>
          <option value="resolved">Resolved</option>
          <option value="dismissed">Dismissed</option>
        </Select>
        <Select selectSize="sm" value={severity} onChange={(e) => { setSeverity(e.target.value); setPage(0); }} style={{ width: 140 }} aria-label="Severity">
          <option value="">Any severity</option>
          {(Object.keys(SEVERITY) as live.DqSeverity[]).map((s) => <option key={s} value={s}>{SEVERITY[s].label}</option>)}
        </Select>
        <Select selectSize="sm" value={entity} onChange={(e) => { setEntity(e.target.value); setPage(0); }} style={{ width: 150 }} aria-label="Record type">
          <option value="">All records</option>
          {(Object.keys(ENTITY) as live.DqEntity[]).map((s) => <option key={s} value={s}>{ENTITY[s]}</option>)}
        </Select>
      </div>
      {q.error ? <p className="faint" style={{ padding: 12 }}>Couldn't load issues. {q.error}</p>
        : q.loading && !q.data ? <div className="skeleton" style={{ height: 120 }} />
        : (q.data?.items.length ?? 0) === 0 ? <Empty icon={<ShieldCheck size={20} />} title="Nothing here" description={status === 'active' ? 'No open data quality issues match these filters.' : 'No issues match these filters.'} />
        : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Severity</th><th>Issue</th><th>Record</th><th>Detected</th><th>Status</th><th>Suggested action</th><th /></tr></thead>
                <tbody>
                  {q.data!.items.map((x) => (
                    <tr key={x.id}>
                      <td><Badge tone={SEVERITY[x.severity].tone}>{SEVERITY[x.severity].label}</Badge></td>
                      <td style={{ maxWidth: 320 }}>{x.message}<div className="mono faint" style={{ fontSize: 11 }}>{x.rule_id}</div></td>
                      <td>{PAGE_OF[x.entity_type] ? <button className="link" onClick={() => openRecord(x.entity_type, x.entity_id)}>{x.entity_label ?? ENTITY[x.entity_type]}</button> : (x.entity_label ?? ENTITY[x.entity_type])}
                        <div className="faint" style={{ fontSize: 11 }}>{ENTITY[x.entity_type]}</div></td>
                      <td className="faint" style={{ fontSize: 12.5 }} title={fmtDateTime(new Date(x.first_detected_at).getTime())}>{relTime(new Date(x.last_detected_at).getTime())}</td>
                      <td><span style={{ fontSize: 12.5 }}>{STATUS[x.status]}</span>{x.assignee_name ? <div className="faint" style={{ fontSize: 11 }}>{x.assignee_name}</div> : null}
                        {x.resolution_note ? <div className="faint" style={{ fontSize: 11 }}>{x.resolution_note}</div> : null}</td>
                      <td className="faint" style={{ fontSize: 12.5, maxWidth: 260 }}>{x.recommended_action}</td>
                      <td><IssueActions issue={x} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={page} pageSize={25} total={q.data!.total} onPage={setPage} />
          </>
        )}
    </div>
  );
}

function IssueActions({ issue: x }: { issue: live.DqIssue }) {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, title: string) => {
    setBusy(true);
    if (await ok(fn)) toast({ kind: 'success', title });
    setBusy(false);
  };
  const active = ACTIVE.includes(x.status);
  return (
    <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
      {active && x.proposed_fix && (
        <Button size="xs" variant="primary" icon={<Check size={12} />} loading={busy}
          title={`Set ${FIELD[x.proposed_fix.field] ?? x.proposed_fix.field} to “${String(x.proposed_fix.value)}”`}
          onClick={async () => {
            const c = await confirm({ title: 'Apply this correction?', body: <>Set <b>{FIELD[x.proposed_fix!.field] ?? x.proposed_fix!.field}</b> to <b>{String(x.proposed_fix!.value)}</b>.{x.origin === 'ai_extraction' && typeof x.evidence.evidence === 'string' ? <> Evidence from the notes: “{x.evidence.evidence}”.</> : null} The change is audited.</>, confirmLabel: 'Apply' });
            if (c.ok) await run(() => live.dataQualityApplyFix(x.id), 'Correction applied');
          }}>Apply</Button>
      )}
      {active && x.status !== 'under_review' && <Button size="xs" variant="ghost" loading={busy} onClick={() => run(() => live.dataQualityIssueAction(x.id, 'start_review'), 'Taken for review')}>Review</Button>}
      {active && x.severity !== 'critical' && (
        <Button size="xs" variant="ghost" loading={busy} onClick={async () => {
          const c = await confirm({ title: 'Dismiss this issue?', body: 'It stays dismissed even if the check finds it again. Say why it is not a problem.', input: { label: 'Reason', required: true }, confirmLabel: 'Dismiss' });
          if (c.ok && c.value) await run(() => live.dataQualityIssueAction(x.id, 'dismiss', c.value), 'Dismissed');
        }}>Dismiss</Button>
      )}
      {x.status === 'dismissed' && <Button size="xs" variant="ghost" loading={busy} onClick={() => run(() => live.dataQualityIssueAction(x.id, 'reopen'), 'Reopened')}>Reopen</Button>}
    </div>
  );
}

function DuplicatesTab() {
  const [entity, setEntity] = useState('');
  const [strength, setStrength] = useState('review');
  const [status, setStatus] = useState<live.DqCandidate['status']>('open');
  const [page, setPage] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const q = useServerQuery(true, () => live.duplicateCandidates({
    status, entity: (entity || null) as live.DqCandidate['entity_type'] | null,
    strength: strength === 'review' ? ['strong', 'possible'] : strength ? [strength as live.DqCandidate['strength']] : undefined, page, pageSize: 25,
  }), [entity, strength, status, page]);
  return (
    <div className="card mt-8">
      <div className="toolbar">
        <Select selectSize="sm" value={status} onChange={(e) => { setStatus(e.target.value as live.DqCandidate['status']); setPage(0); }} style={{ width: 140 }} aria-label="Status">
          <option value="open">To review</option><option value="merged">Merged</option><option value="rejected">Not duplicates</option><option value="stale">No longer matching</option>
        </Select>
        <Select selectSize="sm" value={strength} onChange={(e) => { setStrength(e.target.value); setPage(0); }} style={{ width: 170 }} aria-label="Strength">
          <option value="review">Strong and possible</option><option value="strong">Strong only</option><option value="weak">Weak only</option><option value="">Any strength</option>
        </Select>
        <Select selectSize="sm" value={entity} onChange={(e) => { setEntity(e.target.value); setPage(0); }} style={{ width: 140 }} aria-label="Record type">
          <option value="">All records</option><option value="contact">Contacts</option><option value="lead">Leads</option><option value="property">Listings</option>
        </Select>
      </div>
      {q.error ? <p className="faint" style={{ padding: 12 }}>Couldn't load duplicates. {q.error}</p>
        : q.loading && !q.data ? <div className="skeleton" style={{ height: 120 }} />
        : (q.data?.items.length ?? 0) === 0 ? <Empty icon={<GitMerge size={20} />} title="No duplicate candidates" description="Candidates come from exact phone / email matches, repeat enquiries from one contact, and listings at the same address with matching details." />
        : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Match</th><th>Records</th><th>Why</th><th>Detected</th></tr></thead>
                <tbody>
                  {q.data!.items.map((c) => (
                    <tr key={c.id} className="clickable" onClick={() => setOpenId(c.id)}>
                      <td><Badge tone={STRENGTH[c.strength].tone}>{STRENGTH[c.strength].label}</Badge> <span className="mono faint" style={{ fontSize: 11 }}>{c.score}</span>
                        <div className="faint" style={{ fontSize: 11 }}>{ENTITY[c.entity_type]}s</div></td>
                      <td>{c.label_a ?? '—'}<div className="faint">{c.label_b ?? '—'}</div></td>
                      <td className="faint" style={{ fontSize: 12.5, maxWidth: 380 }}>{c.explanation}</td>
                      <td className="faint" style={{ fontSize: 12.5 }}>{relTime(new Date(c.last_detected_at).getTime())}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={page} pageSize={25} total={q.data!.total} onPage={setPage} />
          </>
        )}
      {openId && <DuplicateReview id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

/** Side-by-side review. The person picks the record to keep; the server re-checks both records before merging. */
export function DuplicateReview({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useServerQuery(true, () => live.duplicateCandidateDetail(id), [id]);
  const d = q.data;
  const canMerge = d?.can_merge ?? false;
  const [keep, setKeep] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canonical = keep ?? d?.candidate.proposed_canonical ?? null;
  const fields = useMemo(() => (d ? Array.from(new Set(d.records.flatMap((r) => Object.keys(r.fields))))
    .sort((a, b) => (FIELD_ORDER.indexOf(a) + 1 || 99) - (FIELD_ORDER.indexOf(b) + 1 || 99)) : []), [d]);
  const related = useMemo(() => (d ? Array.from(new Set(d.records.flatMap((r) => Object.keys(r.related)))) : []), [d]);
  const changed = d && d.current_state_hash !== d.candidate.state_hash;
  const other = d?.records.find((r) => r.id !== canonical);
  const blockers = d?.candidate.entity_type === 'property' && other ? (other.related.active_appointments ?? 0) + (other.related.open_deals ?? 0) : 0;
  const show = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? fmtDateTime(new Date(v).getTime()) : String(v));

  const merge = async () => {
    if (!d || !canonical || !other) return;
    const moved = Object.entries(other.related).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`).join(', ') || 'no linked records';
    const c = await confirm({
      title: 'Merge these records?',
      body: <>The kept record stays as it is; empty fields are filled from the other one and differing values are kept as they are. The other record is not deleted: it becomes a pointer to the kept one.
        {' '}Moves: {moved}.{d.candidate.entity_type === 'contact' ? ' Opt-outs always carry over; a consent is carried only where the kept contact has no decision.' : ''}
        {d.revertible ? ' You can revert this merge later.' : ' Lead merges cannot be reverted.'}</>,
      confirmLabel: 'Merge', danger: !d.revertible,
    });
    if (!c.ok) return;
    setBusy(true);
    const r = await attempt(() => live.decideDuplicate(d.candidate, 'merge', canonical));
    setBusy(false);
    if (r) { toast({ kind: 'success', title: 'Merged', body: 'History and relationships now live on the kept record.' }); onClose(); }
    else q.reload();
  };
  const reject = async () => {
    if (!d) return;
    const c = await confirm({ title: 'Not duplicates?', body: 'They will not be proposed again unless you reopen the decision from the record.', input: { label: 'Note (optional)' }, confirmLabel: 'Mark as different' });
    if (!c.ok) return;
    setBusy(true);
    const r = await attempt(() => live.decideDuplicate(d.candidate, 'reject', null, c.value));
    setBusy(false);
    if (r) { toast({ kind: 'success', title: 'Marked as different records' }); onClose(); }
  };

  return (
    <Modal open size="wide" onClose={onClose} title="Review possible duplicate"
      description={d ? <>{STRENGTH[d.candidate.strength].label} ({d.candidate.score}/100): {d.candidate.explanation}</> : undefined}
      footer={d && d.candidate.status === 'open' && canMerge ? (
        <>
          <Button variant="ghost" onClick={reject} loading={busy}>Not duplicates</Button>
          <Button variant="primary" icon={<GitMerge size={14} />} onClick={merge} loading={busy} disabled={!!changed || blockers > 0}>Merge into the selected record</Button>
        </>
      ) : <Button onClick={onClose}>Close</Button>}>
      {q.error ? <p className="faint">Couldn't load the comparison. {q.error}</p> : !d ? <div className="skeleton" style={{ height: 200 }} /> : (
        <div className="stack">
          {changed && <div className="banner warning"><AlertTriangle size={14} /> One of the records changed after this comparison. It will be re-checked within a minute; reopen it then.</div>}
          {blockers > 0 && <div className="banner warning"><AlertTriangle size={14} /> The listing that would be archived has active appointments or open deals. Move or close them first.</div>}
          {!canMerge && d.candidate.status === 'open' && <div className="banner"><ShieldCheck size={14} /> You can review the evidence; merging needs the merge permission.</div>}
          <div className="row wrap" style={{ gap: 6 }}>
            {d.candidate.signals.map((s) => <Badge key={s.signal} tone="success">+{s.weight} {s.signal.replace(/_/g, ' ')}</Badge>)}
            {d.candidate.conflicts.map((s) => <Badge key={s.signal} tone="warning">{s.weight} {s.signal.replace(/_/g, ' ')}</Badge>)}
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th />{d.records.map((r, i) => (
                  <th key={r.id}>
                    <label className="row" style={{ gap: 6, cursor: d.candidate.status === 'open' ? 'pointer' : 'default' }}>
                      {d.candidate.status === 'open' && <input type="radio" name="keep" checked={canonical === r.id} onChange={() => setKeep(r.id)} />}
                      Record {i === 0 ? 'A' : 'B'} {canonical === r.id ? <Badge tone="accent">keep</Badge> : null}
                      {r.id === d.candidate.proposed_canonical ? <span className="faint" style={{ fontSize: 11 }}>suggested</span> : null}
                    </label>
                  </th>
                ))}</tr>
              </thead>
              <tbody>
                {fields.map((f) => {
                  const vals = d.records.map((r) => show(r.fields[f]));
                  const differ = vals[0] !== vals[1] && vals.every((v) => v !== '—');
                  return <tr key={f}><td className="faint">{f}</td>{vals.map((v, i) => <td key={i} style={differ ? { color: 'var(--warning)' } : undefined}>{v}</td>)}</tr>;
                })}
                {related.map((k) => <tr key={k}><td className="faint">{k.replace(/_/g, ' ')}</td>{d.records.map((r) => <td key={r.id}>{r.related[k] ?? 0}</td>)}</tr>)}
                {d.records.some((r) => r.consents) && (
                  <tr><td className="faint">consent</td>{d.records.map((r) => <td key={r.id} style={{ fontSize: 12 }}>{Object.entries(r.consents ?? {}).filter(([, s]) => s !== 'unknown').map(([k, s]) => `${k}: ${s}`).join(' · ') || 'none recorded'}</td>)}</tr>
                )}
              </tbody>
            </table>
          </div>
          {d.merge && <p className="faint" style={{ fontSize: 12.5 }}>Merged {fmtDateTime(new Date(d.merge.merged_at).getTime())}{d.merge.conflicts.length ? ` · differing values kept on the kept record: ${d.merge.conflicts.join(', ')}` : ''} · {d.merge.status}.</p>}
        </div>
      )}
    </Modal>
  );
}

function MergesTab({ canMerge }: { canMerge: boolean }) {
  const q = useServerQuery(true, () => live.recentMerges(), []);
  return (
    <div className="card mt-8">
      {q.error ? <p className="faint" style={{ padding: 12 }}>Couldn't load merges. {q.error}</p>
        : q.loading && !q.data ? <div className="skeleton" style={{ height: 120 }} />
        : (q.data?.length ?? 0) === 0 ? <Empty icon={<GitMerge size={20} />} title="No merges yet" description="Merges appear here after a person approves a duplicate." />
        : (
          <table className="table">
            <thead><tr><th>When</th><th>Records</th><th>Differing values kept</th><th>Status</th><th /></tr></thead>
            <tbody>
              {q.data!.map((m) => (
                <tr key={m.id}>
                  <td className="faint" style={{ fontSize: 12.5 }}>{fmtDateTime(new Date(m.merged_at).getTime())}</td>
                  <td><button className="link" onClick={() => openRecord(m.entity_type as live.DqEntity, m.canonical_id)}>Open kept {ENTITY[m.entity_type as live.DqEntity].toLowerCase()}</button></td>
                  <td className="faint" style={{ fontSize: 12.5 }}>{m.conflicts.length ? m.conflicts.join(', ') : '—'}</td>
                  <td><Badge tone={m.status === 'completed' ? 'success' : 'neutral'}>{m.status}</Badge></td>
                  <td>{canMerge && m.status === 'completed' && m.revertible && (
                    <Button size="xs" variant="ghost" icon={<Undo2 size={12} />} onClick={async () => {
                      const c = await confirm({ title: 'Revert this merge?', body: 'Moved records go back and the other record is restored. Opt-outs carried over are kept.', input: { label: 'Why', required: true }, confirmLabel: 'Revert' });
                      if (c.ok && c.value && await ok(() => live.revertMerge(m.id, c.value!))) { toast({ kind: 'success', title: 'Merge reverted' }); q.reload(); }
                    }}>Revert</Button>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
    </div>
  );
}

/* ─────────────────────────── record panel ─────────────────────────── */

/** Data quality for one record: score, open findings with one-click corrections, field sources and verification. */
export function RecordQualityPanel({ entityType, id }: { entityType: 'contact' | 'lead' | 'property'; id: string }) {
  const q = useServerQuery(LIVE, () => live.recordQuality(entityType, id), [entityType, id]);
  const [suggesting, setSuggesting] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [review, setReview] = useState<string | null>(null);
  const d = q.data;
  if (!LIVE) return null;
  return (
    <section>
      <h4 className="section-title"><ShieldCheck size={13} /> Data quality</h4>
      {q.error ? <p className="faint" style={{ fontSize: 12.5 }}>Couldn't load data quality. {q.error}</p> : !d ? <div className="skeleton" style={{ height: 60 }} /> : (
        <div className="stack stack-sm">
          <div className="row wrap" style={{ gap: 8, fontSize: 12.5 }}>
            <Badge tone={d.score >= 90 ? 'success' : d.score >= 60 ? 'warning' : 'danger'}>Score {d.score}/100</Badge>
            <span className="faint">{d.issues.length === 0 ? 'No open findings' : `${d.issues.length} open finding${d.issues.length === 1 ? '' : 's'}`}{d.evaluated ? '' : ' · recent changes are still being checked'}</span>
            {entityType === 'lead' && d.can_edit && (
              <Button size="xs" variant="ghost" icon={<Sparkles size={12} />} loading={suggesting} onClick={async () => {
                setSuggesting(true);
                const r = await attempt(() => live.proposeEnrichment(id));
                setSuggesting(false);
                if (!r) return;
                const msg: Record<string, string> = { not_configured: 'AI suggestions are not configured for this workspace.', no_source_text: 'There are no notes to read yet.',
                  timeout: 'The AI did not answer in time. Try again.', model_error: 'The AI request failed. Try again.', invalid_output: 'The AI answer failed validation and was discarded.',
                  rate_limited: 'Too many AI requests right now. Try again later.', guard_unavailable: 'AI requests are unavailable right now.', paused: 'This AI feature is paused for your agency.', refused: 'You do not have access to AI suggestions for this lead.' };
                toast(r.status === 'ok' ? { kind: 'success', title: `${r.proposed ?? 0} suggestion${r.proposed === 1 ? '' : 's'} from the notes`, body: 'Each one quotes its evidence; apply or dismiss it below.' }
                  : { kind: 'info', title: 'No suggestions', body: msg[r.status] ?? 'The request could not be completed.' });
              }}>Suggest from notes</Button>
            )}
            <Button size="xs" variant="ghost" onClick={() => setShowSources(!showSources)}>{showSources ? 'Hide' : 'Show'} field sources</Button>
          </div>
          {d.issues.map((x) => (
            <div key={x.id} className="row" style={{ gap: 8, fontSize: 12.5, alignItems: 'flex-start' }}>
              <Badge tone={SEVERITY[x.severity].tone}>{SEVERITY[x.severity].label}</Badge>
              <div className="grow">{x.message}{x.origin === 'ai_extraction' && typeof x.evidence.evidence === 'string' ? <div className="faint">“{x.evidence.evidence}”</div> : null}
                {x.recommended_action ? <div className="faint">{x.recommended_action}</div> : null}</div>
              <IssueActions issue={x} />
            </div>
          ))}
          {d.duplicates.map((x) => (
            <div key={x.id} className="banner" style={{ fontSize: 12.5 }}>
              <GitMerge size={14} /> <span className="grow">Possible duplicate of <b>{x.other_label}</b> ({x.strength}, {x.score}/100): {x.explanation}</span>
              <Button size="xs" onClick={() => setReview(x.id)}>Review</Button>
            </div>
          ))}
          {d.merges.filter((m) => m.status === 'completed').map((m) => (
            <div key={m.id} className="faint" style={{ fontSize: 12 }}>
              {m.role === 'canonical' ? `Merged with ${m.other_label} ${relTime(new Date(m.merged_at).getTime())}.` : `This record was merged into ${m.other_label}.`}
            </div>
          ))}
          {showSources && (
            <table className="table" style={{ fontSize: 12.5 }}>
              <thead><tr><th>Field</th><th>Source</th><th>Captured</th><th>Verified</th></tr></thead>
              <tbody>
                {d.provenance.map((p) => (
                  <tr key={p.field}>
                    <td>{FIELD[p.field] ?? p.field}</td>
                    <td>{p.recorded ? <>{SOURCE[p.source_type ?? ''] ?? p.source_type}{p.source_label && p.source_type !== 'ai_extraction' ? <span className="faint"> · {p.source_label}</span> : null}</> : <span className="faint">Not recorded</span>}</td>
                    <td className="faint">{p.captured_at ? relTime(new Date(p.captured_at).getTime()) : '—'}</td>
                    <td>{p.verification_status === 'verified'
                      ? <span className="row" style={{ gap: 4 }}><BadgeCheck size={13} className="accent-text" /> {p.verified_at ? relTime(new Date(p.verified_at).getTime()) : ''}
                        {d.can_edit && <Button size="xs" variant="ghost" onClick={() => ok(() => live.verifyField(entityType, id, p.field, false))}>Undo</Button>}</span>
                      : d.can_edit ? <Button size="xs" variant="ghost" onClick={async () => { if (await ok(() => live.verifyField(entityType, id, p.field, true))) toast({ kind: 'success', title: `${FIELD[p.field] ?? p.field} verified`, body: 'Automated updates can no longer overwrite it.' }); }}>Verify</Button>
                      : <span className="faint">No</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      {review && <DuplicateReview id={review} onClose={() => setReview(null)} />}
    </section>
  );
}
