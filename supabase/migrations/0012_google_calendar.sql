-- Conexión directa con Google Calendar (como GHL): el cliente entra con su
-- cuenta de Google y el calendario del panel queda enlazado con su calendario
-- principal en los dos sentidos y al momento:
--   - panel -> Google: cada cambio en calendar_events va a google_outbox y
--     la función google-calendar lo manda a Google en el acto.
--   - Google -> panel: Google avisa a la función (canal "watch") en cuanto
--     cambia algo y la función trae los cambios.

-- Eventos que vienen de la cuenta de Google conectada (editables aquí).
alter table public.calendar_events drop constraint calendar_events_source_check;
alter table public.calendar_events add constraint calendar_events_source_check
  check (source in ('panel', 'agent', 'import', 'google'));
alter table public.calendar_events add column google_event_id text;
create unique index calendar_events_google_id on public.calendar_events (calendar_id, google_event_id);

-- Cuenta conectada, visible en el panel (lo escribe solo la función).
alter table public.calendars add column google_account text;

-- Conexión con Google: tokens y canal de avisos. Solo la función (service role)
-- la lee; ni el cliente ni el admin la ven desde el panel.
create table public.calendar_google (
  calendar_id          uuid primary key references public.calendars (id) on delete cascade,
  account_email        text,
  refresh_token        text not null,
  google_calendar_id   text not null default 'primary',
  channel_id           text unique,
  channel_resource_id  text,
  channel_token        text,
  channel_expires_at   timestamptz,
  pulled_at            timestamptz,
  last_error           text,
  connected_at         timestamptz not null default now()
);

-- Peticiones de conexión en curso (el "state" de OAuth), caducan en 15 minutos.
create table public.google_oauth_states (
  state        text primary key,
  calendar_id  uuid not null references public.calendars (id) on delete cascade,
  user_id      uuid not null,
  return_url   text not null,
  created_at   timestamptz not null default now()
);

-- Cambios del panel pendientes de mandar a Google. Sin clave foránea: al
-- borrar un calendario se borran sus citas y no debe fallar por esta cola.
create table public.google_outbox (
  id               bigint generated always as identity primary key,
  calendar_id      uuid not null,
  event_id         uuid,
  google_event_id  text,
  op               text not null check (op in ('upsert', 'delete')),
  attempts         integer not null default 0,
  last_error       text,
  created_at       timestamptz not null default now()
);
create index on public.google_outbox (created_at);

alter table public.calendar_google enable row level security;
alter table public.google_oauth_states enable row level security;
alter table public.google_outbox enable row level security;
revoke all on public.calendar_google, public.google_oauth_states, public.google_outbox from anon, authenticated;

-- Cada cambio hecho desde el panel (o por el agente) se encola para Google.
-- Lo que escribe la propia función (service_role) no se encola: viene de Google.
create function private.queue_google_change() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  row_cal uuid := coalesce(new.calendar_id, old.calendar_id);
begin
  if coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') = 'service_role'
     or current_setting('role', true) = 'service_role' then
    return null;
  end if;
  if not exists (select 1 from public.calendar_google where calendar_id = row_cal) then
    return null;
  end if;
  if tg_op = 'DELETE' then
    -- Si aún no se había mandado, en Google tendría su uuid sin guiones.
    if old.source <> 'import' then
      insert into public.google_outbox (calendar_id, google_event_id, op)
      values (old.calendar_id, coalesce(old.google_event_id, replace(old.id::text, '-', '')), 'delete');
    end if;
  elsif coalesce(new.source, '') <> 'import' then
    insert into public.google_outbox (calendar_id, event_id, google_event_id, op)
    values (new.calendar_id, new.id, new.google_event_id, 'upsert');
  end if;
  -- Aviso inmediato a la función para que lo mande ya.
  perform net.http_post(
    url := 'https://rhjbpkaesobsbnkvioyh.supabase.co/functions/v1/google-calendar?action=flush',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  return null;
end;
$$;

create trigger calendar_events_to_google
  after insert or update or delete on public.calendar_events
  for each row execute function private.queue_google_change();

-- La función recoge los cambios pendientes; dos ejecuciones a la vez nunca
-- se llevan el mismo cambio.
create function public.google_claim_outbox(p_limit integer) returns setof public.google_outbox
language sql security definer set search_path = ''
as $$
  delete from public.google_outbox
  where id in (select id from public.google_outbox order by id limit p_limit for update skip locked)
  returning *;
$$;
revoke execute on function public.google_claim_outbox(integer) from public, anon, authenticated;
grant execute on function public.google_claim_outbox(integer) to service_role;

-- Mantenimiento cada 10 minutos: reintenta envíos, renueva canales de aviso
-- (caducan cada semana) y trae cambios por si se perdió algún aviso.
select cron.schedule('google-calendar-maintain', '*/10 * * * *', $$
  select net.http_post(
    url := 'https://rhjbpkaesobsbnkvioyh.supabase.co/functions/v1/google-calendar?action=maintain',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
$$);
