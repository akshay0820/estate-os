import { useEffect, useState, type ReactNode } from 'react';
import { ArrowRight, Building, Database, Loader2, LogOut, Mail, MailCheck, RefreshCw, ShieldCheck, Sparkles } from 'lucide-react';
import { Button, Field, Input, Select } from '@/components/ui';
import { backendConfigured } from '@/backend/client';
import { toApiError } from '@/backend/errors';
import {
  acceptInvitationById,
  afterSignIn,
  captureInviteToken,
  createOrganization,
  myInvitations,
  requestPasswordReset,
  signIn,
  signOut,
  signUp,
  startAuth,
  updatePassword,
  useAuth,
} from '@/backend/session';
import { ROLE_LABEL } from '@/lib/permissions';
import type { Role } from '@/store/types';

const DEMO_KEY = 'estate-os:demo-acknowledged';

/** Renders the app only when there is a verified session and a selected workspace (or explicit demo mode). */
export function AuthGate({ children }: { children: ReactNode }) {
  if (!backendConfigured) return <DemoGate>{children}</DemoGate>;
  return <LiveGate>{children}</LiveGate>;
}

function DemoGate({ children }: { children: ReactNode }) {
  const [ok, setOk] = useState(() => {
    try {
      return localStorage.getItem(DEMO_KEY) === '1';
    } catch {
      return false;
    }
  });
  if (ok) return <>{children}</>;
  return (
    <Frame foot={false}>
      <span className="icon-chip accent" style={{ width: 40, height: 40, borderRadius: 12 }}><Database size={18} /></span>
      <h1 className="auth-title">Not connected to a backend</h1>
      <p className="auth-sub">
        This build has no Supabase project configured, so nothing can be saved to a server. You can explore the product with
        <b> sample data that lives only in this browser</b>, or connect a backend first.
      </p>
      <div className="code" style={{ marginTop: 6 }}><span>VITE_SUPABASE_URL · VITE_SUPABASE_PUBLISHABLE_KEY</span></div>
      <p className="faint" style={{ fontSize: 12.5 }}>Set both in <span className="mono">frontend/.env.local</span> and restart — see docs/LOCAL_DEVELOPMENT.md.</p>
      <Button variant="primary" icon={<Sparkles size={15} />} onClick={() => { try { localStorage.setItem(DEMO_KEY, '1'); } catch { /* ignore */ } setOk(true); }}>
        Explore with sample data
      </Button>
    </Frame>
  );
}

function LiveGate({ children }: { children: ReactNode }) {
  const phase = useAuth((s) => s.phase);
  useEffect(() => {
    captureInviteToken();
    startAuth();
  }, []);
  if (phase === 'ready') return <>{children}</>;
  if (phase === 'loading' || phase === 'loading_org') return <Loading />;
  if (phase === 'recovery') return <ResetPassword />;
  if (phase === 'onboarding') return <Onboarding />;
  if (phase === 'error') return <ErrorScreen />;
  return <SignInFlow />;
}

function Frame({ children, wide, foot = true }: { children: ReactNode; wide?: boolean; foot?: boolean }) {
  return (
    <div className="auth-wrap">
      <div className="auth-brand">
        <span className="sb-logo" aria-hidden>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M3 21V10.5L12 3l9 7.5V21h-6.5v-6h-5v6z" /></svg>
        </span>
        <div className="sb-name">Estate OS<small>by BlazeReach</small></div>
      </div>
      <main className="card auth-card" style={wide ? { width: 'min(560px, 100%)' } : undefined}>{children}</main>
      {foot && <p className="faint auth-foot"><ShieldCheck size={12} /> Each agency's data is isolated. Access is checked by the server on every request.</p>}
    </div>
  );
}

function Loading() {
  return (
    <div className="auth-wrap" aria-busy="true">
      <Loader2 size={22} className="spin" style={{ animation: 'spin .8s linear infinite', color: 'var(--text-3)' }} />
      <p className="faint" style={{ marginTop: 12 }}>Loading your workspace…</p>
    </div>
  );
}

function ErrorScreen() {
  const error = useAuth((s) => s.error);
  return (
    <Frame>
      <h1 className="auth-title">We couldn’t load your workspace</h1>
      <p className="auth-sub">{error ?? 'Something went wrong.'}</p>
      <div className="row">
        <Button variant="primary" icon={<RefreshCw size={15} />} onClick={() => void afterSignIn()}>Try again</Button>
        <Button icon={<LogOut size={15} />} onClick={() => void signOut()}>Sign out</Button>
      </div>
    </Frame>
  );
}

type Mode = 'signin' | 'signup' | 'forgot' | 'check_email' | 'reset_sent';

function SignInFlow() {
  const notice = useAuth((s) => s.notice);
  const [mode, setMode] = useState<Mode>('signin');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invited = !!sessionStorage.getItem('estate-os:invite');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) return setError('Enter a valid email address.');
    if (mode === 'signup') {
      if (name.trim().length < 2) return setError('Tell us your name.');
      if (password.length < 8 || !/[a-zA-Z]/.test(password) || !/\d/.test(password)) return setError('Use at least 8 characters with letters and numbers.');
    }
    if (mode === 'signin' && !password) return setError('Enter your password.');
    setBusy(true);
    try {
      if (mode === 'signin') await signIn(email, password);
      else if (mode === 'signup') {
        const r = await signUp(name, email, password);
        if (r.needsConfirmation) setMode('check_email');
      } else if (mode === 'forgot') {
        await requestPasswordReset(email);
        setMode('reset_sent');
      }
    } catch (err) {
      setError(toApiError(err).message);
    } finally {
      setBusy(false);
    }
  };

  if (mode === 'check_email' || mode === 'reset_sent') {
    return (
      <Frame>
        <span className="icon-chip accent" style={{ width: 40, height: 40, borderRadius: 12 }}><MailCheck size={18} /></span>
        <h1 className="auth-title">Check your inbox</h1>
        <p className="auth-sub">
          {mode === 'check_email'
            ? <>We sent a confirmation link to <b>{email}</b>. Open it on this device to finish creating your account.</>
            : <>If an account exists for <b>{email}</b>, a reset link is on its way.</>}
        </p>
        <Button onClick={() => setMode('signin')}>Back to sign in</Button>
      </Frame>
    );
  }

  return (
    <Frame>
      <h1 className="auth-title">{mode === 'signin' ? <>Welcome <span className="serif">back</span></> : mode === 'signup' ? 'Create your account' : 'Reset your password'}</h1>
      <p className="auth-sub">
        {invited ? 'You’ve been invited to a workspace. Sign in or create an account with the invited email to join.' : mode === 'forgot' ? 'We’ll email you a link to choose a new password.' : mode === 'signup' ? 'Create your login, then set up your agency’s workspace.' : 'Sign in to your agency’s workspace.'}
      </p>
      {notice && <div className="banner info">{notice}</div>}
      <form className="stack" onSubmit={submit} noValidate>
        {mode === 'signup' && <Field label="Full name"><Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" data-autofocus /></Field>}
        <Field label="Work email"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" autoFocus={mode !== 'signup'} /></Field>
        {mode !== 'forgot' && (
          <Field label="Password" hint={mode === 'signup' ? 'At least 8 characters, with letters and numbers.' : undefined}>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} />
          </Field>
        )}
        {error && <div className="banner danger" role="alert">{error}</div>}
        <Button type="submit" variant="primary" loading={busy} icon={mode === 'forgot' ? <Mail size={15} /> : <ArrowRight size={15} />}>
          {mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Send reset link'}
        </Button>
      </form>
      <div className="row row-between" style={{ fontSize: 13 }}>
        {mode === 'signin' ? (
          <>
            <button className="link" onClick={() => { setMode('forgot'); setError(null); }}>Forgot password?</button>
            <button className="link" onClick={() => { setMode('signup'); setError(null); }}>Create an account</button>
          </>
        ) : (
          <button className="link" onClick={() => { setMode('signin'); setError(null); }}>Back to sign in</button>
        )}
      </div>
    </Frame>
  );
}

function ResetPassword() {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Frame>
      <h1 className="auth-title">Choose a new password</h1>
      <form className="stack" noValidate onSubmit={async (e) => {
        e.preventDefault();
        if (password.length < 8 || !/[a-zA-Z]/.test(password) || !/\d/.test(password)) return setError('Use at least 8 characters with letters and numbers.');
        if (password !== confirm) return setError('Passwords don’t match.');
        setBusy(true);
        try {
          await updatePassword(password);
        } catch (err) {
          setError(toApiError(err).message);
        } finally {
          setBusy(false);
        }
      }}>
        <Field label="New password"><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" autoFocus /></Field>
        <Field label="Confirm password"><Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" /></Field>
        {error && <div className="banner danger" role="alert">{error}</div>}
        <Button type="submit" variant="primary" loading={busy}>Save password</Button>
      </form>
    </Frame>
  );
}

function Onboarding() {
  const email = useAuth((s) => s.email);
  const [invites, setInvites] = useState<Awaited<ReturnType<typeof myInvitations>> | null>(null);
  const [name, setName] = useState('');
  const [city, setCity] = useState('');
  const [tz, setTz] = useState('Asia/Kolkata');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    myInvitations().then(setInvites).catch(() => setInvites([]));
  }, []);
  return (
    <Frame wide>
      <h1 className="auth-title">Set up your <span className="serif">workspace</span></h1>
      <p className="auth-sub">Signed in as <b>{email}</b>. Create your agency’s workspace, or join one you were invited to.</p>
      {invites && invites.length > 0 && (
        <section className="stack stack-sm">
          <h4 className="section-title">Invitations</h4>
          {invites.map((i) => (
            <div key={i.id} className="card list-row" style={{ boxShadow: 'none' }}>
              <span className="icon-chip"><Building size={14} /></span>
              <div className="grow"><b>{i.organization_name}</b><div className="faint" style={{ fontSize: 12 }}>as {ROLE_LABEL[i.role as Role] ?? i.role}</div></div>
              <Button size="sm" variant="primary" onClick={async () => {
                setBusy(true);
                try { await acceptInvitationById(i.id); } catch (err) { setError(toApiError(err).message); } finally { setBusy(false); }
              }}>Join</Button>
            </div>
          ))}
        </section>
      )}
      <form className="stack" noValidate onSubmit={async (e) => {
        e.preventDefault();
        if (name.trim().length < 2) return setError('Give your agency a name (at least 2 characters).');
        setBusy(true);
        setError(null);
        try {
          await createOrganization(name, city, tz);
        } catch (err) {
          setError(toApiError(err).message);
        } finally {
          setBusy(false);
        }
      }}>
        <h4 className="section-title">New workspace</h4>
        <div className="form-grid">
          <Field label="Agency name" className="full"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Skyline Realty" autoFocus /></Field>
          <Field label="City"><Input value={city} onChange={(e) => setCity(e.target.value)} placeholder="Mumbai" /></Field>
          <Field label="Time zone">
            <Select value={tz} onChange={(e) => setTz(e.target.value)}>
              {['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London'].map((t) => <option key={t}>{t}</option>)}
            </Select>
          </Field>
        </div>
        {error && <div className="banner danger" role="alert">{error}</div>}
        <div className="row">
          <Button type="submit" variant="primary" loading={busy}>Create workspace</Button>
          <Button type="button" variant="ghost" icon={<LogOut size={14} />} onClick={() => void signOut()}>Sign out</Button>
        </div>
      </form>
    </Frame>
  );
}
