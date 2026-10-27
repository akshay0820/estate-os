import { useMemo, useState } from 'react';
import { Mail, MoreHorizontal, Plus, ShieldCheck, UserMinus, UserCheck, Send } from 'lucide-react';
import { Avatar, Badge, Button, Field, Input, Menu, Modal, PageHeader, Progress, Select } from '@/components/ui';
import { confirm } from '@/components/dialogs';
import { useStore } from '@/store/store';
import { LIVE, actions, attempt, ok } from '@/data/actions';
import { useCan, useMe, useOrgList } from '@/store/hooks';
import { toast } from '@/store/ui';
import { ROLE_DESC, ROLE_LABEL } from '@/lib/permissions';
import { pct } from '@/lib/format';
import type { Role } from '@/store/types';

const ROLES: Role[] = ['owner', 'admin', 'manager', 'agent', 'operations', 'finance', 'viewer'];

export function TeamPage() {
  const members = useOrgList('members');
  const leads = useOrgList('leads');
  const tasks = useOrgList('tasks');
  const appts = useOrgList('appointments');
  const me = useMe();
  const canManage = useCan('team.manage');
  const setMemberStatus = (id: string, status: 'active' | 'suspended') => ok(() => actions.setMemberStatus(id, status));
  const [inviting, setInviting] = useState(false);

  const stats = useMemo(() => {
    const now = Date.now();
    return new Map(members.map((m) => {
      const mine = leads.filter((l) => l.assignedTo === m.id);
      const open = mine.filter((l) => !['won', 'lost', 'nurture'].includes(l.status) && !l.archived);
      const recent = mine.filter((l) => now - l.createdAt < 30 * 864e5);
      return [m.id, {
        open: open.length,
        overdue: tasks.filter((t) => t.assignedTo === m.id && t.status !== 'completed' && t.status !== 'cancelled' && t.dueAt < now).length,
        visits: appts.filter((a) => a.assignedTo === m.id && a.start > now && a.status !== 'cancelled').length,
        conv: recent.length ? recent.filter((l) => ['visit_scheduled', 'visit_completed', 'negotiation', 'won'].includes(l.status)).length / recent.length : 0,
      }];
    }));
  }, [members, leads, tasks, appts]);
  const maxOpen = Math.max(1, ...[...stats.values()].map((s) => s.open));

  const onRole = async (id: string, role: Role) => {
    if (await ok(() => actions.changeRole(id, role))) toast({ kind: 'success', title: `Role changed to ${ROLE_LABEL[role]}`, body: 'Takes effect on their next request.' });
  };

  return (
    <div className="page">
      <PageHeader
        eyebrow={`[ ${members.filter((m) => m.status === 'active').length} active · ${members.filter((m) => m.status === 'invited').length} invited ]`}
        title="Team"
        sub="Members, roles and workload. Roles map to explicit capabilities; changes are audited and apply on the next request."
        actions={canManage && <Button variant="primary" icon={<Plus size={15} />} onClick={() => setInviting(true)}>Invite member</Button>}
      />
      <div className="card">
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Member</th><th>Role</th><th>Status</th><th style={{ width: 200 }}>Open leads</th><th className="right">Overdue tasks</th><th className="right">Upcoming visits</th><th className="right">Lead → visit · 30d</th><th /></tr></thead>
            <tbody>
              {members.map((m) => {
                const st = stats.get(m.id)!;
                const isMe = m.id === me.id;
                return (
                  <tr key={m.id} style={{ opacity: m.status === 'suspended' ? 0.5 : 1 }}>
                    <td>
                      <div className="cell-main">
                        <Avatar name={m.name} hue={m.hue} />
                        <div>
                          <div className="cell-title">{m.name}{isMe && <span className="faint"> (you)</span>}</div>
                          <div className="cell-sub">{m.title} · {m.email}</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      {canManage && m.status !== 'suspended' ? (
                        <Select selectSize="sm" value={m.role} onChange={(e) => void onRole(m.id, e.target.value as Role)} style={{ width: 130 }} title={ROLE_DESC[m.role]} aria-label={`Role for ${m.name}`}>
                          {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                        </Select>
                      ) : <Badge>{ROLE_LABEL[m.role]}</Badge>}
                    </td>
                    <td><Badge tone={m.status === 'active' ? 'success' : m.status === 'invited' ? 'info' : 'neutral'} dot>{m.status}</Badge></td>
                    <td>
                      {m.role === 'agent' || st.open ? (
                        <div className="row" style={{ gap: 10 }}>
                          <div className="grow"><Progress value={st.open / maxOpen} tone={st.open / maxOpen > 0.85 ? 'warning' : undefined} /></div>
                          <span className="num mono" style={{ fontSize: 12, width: 24, textAlign: 'right' }}>{st.open}</span>
                        </div>
                      ) : <span className="faint">—</span>}
                    </td>
                    <td className="right num" style={{ color: st.overdue ? 'var(--danger)' : undefined }}>{st.overdue || '—'}</td>
                    <td className="right num">{st.visits || '—'}</td>
                    <td className="right num">{m.role === 'agent' ? pct(st.conv, 0) : '—'}</td>
                    <td>
                      {canManage && !isMe && (
                        <Menu
                          trigger={(p) => <Button size="xs" variant="ghost" iconOnly icon={<MoreHorizontal size={15} />} aria-label={`Actions for ${m.name}`} {...p} />}
                          items={
                            m.status === 'invited'
                              ? [
                                  ...(LIVE ? [] : [{ label: 'Resend invitation', icon: <Send size={14} />, onSelect: () => { useStore.getState().log('member.invite_resent', 'member', m.id, m.email); toast({ kind: 'success', title: 'Invitation resent', body: `New single-use link sent to ${m.email}` }); } }]),
                                  { label: 'Revoke invitation', icon: <UserMinus size={14} />, danger: true, onSelect: async () => { const r = await confirm({ title: 'Revoke invitation?', body: 'The invite link stops working immediately.', confirmLabel: 'Revoke', danger: true }); if (r.ok && (await setMemberStatus(m.id, 'suspended'))) toast({ kind: 'info', title: 'Invitation revoked' }); } },
                                ]
                              : m.status === 'suspended'
                              ? [{ label: 'Reactivate', icon: <UserCheck size={14} />, onSelect: async () => { if (await setMemberStatus(m.id, 'active')) toast({ kind: 'success', title: `${m.name} reactivated` }); } }]
                              : [{ label: 'Suspend access', icon: <UserMinus size={14} />, danger: true, onSelect: async () => {
                                  const r = await confirm({ title: `Suspend ${m.name}?`, body: `Sessions are revoked and ${st.open} open lead${st.open === 1 ? '' : 's'} become unassigned for redistribution.`, confirmLabel: 'Suspend', danger: true, typeToConfirm: m.name.split(' ')[0] });
                                  if (!r.ok) return;
                                  if (await setMemberStatus(m.id, 'suspended')) toast({ kind: 'warning', title: `${m.name} suspended` });
                                } }]
                          }
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <div className="card mt-16" style={{ padding: 18 }}>
        <h4 className="section-title"><ShieldCheck size={12} /> What each role can do</h4>
        <div className="grid g-3" style={{ gap: 10 }}>
          {ROLES.map((r) => (
            <div key={r} className="row row-top" style={{ gap: 10 }}>
              <Badge tone={r === 'owner' ? 'accent' : 'neutral'}>{ROLE_LABEL[r]}</Badge>
              <span className="faint" style={{ fontSize: 12.5 }}>{ROLE_DESC[r]}</span>
            </div>
          ))}
        </div>
      </div>
      {inviting && <InviteModal onClose={() => setInviting(false)} />}
    </div>
  );
}

function InviteModal({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('agent');
  const [err, setErr] = useState<string | null>(null);
  if (link) {
    return (
      <Modal open onClose={onClose} title="Share the invitation link" description="Email delivery isn’t configured yet, so send this link yourself. It works once, only for that email address, and expires in 7 days." footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
        <div className="code"><span>{link}</span><Button size="xs" onClick={() => { void navigator.clipboard?.writeText(link); toast({ kind: 'success', title: 'Link copied' }); }}>Copy</Button></div>
      </Modal>
    );
  }
  return (
    <Modal open onClose={onClose} title="Invite a teammate" description="They get a single-use link that expires in 7 days." footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} icon={<Mail size={14} />} onClick={async () => {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) return setErr('Enter a valid email address');
      setBusy(true);
      const r = await attempt(() => actions.inviteMember(email.trim(), role, name), (m) => setErr(m));
      setBusy(false);
      if (r === undefined) return;
      if (r) return setLink(r);
      toast({ kind: 'success', title: 'Invitation sent', body: `${email} · ${ROLE_LABEL[role]}` });
      onClose();
    }}>{LIVE ? 'Create invite' : 'Send invite'}</Button></>}>
      <div className="form-grid">
        <Field label="Work email" className="full" error={err}><Input type="email" value={email} onChange={(e) => { setEmail(e.target.value); setErr(null); }} placeholder="name@agency.in" data-autofocus invalid={!!err} /></Field>
        {!LIVE && <Field label="Name (optional)"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>}
        <Field label="Role" hint={ROLE_DESC[role]}>
          <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.filter((r) => r !== 'owner').map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </Select>
        </Field>
      </div>
    </Modal>
  );
}
