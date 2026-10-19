-- Tipos de cita de cada negocio (Cliente nuevo, Segunda llamada, Técnico / RMA…), cada
-- uno con su color: la agenda pinta cada cita del color de su tipo. Los tipos por
-- defecto los crea el panel la primera vez que un negocio abre sus calendarios.
-- is_default: el tipo con el que se pintan las citas que reserva el agente.
create table public.appointment_types (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references public.clients (id) on delete cascade,
  name       text not null,
  color      text not null default '#1483DC',
  sort       int not null default 0,
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);
create index appointment_types_client_idx on public.appointment_types (client_id, sort);

alter table public.appointment_types enable row level security;
create policy own_or_admin on public.appointment_types for all to authenticated
  using ((select private.is_admin()) or client_id = any ((select private.my_client_ids())::uuid[]))
  with check ((select private.is_admin()) or client_id = any ((select private.my_client_ids())::uuid[]));
grant select, insert, update, delete on public.appointment_types to authenticated;

alter table public.calendar_events
  add column type_id uuid references public.appointment_types (id) on delete set null;
