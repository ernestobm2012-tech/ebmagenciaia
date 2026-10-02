-- Avisos en el móvil (notificaciones push de la app instalable del panel).
-- Las claves VAPID las genera la función `push` la primera vez y solo ella
-- (service_role) puede leerlas.
create table public.push_config (
  id           int primary key default 1 check (id = 1),
  public_key   text not null,
  private_key  text not null,
  created_at   timestamptz not null default now()
);
alter table public.push_config enable row level security;
revoke all on public.push_config from anon, authenticated;

create table public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now()
);
create index on public.push_subscriptions (user_id);
alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon, authenticated;
grant select, delete on public.push_subscriptions to authenticated;
create policy own_subscriptions on public.push_subscriptions for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Evita avisar dos veces del mismo hecho (y limita los avisos de error repetidos).
create table public.push_log (
  key      text primary key,
  sent_at  timestamptz not null default now()
);
alter table public.push_log enable row level security;
revoke all on public.push_log from anon, authenticated;

create function private.push_event() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform net.http_post(
    url := 'https://rhjbpkaesobsbnkvioyh.supabase.co/functions/v1/push?action=send',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := jsonb_build_object('kind', tg_argv[0], 'id', new.id)
  );
  return new;
end;
$$;

create trigger push_lead    after insert on public.leads
  for each row execute function private.push_event('lead');
create trigger push_handoff after insert on public.handoffs
  for each row execute function private.push_event('handoff');
create trigger push_contact after insert on public.contact_messages
  for each row execute function private.push_event('contact');
create trigger push_error   after insert on public.error_log
  for each row execute function private.push_event('error');

-- Limpieza diaria del registro de avisos.
select cron.schedule('push-log-cleanup', '17 4 * * *',
  $$delete from public.push_log where sent_at < now() - interval '2 days'$$);
