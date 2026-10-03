-- Agente en Instagram (mensajes directos), con «Instagram API con inicio de sesión
-- de Instagram»: el cliente conecta su cuenta profesional desde el panel y el agente
-- responde a sus mensajes con el mismo cerebro que el chat de la web.

-- Cuentas conectadas. El panel las ve (sin tokens) y solo la función las cambia.
create table public.social_accounts (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.clients (id) on delete cascade,
  platform      text not null check (platform in ('instagram')),
  external_id   text not null,
  username      text,
  auto_reply    boolean not null default true,
  last_error    text,
  connected_at  timestamptz not null default now(),
  unique (platform, external_id)
);
create index on public.social_accounts (client_id);
alter table public.social_accounts enable row level security;
revoke all on public.social_accounts from anon, authenticated;
grant select on public.social_accounts to authenticated;
create policy members_read on public.social_accounts for select to authenticated
  using ((select private.is_admin()) or client_id = any ((select private.my_client_ids())::uuid[]));

-- Credenciales: nadie las lee desde el panel.
create table public.social_tokens (
  account_id   uuid primary key references public.social_accounts (id) on delete cascade,
  access_token text not null,
  expires_at   timestamptz not null,
  refreshed_at timestamptz not null default now()
);
alter table public.social_tokens enable row level security;
revoke all on public.social_tokens from anon, authenticated;

create table public.social_oauth_states (
  state       text primary key,
  client_id   uuid not null references public.clients (id) on delete cascade,
  user_id     uuid not null,
  return_url  text not null,
  created_at  timestamptz not null default now()
);
alter table public.social_oauth_states enable row level security;
revoke all on public.social_oauth_states from anon, authenticated;

-- Mensajes ya procesados (Meta puede repetir un aviso) y los que envía el propio agente.
create table public.social_events (
  mid         text primary key,
  created_at  timestamptz not null default now()
);
alter table public.social_events enable row level security;
revoke all on public.social_events from anon, authenticated;

select cron.schedule('social-events-cleanup', '29 4 * * *',
  $$delete from public.social_events where created_at < now() - interval '7 days'$$);

-- Cada día se renuevan las credenciales que caducan pronto (duran 60 días).
select cron.schedule('instagram-maintain', '10 5 * * *', $$
  select net.http_post(
    url := 'https://rhjbpkaesobsbnkvioyh.supabase.co/functions/v1/instagram?action=maintain',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
$$);
