import type { ReactNode } from 'react';
import { Mail, MessageCircle, MessageSquare, Phone, Check, X, ArrowUp, ArrowDown, ArrowUpDown, Lock } from 'lucide-react';
import { Avatar, Badge, Empty } from '@/components/ui';
import { useMemberMap } from '@/store/hooks';
import type { Tone } from '@/lib/domain';
import { LEAD_STATUS } from '@/lib/domain';
import type { Channel, LeadStatus } from '@/store/types';
import type { PolicyResult } from '@/lib/domain';

export function StatusBadge<T extends string>({ map, value }: { map: Record<T, { label: string; tone: Tone }>; value: T }) {
  const m = map[value] ?? { label: value, tone: 'neutral' as Tone };
  return (
    <Badge tone={m.tone} dot={m.tone !== 'solid'}>
      {m.label}
    </Badge>
  );
}

export function LeadStatusBadge({ status }: { status: LeadStatus }) {
  return <StatusBadge map={LEAD_STATUS} value={status} />;
}

export function MemberChip({ id, size = 'sm', showName = true, fallback = 'Unassigned' }: { id: string | null | undefined; size?: 'sm' | 'md'; showName?: boolean; fallback?: string }) {
  const members = useMemberMap();
  const m = id ? members.get(id) : undefined;
  if (!m) return <span className="faint">{fallback}</span>;
  return (
    <span className="row" style={{ gap: 7, minWidth: 0 }}>
      <Avatar name={m.name} hue={m.hue} size={size} />
      {showName && <span className="truncate">{m.name}</span>}
    </span>
  );
}

export const CHANNEL_ICON: Record<Channel, ReactNode> = {
  phone: <Phone size={13} />,
  whatsapp: <MessageCircle size={13} />,
  sms: <MessageSquare size={13} />,
  email: <Mail size={13} />,
};

export function ChannelTag({ channel }: { channel: Channel }) {
  const label = { phone: 'Phone', whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email' }[channel];
  return (
    <span className="tag" style={{ gap: 5 }}>
      {CHANNEL_ICON[channel]} {label}
    </span>
  );
}

export function PolicyChecks({ result }: { result: PolicyResult }) {
  return (
    <div className="steps">
      {result.checks.map((c, i) => (
        <div key={i} className="step">
          <span className={`step-dot ${c.ok ? 'ok' : 'fail'}`}>{c.ok ? <Check size={12} /> : <X size={12} />}</span>
          <span>{c.label}</span>
          <span className="faint" style={{ fontSize: 12 }}>{c.detail}</span>
        </div>
      ))}
    </div>
  );
}

export function SortHeader<K extends string>({ label, k, sort, onSort, align }: { label: string; k: K; sort: { key: K; dir: 1 | -1 }; onSort: (k: K) => void; align?: 'right' }) {
  const active = sort.key === k;
  return (
    <th className={`sortable ${align === 'right' ? 'right' : ''}`} onClick={() => onSort(k)} aria-sort={active ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <span className="th-inner">
        {label}
        {active ? sort.dir === 1 ? <ArrowUp size={12} /> : <ArrowDown size={12} /> : <ArrowUpDown size={11} style={{ opacity: 0.4 }} />}
      </span>
    </th>
  );
}

export function NoAccess({ what = 'this area' }: { what?: string }) {
  return (
    <div className="card" style={{ marginTop: 40 }}>
      <Empty icon={<Lock size={20} />} title="You don't have access" description={`Your role doesn't include permission to view ${what}. Ask an owner or admin if you need it.`} />
    </div>
  );
}

export function scoreTone(score: number): Tone {
  return score >= 75 ? 'accent' : score >= 50 ? 'warning' : 'neutral';
}

export function ScorePill({ score, reasons }: { score: number; reasons?: string[] }) {
  return (
    <span
      className="mono num"
      title={reasons?.length ? `Score ${score}\n• ${reasons.join('\n• ')}` : `Score ${score}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 12,
        color: score >= 75 ? 'var(--accent-text)' : score >= 50 ? 'var(--text)' : 'var(--text-3)',
      }}
    >
      <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden>
        <circle cx="10" cy="10" r="8" fill="none" stroke="var(--fill-strong)" strokeWidth="3" />
        <circle cx="10" cy="10" r="8" fill="none" stroke={score >= 75 ? 'var(--ember)' : score >= 50 ? 'var(--text-2)' : 'var(--text-3)'} strokeWidth="3" strokeDasharray={`${(score / 100) * 50.3} 60`} strokeLinecap="round" transform="rotate(-90 10 10)" />
      </svg>
      {score}
    </span>
  );
}
