-- EBM · Plataforma de agentes de IA
-- Esquema multicliente: todas las tablas llevan client_id y RLS.
--   admin   -> ve y edita todo
--   client  -> solo lee lo de su client_id (nunca prompts, costes ni márgenes)

create schema if not exists private;

-- ---------------------------------------------------------------- clientes
create table public.clients (
  id                      uuid primary key default gen_random_uuid(),
  name                    text not null,
  slug                    text not null unique,
  status                  text not null default 'demo'
                          check (status in ('demo', 'active', 'paused')),
  plan                    text,
  monthly_fee_eur         numeric(10,2) not null default 0,
  included_conversations  integer not null default 0,
  ai_budget_usd           numeric(10,2) not null default 20,  -- tope mensual de IA
  website_url             text,
  contact_name            text,
  contact_email           text,
  notes                   text,
  created_at              timestamptz not null default now()
);

-- ---------------------------------------------------------------- usuarios
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text,
  full_name   text,
  role        text not null default 'client' check (role in ('admin', 'client')),
  client_id   uuid references public.clients (id) on delete set null,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------- agentes
create table public.agents (
  id                             uuid primary key default gen_random_uuid(),
  client_id                      uuid not null references public.clients (id) on delete cascade,
  name                           text not null,
  role                           text not null default 'general',  -- general / ventas / soporte / citas / enrutador
  model                          text not null default 'claude-haiku-4-5-20251001',
  system_prompt                  text not null default '',
  knowledge                      text not null default '',         -- datos del negocio (web pequeña)
  welcome_message                text not null default '¡Hola! ¿En qué puedo ayudarte?',
  fallback_message               text not null default 'Ahora mismo no puedo responderte. Un compañero te escribirá en breve.',
  max_output_tokens              integer not null default 500,
  max_history_messages           integer not null default 20,
  max_messages_per_conversation  integer not null default 40,
  max_messages_per_user_day      integer not null default 80,
  active                         boolean not null default true,
  created_at                     timestamptz not null default now(),
  updated_at                     timestamptz not null default now()
);

-- Personas a las que el agente puede avisar. Nunca inventa correos: solo elige de aquí.
create table public.notify_contacts (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references public.clients (id) on delete cascade,
  name         text not null,
  department   text,
  email        text not null,
  notify_when  text,
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------- actividad
create table public.conversations (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid not null references public.clients (id) on delete cascade,
  agent_id         uuid references public.agents (id) on delete set null,
  channel          text not null default 'web'
                   check (channel in ('web', 'whatsapp', 'instagram', 'email')),
  visitor_id       text,
  topic            text,
  status           text not null default 'open' check (status in ('open', 'closed')),
  handed_off       boolean not null default false,
  message_count    integer not null default 0,
  started_at       timestamptz not null default now(),
  last_message_at  timestamptz not null default now()
);

create table public.messages (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid not null references public.clients (id) on delete cascade,
  conversation_id  uuid not null references public.conversations (id) on delete cascade,
  role             text not null check (role in ('user', 'assistant', 'system')),
  content          text not null,
  created_at       timestamptz not null default now()
);

create table public.leads (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid not null references public.clients (id) on delete cascade,
  conversation_id  uuid references public.conversations (id) on delete set null,
  name             text,
  contact          text,
  reason           text,
  status           text not null default 'new' check (status in ('new', 'pending', 'contacted', 'closed')),
  created_at       timestamptz not null default now()
);

create table public.handoffs (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid not null references public.clients (id) on delete cascade,
  conversation_id  uuid references public.conversations (id) on delete set null,
  reason           text,
  created_at       timestamptz not null default now()
);

create table public.appointments (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid not null references public.clients (id) on delete cascade,
  conversation_id  uuid references public.conversations (id) on delete set null,
  name             text,
  contact          text,
  scheduled_at     timestamptz,
  notes            text,
  created_at       timestamptz not null default now()
);

-- Avisos enviados por el agente a las personas de notify_contacts.
create table public.notifications (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid not null references public.clients (id) on delete cascade,
  conversation_id  uuid references public.conversations (id) on delete set null,
  contact_id       uuid references public.notify_contacts (id) on delete set null,
  subject          text,
  body             text,
  status           text not null default 'sent' check (status in ('sent', 'failed')),
  created_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------- solo admin
-- Tokens y coste de cada llamada a la IA.
create table public.usage_events (
  id                  uuid primary key default gen_random_uuid(),
  client_id           uuid not null references public.clients (id) on delete cascade,
  conversation_id     uuid references public.conversations (id) on delete set null,
  message_id          uuid references public.messages (id) on delete set null,
  model               text not null,
  input_tokens        integer not null default 0,
  output_tokens       integer not null default 0,
  cache_read_tokens   integer not null default 0,
  cache_write_tokens  integer not null default 0,
  cost_usd            numeric(12,6) not null default 0,
  created_at          timestamptz not null default now()
);

create table public.error_log (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid references public.clients (id) on delete cascade,
  conversation_id  uuid references public.conversations (id) on delete set null,
  source           text,
  message          text,
  created_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------- índices
create index on public.profiles (client_id);
create index on public.agents (client_id);
create index on public.notify_contacts (client_id);
create index on public.conversations (client_id, started_at desc);
create index on public.conversations (agent_id);
create index on public.messages (conversation_id, created_at);
create index on public.messages (client_id);
create index on public.leads (client_id, created_at desc);
create index on public.leads (conversation_id);
create index on public.handoffs (client_id, created_at desc);
create index on public.handoffs (conversation_id);
create index on public.appointments (client_id, created_at desc);
create index on public.appointments (conversation_id);
create index on public.notifications (client_id, created_at desc);
create index on public.notifications (conversation_id);
create index on public.notifications (contact_id);
create index on public.usage_events (client_id, created_at desc);
create index on public.usage_events (conversation_id);
create index on public.usage_events (message_id);
create index on public.error_log (client_id, created_at desc);
create index on public.error_log (conversation_id);

-- ---------------------------------------------------------------- funciones
-- En el esquema private (no expuesto por la API) para que RLS pueda consultar
-- profiles sin recursión.
create function private.is_admin() returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = (select auth.uid()) and role = 'admin'
  );
$$;

create function private.my_client_id() returns uuid
language sql stable security definer set search_path = ''
as $$
  select client_id from public.profiles where id = (select auth.uid());
$$;

-- Cada usuario nuevo entra como 'client' sin cliente asignado: no ve nada
-- hasta que el admin le asigna uno.
create function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data ->> 'full_name');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

create function private.touch_updated_at() returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger agents_touch_updated_at
  before update on public.agents
  for each row execute function private.touch_updated_at();

grant usage on schema private to authenticated;
grant execute on function private.is_admin(), private.my_client_id() to authenticated;

-- ---------------------------------------------------------------- RLS
alter table public.clients          enable row level security;
alter table public.profiles         enable row level security;
alter table public.agents           enable row level security;
alter table public.notify_contacts  enable row level security;
alter table public.conversations    enable row level security;
alter table public.messages         enable row level security;
alter table public.leads            enable row level security;
alter table public.handoffs         enable row level security;
alter table public.appointments     enable row level security;
alter table public.notifications    enable row level security;
alter table public.usage_events     enable row level security;
alter table public.error_log        enable row level security;

revoke all on all tables in schema public from anon;
grant select, insert, update, delete on
  public.clients, public.profiles, public.agents, public.notify_contacts,
  public.conversations, public.messages, public.leads, public.handoffs,
  public.appointments, public.notifications, public.usage_events, public.error_log
  to authenticated;

-- Solo admin: clientes (cuota, tope), agentes (prompt), costes y errores.
create policy admin_all on public.clients      for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy admin_all on public.agents       for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy admin_all on public.usage_events for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy admin_all on public.error_log    for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

-- Perfiles: cada uno lee el suyo; solo el admin los modifica (nadie se sube el rol).
create policy read_own_or_admin on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select private.is_admin()));
create policy admin_update on public.profiles for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy admin_delete on public.profiles for delete to authenticated
  using ((select private.is_admin()));

-- Datos de actividad: el admin todo; el cliente solo lee lo suyo.
do $$
declare t text;
begin
  foreach t in array array['notify_contacts', 'conversations', 'messages', 'leads',
                           'handoffs', 'appointments', 'notifications']
  loop
    execute format(
      'create policy read_own_or_admin on public.%I for select to authenticated
         using ((select private.is_admin()) or client_id = (select private.my_client_id()))', t);
    execute format(
      'create policy admin_insert on public.%I for insert to authenticated
         with check ((select private.is_admin()))', t);
    execute format(
      'create policy admin_update on public.%I for update to authenticated
         using ((select private.is_admin())) with check ((select private.is_admin()))', t);
    execute format(
      'create policy admin_delete on public.%I for delete to authenticated
         using ((select private.is_admin()))', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- vistas y RPC
-- Gasto de IA por cliente y mes (solo admin: hereda el RLS de usage_events).
create view public.usage_monthly with (security_invoker = true) as
select
  client_id,
  date_trunc('month', created_at)::date as month,
  count(*)                              as calls,
  sum(input_tokens)                     as input_tokens,
  sum(output_tokens)                    as output_tokens,
  sum(cache_read_tokens)                as cache_read_tokens,
  sum(cache_write_tokens)               as cache_write_tokens,
  sum(cost_usd)                         as cost_usd
from public.usage_events
group by client_id, date_trunc('month', created_at);

-- Conversaciones por cliente y mes (el cliente solo ve las suyas, por RLS).
create view public.conversations_monthly with (security_invoker = true) as
select
  client_id,
  date_trunc('month', started_at)::date as month,
  count(*)                              as conversations,
  count(*) filter (where handed_off)    as handed_off,
  sum(message_count)                    as messages
from public.conversations
group by client_id, date_trunc('month', started_at);

revoke all on public.usage_monthly, public.conversations_monthly from anon;
grant select on public.usage_monthly, public.conversations_monthly to authenticated;

-- Lo único que el rol cliente necesita saber de su ficha (sin cuota ni tope).
create function public.my_client()
returns table (id uuid, name text, status text)
language sql stable security definer set search_path = ''
as $$
  select c.id, c.name, c.status
  from public.clients c
  where c.id = (select client_id from public.profiles where id = (select auth.uid()));
$$;

revoke execute on function public.my_client() from public, anon;
grant execute on function public.my_client() to authenticated;
