-- «En proceso»: quien abre la ficha de un contacto lo marca como atendido para que el resto
-- del equipo lo vea. Caduca solo a los 3 minutos sin señal (cada minuto se renueva mientras la ficha sigue abierta).
create table if not exists public.lead_presence (
  lead_id uuid primary key references public.leads(id) on delete cascade,
  client_id uuid not null,
  user_id uuid not null,
  user_name text,
  seen_at timestamptz not null default now()
);
alter table public.lead_presence enable row level security;
create policy presence_read on public.lead_presence for select to authenticated
  using ((select private.is_admin()) or (client_id = any ((select private.my_client_ids())::uuid[]) and (select private.can_see('act_leads'::text))));
revoke all on public.lead_presence from anon;
grant select on public.lead_presence to authenticated;

create or replace function public.lead_presence_set(p_id uuid, p_on boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v_client uuid; v_name text;
begin
  select client_id into v_client from public.leads l
   where l.id = p_id and (private.is_admin() or (l.client_id = any (private.my_client_ids()::uuid[]) and private.can_see('act_leads')));
  if v_client is null then return; end if;
  if p_on then
    select coalesce(nullif(full_name, ''), email) into v_name from public.profiles where id = auth.uid();
    insert into public.lead_presence(lead_id, client_id, user_id, user_name, seen_at)
    values (p_id, v_client, auth.uid(), v_name, now())
    on conflict (lead_id) do update set user_id = excluded.user_id, user_name = excluded.user_name, seen_at = now();
  else
    delete from public.lead_presence where lead_id = p_id and user_id = auth.uid();
  end if;
end $$;
revoke all on function public.lead_presence_set(uuid, boolean) from public, anon;
grant execute on function public.lead_presence_set(uuid, boolean) to authenticated;
