import { useMemo, useState, useEffect } from 'react';
import { Mail, MessageCircle, Phone, ShieldOff, Users, Pencil } from 'lucide-react';
import { Avatar, Badge, Button, Drawer, Empty, Field, Input, KV, Modal, PageHeader, Pager, SearchInput, Select, TableSkeleton } from '@/components/ui';
import { confirm } from '@/components/dialogs';
import { useStore } from '@/store/store';
import { LIVE, actions, ok } from '@/data/actions';
import { useDebounced, useServerQuery } from '@/data/useServerQuery';
import * as live from '@/backend/live';
import { useCan, useOrgList } from '@/store/hooks';
import { toast } from '@/store/ui';
import { navigate, setParam } from '@/lib/router';
import { CHANNEL_LABEL } from '@/lib/domain';
import { fmtDate, relTime } from '@/lib/format';
import type { Channel, Contact } from '@/store/types';
import { CHANNEL_ICON, LeadStatusBadge, MemberChip } from './shared';
import { ConsentBadge, LeadTimeline } from './leads';
import { RecordQualityPanel } from './dataQuality';

const LIFECYCLE_TONE = { new: 'accent', active: 'info', nurture: 'neutral', client: 'success', inactive: 'neutral', do_not_contact: 'danger' } as const;

export function ContactsPage({ params }: { params: URLSearchParams }) {
  const contacts = useOrgList('contacts');
  const leads = useOrgList('leads');
  const [q, setQ] = useState('');
  const [role, setRole] = useState('');
  const [life, setLife] = useState('');
  const [page, setPage] = useState(0);
  const openId = params.get('id');

  const leadCount = useMemo(() => {
    const m = new Map<string, number>();
    leads.forEach((l) => m.set(l.contactId, (m.get(l.contactId) ?? 0) + 1));
    return m;
  }, [leads]);
  const filtered = useMemo(() => {
    const t = q.toLowerCase().replace(/\s/g, '');
    return contacts
      .filter((c) => (!role || c.roles.includes(role as Contact['roles'][number])) && (!life || c.lifecycle === life) && (!t || c.name.toLowerCase().replace(/\s/g, '').includes(t) || c.phone.includes(t) || c.email.includes(t)))
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [contacts, q, role, life]);
  useEffect(() => setPage(0), [q, role, life]);
  const dq = useDebounced(q);
  const server = useServerQuery(LIVE, () => live.queryContacts({ q: dq, role, lifecycle: life, page, pageSize: 25 }), [dq, role, life, page]);
  const rows = LIVE ? server.data?.rows ?? [] : filtered.slice(page * 25, page * 25 + 25);
  const total = LIVE ? server.data?.total ?? 0 : filtered.length;
  const counts = LIVE ? server.data?.leadCounts ?? new Map<string, number>() : leadCount;

  return (
    <div className="page">
      <PageHeader eyebrow={`[ ${LIVE ? total : contacts.length} people ]`} title="Contacts" sub="One record per person. Repeat enquiries become new leads linked here, so history is never fragmented." />
      <div className="card">
        <div className="toolbar">
          <SearchInput value={q} onChange={setQ} placeholder="Name, phone or email" width={260} />
          <Select selectSize="sm" value={role} onChange={(e) => setRole(e.target.value)} style={{ width: 140 }} aria-label="Role">
            <option value="">Any role</option>
            {['buyer', 'tenant', 'investor', 'seller', 'landlord'].map((r) => <option key={r} value={r}>{r}</option>)}
          </Select>
          <Select selectSize="sm" value={life} onChange={(e) => setLife(e.target.value)} style={{ width: 160 }} aria-label="Lifecycle">
            <option value="">Any lifecycle</option>
            {Object.keys(LIFECYCLE_TONE).map((l) => <option key={l} value={l}>{l.replace(/_/g, ' ')}</option>)}
          </Select>
        </div>
        {LIVE && server.error ? <Empty icon={<Users size={20} />} title="Couldn’t load contacts" description={server.error} action={<Button onClick={server.reload}>Retry</Button>} />
          : LIVE && server.loading && !server.data ? <TableSkeleton />
          : rows.length === 0 ? <Empty icon={<Users size={20} />} title={q || role || life ? 'No contacts found' : 'No contacts yet'} description={q || role || life ? undefined : 'Contacts are created with each new lead.'} /> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Name</th><th>Roles</th><th>Lifecycle</th><th>Reach</th><th>Consent</th><th>Enquiries</th><th>Owner</th><th>Last contact</th></tr></thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} className="clickable" onClick={() => setParam('id', c.id)}>
                    <td><div className="cell-main"><Avatar name={c.name} size="sm" /><div><div className="cell-title">{c.name}</div><div className="cell-sub">{c.phone}</div></div></div></td>
                    <td>{c.roles.map((r) => <span key={r} className="tag" style={{ marginRight: 4, textTransform: 'capitalize' }}>{r}</span>)}</td>
                    <td><Badge tone={LIFECYCLE_TONE[c.lifecycle]}>{c.lifecycle.replace(/_/g, ' ')}</Badge></td>
                    <td><span className="row" style={{ gap: 4 }}>{CHANNEL_ICON[c.preferredChannel]} {CHANNEL_LABEL[c.preferredChannel]}</span></td>
                    <td>
                      <span className="row" style={{ gap: 3 }}>
                        {(['phone', 'whatsapp', 'email'] as Channel[]).map((ch) => (
                          <span key={ch} title={`${CHANNEL_LABEL[ch]}: ${c.consents[ch]}`} className="status-dot" style={{ background: c.consents[ch] === 'granted' ? 'var(--success)' : c.consents[ch] === 'unknown' ? 'var(--amber)' : 'var(--blaze)' }} />
                        ))}
                      </span>
                    </td>
                    <td className="num">{counts.get(c.id) ?? 0}</td>
                    <td><MemberChip id={c.assignedTo} /></td>
                    <td className="faint">{relTime(c.lastContactedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager page={page} pageSize={25} total={total} onPage={setPage} />
      </div>
      {openId && <ContactDrawer id={openId} onClose={() => setParam('id', null)} />}
    </div>
  );
}

function ContactDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const c = useOrgList('contacts').find((x) => x.id === id);
  const leads = useOrgList('leads').filter((l) => l.contactId === id);
  const properties = useOrgList('properties').filter((p) => p.ownerContactId === id);
  const canEdit = useCan('contacts.edit');
  const { startConversation } = useStore.getState();
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (LIVE) void live.ensureContact(id).catch(() => undefined);
  }, [id]);
  if (!c) return LIVE ? <Drawer open wide onClose={onClose} label="Contact" header={<div className="skeleton" style={{ height: 24, width: 180 }} />}><TableSkeleton rows={5} /></Drawer> : null;
  return (
    <Drawer
      open
      wide
      onClose={onClose}
      label={c.name}
      header={
        <div className="row" style={{ gap: 14 }}>
          <Avatar name={c.name} size="lg" />
          <div>
            <h2 style={{ fontSize: 19, fontWeight: 600 }}>{c.name}</h2>
            <div className="row mt-4 wrap" style={{ gap: 6 }}>
              <Badge tone={LIFECYCLE_TONE[c.lifecycle]}>{c.lifecycle.replace(/_/g, ' ')}</Badge>
              {c.roles.map((r) => <span key={r} className="tag" style={{ textTransform: 'capitalize' }}>{r}</span>)}
              {c.tags.map((t) => <span key={t} className="tag">{t}</span>)}
            </div>
          </div>
        </div>
      }
      footer={
        <>
          {canEdit && c.lifecycle !== 'do_not_contact' && (
            <Button variant="danger" icon={<ShieldOff size={15} />} onClick={async () => {
              const r = await confirm({ title: 'Add to do-not-contact?', body: 'All channels are revoked and every pending automated send or call is cancelled.', confirmLabel: 'Confirm opt-out', danger: true });
              if (r.ok && (await ok(() => actions.optOutAll(c.id)))) toast({ kind: 'warning', title: 'Contact suppressed' });
            }}>Do not contact</Button>
          )}
          {canEdit && <Button icon={<Pencil size={15} />} onClick={() => setEditing(true)}>Edit</Button>}
          {!LIVE && <Button variant="primary" icon={<MessageCircle size={15} />} onClick={() => navigate('inbox', { id: startConversation(c.id, c.preferredChannel === 'phone' ? 'whatsapp' : c.preferredChannel) })}>Message</Button>}
        </>
      }
    >
      <div className="stack stack-lg">
        <KV items={[
          ['Phone', <a key="p" className="link" href={`tel:${c.phone}`}><Phone size={12} /> {c.phone}</a>],
          ['Email', c.email ? <a key="e" className="link" href={`mailto:${c.email}`}><Mail size={12} /> {c.email}</a> : '—'],
          ['Prefers', <span key="pr" className="row">{CHANNEL_ICON[c.preferredChannel]} {CHANNEL_LABEL[c.preferredChannel]}</span>],
          ['Source', c.source],
          ['Owner', <MemberChip key="o" id={c.assignedTo} />],
          ['Since', fmtDate(c.createdAt, true)],
        ]} />
        <section>
          <h4 className="section-title">Consent & suppression</h4>
          <div className="card" style={{ boxShadow: 'none' }}>
            {(['phone', 'whatsapp', 'sms', 'email'] as Channel[]).map((ch) => (
              <div key={ch} className="list-row" style={{ padding: '10px 14px' }}>
                <span className="icon-chip">{CHANNEL_ICON[ch]}</span>
                <span className="grow">{CHANNEL_LABEL[ch]}</span>
                <ConsentBadge state={c.consents[ch]} />
                {canEdit && c.lifecycle !== 'do_not_contact' && (
                  <Select selectSize="sm" style={{ width: 130 }} value={c.consents[ch]} onChange={async (e) => { const v = e.target.value as Contact['consents'][Channel]; if (await ok(() => actions.setConsent(c.id, ch, v))) toast({ kind: 'success', title: `${CHANNEL_LABEL[ch]} consent updated`, body: 'Recorded with source and timestamp.' }); }} aria-label={`${CHANNEL_LABEL[ch]} consent`}>
                    <option value="granted">Granted</option>
                    <option value="unknown">Unknown</option>
                    <option value="revoked">Opted out</option>
                  </Select>
                )}
              </div>
            ))}
          </div>
        </section>
        <section>
          <h4 className="section-title">Enquiries ({leads.length})</h4>
          <div className="card" style={{ boxShadow: 'none' }}>
            {leads.map((l) => (
              <button key={l.id} className="list-row" onClick={() => navigate('leads', { id: l.id })}>
                <span className="grow"><b style={{ fontWeight: 500 }}>{l.source}</b> <span className="faint">· {fmtDate(l.createdAt, true)}</span></span>
                <LeadStatusBadge status={l.status} />
              </button>
            ))}
          </div>
        </section>
        {properties.length > 0 && (
          <section>
            <h4 className="section-title">Owns ({properties.length})</h4>
            <div className="card" style={{ boxShadow: 'none' }}>
              {properties.map((p) => (
                <button key={p.id} className="list-row" onClick={() => navigate('properties', { id: p.id })}>
                  <span className="grow truncate">{p.title}</span><span className="faint">{p.locality}</span>
                </button>
              ))}
            </div>
          </section>
        )}
        <RecordQualityPanel entityType="contact" id={c.id} />
        <section>
          <h4 className="section-title">Timeline</h4>
          <LeadTimeline contactId={c.id} canEdit={false} />
        </section>
      </div>
      {editing && <ContactForm contact={c} onClose={() => setEditing(false)} />}
    </Drawer>
  );
}

function ContactForm({ contact, onClose }: { contact: Contact; onClose: () => void }) {
  const [f, setF] = useState({ name: contact.name, phone: contact.phone, email: contact.email, preferredChannel: contact.preferredChannel });
  const [err, setErr] = useState('');
  return (
    <Modal open onClose={onClose} title="Edit contact" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={async () => {
      if (!f.name.trim()) return setErr('Name is required');
      if (f.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email)) return setErr('Enter a valid email');
      if (!f.phone.trim() && !f.email.trim()) return setErr('Keep a phone number or an email');
      if (!(await ok(() => actions.updateContact(contact.id, { name: f.name.trim(), phone: f.phone, email: f.email.toLowerCase(), preferredChannel: f.preferredChannel }), setErr))) return;
      toast({ kind: 'success', title: 'Contact updated' });
      onClose();
    }}>Save</Button></>}>
      <div className="form-grid">
        {err && <div className="banner danger full">{err}</div>}
        <Field label="Name" className="full"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Phone"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        <Field label="Email"><Input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Preferred channel" className="full">
          <Select value={f.preferredChannel} onChange={(e) => setF({ ...f, preferredChannel: e.target.value as Channel })}>
            {(['whatsapp', 'phone', 'email', 'sms'] as Channel[]).map((ch) => <option key={ch} value={ch}>{CHANNEL_LABEL[ch]}</option>)}
          </Select>
        </Field>
      </div>
    </Modal>
  );
}
