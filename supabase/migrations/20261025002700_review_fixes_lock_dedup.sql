-- Code-review fixes (additive).
-- 1. appointments_after serialises cancellations of one lead's viewings with a transaction advisory lock instead of a
--    row lock on the lead. A merge locks the lead and then its appointments; a cancellation held the appointment and then
--    locked the lead, so the two could deadlock. The advisory lock is taken by cancellations only, so it cannot form a cycle.
-- 2. create_lead matches a phone that does not normalize (e.g. an invalid North American number, stored with an empty
--    phone_e164) against other contacts whose phone did not normalize either, by digits, so the same mistyped number
--    entered twice is reported as a duplicate instead of creating a second contact.

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
    -- A cancelled viewing that leaves the lead with no other open viewing puts the lead back where it was before the booking.
    if new.status = 'cancelled' and new.appointment_type = 'viewing' and new.lead_id is not null then
      -- Serialise cancellations of the same lead's viewings: the check below then sees any cancellation that committed
      -- while this one waited, so two viewings cancelled at once cannot both leave the lead on "visit scheduled".
      -- An advisory lock (not a lead row lock) so this never waits on a lead held by a merge that waits on this appointment.
      perform pg_advisory_xact_lock(hashtext('lead_visits:' || new.lead_id::text));
    end if;
    if new.status = 'cancelled' and new.appointment_type = 'viewing' and new.lead_id is not null
       and not exists (select 1 from public.appointments x where x.lead_id = new.lead_id and x.id <> new.id and x.appointment_type = 'viewing'
                       and x.status in ('requested', 'pending', 'confirmed', 'reschedule_requested')) then
      update public.leads l set status = coalesce((
          select h.from_status from public.lead_status_history h
          where h.lead_id = new.lead_id and h.to_status = 'visit_scheduled'
            and h.from_status in ('new', 'attempting', 'contacted', 'qualified', 'matching')
          order by h.created_at desc limit 1), 'contacted')
      where l.id = new.lead_id and l.status = 'visit_scheduled';
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
  v_e164 text;
  v_digits text;
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

    v_e164 := private.normalize_phone(v_phone, (select o.country_code from public.organizations o where o.id = p_org));
    -- A phone that does not normalize is matched by digits against contacts whose phone did not normalize either.
    if v_phone is not null and v_e164 is null then v_digits := regexp_replace(v_phone, '\D', '', 'g'); end if;

    select jsonb_agg(jsonb_build_object('contact_id', c.id, 'name', c.display_name,
             'reasons', to_jsonb(array_remove(array[
               case when c.phone_e164 = v_e164
                      or (c.phone_e164 is null and regexp_replace(coalesce(c.phone, ''), '\D', '', 'g') = v_digits) then 'Same phone' end,
               case when c.email_normalized = v_email then 'Same email' end], null))))
      into dupes
    from public.contacts c
    where c.organization_id = p_org
      and (c.phone_e164 = v_e164
           or (c.phone_e164 is null and regexp_replace(coalesce(c.phone, ''), '\D', '', 'g') = v_digits)
           or (v_email is not null and c.email_normalized = v_email));

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
