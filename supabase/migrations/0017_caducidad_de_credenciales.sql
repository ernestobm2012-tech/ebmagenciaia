-- Contador de caducidad de claves de terceros (p. ej. el secreto de la app de
-- Azure/Outlook, que caduca). Se ve y se edita en el Resumen del panel (solo
-- administración) y un cron diario avisa (push + registro de errores) cuando
-- quedan 60, 30, 14 días y cada día durante la última semana.
create table public.credential_expiry (
  key         text primary key,
  label       text not null,
  expires_at  date,
  note        text,
  updated_at  timestamptz not null default now()
);
alter table public.credential_expiry enable row level security;
create policy admin_all on public.credential_expiry for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
grant select, insert, update on public.credential_expiry to authenticated;

insert into public.credential_expiry (key, label, note) values
  ('microsoft_secret', 'Outlook: secreto de la app de Azure',
   'Azure → EBM Agentes → Certificados y secretos. Crea el nuevo ANTES de que caduque, cámbialo en Supabase (MICROSOFT_CLIENT_SECRET) y borra el viejo.');

create function private.check_credential_expiry() returns void
language plpgsql security definer set search_path = ''
as $$
declare
  r record;
  days int;
begin
  for r in select * from public.credential_expiry where expires_at is not null loop
    days := r.expires_at - current_date;
    if days in (60, 30, 14) or days <= 7 then
      insert into public.error_log (source, message) values (
        'caducidad',
        case when days < 0 then r.label || ' CADUCÓ hace ' || (-days) || ' días. Las conexiones dejan de funcionar.'
             when days = 0 then r.label || ' caduca HOY.'
             else r.label || ' caduca en ' || days || ' días (' || to_char(r.expires_at, 'DD/MM/YYYY') || '). Renuévala.' end);
    end if;
  end loop;
end;
$$;
revoke all on function private.check_credential_expiry() from public, anon, authenticated;

select cron.schedule('credential-expiry-check', '5 8 * * *', $$select private.check_credential_expiry()$$);
