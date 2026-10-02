-- Registro de demos de voz de la web, para limitarlas por persona y por día.
-- Solo guarda una huella (HMAC) de la conexión, no la dirección IP.
create table public.demo_calls (
  id          uuid primary key default gen_random_uuid(),
  day         date not null,
  ip_hash     text not null,
  agent_id    text not null,
  created_at  timestamptz not null default now()
);
create index on public.demo_calls (day, ip_hash);
alter table public.demo_calls enable row level security;
revoke all on public.demo_calls from anon, authenticated;

select cron.schedule('demo-calls-cleanup', '23 4 * * *',
  $$delete from public.demo_calls where created_at < now() - interval '3 days'$$);
