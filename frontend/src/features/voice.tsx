// Agent 02 — AI Voice Calling Agent, live mode: lead call action, lead call history, Calls page and settings.
// Everything shown here comes from the backend; a call is only shown as connected once Retell's webhook says so.
import { useState } from 'react';
import { AlertTriangle, Bot, Headphones, Lock, PhoneCall, PhoneIncoming, PhoneOutgoing, Settings2, ShieldCheck } from 'lucide-react';
import { Badge, Button, Drawer, Empty, Field, Input, KV, Modal, PageHeader, Pager, Segmented, Select, Switch, TableSkeleton } from '@/components/ui';
import { useCan, useLookup } from '@/store/hooks';
import { toast } from '@/store/ui';
import { navigate, setParam } from '@/lib/router';
import { duration, fmtDateTime, relTime } from '@/lib/format';
import type { Tone } from '@/lib/domain';
import { useServerQuery } from '@/data/useServerQuery';
import { ok } from '@/data/actions';
import * as live from '@/backend/live';
import { errorMessage } from '@/backend/errors';
import type { Lead } from '@/store/types';
import { PolicyChecks } from './shared';

export const CALL_STATUS: Record<live.VoiceCallRow['status'], { label: string; tone: Tone }> = {
  initiating: { label: 'Starting', tone: 'neutral' },
  dialing: { label: 'Dialing', tone: 'accent' },
  in_progress: { label: 'In progress', tone: 'accent' },
  completed: { label: 'Completed', tone: 'success' },
  no_answer: { label: 'No answer', tone: 'warning' },
  busy: { label: 'Busy', tone: 'warning' },
  voicemail: { label: 'Voicemail', tone: 'warning' },
  failed: { label: 'Failed', tone: 'danger' },
  unknown: { label: 'Outcome unknown', tone: 'danger' },
  blocked: { label: 'Blocked', tone: 'neutral' },
};
const OUTCOME: Record<string, string> = {
  connected: 'Spoke with the lead', no_answer: 'No answer', busy: 'Line busy', voicemail: 'Reached voicemail', failed: 'Call failed',
  opted_out: 'Asked not to be called', callback_requested: 'Asked for a call back', unknown: 'Unknown',
};
const ANALYSIS: Record<string, string> = {
  not_requested: 'Waiting for the provider', pending: 'Analysing', succeeded: 'Done', failed: 'Failed after retries — call record kept', skipped: 'Not run (disabled, no transcript or no conversation)',
};

const ts = (v: string | null) => (v ? new Date(v).getTime() : null);
const newKey = () => `ui_${crypto.randomUUID().replace(/-/g, '')}`;

export function CallStatusBadge({ c }: { c: Pick<live.VoiceCallRow, 'status'> }) {
  const s = CALL_STATUS[c.status];
  return <Badge tone={s.tone} dot={['dialing', 'in_progress'].includes(c.status)}>{s.label}</Badge>;
}

/* ─────────────────────────── lead: call action ─────────────────────────── */

export function LiveCallModal({ lead, contactId, onClose }: { lead: Lead; contactId: string; onClose: () => void }) {
  const canConsent = useCan('contacts.edit');
  const status = useServerQuery(true, () => live.voiceStatus(), []);
  const pre = useServerQuery(true, () => live.voicePreflight(lead.id), [lead.id]);
  const [key] = useState(newKey); // one key per dialog: double clicks and retries cannot place two calls
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState('');
  const consentCheck = pre.data?.checks.find((c) => c.key === 'consent');
  const suppressed = pre.data?.checks.find((c) => c.key === 'not_suppressed' && !c.ok);

  const place = async () => {
    setBusy(true);
    try {
      const r = await live.requestAiCall(lead.id, key);
      if (r.status === 'blocked') toast({ kind: 'error', title: 'Call blocked', body: r.reason });
      else if (r.status === 'dialing') toast({ kind: 'success', title: 'Call sent to the voice provider', body: 'Status updates here as Retell reports it.' });
      else if (r.status === 'pending_confirmation') toast({ kind: 'warning', title: 'Waiting for the provider to confirm', body: 'The request is retried safely; it will not dial twice.' });
      else toast({ kind: 'info', title: `Call ${r.status}` });
      onClose();
    } catch (e) {
      toast({ kind: 'error', title: 'Call not placed', body: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  const recordConsent = async () => {
    if (await ok(() => live.setAiCallConsent(contactId, 'granted', source))) {
      toast({ kind: 'success', title: 'AI-call consent recorded' });
      setSource('');
      pre.reload();
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`AI call to ${lead.name}?`}
      description="The server checks consent, suppression, calling hours and limits right before dialing. The voice assistant says it is an AI and never confirms bookings itself."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="accent" icon={<PhoneCall size={15} />} loading={busy} disabled={!pre.data?.allowed || !status.data?.retell_configured || busy} onClick={place}>Place AI call</Button>
        </>
      }
    >
      {status.data && !status.data.retell_configured && (
        <div className="banner warning" style={{ marginBottom: 12 }}><AlertTriangle size={15} /> The voice provider (Retell) is not configured on the server yet, so no call can be placed.</div>
      )}
      {pre.loading && !pre.data ? <TableSkeleton rows={5} /> : pre.error ? <p className="faint">{pre.error}</p> : pre.data && <PolicyChecks result={pre.data as never} />}
      {consentCheck && !consentCheck.ok && !suppressed && canConsent && (
        <div className="card mt-12" style={{ padding: 12, boxShadow: 'none' }}>
          <b style={{ fontSize: 13 }}>Record AI-call consent</b>
          <p className="faint" style={{ fontSize: 12, margin: '4px 0 8px' }}>Only if the person agreed to receive automated AI calls. Unknown is never treated as permission.</p>
          <div className="row" style={{ gap: 6 }}>
            <Input inputSize="sm" value={source} onChange={(e) => setSource(e.target.value)} placeholder="How it was captured, e.g. 'Verbal, walk-in 25 Oct'" />
            <Button size="sm" disabled={source.trim().length < 3} onClick={recordConsent}>Record</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/* ─────────────────────────── lead: call history ─────────────────────────── */

export function LeadCallsPanel({ leadId }: { leadId: string }) {
  const canPlace = useCan('calls.place');
  const canLogs = useCan('logs.view');
  const canSee = canPlace || canLogs;
  const q = useServerQuery(canSee, () => live.leadVoiceCalls(leadId), [leadId]);
  if (!canSee || (!q.loading && !q.data?.length && !q.error)) return null;
  return (
    <section>
      <h4 className="section-title">AI calls</h4>
      {q.loading && !q.data ? <div className="skeleton" style={{ height: 48 }} /> : q.error ? <p className="faint" style={{ fontSize: 12.5 }}>{q.error}</p> : (
        <div className="card" style={{ boxShadow: 'none' }}>
          {q.data!.map((c) => (
            <button key={c.id} className="list-row" onClick={() => navigate('calls', { id: c.id })}>
              {c.direction === 'inbound' ? <PhoneIncoming size={14} className="faint" /> : <PhoneOutgoing size={14} className="faint" />}
              <CallStatusBadge c={c} />
              <span className="grow truncate" style={{ fontSize: 13 }}>
                {c.outcome ? OUTCOME[c.outcome] ?? c.outcome : c.last_provider_error ?? '—'}
                {c.human_handoff_status && <span className="faint"> · call-back task created</span>}
              </span>
              {c.duration_seconds != null && <span className="mono faint" style={{ fontSize: 11.5 }}>{duration(c.duration_seconds)}</span>}
              <span className="faint" style={{ fontSize: 12 }}>{relTime(new Date(c.requested_at).getTime())}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

/* ─────────────────────────── Calls page ─────────────────────────── */

export function LiveCallsPage({ params }: { params: URLSearchParams }) {
  const canManage = useCan('integrations.manage');
  const leads = useLookup('leads');
  const [tab, setTab] = useState<'all' | 'live' | 'attention' | 'blocked'>('all');
  const [page, setPage] = useState(0);
  const [settings, setSettings] = useState(false);
  const status = useServerQuery(true, () => live.voiceStatus(), []);
  const cfg = useServerQuery(true, () => live.loadVoiceSettings(), []);
  const list = useServerQuery(true, () => live.listVoiceCalls({ status: tab === 'all' ? undefined : tab, page, pageSize: 25 }), [tab, page]);
  const openId = params.get('id');
  const configured = !!status.data?.retell_configured && !!cfg.data?.enabled;

  return (
    <div className="page">
      <PageHeader
        eyebrow="[ Voice · Retell AI ]"
        title="Calls"
        sub="AI voice calls placed or received through Retell. Every outbound call passes consent, suppression, calling-hour and frequency checks on the server right before dialing."
        actions={canManage ? <Button icon={<Settings2 size={15} />} onClick={() => setSettings(true)}>Voice settings</Button> : undefined}
      />
      <div className={`banner ${configured ? '' : 'warning'}`} style={{ marginBottom: 16 }}>
        {configured ? <ShieldCheck size={16} /> : <AlertTriangle size={16} />}
        <div className="grow" style={{ fontSize: 13 }}>
          <b>{configured ? 'AI calling is on' : 'AI calling is not active'}</b>
          <div className="faint">
            Provider: {status.data ? (status.data.retell_configured ? 'Retell connected' : 'Retell API key not set on the server') : '…'}
            {' · '}Agency settings: {cfg.data ? (cfg.data.enabled ? 'enabled' : 'disabled') : cfg.loading ? '…' : 'not set up'}
            {' · '}Post-call AI analysis: {cfg.data?.analysis_enabled ? (status.data?.analysis_configured ? 'on' : 'on, but Claude key not set') : 'off'}
          </div>
        </div>
      </div>
      <Segmented value={tab} onChange={(v) => { setTab(v as typeof tab); setPage(0); }} options={[
        { value: 'all', label: 'All' }, { value: 'live', label: 'Live' }, { value: 'attention', label: 'Needs attention' }, { value: 'blocked', label: 'Blocked' },
      ]} />
      <div className="card mt-12">
        {list.loading && !list.data ? <TableSkeleton rows={6} /> : list.error ? <p className="faint" style={{ padding: 16 }}>{list.error}</p> : !list.data?.rows.length ? (
          <Empty icon={<PhoneCall size={20} />} title="No calls yet" description="Calls appear here when someone places an AI call from a lead, or when Retell delivers an inbound call." />
        ) : (
          <table className="table">
            <thead><tr><th>Lead</th><th>Status</th><th>Outcome</th><th className="right">Duration</th><th>When</th></tr></thead>
            <tbody>
              {list.data.rows.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => setParam('id', c.id)}>
                  <td><span className="row" style={{ gap: 6 }}>{c.direction === 'inbound' ? <PhoneIncoming size={13} className="faint" /> : <PhoneOutgoing size={13} className="faint" />}{c.lead_id ? leads.get(c.lead_id)?.name ?? 'Lead' : <span className="faint">Unknown caller</span>}</span></td>
                  <td><CallStatusBadge c={c} /></td>
                  <td className="truncate" style={{ maxWidth: 280 }}>{c.status === 'blocked' ? <span className="faint">{c.block_reason}</span> : c.outcome ? OUTCOME[c.outcome] : '—'}{c.human_handoff_status && <Badge tone="warning">call back</Badge>}</td>
                  <td className="right num">{c.duration_seconds != null ? duration(c.duration_seconds) : '—'}</td>
                  <td className="faint">{relTime(new Date(c.requested_at).getTime())}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!!list.data?.total && <Pager page={page} pageSize={25} total={list.data.total} onPage={setPage} />}
      </div>
      {openId && <CallDrawer id={openId} onClose={() => setParam('id', null)} />}
      {settings && cfg && <VoiceSettingsModal initial={cfg.data ?? null} onClose={() => { setSettings(false); cfg.reload(); }} />}
    </div>
  );
}

function CallDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useServerQuery(true, () => live.voiceCallDetail(id), [id]);
  const leads = useLookup('leads');
  const [rec, setRec] = useState(false);
  const c = q.data?.call;
  const a = c?.analysis;
  const openRecording = async () => {
    setRec(true);
    try {
      const r = await live.voiceRecordingUrl(id);
      window.open(r.url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      toast({ kind: 'error', title: 'Recording unavailable', body: errorMessage(e) });
    } finally {
      setRec(false);
    }
  };
  return (
    <Drawer open wide onClose={onClose} label="Call" header={<div><h2 style={{ fontSize: 19, fontWeight: 600 }}>{c?.lead_id ? leads.get(c.lead_id)?.name ?? 'Call' : 'Call'}</h2>{c && <div className="row mt-4" style={{ gap: 6 }}><CallStatusBadge c={c} /><span className="faint">{c.direction} · {fmtDateTime(ts(c.requested_at))}</span></div>}</div>}>
      {q.loading && !q.data ? <TableSkeleton rows={6} /> : q.error ? <p className="faint">{q.error}</p> : c && (
        <div className="stack stack-lg">
          <KV items={[
            ['Outcome', c.outcome ? OUTCOME[c.outcome] : c.status === 'blocked' ? c.block_reason : '—'],
            ['Started', fmtDateTime(ts(c.started_at))],
            ['Ended', fmtDateTime(ts(c.ended_at))],
            ['Duration', c.duration_seconds != null ? duration(c.duration_seconds) : '—'],
            ['Provider reason', c.disconnection_reason ? c.disconnection_reason.replace(/_/g, ' ') : '—'],
            ['Human follow-up', c.human_handoff_status ? 'Call-back task created and owner notified' : 'Not requested'],
            ['Opt-out', c.opt_out_detected ? <Badge key="o" tone="danger">Phone contact revoked</Badge> : 'No'],
            ['AI analysis', ANALYSIS[c.analysis_status] ?? c.analysis_status],
            ...(c.last_provider_error ? [['Provider note', c.last_provider_error] as [string, string]] : []),
          ]} />
          {c.summary && <section><h4 className="section-title">Summary</h4><div className="tl-body" style={{ marginTop: 0 }}>{c.summary}</div></section>}
          {a && (
            <section>
              <h4 className="section-title">Extracted from the call</h4>
              <KV items={[
                ['Filled on the lead', a.filled?.length ? a.filled.join(', ') : 'Nothing new'],
                ['Differs from CRM (not changed)', a.conflicts?.length ? <span key="c" className="row" style={{ gap: 6 }}><AlertTriangle size={13} />{a.conflicts.join(', ')}</span> : 'None'],
                ['Still unanswered', a.unanswered_questions?.length ? a.unanswered_questions.join(' · ') : '—'],
                ['Suggested next step', a.next_recommended_action?.replace(/_/g, ' ') ?? '—'],
              ]} />
            </section>
          )}
          <section>
            <h4 className="section-title"><Lock size={12} /> Transcript & recording</h4>
            {!q.data!.can_view_transcript ? <p className="faint" style={{ fontSize: 12.5 }}>Only roles with recording access can view transcripts.</p>
              : q.data!.transcript ? <pre className="card" style={{ whiteSpace: 'pre-wrap', fontSize: 12.5, padding: 12, maxHeight: 320, overflow: 'auto', boxShadow: 'none' }}>{q.data!.transcript}</pre>
              : <p className="faint" style={{ fontSize: 12.5 }}>{c.transcript_stored ? 'Transcript expired under the retention policy.' : 'No transcript stored (transcript storage is off or nothing was said).'}</p>}
            {q.data!.can_view_transcript && q.data!.recording_access && c.recording_available && (
              <Button size="sm" className="mt-8" icon={<Headphones size={14} />} loading={rec} onClick={openRecording}>Open recording</Button>
            )}
          </section>
          {c.lead_id && <Button variant="ghost" icon={<Bot size={14} />} onClick={() => navigate('leads', { id: c.lead_id! })}>Open lead →</Button>}
        </div>
      )}
    </Drawer>
  );
}

const DEFAULTS: live.VoiceSettings = {
  enabled: false, outbound_agent_id: null, inbound_agent_id: null, from_number: null, agency_spoken_name: null, consent_basis: 'ai_call',
  store_transcripts: false, analysis_enabled: false, recording_access: false, transcript_retention_days: 90,
  max_attempts_per_lead_per_day: 2, min_minutes_between_attempts: 240, max_calls_per_day: 100,
};

function VoiceSettingsModal({ initial, onClose }: { initial: live.VoiceSettings | null; onClose: () => void }) {
  const [f, setF] = useState<live.VoiceSettings>({ ...DEFAULTS, ...(initial ?? {}) });
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof live.VoiceSettings>(k: K, v: live.VoiceSettings[K]) => setF({ ...f, [k]: v });
  const num = (k: 'transcript_retention_days' | 'max_attempts_per_lead_per_day' | 'min_minutes_between_attempts' | 'max_calls_per_day') =>
    <Input value={String(f[k])} inputMode="numeric" onChange={(e) => set(k, Number(e.target.value.replace(/\D/g, '')) || 0)} />;
  const save = async () => {
    setBusy(true);
    const done = await ok(() => live.saveVoiceSettings({ ...f, outbound_agent_id: f.outbound_agent_id || null, inbound_agent_id: f.inbound_agent_id || null, from_number: f.from_number || null }));
    setBusy(false);
    if (done) { toast({ kind: 'success', title: 'Voice settings saved' }); onClose(); }
  };
  return (
    <Modal open size="wide" onClose={onClose} title="Voice settings" description="Retell agent ids and the calling number come from your Retell dashboard. API keys are set on the server, never here."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save</Button></>}>
      <div className="form-grid">
        <Field label="AI calling" className="full"><Switch on={f.enabled} label="Enable AI calling" onChange={(v) => set('enabled', v)} /></Field>
        <Field label="Spoken agency name" hint="Used in the greeting"><Input value={f.agency_spoken_name ?? ''} onChange={(e) => set('agency_spoken_name', e.target.value)} /></Field>
        <Field label="Calling number (E.164)" hint="Owned or imported in Retell"><Input value={f.from_number ?? ''} placeholder="+9180…" onChange={(e) => set('from_number', e.target.value.trim())} /></Field>
        <Field label="Outbound Retell agent id"><Input value={f.outbound_agent_id ?? ''} onChange={(e) => set('outbound_agent_id', e.target.value.trim())} /></Field>
        <Field label="Inbound Retell agent id" hint="Optional"><Input value={f.inbound_agent_id ?? ''} onChange={(e) => set('inbound_agent_id', e.target.value.trim())} /></Field>
        <Field label="Consent required"><Select value={f.consent_basis} onChange={(e) => set('consent_basis', e.target.value as 'ai_call' | 'phone')}>
          <option value="ai_call">Explicit AI-call consent</option><option value="phone">Phone consent (AI or general)</option></Select></Field>
        <Field label="Attempts per lead per day">{num('max_attempts_per_lead_per_day')}</Field>
        <Field label="Minimum minutes between attempts">{num('min_minutes_between_attempts')}</Field>
        <Field label="Max calls per day">{num('max_calls_per_day')}</Field>
        <Field label="Store transcripts" hint="Only where your notice/consent covers it"><Switch on={f.store_transcripts} label="Store transcripts" onChange={(v) => set('store_transcripts', v)} /></Field>
        <Field label="Transcript retention (days)">{num('transcript_retention_days')}</Field>
        <Field label="Post-call AI analysis" hint="Sends the transcript to Claude"><Switch on={f.analysis_enabled} label="Post-call AI analysis" onChange={(v) => set('analysis_enabled', v)} /></Field>
        <Field label="Recording access" hint="For roles with recording permission"><Switch on={f.recording_access} label="Recording access" onChange={(v) => set('recording_access', v)} /></Field>
      </div>
      <p className="faint mt-8" style={{ fontSize: 12 }}>Calling hours and days use the organization's calling-hours and business-day settings. Recording consent and the AI disclosure are configured on the Retell agent (see the setup guide).</p>
    </Modal>
  );
}
