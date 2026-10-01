-- Lo que el agente sabe de cada cliente, además del texto escrito a mano:
-- páginas de su web, tablas (Excel/CSV) y textos sueltos.
create table public.knowledge_sources (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.clients (id) on delete cascade,
  kind        text not null check (kind in ('web', 'table', 'text')),
  title       text not null,
  url         text,
  content     text not null default '',
  pages       integer,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Consultas de solo lectura a sistemas del cliente (ERP, tienda, reservas).
-- La credencial nunca se guarda aquí: secret_name apunta a un secreto de las
-- Edge Functions cuyo nombre empieza por ERP_.
create table public.api_connections (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.clients (id) on delete cascade,
  name          text not null,
  tool_name     text not null check (tool_name ~ '^[a-z0-9_]{3,50}$'),
  description   text not null,
  url_template  text not null check (url_template like 'https://%'),
  params        jsonb not null default '[]',
  auth_header   text,
  auth_prefix   text not null default '',
  secret_name   text check (secret_name is null or secret_name ~ '^ERP_[A-Z0-9_]+$'),
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (client_id, tool_name)
);

-- Registro de cada consulta que hace el agente a un sistema externo.
create table public.api_calls (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid not null references public.clients (id) on delete cascade,
  connection_id    uuid references public.api_connections (id) on delete set null,
  conversation_id  uuid references public.conversations (id) on delete set null,
  params           jsonb,
  status           integer,
  created_at       timestamptz not null default now()
);

create index on public.knowledge_sources (client_id);
create index on public.api_connections (client_id);
create index on public.api_calls (client_id, created_at desc);
create index on public.api_calls (connection_id);
create index on public.api_calls (conversation_id);

create trigger knowledge_sources_touch_updated_at
  before update on public.knowledge_sources
  for each row execute function private.touch_updated_at();

alter table public.knowledge_sources enable row level security;
alter table public.api_connections   enable row level security;
alter table public.api_calls         enable row level security;

revoke all on public.knowledge_sources, public.api_connections, public.api_calls from anon;
grant select, insert, update, delete on public.knowledge_sources, public.api_connections, public.api_calls to authenticated;

create policy admin_all on public.knowledge_sources for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy admin_all on public.api_connections for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy admin_all on public.api_calls for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
