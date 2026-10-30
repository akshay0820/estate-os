// Agent 03 — Sales & Qualification, live mode: the lead's Qualification panel.
// Shows the persisted result only. Recommendations are labelled as such; nothing here contacts the lead.
import { useState } from 'react';
import { AlertTriangle, Check, RefreshCw, ShieldCheck } from 'lucide-react';
import { Badge, Button, Input, Select } from '@/components/ui';
import { toast } from '@/store/ui';
import { money, relTime } from '@/lib/format';
import type { Tone } from '@/lib/domain';
import { usePollWhile, useServerQuery } from '@/data/useServerQuery';
import { ok } from '@/data/actions';
import * as live from '@/backend/live';
import type { Lead } from '@/store/types';

export const QUAL_STATUS: Record<live.QualStatus, { label: string; tone: Tone }> = {
  unqualified: { label: 'Not qualified yet', tone: 'neutral' },
  in_progress: { label: 'Qualifying…', tone: 'accent' },
  needs_information: { label: 'Needs information', tone: 'warning' },
  qualified: { label: 'Qualified', tone: 'success' },
  high_intent: { label: 'High intent', tone: 'success' },
  nurture: { label: 'Nurture', tone: 'info' },
  human_review_required: { label: 'Needs review', tone: 'warning' },
  disqualified: { label: 'Disqualified', tone: 'danger' },
};
const ACTION: Record<string, string> = {
  request_clarification: 'Ask the open questions (a task was created; nothing is sent automatically)',
  recommend_property_matching: 'Ready for property matching',
  request_human_review: 'A person should review this qualification',
  request_human_callback: 'The lead asked for a person — call back',
  continue_nurture: 'Keep in nurture; not ready for a sales step yet',
  no_action: 'No contact recommended (do-not-contact)',
  await_more_information: 'Wait for more information',
};
const CERTAINTY: Record<string, { label: string; tone: Tone; title: string }> = {
  confirmed: { label: 'CRM', tone: 'neutral', title: 'From the CRM record' },
  ai_extracted: { label: 'AI-extracted', tone: 'info', title: 'In the CRM, originally extracted by AI — check before relying on it' },
  stated: { label: 'Stated', tone: 'accent', title: 'Stated by the prospect in the cited source; not yet in the CRM' },
  inferred: { label: 'Inferred', tone: 'warning', title: 'An interpretation, not a statement — confirm before relying on it' },
};
const REASON: Record<string, string> = {
  conflicting_information: 'Sources disagree on a key requirement',
  possible_withdrawal: 'The prospect may have withdrawn interest',
  possible_wrong_number: 'Possibly a wrong number',
  outside_service_scope: "Outside the agency's configured service scope",
  low_confidence_intent: 'Intent is only inferred',
};
const FIELD_LABEL: Record<string, string> = { intent: 'Intent', locations: 'Locations', budget: 'Budget', property_type: 'Property type', bedrooms: 'Bedrooms', timeline: 'Timeline' };
const ANALYSIS: Record<string, string> = {
  not_requested: 'No free text to interpret', succeeded: 'Free text interpreted by AI', failed: 'AI step failed — result uses CRM data only',
  skipped: 'AI step skipped — result uses CRM data only', not_configured: 'AI not configured — result uses CRM data only',
};

function show(field: string, v: unknown): string {
  if (v == null) return '—';
  if (field === 'locations' && Array.isArray(v)) return v.join(', ');
  if (field === 'budget' && typeof v === 'object') {
    const b = v as { min: number | null; max: number | null; currency: string };
    const fmt = (n: number) => money(n, { currency: b.currency });
    return b.min && b.max ? `${fmt(b.min)} – ${fmt(b.max)}` : b.max ? `Up to ${fmt(b.max)}` : b.min ? `From ${fmt(b.min)}` : '—';
  }
  return String(v).replace(/_/g, ' ');
}

export function QualificationPanel({ lead }: { lead: Lead }) {
  const q = useServerQuery(true, () => live.leadQualification(lead.id), [lead.id, lead.updatedAt]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [override, setOverride] = useState<live.QualStatus | ''>('');
  const d = q.data;
  const c = d?.current;
  usePollWhile(!!d?.run && ['received', 'retry_scheduled'].includes(d.run.status), q.reload);

  const run = async () => {
    setBusy(true);
    const done = await ok(() => live.requestQualification(lead.id));
    setBusy(false);
    if (done) { toast({ kind: 'info', title: 'Qualification queued', body: 'Results appear here within about a minute.' }); q.reload(); }
  };
  const decide = async (decision: 'approve' | 'reject' | 'override' | 'edit', edits?: Record<string, unknown>) => {
    if (!c) return;
    setBusy(true);
    const done = await ok(() => live.reviewQualification(c.id, decision, { status: override || undefined, note: note || undefined, edits }));
    setBusy(false);
    if (done) { toast({ kind: 'success', title: edits ? 'Confirmed and re-qualifying' : 'Review recorded' }); setNote(''); setOverride(''); q.reload(); }
  };
  const confirmField = (field: string, f: live.QualField) => {
    const v = f.value as Record<string, unknown>;
    const edits = field === 'budget' ? { budget_min: v.min, budget_max: v.max, currency: v.currency } : { [field]: f.value };
    void decide('edit', edits);
  };

  if (q.loading && !d) return <section><h4 className="section-title">Qualification</h4><div className="skeleton" style={{ height: 80 }} /></section>;
  if (q.error) return <section><h4 className="section-title">Qualification</h4><p className="faint" style={{ fontSize: 12.5 }}>Couldn't load qualification. {q.error}</p></section>;
  if (!d) return null;
  const pending = d.run && ['received', 'retry_scheduled'].includes(d.run.status);

  return (
    <section>
      <div className="row row-between">
        <h4 className="section-title" style={{ margin: 0 }}>Qualification</h4>
        {d.can_run && <Button size="xs" icon={<RefreshCw size={12} />} loading={busy} disabled={!!pending} onClick={run}>{c ? 'Re-run' : 'Run qualification'}</Button>}
      </div>
      {pending && (
        <p className="faint mt-8" style={{ fontSize: 12.5 }}>
          {d.run!.status === 'retry_scheduled' ? `Retrying after an error (attempt ${d.run!.attempts})…` : d.run!.awaiting_analysis ? 'Waiting for the AI step to read the enquiry text…' : 'Queued — runs within a minute.'}
          {c ? ' The previous result stays visible until then.' : ''}
        </p>
      )}
      {d.run?.status === 'dead_letter' && <div className="banner danger mt-8" style={{ fontSize: 12.5 }}><AlertTriangle size={14} /> The last qualification attempt failed after retries. The previous result is kept.</div>}
      {!c ? (
        !pending && <p className="faint mt-8" style={{ fontSize: 12.5 }}>Not qualified yet.</p>
      ) : (
        <div className="stack mt-8" style={{ gap: 12 }}>
          <div className="row wrap" style={{ gap: 8 }}>
            <Badge tone={QUAL_STATUS[c.status].tone}>{QUAL_STATUS[c.status].label}</Badge>
            <span className="tag" title="Readiness for the next sales step — not a judgement of the person">
              Readiness {c.score == null ? '— (not enough evidence)' : `${c.score}/100`}
            </span>
            <span className="faint" style={{ fontSize: 12 }}>{relTime(new Date(c.created_at).getTime())} · {c.ruleset_version ? `rules v${c.ruleset_version}` : 'default rules'} · {ANALYSIS[c.analysis_status] ?? c.analysis_status}</span>
          </div>
          <div className="banner" style={{ fontSize: 12.5 }}>
            <ShieldCheck size={14} />
            <span><b>Recommendation:</b> {ACTION[c.recommended_action] ?? c.recommended_action}</span>
          </div>
          {c.summary && <p style={{ fontSize: 13, margin: 0 }}>{c.summary} <span className="faint">(AI summary)</span></p>}

          <div className="card" style={{ boxShadow: 'none' }}>
            {(['intent', 'locations', 'budget', 'property_type', 'bedrooms', 'timeline'] as const).map((f) => {
              const r = c.requirements[f];
              const cert = r ? CERTAINTY[r.certainty] : null;
              return (
                <div key={f} className="list-row" style={{ padding: '8px 12px' }}>
                  <span className="faint" style={{ width: 110, fontSize: 12.5 }}>{FIELD_LABEL[f]}</span>
                  <span className="grow" style={{ fontSize: 13 }}>{r ? show(f, r.value) : <span className="faint">Unknown</span>}</span>
                  {cert && <Badge tone={cert.tone} title={`${cert.title}${r!.source !== 'crm' ? ` — ${r!.source.split(':')[0]}` : ''}`}>{cert.label}</Badge>}
                  {d.can_review && r && r.certainty !== 'confirmed' && (
                    <Button size="xs" variant="ghost" icon={<Check size={12} />} disabled={busy} onClick={() => confirmField(f, r)} title="Write this value to the CRM and re-qualify">Confirm</Button>
                  )}
                </div>
              );
            })}
          </div>

          {c.missing.length > 0 && <p style={{ fontSize: 12.5, margin: 0 }}><b>Missing:</b> {c.missing.map((m) => FIELD_LABEL[m] ?? m).join(', ')}</p>}
          {c.conflicts.length > 0 && (
            <div className="banner warning" style={{ display: 'block', fontSize: 12.5 }}>
              <b>Conflicting information</b> — CRM values were not changed.
              <ul style={{ margin: '4px 0 0 16px' }}>
                {c.conflicts.map((x, i) => <li key={i}>{FIELD_LABEL[x.field] ?? x.field}: {x.note ?? `CRM ${show(x.field, x.crm)} vs ${show(x.field, x.proposed)}`}</li>)}
              </ul>
            </div>
          )}
          {c.questions.length > 0 && (
            <div style={{ fontSize: 12.5 }}>
              <b>Suggested questions</b> <span className="faint">(not sent automatically)</span>
              <ul style={{ margin: '4px 0 0 16px' }}>{c.questions.map((x, i) => <li key={i}>{x.question}</li>)}</ul>
            </div>
          )}

          <details>
            <summary className="faint" style={{ fontSize: 12.5, cursor: 'pointer' }}>Score breakdown</summary>
            <div className="stack mt-8" style={{ gap: 4 }}>
              {c.score_breakdown.map((b) => (
                <div key={b.key} className="row" style={{ gap: 8, fontSize: 12.5 }}>
                  <span style={{ width: 170 }}>{b.label}</span>
                  <span className="mono" style={{ width: 70 }}>{b.points ?? '—'} / {Math.round((b.weight / c.score_breakdown.reduce((s, x) => s + x.weight, 0)) * 100)}</span>
                  <span className="faint grow">{b.evidence}</span>
                </div>
              ))}
            </div>
          </details>

          {c.human_review_required || c.review_status !== 'not_required' ? (
            <div className="card" style={{ padding: 12, boxShadow: 'none' }}>
              <div className="row wrap" style={{ gap: 6, fontSize: 12.5 }}>
                <b>Human review</b>
                <Badge tone={c.review_status === 'pending' ? 'warning' : 'neutral'}>{c.review_status.replace('_', ' ')}</Badge>
                {c.review_reasons.map((r) => <span key={r} className="tag">{REASON[r] ?? r}</span>)}
              </div>
              {c.review_note && <p className="faint mt-8" style={{ fontSize: 12 }}>Note: {c.review_note}</p>}
              {d.can_review && c.review_status === 'pending' && (
                <div className="stack mt-8" style={{ gap: 6 }}>
                  <Input inputSize="sm" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (required to override or reject)" />
                  <div className="row wrap" style={{ gap: 6 }}>
                    <Select selectSize="sm" value={override} onChange={(e) => setOverride(e.target.value as live.QualStatus)} style={{ width: 190 }} aria-label="Set status">
                      <option value="">Set status…</option>
                      {(['qualified', 'high_intent', 'nurture', 'needs_information', 'disqualified'] as const).map((s) => <option key={s} value={s}>{QUAL_STATUS[s].label}</option>)}
                    </Select>
                    <Button size="sm" variant="primary" disabled={busy || !override || note.trim().length < 3} onClick={() => decide('override')}>Set status</Button>
                    <Button size="sm" disabled={busy || note.trim().length < 3} onClick={() => decide('reject')}>Reject</Button>
                  </div>
                </div>
              )}
            </div>
          ) : d.can_review && c.review_status === 'not_required' && (
            <div className="row" style={{ gap: 6 }}>
              <Button size="xs" variant="ghost" disabled={busy} onClick={() => decide('approve')}>Mark as reviewed</Button>
            </div>
          )}
          {d.history.length > 1 && (
            <p className="faint" style={{ fontSize: 12 }}>
              History: {d.history.slice(0, 5).map((h) => `${QUAL_STATUS[h.status].label}${h.score != null ? ` ${h.score}` : ''} (${relTime(new Date(h.created_at).getTime())})`).join(' · ')}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
