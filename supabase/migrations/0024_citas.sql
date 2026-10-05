-- Reserva de citas por el agente. Cada calendario puede aceptar reservas con su
-- propio horario semanal y su duración de cita.
--   booking_hours: {"1": ["16:30-21:30"], ..., "6": ["09:00-14:00"]}  (1 = lunes … 7 = domingo)
--   booking_minutes: duración de cada cita.
--   booking_notice_minutes: antelación mínima (no se reserva para dentro de 10 minutos).
alter table public.calendars
  add column booking_enabled boolean not null default false,
  add column booking_minutes integer not null default 30 check (booking_minutes between 10 and 240),
  add column booking_hours jsonb not null default '{}'::jsonb check (jsonb_typeof(booking_hours) = 'object'),
  add column booking_notice_minutes integer not null default 120 check (booking_notice_minutes between 0 and 10080);

grant update (booking_enabled, booking_minutes, booking_hours, booking_notice_minutes) on public.calendars to authenticated;

-- Crea la cita solo si el hueco sigue libre. El bloqueo por calendario evita que
-- dos conversaciones reserven la misma hora a la vez. Solo la usan las funciones.
create function public.book_appointment(
  p_calendar uuid, p_start timestamptz, p_end timestamptz,
  p_title text, p_description text, p_conversation uuid
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare new_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_calendar::text, 0));
  if exists (
    select 1 from public.calendar_events
    where calendar_id = p_calendar and starts_at < p_end and ends_at > p_start
  ) then
    return null;
  end if;
  insert into public.calendar_events (calendar_id, client_id, title, description, starts_at, ends_at, source, conversation_id)
  select p_calendar, c.client_id, p_title, p_description, p_start, p_end, 'agent', p_conversation
  from public.calendars c where c.id = p_calendar and c.active and c.booking_enabled
  returning id into new_id;
  return new_id;
end;
$$;
revoke execute on function public.book_appointment(uuid, timestamptz, timestamptz, text, text, uuid) from public, anon, authenticated;
grant execute on function public.book_appointment(uuid, timestamptz, timestamptz, text, text, uuid) to service_role;
