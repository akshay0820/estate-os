-- Estate OS · 0004 · Business rules, history, activity, RPCs
-- Rules here hold no matter which client or path writes the row.

-- ───────────────────────── helpers ─────────────────────────

create or replace function private.add_activity(org uuid, p_lead uuid, p_contact uuid, p_deal uuid, kind text, title text, body text, src text default null, meta jsonb default '{}')
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.activities (organization_id, lead_id, contact_id, deal_id, activity_type, title, description, source, actor_name, created_by, metadata)
  values (org, p_lead, p_contact, p_deal, kind, left(title, 300), left(body, 4000),
          coalesce(src, case when auth.uid() is null then 'system' else 'user' end),
          private.actor_name(), auth.uid(), coalesce(meta, '{}'));
end;
$$;

create or replace function private.org_setting(org uuid, path text[])
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select settings #> path from public.organizations where id = org;
$$;

-- Assignment rules (PRD §8.19): by locality, least loaded, or round robin among active agents.
create or replace function private.pick_assignee(org uuid, locations text[])
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  rule text := coalesce(private.org_setting(org, array['assignment']) #>> '{}', 'least_loaded');
  chosen uuid;
begin
  with agents as (
    select m.user_id, m.localities,
      (select count(*) from public.leads l where l.organization_id = org and l.assigned_to = m.user_id
         and l.archived_at is null and l.status not in ('won', 'lost', 'nurture')) as open_leads,
      (select max(a.created_at) from public.lead_assignments a where a.organization_id = org and a.to_user_id = m.user_id) as last_assigned
    from public.organization_memberships m
    where m.organization_id = org and m.status = 'active' and m.role = 'agent'
  )
  select user_id into chosen from agents
  order by
    case when rule = 'by_locality' and localities && coalesce(locations, '{}') then 0 else 1 end,
    case when rule = 'round_robin' then extract(epoch from coalesce(last_assigned, 'epoch'::timestamptz)) else open_leads end,
    open_leads,
    user_id
  limit 1;
  return chosen;
end;
$$;

create or replace function private.score_lead(l public.leads, out score numeric, out reasons text[])
language plpgsql
immutable
set search_path = ''
as $$
begin
  score := 20;
  reasons := '{}';
  if l.budget_max is not null then score := score + 20; reasons := array_append(reasons, 'Budget confirmed'); end if;
  if cardinality(l.desired_locations) > 0 then score := score + 12; reasons := array_append(reasons, 'Preferred locations given'); end if;
  if l.desired_property_type is not null and l.bedrooms is not null then score := score + 12; reasons := array_append(reasons, 'Configuration specified'); end if;
  if l.timeline ~* '(immediate|1 month|0-3)' then score := score + 20; reasons := array_append(reasons, 'Near-term timeline');
  elsif l.timeline is not null then score := score + 8; reasons := array_append(reasons, 'Timeline stated'); end if;
  if l.source = 'Referral' then score := score + 10; reasons := array_append(reasons, 'Referral source'); end if;
  if l.status in ('qualified', 'matching', 'visit_scheduled', 'visit_completed', 'negotiation') then
    score := score + 6; reasons := array_append(reasons, 'Progressed past qualification');
  end if;
  score := least(score, 99);
end;
$$;

-- ───────────────────────── contacts ─────────────────────────

create or replace function private.contacts_before()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.email := nullif(trim(new.email), '');
  new.phone := nullif(trim(new.phone), '');
  new.email_normalized := lower(new.email);
  new.phone_e164 := private.normalize_phone(new.phone);
  perform private.assert_member(new.organization_id, new.assigned_to, 'Owner');
  if tg_op = 'INSERT' then new.created_by := auth.uid(); end if;
  new.updated_by := auth.uid();
  return new;
end;
$$;
create trigger contacts_before before insert or update on public.contacts for each row execute function private.contacts_before();

create or replace function private.contacts_after()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform private.add_activity(new.organization_id, null, new.id, null, 'created', 'Contact created', null);
  end if;
  return null;
end;
$$;
create trigger contacts_after after insert on public.contacts for each row execute function private.contacts_after();
create trigger contacts_audit after insert or update on public.contacts for each row execute function private.audit_row();

-- ───────────────────────── consents ─────────────────────────

create or replace function private.consents_before()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform private.assert_same_org('contacts', new.contact_id, new.organization_id);
  if tg_op = 'UPDATE' and new.contact_id <> old.contact_id then perform private.fail('FORBIDDEN', 'Consent cannot be moved'); end if;
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    new.captured_by := auth.uid();
    if new.status = 'granted' then new.granted_at := now(); new.revoked_at := null;
    elsif new.status in ('revoked', 'denied') then new.revoked_at := now();
    end if;
  end if;
  return new;
end;
$$;
create trigger consents_before before insert or update on public.communication_consents for each row execute function private.consents_before();

create or replace function private.consents_after()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  lead_id uuid;
begin
  if new.status in ('revoked', 'denied') and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    select id into lead_id from public.leads where contact_id = new.contact_id order by created_at desc limit 1;
    perform private.add_activity(new.organization_id, lead_id, new.contact_id, null, 'opt_out',
      format('Opted out of %s', new.channel), coalesce('Source: ' || new.captured_via, null));
  end if;
  return null;
end;
$$;
create trigger consents_after after insert or update on public.communication_consents for each row execute function private.consents_after();
create trigger consents_audit after insert or update on public.communication_consents for each row execute function private.audit_row();

-- ───────────────────────── leads ─────────────────────────

create or replace function private.leads_before()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  sc record;
  progressed text[] := array['qualified', 'matching', 'visit_scheduled', 'visit_completed', 'negotiation', 'won'];
begin
  perform private.assert_same_org('contacts', new.contact_id, new.organization_id);
  perform private.assert_member(new.organization_id, new.assigned_to, 'Assignee');
  new.desired_locations := coalesce(new.desired_locations, '{}');

  if tg_op = 'INSERT' then
    new.created_by := uid;
    if new.status <> 'new' and new.first_response_at is null then new.first_response_at := now(); end if;
  else
    if new.contact_id <> old.contact_id then perform private.fail('FORBIDDEN', 'A lead cannot be moved to another contact'); end if;
    -- Reassignment needs leads.assign, except an agent claiming an unassigned lead.
    if uid is not null and new.assigned_to is distinct from old.assigned_to
       and not public.has_perm(new.organization_id, 'leads.assign')
       and not (old.assigned_to is null and new.assigned_to = uid) then
      perform private.fail('FORBIDDEN', 'You cannot reassign leads');
    end if;
    -- Status transitions: won is terminal; lost can only move to nurture or be reopened as contacted.
    if new.status is distinct from old.status then
      if old.status = 'won' then
        perform private.fail('INVALID_TRANSITION', 'A won lead is closed. Create a new enquiry instead.');
      end if;
      if old.status = 'lost' and new.status not in ('nurture', 'contacted') then
        perform private.fail('INVALID_TRANSITION', 'A lost lead can only move to Nurture or be reopened as Contacted');
      end if;
      if old.status = 'new' and new.first_response_at is null then new.first_response_at := now(); end if;
    end if;
    -- Edited by a person → no longer AI-extracted.
    if uid is not null then
      if new.budget_max is distinct from old.budget_max then new.ai_extracted_fields := array_remove(new.ai_extracted_fields, 'budget'); end if;
      if new.desired_locations is distinct from old.desired_locations then new.ai_extracted_fields := array_remove(new.ai_extracted_fields, 'locations'); end if;
      if new.bedrooms is distinct from old.bedrooms then new.ai_extracted_fields := array_remove(new.ai_extracted_fields, 'bedrooms'); end if;
      if new.timeline is distinct from old.timeline then new.ai_extracted_fields := array_remove(new.ai_extracted_fields, 'timeline'); end if;
      if new.desired_property_type is distinct from old.desired_property_type then new.ai_extracted_fields := array_remove(new.ai_extracted_fields, 'propertyType'); end if;
    end if;
  end if;

  if new.status = any (progressed) and new.qualified_at is null then new.qualified_at := now(); end if;
  if new.status in ('won', 'lost') then new.closed_at := coalesce(new.closed_at, now()); new.next_follow_up_at := null;
  else new.closed_at := null; end if;
  if new.status <> 'lost' then new.lost_reason := null; end if;

  select * into sc from private.score_lead(new);
  new.lead_score := sc.score;
  new.score_reasons := sc.reasons;
  new.updated_by := uid;
  return new;
end;
$$;
create trigger leads_before before insert or update on public.leads for each row execute function private.leads_before();

create or replace function private.leads_after()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  assignee_name text;
  changed text[];
begin
  if tg_op = 'INSERT' then
    insert into public.lead_status_history (organization_id, lead_id, from_status, to_status, changed_by)
    values (new.organization_id, new.id, null, new.status, auth.uid());
    perform private.add_activity(new.organization_id, new.id, new.contact_id, null, 'created',
      'Lead received from ' || new.source, case when new.source_campaign is not null then 'Campaign: ' || new.source_campaign end,
      case when auth.uid() is null then 'integration' end);
    if new.assigned_to is not null then
      insert into public.lead_assignments (organization_id, lead_id, from_user_id, to_user_id, assigned_by, reason)
      values (new.organization_id, new.id, null, new.assigned_to, auth.uid(), 'Initial assignment');
      select full_name into assignee_name from public.profiles where id = new.assigned_to;
      perform private.add_activity(new.organization_id, new.id, new.contact_id, null, 'assigned', 'Assigned to ' || coalesce(assignee_name, 'teammate'), null);
      if new.assigned_to is distinct from auth.uid() then
        perform private.notify(new.organization_id, new.assigned_to, 'lead', 'New lead: ' || new.title, 'From ' || new.source, 'leads', 'lead', new.id, 'lead_assigned:' || new.id || ':' || new.assigned_to);
      end if;
    end if;
    return null;
  end if;

  if new.status is distinct from old.status then
    insert into public.lead_status_history (organization_id, lead_id, from_status, to_status, changed_by, reason)
    values (new.organization_id, new.id, old.status, new.status, auth.uid(), new.lost_reason);
    perform private.add_activity(new.organization_id, new.id, new.contact_id, null, 'status',
      'Status → ' || replace(new.status, '_', ' '), new.lost_reason);
  end if;

  if new.assigned_to is distinct from old.assigned_to then
    insert into public.lead_assignments (organization_id, lead_id, from_user_id, to_user_id, assigned_by)
    values (new.organization_id, new.id, old.assigned_to, new.assigned_to, auth.uid());
    select full_name into assignee_name from public.profiles where id = new.assigned_to;
    perform private.add_activity(new.organization_id, new.id, new.contact_id, null, 'assigned',
      case when new.assigned_to is null then 'Unassigned' else 'Reassigned to ' || coalesce(assignee_name, 'teammate') end, null);
    if new.assigned_to is distinct from auth.uid() then
      perform private.notify(new.organization_id, new.assigned_to, 'lead', 'Lead assigned to you: ' || new.title, null, 'leads', 'lead', new.id,
        'lead_assigned:' || new.id || ':' || new.assigned_to || ':' || extract(epoch from now())::bigint);
    end if;
  end if;

  changed := array_remove(array[
    case when new.budget_max is distinct from old.budget_max then 'budget' end,
    case when new.desired_locations is distinct from old.desired_locations then 'locations' end,
    case when new.bedrooms is distinct from old.bedrooms then 'bedrooms' end,
    case when new.timeline is distinct from old.timeline then 'timeline' end,
    case when new.desired_property_type is distinct from old.desired_property_type then 'property type' end,
    case when new.priority is distinct from old.priority then 'priority' end
  ], null);
  if cardinality(changed) > 0 then
    perform private.add_activity(new.organization_id, new.id, new.contact_id, null, 'updated', 'Updated ' || array_to_string(changed, ', '), null);
  end if;
  if new.archived_at is distinct from old.archived_at then
    perform private.add_activity(new.organization_id, new.id, new.contact_id, null, 'updated', case when new.archived_at is null then 'Restored' else 'Archived' end, null);
  end if;
  return null;
end;
$$;
create trigger leads_after after insert or update on public.leads for each row execute function private.leads_after();
create trigger leads_audit after insert or update on public.leads for each row execute function private.audit_row();

-- ───────────────────────── properties ─────────────────────────

create or replace function private.properties_before()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform private.assert_same_org('contacts', new.owner_contact_id, new.organization_id);
  perform private.assert_member(new.organization_id, new.listing_agent_id, 'Listing agent');
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.verified_at := null;
    new.verified_by := null;
  elsif new.verified_at is distinct from old.verified_at then
    if auth.uid() is not null and not public.has_perm(new.organization_id, 'properties.verify') then
      perform private.fail('FORBIDDEN', 'You cannot verify listings');
    end if;
    -- The server decides the verification time.
    if new.verified_at is not null then new.verified_at := now(); new.verified_by := auth.uid(); end if;
  end if;
  if new.cover_image_path is not null and new.cover_image_path not like new.organization_id::text || '/%' then
    perform private.fail('VALIDATION_ERROR', 'Image path must belong to this organization');
  end if;
  return new;
end;
$$;
create trigger properties_before before insert or update on public.properties for each row execute function private.properties_before();
create trigger properties_audit after insert or update on public.properties for each row execute function private.audit_row();

-- ───────────────────────── deals ─────────────────────────

create or replace function private.deals_before()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform private.assert_same_org('leads', new.lead_id, new.organization_id);
  perform private.assert_same_org('contacts', new.primary_contact_id, new.organization_id);
  perform private.assert_same_org('properties', new.property_id, new.organization_id);
  perform private.assert_member(new.organization_id, new.owner_user_id, 'Deal owner');
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    if new.stage in ('won', 'lost') then perform private.fail('INVALID_TRANSITION', 'Create the deal open, then close it'); end if;
  elsif new.stage is distinct from old.stage then
    if old.stage in ('won', 'lost') then perform private.fail('INVALID_TRANSITION', 'This deal is closed'); end if;
    new.stage_changed_at := now();
    if new.stage in ('won', 'lost') then new.closed_at := now(); end if;
  end if;
  if new.stage <> 'lost' then new.lost_reason := null; end if;
  return new;
end;
$$;
create trigger deals_before before insert or update on public.deals for each row execute function private.deals_before();

create or replace function private.deals_after()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.properties;
begin
  if tg_op = 'INSERT' then
    perform private.add_activity(new.organization_id, new.lead_id, new.primary_contact_id, new.id, 'deal', 'Deal opened: ' || new.title, null);
    return null;
  end if;
  if new.stage is not distinct from old.stage then return null; end if;

  perform private.add_activity(new.organization_id, new.lead_id, new.primary_contact_id, new.id, 'deal',
    'Deal stage → ' || replace(new.stage, '_', ' '), new.lost_reason);

  if new.stage = 'won' then
    insert into public.commissions (organization_id, deal_id, beneficiary_user_id, gross_commission, currency, calculation_snapshot)
    values (new.organization_id, new.id, new.owner_user_id, round(new.expected_value * new.commission_pct / 100, 2), new.currency,
      jsonb_build_object('value', new.expected_value, 'pct', new.commission_pct, 'calculated_at', now()))
    on conflict (deal_id) do nothing;
    update public.leads set status = 'won' where id = new.lead_id and status not in ('won', 'lost');
    select * into p from public.properties where id = new.property_id;
    if p.id is not null then
      update public.properties set status = case when p.listing_type = 'rent' then 'let' else 'sold' end where id = p.id;
    end if;
    perform private.notify(new.organization_id, new.owner_user_id, 'system', 'Deal won: ' || new.title,
      'Commission estimate recorded for finance review.', 'deals', 'deal', new.id, 'deal_won:' || new.id);
  elsif new.stage = 'lost' then
    update public.leads set status = 'lost', lost_reason = coalesce(new.lost_reason, 'Other') where id = new.lead_id and status not in ('won', 'lost');
  elsif new.stage = 'under_contract' then
    update public.properties set status = 'under_offer' where id = new.property_id and status = 'active';
  end if;
  return null;
end;
$$;
create trigger deals_after after insert or update on public.deals for each row execute function private.deals_after();
create trigger deals_audit after insert or update on public.deals for each row execute function private.audit_row();

create or replace function private.commissions_before()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is distinct from old.status then
    if not (
      (old.status = 'estimated' and new.status = 'approved') or
      (old.status = 'approved' and new.status = 'payable') or
      (old.status = 'payable' and new.status = 'paid') or
      (old.status <> 'paid' and new.status = 'void')
    ) then
      perform private.fail('INVALID_TRANSITION', format('Commission cannot move from %s to %s', old.status, new.status));
    end if;
    if new.status = 'approved' then new.approved_by := auth.uid(); new.approved_at := now(); end if;
    if new.status = 'paid' then new.paid_at := now(); end if;
  end if;
  return new;
end;
$$;
create trigger commissions_before before update on public.commissions for each row execute function private.commissions_before();
create trigger commissions_audit after insert or update on public.commissions for each row execute function private.audit_row();

-- ───────────────────────── appointments ─────────────────────────

create or replace function private.appointments_before()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  org_tz text;
  bh jsonb;
  local_start timestamp;
  local_end timestamp;
  prop_status text;
  clash record;
  active text[] := array['requested', 'pending', 'confirmed', 'reschedule_requested'];
  timing_changed boolean := tg_op = 'INSERT' or new.starts_at <> old.starts_at or new.ends_at <> old.ends_at
                            or new.assigned_to is distinct from old.assigned_to or (new.status = any (active) and not old.status = any (active));
begin
  perform private.assert_same_org('leads', new.lead_id, new.organization_id);
  perform private.assert_same_org('contacts', new.contact_id, new.organization_id);
  perform private.assert_same_org('properties', new.property_id, new.organization_id);
  perform private.assert_member(new.organization_id, new.assigned_to, 'Assignee');
  if tg_op = 'UPDATE' and (new.lead_id is distinct from old.lead_id or new.property_id is distinct from old.property_id) then
    perform private.fail('FORBIDDEN', 'Create a new appointment to change the lead or property');
  end if;
  if new.lead_id is not null and new.contact_id is null then
    select contact_id into new.contact_id from public.leads where id = new.lead_id;
  end if;
  select timezone, settings -> 'business_hours' into org_tz, bh from public.organizations where id = new.organization_id;
  new.timezone := org_tz;
  if tg_op = 'INSERT' then new.created_by := auth.uid(); end if;
  if new.status = 'cancelled' and new.cancellation_reason is null then
    perform private.fail('VALIDATION_ERROR', 'A cancellation reason is required');
  end if;

  if timing_changed and new.status = any (active) then
    if new.starts_at < now() - interval '5 minutes' then
      perform private.fail('VALIDATION_ERROR', 'That time is in the past');
    end if;
    local_start := new.starts_at at time zone org_tz;
    local_end := new.ends_at at time zone org_tz;
    if not (bh -> 'days') @> to_jsonb(extract(dow from local_start)::int)
       or extract(hour from local_start) < (bh ->> 'start')::int
       or local_end > date_trunc('day', local_start) + make_interval(hours => (bh ->> 'end')::int) then
      perform private.fail('OUTSIDE_BUSINESS_HOURS', format('Outside business hours (%s:00–%s:00)', bh ->> 'start', bh ->> 'end'));
    end if;
    if new.appointment_type = 'viewing' and new.property_id is not null and (tg_op = 'INSERT') then
      select status into prop_status from public.properties where id = new.property_id;
      if prop_status <> 'active' then
        perform private.fail('PROPERTY_UNAVAILABLE', 'This property is not available for viewings');
      end if;
    end if;
    if new.assigned_to is not null then
      -- Serialize bookings per person so concurrent requests cannot both pass the check.
      perform pg_advisory_xact_lock(hashtextextended('appt:' || new.assigned_to::text, 0));
      select id, title, starts_at into clash from public.appointments a
      where a.assigned_to = new.assigned_to and a.id <> new.id and a.status = any (active)
        and a.starts_at < new.ends_at and new.starts_at < a.ends_at
      limit 1;
      if clash.id is not null then
        raise exception using message = 'This person already has an appointment at that time', detail = 'APPOINTMENT_CONFLICT',
          hint = jsonb_build_object('conflict_id', clash.id, 'title', clash.title, 'starts_at', clash.starts_at)::text, errcode = 'P0001';
      end if;
    end if;
  end if;
  return new;
end;
$$;
create trigger appointments_before before insert or update on public.appointments for each row execute function private.appointments_before();

create or replace function private.appointments_after()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform private.add_activity(new.organization_id, new.lead_id, new.contact_id, null, 'appointment', new.title || ' booked',
      to_char(new.starts_at at time zone new.timezone, 'Dy DD Mon, HH12:MI am'));
    update public.leads set status = 'visit_scheduled'
    where id = new.lead_id and new.appointment_type = 'viewing' and status in ('new', 'attempting', 'contacted', 'qualified', 'matching');
    if new.assigned_to is distinct from auth.uid() then
      perform private.notify(new.organization_id, new.assigned_to, 'appointment', 'Appointment booked: ' || new.title,
        to_char(new.starts_at at time zone new.timezone, 'Dy DD Mon, HH12:MI am'), 'appointments', 'appointment', new.id, 'appt_booked:' || new.id);
    end if;
    return null;
  end if;
  if new.status is distinct from old.status then
    perform private.add_activity(new.organization_id, new.lead_id, new.contact_id, null, 'appointment',
      new.title || ' — ' || replace(new.status, '_', ' '), coalesce(new.cancellation_reason, new.feedback));
    if new.status = 'completed' then
      update public.leads set status = 'visit_completed' where id = new.lead_id and status = 'visit_scheduled';
    end if;
    if new.status = 'cancelled' and new.assigned_to is distinct from auth.uid() then
      perform private.notify(new.organization_id, new.assigned_to, 'appointment', 'Appointment cancelled: ' || new.title,
        new.cancellation_reason, 'appointments', 'appointment', new.id, 'appt_cancelled:' || new.id);
    end if;
  elsif new.starts_at <> old.starts_at then
    perform private.add_activity(new.organization_id, new.lead_id, new.contact_id, null, 'appointment', new.title || ' rescheduled',
      to_char(new.starts_at at time zone new.timezone, 'Dy DD Mon, HH12:MI am'));
  end if;
  return null;
end;
$$;
create trigger appointments_after after insert or update on public.appointments for each row execute function private.appointments_after();
create trigger appointments_audit after insert or update on public.appointments for each row execute function private.audit_row();

-- ───────────────────────── tasks ─────────────────────────

create or replace function private.tasks_before()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform private.assert_same_org('leads', new.related_lead_id, new.organization_id);
  perform private.assert_same_org('deals', new.related_deal_id, new.organization_id);
  perform private.assert_same_org('properties', new.related_property_id, new.organization_id);
  perform private.assert_member(new.organization_id, new.assigned_to, 'Assignee');
  if tg_op = 'INSERT' then new.created_by := auth.uid(); end if;
  if new.status = 'completed' then new.completed_at := coalesce(new.completed_at, now()); else new.completed_at := null; end if;
  return new;
end;
$$;
create trigger tasks_before before insert or update on public.tasks for each row execute function private.tasks_before();

create or replace function private.tasks_after()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  contact uuid;
begin
  if new.related_lead_id is not null then select contact_id into contact from public.leads where id = new.related_lead_id; end if;
  if tg_op = 'INSERT' then
    if new.related_lead_id is not null then
      perform private.add_activity(new.organization_id, new.related_lead_id, contact, null, 'task', 'Task: ' || new.title, null);
    end if;
    if new.assigned_to is distinct from auth.uid() then
      perform private.notify(new.organization_id, new.assigned_to, 'task', 'New task: ' || new.title, null, 'tasks', 'task', new.id, 'task_assigned:' || new.id);
    end if;
  elsif new.status = 'completed' and old.status <> 'completed' and new.related_lead_id is not null then
    perform private.add_activity(new.organization_id, new.related_lead_id, contact, null, 'task', 'Task completed: ' || new.title, null);
  end if;
  return null;
end;
$$;
create trigger tasks_after after insert or update on public.tasks for each row execute function private.tasks_after();

-- ───────────────────────── activities (user notes) ─────────────────────────

create or replace function private.activities_before()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform private.assert_same_org('leads', new.lead_id, new.organization_id);
  perform private.assert_same_org('contacts', new.contact_id, new.organization_id);
  perform private.assert_same_org('deals', new.deal_id, new.organization_id);
  if new.lead_id is not null and new.contact_id is null then
    select contact_id into new.contact_id from public.leads where id = new.lead_id;
  end if;
  new.actor_name := private.actor_name();
  new.occurred_at := now();
  return new;
end;
$$;
create trigger activities_before before insert on public.activities for each row execute function private.activities_before();

-- ───────────────────────── tenancy audit ─────────────────────────

create trigger organizations_audit after update on public.organizations for each row execute function private.audit_row();
create trigger memberships_audit after insert or update on public.organization_memberships for each row execute function private.audit_row();
create trigger invitations_audit after insert or update on public.invitations for each row execute function private.audit_row();
create trigger documents_audit after insert or update on public.documents for each row execute function private.audit_row();

-- ───────────────────────── RPCs ─────────────────────────

-- Create a lead (and its contact) with duplicate detection and assignment rules.
-- p_on_duplicate: 'ask' → return candidates without writing; 'link' → attach to the first match; 'create' → new contact.
create or replace function public.create_lead(p_org uuid, p_input jsonb, p_on_duplicate text default 'ask')
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_name text := trim(p_input ->> 'name');
  v_phone text := nullif(trim(p_input ->> 'phone'), '');
  v_email text := lower(nullif(trim(p_input ->> 'email'), ''));
  v_type text := coalesce(p_input ->> 'type', 'buyer');
  v_locations text[] := coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(p_input -> 'locations', '[]')) x), '{}');
  v_assigned uuid;
  v_contact uuid;
  v_lead uuid;
  v_channels text[] := coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(p_input -> 'consent_channels', '[]')) x), '{}');
  ch text;
  dupes jsonb;
  v_budget numeric;
  v_bedrooms smallint;
begin
  if not public.has_perm(p_org, 'leads.edit') then perform private.fail('FORBIDDEN', 'You cannot create leads'); end if;
  begin
    v_budget := nullif(p_input ->> 'budget_max', '')::numeric;
    v_bedrooms := nullif(p_input ->> 'bedrooms', '')::smallint;
    v_contact := nullif(p_input ->> 'contact_id', '')::uuid;
    if p_input ? 'assigned_to' then v_assigned := nullif(p_input ->> 'assigned_to', '')::uuid; end if;
  exception when invalid_text_representation or numeric_value_out_of_range then
    perform private.fail('VALIDATION_ERROR', 'One or more fields have an invalid format');
  end;
  if v_budget is not null and v_budget <= 0 then perform private.fail('VALIDATION_ERROR', 'Budget must be greater than zero'); end if;
  if p_on_duplicate not in ('ask', 'link', 'create') then perform private.fail('VALIDATION_ERROR', 'Invalid duplicate handling'); end if;
  if v_contact is null then
    if v_name is null or char_length(v_name) < 1 or char_length(v_name) > 160 then perform private.fail('VALIDATION_ERROR', 'Name is required'); end if;
    if v_phone is null and v_email is null then perform private.fail('VALIDATION_ERROR', 'Add a phone number or email'); end if;
    if v_phone is not null and length(regexp_replace(v_phone, '\D', '', 'g')) < 10 then perform private.fail('VALIDATION_ERROR', 'Enter a valid phone number'); end if;
    if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then perform private.fail('VALIDATION_ERROR', 'Enter a valid email'); end if;

    select jsonb_agg(jsonb_build_object('contact_id', c.id, 'name', c.display_name,
             'reasons', to_jsonb(array_remove(array[
               case when c.phone_e164 = private.normalize_phone(v_phone) then 'Same phone' end,
               case when c.email_normalized = v_email then 'Same email' end], null))))
      into dupes
    from public.contacts c
    where c.organization_id = p_org
      and ((v_phone is not null and c.phone_e164 = private.normalize_phone(v_phone)) or (v_email is not null and c.email_normalized = v_email));

    if dupes is not null then
      if p_on_duplicate = 'ask' then return jsonb_build_object('status', 'duplicate', 'candidates', dupes); end if;
      if p_on_duplicate = 'link' then v_contact := (dupes -> 0 ->> 'contact_id')::uuid; end if;
    end if;
  end if;

  if v_type not in ('buyer', 'seller', 'tenant', 'landlord', 'investor') then perform private.fail('VALIDATION_ERROR', 'Invalid lead type'); end if;

  if v_contact is null then
    insert into public.contacts (organization_id, display_name, email, phone, roles, source)
    values (p_org, v_name, v_email, v_phone, array[v_type], coalesce(p_input ->> 'source', 'Manual'))
    returning id into v_contact;
    foreach ch in array array['phone', 'whatsapp', 'sms', 'email'] loop
      insert into public.communication_consents (organization_id, contact_id, channel, status, captured_via)
      values (p_org, v_contact, ch, case when ch = any (v_channels) then 'granted' else 'unknown' end,
              case when ch = any (v_channels) then 'Recorded by staff at lead creation' end);
    end loop;
  else
    -- Linking must stay inside the tenant; RLS hides other tenants' rows, this makes it explicit.
    perform private.assert_same_org('contacts', v_contact, p_org);
    select display_name into v_name from public.contacts where id = v_contact;
  end if;

  if not (p_input ? 'assigned_to') then
    v_assigned := private.pick_assignee(p_org, v_locations);
  end if;

  insert into public.leads (organization_id, contact_id, title, lead_type, desired_transaction, source, source_campaign, assigned_to,
    budget_min, budget_max, desired_property_type, desired_locations, bedrooms, timeline, summary, next_follow_up_at)
  values (p_org, v_contact, v_name, v_type,
    coalesce(p_input ->> 'intent', case v_type when 'tenant' then 'rent' when 'seller' then 'sell' when 'landlord' then 'let' when 'investor' then 'invest' else 'buy' end),
    coalesce(nullif(p_input ->> 'source', ''), 'Manual'), nullif(p_input ->> 'campaign', ''), v_assigned,
    round(v_budget * 0.75), v_budget, nullif(p_input ->> 'property_type', ''), v_locations,
    v_bedrooms, nullif(p_input ->> 'timeline', ''), nullif(trim(p_input ->> 'notes'), ''),
    now() + interval '2 hours')
  returning id into v_lead;

  return jsonb_build_object('status', 'created', 'lead_id', v_lead, 'contact_id', v_contact, 'linked', dupes is not null and p_on_duplicate = 'link');
end;
$$;

-- Merge a duplicate enquiry into another lead of the same contact, preserving history.
create or replace function public.merge_leads(p_keep uuid, p_drop uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  k public.leads;
  d public.leads;
begin
  select * into k from public.leads where id = p_keep;
  select * into d from public.leads where id = p_drop for update;
  if k.id is null or d.id is null or k.organization_id <> d.organization_id or p_keep = p_drop then
    perform private.fail('NOT_FOUND', 'Lead not found');
  end if;
  if not public.has_perm(k.organization_id, 'leads.merge') then perform private.fail('FORBIDDEN', 'You cannot merge leads'); end if;
  if k.contact_id <> d.contact_id then perform private.fail('VALIDATION_ERROR', 'Only enquiries from the same contact can be merged'); end if;

  update public.activities set lead_id = p_keep where lead_id = p_drop;
  update public.appointments set lead_id = p_keep where lead_id = p_drop;
  update public.tasks set related_lead_id = p_keep where related_lead_id = p_drop;
  update public.deals set lead_id = p_keep where lead_id = p_drop;
  update public.leads set
    budget_max = coalesce(k.budget_max, d.budget_max),
    budget_min = coalesce(k.budget_min, d.budget_min),
    desired_locations = (select coalesce(array_agg(distinct x), '{}') from unnest(k.desired_locations || d.desired_locations) x),
    timeline = coalesce(k.timeline, d.timeline),
    bedrooms = coalesce(k.bedrooms, d.bedrooms),
    desired_property_type = coalesce(k.desired_property_type, d.desired_property_type)
  where id = p_keep;
  update public.leads set archived_at = now(), metadata = metadata || jsonb_build_object('merged_into', p_keep) where id = p_drop;
  perform private.add_activity(k.organization_id, p_keep, k.contact_id, null, 'note', 'Merged duplicate enquiry',
    format('%s enquiry from %s merged; history preserved.', d.source, to_char(d.created_at, 'DD Mon YYYY')));
  perform private.write_audit(k.organization_id, 'leads.merged', 'leads', p_keep, jsonb_build_object('merged', p_drop));
end;
$$;

create or replace function public.set_contact_consent(p_contact uuid, p_channel text, p_status text, p_source text default 'Staff update')
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  org uuid;
begin
  select organization_id into org from public.contacts where id = p_contact;
  if org is null then perform private.fail('NOT_FOUND', 'Contact not found'); end if;
  if not public.has_perm(org, 'contacts.edit') then perform private.fail('FORBIDDEN', 'You cannot change consent'); end if;
  if p_status = 'granted' and exists (select 1 from public.contacts where id = p_contact and lifecycle_status = 'do_not_contact') then
    perform private.fail('FORBIDDEN', 'This contact is on the do-not-contact list');
  end if;
  insert into public.communication_consents (organization_id, contact_id, channel, purpose, status, captured_via)
  values (org, p_contact, p_channel, 'service', p_status, left(p_source, 80))
  on conflict (contact_id, channel, purpose) do update set status = excluded.status, captured_via = excluded.captured_via;
end;
$$;

create or replace function public.opt_out_contact(p_contact uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  ch text;
begin
  foreach ch in array array['phone', 'whatsapp', 'sms', 'email'] loop
    perform public.set_contact_consent(p_contact, ch, 'revoked', 'Do-not-contact request');
  end loop;
  update public.contacts set lifecycle_status = 'do_not_contact' where id = p_contact;
end;
$$;

-- Free slots for a person, inside business hours, without conflicts.
create or replace function public.appointment_free_slots(p_org uuid, p_assignee uuid, p_from timestamptz, p_minutes int default 45, p_count int default 3)
returns setof timestamptz
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  tz text;
  bh jsonb;
  t timestamptz := date_trunc('hour', greatest(p_from, now())) + interval '30 minutes';
  found int := 0;
  i int := 0;
  lt timestamp;
begin
  if not public.is_org_member(p_org) then perform private.fail('FORBIDDEN', 'Not a member'); end if;
  select timezone, settings -> 'business_hours' into tz, bh from public.organizations where id = p_org;
  while found < least(p_count, 10) and i < 600 loop
    i := i + 1;
    t := t + interval '30 minutes';
    lt := t at time zone tz;
    continue when not (bh -> 'days') @> to_jsonb(extract(dow from lt)::int);
    continue when extract(hour from lt) < (bh ->> 'start')::int
               or lt + make_interval(mins => p_minutes) > date_trunc('day', lt) + make_interval(hours => (bh ->> 'end')::int);
    continue when exists (
      select 1 from public.appointments a
      where a.organization_id = p_org and a.assigned_to = p_assignee
        and a.status in ('requested', 'pending', 'confirmed', 'reschedule_requested')
        and a.starts_at < t + make_interval(mins => p_minutes) and t < a.ends_at);
    found := found + 1;
    return next t;
  end loop;
end;
$$;

-- Counts for the Leads page quick views (one round trip, RLS-scoped).
create or replace function public.lead_view_counts(p_org uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'open', count(*) filter (where archived_at is null and status not in ('won', 'lost', 'nurture')),
    'mine', count(*) filter (where archived_at is null and status not in ('won', 'lost', 'nurture') and assigned_to = auth.uid()),
    'new', count(*) filter (where archived_at is null and status = 'new'),
    'hot', count(*) filter (where archived_at is null and status not in ('won', 'lost', 'nurture') and lead_score >= 75),
    'overdue', count(*) filter (where archived_at is null and status not in ('won', 'lost', 'nurture') and next_follow_up_at < now()),
    'closed', count(*) filter (where archived_at is null and status in ('won', 'lost', 'nurture')),
    'archived', count(*) filter (where archived_at is not null)
  )
  from public.leads where organization_id = p_org;
$$;

create or replace function public.mark_all_notifications_read(p_org uuid)
returns void
language sql
security invoker
set search_path = ''
as $$
  update public.notifications set read_at = now() where organization_id = p_org and user_id = auth.uid() and read_at is null;
$$;

-- Dashboard aggregates. Security invoker: RLS still applies to every row read.
-- Buckets are computed in the organization's time zone. Metric definitions: docs/API_IMPLEMENTATION_STATUS.md.
create or replace function public.dashboard_metrics(p_org uuid, p_from timestamptz, p_to timestamptz, p_bucket text default 'day')
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  tz text;
  sla int;
  span interval := p_to - p_from;
  pf timestamptz := p_from - (p_to - p_from);
  step interval;
  result jsonb;
  qual text[] := array['qualified', 'matching', 'visit_scheduled', 'visit_completed', 'negotiation', 'won'];
begin
  if not public.has_perm(p_org, 'leads.view') then perform private.fail('FORBIDDEN', 'Not allowed'); end if;
  if p_to <= p_from or span > interval '400 days' then perform private.fail('VALIDATION_ERROR', 'Invalid date range'); end if;
  if p_bucket not in ('day', 'week', 'month') then perform private.fail('VALIDATION_ERROR', 'Invalid bucket'); end if;
  select timezone, (settings ->> 'sla_minutes')::int into tz, sla from public.organizations where id = p_org;
  step := ('1 ' || p_bucket)::interval;

  with
  cur as (select * from public.leads where organization_id = p_org and archived_at is null and created_at >= p_from and created_at < p_to),
  prev as (select * from public.leads where organization_id = p_org and archived_at is null and created_at >= pf and created_at < p_from),
  appt_leads as (select distinct lead_id from public.appointments where organization_id = p_org and lead_id is not null and status <> 'cancelled'),
  buckets as (
    select gs as b_start, gs + step as b_end
    from generate_series(date_trunc(p_bucket, p_from at time zone tz) at time zone tz, p_to - interval '1 second', step) gs
  ),
  series as (
    select b.b_start,
      (select count(*) from cur where created_at >= b.b_start and created_at < b.b_end) as leads,
      (select count(*) from cur where created_at >= b.b_start and created_at < b.b_end and status = any (qual)) as qualified,
      (select count(*) from prev where created_at >= b.b_start - span and created_at < b.b_end - span) as prev_leads,
      (select count(*) from public.appointments a where a.organization_id = p_org and a.appointment_type = 'viewing' and a.created_at >= b.b_start and a.created_at < b.b_end) as viewings,
      (select coalesce(sum(expected_value), 0) from public.deals d where d.organization_id = p_org and d.stage = 'won' and d.closed_at >= b.b_start and d.closed_at < b.b_end) as won_value
    from buckets b
  ),
  resp as (select extract(epoch from (first_response_at - created_at)) / 60 as minutes from cur where first_response_at is not null),
  prev_resp as (select extract(epoch from (first_response_at - created_at)) / 60 as minutes from prev where first_response_at is not null)
  select jsonb_build_object(
    'range', jsonb_build_object('from', p_from, 'to', p_to, 'bucket', p_bucket, 'timezone', tz),
    'kpis', jsonb_build_object(
      'new_leads', jsonb_build_object('current', (select count(*) from cur), 'previous', (select count(*) from prev)),
      'qualified', jsonb_build_object('current', (select count(*) from cur where status = any (qual)), 'previous', (select count(*) from prev where status = any (qual))),
      'viewings_booked', jsonb_build_object(
        'current', (select count(*) from public.appointments where organization_id = p_org and appointment_type = 'viewing' and created_at >= p_from and created_at < p_to),
        'previous', (select count(*) from public.appointments where organization_id = p_org and appointment_type = 'viewing' and created_at >= pf and created_at < p_from)),
      'lead_to_visit', jsonb_build_object(
        'current', coalesce((select count(*) filter (where id in (select lead_id from appt_leads))::numeric / nullif(count(*), 0) from cur), 0),
        'previous', coalesce((select count(*) filter (where id in (select lead_id from appt_leads))::numeric / nullif(count(*), 0) from prev), 0)),
      'active_deals', jsonb_build_object(
        'current', (select count(*) from public.deals where organization_id = p_org and stage not in ('won', 'lost')),
        'pipeline_value', (select coalesce(sum(expected_value), 0) from public.deals where organization_id = p_org and stage not in ('won', 'lost')),
        'opened', (select count(*) from public.deals where organization_id = p_org and created_at >= p_from and created_at < p_to),
        'opened_previous', (select count(*) from public.deals where organization_id = p_org and created_at >= pf and created_at < p_from)),
      'won_value', jsonb_build_object(
        'current', (select coalesce(sum(expected_value), 0) from public.deals where organization_id = p_org and stage = 'won' and closed_at >= p_from and closed_at < p_to),
        'previous', (select coalesce(sum(expected_value), 0) from public.deals where organization_id = p_org and stage = 'won' and closed_at >= pf and closed_at < p_from)),
      'active_properties', (select count(*) from public.properties where organization_id = p_org and status = 'active'),
      'tasks_completed', (select count(*) from public.tasks where organization_id = p_org and completed_at >= p_from and completed_at < p_to)
    ),
    'series', coalesce((select jsonb_agg(jsonb_build_object('start', b_start, 'leads', leads, 'qualified', qualified, 'previous_leads', prev_leads, 'viewings', viewings, 'won_value', won_value) order by b_start) from series), '[]'),
    'sources', coalesce((select jsonb_agg(jsonb_build_object('source', source, 'leads', n, 'qualified', q) order by n desc)
                from (select source, count(*) n, count(*) filter (where status = any (qual)) q from cur group by source) s), '[]'),
    'funnel', jsonb_build_array(
      jsonb_build_object('label', 'New enquiries', 'n', (select count(*) from cur)),
      jsonb_build_object('label', 'Contacted', 'n', (select count(*) from cur where first_response_at is not null or status not in ('new', 'attempting'))),
      jsonb_build_object('label', 'Qualified', 'n', (select count(*) from cur where status = any (qual))),
      jsonb_build_object('label', 'Visit booked', 'n', (select count(*) from cur where id in (select lead_id from appt_leads))),
      jsonb_build_object('label', 'Negotiation', 'n', (select count(*) from cur where status in ('negotiation', 'won'))),
      jsonb_build_object('label', 'Won', 'n', (select count(*) from cur where status = 'won'))
    ),
    -- Weekday (Mon=1..Sun=7) × two-hour block starting 08:00, in org time.
    'arrivals', coalesce((select jsonb_agg(jsonb_build_object('dow', dow, 'block', blk, 'n', n))
                  from (select extract(isodow from created_at at time zone tz)::int dow,
                               floor((extract(hour from created_at at time zone tz) - 8) / 2)::int blk, count(*) n
                        from cur where extract(hour from created_at at time zone tz) between 8 and 23 group by 1, 2) h), '[]'),
    'response', jsonb_build_object(
      'median_minutes', (select percentile_cont(0.5) within group (order by minutes) from resp),
      'previous_median_minutes', (select percentile_cont(0.5) within group (order by minutes) from prev_resp),
      'within_sla', coalesce((select count(*) filter (where minutes <= sla)::numeric / nullif(count(*), 0) from resp), 0),
      'sla_minutes', sla,
      'awaiting_first_contact', (select count(*) from cur where first_response_at is null)
    )
  ) into result;
  return result;
end;
$$;

-- Records a client-side CSV export in the audit log. Actor comes from the verified session.
create or replace function public.record_export(p_org uuid, p_entity text, p_rows int)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_entity not in ('leads', 'audit_logs') then perform private.fail('VALIDATION_ERROR', 'Unknown export'); end if;
  if not public.has_perm(p_org, case p_entity when 'leads' then 'leads.export' else 'audit.view' end) then
    perform private.fail('FORBIDDEN', 'You cannot export this data');
  end if;
  perform private.write_audit(p_org, p_entity || '.exported', p_entity, null, jsonb_build_object('rows', greatest(0, least(p_rows, 1000000))));
end;
$$;

-- ───────────────────────── webhook intake (service role only) ─────────────────────────

create or replace function public.ingest_lead(p_org uuid, p_provider text, p_event_id text, p_payload jsonb, p_signature_ok boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  evt_id uuid;
  v_name text := left(trim(p_payload ->> 'name'), 160);
  v_phone text := nullif(trim(p_payload ->> 'phone'), '');
  v_email text := lower(nullif(trim(p_payload ->> 'email'), ''));
  v_locations text[] := coalesce((select array_agg(left(x, 120)) from (select x from jsonb_array_elements_text(coalesce(p_payload -> 'locations', '[]')) x limit 10) l), '{}');
  v_contact uuid;
  v_lead uuid;
  ch text;
begin
  if not exists (select 1 from public.organizations where id = p_org and deleted_at is null) then
    perform private.fail('NOT_FOUND', 'Unknown organization');
  end if;
  if not p_signature_ok then
    insert into public.webhook_events (organization_id, provider, provider_event_id, event_type, signature_verified, processing_status, last_error)
    values (p_org, p_provider, 'rejected:' || gen_random_uuid(), 'lead.created', false, 'rejected', 'Invalid signature');
    return jsonb_build_object('status', 'rejected');
  end if;

  insert into public.webhook_events (organization_id, provider, provider_event_id, event_type, signature_verified)
  values (p_org, p_provider, p_event_id, 'lead.created', true)
  on conflict (organization_id, provider, provider_event_id) do nothing
  returning id into evt_id;
  if evt_id is null then
    update public.webhook_events set attempt_count = attempt_count + 1
    where organization_id = p_org and provider = p_provider and provider_event_id = p_event_id;
    return jsonb_build_object('status', 'duplicate_event',
      'lead_id', (select lead_id from public.webhook_events where organization_id = p_org and provider = p_provider and provider_event_id = p_event_id));
  end if;

  if v_name is null or v_name = '' or (v_phone is null and v_email is null)
     or (v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
     or (v_phone is not null and length(regexp_replace(v_phone, '\D', '', 'g')) < 10) then
    update public.webhook_events set processing_status = 'failed', last_error = 'Payload validation failed: name and a valid phone or email are required', processed_at = now() where id = evt_id;
    return jsonb_build_object('status', 'invalid');
  end if;

  select id into v_contact from public.contacts
  where organization_id = p_org and ((v_phone is not null and phone_e164 = private.normalize_phone(v_phone)) or (v_email is not null and email_normalized = v_email))
  order by created_at limit 1;

  if v_contact is null then
    insert into public.contacts (organization_id, display_name, email, phone, roles, source)
    values (p_org, v_name, v_email, v_phone, array['buyer'], left(p_provider, 80)) returning id into v_contact;
    foreach ch in array array['phone', 'whatsapp', 'sms', 'email'] loop
      insert into public.communication_consents (organization_id, contact_id, channel, status)
      values (p_org, v_contact, ch, case when ch = any (coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(p_payload -> 'consent_channels', '[]')) x), '{}')) then 'granted' else 'unknown' end);
    end loop;
  end if;

  insert into public.leads (organization_id, contact_id, title, source, source_campaign, source_external_id, assigned_to, desired_locations,
    budget_max, summary, next_follow_up_at)
  values (p_org, v_contact, v_name, left(coalesce(p_payload ->> 'source', p_provider), 80), left(p_payload ->> 'campaign', 120), left(p_event_id, 200),
    private.pick_assignee(p_org, v_locations), v_locations,
    case when (p_payload ->> 'budget_max') ~ '^[0-9]+(\.[0-9]+)?$' then (p_payload ->> 'budget_max')::numeric end,
    left(p_payload ->> 'message', 2000), now() + interval '15 minutes')
  returning id into v_lead;

  update public.webhook_events set processing_status = 'processed', lead_id = v_lead, processed_at = now() where id = evt_id;
  return jsonb_build_object('status', 'created', 'lead_id', v_lead, 'contact_existed', v_contact is not null);
end;
$$;

-- Looks up the active intake secret for an org slug (service role only; used by the Edge Function).
create or replace function public.webhook_secret_for(p_slug text)
returns table (organization_id uuid, secret text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return query
  select o.id, (select ds.decrypted_secret from vault.decrypted_secrets ds where ds.id = i.secret_reference)
  from public.organizations o
  join public.integrations i on i.organization_id = o.id and i.provider = 'webhook' and i.status = 'connected'
  where o.slug = p_slug and o.deleted_at is null;
end;
$$;

-- Generates (or rotates) the intake signing secret. Returned once; stored only in Vault.
create or replace function public.rotate_webhook_secret(p_org uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  secret text := 'whsec_' || private.random_token();
  ref uuid;
begin
  if not public.has_perm(p_org, 'integrations.manage') then perform private.fail('FORBIDDEN', 'You cannot manage integrations'); end if;
  select secret_reference into ref from public.integrations where organization_id = p_org and provider = 'webhook';
  if ref is null then
    ref := vault.create_secret(secret, 'webhook:' || p_org::text, 'Lead intake signing secret');
    insert into public.integrations (organization_id, provider, integration_type, display_name, status, secret_reference, scopes)
    values (p_org, 'webhook', 'lead_source', 'Generic webhook', 'connected', ref, array['leads:write'])
    on conflict (organization_id, provider) do update set secret_reference = excluded.secret_reference, status = 'connected';
  else
    perform vault.update_secret(ref, secret);
    update public.integrations set status = 'connected' where organization_id = p_org and provider = 'webhook';
  end if;
  update public.organizations set webhook_secret_version = webhook_secret_version + 1 where id = p_org;
  perform private.write_audit(p_org, 'integrations.secret_rotated', 'integrations', null, '{}');
  return secret;
end;
$$;

-- ───────────────────────── execution privileges ─────────────────────────

revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function private.shares_org(uuid), private.is_active_member(uuid, uuid), private.fail(text, text),
  private.can_access_document_object(text, boolean), private.assert_same_org(text, uuid, uuid), private.assert_member(uuid, uuid, text),
  private.normalize_phone(text), private.score_lead(public.leads), private.pick_assignee(uuid, text[]), private.org_setting(uuid, text[]),
  private.actor_name()
  to authenticated;

revoke execute on function public.create_lead(uuid, jsonb, text), public.merge_leads(uuid, uuid), public.set_contact_consent(uuid, text, text, text),
  public.opt_out_contact(uuid), public.appointment_free_slots(uuid, uuid, timestamptz, int, int), public.lead_view_counts(uuid),
  public.mark_all_notifications_read(uuid), public.dashboard_metrics(uuid, timestamptz, timestamptz, text), public.rotate_webhook_secret(uuid),
  public.record_export(uuid, text, int)
  from public, anon;
grant execute on function public.create_lead(uuid, jsonb, text), public.merge_leads(uuid, uuid), public.set_contact_consent(uuid, text, text, text),
  public.opt_out_contact(uuid), public.appointment_free_slots(uuid, uuid, timestamptz, int, int), public.lead_view_counts(uuid),
  public.mark_all_notifications_read(uuid), public.dashboard_metrics(uuid, timestamptz, timestamptz, text), public.rotate_webhook_secret(uuid),
  public.record_export(uuid, text, int)
  to authenticated;

-- Intake functions are callable only with the service role (Edge Function).
revoke execute on function public.ingest_lead(uuid, text, text, jsonb, boolean), public.webhook_secret_for(text) from public, anon, authenticated;
grant execute on function public.ingest_lead(uuid, text, text, jsonb, boolean), public.webhook_secret_for(text) to service_role;

-- Anonymous visitors get nothing from the public schema.
revoke all on all tables in schema public from anon;
