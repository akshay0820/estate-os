import { useMemo, useState } from 'react';
import { CheckCircle2, CircleSlash, Clock3, Pause, Play, Repeat, Square } from 'lucide-react';
import { Badge, Button, Empty, PageHeader, Tabs } from '@/components/ui';
import { confirm } from '@/components/dialogs';
import { useStore } from '@/store/store';
import { useCan, useLookup, useOrgList } from '@/store/hooks';
import { toast } from '@/store/ui';
import { navigate } from '@/lib/router';
import { fmtDateTime, relTime } from '@/lib/format';
import type { FollowUp } from '@/store/types';
import { CHANNEL_ICON, MemberChip } from './shared';
import { LIVE } from '@/data/actions';
import { LiveFollowUpsPage } from './followUpsLive';

const TONE = { active: 'accent', paused: 'warning', stopped: 'neutral', completed: 'success' } as const;

export function FollowUpsPage() {
  return LIVE ? <LiveFollowUpsPage /> : <DemoFollowUpsPage />;
}

function DemoFollowUpsPage() {
  const followUps = useOrgList('followUps');
  const leads = useLookup('leads');
  const canEdit = useCan('inbox.reply');
  const setStatus = useStore((s) => s.setFollowUpStatus);
  const [tab, setTab] = useState<FollowUp['status']>('active');
  const list = useMemo(() => followUps.filter((f) => f.status === tab).sort((a, b) => b.createdAt - a.createdAt), [followUps, tab]);
  const count = (s: FollowUp['status']) => followUps.filter((f) => f.status === s).length;

  return (
    <div className="page">
      <PageHeader
        eyebrow="[ Sequences ]"
        title="Follow-ups"
        sub="Every running sequence, its next step and its stop rules. Sequences stop automatically when a lead replies, books, opts out, or a person takes over."
      />
      <div className="card">
        <div style={{ padding: '4px 14px 0' }}>
          <Tabs value={tab} onChange={setTab} tabs={[
            { value: 'active', label: 'Running', count: count('active') },
            { value: 'paused', label: 'Paused', count: count('paused') },
            { value: 'stopped', label: 'Stopped', count: count('stopped') },
            { value: 'completed', label: 'Completed', count: count('completed') },
          ]} />
        </div>
        {list.length === 0 && <Empty icon={<Repeat size={20} />} title="Nothing here" description="Sequences start from workflows such as the no-answer callback or post-visit feedback." />}
        {list.map((f) => {
          const lead = leads.get(f.leadId);
          const next = f.steps.find((s) => s.status === 'scheduled');
          return (
            <div key={f.id} className="list-row" style={{ alignItems: 'flex-start', padding: '16px 18px' }}>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row wrap" style={{ gap: 8 }}>
                  <button className="link" style={{ fontWeight: 600 }} onClick={() => lead && navigate('leads', { id: lead.id })}>{lead?.name ?? 'Lead'}</button>
                  <span className="faint">·</span>
                  <span>{f.name}</span>
                  <Badge tone={TONE[f.status]}>{f.status}</Badge>
                  {lead && <MemberChip id={lead.assignedTo} showName={false} />}
                </div>
                <div className="row wrap mt-12" style={{ gap: 6 }}>
                  {f.steps.map((s, i) => (
                    <span key={i} className="tag" style={{ gap: 6, opacity: s.status === 'cancelled' ? 0.5 : 1, textDecoration: s.status === 'cancelled' ? 'line-through' : undefined, borderColor: s === next ? 'var(--ember)' : undefined }} title={fmtDateTime(s.at)}>
                      {s.status === 'done' ? <CheckCircle2 size={12} style={{ color: 'var(--success)' }} /> : s.status === 'cancelled' ? <CircleSlash size={12} /> : <Clock3 size={12} />}
                      {s.channel !== 'task' && CHANNEL_ICON[s.channel]}
                      {s.label}
                    </span>
                  ))}
                </div>
                <div className="faint mt-8" style={{ fontSize: 12 }}>
                  {f.stopReason ? `Stopped: ${f.stopReason}` : next ? `Next: ${next.label} ${relTime(next.at)}` : 'All steps done'} · started {relTime(f.createdAt)}
                </div>
              </div>
              {canEdit && (f.status === 'active' || f.status === 'paused') && (
                <div className="row" style={{ gap: 6 }}>
                  {f.status === 'active' ? (
                    <Button size="sm" icon={<Pause size={13} />} onClick={() => { setStatus(f.id, 'paused'); toast({ kind: 'info', title: 'Sequence paused' }); }}>Pause</Button>
                  ) : (
                    <Button size="sm" icon={<Play size={13} />} onClick={() => { setStatus(f.id, 'active'); toast({ kind: 'success', title: 'Sequence resumed', body: 'Next step re-checks consent before sending.' }); }}>Resume</Button>
                  )}
                  <Button size="sm" variant="danger" icon={<Square size={12} />} onClick={async () => {
                    const r = await confirm({ title: 'Stop this sequence?', body: 'Scheduled steps are cancelled. This cannot be resumed — start a new sequence if needed.', reasons: ['Lead replied', 'Handled manually', 'Not relevant anymore', 'Other'], confirmLabel: 'Stop sequence', danger: true });
                    if (r.ok) { setStatus(f.id, 'stopped', r.value); toast({ kind: 'info', title: 'Sequence stopped' }); }
                  }}>Stop</Button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
