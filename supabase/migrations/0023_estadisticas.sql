-- Estadísticas del panel: visitas a la web pública y usos de cada demo, por día.
-- Las visitas se cuentan sin cookies y sin guardar la IP: solo una huella que cambia
-- cada día y no se puede deshacer (la calcula la función track).

create table if not exists public.web_visits (
  id bigint generated always as identity primary key,
  day date not null,
  path text not null,
  visitor text not null,
  referrer text,
  device text,
  created_at timestamptz not null default now()
);
create index if not exists web_visits_day_idx on public.web_visits (day);
create index if not exists web_visits_day_visitor_idx on public.web_visits (day, visitor);
alter table public.web_visits enable row level security;
revoke all on public.web_visits from anon, authenticated;
comment on table public.web_visits is 'Visitas a la web pública (función track). Sin cookies ni IP. Se borran a los 180 días.';

-- Usos de las demos por día: se mantiene a mano al empezar cada demo (función demo-token),
-- porque demo_calls se borra a los 3 días.
create table if not exists public.demo_usage_daily (
  day date not null,
  agent_id text not null,
  kind text not null check (kind in ('voice', 'text')),
  starts integer not null default 0,
  people integer not null default 0,
  primary key (day, agent_id, kind)
);
alter table public.demo_usage_daily enable row level security;
revoke all on public.demo_usage_daily from anon, authenticated;

insert into public.demo_usage_daily (day, agent_id, kind, starts, people)
select day, agent_id, kind, count(*), count(distinct ip_hash) from public.demo_calls group by 1, 2, 3
on conflict do nothing;

create or replace function public.demo_usage_bump(p_day date, p_agent text, p_kind text, p_new_person boolean)
returns void language sql security definer set search_path = public as $$
  insert into public.demo_usage_daily (day, agent_id, kind, starts, people)
  values (p_day, p_agent, p_kind, 1, case when p_new_person then 1 else 0 end)
  on conflict (day, agent_id, kind) do update
    set starts = demo_usage_daily.starts + 1,
        people = demo_usage_daily.people + case when p_new_person then 1 else 0 end;
$$;
revoke all on function public.demo_usage_bump(date, text, text, boolean) from public, anon, authenticated;
grant execute on function public.demo_usage_bump(date, text, text, boolean) to service_role;

-- Lo que lee el panel (solo administración).
create or replace function public.admin_web_stats(p_days integer default 30)
returns jsonb language plpgsql security definer set search_path = public, private as $$
declare
  v_from date := (now() at time zone 'Europe/Madrid')::date - (greatest(1, least(p_days, 365)) - 1);
begin
  if not (select private.is_admin()) then
    raise exception 'Solo administración' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'daily', coalesce((select jsonb_agg(d order by d.day) from (
      select day, count(*) as visits, count(distinct visitor) as people
      from web_visits where day >= v_from group by day) d), '[]'::jsonb),
    'pages', coalesce((select jsonb_agg(p) from (
      select path, count(*) as visits, count(distinct visitor) as people
      from web_visits where day >= v_from group by path order by count(*) desc limit 10) p), '[]'::jsonb),
    'referrers', coalesce((select jsonb_agg(r) from (
      select coalesce(referrer, '(directo)') as ref, count(*) as visits
      from web_visits where day >= v_from group by 1 order by 2 desc limit 10) r), '[]'::jsonb),
    'devices', coalesce((select jsonb_agg(v) from (
      select coalesce(device, '?') as device, count(*) as visits
      from web_visits where day >= v_from group by 1 order by 2 desc) v), '[]'::jsonb)
  );
end $$;

create or replace function public.admin_demo_stats(p_days integer default 30)
returns jsonb language plpgsql security definer set search_path = public, private as $$
declare
  v_from date := (now() at time zone 'Europe/Madrid')::date - (greatest(1, least(p_days, 365)) - 1);
begin
  if not (select private.is_admin()) then
    raise exception 'Solo administración' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(u order by u.day) from (
    select day, agent_id, kind, starts, people from demo_usage_daily where day >= v_from) u), '[]'::jsonb);
end $$;

revoke all on function public.admin_web_stats(integer), public.admin_demo_stats(integer) from public, anon;
grant execute on function public.admin_web_stats(integer), public.admin_demo_stats(integer) to authenticated;

-- Las visitas se conservan 180 días.
select cron.schedule('web-visits-purge', '15 4 * * 0',
  $$delete from public.web_visits where day < current_date - 180$$);
