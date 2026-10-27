// Live-mode AI agents page: only agents that actually run in the backend show activity.
// Agent 01 (Lead Intake) and Agent 02 (Voice Calling) read their real runs and queues; the rest are listed as not built yet.
import { useMemo } from 'react';
import { Bot, GitMerge, Inbox, ShieldCheck, Sparkles, Timer } from 'lucide-react';
import { Badge, Button, Drawer, Empty, KV, PageHeader, TableSkeleton } from '@/components/ui';
import { navigate, setParam } from '@/lib/router';
import { ms, pct, relTime } from '@/lib/format';
import { cx } from '@/lib/util';
import { useServerQuery } from '@/data/useServerQuery';
import * as live from '@/backend/live';
import type { Tone } from '@/lib/domain';

const RUN_TONE: Record<string, { label: string; tone: Tone }> = {
  received: { label: 'Received', tone: 'neutral' },
  succeeded: { label: 'Succeeded', tone: 'success' },
  review_required: { label: 'Needs review', tone: 'warning' },
  invalid: { label: 'Quarantined', tone: 'danger' },
  retry_scheduled: { label: 'Retrying', tone: 'warning' },
  dead_letter: { label: 'Failed', tone: 'danger' },
};
const ACTION_LABEL: Record<string, string> = { created: 'New lead', repeat_enquiry: 'Repeat enquiry', review_required: 'Possible duplicate' };
const SOURCE_LABEL: Record<string, string> = { webhook: 'Webhook', manual: 'Added in OS', import: 'Import', voice: 'Call', integration: 'Integration' };

export function LiveAgentsPage({ params }: { params: URLSearchParams }) {
  const q = useServerQuery(true, () => live.leadIntakeAgentOverview(), []);
  const open = params.get('id') === 'lead_intake_agent';

  const st = useMemo(() => {
    const runs = q.data?.runs ?? [];
    const by = (s: string) => runs.filter((r) => r.status === s).length;
    const handled = by('succeeded') + by('review_required');
    const failed = by('dead_letter');
    const timed = runs.filter((r) => r.duration_ms != null && r.source_kind !== 'manual');
    const model = runs.find((r) => r.model_meta?.outcome);
    return {
      total: runs.length,
      handled,
      failed,
      quarantined: by('invalid'),
      retrying: by('retry_scheduled') + by('received'),
      success: handled + failed ? handled / (handled + failed) : null,
      created: runs.filter((r) => r.outcome?.action === 'created').length,
      repeats: runs.filter((r) => r.outcome?.action === 'repeat_enquiry').length,
      avgMs: timed.length ? Math.round(timed.reduce((s, r) => s + (r.duration_ms ?? 0), 0) / timed.length) : null,
      last: runs[0] ? new Date(runs[0].received_at).getTime() : null,
      version: runs[0]?.agent_version ?? '1.0.0',
      model: model?.model_meta ?? null,
    };
  }, [q.data]);

  return (
    <div className="page">
      <PageHeader
        eyebrow="[ 8 of 8 built ]"
        title="AI agents"
        sub="Bounded task runners with explicit tools and escalation rules. Model output is a proposal — the backend validates and authorizes every action."
      />
      <div className="grid g-3">
        <div className="card agent-card">
          <div className="row row-top">
            <span className="icon-chip accent" style={{ width: 36, height: 36, borderRadius: 10 }}><Bot size={17} /></span>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="row" style={{ gap: 6 }}>
                <b className="truncate">AI Lead Intake Agent</b>
                <span className="mono faint" style={{ fontSize: 11 }}>v{st.version}</span>
              </div>
              <div className="row" style={{ gap: 6, marginTop: 3 }}>
                <Badge tone="success" dot>live</Badge>
                <span className="tag" style={{ height: 20, fontSize: 11 }}>Bounded auto</span>
              </div>
            </div>
          </div>
          <p className="faint" style={{ fontSize: 13, minHeight: 38 }}>Validates, normalizes, de-duplicates and assigns every incoming lead, then hands it to qualification. Ambiguous matches go to a person.</p>
          {q.loading && !q.data ? (
            <div className="skeleton" style={{ height: 52 }} />
          ) : q.error ? (
            <p className="faint" style={{ fontSize: 12.5 }}>Couldn't load activity. {q.error}</p>
          ) : (
            <>
              <div className="mini-stats">
                <div><b>{st.total}</b><span>runs · 7d</span></div>
                <div><b>{st.success == null ? '—' : pct(st.success, 0)}</b><span>success</span></div>
                <div><b>{st.last ? relTime(st.last).replace(' ago', '') : '—'}</b><span>last run</span></div>
              </div>
              <div className="row wrap" style={{ gap: 6, fontSize: 12 }}>
                <span className="tag"><Inbox size={11} style={{ marginRight: 4 }} />{q.data!.handoffPending} queued for qualification</span>
                {q.data!.openReviews > 0 && <span className="tag"><GitMerge size={11} style={{ marginRight: 4 }} />{q.data!.openReviews} duplicate review{q.data!.openReviews === 1 ? '' : 's'}</span>}
                {q.data!.handoffFailed > 0 && <Badge tone="danger">{q.data!.handoffFailed} failed handoff{q.data!.handoffFailed === 1 ? '' : 's'}</Badge>}
              </div>
            </>
          )}
          <div className="row" style={{ gap: 6 }}>
            <Button size="sm" onClick={() => setParam('id', 'lead_intake_agent')}>Details & runs</Button>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => navigate('leads')}>Leads →</Button>
          </div>
        </div>

        <VoiceAgentCard />
        <QualificationAgentCard />
        <MatchingAgentCard />
        <FollowUpAgentCard />
        <AppointmentAgentCard />
        <DataQualityAgentCard />
        <SalesIntelligenceAgentCard />

      </div>

      {open && (
        <Drawer
          open
          wide
          onClose={() => setParam('id', null)}
          label="AI Lead Intake Agent"
          header={<div><h2 style={{ fontSize: 19, fontWeight: 600 }}>AI Lead Intake Agent</h2><div className="faint mt-4">Agent 01 · lead_intake_agent · v{st.version}</div></div>}
        >
          <div className="stack stack-lg">
            <KV items={[
              ['Runs (7 days)', `${st.total} · ${st.created} new leads · ${st.repeats} repeat enquiries`],
              ['Outcomes', `${st.handled} handled · ${st.quarantined} quarantined (invalid input) · ${st.failed} failed · ${st.retrying} in progress or retrying`],
              ['Average time', st.avgMs == null ? '—' : ms(st.avgMs)],
              ['Handoff', `${q.data?.handoffPending ?? 0} waiting for the Sales & Qualification agent (not built yet)`],
              ['AI extraction', st.model ? <span key="m" className="row" style={{ gap: 6 }}><Sparkles size={13} className="accent-text" />{st.model.outcome === 'disabled' ? 'Off — no Claude API key configured; form fields only' : `${st.model.model ?? 'model'} · last outcome ${st.model.outcome}`}</span> : 'Not used yet (only for free-text messages)'],
              ['Guardrails', <span key="g" className="row" style={{ gap: 6 }}><ShieldCheck size={13} className="faint" />Tenant-scoped matching, deterministic assignment, no auto-merge of ambiguous matches</span>],
            ]} />
            <section>
              <h4 className="section-title"><Timer size={12} /> Recent runs</h4>
              {q.loading && !q.data ? <TableSkeleton rows={5} /> : !q.data?.runs.length ? (
                <Empty icon={<Bot size={20} />} title="No runs in the last 7 days" description="Runs appear when a lead arrives by webhook, is added in the OS, or is imported." />
              ) : (
                <div className="card" style={{ boxShadow: 'none' }}>
                  {q.data.runs.slice(0, 25).map((r) => {
                    const s = RUN_TONE[r.status] ?? { label: r.status, tone: 'neutral' as Tone };
                    return (
                      <button key={r.id} className={cx('list-row')} disabled={!r.lead_id} onClick={() => r.lead_id && navigate('leads', { id: r.lead_id })}>
                        <Badge tone={s.tone}>{s.label}</Badge>
                        <span className="grow truncate" style={{ fontSize: 13 }}>
                          {ACTION_LABEL[r.outcome?.action ?? ''] ?? (r.status === 'invalid' ? `Rejected: ${(r.outcome?.errors ?? []).join(', ').replace(/_/g, ' ')}` : '—')}
                          <span className="faint"> · {SOURCE_LABEL[r.source_kind] ?? r.source_kind}{r.outcome?.assignment?.rule ? ` · ${r.outcome.assignment.rule.replace(/_/g, ' ')}` : ''}</span>
                        </span>
                        {r.duration_ms != null && r.source_kind !== 'manual' && <span className="mono faint" style={{ fontSize: 11.5 }}>{ms(r.duration_ms)}</span>}
                        <span className="faint" style={{ fontSize: 12 }}>{relTime(new Date(r.received_at).getTime())}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </section>
          </div>
        </Drawer>
      )}
    </div>
  );
}

/** Agent 02 — real call counts and configuration state; "live" only when Retell and agency settings are both on. */
function VoiceAgentCard() {
  const q = useServerQuery(true, () => live.voiceAgentOverview(), []);
  const d = q.data;
  const active = !!d?.retellConfigured && !!d?.enabled;
  return (
    <div className="card agent-card">
      <div className="row row-top">
        <span className={cx('icon-chip', active && 'accent')} style={{ width: 36, height: 36, borderRadius: 10 }}><Bot size={17} /></span>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 6 }}>
            <b className="truncate">AI Voice Calling Agent</b>
            <span className="mono faint" style={{ fontSize: 11 }}>v1.0.0</span>
          </div>
          <div className="row" style={{ gap: 6, marginTop: 3 }}>
            {q.loading && !d ? <Badge>…</Badge> : active ? <Badge tone="success" dot>live</Badge> : <Badge tone="warning">needs setup</Badge>}
            <span className="tag" style={{ height: 20, fontSize: 11 }}>Retell AI</span>
          </div>
        </div>
      </div>
      <p className="faint" style={{ fontSize: 13, minHeight: 38 }}>Places and receives AI calls within consent, calling hours and limits; records outcomes, handles opt-outs and call-back requests, then hands results to qualification.</p>
      {q.error ? <p className="faint" style={{ fontSize: 12.5 }}>Couldn't load activity. {q.error}</p> : d && (
        <>
          <div className="mini-stats">
            <div><b>{d.calls7d}</b><span>calls · 7d</span></div>
            <div><b>{d.connected7d}</b><span>connected</span></div>
            <div><b>{d.lastCall ? relTime(d.lastCall).replace(' ago', '') : '—'}</b><span>last call</span></div>
          </div>
          <div className="row wrap" style={{ gap: 6, fontSize: 12 }}>
            {!d.retellConfigured && <span className="tag">Retell API key not set on the server</span>}
            {d.retellConfigured && !d.enabled && <span className="tag">Turned off in voice settings</span>}
            {d.handoffPending > 0 && <span className="tag"><Inbox size={11} style={{ marginRight: 4 }} />{d.handoffPending} results queued for qualification</span>}
            {d.callbacks7d > 0 && <span className="tag">{d.callbacks7d} call-back request{d.callbacks7d === 1 ? '' : 's'}</span>}
          </div>
        </>
      )}
      <div className="row" style={{ gap: 6 }}>
        <Button size="sm" onClick={() => navigate('calls')}>Calls & settings</Button>
      </div>
    </div>
  );
}

/** Agent 03 — real qualification counts and queues. */
function QualificationAgentCard() {
  const q = useServerQuery(true, () => live.qualificationAgentOverview(), []);
  const d = q.data;
  return (
    <div className="card agent-card">
      <div className="row row-top">
        <span className="icon-chip accent" style={{ width: 36, height: 36, borderRadius: 10 }}><Bot size={17} /></span>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 6 }}>
            <b className="truncate">AI Sales &amp; Qualification Agent</b>
            <span className="mono faint" style={{ fontSize: 11 }}>v1.0.0</span>
          </div>
          <div className="row" style={{ gap: 6, marginTop: 3 }}>
            <Badge tone="success" dot>live</Badge>
            <span className="tag" style={{ height: 20, fontSize: 11 }}>Rules + optional AI</span>
          </div>
        </div>
      </div>
      <p className="faint" style={{ fontSize: 13, minHeight: 38 }}>Turns enquiries and call results into explainable requirements, a readiness score and a recommended next step. Unknowns stay unknown; people review edge cases.</p>
      {q.error ? <p className="faint" style={{ fontSize: 12.5 }}>Couldn't load activity. {q.error}</p> : d ? (
        <>
          <div className="mini-stats">
            <div><b>{d.runs7d}</b><span>results · 7d</span></div>
            <div><b>{d.qualified7d}</b><span>qualified</span></div>
            <div><b>{d.last ? relTime(d.last).replace(' ago', '') : '—'}</b><span>last result</span></div>
          </div>
          <div className="row wrap" style={{ gap: 6, fontSize: 12 }}>
            {d.reviewsPending > 0 && <span className="tag">{d.reviewsPending} awaiting review</span>}
            {d.pendingInput > 0 && <span className="tag"><Inbox size={11} style={{ marginRight: 4 }} />{d.pendingInput} events to process</span>}
            {d.pendingMatching > 0 && <span className="tag">{d.pendingMatching} handed to property matching</span>}
          </div>
        </>
      ) : <div className="skeleton" style={{ height: 52 }} />}
      <div className="row" style={{ gap: 6 }}>
        <Button size="sm" variant="ghost" onClick={() => navigate('leads')}>Leads →</Button>
      </div>
    </div>
  );
}

/** Agent 04 — real matching counts and queues. */
function MatchingAgentCard() {
  const q = useServerQuery(true, () => live.matchingAgentOverview(), []);
  const d = q.data;
  return (
    <div className="card agent-card">
      <div className="row row-top">
        <span className="icon-chip accent" style={{ width: 36, height: 36, borderRadius: 10 }}><Bot size={17} /></span>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 6 }}>
            <b className="truncate">AI Property Matching Agent</b>
            <span className="mono faint" style={{ fontSize: 11 }}>v1.0.0</span>
          </div>
          <div className="row" style={{ gap: 6, marginTop: 3 }}>
            <Badge tone="success" dot>live</Badge>
            <span className="tag" style={{ height: 20, fontSize: 11 }}>Rules + optional AI summaries</span>
          </div>
        </div>
      </div>
      <p className="faint" style={{ fontSize: 13, minHeight: 38 }}>Ranks this workspace's active listings against confirmed requirements, with hard constraints first and every score explained. Never contacts the lead.</p>
      {q.error ? <p className="faint" style={{ fontSize: 12.5 }}>Couldn't load activity. {q.error}</p> : d ? (
        <>
          <div className="mini-stats">
            <div><b>{d.runs7d}</b><span>runs · 7d</span></div>
            <div><b>{d.withMatches7d}</b><span>with matches</span></div>
            <div><b>{d.last ? relTime(d.last).replace(' ago', '') : '—'}</b><span>last run</span></div>
          </div>
          <div className="row wrap" style={{ gap: 6, fontSize: 12 }}>
            {d.noMatches7d > 0 && <span className="tag">{d.noMatches7d} with no suitable listing</span>}
            {d.needsInfo7d > 0 && <span className="tag">{d.needsInfo7d} need more information</span>}
            {d.pendingInput > 0 && <span className="tag"><Inbox size={11} style={{ marginRight: 4 }} />{d.pendingInput} events to process</span>}
            {d.pendingFollowUp > 0 && <span className="tag">{d.pendingFollowUp} handed to follow-up</span>}
          </div>
        </>
      ) : <div className="skeleton" style={{ height: 52 }} />}
      <div className="row" style={{ gap: 6 }}>
        <Button size="sm" variant="ghost" onClick={() => navigate('leads')}>Leads →</Button>
      </div>
    </div>
  );
}

/** Agent 05 — real follow-up counts. Nothing is sent automatically: no messaging provider is connected. */
function FollowUpAgentCard() {
  const q = useServerQuery(true, () => live.followUpAgentOverview(), []);
  const d = q.data;
  return (
    <div className="card agent-card">
      <div className="row row-top">
        <span className="icon-chip accent" style={{ width: 36, height: 36, borderRadius: 10 }}><Bot size={17} /></span>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 6 }}>
            <b className="truncate">AI Follow-Up Agent</b>
            <span className="mono faint" style={{ fontSize: 11 }}>v1.0.0</span>
          </div>
          <div className="row" style={{ gap: 6, marginTop: 3 }}>
            <Badge tone="success" dot>live</Badge>
            <span className="tag" style={{ height: 20, fontSize: 11 }}>Drafts + approval · no messaging provider</span>
          </div>
        </div>
      </div>
      <p className="faint" style={{ fontSize: 13, minHeight: 38 }}>Plans follow-ups from matches, missing information and calls; every message passes consent, time-window and frequency checks and is approved and sent by a person.</p>
      {q.error ? <p className="faint" style={{ fontSize: 12.5 }}>Couldn't load activity. {q.error}</p> : d ? (
        <>
          <div className="mini-stats">
            <div><b>{d.planned7d}</b><span>planned · 7d</span></div>
            <div><b>{d.awaiting}</b><span>awaiting approval</span></div>
            <div><b>{d.sent7d}</b><span>sent</span></div>
          </div>
          <div className="row wrap" style={{ gap: 6, fontSize: 12 }}>
            {d.ready > 0 && <span className="tag">{d.ready} approved, ready to send</span>}
            {d.handedOff7d > 0 && <span className="tag">{d.handedOff7d} handed to a person</span>}
            {d.stopped7d > 0 && <span className="tag">{d.stopped7d} blocked, cancelled or expired</span>}
            {d.pendingInput > 0 && <span className="tag"><Inbox size={11} style={{ marginRight: 4 }} />{d.pendingInput} events to process</span>}
          </div>
        </>
      ) : <div className="skeleton" style={{ height: 52 }} />}
      <div className="row" style={{ gap: 6 }}>
        <Button size="sm" onClick={() => navigate('followups')}>Review follow-ups</Button>
      </div>
    </div>
  );
}

/** Agent 06 — real appointment counts. The internal calendar is authoritative; no external calendar is connected. */
function AppointmentAgentCard() {
  const q = useServerQuery(true, () => live.appointmentAgentOverview(), []);
  const d = q.data;
  return (
    <div className="card agent-card">
      <div className="row row-top">
        <span className="icon-chip accent" style={{ width: 36, height: 36, borderRadius: 10 }}><Bot size={17} /></span>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 6 }}>
            <b className="truncate">AI Appointment Agent</b>
            <span className="mono faint" style={{ fontSize: 11 }}>v1.0.0</span>
          </div>
          <div className="row" style={{ gap: 6, marginTop: 3 }}>
            <Badge tone="success" dot>live</Badge>
            <span className="tag" style={{ height: 20, fontSize: 11 }}>Verified slots · no external calendar</span>
          </div>
        </div>
      </div>
      <p className="faint" style={{ fontSize: 13, minHeight: 38 }}>Offers only verified free times (hours, buffers, time off, property), books without double-booking, and hands confirmations and reminders to the Follow-Up Agent.</p>
      {q.error ? <p className="faint" style={{ fontSize: 12.5 }}>Couldn't load activity. {q.error}</p> : d ? (
        <>
          <div className="mini-stats">
            <div><b>{d.upcomingConfirmed}</b><span>confirmed · 14d</span></div>
            <div><b>{d.awaiting}</b><span>awaiting confirmation</span></div>
            <div><b>{d.completed7d}</b><span>completed</span></div>
          </div>
          <div className="row wrap" style={{ gap: 6, fontSize: 12 }}>
            {d.cancelled7d > 0 && <span className="tag">{d.cancelled7d} cancelled · 7d</span>}
            {d.syncFailed > 0 && <span className="tag">{d.syncFailed} calendar sync failed</span>}
          </div>
        </>
      ) : <div className="skeleton" style={{ height: 52 }} />}
      <div className="row" style={{ gap: 6 }}>
        <Button size="sm" onClick={() => navigate('appointments')}>Appointments</Button>
      </div>
    </div>
  );
}

/** Agent 07 — real data quality counts from the server. */
function DataQualityAgentCard() {
  const q = useServerQuery(true, () => live.dataQualityOverview(), []);
  const d = q.data;
  return (
    <div className="card agent-card">
      <div className="row row-top">
        <span className="icon-chip accent" style={{ width: 36, height: 36, borderRadius: 10 }}><Bot size={17} /></span>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 6 }}>
            <b className="truncate">AI CRM &amp; Data Intelligence Agent</b>
            <span className="mono faint" style={{ fontSize: 11 }}>v1.0.0</span>
          </div>
          <div className="row" style={{ gap: 6, marginTop: 3 }}>
            <Badge tone="success" dot>live</Badge>
            <span className="tag" style={{ height: 20, fontSize: 11 }}>Deterministic rules · merges need a person</span>
          </div>
        </div>
      </div>
      <p className="faint" style={{ fontSize: 13, minHeight: 38 }}>Checks records for invalid, inconsistent, stale and duplicate data, tracks where values came from, and proposes corrections and merges for review.</p>
      {q.error ? <p className="faint" style={{ fontSize: 12.5 }}>Couldn't load activity. {q.error}</p> : d ? (
        <>
          <div className="mini-stats">
            <div><b>{d.issues.open}</b><span>open issues</span></div>
            <div><b>{d.issues.critical + d.issues.high}</b><span>critical / high</span></div>
            <div><b>{d.duplicates.awaiting_review}</b><span>duplicates to review</span></div>
          </div>
          <div className="row wrap" style={{ gap: 6, fontSize: 12 }}>
            {d.score.average !== null && <span className="tag">Average score {d.score.average}</span>}
            {d.queue.pending > 0 && <span className="tag">{d.queue.pending} changes waiting</span>}
          </div>
        </>
      ) : <div className="skeleton" style={{ height: 52 }} />}
      <div className="row" style={{ gap: 6 }}>
        <Button size="sm" onClick={() => navigate('dataquality')}>Data quality</Button>
      </div>
    </div>
  );
}

/** Agent 08 — real insight counts from the server. */
function SalesIntelligenceAgentCard() {
  const q = useServerQuery(true, () => live.siInsights(['new', 'reviewed', 'accepted', 'in_progress']), []);
  const d = q.data;
  return (
    <div className="card agent-card">
      <div className="row row-top">
        <span className="icon-chip accent" style={{ width: 36, height: 36, borderRadius: 10 }}><Bot size={17} /></span>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 6 }}>
            <b className="truncate">AI Sales Intelligence Agent</b>
            <span className="mono faint" style={{ fontSize: 11 }}>v1.0.0</span>
          </div>
          <div className="row" style={{ gap: 6, marginTop: 3 }}>
            <Badge tone="success" dot>live</Badge>
            <span className="tag" style={{ height: 20, fontSize: 11 }}>Exact metrics · AI interprets only</span>
          </div>
        </div>
      </div>
      <p className="faint" style={{ fontSize: 13, minHeight: 38 }}>Computes funnel, source, team and pipeline metrics with fixed definitions, flags unusual changes and bottlenecks, and forecasts from real deals.</p>
      {q.error ? <p className="faint" style={{ fontSize: 12.5 }}>Couldn't load insights. {q.error}</p> : d ? (
        <div className="mini-stats">
          <div><b>{d.length}</b><span>open insights</span></div>
          <div><b>{d.filter((x) => x.priority === 'high').length}</b><span>high priority</span></div>
          <div><b>{d.filter((x) => x.kind === 'recommendation').length}</b><span>AI recommendations</span></div>
        </div>
      ) : <div className="skeleton" style={{ height: 52 }} />}
      <div className="row" style={{ gap: 6 }}>
        <Button size="sm" onClick={() => navigate('sales')}>Sales intelligence</Button>
      </div>
    </div>
  );
}
