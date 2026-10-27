import { useMemo, useState } from 'react';
import { Bot, Check, ClipboardCheck, Clock, Hourglass, UserRound, X } from 'lucide-react';
import { Badge, Button, Empty, PageHeader, Tabs } from '@/components/ui';
import { confirm } from '@/components/dialogs';
import { useStore } from '@/store/store';
import { useCan, useLookup, useOrgList } from '@/store/hooks';
import { fmtDateTime, inr, relTime } from '@/lib/format';
import type { Approval } from '@/store/types';

const RISK = { low: 'neutral', medium: 'warning', high: 'danger', critical: 'danger' } as const;

export function ApprovalsPage() {
  const approvals = useOrgList('approvals');
  const deals = useLookup('deals');
  const leads = useLookup('leads');
  const canDecide = useCan('approvals.decide');
  const decide = useStore((s) => s.decideApproval);
  const [tab, setTab] = useState<'pending' | 'history'>('pending');
  const list = useMemo(() => approvals.filter((a) => (tab === 'pending' ? a.status === 'pending' : a.status !== 'pending')).sort((a, b) => b.createdAt - a.createdAt), [approvals, tab]);

  const detail = (a: Approval) => {
    const p = a.payload;
    if (p.kind === 'send_message') return <div className="tl-body" style={{ whiteSpace: 'pre-wrap' }}>{p.body}</div>;
    if (p.kind === 'deal_stage') { const d = deals.get(p.dealId); return <div className="tl-body">{d?.title} · {inr(d?.value)} → <b>{p.to.replace(/_/g, ' ')}</b></div>; }
    if (p.kind === 'book_appointment') return <div className="tl-body">{leads.get(p.leadId)?.name} · {fmtDateTime(p.start)}</div>;
    if (p.kind === 'bulk_export' && p.rows) return <div className="tl-body">{p.rows.toLocaleString('en-IN')} rows of <b>{p.entity}</b> including contact details. Download link expires in 15 minutes.</div>;
    return null;
  };

  return (
    <div className="page" style={{ maxWidth: 980 }}>
      <PageHeader
        eyebrow={`[ ${approvals.filter((a) => a.status === 'pending').length} waiting ]`}
        title="Approvals"
        sub="Sensitive actions proposed by agents or teammates. Approval is bound to the exact payload, expires, and is re-checked at execution — it never overrides a later opt-out."
      />
      <div className="card">
        <div style={{ padding: '4px 14px 0' }}>
          <Tabs value={tab} onChange={setTab} tabs={[{ value: 'pending', label: 'Waiting', count: approvals.filter((a) => a.status === 'pending').length }, { value: 'history', label: 'History' }]} />
        </div>
        {list.length === 0 && <Empty icon={<ClipboardCheck size={20} />} title={tab === 'pending' ? 'Nothing waiting on you' : 'No decisions yet'} description="When an agent needs sign-off it appears here." />}
        {list.map((a) => (
          <div key={a.id} className="list-row" style={{ alignItems: 'flex-start', padding: '16px 18px' }}>
            <span className={a.requestedBy.type === 'ai_agent' ? 'icon-chip accent' : 'icon-chip'}>{a.requestedBy.type === 'ai_agent' ? <Bot size={14} /> : <UserRound size={14} />}</span>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="row wrap" style={{ gap: 8 }}>
                <b>{a.summary}</b>
                <Badge tone={RISK[a.risk]}>{a.risk} risk</Badge>
                <span className="mono faint" style={{ fontSize: 11 }}>{a.action}</span>
              </div>
              <div className="faint" style={{ fontSize: 12, marginTop: 2 }}>
                Requested by {a.requestedBy.name} · {relTime(a.createdAt)}
                {a.status === 'pending' && <> · <Hourglass size={11} style={{ verticalAlign: -1 }} /> expires {relTime(a.expiresAt)}</>}
              </div>
              {detail(a)}
              {a.status !== 'pending' && (
                <div className="row mt-8" style={{ gap: 8, fontSize: 12.5 }}>
                  <Badge tone={a.status === 'approved' ? 'success' : a.status === 'rejected' ? 'danger' : 'neutral'}>{a.status}</Badge>
                  <span className="faint">{a.decidedBy ? `by ${a.decidedBy} · ${relTime(a.decidedAt)}` : <><Clock size={11} /> no decision before expiry</>}</span>
                  {a.note && <span className="faint">— “{a.note}”</span>}
                </div>
              )}
            </div>
            {a.status === 'pending' && canDecide && (
              <div className="row" style={{ gap: 6 }}>
                <Button size="sm" icon={<X size={14} />} onClick={async () => {
                  const r = await confirm({ title: 'Reject this action?', input: { label: 'Reason (shared with the requester)', placeholder: 'e.g. Tone too pushy — rewrite' }, confirmLabel: 'Reject' });
                  if (r.ok) decide(a.id, false, r.value || undefined);
                }}>Reject</Button>
                <Button size="sm" variant="primary" icon={<Check size={14} />} onClick={async () => {
                  if (a.risk === 'high' || a.risk === 'critical') {
                    const r = await confirm({ title: 'Approve high-risk action?', body: 'This executes immediately after a final authorization and policy check.', confirmLabel: 'Approve & execute' });
                    if (!r.ok) return;
                  }
                  decide(a.id, true);
                }}>Approve</Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
