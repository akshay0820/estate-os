import { useMemo, useState } from 'react';
import { Activity as ActivityIcon, Bot, Pencil, Building2, CalendarPlus, CheckSquare, CircleDot, Handshake, MessageCircle, PhoneCall, Plug, Plus, ShieldOff, Sparkles, StickyNote, UserPlus, Workflow } from 'lucide-react';
import { Button, Empty, PageHeader, SearchInput, Segmented } from '@/components/ui';
import { useLookup, useOrgList } from '@/store/hooks';
import { navigate } from '@/lib/router';
import { fmtTime, sameDay } from '@/lib/format';
import { cx } from '@/lib/util';
import type { Activity, ActorType } from '@/store/types';

const ICON: Record<Activity['kind'], React.ReactNode> = {
  created: <Plus size={13} />, status: <CircleDot size={13} />, assigned: <UserPlus size={13} />, call: <PhoneCall size={13} />,
  message: <MessageCircle size={13} />, note: <StickyNote size={13} />, appointment: <CalendarPlus size={13} />, property_sent: <Building2 size={13} />,
  ai_update: <Sparkles size={13} />, opt_out: <ShieldOff size={13} />, deal: <Handshake size={13} />, task: <CheckSquare size={13} />, workflow: <Workflow size={13} />, updated: <Pencil size={13} />,
};

export function ActivityPage() {
  const activities = useOrgList('activities');
  const leads = useLookup('leads');
  const [actor, setActor] = useState<'all' | ActorType>('all');
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(60);
  const list = useMemo(() => {
    const t = q.toLowerCase();
    return [...activities]
      .sort((a, b) => b.at - a.at)
      .filter((a) => (actor === 'all' || a.actor.type === actor) && (!t || a.title.toLowerCase().includes(t) || (a.leadId && leads.get(a.leadId)?.name.toLowerCase().includes(t))));
  }, [activities, actor, q, leads]);
  const shown = list.slice(0, limit);
  let lastDay = 0;
  return (
    <div className="page" style={{ maxWidth: 920 }}>
      <PageHeader eyebrow="[ Overview ]" title="Activity feed" sub="Everything that happened across leads, by people, AI agents, workflows and integrations — newest first." />
      <div className="card">
        <div className="toolbar">
          <SearchInput value={q} onChange={setQ} placeholder="Search activity or lead" width={260} />
          <div className="ml-auto">
            <Segmented value={actor} onChange={setActor} options={[{ value: 'all', label: 'All' }, { value: 'user', label: 'People' }, { value: 'ai_agent', label: <><Bot size={13} /> AI</> }, { value: 'system', label: 'System' }, { value: 'integration', label: <><Plug size={13} /> Integrations</> }]} />
          </div>
        </div>
        <div style={{ padding: '8px 20px 20px' }}>
          {shown.length === 0 && <Empty icon={<ActivityIcon size={20} />} title="No activity" />}
          <div className="timeline">
            {shown.map((a) => {
              const day = !sameDay(a.at, lastDay);
              lastDay = a.at;
              const lead = a.leadId ? leads.get(a.leadId) : undefined;
              return (
                <div key={a.id}>
                  {day && <div className="menu-label" style={{ padding: '16px 0 10px' }}>{sameDay(a.at, Date.now()) ? 'Today' : new Date(a.at).toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long' })}</div>}
                  <div className="tl-item">
                    <span className={cx('tl-icon', a.actor.type === 'ai_agent' && 'ai')}>{ICON[a.kind]}</span>
                    <div style={{ minWidth: 0 }}>
                      <div className="tl-title row wrap" style={{ gap: 6 }}>
                        {a.title}
                        {lead && <button className="link" style={{ fontWeight: 500 }} onClick={() => navigate('leads', { id: lead.id })}>{lead.name}</button>}
                      </div>
                      <div className="tl-meta">{a.actor.name} · {fmtTime(a.at)}</div>
                      {a.body && <div className="tl-body">{a.body}</div>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {list.length > limit && <div className="row" style={{ justifyContent: 'center' }}><Button onClick={() => setLimit((l) => l + 60)}>Load more ({list.length - limit} remaining)</Button></div>}
        </div>
      </div>
    </div>
  );
}
