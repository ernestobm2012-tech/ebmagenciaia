-- Contadores en bruto (OID -> valor) de las marcas que aún no están mapeadas, para ajustar el
-- lector a distancia. El lector los manda como mucho una vez cada 6 horas por impresora.
create table public.printer_raw (
  id         bigint generated always as identity primary key,
  printer_id uuid not null references public.printers (id) on delete cascade,
  client_id  uuid not null references public.clients (id) on delete cascade,
  read_at    timestamptz not null default now(),
  data       jsonb not null
);
create index on public.printer_raw (printer_id, read_at desc);
alter table public.printer_raw enable row level security;
create policy admin_read on public.printer_raw for select to authenticated using ((select private.is_admin()));
revoke insert, update, delete on public.printer_raw from authenticated, anon;
comment on table public.printer_raw is 'Tabla de contadores en bruto (OID -> valor) de marcas sin mapear, para ajustar el lector a distancia. Solo administración.';
