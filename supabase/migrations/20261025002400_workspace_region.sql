-- Phones and time zones follow the workspace's country (for US clients). Additive.
-- 1. New workspaces default to country US and time zone America/New_York (the setup form sends the creator's own zone).
--    Existing workspaces keep theirs; owners and admins can change the country in Settings.
-- 2. private.normalize_phone(raw, country): a number without a country code takes the workspace country's code
--    (US/CA: 10 digits -> +1; IN: 10 digits -> +91). Contacts and create_lead's duplicate check use it. The one-argument
--    version is kept unchanged for the legacy ingest_lead (no callers).
-- 3. Webhook / import intake (intake_phone) recognises US and Canadian numbers; data-quality checks validate +1 numbers
--    and no longer say India was assumed.
-- Appointments already take their workspace's time zone (appointments_before), so a US workspace books in US time.

alter table public.organizations alter column country_code set default 'US';
alter table public.organizations alter column timezone set default 'America/New_York';
grant update (country_code) on public.organizations to authenticated;

create or replace function private.normalize_phone(raw text, country text)
returns text
language sql
immutable
set search_path = ''
as $$
  with x as (select regexp_replace(coalesce(raw, ''), '\D', '', 'g') d, coalesce(raw, '') ~ '^\s*(\+|00)' intl)
  select case
    when x.d = '' then null
    when x.intl then '+' || case when raw ~ '^\s*00' then substring(x.d from 3) else x.d end
    when country in ('US', 'CA') and length(x.d) = 10 then '+1' || x.d
    when country in ('US', 'CA') and length(x.d) = 11 and x.d like '1%' then '+' || x.d
    when country = 'IN' and length(x.d) = 10 then '+91' || x.d
    when country = 'IN' and length(x.d) = 11 and x.d like '0%' then '+91' || substring(x.d from 2)
    else '+' || x.d
  end
  from x;
$$;
-- Same privileges as the one-argument version: contacts_before runs as the signed-in user.
revoke execute on function private.normalize_phone(text, text) from public, anon;
grant execute on function private.normalize_phone(text, text) to authenticated;

create or replace function private.contacts_before()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.email := nullif(trim(new.email), '');
  new.phone := nullif(trim(new.phone), '');
  new.email_normalized := lower(new.email);
  new.phone_e164 := private.normalize_phone(new.phone, (select o.country_code from public.organizations o where o.id = new.organization_id));
  perform private.assert_member(new.organization_id, new.assigned_to, 'Owner');
  if tg_op = 'INSERT' then new.created_by := auth.uid(); end if;
  new.updated_by := auth.uid();
  return new;
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
               case when c.phone_e164 = private.normalize_phone(v_phone, (select o.country_code from public.organizations o where o.id = p_org)) then 'Same phone' end,
               case when c.email_normalized = v_email then 'Same email' end], null))))
      into dupes
    from public.contacts c
    where c.organization_id = p_org
      and ((v_phone is not null and c.phone_e164 = private.normalize_phone(v_phone, (select o.country_code from public.organizations o where o.id = p_org))) or (v_email is not null and c.email_normalized = v_email));

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

create or replace function private.intake_phone(raw text, country text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  d text := regexp_replace(coalesce(raw, ''), '\D', '', 'g');
  intl boolean := coalesce(raw, '') ~ '^\s*(\+|00)';
begin
  if d = '' then return null; end if;
  if intl then
    if coalesce(raw, '') ~ '^\s*00' then d := substring(d from 3); end if;
    if char_length(d) between 8 and 15 and d !~ '^0' then return '+' || d; end if;
    return null;
  end if;
  -- United States and Canada (NANP): 10 digits with a valid area code, or 11 starting with the country code 1.
  if country in ('US', 'CA') then
    if char_length(d) = 10 and d ~ '^[2-9][0-9]{2}[2-9]' then return '+1' || d; end if;
    if char_length(d) = 11 and d ~ '^1[2-9][0-9]{2}[2-9]' then return '+' || d; end if;
  end if;
  if country = 'IN' then
    if char_length(d) = 10 and d !~ '^0' then return '+91' || d; end if;
    if char_length(d) = 11 and d ~ '^0[1-9]' then return '+91' || substring(d from 2); end if;
    if char_length(d) = 12 and d ~ '^91[1-9]' then return '+' || d; end if;
  end if;
  return null;
end;
$$;

create or replace function private.dq_phone_check(raw text, e164 text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when raw is null then null
    when e164 is null then 'invalid'
    when e164 like '+91%' and substr(e164, 4) !~ '^[2-9][0-9]{9}$' then 'invalid'
    when e164 like '+1%' and substr(e164, 3) !~ '^[2-9][0-9]{2}[2-9][0-9]{6}$' then 'invalid'
    when e164 !~ '^\+[1-9][0-9]{7,14}$' then 'invalid'
    when raw !~ '^\s*(\+|00)' and length(regexp_replace(raw, '\D', '', 'g')) = 10 then 'country_assumed'
    else null end;
$$;

create or replace function private.dq_findings(et text, eid uuid, rules jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  res jsonb := '[]';
  c public.contacts;
  l public.leads;
  p public.properties;
  a public.appointments;
  i public.integrations;
  q public.lead_qualifications;
  chk text;
  v_name text;
  th jsonb;
  allowed text[];
  active text[] := array['requested', 'pending', 'confirmed', 'reschedule_requested'];
  residential text[] := array['apartment', 'penthouse', 'villa', 'house', 'townhouse'];
  v_org uuid;
begin
  if et = 'contact' then
    select * into c from public.contacts where id = eid;
    chk := private.dq_phone_check(c.phone, c.phone_e164);
    if chk = 'invalid' then
      res := res || private.dq_f('contact.phone_invalid', 'high', 'validity', 'The phone number is not a valid number',
        jsonb_build_object('field', 'phone'), 'Correct the phone number or remove it');
    elsif chk = 'country_assumed' then
      res := res || private.dq_f('contact.phone_country_assumed', 'info', 'validity',
        'The phone number had no country code, so the workspace country''s code (' || coalesce(substring(c.phone_e164 from '^\+(?:1|91)'), 'unknown') || ') was assumed',
        jsonb_build_object('field', 'phone', 'assumed_country_code', coalesce(substring(c.phone_e164 from '^\+(?:1|91)'), 'unknown')), 'Confirm the country code with the contact');
    end if;
    if not private.dq_email_ok(c.email) then
      res := res || private.dq_f('contact.email_malformed', 'warning', 'validity', 'The email address looks malformed',
        jsonb_build_object('field', 'email'), 'Check the spelling of the email address');
    end if;
    v_name := regexp_replace(trim(c.display_name), '\s+', ' ', 'g');
    if v_name <> c.display_name and v_name <> '' then
      res := res || private.dq_f('contact.name_whitespace', 'info', 'consistency', 'The name has extra spaces',
        jsonb_build_object('field', 'display_name'), 'Apply the cleaned-up name', jsonb_build_object('field', 'display_name', 'value', v_name));
    end if;
    if c.display_name ~ '^[+0-9 ().-]{6,}$' or position('@' in c.display_name) > 0 then
      res := res || private.dq_f('contact.name_is_contact_detail', 'warning', 'validity', 'The name field contains a phone number or email address',
        jsonb_build_object('field', 'display_name'), 'Ask for the contact''s name and update it');
    end if;
    if c.lifecycle_status = 'do_not_contact' and exists (select 1 from public.communication_consents x where x.contact_id = c.id and x.status = 'granted') then
      res := res || private.dq_f('contact.dnc_consent_conflict', 'high', 'consistency', 'The contact is on the do-not-contact list but still has a granted consent',
        jsonb_build_object('channels', (select jsonb_agg(x.channel || ':' || x.purpose) from public.communication_consents x where x.contact_id = c.id and x.status = 'granted')),
        'Revoke the remaining consents or confirm the contact''s wishes');
    end if;
    if c.lifecycle_status <> 'do_not_contact' and c.preferred_contact_channel <> 'none'
       and not exists (select 1 from public.communication_consents x where x.contact_id = c.id and x.channel = c.preferred_contact_channel
                         and x.purpose = 'service' and x.status <> 'unknown') then
      res := res || private.dq_f('contact.consent_unknown', 'info', 'completeness', 'No consent decision is recorded for the preferred channel',
        jsonb_build_object('channel', c.preferred_contact_channel), 'Record the contact''s consent for this channel');
    end if;
    if c.source is null then
      res := res || private.dq_f('contact.source_missing', 'info', 'provenance', 'Where this contact came from is not recorded',
        jsonb_build_object('field', 'source'), 'Add the source');
    end if;

  elsif et = 'lead' then
    select * into l from public.leads where id = eid;
    select organization_id into v_org from public.contacts where id = l.contact_id;
    if v_org is distinct from l.organization_id then
      res := res || private.dq_f('lead.cross_tenant_contact', 'critical', 'referential_integrity', 'The lead points to a contact outside this workspace',
        jsonb_build_object('field', 'contact_id'), 'Stop using this lead and contact support');
    end if;
    th := rules -> 'budget_plausibility' -> l.budget_currency::text;
    if th is not null and l.budget_max is not null then
      if l.desired_transaction = 'rent' and l.budget_max > (th ->> 'rent_max')::numeric then
        res := res || private.dq_f('lead.rent_budget_implausible', 'warning', 'consistency', 'The rent budget looks like a purchase price',
          jsonb_build_object('field', 'budget_max', 'threshold', th -> 'rent_max', 'currency', l.budget_currency), 'Check whether the lead wants to rent or buy, and the budget');
      elsif l.desired_transaction in ('buy', 'invest') and l.budget_max < (th ->> 'purchase_min')::numeric then
        res := res || private.dq_f('lead.purchase_budget_implausible', 'warning', 'consistency', 'The purchase budget looks like a monthly rent',
          jsonb_build_object('field', 'budget_max', 'threshold', th -> 'purchase_min', 'currency', l.budget_currency), 'Check whether the lead wants to buy or rent, and the budget');
      end if;
    end if;
    allowed := case l.lead_type when 'buyer' then array['buy', 'invest'] when 'investor' then array['buy', 'invest'] when 'tenant' then array['rent']
                                when 'seller' then array['sell'] when 'landlord' then array['let'] end;
    if not (l.desired_transaction = any (allowed)) then
      res := res || private.dq_f('lead.type_transaction_mismatch', 'warning', 'consistency',
        format('A %s lead is marked as wanting to %s', l.lead_type, l.desired_transaction),
        jsonb_build_object('fields', jsonb_build_array('lead_type', 'desired_transaction')), 'Correct the lead type or the transaction');
    end if;
    if l.assigned_to is null and l.status not in ('won', 'lost') then
      res := res || private.dq_f('lead.unassigned', 'warning', 'workflow_integrity', 'Nobody owns this open lead',
        jsonb_build_object('field', 'assigned_to'), 'Assign an owner');
    end if;
    if l.status in ('qualified', 'matching', 'visit_scheduled', 'visit_completed', 'negotiation') and l.budget_max is null and l.desired_transaction in ('buy', 'rent', 'invest') then
      res := res || private.dq_f('lead.budget_missing', 'info', 'completeness', 'The lead is past qualification but has no budget',
        jsonb_build_object('field', 'budget_max', 'status', l.status), 'Ask for and record the budget');
    end if;
    select * into q from public.lead_qualifications x where x.lead_id = l.id and x.is_current order by x.created_at desc limit 1;
    if q.id is not null and l.status not in ('won', 'lost') and q.created_at < now() - make_interval(days => coalesce((rules ->> 'qualification_stale_days')::int, 30)) then
      res := res || private.dq_f('lead.qualification_stale', 'info', 'freshness', 'The qualification is old; requirements may have changed',
        jsonb_build_object('age_days', extract(day from now() - q.created_at)::int), 'Re-qualify the lead');
    end if;
    if l.status = 'visit_scheduled' and not exists (select 1 from public.appointments x where x.lead_id = l.id and x.status = any (active)) then
      res := res || private.dq_f('lead.visit_without_appointment', 'warning', 'workflow_integrity', 'The lead is at "visit scheduled" but has no active appointment',
        jsonb_build_object('status', l.status), 'Book the visit or move the lead to the right stage');
    elsif l.status = 'visit_completed' and not exists (select 1 from public.appointments x where x.lead_id = l.id and x.status = 'completed') then
      res := res || private.dq_f('lead.visit_unrecorded', 'info', 'workflow_integrity', 'The lead is at "visit completed" but no appointment is recorded as completed',
        jsonb_build_object('status', l.status), 'Record the visit outcome on the appointment');
    end if;
    if l.source_external_id is not null and exists (select 1 from public.leads x where x.organization_id = l.organization_id and x.id <> l.id and x.archived_at is null
                                                     and x.source = l.source and x.source_external_id = l.source_external_id) then
      res := res || private.dq_f('lead.external_id_collision', 'high', 'uniqueness', 'Another open lead has the same source and external id',
        jsonb_build_object('fields', jsonb_build_array('source', 'source_external_id')), 'Review the duplicate enquiry and merge or correct it');
    end if;

  elsif et = 'property' then
    select * into p from public.properties where id = eid;
    if p.owner_contact_id is not null then
      select organization_id into v_org from public.contacts where id = p.owner_contact_id;
      if v_org is distinct from p.organization_id then
        res := res || private.dq_f('property.cross_tenant_owner', 'critical', 'referential_integrity', 'The listing''s owner contact is outside this workspace',
          jsonb_build_object('field', 'owner_contact_id'), 'Remove the owner link and contact support');
      end if;
    end if;
    th := rules -> 'property_price_plausibility' -> p.currency::text;
    if th is not null then
      if p.listing_type = 'sale' and p.price < (th ->> 'sale_min')::numeric then
        res := res || private.dq_f('property.sale_price_implausible', 'warning', 'consistency', 'The sale price looks like a monthly rent',
          jsonb_build_object('field', 'price', 'threshold', th -> 'sale_min', 'currency', p.currency), 'Check the price and the listing type');
      elsif p.listing_type = 'rent' and p.price > (th ->> 'rent_max')::numeric then
        res := res || private.dq_f('property.rent_price_implausible', 'warning', 'consistency', 'The rent looks like a sale price',
          jsonb_build_object('field', 'price', 'threshold', th -> 'rent_max', 'currency', p.currency), 'Check the price and the listing type');
      end if;
    end if;
    if p.property_type in ('plot', 'office', 'retail', 'commercial') and p.bedrooms > 0 then
      res := res || private.dq_f('property.bedrooms_not_applicable', 'warning', 'validity', format('A %s listing has %s bedrooms', p.property_type, p.bedrooms),
        jsonb_build_object('field', 'bedrooms'), 'Set bedrooms to 0 or correct the property type');
    end if;
    if p.property_type = any (residential) and ((p.area_unit = 'sqft' and (p.area_value < 150 or p.area_value > 50000))
                                                or (p.area_unit = 'sqm' and (p.area_value < 15 or p.area_value > 5000))) then
      res := res || private.dq_f('property.area_implausible', 'warning', 'validity', format('The area (%s %s) is unusual for a %s', p.area_value, p.area_unit, p.property_type),
        jsonb_build_object('fields', jsonb_build_array('area_value', 'area_unit')), 'Check the area and its unit');
    end if;
    if p.status = 'active' and p.verified_at is null then
      res := res || private.dq_f('property.unverified_active', 'info', 'provenance', 'The listing is active but has never been verified',
        jsonb_build_object('field', 'verified_at'), 'Verify the listing details');
    end if;
    if p.status = 'active' and greatest(p.updated_at, coalesce(p.verified_at, p.updated_at)) < now() - make_interval(days => coalesce((rules ->> 'property_stale_days')::int, 90)) then
      res := res || private.dq_f('property.stale_listing', 'warning', 'freshness', 'The active listing has not been updated or verified for a long time',
        jsonb_build_object('days_since_update', extract(day from now() - greatest(p.updated_at, coalesce(p.verified_at, p.updated_at)))::int),
        'Confirm the listing is still available and its price is current');
    end if;
    if p.status = 'active' and exists (select 1 from public.deals d where d.property_id = p.id and d.stage = 'won') then
      res := res || private.dq_f('property.active_with_won_deal', 'high', 'workflow_integrity', 'The listing is active but a deal on it is won',
        jsonb_build_object('field', 'status'), 'Mark the listing sold or let');
    end if;
    if p.address_line_1 is null or p.city is null then
      res := res || private.dq_f('property.address_incomplete', 'info', 'completeness', 'The address is incomplete',
        jsonb_build_object('missing', to_jsonb(array_remove(array[case when p.address_line_1 is null then 'address_line_1' end, case when p.city is null then 'city' end], null))),
        'Add the street address and city');
    end if;

  elsif et = 'appointment' then
    select * into a from public.appointments where id = eid;
    if (a.lead_id is not null and (select organization_id from public.leads where id = a.lead_id) is distinct from a.organization_id)
       or (a.property_id is not null and (select organization_id from public.properties where id = a.property_id) is distinct from a.organization_id) then
      res := res || private.dq_f('appointment.cross_tenant_reference', 'critical', 'referential_integrity', 'The appointment points to a record outside this workspace',
        jsonb_build_object('fields', jsonb_build_array('lead_id', 'property_id')), 'Cancel the appointment and contact support');
    end if;
    if a.status = any (active) and a.appointment_type = 'viewing' and a.property_id is not null
       and (select status from public.properties where id = a.property_id) <> 'active' then
      res := res || private.dq_f('appointment.property_unavailable', 'high', 'workflow_integrity', 'An active viewing is booked for a listing that is no longer active',
        jsonb_build_object('field', 'property_id'), 'Reschedule to another listing or cancel the viewing');
    end if;
    if a.status = any (active) and a.ends_at < now() - interval '24 hours' then
      res := res || private.dq_f('appointment.outcome_missing', 'warning', 'workflow_integrity', 'The appointment is over but its outcome was not recorded',
        jsonb_build_object('status', a.status), 'Mark it completed, no-show or cancelled');
    end if;
    if a.status = any (active) and a.starts_at > now() and a.lead_id is not null
       and exists (select 1 from public.leads x where x.id = a.lead_id and (x.archived_at is not null or x.status in ('won', 'lost'))) then
      res := res || private.dq_f('appointment.lead_closed', 'warning', 'consistency', 'An upcoming appointment belongs to a closed or archived lead',
        jsonb_build_object('field', 'lead_id'), 'Cancel the appointment or reopen the lead');
    end if;
    if a.status = any (active) and a.starts_at > now() and a.assigned_to is not null and not private.is_active_member(a.organization_id, a.assigned_to) then
      res := res || private.dq_f('appointment.assignee_inactive', 'high', 'workflow_integrity', 'An upcoming appointment is assigned to someone no longer active',
        jsonb_build_object('field', 'assigned_to'), 'Reassign the appointment');
    end if;
    if a.status = any (active) and a.calendar_sync_status = 'failed' then
      res := res || private.dq_f('appointment.calendar_sync_failed', 'warning', 'sync_integrity', 'The appointment could not be written to the connected calendar',
        jsonb_build_object('field', 'calendar_sync_status'), 'Check the calendar and the task created for it');
    end if;

  elsif et = 'integration' then
    select * into i from public.integrations where id = eid;
    if i.status in ('error', 'needs_reauth') then
      res := res || private.dq_f('integration.unhealthy', 'high', 'sync_integrity', format('%s is %s', i.display_name, replace(i.status, '_', ' ')),
        jsonb_build_object('status', i.status, 'type', i.integration_type), 'Reconnect the integration');
    elsif i.status = 'connected' and (i.last_synced_at is null or i.last_synced_at < now() - make_interval(hours => coalesce((rules ->> 'integration_stale_hours')::int, 48))) then
      res := res || private.dq_f('integration.stale', 'warning', 'sync_integrity', format('%s has no recent successful sync', i.display_name),
        jsonb_build_object('last_synced_at', i.last_synced_at, 'type', i.integration_type), 'Check the integration');
    end if;
  end if;
  return res;
end;
$$;

create or replace function public.create_organization(p_name text, p_city text default null, p_timezone text default 'America/New_York')
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  base text;
  candidate text;
  n int := 0;
  org_id uuid;
begin
  if uid is null then perform private.fail('UNAUTHENTICATED', 'Sign in first'); end if;
  if p_name is null or char_length(trim(p_name)) < 2 or char_length(trim(p_name)) > 120 then
    perform private.fail('VALIDATION_ERROR', 'Organization name must be 2–120 characters');
  end if;
  if (select count(*) from public.organization_memberships where user_id = uid and role = 'owner') >= 10 then
    perform private.fail('RATE_LIMITED', 'Too many organizations for this account');
  end if;
  base := trim(both '-' from regexp_replace(lower(trim(p_name)), '[^a-z0-9]+', '-', 'g'));
  if base = '' then base := 'workspace'; end if;
  base := left(base, 50);
  candidate := base;
  while exists (select 1 from public.organizations where slug = candidate) loop
    n := n + 1;
    candidate := base || '-' || n;
  end loop;

  insert into public.organizations (name, slug, city, timezone, created_by)
  values (trim(p_name), candidate, nullif(trim(p_city), ''), coalesce(nullif(p_timezone, ''), 'America/New_York'), uid)
  returning id into org_id;

  insert into public.organization_memberships (organization_id, user_id, role, title)
  values (org_id, uid, 'owner', 'Owner');
  return org_id;
end;
$$;
