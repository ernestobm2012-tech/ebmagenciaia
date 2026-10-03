-- Conexión directa con Outlook / Microsoft 365 (Microsoft Graph), igual que la de
-- Google: el cliente entra con su cuenta y el calendario del panel queda enlazado
-- con su calendario principal en los dos sentidos y al momento. Un calendario del
-- panel solo puede estar enlazado con un proveedor a la vez.

alter table public.calendar_events drop constraint calendar_events_source_check;
alter table public.calendar_events add constraint calendar_events_source_check
  check (source in ('panel', 'agent', 'import', 'google', 'microsoft'));
alter table public.calendar_events add column microsoft_event_id text;
create unique index calendar_events_microsoft_id on public.calendar_events (calendar_id, microsoft_event_id);

alter table public.calendars add column microsoft_account text;

-- Tokens y suscripción de avisos. Solo la función (service role) la lee.
create table public.calendar_microsoft (
  calendar_id             uuid primary key references public.calendars (id) on delete cascade,
  account_email           text,
  refresh_token           text not null,
  subscription_id         text unique,
  subscription_secret     text,
  subscription_expires_at timestamptz,
  pulled_at               timestamptz,
  last_error              text,
  connected_at            timestamptz not null default now()
);

create table public.microsoft_oauth_states (
  state        text primary key,
  calendar_id  uuid not null references public.calendars (id) on delete cascade,
  user_id      uuid not null,
  return_url   text not null,
  created_at   timestamptz not null default now()
);

create table public.microsoft_outbox (
  id                bigint generated always as identity primary key,
  calendar_id       uuid not null,
  event_id          uuid,
  microsoft_event_id text,
  op                text not null check (op in ('upsert', 'delete')),
  attempts          integer not null default 0,
  last_error        text,
  created_at        timestamptz not null default now()
);
create index on public.microsoft_outbox (created_at);

alter table public.calendar_microsoft enable row level security;
alter table public.microsoft_oauth_states enable row level security;
alter table public.microsoft_outbox enable row level security;
revoke all on public.calendar_microsoft, public.microsoft_oauth_states, public.microsoft_outbox from anon, authenticated;

-- Un calendario, un proveedor.
create function private.only_one_provider() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_table_name = 'calendar_microsoft' and exists (select 1 from public.calendar_google where calendar_id = new.calendar_id) then
    raise exception 'Este calendario ya está conectado con Google. Desconéctalo primero.';
  end if;
  if tg_table_name = 'calendar_google' and exists (select 1 from public.calendar_microsoft where calendar_id = new.calendar_id) then
    raise exception 'Este calendario ya está conectado con Outlook. Desconéctalo primero.';
  end if;
  return new;
end;
$$;
create trigger only_one_provider before insert on public.calendar_microsoft
  for each row execute function private.only_one_provider();
create trigger only_one_provider before insert on public.calendar_google
  for each row execute function private.only_one_provider();

-- Cada cambio del panel se encola para Outlook; lo que escribe la función no.
create function private.queue_microsoft_change() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  row_cal uuid := coalesce(new.calendar_id, old.calendar_id);
begin
  if coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') = 'service_role'
     or current_setting('role', true) = 'service_role' then
    return null;
  end if;
  if not exists (select 1 from public.calendar_microsoft where calendar_id = row_cal) then
    return null;
  end if;
  if tg_op = 'DELETE' then
    -- Sin id de Outlook todavía, la cita nunca llegó allí: no hay nada que borrar.
    if old.source <> 'import' and old.microsoft_event_id is not null then
      insert into public.microsoft_outbox (calendar_id, microsoft_event_id, op)
      values (old.calendar_id, old.microsoft_event_id, 'delete');
    end if;
  elsif coalesce(new.source, '') <> 'import' then
    insert into public.microsoft_outbox (calendar_id, event_id, microsoft_event_id, op)
    values (new.calendar_id, new.id, new.microsoft_event_id, 'upsert');
  end if;
  perform net.http_post(
    url := 'https://rhjbpkaesobsbnkvioyh.supabase.co/functions/v1/microsoft-calendar?action=flush',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  return null;
end;
$$;
create trigger calendar_events_to_microsoft
  after insert or update or delete on public.calendar_events
  for each row execute function private.queue_microsoft_change();

create function public.microsoft_claim_outbox(p_limit integer) returns setof public.microsoft_outbox
language sql security definer set search_path = ''
as $$
  delete from public.microsoft_outbox
  where id in (select id from public.microsoft_outbox order by id limit p_limit for update skip locked)
  returning *;
$$;
revoke execute on function public.microsoft_claim_outbox(integer) from public, anon, authenticated;
grant execute on function public.microsoft_claim_outbox(integer) to service_role;

-- Mantenimiento cada 10 minutos: reintentos, renovar avisos (caducan a los 3 días)
-- y repaso por si se perdió algún aviso.
select cron.schedule('microsoft-calendar-maintain', '*/10 * * * *', $$
  select net.http_post(
    url := 'https://rhjbpkaesobsbnkvioyh.supabase.co/functions/v1/microsoft-calendar?action=maintain',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
$$);
