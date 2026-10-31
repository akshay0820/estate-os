// The workspace assistant: a launcher in the corner and a chat panel. Answers come from lib/assistant (live Edge Function
// or the demo rules); every change it suggests is shown as a card and runs only when the user confirms it.
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUp, CalendarClock, CalendarPlus, Check, CheckCircle2, ClipboardList, Loader2, MessageSquareText, NotebookPen, PhoneCall, RotateCcw, Sparkles, Timer, UserRoundCog, Workflow, X, XCircle, type LucideIcon } from 'lucide-react';
import { useMe, useOrg } from '@/store/hooks';
import { LIVE } from '@/store/store';
import { toast, useUi } from '@/store/ui';
import { cx } from '@/lib/util';
import { ask, describeAction, runAction, type AssistantAction, type ChatTurn } from '@/lib/assistant';
import { EXAMPLES } from '@/lib/assistantDemo';

type CardState = { status: 'pending' | 'running' | 'done' | 'failed' | 'dismissed'; note?: string };
interface Msg { id: string; role: 'user' | 'assistant'; text: string; actions?: AssistantAction[]; error?: boolean }

const ICONS: Record<AssistantAction['kind'], LucideIcon> = {
  create_task: ClipboardList, complete_task: CheckCircle2, schedule_follow_up: Timer, update_lead_status: Workflow,
  assign_lead: UserRoundCog, add_note: NotebookPen, book_showing: CalendarPlus, move_deal: Workflow,
  call_lead: PhoneCall, request_follow_up: MessageSquareText, create_automation: CalendarClock,
};
const TITLES: Record<AssistantAction['kind'], string> = {
  create_task: 'Create task', complete_task: 'Complete task', schedule_follow_up: 'Schedule follow-up', update_lead_status: 'Change lead status',
  assign_lead: 'Assign lead', add_note: 'Add note', book_showing: 'Book showing', move_deal: 'Move deal',
  call_lead: 'AI call', request_follow_up: 'Draft follow-up', create_automation: 'Schedule automation',
};

let n = 0;
const mid = () => `m${Date.now().toString(36)}${(n++).toString(36)}`;

export function Assistant() {
  const open = useUi((s) => s.assistantOpen);
  const setOpen = useUi((s) => s.setAssistant);
  const org = useOrg();

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        setOpen(!useUi.getState().assistantOpen);
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [setOpen]);

  return (
    <>
      {!open && (
        <button className="ai-fab" onClick={() => setOpen(true)} aria-label="Ask Estate AI" title="Ask Estate AI (Ctrl J)">
          <Sparkles size={20} />
        </button>
      )}
      {/* Keyed by workspace so a conversation never carries over to another agency. */}
      {open && <Panel key={org?.id} onClose={() => setOpen(false)} />}
    </>
  );
}

function Panel({ onClose }: { onClose: () => void }) {
  const me = useMe();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [cards, setCards] = useState<Record<string, CardState>>({});
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => input.current?.focus(), []);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [msgs, busy]);
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(140, el.scrollHeight)}px`;
  }, [draft]);

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || busy) return;
    const next: Msg[] = [...msgs, { id: mid(), role: 'user', text: q }];
    setMsgs(next);
    setDraft('');
    setBusy(true);
    try {
      const turns: ChatTurn[] = next.filter((m) => !m.error).map((m) => ({ role: m.role, text: m.text }));
      const r = await ask(turns);
      setMsgs((cur) => [...cur, { id: mid(), role: 'assistant', text: r.reply, actions: r.actions, error: !!r.error }]);
      if (r.actions.length) setCards((c) => ({ ...c, ...Object.fromEntries(r.actions.map((a) => [a.id, { status: 'pending' as const }])) }));
    } catch {
      setMsgs((cur) => [...cur, { id: mid(), role: 'assistant', text: 'I couldn’t reach the assistant. Check your connection and try again.', error: true }]);
    } finally {
      setBusy(false);
      input.current?.focus();
    }
  };

  const confirm = async (a: AssistantAction) => {
    setCards((c) => ({ ...c, [a.id]: { status: 'running' } }));
    try {
      const note = await runAction(a);
      setCards((c) => ({ ...c, [a.id]: { status: 'done', note } }));
      // Tell the assistant what happened, so a follow-up question knows the change was made.
      setMsgs((cur) => [...cur, { id: mid(), role: 'user', text: `[Confirmed] ${a.summary}`, error: false }]);
      toast({ kind: 'success', title: TITLES[a.kind], body: note });
    } catch (e) {
      setCards((c) => ({ ...c, [a.id]: { status: 'failed', note: (e as Error).message || 'That didn’t work.' } }));
    }
  };

  const reset = () => {
    setMsgs([]);
    setCards({});
    input.current?.focus();
  };

  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  return (
    <aside className="ai-panel" role="dialog" aria-label="Estate AI assistant" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <header className="ai-head">
        <span className="ai-orb" aria-hidden><Sparkles size={15} /></span>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="ai-title">Estate AI {!LIVE && <span className="badge" style={{ marginLeft: 6 }}>Demo</span>}</div>
          <div className="ai-sub">Knows your workspace · asks before changing anything</div>
        </div>
        {msgs.length > 0 && <button className="btn btn-ghost btn-icon btn-sm" onClick={reset} aria-label="New conversation" title="New conversation"><RotateCcw size={15} /></button>}
        <button className="btn btn-ghost btn-icon btn-sm" onClick={onClose} aria-label="Close assistant" title="Close (Esc)"><X size={16} /></button>
      </header>

      <div className="ai-body" ref={scroller}>
        {msgs.length === 0 ? (
          <div className="ai-empty">
            <div className="ai-hello">{greet}, <span className="serif">{me.name.split(' ')[0]}</span></div>
            <p className="faint">Ask about your leads, listings, showings, tasks, deals or performance, or tell me what to set up.</p>
            <div className="ai-chips">
              {EXAMPLES.map((e) => <button key={e} className="ai-chip" onClick={() => void send(e)}>{e}</button>)}
            </div>
          </div>
        ) : (
          msgs.filter((m) => !m.text.startsWith('[Confirmed]')).map((m) => (
            <div key={m.id} className={cx('ai-msg', m.role, m.error && 'error')}>
              <div className="ai-bubble"><Rich text={m.text} /></div>
              {m.actions?.map((a) => <ActionCard key={a.id} a={a} state={cards[a.id] ?? { status: 'pending' }} onConfirm={() => void confirm(a)} onDismiss={() => setCards((c) => ({ ...c, [a.id]: { status: 'dismissed' } }))} />)}
            </div>
          ))
        )}
        {busy && <div className="ai-msg assistant"><div className="ai-bubble ai-typing" aria-label="Thinking"><i /><i /><i /></div></div>}
      </div>

      <form className="ai-compose" onSubmit={(e) => { e.preventDefault(); void send(draft); }}>
        <textarea
          ref={input}
          rows={1}
          value={draft}
          placeholder="Ask anything about your agency…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send(draft);
            }
          }}
          maxLength={2000}
          aria-label="Message the assistant"
        />
        <button type="submit" className="ai-send" disabled={!draft.trim() || busy} aria-label="Send">
          {busy ? <Loader2 size={16} className="spin" /> : <ArrowUp size={16} />}
        </button>
      </form>
    </aside>
  );
}

function ActionCard({ a, state, onConfirm, onDismiss }: { a: AssistantAction; state: CardState; onConfirm: () => void; onDismiss: () => void }) {
  const Icon = ICONS[a.kind];
  return (
    <div className={cx('ai-card', state.status)}>
      <div className="ai-card-head">
        <span className="icon-chip"><Icon size={14} /></span>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="ai-card-kind">{TITLES[a.kind]}</div>
          <div className="ai-card-summary">{a.summary}</div>
        </div>
      </div>
      <dl className="ai-card-rows">
        {describeAction(a).map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>)}
      </dl>
      {state.status === 'pending' && (
        <div className="ai-card-foot">
          <button className="btn btn-ghost btn-sm" onClick={onDismiss}>Dismiss</button>
          <button className="btn btn-accent btn-sm" onClick={onConfirm}><Check size={14} /> Confirm</button>
        </div>
      )}
      {state.status === 'running' && <div className="ai-card-note"><Loader2 size={13} className="spin" /> Working…</div>}
      {state.status === 'done' && <div className="ai-card-note ok"><CheckCircle2 size={13} /> {state.note}</div>}
      {state.status === 'failed' && <div className="ai-card-note bad"><XCircle size={13} /> {state.note}</div>}
      {state.status === 'dismissed' && <div className="ai-card-note">Dismissed. Nothing was changed.</div>}
    </div>
  );
}

/** Light formatting for replies: paragraphs, "- " bullet lists, **bold** and *italic*. No HTML is ever injected. */
function Rich({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) blocks.push(<ul key={`u${blocks.length}`}>{list.map((l, i) => <li key={i}>{inline(l)}</li>)}</ul>);
    list = [];
  };
  for (const line of text.split('\n')) {
    const b = line.match(/^\s*[-•*]\s+(.*)$/);
    if (b) { list.push(b[1]); continue; }
    flush();
    if (line.trim()) blocks.push(<p key={`p${blocks.length}`}>{inline(line)}</p>);
  }
  flush();
  return <>{blocks}</>;
}

function inline(s: string): ReactNode[] {
  return s.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g).filter(Boolean).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong>
      : part.startsWith('*') && part.endsWith('*') && part.length > 2 ? <em key={i}>{part.slice(1, -1)}</em>
      : <Fragment key={i}>{part}</Fragment>);
}
