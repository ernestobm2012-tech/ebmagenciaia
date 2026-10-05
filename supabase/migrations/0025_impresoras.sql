-- Lector de impresoras: un programa en la red del cliente lee por SNMP los contadores
-- y el tóner de cada impresora y los manda a la función `printer-ingest` con una clave
-- propia del cliente. Aquí se guardan las impresoras, sus lecturas y el precio por copia.

alter table public.clients drop constraint clients_services_check;
alter table public.clients add constraint clients_services_check
  check (services <@ array['agentes', 'web', 'software', 'impresoras']::text[] and cardinality(services) > 0);

-- Claves del lector: solo se guarda el hash; la clave en claro se ve una vez al crearla.
create table public.printer_keys (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references public.clients (id) on delete cascade,
  label        text not null default 'Lector',
  key_hash     text not null unique,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);
create index on public.printer_keys (client_id);
alter table public.printer_keys enable row level security;
create policy admin_all on public.printer_keys for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

create table public.printers (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references public.clients (id) on delete cascade,
  serial          text not null,
  name            text,
  model           text,
  brand           text,
  ip              text,
  price_bn_eur    numeric(10, 4) not null default 0 check (price_bn_eur >= 0),
  price_color_eur numeric(10, 4) not null default 0 check (price_color_eur >= 0),
  last_read_at    timestamptz,
  last_total      bigint,
  last_bn         bigint,
  last_color      bigint,
  last_toner      jsonb,
  created_at      timestamptz not null default now(),
  unique (client_id, serial)
);
alter table public.printers enable row level security;
create policy read_own_or_admin on public.printers for select to authenticated
  using ((select private.is_admin()) or client_id = any ((select private.my_client_ids())::uuid[]));
create policy edit_own_or_admin on public.printers for update to authenticated
  using ((select private.is_admin()) or client_id = any ((select private.my_client_ids())::uuid[]))
  with check ((select private.is_admin()) or client_id = any ((select private.my_client_ids())::uuid[]));
create policy delete_admin on public.printers for delete to authenticated
  using ((select private.is_admin()));
-- Desde el panel solo se cambia el nombre y los precios; el resto lo escribe el lector.
revoke insert, update on public.printers from authenticated, anon;
grant update (name, price_bn_eur, price_color_eur) on public.printers to authenticated;

-- Se guarda una lectura cuando cambia algún contador o, si no, cada 6 horas.
create table public.printer_readings (
  id         bigint generated always as identity primary key,
  printer_id uuid not null references public.printers (id) on delete cascade,
  client_id  uuid not null references public.clients (id) on delete cascade,
  read_at    timestamptz not null default now(),
  total      bigint,
  bn         bigint,
  color      bigint,
  toner      jsonb
);
create index on public.printer_readings (printer_id, read_at desc);
create index on public.printer_readings (client_id, read_at desc);
alter table public.printer_readings enable row level security;
create policy read_own_or_admin on public.printer_readings for select to authenticated
  using ((select private.is_admin()) or client_id = any ((select private.my_client_ids())::uuid[]));
revoke insert, update, delete on public.printer_readings from authenticated, anon;

-- Primera y última lectura de cada impresora en cada mes (hora de Madrid), para
-- calcular las copias del mes sin bajar todas las lecturas. Respeta RLS.
create function public.printer_months(p_client_ids uuid[], p_since timestamptz)
returns table (printer_id uuid, month date, first_bn bigint, first_color bigint, first_total bigint,
               last_bn bigint, last_color bigint, last_total bigint)
language sql stable security invoker set search_path = ''
as $$
  with r as (
    select pr.printer_id, (date_trunc('month', pr.read_at at time zone 'Europe/Madrid'))::date as month,
           pr.read_at, pr.bn, pr.color, pr.total
    from public.printer_readings pr
    where pr.client_id = any (p_client_ids) and pr.read_at >= p_since
  )
  select f.printer_id, f.month, f.bn, f.color, f.total, l.bn, l.color, l.total
  from (select distinct on (printer_id, month) * from r order by printer_id, month, read_at) f
  join (select distinct on (printer_id, month) * from r order by printer_id, month, read_at desc) l
    using (printer_id, month);
$$;
revoke execute on function public.printer_months(uuid[], timestamptz) from public, anon;
grant execute on function public.printer_months(uuid[], timestamptz) to authenticated;

-- Crea una clave para el lector de un cliente y la devuelve en claro una sola vez.
create function public.create_printer_key(p_client_id uuid, p_label text default 'Lector')
returns text
language plpgsql security definer set search_path = ''
as $$
declare token text;
begin
  if not private.is_admin() then raise exception 'Solo administración'; end if;
  token := 'lec_' || encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.printer_keys (client_id, label, key_hash)
  values (p_client_id, coalesce(nullif(trim(p_label), ''), 'Lector'),
          encode(extensions.digest(token, 'sha256'), 'hex'));
  return token;
end;
$$;
revoke execute on function public.create_printer_key(uuid, text) from public, anon;
grant execute on function public.create_printer_key(uuid, text) to authenticated;

-- Servicios de los clientes del usuario (para enseñar o no el menú «Impresoras»).
create function public.my_client_services()
returns table (id uuid, services text[])
language sql stable security definer set search_path = ''
as $$
  select c.id, c.services from public.clients c
  where c.id = any (private.my_client_ids());
$$;
revoke execute on function public.my_client_services() from public, anon;
grant execute on function public.my_client_services() to authenticated;
