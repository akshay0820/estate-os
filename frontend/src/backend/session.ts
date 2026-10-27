// Authentication and workspace selection for live mode.
import { create } from 'zustand';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { useStore } from '@/store/store';
import { supabase } from './client';
import { ApiError, check, toApiError } from './errors';
import { loadMembers, loadOrganizations, refresh } from './live';

export type Phase = 'loading' | 'signed_out' | 'recovery' | 'onboarding' | 'loading_org' | 'ready' | 'error';

export interface MembershipSummary {
  orgId: string;
  role: string;
}

interface AuthState {
  phase: Phase;
  userId: string | null;
  email: string | null;
  name: string;
  memberships: MembershipSummary[];
  error: string | null;
  notice: string | null;
}

export const useAuth = create<AuthState>(() => ({
  phase: 'loading',
  userId: null,
  email: null,
  name: '',
  memberships: [],
  error: null,
  notice: null,
}));

const ORG_KEY = 'estate-os:last-org';
let started = false;

export function startAuth() {
  if (started) return;
  started = true;
  const sb = supabase();
  sb.auth.onAuthStateChange((event: AuthChangeEvent, session: Session | null) => {
    // Defer: Supabase recommends not awaiting other calls inside this callback.
    setTimeout(() => void onAuth(event, session), 0);
  });
}

async function onAuth(event: AuthChangeEvent, session: Session | null) {
  if (event === 'PASSWORD_RECOVERY') {
    useAuth.setState({ phase: 'recovery', userId: session?.user.id ?? null, email: session?.user.email ?? null });
    return;
  }
  if (!session) {
    const expired = useAuth.getState().userId !== null && event === 'SIGNED_OUT' && !manualSignOut;
    manualSignOut = false;
    clearWorkspace();
    useAuth.setState({ phase: 'signed_out', userId: null, email: null, memberships: [], notice: expired ? 'Your session ended. Please sign in again.' : null });
    return;
  }
  if (event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') return;
  const { phase, userId } = useAuth.getState();
  if ((phase === 'ready' || phase === 'loading_org') && userId === session.user.id) return;
  useAuth.setState({
    userId: session.user.id,
    email: session.user.email ?? null,
    name: (session.user.user_metadata?.full_name as string) ?? '',
    error: null,
  });
  await afterSignIn();
}

export async function afterSignIn() {
  const { userId } = useAuth.getState();
  if (!userId) return;
  useAuth.setState({ phase: 'loading_org' });
  try {
    // Accept a pending invitation link if the user arrived through one.
    const token = pendingInviteToken();
    if (token) {
      try {
        const orgId = check(await supabase().rpc('accept_invitation', { p_token: token })) as string;
        localStorage.setItem(ORG_KEY, orgId);
        useAuth.setState({ notice: 'Invitation accepted.' });
      } catch (e) {
        useAuth.setState({ notice: toApiError(e).message });
      } finally {
        sessionStorage.removeItem('estate-os:invite');
      }
    }
    const rows = check(await supabase().from('organization_memberships').select('organization_id, role').eq('user_id', userId).eq('status', 'active'));
    const memberships = rows.map((r) => ({ orgId: r.organization_id as string, role: r.role as string }));
    useAuth.setState({ memberships });
    if (!memberships.length) {
      useAuth.setState({ phase: 'onboarding' });
      return;
    }
    await loadOrganizations(memberships.map((m) => m.orgId));
    const saved = localStorage.getItem(ORG_KEY);
    await selectOrg(memberships.find((m) => m.orgId === saved)?.orgId ?? memberships[0].orgId);
  } catch (e) {
    useAuth.setState({ phase: 'error', error: toApiError(e).message });
  }
}

/** The org id is only a selector; RLS still checks membership on every query. */
export async function selectOrg(orgId: string) {
  const { userId, memberships } = useAuth.getState();
  if (!memberships.some((m) => m.orgId === orgId)) throw new ApiError('FORBIDDEN', 'You are not a member of that workspace.');
  useAuth.setState({ phase: 'loading_org' });
  clearWorkspace(true);
  useStore.setState((s) => ({ session: { ...s.session, orgId, userId, roleOverride: null } }));
  try {
    await loadMembers(orgId);
    await refresh();
    localStorage.setItem(ORG_KEY, orgId);
    useAuth.setState({ phase: 'ready' });
  } catch (e) {
    useAuth.setState({ phase: 'error', error: toApiError(e).message });
  }
}

function clearWorkspace(keepOrgs = false) {
  useStore.setState((s) => ({
    orgs: keepOrgs ? s.orgs : [],
    members: [], contacts: [], leads: [], properties: [], deals: [], appointments: [], tasks: [], conversations: [], calls: [], agents: [],
    workflows: [], runs: [], approvals: [], followUps: [], integrations: [], webhookEvents: [], usage: [], commissions: [], expenses: [],
    documents: [], audit: [], activities: [], notifications: [], sources: [],
    session: { ...s.session, orgId: keepOrgs ? s.session.orgId : '', userId: keepOrgs ? s.session.userId : null },
  }));
}

/* ─────────── auth actions ─────────── */

export async function signIn(email: string, password: string) {
  const r = await supabase().auth.signInWithPassword({ email: email.trim(), password });
  if (r.error) throw new ApiError('UNAUTHENTICATED', authMessage(r.error.message));
}

export async function signUp(name: string, email: string, password: string) {
  const r = await supabase().auth.signUp({
    email: email.trim(),
    password,
    options: { data: { full_name: name.trim() }, emailRedirectTo: `${location.origin}${location.pathname}` },
  });
  if (r.error) throw new ApiError('VALIDATION_ERROR', authMessage(r.error.message));
  // With email confirmation enabled there is no session yet.
  return { needsConfirmation: !r.data.session };
}

let manualSignOut = false;
export async function signOut() {
  manualSignOut = true;
  await supabase().auth.signOut();
}

export async function requestPasswordReset(email: string) {
  // Same response whether or not the address exists (no account enumeration).
  await supabase().auth.resetPasswordForEmail(email.trim(), { redirectTo: `${location.origin}${location.pathname}` });
}

export async function updatePassword(password: string) {
  const r = await supabase().auth.updateUser({ password });
  if (r.error) throw new ApiError('VALIDATION_ERROR', authMessage(r.error.message));
  useAuth.setState({ phase: 'loading' });
  await afterSignIn();
}

export async function createOrganization(name: string, city: string, timezone: string) {
  const orgId = check(await supabase().rpc('create_organization', { p_name: name, p_city: city, p_timezone: timezone })) as string;
  localStorage.setItem(ORG_KEY, orgId);
  await afterSignIn();
}

export async function myInvitations() {
  return check(await supabase().rpc('my_invitations')) as { id: string; organization_id: string; organization_name: string; role: string; expires_at: string }[];
}

export async function acceptInvitationById(id: string) {
  const orgId = check(await supabase().rpc('accept_invitation_by_id', { p_invitation: id })) as string;
  localStorage.setItem(ORG_KEY, orgId);
  await afterSignIn();
}

/** Invite links look like #/invite?token=…; the token is kept for the session until sign-in. */
export function captureInviteToken() {
  const m = location.hash.match(/^#\/invite\?token=([0-9a-f]{64})$/);
  if (m) {
    sessionStorage.setItem('estate-os:invite', m[1]);
    history.replaceState(null, '', `${location.pathname}#/dashboard`);
  }
}

function pendingInviteToken() {
  return sessionStorage.getItem('estate-os:invite');
}

function authMessage(raw: string) {
  if (/invalid login credentials/i.test(raw)) return 'Email or password is incorrect.';
  if (/email not confirmed/i.test(raw)) return 'Confirm your email first — check your inbox for the link.';
  if (/password should be|weak password/i.test(raw)) return 'Choose a stronger password (at least 8 characters, mixing letters and numbers).';
  if (/already registered|already exists/i.test(raw)) return 'An account with this email already exists. Sign in instead.';
  if (/rate limit|too many/i.test(raw)) return 'Too many attempts. Wait a minute and try again.';
  return 'We couldn’t complete that request. Please try again.';
}
