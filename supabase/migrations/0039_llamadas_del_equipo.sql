-- Llamadas programadas por el asistente y repartidas entre el equipo.
-- Cada calendario puede ser de una persona del equipo (member_id) y decir qué agenda
-- el asistente en él (booking_kind): 'cita' (como hasta ahora, en ese calendario) o
-- 'llamada' (todas las agendas de llamadas del negocio funcionan como un grupo: el
-- asistente ve los huecos de todas y la llamada se pone a la persona libre que tenga
-- menos ese día, sin repetir hora). booking_type_id: tipo de cita (color) con el que
-- se apunta lo que reserva el asistente en ese calendario.
alter table public.calendars
  add column member_id uuid references public.team_members (id) on delete set null,
  add column booking_kind text not null default 'cita' check (booking_kind in ('cita', 'llamada')),
  add column booking_type_id uuid references public.appointment_types (id) on delete set null;
