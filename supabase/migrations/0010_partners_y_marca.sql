-- Partners: un cliente (p. ej. Palmo) puede tener clientes propios colgando de
-- él. Esos clientes se facturan a través del partner y ven su marca, no la de EBM.
alter table public.clients
  add column parent_client_id uuid references public.clients (id) on delete set null,
  add column brand_name       text,
  add column brand_logo_url   text check (brand_logo_url is null or brand_logo_url like 'https://%'),
  add column brand_color      text check (brand_color is null or brand_color ~ '^#[0-9a-fA-F]{6}$'),
  add constraint clients_no_self_parent check (parent_client_id is null or parent_client_id <> id);
create index on public.clients (parent_client_id);

-- Rol partner: ve su propio cliente y los que cuelgan de él.
alter table public.profiles drop constraint profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role in ('admin', 'partner', 'client'));

create function private.my_client_ids() returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(c.id), '{}')
  from public.profiles p
  join public.clients c
    on c.id = p.client_id or (p.role = 'partner' and c.parent_client_id = p.client_id)
  where p.id = (select auth.uid()) and p.role in ('client', 'partner');
$$;
grant execute on function private.my_client_ids() to authenticated;

do $$
declare t text;
begin
  foreach t in array array['notify_contacts', 'conversations', 'messages', 'leads',
                           'handoffs', 'appointments', 'notifications']
  loop
    execute format('drop policy read_own_or_admin on public.%I', t);
    execute format(
      'create policy read_own_or_admin on public.%I for select to authenticated
         using ((select private.is_admin()) or client_id = any ((select private.my_client_ids())::uuid[]))', t);
  end loop;
end $$;

-- Lo que un usuario no admin necesita saber de sus clientes y de la marca que debe ver.
drop function public.my_client();
create function public.my_clients()
returns table (id uuid, name text, status text, is_own boolean)
language sql stable security definer set search_path = ''
as $$
  select c.id, c.name, c.status, c.id = p.client_id
  from public.profiles p
  join public.clients c
    on c.id = p.client_id or (p.role = 'partner' and c.parent_client_id = p.client_id)
  where p.id = (select auth.uid()) and p.role in ('client', 'partner')
  order by (c.id = p.client_id) desc, c.name;
$$;
revoke execute on function public.my_clients() from public, anon;
grant execute on function public.my_clients() to authenticated;

-- Marca: la del partner si el cliente cuelga de uno; si no, la propia. Vacía = marca de EBM.
create function public.my_brand()
returns table (name text, logo_url text, color text)
language sql stable security definer set search_path = ''
as $$
  select b.brand_name, b.brand_logo_url, b.brand_color
  from public.profiles p
  join public.clients c on c.id = p.client_id
  join public.clients b on b.id = coalesce(c.parent_client_id, c.id)
  where p.id = (select auth.uid()) and b.brand_name is not null;
$$;
revoke execute on function public.my_brand() from public, anon;
grant execute on function public.my_brand() to authenticated;
