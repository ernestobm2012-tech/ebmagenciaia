-- Módulo «Clientes» de DZZERO (07/11/2026): personas que ya son clientes (contactos cerrados).
-- Se reutiliza la tabla customers (única por teléfono dentro del negocio, RLS own_or_admin).
alter table public.customers
  add column if not exists address text,
  add column if not exists town text,
  add column if not exists postal_code text,
  add column if not exists province text,
  add column if not exists equipment text,
  add column if not exists installed_at date,
  add column if not exists last_maintenance_at date,
  add column if not exists lead_id uuid references public.leads(id) on delete set null;
create index if not exists customers_lead_idx on public.customers(lead_id);

-- lead_to_customer: pasa un contacto a Clientes (si ya existe el teléfono, lo completa). Exige 9 cifras.
create or replace function public.lead_to_customer(p_lead uuid)
returns uuid language plpgsql security definer set search_path = '' as $f$
declare
  l public.leads%rowtype; v_phone text; v_id uuid; v_equip text;
begin
  select * into l from public.leads where id = p_lead;
  if l.id is null or not (select private.can_manage_leads(l.client_id)) then
    raise exception 'No tienes acceso a este contacto.';
  end if;
  v_phone := regexp_replace(coalesce(l.contact, ''), '\D', '', 'g');
  v_phone := regexp_replace(v_phone, '^(0034|34)(?=\d{9}$)', '');
  if v_phone !~ '^\d{9}$' then
    raise exception 'El teléfono del contacto no tiene 9 cifras: corrígelo en la ficha y vuelve a intentarlo.';
  end if;
  select string_agg(name, ', ') into v_equip from public.lead_products where lead_id = p_lead;
  insert into public.customers (client_id, name, phone, email, address, town, postal_code, province, equipment, notes, lead_id)
  values (l.client_id, coalesce(nullif(btrim(l.name), ''), 'Sin nombre'), v_phone, l.email, l.address, l.town, l.postal_code, l.province, v_equip, l.observations, l.id)
  on conflict (client_id, phone) do update set
    name = coalesce(nullif(btrim(l.name), ''), public.customers.name),
    email = coalesce(l.email, public.customers.email),
    address = coalesce(l.address, public.customers.address),
    town = coalesce(l.town, public.customers.town),
    postal_code = coalesce(l.postal_code, public.customers.postal_code),
    province = coalesce(l.province, public.customers.province),
    equipment = coalesce(v_equip, public.customers.equipment),
    lead_id = l.id
  returning id into v_id;
  return v_id;
end $f$;
revoke all on function public.lead_to_customer(uuid) from public, anon;
grant execute on function public.lead_to_customer(uuid) to authenticated;

-- Óscar (DZZERO) ya no ve «Conversaciones» en el menú: las conversaciones se ven dentro de la ficha del contacto.
update public.profiles set modules = array_remove(modules, 'act_conversaciones') where email = 'o.lopez@dzzero.com';
