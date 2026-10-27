import { useEffect, useMemo, useState } from 'react';
import { Bot, CheckSquare, Plus, Trash2, Workflow as WorkflowIcon, Pencil } from 'lucide-react';
import { Badge, Button, Checkbox, Empty, Field, Input, Menu, Modal, PageHeader, SearchInput, Segmented, Select } from '@/components/ui';
import { actions, ok } from '@/data/actions';
import { useCan, useLookup, useMe, useOrgList } from '@/store/hooks';
import { toast } from '@/store/ui';
import { navigate, setParam } from '@/lib/router';
import { DAY, fmtDate, fmtTime, fromLocalInput, relTime, startOfDay, toLocalInput } from '@/lib/format';
import { PRIORITY_TONE } from '@/lib/domain';
import type { Task } from '@/store/types';
import { MemberChip } from './shared';

export function TasksPage({ params }: { params: URLSearchParams }) {
  const tasks = useOrgList('tasks');
  const me = useMe();
  const canEdit = useCan('tasks.edit');
  const leads = useLookup('leads');
  const setTaskStatus = (id: string, status: Task['status']) => ok(() => actions.setTaskStatus(id, status));
  const [scope, setScope] = useState<'mine' | 'team'>('mine');
  const [q, setQ] = useState('');
  const [showDone, setShowDone] = useState(false);
  const [editing, setEditing] = useState<Task | 'new' | null>(params.get('new') === '1' ? 'new' : null);

  useEffect(() => {
    if (params.get('new') === '1') setEditing('new');
  }, [params]);

  const now = Date.now();
  const today = startOfDay(now);
  const visible = useMemo(
    () =>
      tasks.filter((t) => (scope === 'team' || t.assignedTo === me.id) && (showDone || !['completed', 'cancelled'].includes(t.status)) && (!q || t.title.toLowerCase().includes(q.toLowerCase()))),
    [tasks, scope, me.id, showDone, q],
  );
  const groups: { key: string; label: string; items: Task[]; tone?: string }[] = [
    { key: 'overdue', label: 'Overdue', tone: 'danger', items: visible.filter((t) => t.dueAt < now && t.status !== 'completed' && t.status !== 'cancelled') },
    { key: 'today', label: 'Today', items: visible.filter((t) => t.dueAt >= now && t.dueAt < today + DAY && t.status !== 'completed') },
    { key: 'upcoming', label: 'Upcoming', items: visible.filter((t) => t.dueAt >= today + DAY && t.status !== 'completed') },
    { key: 'done', label: 'Completed', items: visible.filter((t) => t.status === 'completed') },
  ].map((g) => ({ ...g, items: g.items.sort((a, b) => a.dueAt - b.dueAt) }));

  const toggle = (t: Task) => {
    const next = t.status === 'completed' ? 'open' : 'completed';
    void setTaskStatus(t.id, next).then((done) => {
      if (done && next === 'completed') toast({ kind: 'success', title: 'Task completed', body: t.title, action: { label: 'Undo', run: () => void setTaskStatus(t.id, t.status) } });
    });
  };

  return (
    <div className="page">
      <PageHeader
        eyebrow={`[ ${groups[0].items.length} overdue · ${groups[1].items.length} due today ]`}
        title="Tasks"
        sub="Your daily list — created by you, by workflows, and by AI agents when a person needs to step in."
        actions={
          <>
            <Segmented value={scope} onChange={setScope} options={[{ value: 'mine', label: 'Mine' }, { value: 'team', label: 'Whole team' }]} />
            {canEdit && <Button variant="primary" icon={<Plus size={15} />} onClick={() => setEditing('new')}>New task</Button>}
          </>
        }
      />
      <div className="card">
        <div className="toolbar">
          <SearchInput value={q} onChange={setQ} placeholder="Search tasks" />
          <label className="check ml-auto" style={{ fontSize: 13 }}>
            <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> Show completed
          </label>
        </div>
        {visible.length === 0 && <Empty icon={<CheckSquare size={20} />} title="Nothing on your plate" description="Tasks from workflows and AI hand-offs will show up here." />}
        {groups.filter((g) => g.items.length).map((g) => (
          <div key={g.key}>
            <div className="menu-label row" style={{ padding: '14px 18px 6px', color: g.tone === 'danger' ? 'var(--danger)' : undefined }}>
              {g.label} <span className="mono">{g.items.length}</span>
            </div>
            {g.items.map((t) => {
              const lead = t.related?.type === 'lead' ? leads.get(t.related.id) : undefined;
              return (
                <div key={t.id} className="list-row" style={{ opacity: t.status === 'completed' ? 0.55 : 1 }}>
                  <Checkbox checked={t.status === 'completed'} onChange={() => toggle(t)} disabled={!canEdit} aria={`Complete ${t.title}`} />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 500, textDecoration: t.status === 'completed' ? 'line-through' : undefined }} className="truncate">{t.title}</div>
                    <div className="faint row" style={{ fontSize: 12, gap: 6 }}>
                      {lead && <button className="link" style={{ fontSize: 12 }} onClick={() => navigate('leads', { id: lead.id })}>{lead.name}</button>}
                      {t.source !== 'manual' && <span className="row" style={{ gap: 3 }}>{t.source === 'ai' ? <Bot size={11} /> : <WorkflowIcon size={11} />} {t.source === 'ai' ? 'AI hand-off' : 'Workflow'}</span>}
                    </div>
                  </div>
                  {t.priority !== 'normal' && <Badge tone={PRIORITY_TONE[t.priority]}>{t.priority}</Badge>}
                  {t.status === 'in_progress' && <Badge tone="info">In progress</Badge>}
                  <span className="mono num" style={{ fontSize: 12, width: 92, textAlign: 'right', color: t.dueAt < now && t.status !== 'completed' ? 'var(--danger)' : 'var(--text-3)' }} title={`${fmtDate(t.dueAt)} ${fmtTime(t.dueAt)}`}>
                    {t.dueAt < today + DAY && t.dueAt >= today ? fmtTime(t.dueAt) : relTime(t.dueAt)}
                  </span>
                  {scope === 'team' && <MemberChip id={t.assignedTo} showName={false} />}
                  {canEdit && (
                    <Menu
                      trigger={(p) => <Button size="xs" variant="ghost" iconOnly icon={<Pencil size={13} />} aria-label="Task actions" {...p} />}
                      items={[
                        { label: 'Edit', onSelect: () => setEditing(t) },
                        { label: t.status === 'in_progress' ? 'Mark open' : 'Start', onSelect: () => void setTaskStatus(t.id, t.status === 'in_progress' ? 'open' : 'in_progress') },
                        { label: 'Snooze 1 day', onSelect: async () => { if (await ok(() => actions.saveTask({ ...t, dueAt: Math.max(now, t.dueAt) + DAY }))) toast({ kind: 'info', title: 'Snoozed to tomorrow' }); } },
                        'sep',
                        { label: 'Cancel task', icon: <Trash2 size={14} />, danger: true, onSelect: async () => { if (await setTaskStatus(t.id, 'cancelled')) toast({ kind: 'info', title: 'Task cancelled', action: { label: 'Undo', run: () => void setTaskStatus(t.id, t.status) } }); } },
                      ]}
                    />
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {editing && <TaskModal task={editing === 'new' ? undefined : editing} onClose={() => { setEditing(null); if (params.get('new')) setParam('new', null); }} />}
    </div>
  );
}

export function TaskModal({ task, onClose, preset }: { task?: Task; onClose: () => void; preset?: Partial<Task> }) {
  const members = useOrgList('members');
  const leads = useOrgList('leads');
  const me = useMe();
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({
    title: task?.title ?? '',
    dueAt: toLocalInput(task?.dueAt ?? Date.now() + 3 * 3600_000),
    priority: task?.priority ?? preset?.priority ?? 'normal',
    assignedTo: task?.assignedTo ?? preset?.assignedTo ?? me.id,
    leadId: task?.related?.type === 'lead' ? task.related.id : preset?.related?.type === 'lead' ? preset.related.id : '',
  });
  const [err, setErr] = useState('');
  const submit = async () => {
    if (!f.title.trim()) return setErr('Give the task a title');
    const due = fromLocalInput(f.dueAt);
    if (!Number.isFinite(due)) return setErr('Pick a due date');
    setBusy(true);
    const done = await ok(() => actions.saveTask({ ...(task ?? {}), title: f.title.trim(), dueAt: due, priority: f.priority as Task['priority'], assignedTo: f.assignedTo || null, related: f.leadId ? { type: 'lead', id: f.leadId } : null }), setErr);
    setBusy(false);
    if (!done) return;
    toast({ kind: 'success', title: task ? 'Task updated' : 'Task created' });
    onClose();
  };
  return (
    <Modal open onClose={onClose} title={task ? 'Edit task' : 'New task'} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => void submit()}>{task ? 'Save' : 'Create task'}</Button></>}>
      <div className="form-grid">
        <Field label="Title" className="full" error={err || null}><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. Send floor plans to Riya" data-autofocus invalid={!!err && !f.title} /></Field>
        <Field label="Due"><Input type="datetime-local" value={f.dueAt} onChange={(e) => setF({ ...f, dueAt: e.target.value })} /></Field>
        <Field label="Priority">
          <Select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value as Task['priority'] })}>
            {['low', 'normal', 'high', 'urgent'].map((p) => <option key={p}>{p}</option>)}
          </Select>
        </Field>
        <Field label="Assignee">
          <Select value={f.assignedTo ?? ''} onChange={(e) => setF({ ...f, assignedTo: e.target.value })}>
            {members.filter((m) => m.status === 'active').map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Select>
        </Field>
        <Field label="Related lead">
          <Select value={f.leadId} onChange={(e) => setF({ ...f, leadId: e.target.value })}>
            <option value="">None</option>
            {leads.filter((l) => !l.archived && (!['won', 'lost'].includes(l.status) || l.id === f.leadId)).slice(0, 250).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </Select>
        </Field>
      </div>
    </Modal>
  );
}
