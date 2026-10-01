-- Llamadas del agente telefónico (ElevenLabs). Se importan con la función
-- sync-voice: conversación, transcripción, coste y contacto recogido.
alter table public.conversations drop constraint conversations_channel_check;
alter table public.conversations add constraint conversations_channel_check
  check (channel in ('web', 'whatsapp', 'instagram', 'email', 'phone'));

alter table public.conversations
  add column external_id   text unique,   -- id de la llamada en ElevenLabs
  add column duration_secs integer,
  add column summary       text;

-- Id del agente en ElevenLabs: enlaza sus llamadas con este agente y su cliente.
alter table public.agents add column voice_agent_id text unique;

-- Última ejecución de cada sincronización, para no repetirla demasiado seguido.
create table public.sync_state (
  name      text primary key,
  last_run  timestamptz not null default now()
);
alter table public.sync_state enable row level security;
revoke all on public.sync_state from anon, authenticated;

-- Cada 5 minutos se piden las llamadas nuevas.
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.schedule('sync-voice', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://rhjbpkaesobsbnkvioyh.supabase.co/functions/v1/sync-voice',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
$$);
