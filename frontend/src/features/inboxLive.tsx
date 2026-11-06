// Unified inbox, live mode: email channel only (WhatsApp/SMS are not built yet — see CLAUDE.md). There is no AI
// auto-responder for email; a new conversation always starts unassigned, waiting for a person to reply or resolve.
import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, Bot, Check, Clock, Hand, Lock, Mail, MessageSquareDashed, Send, Settings2, ShieldCheck, StickyNote, CheckCircle2, RotateCcw } from 'lucide-react';
import { Avatar, Button, Empty, Field, Input, Menu, Modal, PageHeader, SearchInput, Segmented, Switch, TableSkeleton } from '@/components/ui';
import { useCan } from '@/store/hooks';
import { toast } from '@/store/ui';
import { setParam } from '@/lib/router';
import { CHANNEL_LABEL } from '@/lib/domain';
import { relTime, sameDay } from '@/lib/format';
import { cx } from '@/lib/util';
import { useServerQuery } from '@/data/useServerQuery';
import { ok } from '@/data/actions';
import { errorMessage } from '@/backend/errors';
import * as live from '@/backend/live';
import type { Conversation } from '@/store/types';
import { CHANNEL_ICON } from './shared';
import { Bubble, OwnerBadge } from './inbox';

type Filter = 'open' | 'mine' | 'resolved';

export function LiveInboxPage({ params }: { params: URLSearchParams }) {
  const canReply = useCan('inbox.reply');
  const canManage = useCan('integrations.manage');
  const [filter, setFilter] = useState<Filter>('open');
  const [q, setQ] = useState('');
  const [settings, setSettings] = useState(false);
  const data = useServerQuery(true, () => live.conversations(), []);
  const status = useServerQuery(true, () => live.inboxEmailStatus(), []);
  const cfg = useServerQuery(true, () => live.loadEmailSettings(), []);
  const selected = params.get('id');
  const configured = !!status.data?.postmark_configured && !!cfg.data?.enabled;

  const conversations = useMemo(() => data.data?.conversations ?? [], [data.data]);
  const contactsById = data.data?.contactsById;
  const list = useMemo(() => {
    const t = q.toLowerCase();
    return conversations
      .filter((c) => {
        if (filter === 'resolved') { if (c.status !== 'resolved') return false; }
        else if (c.status === 'resolved') return false;
        if (filter === 'mine' && c.owner !== 'human') return false;
        const contact = contactsById?.get(c.contactId);
        return !t || (contact?.name.toLowerCase().includes(t) ?? false) || c.messages.some((m) => m.body.toLowerCase().includes(t));
      })
      .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  }, [conversations, filter, q, contactsById]);

  useEffect(() => {
    if (!selected && list[0] && window.innerWidth > 860) setParam('id', list[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, list.length]);

  const current = conversations.find((c) => c.id === selected);
  const unread = conversations.reduce((s, c) => s + c.unread, 0);

  return (
    <div className="page" style={{ maxWidth: 1600 }}>
      <PageHeader
        eyebrow={`[ ${unread} unread · email ]`}
        title="Unified inbox"
        sub="Email replies in one place. WhatsApp and SMS are not connected yet."
        actions={canManage ? <Button icon={<Settings2 size={15} />} onClick={() => setSettings(true)}>Email settings</Button> : undefined}
      />
      <div className={`banner ${configured ? '' : 'warning'}`} style={{ marginBottom: 16 }}>
        {configured ? <ShieldCheck size={16} /> : <AlertTriangle size={16} />}
        <div className="grow" style={{ fontSize: 13 }}>
          <b>{configured ? 'Email is on' : 'Email is not active'}</b>
          <div className="faint">
            Provider: {status.data ? (status.data.postmark_configured ? 'Postmark connected' : 'Postmark token not set on the server') : '…'}
            {' · '}Agency settings: {cfg.data ? (cfg.data.enabled ? 'enabled' : 'disabled') : cfg.loading ? '…' : 'not set up'}
          </div>
        </div>
      </div>
      <div className="card inbox" data-thread={!!current}>
        <div className="inbox-list">
          <div className="stack stack-sm" style={{ padding: 12, borderBottom: '1px solid var(--border-soft)' }}>
            <SearchInput value={q} onChange={setQ} placeholder="Search people or messages" width="100%" />
            <Segmented value={filter} onChange={setFilter} options={[
              { value: 'open', label: 'Open' }, { value: 'mine', label: 'Mine' }, { value: 'resolved', label: 'Done' },
            ]} />
          </div>
          <div className="inbox-items">
            {data.loading && !data.data ? <TableSkeleton rows={6} /> : list.length === 0 && (
              <Empty icon={<MessageSquareDashed size={20} />} title="No conversations" description="Try another filter." />
            )}
            {list.map((c) => {
              const contact = contactsById?.get(c.contactId);
              const last = [...c.messages].reverse().find((m) => m.direction !== 'system') ?? c.messages[c.messages.length - 1];
              return (
                <button key={c.id} className={cx('conv-item', c.id === selected && 'on', c.unread > 0 && 'unread')} onClick={() => setParam('id', c.id)}>
                  <Avatar name={contact?.name ?? '?'} />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="row" style={{ gap: 6 }}>
                      <span className="name truncate">{contact?.name}</span>
                      <span className="faint" style={{ display: 'inline-flex' }} title={CHANNEL_LABEL[c.channel]}>{CHANNEL_ICON[c.channel]}</span>
                      <span className="faint mono ml-auto" style={{ fontSize: 11 }}>{relTime(c.lastMessageAt)}</span>
                    </div>
                    <div className="preview truncate">
                      {last?.direction === 'out' ? 'You: ' : last?.direction === 'internal' ? 'Note: ' : ''}
                      {last?.body}
                    </div>
                    <div className="row mt-4" style={{ gap: 6 }}>
                      <OwnerBadge owner={c.owner} />
                      {c.unread > 0 && <span className="badge badge-accent" style={{ height: 18 }}>{c.unread} new</span>}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
        {current ? (
          <LiveThread key={current.id} conv={current} contactName={contactsById?.get(current.contactId)?.name ?? '?'} canReply={canReply} />
        ) : (
          <div className="thread" style={{ display: 'grid', placeItems: 'center' }}>
            <Empty icon={<MessageSquareDashed size={20} />} title="Select a conversation" />
          </div>
        )}
      </div>
      {settings && <EmailSettingsModal initial={cfg.data ?? null} onClose={() => setSettings(false)} />}
    </div>
  );
}

function LiveThread({ conv, contactName, canReply }: { conv: Conversation; contactName: string; canReply: boolean }) {
  const [text, setText] = useState('');
  const [note, setNote] = useState(false);
  const [busy, setBusy] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const readRef = useRef<string | null>(null);

  useEffect(() => {
    if (conv.unread && readRef.current !== conv.id) {
      readRef.current = conv.id;
      void live.markConversationRead(conv.id);
    }
  }, [conv.id, conv.unread]);
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: 'smooth' });
  }, [conv.messages.length]);

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setBusy(true);
    try {
      const r = await live.sendConversationMessage(conv.id, body, { internal: note });
      if (r.status === 'blocked') toast({ kind: 'error', title: 'Not sent', body: r.reason ?? 'Blocked by policy' });
      else setText('');
    } catch (e) {
      toast({ kind: 'error', title: 'Not sent', body: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  let lastDay = 0;
  return (
    <div className="thread">
      <div className="thread-head">
        <Button variant="ghost" size="sm" iconOnly className="mobile-only" icon={<ArrowLeft size={16} />} onClick={() => setParam('id', null)} aria-label="Back to list" />
        <Avatar name={contactName} />
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 8 }}>
            <b className="truncate">{contactName}</b>
            <OwnerBadge owner={conv.owner} />
          </div>
          <div className="faint row" style={{ fontSize: 12, gap: 5 }}><Mail size={12} /> {CHANNEL_LABEL[conv.channel]}</div>
        </div>
        {canReply && (
          <div className="row" style={{ gap: 6 }}>
            {conv.owner === 'ai' ? (
              <Button size="sm" variant="primary" icon={<Hand size={14} />} onClick={() => void ok(() => live.takeOverConversation(conv.id))}>Take over</Button>
            ) : (
              <Button size="sm" icon={<Bot size={14} />} title="Hand back to AI (no email auto-responder is wired up yet)" disabled onClick={() => void ok(() => live.resumeAiConversation(conv.id))}>Resume AI</Button>
            )}
            <Menu
              trigger={(p) => <Button size="sm" iconOnly icon={<CheckCircle2 size={15} />} aria-label="Conversation status" {...p} />}
              items={[
                conv.status === 'resolved'
                  ? { label: 'Reopen', icon: <RotateCcw size={14} />, onSelect: () => void ok(() => live.setConversationStatus(conv.id, 'open')) }
                  : { label: 'Mark resolved', icon: <Check size={14} />, onSelect: () => void ok(() => live.setConversationStatus(conv.id, 'resolved')) },
                { label: 'Mark pending', icon: <Clock size={14} />, onSelect: () => void ok(() => live.setConversationStatus(conv.id, 'pending')) },
              ]}
            />
          </div>
        )}
      </div>

      <div className="thread-body" ref={bodyRef}>
        {conv.messages.map((m) => {
          const showDay = !sameDay(m.at, lastDay);
          lastDay = m.at;
          return (
            <div key={m.id} style={{ display: 'contents' }}>
              {showDay && <div className="msg system" style={{ margin: '6px 0' }}><span className="mono" style={{ fontSize: 10.5, letterSpacing: '.06em', textTransform: 'uppercase' }}>{sameDay(m.at, Date.now()) ? 'Today' : new Date(m.at).toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'short' })}</span></div>}
              <Bubble m={m} />
            </div>
          );
        })}
      </div>

      {canReply ? (
        <div className="composer">
          <div className={cx('composer-box', note && 'note')}>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send(); }}
              placeholder={note ? 'Internal note — only your team sees this' : `Reply on ${CHANNEL_LABEL[conv.channel]}…`}
              aria-label="Message"
            />
            <div className="row">
              <Segmented value={note ? 'note' : 'reply'} onChange={(v) => setNote(v === 'note')} options={[{ value: 'reply', label: 'Reply' }, { value: 'note', label: <><StickyNote size={12} /> Note</> }]} />
              <span className="faint ml-auto desktop-only" style={{ fontSize: 11.5 }}>Ctrl ↵ to send</span>
              <Button size="sm" variant={note ? 'default' : 'primary'} icon={note ? <StickyNote size={14} /> : <Send size={14} />} disabled={!text.trim()} loading={busy} onClick={send}>
                {note ? 'Add note' : 'Send'}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="composer faint" style={{ fontSize: 13 }}><Lock size={13} /> Your role can read but not reply.</div>
      )}
    </div>
  );
}

const DEFAULTS: live.EmailSettings = { enabled: false, from_address: null, from_name: null, inbound_address: null };

function EmailSettingsModal({ initial, onClose }: { initial: live.EmailSettings | null; onClose: () => void }) {
  const [f, setF] = useState<live.EmailSettings>({ ...DEFAULTS, ...(initial ?? {}) });
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof live.EmailSettings>(k: K, v: live.EmailSettings[K]) => setF({ ...f, [k]: v });
  const save = async () => {
    setBusy(true);
    const done = await ok(() => live.saveEmailSettings({ ...f, from_address: f.from_address || null, from_name: f.from_name || null, inbound_address: f.inbound_address || null }), (m) => toast({ kind: 'error', title: 'Not saved', body: m }));
    setBusy(false);
    if (done) { toast({ kind: 'success', title: 'Email settings saved' }); onClose(); }
  };
  return (
    <Modal open onClose={onClose} title="Email settings" description="The sender address and inbound address come from your Postmark server. The server token is set on the server, never here.">
      <div className="stack">
        <Field label="Enable email"><Switch on={f.enabled} onChange={(v) => set('enabled', v)} label="Enable email" /></Field>
        <Field label="From address" hint="A verified Sender Signature on your Postmark server"><Input value={f.from_address ?? ''} onChange={(e) => set('from_address', e.target.value)} placeholder="leads@youragency.com" /></Field>
        <Field label="From name" hint="Used in the From header"><Input value={f.from_name ?? ''} onChange={(e) => set('from_name', e.target.value)} placeholder="Blaze Estate" /></Field>
        <Field label="Inbound address" hint="This Postmark Inbound Stream's address — replies are routed to this workspace by matching it">
          <Input value={f.inbound_address ?? ''} onChange={(e) => set('inbound_address', e.target.value)} placeholder="yourhash@inbound.postmarkapp.com" />
        </Field>
        <div className="row row-between mt-8">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={save}>Save</Button>
        </div>
      </div>
    </Modal>
  );
}
