-- Avisos y errores de las impresoras (tabla prtAlertTable del Printer MIB) con fecha y hora.
-- El lector manda los avisos activos; printer-ingest abre un evento cuando aparece uno nuevo
-- y lo cierra (ended_at) cuando la impresora deja de mostrarlo.
alter table public.printers
  add column last_status smallint,
  add column last_alerts jsonb;

create table public.printer_events (
  id          bigint generated always as identity primary key,
  printer_id  uuid not null references public.printers (id) on delete cascade,
  client_id   uuid not null references public.clients (id) on delete cascade,
  code        integer not null,
  severity    smallint,
  description text,
  started_at  timestamptz not null default now(),
  ended_at    timestamptz
);
create index on public.printer_events (client_id, started_at desc);
create index on public.printer_events (printer_id) where ended_at is null;
alter table public.printer_events enable row level security;
create policy read_own_or_admin on public.printer_events for select to authenticated
  using ((select private.is_admin()) or client_id = any ((select private.my_client_ids())::uuid[]));
revoke insert, update, delete on public.printer_events from authenticated, anon;
