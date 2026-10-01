-- Avisos por correo: al entrar un contacto, un paso a humano o un mensaje del
-- formulario, la base de datos llama a la función notify.
alter table public.leads            add column notified_at timestamptz;
alter table public.handoffs         add column notified_at timestamptz;
alter table public.contact_messages add column notified_at timestamptz;

create function private.notify_event() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform net.http_post(
    url := 'https://rhjbpkaesobsbnkvioyh.supabase.co/functions/v1/notify',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := jsonb_build_object('kind', tg_argv[0], 'id', new.id)
  );
  return new;
end;
$$;

create trigger notify_lead    after insert on public.leads
  for each row execute function private.notify_event('lead');
create trigger notify_handoff after insert on public.handoffs
  for each row execute function private.notify_event('handoff');
create trigger notify_contact after insert on public.contact_messages
  for each row execute function private.notify_event('contact');

-- Reintenta cada 5 minutos los avisos del último día que no salieron
-- (por ejemplo, si el servicio de correo falló o aún no estaba configurado).
create function private.retry_notifications() returns void
language plpgsql security definer set search_path = ''
as $$
declare r record;
begin
  for r in
    select 'lead' as kind, id from public.leads where notified_at is null and created_at > now() - interval '1 day'
    union all
    select 'handoff', id from public.handoffs where notified_at is null and created_at > now() - interval '1 day'
    union all
    select 'contact', id from public.contact_messages where notified_at is null and created_at > now() - interval '1 day'
    limit 20
  loop
    perform net.http_post(
      url := 'https://rhjbpkaesobsbnkvioyh.supabase.co/functions/v1/notify',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := jsonb_build_object('kind', r.kind, 'id', r.id)
    );
  end loop;
end;
$$;

select cron.schedule('retry-notifications', '*/5 * * * *', $$select private.retry_notifications()$$);
