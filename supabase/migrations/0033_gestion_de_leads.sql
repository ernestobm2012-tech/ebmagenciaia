-- Gestión de cada lead desde el panel: estado, quién lo lleva, fecha para volver
-- a llamar y notas con historial. El cliente no edita la fila directamente: todo
-- pasa por la función update_lead, que comprueba el acceso y deja la nota.
-- El cron lead-followups avisa (push y correo) cuando llega la hora de volver a llamar.

-- Estados nuevos (al aplicarla todos los leads estaban en 'new', no hubo que traducir).
alter table public.leads drop constraint leads_status_check,
  add constraint leads_status_check check (status in ('new', 'to_call', 'called', 'waiting', 'callback', 'won', 'lost'));

alter table public.leads
  add column assigned_to uuid references public.profiles (id) on delete set null,
  add column follow_up_at timestamptz,
  add column followup_notified_at timestamptz,
  add column updated_at timestamptz;
create index leads_follow_up_idx on public.leads (follow_up_at) where follow_up_at is not null;

create table public.lead_notes (
  id          uuid primary key default gen_random_uuid(),
  lead_id     uuid not null references public.leads (id) on delete cascade,
  client_id   uuid not null references public.clients (id) on delete cascade,
  author_id   uuid references public.profiles (id) on delete set null,
  author_name text,
  body        text,
  status_from text,
  status_to   text,
  created_at  timestamptz not null default now()
);
create index lead_notes_lead_idx on public.lead_notes (lead_id, created_at desc);

alter table public.lead_notes enable row level security;
create policy read_own_or_admin on public.lead_notes for select to authenticated
  using ((select private.is_admin()) or (client_id = any ((select private.my_client_ids())::uuid[]) and (select private.can_see('act_leads'))));
grant select on public.lead_notes to authenticated;

-- ¿Puede el usuario actual gestionar los leads de este cliente?
create function private.can_manage_leads(p_client uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select (select private.is_admin())
      or (p_client = any ((select private.my_client_ids())::uuid[]) and (select private.can_see('act_leads')));
$$;

-- Personas a las que se puede asignar un lead de este cliente: las del propio
-- cliente y los partners de los que cuelga.
create function public.lead_team(p_client uuid) returns table (id uuid, name text)
language sql stable security definer set search_path = ''
as $$
  select p.id, coalesce(nullif(p.full_name, ''), p.email)
  from public.profiles p
  join public.clients c on c.id = p_client
  where (select private.can_manage_leads(p_client))
    and p.role in ('client', 'partner')
    and (p.client_id = c.id or (p.role = 'partner' and p.client_id = c.parent_client_id))
  order by 2;
$$;
revoke execute on function public.lead_team(uuid) from public, anon;
grant execute on function public.lead_team(uuid) to authenticated;

-- Cambia estado, fecha de volver a llamar y responsable, y apunta la nota.
-- p_follow_up_at: null la quita. p_assigned_to: null deja el lead sin asignar.
create function public.update_lead(p_id uuid, p_status text, p_follow_up_at timestamptz,
  p_assigned_to uuid, p_note text) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_lead public.leads;
  v_name text;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select * into v_lead from public.leads where id = p_id for update;
  if not found or not (select private.can_manage_leads(v_lead.client_id)) then
    raise exception 'No tienes acceso a este contacto.';
  end if;
  if p_status not in ('new', 'to_call', 'called', 'waiting', 'callback', 'won', 'lost') then
    raise exception 'Estado no válido.';
  end if;
  if p_assigned_to is not null and not exists (select 1 from public.lead_team(v_lead.client_id) t where t.id = p_assigned_to) then
    raise exception 'Esa persona no pertenece a este negocio.';
  end if;

  update public.leads set
    status = p_status,
    follow_up_at = p_follow_up_at,
    followup_notified_at = case when p_follow_up_at is distinct from v_lead.follow_up_at then null else followup_notified_at end,
    assigned_to = p_assigned_to,
    updated_at = now()
  where id = p_id;

  if v_note is not null or p_status <> v_lead.status then
    select coalesce(nullif(full_name, ''), email) into v_name from public.profiles where id = (select auth.uid());
    insert into public.lead_notes (lead_id, client_id, author_id, author_name, body, status_from, status_to)
    values (p_id, v_lead.client_id, (select auth.uid()), v_name, left(v_note, 4000),
            case when p_status <> v_lead.status then v_lead.status end,
            case when p_status <> v_lead.status then p_status end);
  end if;
end;
$$;
revoke execute on function public.update_lead(uuid, text, timestamptz, uuid, text) from public, anon;
grant execute on function public.update_lead(uuid, text, timestamptz, uuid, text) to authenticated;

-- Avisos de «volver a llamar»: cada 10 minutos.
select cron.schedule('lead-followups', '*/10 * * * *', $$
  select net.http_post(
    url := 'https://rhjbpkaesobsbnkvioyh.supabase.co/functions/v1/push?action=followups',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
$$);
