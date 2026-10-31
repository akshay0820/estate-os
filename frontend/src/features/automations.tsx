// Automations: schedules that prepare work on their own (briefings, follow-up tasks, message drafts, a queue of AI calls),
// and the AI call queue where a person approves each call. Live data comes from migration 0029; demo mode uses
// lib/automationsDemo. Calls and messages never go out without a person's approval.
import { useState } from 'react';
import { BellRing, CalendarClock, Check, ListChecks, Pencil, PhoneCall, Play, Plus, RotateCcw, ShieldCheck, Trash2, X, type LucideIcon } from 'lucide-react';
import { Badge, Button, Card, Empty, Field, Input, Modal, PageHeader, Select, Switch } from '@/components/ui';
import { confirm } from '@/components/dialogs';
import * as live from '@/backend/live';
import type { AutomationRow, CallQueueRow } from '@/backend/live';
import { LIVE } from '@/store/store';
import { toast } from '@/store/ui';
import { useCan } from '@/store/hooks';
import { useServerQuery } from '@/data/useServerQuery';
import { attempt, ok } from '@/data/actions';
import { relTime } from '@/lib/format';
import { cx } from '@/lib/util';
import { AUTOMATION_LABEL, daysLabel } from '@/lib/assistant';
import { useDemoAutomations } from '@/lib/automationsDemo';

type Kind = AutomationRow['kind'];
const KIND_ICON: Record<Kind, LucideIcon> = { daily_briefing: BellRing, overdue_follow_ups: ListChecks, call_new_leads: PhoneCall, reengage_stale: RotateCcw };
const KIND_HELP: Record<Kind, string> = {
  daily_briefing: 'Sends a summary notification: new and hot leads, overdue follow-ups, tasks, today’s showings and calls waiting.',
  overdue_follow_ups: 'Creates a follow-up task for each lead whose follow-up is overdue. Can also draft a message for approval.',
  call_new_leads: 'Queues an AI call for each new, uncontacted lead that gave AI-call consent. Nothing is dialed until someone approves.',
  reengage_stale: 'Drafts a re-engagement message for open leads nobody has contacted in a while. Drafts wait for approval.',
};
const DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function resultText(r: Record<string, unknown> | null): string | null {
  if (!r) return null;
  if (r.error) return `Failed: ${String(r.error)}`;
  switch (r.kind) {
    case 'daily_briefing': return `Briefed ${r.notified} ${r.notified === 1 ? 'person' : 'people'}: ${r.summary}`;
    case 'overdue_follow_ups': return `${r.tasks_created} follow-up tasks created${r.drafts_requested ? `, ${r.drafts_requested} message drafts for approval` : ''}`;
    case 'call_new_leads': return `${r.queued} calls queued for approval${r.skipped_no_consent ? `, ${r.skipped_no_consent} skipped (no AI-call consent)` : ''}`;
    case 'reengage_stale': return `${r.drafts_requested} re-engagement drafts for approval`;
    default: return null;
  }
}

export function AutomationsPage() {
  const canManage = useCan('workflows.manage');
  const canCall = useCan('calls.place');
  const demo = useDemoAutomations();
  const q = useServerQuery(LIVE, () => Promise.all([live.automations(), live.callQueue()]), []);
  const automations = LIVE ? q.data?.[0] ?? [] : demo.automations;
  const queue = LIVE ? q.data?.[1] ?? [] : demo.queue;
  const pending = queue.filter((x) => x.status === 'pending');
  const [edit, setEdit] = useState<AutomationRow | 'new' | null>(null);

  const save = async (input: Parameters<typeof live.automationSave>[0]) => {
    const r = LIVE ? await attempt(() => live.automationSave(input)) : demo.save(input);
    if (r) {
      toast({ kind: 'success', title: input.id ? 'Automation updated' : 'Automation scheduled', body: `${daysLabel(input.days)} at ${input.run_at}` });
      setEdit(null);
      q.reload();
    }
  };
  const toggle = (a: AutomationRow) => void save({ id: a.id, name: a.name, kind: a.kind, enabled: !a.enabled, run_at: a.run_at.slice(0, 5), days: a.days, settings: a.settings });
  const runNow = async (a: AutomationRow) => {
    const r = LIVE ? await attempt(() => live.automationRunNow(a.id)) : demo.runNow(a.id);
    if (r) toast({ kind: 'success', title: `${a.name} ran`, body: resultText(r) ?? undefined });
    q.reload();
  };
  const remove = async (a: AutomationRow) => {
    const c = await confirm({ title: `Delete “${a.name}”?`, body: 'It stops running. Work it already prepared stays.', confirmLabel: 'Delete', danger: true });
    if (!c.ok) return;
    if (LIVE ? await ok(() => live.automationDelete(a.id)) : (demo.remove(a.id), true)) toast({ kind: 'success', title: 'Automation deleted' });
    q.reload();
  };
  const decide = async (item: CallQueueRow, decision: 'approved' | 'declined') => {
    const r = LIVE ? await attempt(() => live.callQueueDecide(item, decision)) : demo.decide(item, decision);
    if (!r) return;
    if (r.ok) toast({ kind: 'success', title: decision === 'approved' ? 'AI call placed' : 'Call declined', body: decision === 'approved' ? 'Follow it on the Calls page.' : undefined });
    else toast({ kind: 'warning', title: 'Not called', body: r.reason });
    q.reload();
  };
  const approveAll = async () => {
    for (const item of pending) await decide(item, 'approved');
  };

  return (
    <div className="page">
      <PageHeader
        eyebrow={`[ ${automations.filter((a) => a.enabled).length} ACTIVE · ${pending.length} CALLS WAITING ]`}
        title="Automations"
        sub="Schedules that prepare work for your team on their own. Calls and messages always wait for a person’s approval."
        actions={canManage && <Button variant="primary" icon={<Plus size={15} />} onClick={() => setEdit('new')}>New automation</Button>}
      />

      <Card
        title="AI call queue"
        sub={pending.length ? `${pending.length} waiting · consent, calling hours and limits are checked again when you approve` : 'Calls queued by automations appear here for approval'}
        icon={<PhoneCall size={14} />}
        actions={pending.length > 1 && canCall ? <Button size="sm" variant="accent" icon={<Check size={14} />} onClick={() => void approveAll()}>Approve all</Button> : undefined}
        flush
      >
        {queue.length === 0 ? (
          <Empty icon={<ShieldCheck size={18} />} title="No calls waiting" description="The “Call new leads” automation queues new leads that gave AI-call consent." />
        ) : (
          queue.slice(0, 12).map((item) => (
            <div key={item.id} className="list-row">
              <span className="icon-chip"><PhoneCall size={14} /></span>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="truncate" style={{ fontWeight: 500, fontSize: 13.5 }}>{item.lead?.contact?.display_name ?? item.lead?.title ?? 'Lead'}</div>
                <div className="faint truncate" style={{ fontSize: 12 }}>{item.reason} · queued {relTime(Date.parse(item.created_at))}</div>
              </div>
              {item.status === 'pending' ? (
                canCall ? (
                  <div className="row" style={{ gap: 6 }}>
                    <Button size="sm" variant="ghost" icon={<X size={14} />} onClick={() => void decide(item, 'declined')}>Decline</Button>
                    <Button size="sm" variant="accent" icon={<PhoneCall size={14} />} onClick={() => void decide(item, 'approved')}>Approve call</Button>
                  </div>
                ) : <Badge tone="warning">Waiting</Badge>
              ) : <Badge tone={item.status === 'approved' ? 'success' : 'neutral'}>{item.status === 'approved' ? 'Called' : item.status}</Badge>}
            </div>
          ))
        )}
      </Card>

      {automations.length === 0 && !q.loading ? (
        <div className="card mt-16">
          <Empty icon={<CalendarClock size={18} />} title="No automations yet" description="Schedule a morning briefing, an overdue follow-up sweep or a call queue for new leads." action={canManage ? <Button variant="primary" icon={<Plus size={15} />} onClick={() => setEdit('new')}>New automation</Button> : undefined} />
        </div>
      ) : (
        <div className="grid g-3 mt-16">
          {automations.map((a) => {
            const Icon = KIND_ICON[a.kind];
            const res = resultText(a.last_result);
            return (
              <section key={a.id} className={cx('card card-fill', !a.enabled && 'is-off')}>
                <header className="card-head">
                  <span className="icon-chip"><Icon size={14} /></span>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <h3 className="card-title truncate">{a.name}</h3>
                    <div className="card-sub">{AUTOMATION_LABEL[a.kind]}</div>
                  </div>
                  {canManage && <Switch on={a.enabled} onChange={() => toggle(a)} label={a.enabled ? 'Pause automation' : 'Resume automation'} />}
                </header>
                <div className="card-body">
                  <div className="kpi-value" style={{ fontSize: 22, marginTop: 0 }}>{a.run_at.slice(0, 5)}</div>
                  <div className="faint" style={{ fontSize: 12.5 }}>{daysLabel(a.days)} · {a.enabled && a.next_run_at ? `next ${relTime(Date.parse(a.next_run_at))}` : 'paused'}</div>
                  <p className="muted mt-12" style={{ fontSize: 12.5 }}>{KIND_HELP[a.kind]}</p>
                  {res && <div className="tl-body mt-12" style={{ fontSize: 12.5 }}><b>Last run {a.last_run_at ? relTime(Date.parse(a.last_run_at)) : ''}:</b> {res}</div>}
                  {canManage && (
                    <div className="row push-end" style={{ gap: 6, paddingTop: 14 }}>
                      <Button size="sm" icon={<Play size={13} />} onClick={() => void runNow(a)}>Run now</Button>
                      <Button size="sm" variant="ghost" icon={<Pencil size={13} />} onClick={() => setEdit(a)}>Edit</Button>
                      <Button size="sm" variant="ghost" iconOnly icon={<Trash2 size={13} />} aria-label={`Delete ${a.name}`} onClick={() => void remove(a)} />
                    </div>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {edit && <Editor initial={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSave={save} />}
    </div>
  );
}

function Editor({ initial, onClose, onSave }: { initial: AutomationRow | null; onClose: () => void; onSave: (input: Parameters<typeof live.automationSave>[0]) => Promise<void> }) {
  const [name, setName] = useState(initial?.name ?? 'Morning briefing');
  const [kind, setKind] = useState<Kind>(initial?.kind ?? 'daily_briefing');
  const [runAt, setRunAt] = useState(initial?.run_at.slice(0, 5) ?? '08:30');
  const [days, setDays] = useState<number[]>(initial?.days ?? [1, 2, 3, 4, 5]);
  const [settings, setSettings] = useState<Record<string, unknown>>(initial?.settings ?? {});
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: unknown) => setSettings((s) => ({ ...s, [k]: v }));
  const num = (k: string, d: number) => (settings[k] as number | undefined) ?? d;
  const valid = name.trim() && /^\d{2}:\d{2}$/.test(runAt) && days.length;

  return (
    <Modal
      open
      onClose={onClose}
      title={initial ? 'Edit automation' : 'New automation'}
      description="Runs on its own at the time you pick, in the agency’s time zone. It prepares work; calls and messages wait for approval."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!valid} onClick={async () => { setBusy(true); await onSave({ id: initial?.id, name: name.trim(), kind, run_at: runAt, days, settings, enabled: initial?.enabled ?? true }); setBusy(false); }}>{initial ? 'Save' : 'Schedule'}</Button></>}
    >
      <div className="stack">
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} data-autofocus /></Field>
        <Field label="What it does" hint={KIND_HELP[kind]}>
          <Select value={kind} onChange={(e) => { setKind(e.target.value as Kind); setSettings({}); }}>
            {(Object.keys(AUTOMATION_LABEL) as Kind[]).map((k) => <option key={k} value={k}>{AUTOMATION_LABEL[k]}</option>)}
          </Select>
        </Field>
        <div className="row" style={{ gap: 12, alignItems: 'flex-end' }}>
          <Field label="Time"><Input type="time" value={runAt} onChange={(e) => setRunAt(e.target.value)} style={{ width: 130 }} /></Field>
          <Field label="Days">
            <div className="row" style={{ gap: 4 }}>
              {DAYS.map((d, i) => (
                <button key={i} type="button" title={DAY_FULL[i]} aria-pressed={days.includes(i)} className={cx('day-chip', days.includes(i) && 'on')}
                  onClick={() => setDays((ds) => (ds.includes(i) ? ds.filter((x) => x !== i) : [...ds, i].sort()))}>{d}</button>
              ))}
            </div>
          </Field>
        </div>
        {kind === 'daily_briefing' && (
          <Field label="Who gets it">
            <Select value={String(settings.audience ?? 'managers')} onChange={(e) => set('audience', e.target.value)}>
              <option value="managers">Owners, admins and managers</option>
              <option value="everyone">Everyone on the team</option>
            </Select>
          </Field>
        )}
        {kind === 'overdue_follow_ups' && (
          <label className="row" style={{ gap: 10, fontSize: 13 }}>
            <Switch on={settings.draft_messages === true} onChange={(v) => set('draft_messages', v)} label="Also draft follow-up messages" />
            Also draft a follow-up message for each lead (waits in Approvals)
          </label>
        )}
        {kind === 'call_new_leads' && (
          <div className="row" style={{ gap: 12 }}>
            <Field label="Leads from the last (hours)"><Input type="number" min={1} max={168} value={num('within_hours', 24)} onChange={(e) => set('within_hours', Number(e.target.value))} /></Field>
            <Field label="Most calls per run"><Input type="number" min={1} max={50} value={num('max', 20)} onChange={(e) => set('max', Number(e.target.value))} /></Field>
          </div>
        )}
        {kind === 'reengage_stale' && (
          <div className="row" style={{ gap: 12 }}>
            <Field label="Untouched for (days)"><Input type="number" min={7} max={180} value={num('stale_days', 14)} onChange={(e) => set('stale_days', Number(e.target.value))} /></Field>
            <Field label="Most drafts per run"><Input type="number" min={1} max={50} value={num('max', 15)} onChange={(e) => set('max', Number(e.target.value))} /></Field>
          </div>
        )}
      </div>
    </Modal>
  );
}
