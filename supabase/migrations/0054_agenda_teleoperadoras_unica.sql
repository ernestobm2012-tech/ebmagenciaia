-- Una sola agenda de teleoperadoras en DZZERO (07/11/2026): «Teleoperadoras», con capacidad 2 (dos llamadas a la misma hora).
alter table public.calendars add column if not exists booking_capacity smallint not null default 1 check (booking_capacity between 1 and 20);

-- book_appointment respeta la capacidad del calendario; un evento de todo el día (festivo) lo cierra.
create or replace function public.book_appointment(p_calendar uuid, p_start timestamp with time zone, p_end timestamp with time zone, p_title text, p_description text, p_conversation uuid)
returns uuid language plpgsql security definer set search_path = '' as $f$
declare new_id uuid; v_cap int; v_over int; v_allday boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_calendar::text, 0));
  select coalesce(booking_capacity, 1) into v_cap from public.calendars where id = p_calendar;
  select count(*), coalesce(bool_or(all_day), false) into v_over, v_allday
  from public.calendar_events where calendar_id = p_calendar and starts_at < p_end and ends_at > p_start;
  if v_allday or v_over >= coalesce(v_cap, 1) then
    return null;
  end if;
  insert into public.calendar_events (calendar_id, client_id, title, description, starts_at, ends_at, source, conversation_id)
  select p_calendar, c.client_id, p_title, p_description, p_start, p_end, 'agent', p_conversation
  from public.calendars c where c.id = p_calendar and c.active and c.booking_enabled
  returning id into new_id;
  return new_id;
end $f$;

-- Un contacto con llamada programada sin persona asignada (agenda común) avisa como contacto nuevo; con persona, solo la asignación.
create or replace function private.push_event()
returns trigger language plpgsql security definer set search_path = '' as $f$
begin
  if tg_argv[0] = 'lead' then
    if new.status = 'callback' and new.caller_id is not null then
      return new;
    end if;
  end if;
  perform net.http_post(
    url := 'https://rhjbpkaesobsbnkvioyh.supabase.co/functions/v1/push?action=send',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := jsonb_build_object('kind', tg_argv[0], 'id', new.id)
  );
  return new;
end $f$;

-- Datos de DZZERO: el calendario de Laura pasa a ser «Teleoperadoras» (sin persona, capacidad 2), se le pasan las
-- llamadas del de Ángela y este se apaga (no se borra).
update public.calendar_events set calendar_id = 'a797edfb-22d9-43e1-a9c1-39484bf301c1'
 where calendar_id = '938ef033-bebd-48df-aec2-90ff16aa1993' and not all_day;
update public.calendars set name = 'Teleoperadoras', member_id = null, booking_capacity = 2, agenda_group = 'llamadas', booking_step_minutes = 5
 where id = 'a797edfb-22d9-43e1-a9c1-39484bf301c1';
update public.calendars set active = false, booking_enabled = false, agenda_group = null,
  name = 'Calendario de Angela (sin usar, ahora es «Teleoperadoras»)' where id = '938ef033-bebd-48df-aec2-90ff16aa1993';
