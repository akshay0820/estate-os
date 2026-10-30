-- Currency follows the workspace (for US clients). Additive.
-- 1. New workspaces default to US dollars (was INR). Existing workspaces keep their currency.
-- 2. New leads, listings and deals take their workspace's currency instead of a fixed column default, so a USD workspace
--    never gets INR budgets or prices. An explicitly supplied currency is kept. Commissions already copy their deal's.
-- 3. Owners and admins (settings.manage) may change a workspace's currency; amounts already stored are not converted.

alter table public.organizations alter column default_currency set default 'USD';

alter table public.leads alter column budget_currency drop default;
alter table public.properties alter column currency drop default;
alter table public.deals alter column currency drop default;

create or replace function private.lead_inherit_currency()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.budget_currency is null then
    select o.default_currency into new.budget_currency from public.organizations o where o.id = new.organization_id;
  end if;
  return new;
end;
$$;

create or replace function private.inherit_currency()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.currency is null then
    select o.default_currency into new.currency from public.organizations o where o.id = new.organization_id;
  end if;
  return new;
end;
$$;

-- "00" sorts before the other BEFORE INSERT triggers on these tables, so they all see the filled-in currency.
create trigger leads_00_currency before insert on public.leads for each row execute function private.lead_inherit_currency();
create trigger properties_00_currency before insert on public.properties for each row execute function private.inherit_currency();
create trigger deals_00_currency before insert on public.deals for each row execute function private.inherit_currency();
revoke execute on function private.lead_inherit_currency(), private.inherit_currency() from public, anon, authenticated;

grant update (default_currency) on public.organizations to authenticated;
