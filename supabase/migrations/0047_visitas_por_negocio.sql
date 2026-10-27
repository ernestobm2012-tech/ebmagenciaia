-- Visitas a la web pública de cada negocio con web propia (primero Henko). Mismo contador
-- sin cookies que el de la web de EBM (función track): ahora cada visita puede llevar el
-- negocio al que pertenece; client_id nulo = la web de EBM de siempre.
alter table public.web_visits add column client_id uuid references public.clients (id) on delete cascade;
create index web_visits_client_day on public.web_visits (client_id, day);

-- Las estadísticas de la web de EBM no deben mezclar las visitas de los clientes.
create or replace function public.admin_web_stats(p_days integer default 30)
returns jsonb language plpgsql security definer set search_path to 'public', 'private' as $$
declare
  v_from date := (now() at time zone 'Europe/Madrid')::date - (greatest(1, least(p_days, 365)) - 1);
begin
  if not (select private.is_admin()) then
    raise exception 'Solo administración' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'daily', coalesce((select jsonb_agg(d order by d.day) from (
      select day, count(*) as visits, count(distinct visitor) as people
      from web_visits where day >= v_from and client_id is null group by day) d), '[]'::jsonb),
    'pages', coalesce((select jsonb_agg(p) from (
      select path, count(*) as visits, count(distinct visitor) as people
      from web_visits where day >= v_from and client_id is null group by path order by count(*) desc limit 10) p), '[]'::jsonb),
    'referrers', coalesce((select jsonb_agg(r) from (
      select coalesce(referrer, '(directo)') as ref, count(*) as visits
      from web_visits where day >= v_from and client_id is null group by 1 order by 2 desc limit 10) r), '[]'::jsonb),
    'devices', coalesce((select jsonb_agg(v) from (
      select coalesce(device, '?') as device, count(*) as visits
      from web_visits where day >= v_from and client_id is null group by 1 order by 2 desc) v), '[]'::jsonb)
  );
end $$;

-- Visitas de la web de un negocio entre dos días (Madrid). Lo ve administración o el
-- dueño del negocio; la empleada con agenda propia no.
create or replace function public.client_web_stats(p_client uuid, p_from date, p_to date)
returns jsonb language plpgsql security definer set search_path to 'public', 'private' as $$
begin
  if not ((select private.is_admin())
          or (p_client = any ((select private.my_client_ids())::uuid[]) and not (select private.is_staff_only()))) then
    raise exception 'Sin permiso' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'visits', (select count(*) from web_visits where client_id = p_client and day between p_from and p_to),
    'people', (select count(distinct visitor) from web_visits where client_id = p_client and day between p_from and p_to),
    'daily', coalesce((select jsonb_agg(d order by d.day) from (
      select day, count(*) as visits, count(distinct visitor) as people
      from web_visits where client_id = p_client and day between p_from and p_to group by day) d), '[]'::jsonb),
    'pages', coalesce((select jsonb_agg(p) from (
      select path, count(*) as visits from web_visits
      where client_id = p_client and day between p_from and p_to group by path order by count(*) desc limit 8) p), '[]'::jsonb),
    'referrers', coalesce((select jsonb_agg(r) from (
      select coalesce(referrer, '(directo)') as ref, count(*) as visits from web_visits
      where client_id = p_client and day between p_from and p_to group by 1 order by 2 desc limit 8) r), '[]'::jsonb),
    'devices', coalesce((select jsonb_agg(v) from (
      select coalesce(device, '?') as device, count(*) as visits from web_visits
      where client_id = p_client and day between p_from and p_to group by 1 order by 2 desc) v), '[]'::jsonb)
  );
end $$;
revoke all on function public.client_web_stats(uuid, date, date) from public, anon;
grant execute on function public.client_web_stats(uuid, date, date) to authenticated;
