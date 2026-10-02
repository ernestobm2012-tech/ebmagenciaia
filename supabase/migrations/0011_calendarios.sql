-- Calendarios de cada cliente. Puede tener tantos como quiera (uno por
-- persona, sala, servicio…) y cada uno se sincroniza con Google u Outlook:
--   - de fuera hacia aquí: la dirección iCal secreta de su calendario
--     (ics_import_url); la función calendar la lee cada 15 minutos.
--   - de aquí hacia fuera: un enlace iCal con feed_token que el cliente
--     añade en Google/Outlook como "calendario por URL".
create table public.calendars (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid not null references public.clients (id) on delete cascade,
  name             text not null,
  color            text not null default '#1483DC' check (color ~ '^#[0-9a-fA-F]{6}$'),
  ics_import_url   text check (ics_import_url is null or ics_import_url ~* '^(https|webcal)://'),
  feed_token       text not null unique default encode(extensions.gen_random_bytes(24), 'hex'),
  active           boolean not null default true,
  last_synced_at   timestamptz,
  sync_error       text,
  created_at       timestamptz not null default now()
);
create index on public.calendars (client_id);

create table public.calendar_events (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid not null references public.clients (id) on delete cascade,
  calendar_id      uuid not null references public.calendars (id) on delete cascade,
  title            text not null,
  description      text,
  location         text,
  starts_at        timestamptz not null,
  ends_at          timestamptz not null,
  all_day          boolean not null default false,
  -- panel: creada a mano; agent: la creó el agente; import: viene de Google/Outlook.
  source           text not null default 'panel' check (source in ('panel', 'agent', 'import')),
  external_uid     text,
  conversation_id  uuid references public.conversations (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (ends_at >= starts_at)
);
create index on public.calendar_events (calendar_id, starts_at);
create index on public.calendar_events (client_id, starts_at);
create index on public.calendar_events (conversation_id);

create trigger calendar_events_touch_updated_at
  before update on public.calendar_events
  for each row execute function private.touch_updated_at();

-- El cliente de un evento es siempre el de su calendario (nadie lo puede falsear).
create function private.event_client_from_calendar() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  select client_id into new.client_id from public.calendars where id = new.calendar_id;
  return new;
end;
$$;
create trigger calendar_events_client
  before insert or update of calendar_id on public.calendar_events
  for each row execute function private.event_client_from_calendar();

-- RLS: el admin todo; el cliente (y el partner, con los suyos) gestiona sus calendarios.
alter table public.calendars enable row level security;
alter table public.calendar_events enable row level security;
revoke all on public.calendars, public.calendar_events from anon, authenticated;
grant select, insert, delete on public.calendars to authenticated;
-- feed_token no se puede elegir a mano: solo se regenera con new_calendar_feed_token().
grant update (name, color, ics_import_url, active) on public.calendars to authenticated;
grant select, insert, update, delete on public.calendar_events to authenticated;

do $$
declare t text;
begin
  foreach t in array array['calendars', 'calendar_events']
  loop
    execute format(
      'create policy own_or_admin on public.%I for all to authenticated
         using ((select private.is_admin()) or client_id = any ((select private.my_client_ids())::uuid[]))
         with check ((select private.is_admin()) or client_id = any ((select private.my_client_ids())::uuid[]))', t);
  end loop;
end $$;

-- Cambia el enlace de exportación (si se ha compartido por error, el viejo deja de valer).
create function public.new_calendar_feed_token(p_calendar uuid) returns text
language plpgsql security definer set search_path = ''
as $$
declare token text := encode(extensions.gen_random_bytes(24), 'hex');
begin
  update public.calendars set feed_token = token
  where id = p_calendar
    and ((select private.is_admin()) or client_id = any ((select private.my_client_ids())::uuid[]));
  if not found then raise exception 'Calendario no encontrado'; end if;
  return token;
end;
$$;
revoke execute on function public.new_calendar_feed_token(uuid) from public, anon;
grant execute on function public.new_calendar_feed_token(uuid) to authenticated;

-- Cada 15 minutos se traen los calendarios de Google/Outlook.
select cron.schedule('sync-calendars', '*/15 * * * *', $$
  select net.http_post(
    url := 'https://rhjbpkaesobsbnkvioyh.supabase.co/functions/v1/calendar',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
$$);
