-- Webs de negocios con reservas (la primera, Henko Peluquería): servicios con precio y
-- duración, el equipo que sale en la web, los clientes del negocio y las fotos y vídeos
-- de la web. Cada persona del equipo reserva en su propio calendario (calendars.member_id)
-- con su horario en booking_hours, así que las citas salen también en la agenda del panel
-- y se sincronizan con Google/Outlook como el resto.
-- La web pública lee y reserva a través de la función reservas (service_role); el panel
-- del negocio lo gestiona con su usuario (RLS por client_id, igual que los calendarios).

create table public.services (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid not null references public.clients (id) on delete cascade,
  name             text not null,
  category         text,
  description      text,
  price_eur        numeric(8, 2),
  price_from       boolean not null default false,   -- «desde 25 €»
  duration_minutes integer not null default 30 check (duration_minutes between 5 and 480),
  member_ids       uuid[] not null default '{}',     -- quién lo hace; vacío = todo el equipo
  bookable         boolean not null default true,    -- false: sale en precios pero se pide por WhatsApp
  active           boolean not null default true,
  sort             integer not null default 0,
  created_at       timestamptz not null default now()
);
create index services_client_idx on public.services (client_id, sort);

-- Clientes del negocio (quien se corta el pelo, no los clientes de EBM).
create table public.customers (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references public.clients (id) on delete cascade,
  name            text not null,
  phone           text,
  email           text,
  notes           text,
  last_booking_at timestamptz,
  created_at      timestamptz not null default now(),
  unique (client_id, phone)
);

-- Lo que se ve de cada persona del equipo en la web.
alter table public.team_members
  add column photo_url   text,
  add column bio         text,
  add column show_on_web boolean not null default false,
  add column sort        integer not null default 0;

alter table public.calendar_events
  add column service_id   uuid references public.services (id) on delete set null,
  add column customer_id  uuid references public.customers (id) on delete set null,
  add column price_eur    numeric(8, 2),
  -- Enlace secreto para que quien reservó pueda ver o anular su cita.
  add column manage_token text unique;
create index calendar_events_customer_idx on public.calendar_events (customer_id);

alter table public.calendar_events drop constraint calendar_events_source_check,
  add constraint calendar_events_source_check
  check (source in ('panel', 'agent', 'import', 'google', 'microsoft', 'web'));

-- Fotos (subidas al almacén site-media) y vídeos de YouTube que salen en la web.
create table public.site_media (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references public.clients (id) on delete cascade,
  kind         text not null check (kind in ('photo', 'video')),
  storage_path text,
  youtube_id   text check (youtube_id ~ '^[A-Za-z0-9_-]{11}$'),
  title        text,
  category     text,
  sort         integer not null default 0,
  published    boolean not null default true,
  created_at   timestamptz not null default now(),
  check ((kind = 'photo') = (storage_path is not null)),
  check ((kind = 'video') = (youtube_id is not null))
);
create index site_media_client_idx on public.site_media (client_id, kind, sort);

-- Textos y datos de la web que el negocio cambia desde su panel (portada, horario,
-- dirección, redes, reseñas, avisos…), en un solo documento por negocio.
create table public.site_settings (
  client_id  uuid primary key references public.clients (id) on delete cascade,
  data       jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  updated_at timestamptz not null default now()
);
create trigger site_settings_touch_updated_at
  before update on public.site_settings
  for each row execute function private.touch_updated_at();

-- Intentos de reserva desde la web (para frenar abusos). Sin IP: solo una huella diaria.
create table public.web_booking_attempts (
  id         bigint generated always as identity primary key,
  client_id  uuid not null references public.clients (id) on delete cascade,
  visitor    text not null,
  created_at timestamptz not null default now()
);
create index web_booking_attempts_idx on public.web_booking_attempts (visitor, created_at);
alter table public.web_booking_attempts enable row level security;
revoke all on public.web_booking_attempts from anon, authenticated;
select cron.schedule('web-booking-attempts-purge', '41 4 * * *',
  $$delete from public.web_booking_attempts where created_at < now() - interval '3 days'$$);

-- RLS: el admin todo; el negocio (y su partner) lo suyo.
do $$
declare t text;
begin
  foreach t in array array['services', 'customers', 'site_media', 'site_settings']
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

-- Almacén público de fotos de las webs: <client_id>/<archivo>. Se ve sin sesión (son
-- fotos de la web); solo sube, cambia o borra el propio negocio o administración.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('site-media', 'site-media', true, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'image/avif'])
on conflict (id) do nothing;

create policy site_media_write on storage.objects for insert to authenticated
  with check (bucket_id = 'site-media' and ((select private.is_admin())
    or (storage.foldername(name))[1] = any (select unnest((select private.my_client_ids()))::text)));
create policy site_media_update on storage.objects for update to authenticated
  using (bucket_id = 'site-media' and ((select private.is_admin())
    or (storage.foldername(name))[1] = any (select unnest((select private.my_client_ids()))::text)));
create policy site_media_delete on storage.objects for delete to authenticated
  using (bucket_id = 'site-media' and ((select private.is_admin())
    or (storage.foldername(name))[1] = any (select unnest((select private.my_client_ids()))::text)));

-- Crea la cita de la web solo si el hueco sigue libre en ese calendario (mismo bloqueo
-- que book_appointment, así web, chat y panel no pisan la misma hora). Solo la usa la
-- función reservas.
create function public.book_service(
  p_calendar uuid, p_start timestamptz, p_end timestamptz, p_title text, p_description text,
  p_service uuid, p_customer uuid, p_price numeric, p_type uuid
) returns table (id uuid, manage_token text)
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_token text := encode(extensions.gen_random_bytes(18), 'hex');
begin
  perform pg_advisory_xact_lock(hashtextextended(p_calendar::text, 0));
  if exists (
    select 1 from public.calendar_events e
    where e.calendar_id = p_calendar and e.starts_at < p_end and e.ends_at > p_start
  ) then
    return;
  end if;
  insert into public.calendar_events (calendar_id, client_id, title, description, starts_at, ends_at,
    source, service_id, customer_id, price_eur, type_id, manage_token)
  select p_calendar, c.client_id, p_title, p_description, p_start, p_end,
    'web', p_service, p_customer, p_price, p_type, v_token
  from public.calendars c where c.id = p_calendar and c.active and c.booking_enabled
  returning calendar_events.id into v_id;
  if v_id is not null then
    update public.customers set last_booking_at = now() where customers.id = p_customer;
    return query select v_id, v_token;
  end if;
end;
$$;
revoke execute on function public.book_service(uuid, timestamptz, timestamptz, text, text, uuid, uuid, numeric, uuid) from public, anon, authenticated;
grant execute on function public.book_service(uuid, timestamptz, timestamptz, text, text, uuid, uuid, numeric, uuid) to service_role;
