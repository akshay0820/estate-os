// Agent 04 — Property Matching, live mode: the lead drawer's "Property matches" tab.
// Shows persisted backend results only (never a client-side ranking). Sharing here records what a person did;
// nothing in this panel contacts the lead.
import { useState } from 'react';
import { AlertTriangle, Building2, Check, Flag, RefreshCw, RotateCcw, Share2, Star, X } from 'lucide-react';
import { Badge, Button, Empty, Input } from '@/components/ui';
import { toast } from '@/store/ui';
import { inr, relTime } from '@/lib/format';
import { navigate } from '@/lib/router';
import type { Tone } from '@/lib/domain';
import { usePollWhile, useServerQuery } from '@/data/useServerQuery';
import { attempt, ok } from '@/data/actions';
import * as live from '@/backend/live';
import type { Lead } from '@/store/types';

const RUN_STATUS: Record<live.MatchRunStatus, { label: string; tone: Tone }> = {
  completed: { label: 'Matches found', tone: 'success' },
  completed_with_warnings: { label: 'Matches found (with caveats)', tone: 'success' },
  needs_more_information: { label: 'Needs more information', tone: 'warning' },
  no_matches: { label: 'No suitable listings', tone: 'neutral' },
  not_applicable: { label: 'Not applicable', tone: 'neutral' },
};
const MATCH_STATUS: Record<live.MatchStatus, { label: string; tone: Tone }> = {
  recommended: { label: 'Recommended', tone: 'accent' },
  viewed: { label: 'Viewed', tone: 'neutral' },
  shortlisted: { label: 'Shortlisted', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'neutral' },
  shared: { label: 'Shared', tone: 'success' },
  appointment_requested: { label: 'Viewing booked', tone: 'success' },
  invalidated: { label: 'Listing changed', tone: 'danger' },
};
const BAND: Record<string, string> = { strong: 'Strong alignment', good: 'Good alignment, some trade-offs', partial: 'Partial alignment' };
const AVAIL: Record<string, { label: string; tone: Tone }> = {
  verified: { label: 'Availability verified', tone: 'success' },
  stale: { label: 'Verification is old', tone: 'warning' },
  unverified: { label: 'Not verified', tone: 'warning' },
};
const WARNING: Record<string, string> = {
  qualification_missing: 'This lead has not been qualified yet; requirements come straight from the CRM.',
  qualification_not_complete: 'The qualification is not complete (needs information or review).',
  unverified_listings: 'Some recommended listings are not recently verified. Confirm availability before sharing.',
  currency_mismatch: 'Some listings are priced in another currency and were not compared with the budget.',
  candidate_limit_reached: 'The candidate limit was reached; some listings were not evaluated.',
  inventory_empty: 'There are no active listings in this workspace.',
};
const REJECT: Record<string, string> = {
  EXCEEDS_HARD_BUDGET: 'over the budget', OUTSIDE_MANDATORY_LOCATION: 'outside the required areas', LISTING_UNAVAILABLE: 'under offer / reserved',
  PROPERTY_TYPE_MISMATCH: 'wrong property type', BEDROOM_REQUIREMENT_NOT_MET: 'too few bedrooms', REQUIRED_DATA_UNVERIFIED: 'not verified',
  BELOW_MIN_SCORE: 'weak alignment', TRANSACTION_TYPE_MISMATCH: 'wrong transaction type',
};
const FIELD: Record<string, string> = { intent: 'intent', locations: 'locations', budget: 'budget', property_type: 'property type', bedrooms: 'bedrooms' };

const price = (p: live.PropertyMatch['property']) => `${p.currency === 'INR' ? inr(p.price) : `${p.currency} ${p.price.toLocaleString()}`}${p.listing_type === 'rent' ? '/mo' : ''}`;

export function PropertyMatchesPanel({ lead, onBook }: { lead: Lead; onBook: (propertyId: string) => void }) {
  const q = useServerQuery(true, () => live.leadPropertyMatches(lead.id), [lead.id, lead.updatedAt]);
  const [busy, setBusy] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const d = q.data;
  const c = d?.current;
  usePollWhile(!!d?.run && ['received', 'retry_scheduled'].includes(d.run.status), q.reload);

  const run = async () => {
    setBusy('run');
    const done = await ok(() => live.requestPropertyMatching(lead.id));
    setBusy(null);
    if (done) { toast({ kind: 'info', title: 'Matching queued', body: 'Results appear here within about a minute.' }); q.reload(); }
  };
  const act = async (m: live.PropertyMatch, action: Parameters<typeof live.propertyMatchAction>[1], msg?: string) => {
    setBusy(m.id);
    const r = await attempt(() => live.propertyMatchAction(m.id, action, msg));
    setBusy(null);
    if (!r) return;
    if (r.status === 'invalidated') toast({ kind: 'error', title: 'This listing no longer fits', body: `${REJECT[r.reason ?? ''] ?? 'The listing changed'} — re-run matching.` });
    else if (action === 'share') toast({ kind: 'success', title: 'Recorded as shared', body: m.availability !== 'verified' ? 'Availability is not recently verified — confirm before promising.' : undefined });
    else if (action === 'request_review') toast({ kind: 'success', title: 'Review task created' });
    setRejecting(null); setNote('');
    q.reload();
  };

  if (q.loading && !d) return <div className="skeleton" style={{ height: 120 }} />;
  if (q.error) return <p className="faint" style={{ fontSize: 12.5 }}>Couldn't load property matches. {q.error}</p>;
  if (!d) return null;
  const pending = d.run && ['received', 'retry_scheduled'].includes(d.run.status);
  const visible = d.matches.filter((m) => showHidden || !['rejected', 'invalidated'].includes(m.status));
  const hidden = d.matches.length - d.matches.filter((m) => !['rejected', 'invalidated'].includes(m.status)).length;
  const rej = c ? Object.entries(c.rejections).sort((a, b) => b[1] - a[1]) : [];

  return (
    <div className="stack">
      <div className="row row-between">
        <p className="faint grow" style={{ fontSize: 12.5, margin: 0 }}>
          Ranked by the Property Matching Agent from this workspace's listings. Hard requirements (confirmed in the CRM) are applied first; preferences only affect ranking.
        </p>
        {d.can_act && <Button size="xs" icon={<RefreshCw size={12} />} loading={busy === 'run'} disabled={!!pending} onClick={run}>{c ? 'Re-run matching' : 'Run matching'}</Button>}
      </div>
      {pending && (
        <p className="faint" style={{ fontSize: 12.5, margin: 0 }}>
          {d.run!.status === 'retry_scheduled' ? `Retrying after an error (attempt ${d.run!.attempts})…` : 'Queued — runs within a minute.'}
          {c ? ' The previous results stay visible until then.' : ''}
        </p>
      )}
      {d.run?.status === 'dead_letter' && <div className="banner danger" style={{ fontSize: 12.5 }}><AlertTriangle size={14} /> The last matching attempt failed after retries. Earlier results are kept; this is not a "no matches" result.</div>}
      {d.outdated && <div className="banner warning" style={{ fontSize: 12.5 }}><AlertTriangle size={14} /> Requirements changed since these results. Re-run matching.</div>}

      {!c ? (
        !pending && <Empty icon={<Building2 size={20} />} title="Not matched yet" description="Matching runs automatically once the lead is qualified, or run it now." />
      ) : (
        <>
          <div className="row wrap" style={{ gap: 8 }}>
            <Badge tone={RUN_STATUS[c.status].tone}>{RUN_STATUS[c.status].label}</Badge>
            {!['needs_more_information', 'not_applicable'].includes(c.status) && (
              <span className="tag">{c.recommended_count} recommended · {c.eligible_count} eligible of {c.candidate_count} evaluated</span>
            )}
            <span className="faint" style={{ fontSize: 12 }}>{relTime(new Date(c.created_at).getTime())} · {c.ruleset_version ? `rules v${c.ruleset_version}` : 'default rules'}</span>
          </div>
          {c.status === 'needs_more_information' && (
            <p style={{ fontSize: 12.5, margin: 0 }}>Matching needs at least the intent and a location or budget. Missing: {c.missing.map((m) => FIELD[m] ?? m).join(', ')}.</p>
          )}
          {c.status === 'not_applicable' && <p style={{ fontSize: 12.5, margin: 0 }}>Sellers and landlords are not matched against buyer inventory.</p>}
          {c.status !== 'needs_more_information' && c.missing.length > 0 && (
            <p className="faint" style={{ fontSize: 12.5, margin: 0 }}>Would improve matching: {c.missing.map((m) => FIELD[m] ?? m).join(', ')}.</p>
          )}
          {c.warnings.map((w) => <div key={w} className="banner warning" style={{ fontSize: 12.5 }}><AlertTriangle size={14} /> {WARNING[w] ?? w}</div>)}
          {rej.length > 0 && (
            <p className="faint" style={{ fontSize: 12, margin: 0 }}>Excluded: {rej.map(([k, n]) => `${n} ${REJECT[k] ?? k.toLowerCase()}`).join(' · ')}</p>
          )}
          {c.status === 'no_matches' && (
            <Empty icon={<Building2 size={20} />} title="No suitable property right now" description="Nothing active meets the hard requirements. A task was created to review the requirements or check new inventory." />
          )}

          {visible.map((m) => {
            const p = m.property;
            const closed = ['rejected', 'invalidated'].includes(m.status);
            return (
              <div key={m.id} className="card" style={{ padding: 12, boxShadow: 'none', opacity: closed ? 0.65 : 1 }}>
                <div className="row row-top" style={{ gap: 12 }}>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="row wrap" style={{ gap: 8 }}>
                      <span className="mono faint" style={{ fontSize: 11 }}>#{m.rank}</span>
                      <b className="truncate">{p.title}</b>
                      <span className="mono faint" style={{ fontSize: 11 }}>{p.reference_code}</span>
                      <Badge tone={MATCH_STATUS[m.status].tone}>{MATCH_STATUS[m.status].label}</Badge>
                    </div>
                    <div className="faint" style={{ fontSize: 12.5 }}>
                      {p.locality}{p.city ? `, ${p.city}` : ''} · {price(p)} · {p.property_type} · {p.bedrooms} bed · {p.area_value.toLocaleString('en-IN')} {p.area_unit}
                    </div>
                  </div>
                  <div className="stack stack-sm" style={{ alignItems: 'flex-end' }}>
                    <span className="mono" style={{ fontSize: 18, fontWeight: 600 }} title={`${BAND[m.band]}. Alignment with the stated preferences — not a guarantee of availability or suitability.`}>{m.score}</span>
                    <Badge tone={AVAIL[m.availability].tone} title={p.verified_at ? `Last verified ${new Date(p.verified_at).toLocaleDateString()}` : 'Never verified'}>{AVAIL[m.availability].label}</Badge>
                  </div>
                </div>
                {m.status === 'invalidated' && <p className="mt-8" style={{ fontSize: 12.5, color: 'var(--danger)', margin: 0 }}>Changed after matching ({REJECT[m.status_reason ?? ''] ?? 'listing changed'}). Re-run matching.</p>}
                {m.price_changed && m.status !== 'invalidated' && <p className="mt-8" style={{ fontSize: 12.5, color: 'var(--warning)', margin: 0 }}>Price changed since matching — shortlisting or sharing re-checks it.</p>}
                <div className="row wrap mt-8" style={{ gap: 5 }}>
                  {m.strengths.map((s) => <span key={s.code + s.text} className="badge badge-success"><Check size={10} /> {s.text}</span>)}
                  {m.tradeoffs.map((s) => <span key={s.code + s.text} className="badge">{s.text}</span>)}
                  {m.caveats.map((s) => <span key={s.code + s.text} className="badge badge-warning">{s.text}</span>)}
                </div>
                {m.ai_summary && <p className="mt-8" style={{ fontSize: 12.5, margin: '8px 0 0' }}>{m.ai_summary} <span className="faint">(AI summary of the facts above)</span></p>}
                {m.status === 'rejected' && m.status_reason && <p className="faint mt-8" style={{ fontSize: 12, margin: '8px 0 0' }}>Rejected: {m.status_reason}</p>}
                <details className="mt-8">
                  <summary className="faint" style={{ fontSize: 12, cursor: 'pointer' }}>Score breakdown</summary>
                  <div className="stack mt-8" style={{ gap: 3 }}>
                    {m.breakdown.map((b) => (
                      <div key={b.key} className="row" style={{ gap: 8, fontSize: 12 }}>
                        <span style={{ width: 160 }}>{b.label}</span>
                        <span className="mono" style={{ width: 80 }}>{b.points ?? '—'} pts</span>
                        <span className="faint">{b.status === 'unknown' ? 'could not be evaluated (no points)' : b.status}</span>
                      </div>
                    ))}
                  </div>
                </details>
                <div className="row wrap mt-8" style={{ gap: 4 }}>
                  <Button size="xs" onClick={() => { void live.propertyMatchAction(m.id, 'view').catch(() => undefined); navigate('properties', { id: p.id }); }}>View listing</Button>
                  {d.can_act && !closed && (
                    <>
                      {m.status !== 'shortlisted' && m.status !== 'shared' && m.status !== 'appointment_requested' && (
                        <Button size="xs" icon={<Star size={12} />} loading={busy === m.id} onClick={() => act(m, 'shortlist')}>Shortlist</Button>
                      )}
                      {m.status !== 'shared' && <Button size="xs" icon={<Share2 size={12} />} disabled={busy === m.id} onClick={() => act(m, 'share')} title="Record that you shared it with the prospect yourself">Mark shared</Button>}
                      <Button size="xs" variant="primary" disabled={busy === m.id || p.status !== 'active'} onClick={() => onBook(p.id)}>Book viewing</Button>
                      <Button size="xs" variant="ghost" icon={<X size={12} />} disabled={busy === m.id} onClick={() => setRejecting(rejecting === m.id ? null : m.id)}>Reject</Button>
                    </>
                  )}
                  {d.can_act && m.status === 'rejected' && <Button size="xs" variant="ghost" icon={<RotateCcw size={12} />} disabled={busy === m.id} onClick={() => act(m, 'restore')}>Restore</Button>}
                  {d.can_act && <Button size="xs" variant="ghost" icon={<Flag size={12} />} disabled={busy === m.id} onClick={() => act(m, 'request_review')}>Request review</Button>}
                </div>
                {rejecting === m.id && (
                  <div className="row mt-8" style={{ gap: 6 }}>
                    <Input inputSize="sm" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="Why it does not fit (optional)" />
                    <Button size="sm" loading={busy === m.id} onClick={() => act(m, 'reject', note || undefined)}>Reject</Button>
                  </div>
                )}
              </div>
            );
          })}
          {hidden > 0 && (
            <button type="button" className="link faint" style={{ fontSize: 12, alignSelf: 'flex-start' }} onClick={() => setShowHidden(!showHidden)}>
              {showHidden ? 'Hide' : 'Show'} {hidden} rejected or changed
            </button>
          )}
          {d.history.length > 1 && (
            <p className="faint" style={{ fontSize: 12, margin: 0 }}>
              History: {d.history.slice(0, 5).map((h) => `${RUN_STATUS[h.status].label} · ${h.recommended_count} (${relTime(new Date(h.created_at).getTime())})`).join(' · ')}
            </p>
          )}
        </>
      )}
    </div>
  );
}
