import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Bot, Check, CheckCheck, CircleSlash, Clock, Hand, Lock, MessageSquareDashed, Send, Sparkles, StickyNote, UserRound, Wand2, CornerDownLeft, CheckCircle2, RotateCcw } from 'lucide-react';
import { Avatar, Badge, Button, Empty, KV, Menu, PageHeader, SearchInput, Segmented } from '@/components/ui';
import { useStore, draftReply } from '@/store/store';
import { useCan, useLookup, useMe, useOrg, useOrgList } from '@/store/hooks';
import { toast } from '@/store/ui';
import { navigate, setParam } from '@/lib/router';
import { CHANNEL_LABEL, outboundPolicy } from '@/lib/domain';
import { fmtTime, money, relTime, sameDay } from '@/lib/format';
import { cx } from '@/lib/util';
import type { Conversation, Message } from '@/store/types';
import { CHANNEL_ICON, LeadStatusBadge, MemberChip } from './shared';
import { ConsentBadge } from './leads';

type Filter = 'open' | 'mine' | 'ai' | 'human' | 'resolved';

export function InboxPage({ params }: { params: URLSearchParams }) {
  const conversations = useOrgList('conversations');
  const contacts = useLookup('contacts');
  const me = useMe();
  const [filter, setFilter] = useState<Filter>('open');
  const [q, setQ] = useState('');
  const selected = params.get('id');

  const list = useMemo(() => {
    const t = q.toLowerCase();
    return conversations
      .filter((c) => {
        if (filter === 'resolved') { if (c.status !== 'resolved') return false; }
        else if (c.status === 'resolved') return false;
        if (filter === 'mine' && c.assignedTo !== me.id) return false;
        if (filter === 'ai' && c.owner !== 'ai') return false;
        if (filter === 'human' && c.owner !== 'human') return false;
        return !t || (contacts.get(c.contactId)?.name.toLowerCase().includes(t) ?? false) || c.messages.some((m) => m.body.toLowerCase().includes(t));
      })
      .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  }, [conversations, filter, q, contacts, me.id]);

  useEffect(() => {
    if (!selected && list[0] && window.innerWidth > 860) setParam('id', list[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const current = conversations.find((c) => c.id === selected);
  const unread = conversations.reduce((s, c) => s + c.unread, 0);

  return (
    <div className="page" style={{ maxWidth: 1600 }}>
      <PageHeader
        eyebrow={`[ ${unread} unread · ${conversations.filter((c) => c.owner === 'ai' && c.status !== 'resolved').length} handled by AI ]`}
        title="Unified inbox"
        sub="WhatsApp, SMS and email in one place. Take over from AI at any moment — pending automated replies are cancelled instantly."
      />
      <div className="card inbox" data-thread={!!current}>
        <div className="inbox-list">
          <div className="stack stack-sm" style={{ padding: 12, borderBottom: '1px solid var(--border-soft)' }}>
            <SearchInput value={q} onChange={setQ} placeholder="Search people or messages" width="100%" />
            <Segmented
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'open', label: 'Open' },
                { value: 'mine', label: 'Mine' },
                { value: 'ai', label: <><Bot size={13} /> AI</> },
                { value: 'human', label: <><Hand size={13} /> Human</> },
                { value: 'resolved', label: 'Done' },
              ]}
            />
          </div>
          <div className="inbox-items">
            {list.length === 0 && <Empty icon={<MessageSquareDashed size={20} />} title="No conversations" description="Try another filter." />}
            {list.map((c) => {
              const contact = contacts.get(c.contactId);
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
                      {last?.direction === 'out' ? (last.sender === 'ai' ? 'AI: ' : 'You: ') : last?.direction === 'internal' ? 'Note: ' : ''}
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
        {current ? <Thread key={current.id} conv={current} /> : (
          <div className="thread" style={{ display: 'grid', placeItems: 'center' }}>
            <Empty icon={<MessageSquareDashed size={20} />} title="Select a conversation" />
          </div>
        )}
        {current && <SidePanel conv={current} />}
      </div>
    </div>
  );
}

function OwnerBadge({ owner }: { owner: Conversation['owner'] }) {
  if (owner === 'ai') return <span className="badge badge-ai" style={{ height: 18 }}><Bot size={10} /> AI</span>;
  if (owner === 'human') return <span className="badge" style={{ height: 18 }}><Hand size={10} /> Human</span>;
  return <span className="badge" style={{ height: 18 }}>Unassigned</span>;
}

function Thread({ conv }: { conv: Conversation }) {
  const contact = useLookup('contacts').get(conv.contactId);
  const org = useOrg();
  const canReply = useCan('inbox.reply');
  const { sendMessage, takeOver, resumeAi, setConversationStatus, markConversationRead, receiveMessage } = useStore.getState();
  const [text, setText] = useState('');
  const [note, setNote] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (conv.unread) markConversationRead(conv.id);
  }, [conv.id, conv.unread, markConversationRead]);
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: 'smooth' });
  }, [conv.messages.length]);

  const policy = contact ? outboundPolicy(org, contact, conv.channel) : null;
  const blocked = !note && policy && !policy.allowed;

  const send = () => {
    const body = text.trim();
    if (!body) return;
    const r = sendMessage(conv.id, body, { internal: note });
    if (r && !r.allowed) toast({ kind: 'error', title: 'Not sent', body: r.reason });
    else if (!note && conv.owner === 'ai') toast({ kind: 'info', title: 'You took over', body: 'AI is paused for this conversation.' });
    setText('');
  };

  const suggest = () => {
    setDrafting(true);
    setTimeout(() => {
      setText(draftReply(useStore.getState(), conv.id));
      setDrafting(false);
      setNote(false);
    }, 650);
  };

  let lastDay = 0;
  return (
    <div className="thread">
      <div className="thread-head">
        <Button variant="ghost" size="sm" iconOnly className="mobile-only" icon={<ArrowLeft size={16} />} onClick={() => setParam('id', null)} aria-label="Back to list" />
        <Avatar name={contact?.name ?? '?'} />
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 8 }}>
            <b className="truncate">{contact?.name}</b>
            <OwnerBadge owner={conv.owner} />
          </div>
          <div className="faint row" style={{ fontSize: 12, gap: 5 }}>{CHANNEL_ICON[conv.channel]} {CHANNEL_LABEL[conv.channel]} · {contact?.phone}</div>
        </div>
        {canReply && (
          <div className="row" style={{ gap: 6 }}>
            {conv.owner === 'ai' ? (
              <Button size="sm" variant="primary" icon={<Hand size={14} />} onClick={() => { takeOver(conv.id); toast({ kind: 'success', title: 'You own this conversation', body: 'AI paused; pending AI sends cancelled.' }); }}>Take over</Button>
            ) : (
              <Button size="sm" icon={<Bot size={14} />} disabled={!!policy && !policy.allowed} title={policy && !policy.allowed ? policy.reason : 'Let the AI continue'} onClick={() => { resumeAi(conv.id); toast({ kind: 'info', title: 'Handed back to AI' }); }}>Resume AI</Button>
            )}
            <Menu
              trigger={(p) => <Button size="sm" iconOnly icon={<CheckCircle2 size={15} />} aria-label="Conversation status" {...p} />}
              items={[
                conv.status === 'resolved'
                  ? { label: 'Reopen', icon: <RotateCcw size={14} />, onSelect: () => setConversationStatus(conv.id, 'open') }
                  : { label: 'Mark resolved', icon: <Check size={14} />, onSelect: () => { setConversationStatus(conv.id, 'resolved'); toast({ kind: 'success', title: 'Resolved' }); } },
                { label: 'Mark pending', icon: <Clock size={14} />, onSelect: () => setConversationStatus(conv.id, 'pending') },
                'sep',
                { heading: 'Test (simulate inbound)' },
                { label: 'Customer replies with requirements', icon: <CornerDownLeft size={14} />, onSelect: () => receiveMessage(conv.id, 'Looking for a 3 bed in Downtown, budget around $850k, can move in 3 months') },
                { label: 'Customer asks a question', icon: <CornerDownLeft size={14} />, onSelect: () => receiveMessage(conv.id, 'Is parking included? Can I visit this weekend?') },
                { label: 'Customer sends STOP', icon: <CircleSlash size={14} />, danger: true, onSelect: () => receiveMessage(conv.id, 'STOP') },
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
          {blocked && (
            <div className="banner danger" style={{ marginBottom: 8, fontSize: 12.5 }}>
              <Lock size={14} /> Replies on {CHANNEL_LABEL[conv.channel]} are blocked — {policy?.reason}. Internal notes still work.
            </div>
          )}
          {conv.owner === 'ai' && !blocked && !note && (
            <div className="faint row" style={{ fontSize: 12, marginBottom: 6, gap: 6 }}><Sparkles size={12} className="accent-text" /> Sending a message takes this conversation over from the AI.</div>
          )}
          <div className={cx('composer-box', note && 'note')}>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
              }}
              placeholder={note ? 'Internal note — only your team sees this' : blocked ? 'Sending is blocked by policy' : `Reply on ${CHANNEL_LABEL[conv.channel]}…`}
              aria-label="Message"
            />
            <div className="row">
              <Segmented value={note ? 'note' : 'reply'} onChange={(v) => setNote(v === 'note')} options={[{ value: 'reply', label: 'Reply' }, { value: 'note', label: <><StickyNote size={12} /> Note</> }]} />
              <Button size="sm" variant="ghost" icon={<Wand2 size={14} />} loading={drafting} onClick={suggest} disabled={blocked ?? false} title="Draft from verified lead data only">Suggest</Button>
              <span className="faint ml-auto desktop-only" style={{ fontSize: 11.5 }}>Ctrl ↵ to send</span>
              <Button size="sm" variant={note ? 'default' : 'primary'} icon={note ? <StickyNote size={14} /> : <Send size={14} />} disabled={!text.trim() || (!note && !!blocked)} onClick={send}>
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

function Bubble({ m }: { m: Message }) {
  if (m.direction === 'system') return <div className="msg system">{m.body} · {fmtTime(m.at)}</div>;
  const cls = m.direction === 'internal' ? 'internal' : m.direction === 'in' ? 'in' : cx('out', m.sender === 'ai' && 'ai');
  return (
    <div className={cx('msg', cls)}>
      <div className="msg-bubble">{m.body}</div>
      <div className="msg-meta">
        {m.direction === 'internal' && <><StickyNote size={10} /> Internal · </>}
        {m.sender === 'ai' && <><Sparkles size={10} className="accent-text" /> </>}
        {m.direction !== 'in' && <span>{m.senderName} ·</span>}
        <span>{fmtTime(m.at)}</span>
        {m.direction === 'out' && <StatusTick status={m.status} />}
      </div>
    </div>
  );
}

function StatusTick({ status }: { status: Message['status'] }) {
  if (status === 'queued') return <Clock size={11} aria-label="Queued" />;
  if (status === 'sent') return <Check size={12} aria-label="Sent" />;
  if (status === 'failed') return <span style={{ color: 'var(--danger)' }}>Failed</span>;
  return <CheckCheck size={12} style={{ color: status === 'read' ? 'var(--sky)' : undefined }} aria-label={status} />;
}

function SidePanel({ conv }: { conv: Conversation }) {
  const contact = useLookup('contacts').get(conv.contactId);
  const lead = useOrgList('leads').find((l) => l.id === conv.leadId);
  const props = useOrgList('properties');
  if (!contact) return null;
  const suggestions = lead ? props.filter((p) => p.status === 'active' && p.verified && lead.locations.includes(p.locality)).slice(0, 3) : [];
  return (
    <aside className="inbox-side">
      <div className="row" style={{ gap: 10 }}>
        <Avatar name={contact.name} size="lg" />
        <div>
          <b>{contact.name}</b>
          <div className="faint" style={{ fontSize: 12 }}>{contact.email}</div>
        </div>
      </div>
      {lead && (
        <section>
          <h4 className="section-title">Lead</h4>
          <KV items={[
            ['Status', <LeadStatusBadge key="s" status={lead.status} />],
            ['Budget', lead.budgetMax ? money(lead.budgetMax) : <span className="faint">Unknown</span>],
            ['Looking in', lead.locations.join(', ') || <span className="faint">Unknown</span>],
            ['Owner', <MemberChip key="o" id={lead.assignedTo} />],
          ]} />
          <Button size="sm" className="mt-12" icon={<UserRound size={14} />} onClick={() => navigate('leads', { id: lead.id })}>Open lead</Button>
        </section>
      )}
      <section>
        <h4 className="section-title">Consent</h4>
        <div className="stack stack-sm">
          {(['whatsapp', 'sms', 'email', 'phone'] as const).map((ch) => (
            <div key={ch} className="row" style={{ fontSize: 13 }}>
              <span className="faint">{CHANNEL_ICON[ch]}</span>
              <span className="grow">{CHANNEL_LABEL[ch]}</span>
              <ConsentBadge state={contact.consents[ch]} />
            </div>
          ))}
        </div>
      </section>
      {suggestions.length > 0 && (
        <section>
          <h4 className="section-title"><Sparkles size={12} /> Verified matches</h4>
          <div className="stack stack-sm">
            {suggestions.map((p) => (
              <button key={p.id} className="card list-row" style={{ boxShadow: 'none', padding: 10 }} onClick={() => navigate('properties', { id: p.id })}>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="truncate" style={{ fontSize: 13, fontWeight: 500 }}>{p.title}</div>
                  <div className="faint" style={{ fontSize: 12 }}>{money(p.price)} · {p.locality}</div>
                </div>
              </button>
            ))}
          </div>
        </section>
      )}
      <section>
        <h4 className="section-title">Automation</h4>
        <div className="faint" style={{ fontSize: 12.5 }}>
          {conv.owner === 'ai' ? 'AI may reply within policy. Replies that need approval go to the Approvals queue.' : conv.owner === 'human' ? 'Human-owned. AI stays paused until someone resumes it.' : 'Unassigned. No automated replies.'}
        </div>
        {conv.owner === 'ai' && <Badge tone="accent" className="mt-8">AI Follow-Up Agent · approval required</Badge>}
      </section>
    </aside>
  );
}
