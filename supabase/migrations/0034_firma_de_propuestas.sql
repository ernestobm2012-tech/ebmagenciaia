-- Firma de propuestas por el cliente (como el contrato de Mi Pequeño Rincón, pero
-- con el PDF personalizado de cada cliente). El panel crea una solicitud con un
-- enlace secreto; el cliente lo abre en ebmagenciaia.es/firmar.html, rellena sus
-- datos y firma; la función `firma` añade al PDF una hoja de aceptación con la
-- firma y las evidencias, la guarda en Documentos (tipo contrato) y la sube a
-- Google Drive (función `google-drive`), en la carpeta del cliente › Contratos.

create table public.signature_requests (
  id                 uuid primary key default gen_random_uuid(),
  token              text not null unique default encode(extensions.gen_random_bytes(24), 'hex'),
  client_id          uuid not null references public.clients (id) on delete cascade,
  document_id        uuid not null references public.client_documents (id) on delete cascade,
  status             text not null default 'pending' check (status in ('pending', 'signed', 'cancelled')),
  created_at         timestamptz not null default now(),
  expires_at         timestamptz not null default now() + interval '60 days',
  signed_at          timestamptz,
  signer_name        text,
  signer_nif         text,
  signer_role        text,
  company_name       text,
  company_cif        text,
  signer_email       text,
  signer_phone       text,
  typed_name         text,
  signature_png      text,
  ip                 text,
  user_agent         text,
  doc_sha256         text,
  signed_document_id uuid references public.client_documents (id) on delete set null,
  drive_file_id      text,
  drive_error        text
);
create index signature_requests_client_idx on public.signature_requests (client_id, created_at desc);

alter table public.signature_requests enable row level security;
create policy admin_all on public.signature_requests for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
grant select, insert, update, delete on public.signature_requests to authenticated;

-- Carpeta del cliente en Google Drive (dentro de «Ebm agencia ia»).
alter table public.clients add column if not exists drive_folder_id text;

-- Segundo correo de contacto (p. ej. info@ y el de la persona que lleva el trato).
alter table public.clients add column if not exists contact_email_alt text;

-- Conexión con Google Drive de la administración (una sola cuenta). Solo service_role.
create table public.drive_google (
  id             int primary key default 1 check (id = 1),
  account_email  text,
  refresh_token  text not null,
  root_folder_id text,
  connected_at   timestamptz not null default now()
);
alter table public.drive_google enable row level security;
revoke all on public.drive_google from anon, authenticated;

create table public.drive_oauth_states (
  state      text primary key,
  user_id    uuid,
  return_url text,
  created_at timestamptz not null default now()
);
alter table public.drive_oauth_states enable row level security;
revoke all on public.drive_oauth_states from anon, authenticated;
