-- Low-priority code-review fixes (additive).
-- 1. normalize_phone(raw, country) applies the same North American check as intake_phone: a 10-digit US/Canadian number
--    must have a valid area code and exchange (first digit 2-9), otherwise it is not stored as a +1 number (phone_e164
--    stays empty and the data-quality check reports the number as invalid). Indian and international rules are unchanged.
-- 2. appointments_after locks the lead before deciding whether a cancelled viewing was its last open one.

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
    when country in ('US', 'CA') and length(x.d) = 10 then case when x.d ~ '^[2-9][0-9]{2}[2-9]' then '+1' || x.d end
    when country in ('US', 'CA') and length(x.d) = 11 and x.d like '1%' then case when x.d ~ '^1[2-9][0-9]{2}[2-9]' then '+' || x.d end
    when country = 'IN' and length(x.d) = 10 then '+91' || x.d
    when country = 'IN' and length(x.d) = 11 and x.d like '0%' then '+91' || substring(x.d from 2)
    else '+' || x.d
  end
  from x;
$$;

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
      perform 1 from public.leads where id = new.lead_id for update;
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
