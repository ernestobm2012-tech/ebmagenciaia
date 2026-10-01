-- Mensajes del formulario de la web pública.
-- Cualquiera puede enviar uno (solo insertar, y solo estos campos); solo el admin los lee.
create table public.contact_messages (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 2 and 120),
  email       text not null check (char_length(email) <= 200 and email like '%_@_%._%'),
  phone       text check (char_length(phone) <= 40),
  service     text check (service in ('web', 'web-gestion', 'software', 'agentes', 'otro')),
  message     text not null check (char_length(message) between 10 and 4000),
  status      text not null default 'new' check (status in ('new', 'contacted', 'closed')),
  created_at  timestamptz not null default now()
);

create index on public.contact_messages (created_at desc);

alter table public.contact_messages enable row level security;

revoke all on public.contact_messages from anon, authenticated;
grant insert (name, email, phone, service, message) on public.contact_messages to anon, authenticated;
grant select, update, delete on public.contact_messages to authenticated;

create policy anyone_insert on public.contact_messages for insert to anon, authenticated
  with check (true);
create policy admin_select on public.contact_messages for select to authenticated
  using ((select private.is_admin()));
create policy admin_update on public.contact_messages for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy admin_delete on public.contact_messages for delete to authenticated
  using ((select private.is_admin()));
