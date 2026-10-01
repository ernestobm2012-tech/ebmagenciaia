-- Catálogo de productos de un cliente. No se envía entero al agente: el agente
-- lo consulta con una búsqueda (catalog_search) y recibe solo unos resultados.
create extension if not exists unaccent with schema extensions;

create table public.catalog_items (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references public.clients (id) on delete cascade,
  external_id  text,
  name         text not null,
  reference    text,
  category     text,
  brand        text,
  used_in      text,
  url          text,
  details      jsonb not null default '{}',
  search_text  text not null,
  created_at   timestamptz not null default now(),
  unique (client_id, external_id)
);
create index on public.catalog_items (client_id);

alter table public.catalog_items enable row level security;
revoke all on public.catalog_items from anon;
grant select, insert, update, delete on public.catalog_items to authenticated;
create policy admin_all on public.catalog_items for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

create function private.normalize(t text) returns text
language sql stable set search_path = ''
as $$ select lower(extensions.unaccent(coalesce(t, ''))) $$;

-- Búsqueda para el agente: todas las palabras de la consulta cuentan; se
-- devuelven los productos que contienen más de ellas. El catálogo es público
-- (es el de la tienda), así que puede consultarse sin sesión.
create function public.catalog_search(p_client text, p_query text)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with terms as (
    select distinct t from regexp_split_to_table(private.normalize(left(p_query, 200)), '[^a-z0-9]+') t
    where length(t) >= 2 and t not in ('de', 'el', 'la', 'los', 'las', 'para', 'con', 'un', 'una', 'del', 'en', 'por')
  ), scored as (
    select i.*, (select count(*) from terms where i.search_text like '%' || terms.t || '%') as score
    from public.catalog_items i
    join public.clients c on c.id = i.client_id
    where c.slug = p_client
  ), hits as (
    select * from scored
    where score >= greatest(1, ceil((select count(*) from terms) * 0.6))
  )
  select jsonb_build_object(
    'coincidencias', (select count(*) from hits),
    'productos', coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'nombre', name, 'referencia', reference, 'fabricante', brand, 'para_uso_en', used_in,
        'tipo', category, 'detalles', nullif(details, '{}'::jsonb), 'url', url)))
      from (select * from hits order by score desc, name limit 8) top), '[]'::jsonb)
  );
$$;
revoke execute on function public.catalog_search(text, text) from public;
grant execute on function public.catalog_search(text, text) to anon, authenticated;
