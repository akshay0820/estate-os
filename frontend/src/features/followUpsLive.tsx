// Agent 05 — Follow-Up, live mode: the lead's follow-up panel and the org-wide approval queue.
// No messaging provider is connected, so nothing here sends: a person sends the approved text through their own channel
// and then records it ("Mark as sent"). Drafts, approvals and sends are labelled distinctly; nothing shows as delivered
// without provider evidence.
import { useState } from 'react';
import { AlertTriangle, Check, ClipboardCopy, ListTodo, Pencil, RefreshCw, Send, ShieldCheck, X } from 'lucide-react';
import { Badge, Button, Empty, Input, PageHeader, Tabs, Textarea } from '@/components/ui';
import { confirm } from '@/components/dialogs';
import { toast } from '@/store/ui';
import { fmtDateTime, relTime } from '@/lib/format';
import { navigate } from '@/lib/router';
import type { Tone } from '@/lib/domain';
import { useServerQuery } from '@/data/useServerQuery';
import { attempt, ok } from '@/data/actions';
import * as live from '@/backend/live';

export const FU_STATUS: Record<live.FollowUpStatus, { label: string; tone: Tone }> = {
  pending_approval: { label: 'Draft · awaiting approval', tone: 'warning' },
  approved: { label: 'Approved · ready to send', tone: 'accent' },
  scheduled: { label: 'Scheduled', tone: 'accent' },
  processing: { label: 'Sending…', tone: 'accent' },
  sent: { label: 'Sent', tone: 'success' },
  delivered: { label: 'Delivered', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  suppressed: { label: 'Blocked by policy', tone: 'danger' },
  expired: { label: 'Expired', tone: 'neutral' },
  handed_off: { label: 'Handed to a person', tone: 'info' },
};
export const FU_PURPOSE: Record<live.FollowUpPurpose, string> = {
  share_property_recommendations: 'Share matched listings',
  clarify_requirements: 'Ask for missing requirements',
  answer_call_questions: 'Answer questions from a call',
  callback_request: 'Call-back requested',
  re_engagement: 'Re-engagement',
};
const CHANNEL: Record<string, string> = { whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email', task: 'Task' };
const SOURCE: Record<string, string> = { template: 'Template draft', ai: 'AI draft', human: 'Edited by a person' };

function sentLabel(f: live.FollowUpItem) {
  if (f.status === 'delivered') return `Delivered ${relTime(new Date(f.delivered_at!).getTime())}`;
  if (f.sent_via === 'manual') return `Sent by a person ${relTime(new Date(f.sent_at!).getTime())} · not delivery-confirmed`;
  if (f.sent_via === 'provider') return `Accepted by ${f.provider} ${relTime(new Date(f.sent_at!).getTime())} · delivery not yet confirmed`;
  return null;
}

export function FollowUpsPanel({ leadId }: { leadId: string }) {
  const q = useServerQuery(true, () => live.leadFollowUps(leadId), [leadId]);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState({ subject: '', body: '' });
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const d = q.data;

  const run = async (key: string, fn: () => Promise<unknown>, success?: string) => {
    setBusy(key);
    const done = await ok(fn);
    setBusy(null);
    if (done) { if (success) toast({ kind: 'success', title: success }); setEditing(null); setRejecting(null); setNote(''); q.reload(); }
  };
  const markSent = async (f: live.FollowUpItem) => {
    const yes = await confirm({ title: 'Mark as sent?', body: `Only confirm after you have sent this exact text by ${CHANNEL[f.channel]} yourself. Consent and limits are checked again now.`, confirmLabel: 'I sent it' });
    if (!yes) return;
    setBusy(f.id);
    const r = await attempt(() => live.markFollowUpSent(f.id, f.content_version));
    setBusy(null);
    if (!r) return;
    if (r.status === 'sent') toast({ kind: 'success', title: 'Recorded as sent', body: 'Logged on the timeline with the exact text.' });
    else toast({ kind: 'error', title: r.status === 'suppressed' ? 'Blocked by policy' : 'Content no longer valid', body: 'Do not send it. The follow-up was stopped.' });
    q.reload();
  };

  if (q.loading && !d) return <div className="skeleton" style={{ height: 100 }} />;
  if (q.error) return <p className="faint" style={{ fontSize: 12.5 }}>Couldn't load follow-ups. {q.error}</p>;
  if (!d) return null;

  return (
    <div className="stack">
      <div className="row row-between">
        <h4 className="section-title" style={{ margin: 0 }}>Follow-ups</h4>
        {d.can_act && (
          <div className="row" style={{ gap: 4 }}>
            <Button size="xs" icon={<RefreshCw size={12} />} loading={busy === 'share'} onClick={() => run('share', () => live.requestFollowUp(leadId, 'share_property_recommendations'), 'Planning queued')}>Suggest listings follow-up</Button>
            <Button size="xs" variant="ghost" loading={busy === 'clarify'} onClick={() => run('clarify', () => live.requestFollowUp(leadId, 'clarify_requirements'), 'Planning queued')}>Ask for missing info</Button>
          </div>
        )}
      </div>
      <div className="banner" style={{ fontSize: 12.5 }}>
        <ShieldCheck size={14} />
        <span>
          No messaging provider is connected, so nothing is sent automatically. Approve a draft, send it yourself, then mark it as sent.
          {' '}Channels now: {(['whatsapp', 'sms', 'email'] as const).map((ch) => {
            const p = d.channels[ch].policy;
            return <span key={ch} title={p.failed.join(' · ') || 'All checks pass'} style={{ marginLeft: 6 }}><Badge tone={p.allowed ? 'success' : p.blocked ? 'neutral' : 'warning'}>{CHANNEL[ch]}: {p.allowed ? 'allowed' : p.blocked ? 'blocked' : 'later'}</Badge></span>;
          })}
        </span>
      </div>
      {d.items.length === 0 && <Empty icon={<Send size={20} />} title="No follow-ups yet" description="The Follow-Up Agent plans one when listings are matched, information is missing, or a call needs a person." />}
      {d.items.map((f) => {
        const isEditing = editing === f.id;
        const sent = sentLabel(f);
        return (
          <div key={f.id} className="card" style={{ padding: 12, boxShadow: 'none' }}>
            <div className="row wrap" style={{ gap: 6 }}>
              <b style={{ fontSize: 13 }}>{FU_PURPOSE[f.purpose]}</b>
              <Badge tone={FU_STATUS[f.status].tone}>{FU_STATUS[f.status].label}</Badge>
              <span className="tag">{CHANNEL[f.channel]}</span>
              {f.kind === 'message' && <span className="faint" style={{ fontSize: 12 }}>{SOURCE[f.generated_by]} · v{f.content_version}{f.draft_status === 'pending' ? ' · AI rewrite pending' : ''}</span>}
              <span className="faint" style={{ fontSize: 12 }}>{relTime(new Date(f.created_at).getTime())}</span>
            </div>
            <p className="faint" style={{ fontSize: 12.5, margin: '4px 0 0' }}>Why: {f.reason}</p>
            {f.status_reason && <p style={{ fontSize: 12.5, margin: '4px 0 0' }}>{['suppressed', 'failed'].includes(f.status) && <AlertTriangle size={12} />} {f.status_reason}</p>}
            {sent && <p style={{ fontSize: 12.5, margin: '4px 0 0' }}><Check size={12} /> {sent}</p>}
            {f.status === 'pending_approval' && f.scheduled_for && new Date(f.scheduled_for).getTime() > Date.now() + 60e3 && (
              <p className="faint" style={{ fontSize: 12.5, margin: '4px 0 0' }}>Earliest allowed send: {fmtDateTime(new Date(f.scheduled_for).getTime())} ({f.timezone})</p>
            )}
            {f.properties.length > 0 && (
              <div className="row wrap mt-8" style={{ gap: 4 }}>
                {f.properties.map((p) => <button type="button" key={p.id} className="tag" onClick={() => navigate('properties', { id: p.id })}>{p.title} · {p.reference_code}{p.status !== 'active' ? ` (${p.status})` : ''}</button>)}
              </div>
            )}
            {f.kind === 'message' && d.can_view_drafts && !isEditing && f.body && (
              <div className="mt-8" style={{ whiteSpace: 'pre-wrap', fontSize: 13, background: 'var(--fill)', borderRadius: 8, padding: 10 }}>
                {f.subject && <div><b>Subject:</b> {f.subject}</div>}
                {f.body}
              </div>
            )}
            {isEditing && (
              <div className="stack mt-8" style={{ gap: 6 }}>
                {f.channel === 'email' && <Input inputSize="sm" value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} placeholder="Subject" />}
                <Textarea value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} style={{ minHeight: 140 }} />
                <div className="row" style={{ gap: 6 }}>
                  <Button size="sm" variant="primary" loading={busy === f.id} onClick={() => run(f.id, () => live.updateFollowUpDraft(f.id, draft.subject || null, draft.body), 'Draft saved — approve it again')}>Save</Button>
                  <Button size="sm" onClick={() => setEditing(null)}>Cancel</Button>
                </div>
              </div>
            )}
            {d.can_act && !isEditing && (
              <div className="row wrap mt-8" style={{ gap: 4 }}>
                {f.status === 'pending_approval' && (
                  <>
                    <Button size="xs" variant="primary" icon={<Check size={12} />} loading={busy === f.id} onClick={() => run(f.id, () => live.decideFollowUp(f.id, 'approve', f.content_version), 'Approved')}>Approve this version</Button>
                    <Button size="xs" icon={<Pencil size={12} />} onClick={() => { setEditing(f.id); setDraft({ subject: f.subject ?? '', body: f.body ?? '' }); }}>Edit</Button>
                    <Button size="xs" variant="ghost" icon={<X size={12} />} onClick={() => setRejecting(rejecting === f.id ? null : f.id)}>Reject</Button>
                  </>
                )}
                {f.status === 'approved' && (
                  <>
                    <Button size="xs" icon={<ClipboardCopy size={12} />} onClick={async () => { await navigator.clipboard.writeText(`${f.subject ? f.subject + '\n\n' : ''}${f.body ?? ''}`); toast({ kind: 'info', title: 'Copied', body: 'Send it yourself, then mark it as sent.' }); }}>Copy text</Button>
                    <Button size="xs" variant="primary" icon={<Send size={12} />} loading={busy === f.id} onClick={() => void markSent(f)}>Mark as sent</Button>
                  </>
                )}
                {['pending_approval', 'approved', 'scheduled'].includes(f.status) && f.status !== 'pending_approval' && (
                  <Button size="xs" variant="ghost" onClick={() => run(f.id, () => live.decideFollowUp(f.id, 'cancel', null), 'Cancelled')}>Cancel</Button>
                )}
                {f.status === 'failed' && f.last_error_category !== 'ambiguous' && <Button size="xs" onClick={() => run(f.id, () => live.retryFollowUp(f.id), 'Back to approval')}>Retry</Button>}
                {f.task_id && <Button size="xs" variant="ghost" icon={<ListTodo size={12} />} onClick={() => navigate('tasks')}>Open tasks</Button>}
              </div>
            )}
            {rejecting === f.id && (
              <div className="row mt-8" style={{ gap: 6 }}>
                <Input inputSize="sm" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Why (required)" />
                <Button size="sm" disabled={note.trim().length < 3} loading={busy === f.id} onClick={() => run(f.id, () => live.decideFollowUp(f.id, 'reject', null, note), 'Rejected')}>Reject</Button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

type QueueTab = 'review' | 'ready' | 'sent' | 'stopped';
const QUEUE: Record<QueueTab, live.FollowUpStatus[]> = {
  review: ['pending_approval'], ready: ['approved', 'scheduled', 'processing'], sent: ['sent', 'delivered', 'handed_off'], stopped: ['suppressed', 'cancelled', 'expired', 'failed'],
};

export function LiveFollowUpsPage() {
  const [tab, setTab] = useState<QueueTab>('review');
  const q = useServerQuery(true, () => live.followUpQueue(QUEUE[tab]), [tab]);
  const rows = q.data ?? [];
  return (
    <div className="page">
      <PageHeader eyebrow="[ Follow-Up Agent ]" title="Follow-ups"
        sub="Drafts the AI planned from matches, missing information and calls. Every message passes consent, time-window and frequency checks; a person approves and sends it." />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'review', label: 'Awaiting approval' }, { value: 'ready', label: 'Ready to send' }, { value: 'sent', label: 'Sent / handed off' }, { value: 'stopped', label: 'Stopped' }]} />
      <div className="card mt-8">
        {q.error ? <p className="faint" style={{ padding: 12 }}>Couldn't load follow-ups. {q.error}</p>
          : q.loading && !q.data ? <div className="skeleton" style={{ height: 120 }} />
          : rows.length === 0 ? <Empty icon={<Send size={20} />} title="Nothing here" description="Follow-ups appear as leads are matched, qualified or called." />
          : (
            <table className="table">
              <thead><tr><th>Lead</th><th>Follow-up</th><th>Channel</th><th>Status</th><th>Why</th><th>When</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="clickable" onClick={() => navigate('leads', { id: r.lead_id })}>
                    <td>{r.leads?.title ?? '—'}</td>
                    <td>{FU_PURPOSE[r.purpose]}</td>
                    <td>{CHANNEL[r.channel] ?? r.channel}</td>
                    <td><Badge tone={FU_STATUS[r.status].tone}>{FU_STATUS[r.status].label}</Badge>{r.sent_via === 'manual' ? <span className="faint" style={{ fontSize: 11 }}> by a person</span> : null}</td>
                    <td className="faint" style={{ fontSize: 12.5, maxWidth: 320 }}>{r.status_reason ?? r.reason}</td>
                    <td className="faint" style={{ fontSize: 12.5 }}>{relTime(new Date(r.sent_at ?? r.created_at).getTime())}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
      <p className="faint mt-8" style={{ fontSize: 12 }}>Open a lead's <b>Calls &amp; messages</b> tab to review, edit, approve and record sends.</p>
    </div>
  );
}
