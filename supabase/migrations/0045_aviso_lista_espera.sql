-- Cuando se anula una cita (desde la web, el panel o el chat) y hay gente en la lista de
-- espera de ese día sin avisar, la función citas-mensajes les manda «se ha liberado un hueco».
create function private.waitlist_on_cancel() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare v_day date := (old.starts_at at time zone 'Europe/Madrid')::date;
begin
  if old.starts_at > now() and exists (
    select 1 from public.waitlist w
    where w.client_id = old.client_id and w.day = v_day and w.notified_at is null
  ) then
    perform net.http_post(
      url := 'https://rhjbpkaesobsbnkvioyh.supabase.co/functions/v1/citas-mensajes?action=waitlist',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := jsonb_build_object('client_id', old.client_id, 'day', v_day),
      timeout_milliseconds := 30000
    );
  end if;
  return old;
end;
$$;

create trigger waitlist_on_cancel after delete on public.calendar_events
  for each row execute function private.waitlist_on_cancel();
