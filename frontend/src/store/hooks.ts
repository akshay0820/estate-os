import { useMemo } from 'react';
import { can, type Capability } from '@/lib/permissions';
import { LIVE, useStore } from './store';
import type { OrgData } from './seed';
import type { Member } from './types';

const ME_EMAIL = 'aanya@skylinerealty.in';

// Least-privileged placeholder while a workspace is loading.
const GUEST: Member = { id: '', orgId: '', name: '', email: '', phone: '', role: 'viewer', title: '', status: 'active', hue: 0, localities: [], joinedAt: 0 };

/** Tenant-scoped list. Every list read goes through the active organization. */
export function useOrgList<K extends keyof OrgData>(key: K): OrgData[K] {
  const orgId = useStore((s) => s.session.orgId);
  const list = useStore((s) => s[key]) as unknown as { orgId: string }[];
  return useMemo(() => list.filter((x) => x.orgId === orgId), [list, orgId]) as unknown as OrgData[K];
}

export function useOrg() {
  const orgId = useStore((s) => s.session.orgId);
  const orgs = useStore((s) => s.orgs);
  return useMemo(() => orgs.find((o) => o.id === orgId)!, [orgs, orgId]);
}

export function useMe(): Member {
  const orgId = useStore((s) => s.session.orgId);
  const override = useStore((s) => s.session.roleOverride);
  const members = useStore((s) => s.members);
  const userId = useStore((s) => s.session.userId);
  return useMemo(() => {
    if (LIVE) {
      // Role comes from the verified membership; there is no role preview in live mode.
      return members.find((x) => x.id === userId && x.orgId === orgId) ?? GUEST;
    }
    const m = members.find((x) => x.orgId === orgId && x.email === ME_EMAIL) ?? members.find((x) => x.orgId === orgId)!;
    return override ? { ...m, role: override } : m;
  }, [members, orgId, override, userId]);
}

export function useCan(cap: Capability): boolean {
  const me = useMe();
  return can(me.role, cap);
}

export function useMemberMap() {
  const members = useOrgList('members');
  return useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
}

export function useLookup<K extends 'contacts' | 'properties' | 'leads' | 'deals' | 'agents'>(key: K) {
  const list = useOrgList(key) as unknown as { id: string }[];
  return useMemo(() => new Map(list.map((x) => [x.id, x])), [list]) as Map<string, OrgData[K][number]>;
}
