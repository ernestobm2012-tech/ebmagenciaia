-- Más que una agenda (primero, Henko Peluquería): cupones de descuento, correos a las
-- clientas (confirmación, recordatorio, reseña, «hace tiempo que no vienes» y
-- cumpleaños), lista de espera cuando no hay hueco, ficha técnica de cada clienta
-- (fórmulas de color, notas y fotos de antes y después) y marca de «no vino».
-- Los correos los manda la función citas-mensajes (Resend) y quedan en message_log,
-- que también evita repetirlos.

-- ---- Clientas: cumpleaños, permiso para ofertas y enlace de baja
alter table public.customers
  add column birthday date,
  add column marketing_ok boolean not null default false,
  add column marketing_ok_at timestamptz,
  add column unsub_token text not null default encode(extensions.gen_random_bytes(18), 'hex');
create unique index customers_unsub_token on public.customers (unsub_token);

-- ---- Cupones
create table public.coupons (
  id                 uuid primary key default gen_random_uuid(),
  client_id          uuid not null references public.clients (id) on delete cascade,
  code               text not null check (code ~ '^[A-Z0-9-]{3,20}$'),
  title              text,                       -- «Otoño en Henko», se ve en la web si show_on_web
  kind               text not null default 'percent' check (kind in ('percent', 'fixed')),
  value              numeric(8,2) not null check (value > 0),
  service_ids        uuid[] not null default '{}',   -- vacío = todos los servicios
  valid_from         date,
  valid_until        date,
  max_uses           integer check (max_uses is null or max_uses > 0),
  once_per_customer  boolean not null default true,
  new_customers_only boolean not null default false,
  show_on_web        boolean not null default false,
  active             boolean not null default true,
  created_at         timestamptz not null default now(),
  unique (client_id, code),
  check (kind <> 'percent' or value <= 100)
);

alter table public.calendar_events
  add column coupon_id uuid references public.coupons (id) on delete set null,
  add column discount_eur numeric(8,2),
  add column no_show boolean not null default false;
create index calendar_events_coupon on public.calendar_events (coupon_id) where coupon_id is not null;
create index calendar_events_customer on public.calendar_events (customer_id) where customer_id is not null;

-- ---- Lista de espera: alguien quería un día sin huecos; si se anula una cita ese día,
-- se le avisa por correo (y el salón la ve en el panel para escribirle).
create table public.waitlist (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.clients (id) on delete cascade,
  service_id  uuid references public.services (id) on delete set null,
  member_id   uuid references public.team_members (id) on delete set null,
  day         date not null,
  name        text not null,
  phone       text not null,
  email       text,
  notified_at timestamptz,
  created_at  timestamptz not null default now()
);
create index waitlist_day on public.waitlist (client_id, day);

-- ---- Ficha técnica: fórmulas, notas y fotos de cada clienta (almacén privado).
create table public.customer_records (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.clients (id) on delete cascade,
  customer_id uuid not null references public.customers (id) on delete cascade,
  member_id   uuid references public.team_members (id) on delete set null,
  kind        text not null default 'nota' check (kind in ('color', 'nota', 'foto')),
  body        text,
  photo_path  text,
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now()
);
create index customer_records_customer on public.customer_records (customer_id, created_at desc);

-- ---- Correos enviados (para no repetir y para las estadísticas)
create table public.message_log (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.clients (id) on delete cascade,
  customer_id uuid references public.customers (id) on delete set null,
  event_id    uuid,
  kind        text not null check (kind in ('confirm', 'reminder', 'review', 'comeback', 'birthday', 'waitlist')),
  to_email    text,
  ok          boolean not null default true,
  error       text,
  created_at  timestamptz not null default now()
);
create index message_log_lookup on public.message_log (client_id, kind, created_at desc);
create unique index message_log_event_once on public.message_log (event_id, kind) where event_id is not null and ok;

do $$
declare t text;
begin
  foreach t in array array['coupons', 'waitlist', 'customer_records', 'message_log']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format(
      'create policy own_or_admin on public.%I for all to authenticated
         using ((select private.is_admin()) or client_id = any ((select private.my_client_ids())::uuid[]))
         with check ((select private.is_admin()) or client_id = any ((select private.my_client_ids())::uuid[]))', t);
  end loop;
end $$;

-- La empleada con agenda propia: lee los cupones (para aplicarlos en una cita) pero no
-- los toca; no ve los correos enviados; la ficha técnica, solo de sus clientas.
create policy staff_no_insert on public.coupons as restrictive for insert to authenticated
  with check (not (select private.is_staff_only()));
create policy staff_no_update on public.coupons as restrictive for update to authenticated
  using (not (select private.is_staff_only()));
create policy staff_no_delete on public.coupons as restrictive for delete to authenticated
  using (not (select private.is_staff_only()));
create policy staff_no_read on public.message_log as restrictive for select to authenticated
  using (not (select private.is_staff_only()));
create policy staff_own_records on public.customer_records as restrictive for all to authenticated
  using (not (select private.is_staff_only()) or exists (
    select 1 from public.customers c where c.id = customer_id
      and (select private.staff_sees_customer(c.id, c.preferred_member_id))))
  with check (not (select private.is_staff_only()) or exists (
    select 1 from public.customers c where c.id = customer_id
      and (select private.staff_sees_customer(c.id, c.preferred_member_id))));

-- Fotos de la ficha técnica: almacén privado <client_id>/<customer_id>/<archivo>.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('customer-photos', 'customer-photos', false, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy customer_photos_all on storage.objects for all to authenticated
  using (bucket_id = 'customer-photos' and ((select private.is_admin())
    or (storage.foldername(name))[1] = any (select unnest((select private.my_client_ids()))::text)))
  with check (bucket_id = 'customer-photos' and ((select private.is_admin())
    or (storage.foldername(name))[1] = any (select unnest((select private.my_client_ids()))::text)));

-- book_service con cupón: igual que antes, pero guarda el cupón y el descuento.
create or replace function public.book_service_coupon(
  p_calendar uuid, p_start timestamptz, p_end timestamptz, p_title text, p_description text,
  p_service uuid, p_customer uuid, p_price numeric, p_type uuid, p_coupon uuid, p_discount numeric
) returns table (id uuid, manage_token text)
language plpgsql security definer set search_path = ''
as $$
declare r record;
begin
  select * into r from public.book_service(p_calendar, p_start, p_end, p_title, p_description,
                                           p_service, p_customer, p_price, p_type) limit 1;
  if r.id is null then return; end if;
  if p_coupon is not null then
    update public.calendar_events set coupon_id = p_coupon, discount_eur = p_discount where calendar_events.id = r.id;
  end if;
  id := r.id; manage_token := r.manage_token;
  return next;
end;
$$;
revoke all on function public.book_service_coupon from public, anon, authenticated;
grant execute on function public.book_service_coupon to service_role;

-- Cada hora: recordatorios, reseñas, «te echamos de menos» y cumpleaños.
select cron.schedule('citas-mensajes', '7 * * * *', $$
  select net.http_post(
    url := 'https://rhjbpkaesobsbnkvioyh.supabase.co/functions/v1/citas-mensajes?action=cron',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
$$);
select cron.schedule('waitlist-cleanup', '41 4 * * *',
  $$delete from public.waitlist where day < current_date - 7$$);
