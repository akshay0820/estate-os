import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Bell,
  Check,
  CornerDownLeft,
  LogOut,
  Menu as MenuIcon,
  Moon,
  OctagonPause,
  PanelLeftClose,
  PanelLeftOpen,
  RotateCcw,
  Search,
  Sun,
  UserCog,
  Zap,
} from 'lucide-react';
import { NAV, NAV_FLAT, PAGE_TITLE } from './nav';
import { Brand } from './Brand';
import { Avatar, Button, Menu, Switch } from '@/components/ui';
import { confirm } from '@/components/dialogs';
import { LIVE, useStore } from '@/store/store';
import { APP_ENV } from '@/backend/client';
import { actions, attempt, ok } from '@/data/actions';
import { signOut, useAuth } from '@/backend/session';
import { useUi, toast } from '@/store/ui';
import { useCan, useMe, useOrg, useOrgList } from '@/store/hooks';
import { can, ROLE_DESC, ROLE_LABEL } from '@/lib/permissions';
import { navigate } from '@/lib/router';
import { cx } from '@/lib/util';
import { relTime } from '@/lib/format';
import type { Role } from '@/store/types';

export function Shell({ page, children }: { page: string; children: ReactNode }) {
  const collapsed = useUi((s) => s.collapsed);
  const mobileOpen = useUi((s) => s.mobileOpen);
  const setMobileOpen = useUi((s) => s.setMobileOpen);
  const setCmd = useUi((s) => s.setCmd);

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmd(!useUi.getState().cmdOpen);
      }
      if (e.key === '/' && !(e.target as HTMLElement).closest('input, textarea, select, [contenteditable]')) {
        e.preventDefault();
        setCmd(true);
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [setCmd]);

  useEffect(() => setMobileOpen(false), [page, setMobileOpen]);

  return (
    <div className="app" data-collapsed={collapsed} data-mobile-open={mobileOpen}>
      <div className="sb-scrim" onClick={() => setMobileOpen(false)} />
      <Sidebar page={page} />
      <div className="main">
        <Topbar page={page} />
        <main className="content" id="main">
          {children}
        </main>
      </div>
      <CommandPalette />
    </div>
  );
}

/* ─────────── Sidebar ─────────── */

function Sidebar({ page }: { page: string }) {
  const collapsed = useUi((s) => s.collapsed);
  const setCollapsed = useUi((s) => s.setCollapsed);
  const me = useMe();
  const org = useOrg();
  const approvals = useOrgList('approvals');
  const conversations = useOrgList('conversations');
  const tasks = useOrgList('tasks');
  const canKill = useCan('outbound.kill');

  const counts: Record<string, number | undefined> = {
    approvals: approvals.filter((a) => a.status === 'pending').length || undefined,
    inbox: conversations.reduce((s, c) => s + c.unread, 0) || undefined,
    tasks: tasks.filter((t) => t.assignedTo === me.id && t.status !== 'completed' && t.status !== 'cancelled' && t.dueAt < Date.now()).length || undefined,
  };

  const toggleKill = async (v: boolean) => {
    if (v) {
      const r = await confirm({
        title: 'Pause all outbound communication?',
        body: 'Every AI and workflow call or message stops immediately. Queued work is cancelled and will re-check policy when resumed. People can still reply manually.',
        confirmLabel: 'Pause outbound',
        danger: true,
      });
      if (!r.ok) return;
    }
    if (!(await ok(() => actions.setOutboundPaused(org, v)))) return;
    toast({ kind: v ? 'warning' : 'success', title: v ? 'Outbound paused' : 'Outbound resumed', body: v ? 'Kill switch engaged for this organization.' : 'Queued work will re-check policy before sending.' });
  };

  return (
    <nav className="sidebar" aria-label="Primary">
      <div className="sb-brand">
        <Brand />
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          className="sb-collapse desktop-only"
          icon={collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        />
      </div>
      <div className="sb-scroll">
        {NAV.map((section) => {
          const items = section.items.filter((i) => !i.cap || can(me.role, i.cap));
          if (!items.length) return null;
          return (
            <div className="sb-section" key={section.section}>
              <div className="sb-label">{section.section}</div>
              {items.map((item) => {
                const Icon = item.icon;
                const count = counts[item.key];
                return (
                  <a
                    key={item.key}
                    href={`#/${item.key}`}
                    className={cx('sb-item', page === item.key && 'active')}
                    aria-current={page === item.key ? 'page' : undefined}
                    title={collapsed ? item.label : undefined}
                  >
                    <Icon size={16} strokeWidth={1.8} />
                    <span>{item.label}</span>
                    {count != null && (item.key === 'approvals' ? <i className="pip" aria-label={`${count} pending`} /> : <span className="count">{count}</span>)}
                  </a>
                );
              })}
            </div>
          );
        })}
      </div>
      <div className="sb-footer">
        {canKill && !collapsed ? (
          <div className={cx('sb-kill', org.outboundPaused && 'on')}>
            <OctagonPause size={16} />
            <div className="grow sb-footer-text">
              <div style={{ fontWeight: 600 }}>{org.outboundPaused ? 'Outbound paused' : 'Outbound live'}</div>
              <div style={{ fontSize: 11.5, opacity: 0.75 }}>Global kill switch</div>
            </div>
            <Switch on={org.outboundPaused} onChange={toggleKill} danger label="Pause all outbound" />
          </div>
        ) : (
          <div className="row" style={{ justifyContent: 'center' }} title={org.outboundPaused ? 'Outbound paused' : 'Outbound live'}>
            <span className={cx('status-dot', !org.outboundPaused && 'live')} style={org.outboundPaused ? { background: 'var(--blaze)' } : undefined} />
          </div>
        )}
      </div>
    </nav>
  );
}

/* ─────────── Topbar ─────────── */

function Topbar({ page }: { page: string }) {
  const theme = useUi((s) => s.theme);
  const toggleTheme = useUi((s) => s.toggleTheme);
  const setCmd = useUi((s) => s.setCmd);
  const setMobileOpen = useUi((s) => s.setMobileOpen);
  const org = useOrg();
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 4);
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);
  const section = NAV_FLAT.find((n) => n.key === page)?.section;
  return (
    <header className={cx('topbar', scrolled && 'scrolled')}>
      <Button variant="ghost" size="sm" iconOnly className="mobile-only" icon={<MenuIcon size={18} />} onClick={() => setMobileOpen(true)} aria-label="Open navigation" />
      <div className="crumbs">
        <span className="desktop-only">{org.name}</span>
        <span className="desktop-only">/</span>
        {section && <span className="desktop-only">{section}</span>}
        {section && <span className="desktop-only">/</span>}
        <b className="truncate">{PAGE_TITLE[page] ?? 'Not found'}</b>
      </div>
      <div className="ml-auto row" style={{ gap: 6 }}>
        {!LIVE && (
          <span className="demo-pill desktop-only" title="Sample data stored only in this browser — not connected to a backend">
            Demo data
          </span>
        )}
        {LIVE && APP_ENV !== 'production' && (
          <span className="demo-pill" title="Not the production environment: test data only">
            {APP_ENV === 'staging' ? 'Staging' : APP_ENV} — test data
          </span>
        )}
        {org.outboundPaused && (
          <span className="badge badge-danger desktop-only" title="Global kill switch engaged">
            <OctagonPause size={12} /> Outbound paused
          </span>
        )}
        <button className="search-trigger" onClick={() => setCmd(true)} aria-label="Search (Ctrl K)">
          <Search size={15} />
          <span className="label">Search leads, properties…</span>
          <span className="kbd">Ctrl K</span>
        </button>
        <Button
          variant="ghost"
          iconOnly
          icon={theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
        />
        <Notifications />
        <AccountMenu />
      </div>
    </header>
  );
}

function Notifications() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const all = useOrgList('notifications');
  const list = useMemo(() => [...all].sort((a, b) => b.at - a.at).slice(0, 30), [all]);
  const unread = list.filter((n) => !n.read).length;
  const mark = (id: string) => void attempt(() => actions.markNotification(id));
  const markAll = () => void attempt(() => actions.markAllNotifications());
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const dotColor: Record<string, string> = { failure: 'var(--blaze)', approval: 'var(--amber)', lead: 'var(--ember)', appointment: 'var(--sky)', task: 'var(--text-3)', system: 'var(--text-3)' };
  return (
    <div className="menu-anchor" ref={ref}>
      <span className="icon-btn-badge">
        <Button variant="ghost" iconOnly icon={<Bell size={17} />} onClick={() => setOpen((o) => !o)} aria-label={`Notifications, ${unread} unread`} aria-expanded={open} />
        {unread > 0 && <span className="badge-count">{unread}</span>}
      </span>
      {open && (
        <div className="panel" role="dialog" aria-label="Notifications">
          <div className="row" style={{ padding: '14px 16px 10px' }}>
            <b style={{ fontSize: 14 }}>Notifications</b>
            {unread > 0 && <span className="badge badge-accent">{unread} new</span>}
            <button className="text-btn ml-auto" onClick={markAll} disabled={!unread}>
              <Check size={13} /> Mark all read
            </button>
          </div>
          <div style={{ overflowY: 'auto', borderTop: '1px solid var(--border-soft)' }}>
            {list.length === 0 && <div className="empty"><div className="empty-title">You're all caught up</div></div>}
            {list.map((n) => (
              <button
                key={n.id}
                className="list-row"
                style={{ alignItems: 'flex-start', padding: '12px 16px', background: n.read ? undefined : 'color-mix(in srgb, var(--accent-soft) 60%, transparent)' }}
                onClick={() => {
                  mark(n.id);
                  if (n.link) navigate(n.link);
                  setOpen(false);
                }}
              >
                <span className="status-dot" style={{ background: dotColor[n.kind], marginTop: 6 }} />
                <span className="grow">
                  <span style={{ display: 'block', fontWeight: n.read ? 500 : 600, fontSize: 13 }}>{n.title}</span>
                  <span className="faint" style={{ display: 'block', fontSize: 12.5, marginTop: 2 }}>{n.body}</span>
                </span>
                <span className="faint mono" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{relTime(n.at)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function AccountMenu() {
  return LIVE ? <LiveAccountMenu /> : <DemoAccountMenu />;
}

function LiveAccountMenu() {
  const me = useMe();
  const email = useAuth((s) => s.email);
  const theme = useUi((s) => s.theme);
  const toggleTheme = useUi((s) => s.toggleTheme);
  return (
    <Menu
      width={260}
      trigger={(p) => (
        <button {...p} className="row" style={{ gap: 8, padding: '3px 4px', borderRadius: 999 }} aria-label="Account menu">
          <Avatar name={me.name || email || '?'} hue={me.hue} />
        </button>
      )}
      items={[
        { heading: `${me.name || email} · ${ROLE_LABEL[me.role]}` },
        { label: theme === 'dark' ? 'Light mode' : 'Dark mode', icon: theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />, onSelect: toggleTheme },
        'sep',
        {
          label: 'Sign out',
          icon: <LogOut size={14} />,
          danger: true,
          onSelect: async () => {
            await signOut();
            toast({ kind: 'info', title: 'Signed out' });
          },
        },
      ]}
    />
  );
}

function DemoAccountMenu() {
  const me = useMe();
  const realRole = useStore((s) => s.members.find((m) => m.id === me.id)?.role ?? me.role);
  const override = useStore((s) => s.session.roleOverride);
  const setRole = useStore((s) => s.setRoleOverride);
  const reset = useStore((s) => s.resetDemo);
  const theme = useUi((s) => s.theme);
  const toggleTheme = useUi((s) => s.toggleTheme);
  const roles: Role[] = ['owner', 'admin', 'manager', 'agent', 'operations', 'finance', 'viewer'];
  return (
    <Menu
      width={260}
      trigger={(p) => (
        <button {...p} className="row" style={{ gap: 8, padding: '3px 4px', borderRadius: 999 }} aria-label="Account menu">
          <Avatar name={me.name} hue={me.hue} />
        </button>
      )}
      items={[
        { heading: `${me.name} · ${ROLE_LABEL[me.role]}${override ? ' (preview)' : ''}` },
        { heading: 'View as role (demo only)' },
        ...roles.map((r) => ({
          label: ROLE_LABEL[r],
          icon: <UserCog size={14} />,
          checked: me.role === r,
          hint: ROLE_DESC[r],
          onSelect: () => {
            setRole(r === realRole ? null : r);
            toast({ kind: 'info', title: `Viewing as ${ROLE_LABEL[r]}`, body: 'Navigation and actions adapt to this role’s capabilities.' });
          },
        })),
        'sep',
        { label: theme === 'dark' ? 'Light mode' : 'Dark mode', icon: theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />, onSelect: toggleTheme },
        { label: 'Simulate inbound lead', icon: <Zap size={14} />, onSelect: () => void useStore.getState().simulateInboundLead() },
        {
          label: 'Reset demo data',
          icon: <RotateCcw size={14} />,
          onSelect: async () => {
            const r = await confirm({ title: 'Reset demo data?', body: 'All changes you made in this browser are discarded and fresh sample data is generated.', confirmLabel: 'Reset', danger: true });
            if (r.ok) {
              reset();
              navigate('dashboard');
              toast({ kind: 'success', title: 'Demo data reset' });
            }
          },
        },
        'sep',
        {
          label: 'Leave demo',
          icon: <LogOut size={14} />,
          danger: true,
          onSelect: () => {
            try { localStorage.removeItem('estate-os:demo-acknowledged'); } catch { /* ignore */ }
            location.reload();
          },
        },
      ]}
    />
  );
}

/* ─────────── Command palette ─────────── */

interface Cmd {
  id: string;
  label: string;
  hint: string;
  group: string;
  icon?: ReactNode;
  run: () => void;
}

function CommandPalette() {
  const open = useUi((s) => s.cmdOpen);
  const setCmd = useUi((s) => s.setCmd);
  if (!open) return null;
  return <PaletteInner close={() => setCmd(false)} />;
}

function PaletteInner({ close }: { close: () => void }) {
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const me = useMe();
  const leads = useOrgList('leads');
  const properties = useOrgList('properties');
  const contacts = useOrgList('contacts');
  const deals = useOrgList('deals');
  const toggleTheme = useUi((s) => s.toggleTheme);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo<Cmd[]>(() => {
    const term = q.trim().toLowerCase();
    const pages: Cmd[] = NAV_FLAT.filter((n) => !n.cap || can(me.role, n.cap)).map((n) => ({ id: `p-${n.key}`, label: n.label, hint: n.section, group: 'Go to', icon: <n.icon size={15} />, run: () => navigate(n.key) }));
    const actions: Cmd[] = [
      { id: 'a-lead', label: 'Create lead', hint: 'Action', group: 'Actions', run: () => navigate('leads', { new: '1' }) },
      { id: 'a-prop', label: 'Add property', hint: 'Action', group: 'Actions', run: () => navigate('properties', { new: '1' }) },
      { id: 'a-appt', label: 'Book appointment', hint: 'Action', group: 'Actions', run: () => navigate('appointments', { new: '1' }) },
      { id: 'a-task', label: 'New task', hint: 'Action', group: 'Actions', run: () => navigate('tasks', { new: '1' }) },
      ...(LIVE ? [] : [{ id: 'a-sim', label: 'Simulate inbound lead (demo)', hint: 'Action', group: 'Actions', run: () => void useStore.getState().simulateInboundLead() }]),
      { id: 'a-theme', label: 'Toggle light / dark mode', hint: 'Action', group: 'Actions', run: toggleTheme },
    ];
    if (!term) return [...actions, ...pages];
    const match = (s: string) => s.toLowerCase().includes(term);
    const out: Cmd[] = [
      ...actions.filter((a) => match(a.label)),
      ...pages.filter((p) => match(p.label)),
      ...leads.filter((l) => !l.archived && (match(l.name) || l.locations.some(match))).slice(0, 6).map((l) => ({ id: l.id, label: l.name, hint: `Lead · ${l.status.replace(/_/g, ' ')}`, group: 'Leads', run: () => navigate('leads', { id: l.id }) })),
      ...contacts.filter((c) => match(c.name) || match(c.phone) || match(c.email)).slice(0, 4).map((c) => ({ id: c.id, label: c.name, hint: `Contact · ${c.phone}`, group: 'Contacts', run: () => navigate('contacts', { id: c.id }) })),
      ...properties.filter((p) => match(p.title) || match(p.locality) || match(p.ref)).slice(0, 5).map((p) => ({ id: p.id, label: p.title, hint: `${p.ref} · ${p.locality}`, group: 'Properties', run: () => navigate('properties', { id: p.id }) })),
      ...deals.filter((d) => match(d.title)).slice(0, 4).map((d) => ({ id: d.id, label: d.title, hint: `Deal · ${d.stage}`, group: 'Deals', run: () => navigate('deals', { id: d.id }) })),
    ];
    return out;
  }, [q, me.role, leads, contacts, properties, deals, toggleTheme]);

  useEffect(() => setIdx(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector('.cmdk-item.on')?.scrollIntoView({ block: 'nearest' });
  }, [idx]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIdx((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter' && results[idx]) {
      results[idx].run();
      close();
    } else if (e.key === 'Escape') close();
  };

  let lastGroup = '';
  return (
    <>
      <div className="overlay" onClick={close} />
      <div className="cmdk" role="dialog" aria-label="Command palette">
        <div className="cmdk-input">
          <Search size={17} className="faint" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder="Search or jump to…" aria-label="Search" />
          <span className="kbd">Esc</span>
        </div>
        <div className="cmdk-list" ref={listRef}>
          {results.length === 0 && <div className="empty" style={{ padding: 32 }}><div className="empty-title">No results for “{q}”</div></div>}
          {results.map((r, i) => {
            const header = r.group !== lastGroup ? r.group : null;
            lastGroup = r.group;
            return (
              <div key={r.id}>
                {header && <div className="menu-label">{header}</div>}
                <button
                  className={cx('cmdk-item', i === idx && 'on')}
                  onMouseMove={() => setIdx(i)}
                  onClick={() => {
                    r.run();
                    close();
                  }}
                >
                  <span className="faint">{r.icon ?? <CornerDownLeft size={14} />}</span>
                  <span className="truncate">{r.label}</span>
                  <span className="hint">{r.hint}</span>
                </button>
              </div>
            );
          })}
        </div>
        <div className="row faint" style={{ padding: '9px 14px', borderTop: '1px solid var(--border-soft)', fontSize: 12, gap: 14 }}>
          <span className="row" style={{ gap: 5 }}><span className="kbd">↑</span><span className="kbd">↓</span> navigate</span>
          <span className="row" style={{ gap: 5 }}><span className="kbd">↵</span> open</span>
          <span className="row ml-auto" style={{ gap: 5 }}><span className="kbd">/</span> anywhere to search</span>
        </div>
      </div>
    </>
  );
}
