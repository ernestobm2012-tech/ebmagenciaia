-- Documentos de cada cliente (propuestas, contratos, facturas…): el PDF se
-- guarda en el almacén privado `client-docs` y aquí queda la ficha. Solo la
-- administración los ve; se descargan con un enlace firmado que caduca.
create table public.client_documents (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  name text not null,
  kind text not null default 'propuesta' check (kind in ('propuesta', 'contrato', 'factura', 'otro')),
  storage_path text not null unique,
  size_bytes bigint,
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null default auth.uid()
);
create index client_documents_client_idx on public.client_documents (client_id, created_at desc);

alter table public.client_documents enable row level security;
create policy admin_all on public.client_documents for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
grant select, insert, update, delete on public.client_documents to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('client-docs', 'client-docs', false, 20971520, array['application/pdf'])
on conflict (id) do nothing;

create policy client_docs_admin_read on storage.objects for select to authenticated
  using (bucket_id = 'client-docs' and (select private.is_admin()));
create policy client_docs_admin_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'client-docs' and (select private.is_admin()));
create policy client_docs_admin_delete on storage.objects for delete to authenticated
  using (bucket_id = 'client-docs' and (select private.is_admin()));
