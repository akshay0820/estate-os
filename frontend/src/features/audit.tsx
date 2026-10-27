import { useEffect, useMemo, useState } from 'react';
import { Bot, Download, Plug, Server, ShieldCheck, UserRound } from 'lucide-react';
import { Badge, Button, Empty, PageHeader, Pager, SearchInput, Select } from '@/components/ui';
import { useOrgList } from '@/store/hooks';
import { toast } from '@/store/ui';
import { useStore } from '@/store/store';
import { LIVE, attempt } from '@/data/actions';
import * as live from '@/backend/live';
import { fmtDateTime } from '@/lib/format';
import { downloadCsv } from '@/lib/util';
import type { ActorType } from '@/store/types';

const ACTOR_ICON: Record<ActorType, React.ReactNode> = { user: <UserRound size={13} />, ai_agent: <Bot size={13} />, workflow: <Server size={13} />, system: <Server size={13} />, integration: <Plug size={13} /> };

export function AuditPage() {
  const logs = useOrgList('audit');
  const [q, setQ] = useState('');
  const [actor, setActor] = useState('');
  const [entity, setEntity] = useState('');
  const [page, setPage] = useState(0);
  const entities = useMemo(() => [...new Set(logs.map((l) => l.entity))].sort(), [logs]);
  const filtered = useMemo(() => {
    const t = q.toLowerCase();
    return logs.filter((l) => (!actor || l.actor.type === actor) && (!entity || l.entity === entity) && (!t || l.action.includes(t) || l.actor.name.toLowerCase().includes(t) || (l.meta ?? '').toLowerCase().includes(t)));
  }, [logs, q, actor, entity]);
  useEffect(() => setPage(0), [q, actor, entity]);
  const rows = filtered.slice(page * 40, page * 40 + 40);

  return (
    <div className="page">
      <PageHeader
        eyebrow="[ Append-only ]"
        title="Audit logs"
        sub="High-impact actions by people, AI agents, workflows and integrations. Entries can't be edited or deleted, and never contain secrets or message bodies."
        actions={<Button icon={<Download size={15} />} onClick={() => {
          downloadCsv('audit-log.csv', [['Time (UTC)', 'Actor type', 'Actor', 'Action', 'Entity', 'Details'], ...filtered.map((l) => [new Date(l.at).toISOString(), l.actor.type, l.actor.name, l.action, l.entity, l.meta])]);
          if (LIVE) void attempt(() => live.recordExport('audit_logs', filtered.length));
          else useStore.getState().log('audit.exported', 'audit', null, `${filtered.length} rows`);
          toast({ kind: 'success', title: 'Audit log exported', body: 'The export itself was recorded.' });
        }}>Export</Button>}
      />
      <div className="card">
        <div className="toolbar">
          <SearchInput value={q} onChange={setQ} placeholder="Action, actor or detail" width={260} />
          <Select selectSize="sm" value={actor} onChange={(e) => setActor(e.target.value)} style={{ width: 150 }} aria-label="Actor type">
            <option value="">All actors</option>
            <option value="user">People</option>
            <option value="ai_agent">AI agents</option>
            <option value="system">System</option>
            <option value="integration">Integrations</option>
          </Select>
          <Select selectSize="sm" value={entity} onChange={(e) => setEntity(e.target.value)} style={{ width: 160 }} aria-label="Entity">
            <option value="">All entities</option>
            {entities.map((e) => <option key={e}>{e}</option>)}
          </Select>
          <span className="ml-auto faint row" style={{ fontSize: 12, gap: 5 }}><ShieldCheck size={13} /> Retained 2 years</span>
        </div>
        {rows.length === 0 ? <Empty icon={<ShieldCheck size={20} />} title="No entries" /> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Details</th></tr></thead>
              <tbody>
                {rows.map((l) => (
                  <tr key={l.id}>
                    <td className="mono faint" style={{ fontSize: 12 }}>{fmtDateTime(l.at)}</td>
                    <td><span className="row" style={{ gap: 6 }}><span className={l.actor.type === 'ai_agent' ? 'icon-chip accent' : 'icon-chip'} style={{ width: 22, height: 22 }}>{ACTOR_ICON[l.actor.type]}</span>{l.actor.name}</span></td>
                    <td className="mono" style={{ fontSize: 12 }}>{l.action}</td>
                    <td><Badge>{l.entity}</Badge></td>
                    <td className="faint truncate" style={{ maxWidth: 360 }}>{l.meta ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager page={page} pageSize={40} total={filtered.length} onPage={setPage} />
      </div>
    </div>
  );
}
