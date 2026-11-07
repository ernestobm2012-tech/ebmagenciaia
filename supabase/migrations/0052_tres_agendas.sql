-- Tres agendas para DZZERO (07/11/2026): teleoperadoras (llamadas), visitas y comercial.
-- Las agendas se agrupan con calendars.agenda_group; las llamadas se dan cada 5 minutos
-- (booking_step_minutes) y, al haber dos teleoperadoras, se pueden repetir dos a la misma hora.
alter table public.calendars
  add column if not exists agenda_group text check (agenda_group in ('llamadas','visitas','comercial')),
  add column if not exists booking_step_minutes smallint check (booking_step_minutes between 5 and 240);
alter table public.calendar_events add column if not exists lead_id uuid references public.leads(id) on delete set null;
alter table public.leads add column if not exists visit_member_id uuid references public.team_members(id) on delete set null;
create index if not exists calendar_events_lead_idx on public.calendar_events(lead_id);

-- DZZERO: Laura y Angela = llamadas cada 5 min; Óscar y Juan Antonio = agenda comercial; una agenda de visitas.
update public.calendars set agenda_group = 'llamadas', booking_step_minutes = 5
 where id in ('a797edfb-22d9-43e1-a9c1-39484bf301c1', '938ef033-bebd-48df-aec2-90ff16aa1993');
update public.calendars set agenda_group = 'comercial' where id = 'bce08e6d-2834-4691-9d75-3cd3b42c3e2d';
-- (Calendario de Juan Antonio y Agenda de visitas se crearon con INSERT en esta misma fecha.)

-- schedule_visit: agenda la visita desde la ficha. Sin comercial va a «Agenda de visitas» (el día, hora opcional);
-- con comercial (y hora) va a su agenda y el contacto pasa a ese comercial. Sin día, quita la visita.
-- El enlace entre la cita y el contacto es calendar_events.lead_id (source = 'panel': el check solo admite los orígenes de siempre).
create or replace function public.schedule_visit(p_lead uuid, p_date date, p_time time default null, p_member uuid default null, p_minutes int default 60)
returns jsonb language plpgsql security definer set search_path = '' as $f$
declare
  l public.leads%rowtype;
  v_cal uuid; v_start timestamptz; v_end timestamptz; v_all boolean := false;
  v_title text; v_desc text; v_loc text; v_event uuid;
begin
  select * into l from public.leads where id = p_lead;
  if l.id is null or not (select private.can_manage_leads(l.client_id)) then
    raise exception 'No tienes acceso a este contacto.';
  end if;
  if p_date is null then
    delete from public.calendar_events where lead_id = p_lead;
    update public.leads set visit_at = null, visit_member_id = null, updated_at = now() where id = p_lead;
    return jsonb_build_object('removed', true);
  end if;
  if p_member is not null then
    if p_time is null then raise exception 'Para asignarla a un comercial hace falta la hora.'; end if;
    select id into v_cal from public.calendars
      where client_id = l.client_id and agenda_group = 'comercial' and member_id = p_member and active limit 1;
    if v_cal is null then raise exception 'Ese comercial no tiene agenda. Pídele a EBM que se la cree.'; end if;
  else
    select id into v_cal from public.calendars
      where client_id = l.client_id and agenda_group = 'visitas' and active limit 1;
    if v_cal is null then raise exception 'Este negocio no tiene agenda de visitas.'; end if;
  end if;
  if p_time is null then
    v_all := true;
    v_start := (p_date::timestamp) at time zone 'Europe/Madrid';
    v_end := ((p_date + 1)::timestamp) at time zone 'Europe/Madrid';
  else
    v_start := (p_date + p_time) at time zone 'Europe/Madrid';
    v_end := v_start + make_interval(mins => greatest(5, least(p_minutes, 480)));
  end if;
  v_title := 'Visita · ' || coalesce(l.name, 'Sin nombre') || coalesce(' · ' || l.contact, '');
  v_desc := concat_ws(E'\n', 'Contacto: ' || coalesce(l.name, '—') || ' ' || coalesce(l.contact, ''),
    nullif(concat_ws(', ', l.address, l.town, l.postal_code, l.province), ''), l.observations);
  v_loc := nullif(concat_ws(', ', l.address, l.town, l.province), '');
  select id into v_event from public.calendar_events where lead_id = p_lead limit 1;
  if v_event is null then
    insert into public.calendar_events (client_id, calendar_id, title, description, location, starts_at, ends_at, all_day, source, lead_id)
    values (l.client_id, v_cal, v_title, v_desc, v_loc, v_start, v_end, v_all, 'panel', p_lead);
  else
    update public.calendar_events set calendar_id = v_cal, title = v_title, description = v_desc, location = v_loc,
      starts_at = v_start, ends_at = v_end, all_day = v_all, updated_at = now() where id = v_event;
  end if;
  update public.leads set visit_at = v_start, visit_member_id = p_member, updated_at = now() where id = p_lead;
  if p_member is not null then
    update public.leads set seller_id = p_member, passed_at = coalesce(passed_at, now()),
      status = case when status in ('won','lost') then status else 'with_sales' end, updated_at = now()
    where id = p_lead;
  end if;
  return jsonb_build_object('calendar_id', v_cal, 'starts_at', v_start, 'all_day', v_all);
end $f$;
revoke all on function public.schedule_visit(uuid, date, time, uuid, int) from public, anon;
grant execute on function public.schedule_visit(uuid, date, time, uuid, int) to authenticated;
