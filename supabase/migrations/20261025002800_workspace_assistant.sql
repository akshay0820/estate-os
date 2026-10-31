-- Workspace assistant (additive): the read tools behind the in-app assistant, plus its AI request limits.
-- Every function is SECURITY INVOKER: it runs as the signed-in user, so row-level security decides what the assistant can
-- see, exactly as for the screens. The assistant never writes through these; changes are proposed to the user and made
-- through the existing permissioned RPCs and tables after the user confirms them in the app.

-- AI request guard: a new feature for the assistant (every member who can see leads may ask).
alter table public.ai_requests drop constraint if exists ai_requests_feature_check;
alter table public.ai_requests add constraint ai_requests_feature_check
  check (feature in ('appointment_assistant', 'crm_enrichment', 'sales_recommendations', 'sales_analyst', 'workspace_assistant'));

create or replace function private.ai_limits(p_feature text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case p_feature
    when 'appointment_assistant' then '{"per_user_hour": 60, "permission": "appointments.edit"}'
    when 'crm_enrichment' then '{"per_user_hour": 30, "permission": "leads.edit"}'
    when 'sales_recommendations' then '{"per_user_hour": 10, "permission": "reports.view"}'
    when 'sales_analyst' then '{"per_user_hour": 60, "permission": "reports.view"}'
    when 'workspace_assistant' then '{"per_user_hour": 120, "permission": "leads.view"}'
  end::jsonb || '{"per_org_day": 1000}'::jsonb;
$$;

create or replace function private.assistant_member(p_org uuid)
returns void
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if p_org is null or not public.is_org_member(p_org) then perform private.fail('NOT_FOUND', 'Organization not found'); end if;
end;
$$;

/** Workspace numbers for a period: leads (by status and source), tasks, appointments and deals. */
create or replace function public.assistant_overview(p_org uuid, p_days integer default 30)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  d integer := least(greatest(coalesce(p_days, 30), 1), 365);
  since timestamptz := now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 365));
  uid uuid := auth.uid();
begin
  perform private.assistant_member(p_org);
  return jsonb_build_object(
    'period_days', d,
    'now', now(),
    'organization', (select jsonb_build_object('name', o.name, 'timezone', o.timezone, 'currency', o.default_currency, 'country', o.country_code)
                     from public.organizations o where o.id = p_org),
    'leads', (select jsonb_build_object(
        'open', count(*) filter (where l.status not in ('won', 'lost')),
        'created_last_24h', count(*) filter (where l.created_at >= now() - interval '24 hours'),
        'created_in_period', count(*) filter (where l.created_at >= since),
        'qualified_in_period', count(*) filter (where l.qualified_at >= since),
        'won_in_period', count(*) filter (where l.status = 'won' and l.closed_at >= since),
        'lost_in_period', count(*) filter (where l.status = 'lost' and l.closed_at >= since),
        'follow_up_overdue', count(*) filter (where l.next_follow_up_at < now() and l.status not in ('won', 'lost')),
        'uncontacted_open', count(*) filter (where l.first_response_at is null and l.status not in ('won', 'lost')),
        'unassigned_open', count(*) filter (where l.assigned_to is null and l.status not in ('won', 'lost')),
        'mine_open', count(*) filter (where l.assigned_to = uid and l.status not in ('won', 'lost')))
      from public.leads l where l.organization_id = p_org and l.archived_at is null),
    'leads_by_status', coalesce((select jsonb_object_agg(s.status, s.n) from (
        select l.status, count(*) n from public.leads l where l.organization_id = p_org and l.archived_at is null group by l.status) s), '{}'::jsonb),
    'sources_in_period', coalesce((select jsonb_agg(jsonb_build_object('source', s.source, 'leads', s.n, 'qualified', s.q, 'won', s.w) order by s.n desc) from (
        select l.source, count(*) n, count(*) filter (where l.qualified_at is not null) q, count(*) filter (where l.status = 'won') w
        from public.leads l where l.organization_id = p_org and l.archived_at is null and l.created_at >= since group by l.source) s), '[]'::jsonb),
    'tasks', (select jsonb_build_object(
        'open', count(*) filter (where t.status in ('open', 'in_progress')),
        'overdue', count(*) filter (where t.status in ('open', 'in_progress') and t.due_at < now()),
        'due_next_24h', count(*) filter (where t.status in ('open', 'in_progress') and t.due_at between now() and now() + interval '24 hours'),
        'mine_open', count(*) filter (where t.assigned_to = uid and t.status in ('open', 'in_progress')),
        'mine_overdue', count(*) filter (where t.assigned_to = uid and t.status in ('open', 'in_progress') and t.due_at < now()))
      from public.tasks t where t.organization_id = p_org),
    'appointments', (select jsonb_build_object(
        'next_7_days', count(*) filter (where a.starts_at between now() and now() + interval '7 days'),
        'mine_next_7_days', count(*) filter (where a.assigned_to = uid and a.starts_at between now() and now() + interval '7 days'))
      from public.appointments a where a.organization_id = p_org and a.status not in ('cancelled', 'no_show')),
    'deals', (select jsonb_build_object(
        'open', count(*) filter (where dl.stage not in ('won', 'lost')),
        'open_value', coalesce(sum(dl.expected_value) filter (where dl.stage not in ('won', 'lost')), 0),
        'won_in_period', count(*) filter (where dl.stage = 'won' and dl.closed_at >= since),
        'won_value_in_period', coalesce(sum(dl.expected_value) filter (where dl.stage = 'won' and dl.closed_at >= since), 0),
        'by_stage', coalesce((select jsonb_object_agg(x.stage, x.n) from (select d2.stage, count(*) n from public.deals d2 where d2.organization_id = p_org group by d2.stage) x), '{}'::jsonb))
      from public.deals dl where dl.organization_id = p_org)
  );
end;
$$;

/** Leads matching optional filters: text (name, phone, email, locality, source), status, source, owner, hot, overdue follow-up. */
create or replace function public.assistant_search_leads(p_org uuid, p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  q text := nullif(trim(p_filters ->> 'query'), '');
  st text := nullif(p_filters ->> 'status', '');
  src text := nullif(p_filters ->> 'source', '');
  mine boolean := coalesce((p_filters ->> 'assigned_to_me')::boolean, false);
  hot boolean := coalesce((p_filters ->> 'hot')::boolean, false);
  overdue boolean := coalesce((p_filters ->> 'follow_up_overdue')::boolean, false);
  uncontacted boolean := coalesce((p_filters ->> 'uncontacted')::boolean, false);
  lim integer := least(greatest(coalesce((p_filters ->> 'limit')::integer, 10), 1), 25);
begin
  perform private.assistant_member(p_org);
  return coalesce((select jsonb_agg(r) from (
    select jsonb_build_object('id', l.id, 'name', coalesce(c.display_name, l.title), 'status', l.status, 'score', l.lead_score,
      'type', l.lead_type, 'source', l.source, 'budget_max', l.budget_max, 'locations', l.desired_locations, 'bedrooms', l.bedrooms,
      'timeline', l.timeline, 'owner', p.full_name, 'next_follow_up_at', l.next_follow_up_at, 'created_at', l.created_at,
      'phone', c.phone, 'email', c.email) r
    from public.leads l
    left join public.contacts c on c.id = l.contact_id
    left join public.profiles p on p.id = l.assigned_to
    where l.organization_id = p_org and l.archived_at is null
      and (st is null or l.status = st)
      and (st is not null or not (l.status in ('won', 'lost')) or q is not null)
      and (src is null or l.source ilike src)
      and (not mine or l.assigned_to = auth.uid())
      and (not hot or l.lead_score >= 70)
      and (not overdue or (l.next_follow_up_at < now() and l.status not in ('won', 'lost')))
      and (not uncontacted or (l.first_response_at is null and l.status not in ('won', 'lost')))
      and (q is null or c.display_name ilike '%' || q || '%' or l.title ilike '%' || q || '%' or c.email ilike '%' || q || '%'
           or (length(regexp_replace(q, '\D', '', 'g')) >= 4 and regexp_replace(coalesce(c.phone, ''), '\D', '', 'g') like '%' || regexp_replace(q, '\D', '', 'g') || '%')
           or array_to_string(l.desired_locations, ' ') ilike '%' || q || '%' or l.source ilike '%' || q || '%')
    order by (case when hot then l.lead_score end) desc nulls last, l.next_follow_up_at asc nulls last, l.created_at desc
    limit lim) x), '[]'::jsonb);
end;
$$;

/** One lead with its contact, recent activity, open tasks and upcoming appointments. */
create or replace function public.assistant_lead(p_org uuid, p_lead uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  out jsonb;
begin
  perform private.assistant_member(p_org);
  select jsonb_build_object('id', l.id, 'name', coalesce(c.display_name, l.title), 'status', l.status, 'score', l.lead_score,
      'score_reasons', l.score_reasons, 'type', l.lead_type, 'intent', l.desired_transaction, 'source', l.source, 'campaign', l.source_campaign,
      'budget_min', l.budget_min, 'budget_max', l.budget_max, 'property_type', l.desired_property_type, 'locations', l.desired_locations,
      'bedrooms', l.bedrooms, 'timeline', l.timeline, 'summary', l.summary, 'owner', p.full_name, 'owner_id', l.assigned_to,
      'next_follow_up_at', l.next_follow_up_at, 'first_response_at', l.first_response_at, 'last_contact_at', l.last_contact_at,
      'lost_reason', l.lost_reason, 'created_at', l.created_at,
      'contact', jsonb_build_object('id', c.id, 'phone', c.phone, 'email', c.email, 'preferred_channel', c.preferred_contact_channel),
      'recent_activity', coalesce((select jsonb_agg(jsonb_build_object('at', a.occurred_at, 'type', a.activity_type, 'title', a.title, 'detail', left(a.description, 300)) order by a.occurred_at desc)
          from (select * from public.activities a where a.lead_id = l.id order by a.occurred_at desc limit 10) a), '[]'::jsonb),
      'open_tasks', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'due_at', t.due_at, 'priority', t.priority, 'status', t.status) order by t.due_at nulls last)
          from public.tasks t where t.related_lead_id = l.id and t.status in ('open', 'in_progress')), '[]'::jsonb),
      'upcoming_appointments', coalesce((select jsonb_agg(jsonb_build_object('id', ap.id, 'title', ap.title, 'starts_at', ap.starts_at, 'status', ap.status) order by ap.starts_at)
          from public.appointments ap where ap.lead_id = l.id and ap.starts_at >= now() and ap.status not in ('cancelled', 'no_show')), '[]'::jsonb))
    into out
  from public.leads l
  left join public.contacts c on c.id = l.contact_id
  left join public.profiles p on p.id = l.assigned_to
  where l.id = p_lead and l.organization_id = p_org;
  if out is null then perform private.fail('NOT_FOUND', 'Lead not found'); end if;
  return out;
end;
$$;

/** Tasks: scope mine|team, when overdue|today|upcoming|open (default open), newest due first for overdue. */
create or replace function public.assistant_tasks(p_org uuid, p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  mine boolean := coalesce(p_filters ->> 'scope', 'mine') = 'mine';
  w text := coalesce(nullif(p_filters ->> 'when', ''), 'open');
  lim integer := least(greatest(coalesce((p_filters ->> 'limit')::integer, 15), 1), 30);
begin
  perform private.assistant_member(p_org);
  return coalesce((select jsonb_agg(r) from (
    select jsonb_build_object('id', t.id, 'title', t.title, 'status', t.status, 'priority', t.priority, 'due_at', t.due_at,
      'assignee', p.full_name, 'lead_id', t.related_lead_id, 'lead', coalesce(c.display_name, l.title)) r
    from public.tasks t
    left join public.profiles p on p.id = t.assigned_to
    left join public.leads l on l.id = t.related_lead_id
    left join public.contacts c on c.id = l.contact_id
    where t.organization_id = p_org and t.status in ('open', 'in_progress')
      and (not mine or t.assigned_to = auth.uid())
      and (w = 'open'
        or (w = 'overdue' and t.due_at < now())
        or (w = 'today' and t.due_at between now() - interval '12 hours' and now() + interval '24 hours')
        or (w = 'upcoming' and t.due_at >= now()))
    order by t.due_at asc nulls last
    limit lim) x), '[]'::jsonb);
end;
$$;

/** Appointments in a window of days from now (negative = past), optionally only mine. */
create or replace function public.assistant_appointments(p_org uuid, p_from_days integer default 0, p_to_days integer default 7, p_mine boolean default false)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  perform private.assistant_member(p_org);
  return coalesce((select jsonb_agg(r) from (
    select jsonb_build_object('id', a.id, 'title', a.title, 'type', a.appointment_type, 'status', a.status, 'starts_at', a.starts_at,
      'ends_at', a.ends_at, 'location', a.location_text, 'assignee', p.full_name, 'lead_id', a.lead_id, 'lead', coalesce(c.display_name, l.title),
      'property', pr.title) r
    from public.appointments a
    left join public.profiles p on p.id = a.assigned_to
    left join public.leads l on l.id = a.lead_id
    left join public.contacts c on c.id = l.contact_id
    left join public.properties pr on pr.id = a.property_id
    where a.organization_id = p_org
      and a.starts_at between now() + make_interval(days => greatest(coalesce(p_from_days, 0), -90)) and now() + make_interval(days => least(coalesce(p_to_days, 7), 90))
      and (not coalesce(p_mine, false) or a.assigned_to = auth.uid())
    order by a.starts_at
    limit 30) x), '[]'::jsonb);
end;
$$;

/** Listings matching optional filters: text, locality, listing sale|rent, max price, min bedrooms; active by default. */
create or replace function public.assistant_properties(p_org uuid, p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  q text := nullif(trim(p_filters ->> 'query'), '');
  loc text := nullif(p_filters ->> 'locality', '');
  lst text := nullif(p_filters ->> 'listing', '');
  maxp numeric := nullif(p_filters ->> 'max_price', '')::numeric;
  beds integer := nullif(p_filters ->> 'min_bedrooms', '')::integer;
  st text := coalesce(nullif(p_filters ->> 'status', ''), 'active');
  lim integer := least(greatest(coalesce((p_filters ->> 'limit')::integer, 10), 1), 25);
begin
  perform private.assistant_member(p_org);
  return coalesce((select jsonb_agg(r) from (
    select jsonb_build_object('id', pr.id, 'ref', pr.reference_code, 'title', pr.title, 'type', pr.property_type, 'listing', pr.listing_type,
      'status', pr.status, 'price', pr.price, 'bedrooms', pr.bedrooms, 'bathrooms', pr.bathrooms, 'area', pr.area_value, 'area_unit', pr.area_unit,
      'locality', pr.locality, 'city', pr.city, 'verified_at', pr.verified_at) r
    from public.properties pr
    where pr.organization_id = p_org and pr.merged_into is null
      and (st = 'any' or pr.status = st)
      and (loc is null or pr.locality ilike '%' || loc || '%')
      and (lst is null or pr.listing_type = lst)
      and (maxp is null or pr.price <= maxp)
      and (beds is null or pr.bedrooms >= beds)
      and (q is null or pr.title ilike '%' || q || '%' or pr.locality ilike '%' || q || '%' or pr.reference_code ilike '%' || q || '%')
    order by pr.verified_at desc nulls last, pr.created_at desc
    limit lim) x), '[]'::jsonb);
end;
$$;

/** Deals, optionally by stage (open = every stage except won and lost). */
create or replace function public.assistant_deals(p_org uuid, p_stage text default 'open')
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  st text := coalesce(nullif(p_stage, ''), 'open');
begin
  perform private.assistant_member(p_org);
  return coalesce((select jsonb_agg(r) from (
    select jsonb_build_object('id', d.id, 'title', d.title, 'stage', d.stage, 'value', d.expected_value, 'commission_pct', d.commission_pct,
      'expected_close_date', d.expected_close_date, 'owner', p.full_name, 'lead_id', d.lead_id, 'stage_changed_at', d.stage_changed_at) r
    from public.deals d
    left join public.profiles p on p.id = d.owner_user_id
    where d.organization_id = p_org
      and (st = 'all' or (st = 'open' and d.stage not in ('won', 'lost')) or d.stage = st)
    order by d.expected_value desc nulls last
    limit 25) x), '[]'::jsonb);
end;
$$;

/** Active members with their role and localities (for assigning work). */
create or replace function public.assistant_team(p_org uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  perform private.assistant_member(p_org);
  return coalesce((select jsonb_agg(jsonb_build_object('id', m.user_id, 'name', p.full_name, 'role', m.role, 'title', m.title, 'localities', m.localities,
      'is_me', m.user_id = auth.uid()) order by p.full_name)
    from public.organization_memberships m
    left join public.profiles p on p.id = m.user_id
    where m.organization_id = p_org and m.status = 'active'), '[]'::jsonb);
end;
$$;

revoke execute on function public.assistant_overview(uuid, integer), public.assistant_search_leads(uuid, jsonb), public.assistant_lead(uuid, uuid),
  public.assistant_tasks(uuid, jsonb), public.assistant_appointments(uuid, integer, integer, boolean), public.assistant_properties(uuid, jsonb),
  public.assistant_deals(uuid, text), public.assistant_team(uuid) from public, anon;
grant execute on function public.assistant_overview(uuid, integer), public.assistant_search_leads(uuid, jsonb), public.assistant_lead(uuid, uuid),
  public.assistant_tasks(uuid, jsonb), public.assistant_appointments(uuid, integer, integer, boolean), public.assistant_properties(uuid, jsonb),
  public.assistant_deals(uuid, text), public.assistant_team(uuid) to authenticated;
