-- Estate OS · 0005 · Advisor follow-ups
-- Authorization helpers are for signed-in sessions only; anonymous callers have no use for them.

revoke execute on function public.has_perm(uuid, text), public.is_org_member(uuid), public.org_role(uuid) from public, anon;
grant execute on function public.has_perm(uuid, text), public.is_org_member(uuid), public.org_role(uuid) to authenticated, service_role;
