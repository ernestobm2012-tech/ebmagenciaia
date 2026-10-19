-- Equipo de cada cliente para la gestión de leads: quién llama (llamadas) y los
-- comerciales a los que se pasa el contacto. No hace falta que tengan usuario del
-- panel; si lo tienen, se enlaza (profile_id) para el filtro «Míos» y los avisos al móvil.
-- Cada lead guarda quién lo gestiona (caller_id), a qué comercial se pasó (seller_id),
-- el importe si se cierra y las fechas para las estadísticas.

create table public.team_members (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references public.clients (id) on delete cascade,
  name       text not null,
  role       text not null check (role in ('llamadas', 'comercial')),
  email      text,
  phone      text,
  profile_id uuid references public.profiles (id) on delete set null,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
create index team_members_client_idx on public.team_members (client_id, role);

alter table public.team_members enable row level security;
create policy team_read on public.team_members for select to authenticated
  using ((select private.can_manage_leads(client_id)));
create policy team_insert on public.team_members for insert to authenticated
  with check ((select private.can_manage_leads(client_id)));
create policy team_update on public.team_members for update to authenticated
  using ((select private.can_manage_leads(client_id))) with check ((select private.can_manage_leads(client_id)));
create policy team_delete on public.team_members for delete to authenticated
  using ((select private.can_manage_leads(client_id)));
grant select, insert, update, delete on public.team_members to authenticated;

alter table public.leads drop constraint leads_status_check,
  add constraint leads_status_check check (status in ('new', 'to_call', 'called', 'waiting', 'callback', 'with_sales', 'won', 'lost'));

alter table public.leads
  add column caller_id uuid references public.team_members (id) on delete set null,
  add column seller_id uuid references public.team_members (id) on delete set null,
  add column deal_value numeric(12, 2),
  add column first_contact_at timestamptz,
  add column passed_at timestamptz,
  add column closed_at timestamptz;

-- La versión anterior de update_lead (5 parámetros, de la 0033) se dejó sin borrar
-- porque el DROP se queda esperando aprobación; el panel ya solo usa la nueva.

-- Cambia estado, fecha de volver a llamar, quién lo gestiona, comercial e importe,
-- y apunta la nota con lo que ha cambiado.
create or replace function public.update_lead(p_id uuid, p_status text, p_follow_up_at timestamptz,
  p_caller uuid, p_seller uuid, p_value numeric, p_note text) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_lead public.leads;
  v_name text;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_changes text[] := '{}';
  v_who text;
begin
  select * into v_lead from public.leads where id = p_id for update;
  if not found or not (select private.can_manage_leads(v_lead.client_id)) then
    raise exception 'No tienes acceso a este contacto.';
  end if;
  if p_status not in ('new', 'to_call', 'called', 'waiting', 'callback', 'with_sales', 'won', 'lost') then
    raise exception 'Estado no válido.';
  end if;
  if p_caller is not null and not exists (select 1 from public.team_members t where t.id = p_caller and t.client_id = v_lead.client_id) then
    raise exception 'Esa persona no es del equipo de este negocio.';
  end if;
  if p_seller is not null and not exists (select 1 from public.team_members t where t.id = p_seller and t.client_id = v_lead.client_id and t.role = 'comercial') then
    raise exception 'Ese comercial no es del equipo de este negocio.';
  end if;

  if p_caller is distinct from v_lead.caller_id then
    select name into v_who from public.team_members where id = p_caller;
    v_changes := v_changes || ('Lo gestiona: ' || coalesce(v_who, 'nadie'));
  end if;
  if p_seller is distinct from v_lead.seller_id then
    select name into v_who from public.team_members where id = p_seller;
    v_changes := v_changes || ('Comercial: ' || coalesce(v_who, 'ninguno'));
  end if;
  if p_value is distinct from v_lead.deal_value and p_value is not null then
    v_changes := v_changes || ('Importe: ' || replace(to_char(p_value, 'FM999999990.00'), '.', ',') || ' €');
  end if;

  update public.leads set
    status = p_status,
    follow_up_at = p_follow_up_at,
    followup_notified_at = case when p_follow_up_at is distinct from v_lead.follow_up_at then null else followup_notified_at end,
    caller_id = p_caller,
    seller_id = p_seller,
    deal_value = p_value,
    first_contact_at = case when first_contact_at is null and p_status not in ('new', 'to_call') then now() else first_contact_at end,
    passed_at = case when passed_at is null and (p_seller is not null or p_status = 'with_sales') then now() else passed_at end,
    closed_at = case when p_status in ('won', 'lost') then coalesce(case when v_lead.status = p_status then closed_at end, now()) else null end,
    updated_at = now()
  where id = p_id;

  if v_note is not null or p_status <> v_lead.status or cardinality(v_changes) > 0 then
    select coalesce(nullif(full_name, ''), email) into v_name from public.profiles where id = (select auth.uid());
    insert into public.lead_notes (lead_id, client_id, author_id, author_name, body, status_from, status_to)
    values (p_id, v_lead.client_id, (select auth.uid()), v_name,
            left(concat_ws(E'\n', nullif(array_to_string(v_changes, ' · '), ''), v_note), 4000),
            case when p_status <> v_lead.status then v_lead.status end,
            case when p_status <> v_lead.status then p_status end);
  end if;
end;
$$;
revoke execute on function public.update_lead(uuid, text, timestamptz, uuid, uuid, numeric, text) from public, anon;
grant execute on function public.update_lead(uuid, text, timestamptz, uuid, uuid, numeric, text) to authenticated;

-- Aviso a la persona a la que se pasa un lead (quien llama o el comercial).
create function private.lead_assigned_event() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.seller_id is not null and new.seller_id is distinct from old.seller_id then
    perform net.http_post(
      url := 'https://rhjbpkaesobsbnkvioyh.supabase.co/functions/v1/push?action=assigned',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := jsonb_build_object('lead_id', new.id, 'member_id', new.seller_id));
  end if;
  if new.caller_id is not null and new.caller_id is distinct from old.caller_id then
    perform net.http_post(
      url := 'https://rhjbpkaesobsbnkvioyh.supabase.co/functions/v1/push?action=assigned',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := jsonb_build_object('lead_id', new.id, 'member_id', new.caller_id));
  end if;
  return new;
end;
$$;
create trigger leads_assigned after update of seller_id, caller_id on public.leads
  for each row execute function private.lead_assigned_event();
