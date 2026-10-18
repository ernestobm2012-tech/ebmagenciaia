-- Correos que prepara Claude desde los buzones de DonDominio (ebermejo@ e info@).
-- Se inserta una fila y el trigger llama a la función `mail`, que la lee ella
-- misma: con mode = 'draft' deja el correo en Borradores (Outlook lo ve por IMAP)
-- y con mode = 'send' lo envía por SMTP y guarda la copia en Enviados.
-- Los adjuntos son PDF de `client_documents` (pestaña Documentos del panel).
-- Contraseñas en los secretos MAIL_EBERMEJO_PASSWORD y MAIL_INFO_PASSWORD.
create table public.outgoing_mail (
  id           uuid primary key default gen_random_uuid(),
  account      text not null default 'ebermejo' check (account in ('ebermejo', 'info')),
  mode         text not null default 'draft' check (mode in ('draft', 'send')),
  to_addr      text[] not null,
  cc_addr      text[] not null default '{}',
  subject      text not null,
  body_html    text not null,
  document_ids uuid[] not null default '{}',
  client_id    uuid references public.clients(id) on delete set null,
  status       text not null default 'pending' check (status in ('pending', 'working', 'done', 'error')),
  error        text,
  created_at   timestamptz not null default now(),
  processed_at timestamptz
);
create index outgoing_mail_created_idx on public.outgoing_mail (created_at desc);

alter table public.outgoing_mail enable row level security;
create policy admin_all on public.outgoing_mail for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
grant select, insert, update, delete on public.outgoing_mail to authenticated;

create function private.mail_event() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform net.http_post(
    url := 'https://rhjbpkaesobsbnkvioyh.supabase.co/functions/v1/mail',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := jsonb_build_object('id', new.id),
    timeout_milliseconds := 60000
  );
  return new;
end;
$$;

create trigger mail_outgoing after insert on public.outgoing_mail
  for each row execute function private.mail_event();
