-- Catálogo de productos (sin precios), ficha completa del contacto con el equipo que se
-- va a montar, y presupuestos. El precio lo pone el comercial en cada presupuesto, a
-- pago único, mensual o las dos cosas (cada cliente final puede tener un precio distinto).
-- Quién lo ve: administración y quien tiene el permiso «catalogo» en el negocio.

create function private.can_manage_catalog(p_client uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select (select private.is_admin())
      or (p_client = any ((select private.my_client_ids())::uuid[]) and (select private.can_see('catalogo')));
$$;

-- ------------------------------------------------------------------ catálogo
create table public.products (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.clients (id) on delete cascade,
  name        text not null,
  category    text,
  description text,
  features    text,
  sheet_url   text,
  active      boolean not null default true,
  sort        int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index products_client_idx on public.products (client_id, category, name);

-- ------------------------------------------------------------------ ficha completa del contacto
alter table public.leads
  add column email text,
  add column address text,
  add column postal_code text,
  add column province text,
  add column property_type text check (property_type in ('casa', 'negocio')),
  add column water_notes text,
  add column install_notes text;

-- Equipo que se va a montar (todavía sin precio).
create table public.lead_products (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references public.clients (id) on delete cascade,
  lead_id    uuid not null references public.leads (id) on delete cascade,
  product_id uuid references public.products (id) on delete set null,
  name       text not null,
  qty        int not null default 1 check (qty > 0),
  notes      text,
  created_at timestamptz not null default now()
);
create index lead_products_lead_idx on public.lead_products (lead_id);

-- ------------------------------------------------------------------ presupuestos
create table public.quotes (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.clients (id) on delete cascade,
  lead_id       uuid references public.leads (id) on delete set null,
  number        int not null,
  status        text not null default 'draft' check (status in ('draft', 'sent', 'accepted', 'rejected')),
  offer         text not null default 'both' check (offer in ('cash', 'monthly', 'both')),
  months        int check (months is null or months > 0),
  discount_eur  numeric(12, 2) not null default 0,
  cash_total    numeric(12, 2),
  monthly_total numeric(12, 2),
  valid_until   date,
  intro         text,
  conditions    text,
  customer_name text,
  customer_contact text,
  customer_address text,
  created_by    uuid references public.profiles (id) on delete set null,
  sent_at       timestamptz,
  decided_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (client_id, number)
);
create index quotes_client_idx on public.quotes (client_id, created_at desc);
create index quotes_lead_idx on public.quotes (lead_id);

create table public.quote_items (
  id           uuid primary key default gen_random_uuid(),
  quote_id     uuid not null references public.quotes (id) on delete cascade,
  product_id   uuid references public.products (id) on delete set null,
  name         text not null,
  description  text,
  qty          int not null default 1 check (qty > 0),
  unit_cash    numeric(12, 2),
  unit_monthly numeric(12, 2),
  sort         int not null default 0
);
create index quote_items_quote_idx on public.quote_items (quote_id, sort);

-- Número correlativo por negocio.
create function private.quote_number() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.number is null or new.number = 0 then
    select coalesce(max(number), 0) + 1 into new.number from public.quotes where client_id = new.client_id;
  end if;
  return new;
end;
$$;
alter table public.quotes alter column number drop not null;
create trigger quotes_number before insert on public.quotes for each row execute function private.quote_number();
create function private.touch_updated() returns trigger language plpgsql set search_path = ''
as $$ begin new.updated_at := now(); return new; end; $$;
create trigger quotes_touch before update on public.quotes for each row execute function private.touch_updated();
create trigger products_touch before update on public.products for each row execute function private.touch_updated();

-- ------------------------------------------------------------------ permisos
do $$
declare t text;
begin
  foreach t in array array['products', 'lead_products', 'quotes'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy catalog_all on public.%I for all to authenticated
      using ((select private.can_manage_catalog(client_id))) with check ((select private.can_manage_catalog(client_id)))', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

alter table public.quote_items enable row level security;
create policy catalog_all on public.quote_items for all to authenticated
  using (exists (select 1 from public.quotes q where q.id = quote_id and (select private.can_manage_catalog(q.client_id))))
  with check (exists (select 1 from public.quotes q where q.id = quote_id and (select private.can_manage_catalog(q.client_id))));
grant select, insert, update, delete on public.quote_items to authenticated;

-- El comercial completa la ficha del contacto (lo que antes solo llegaba por el asistente).
create function public.update_lead_profile(p_id uuid, p_email text, p_address text, p_postal text,
  p_province text, p_property text, p_water text, p_install text) returns void
language plpgsql security definer set search_path = ''
as $$
declare v_client uuid;
begin
  select client_id into v_client from public.leads where id = p_id;
  if v_client is null or not (select private.can_manage_leads(v_client)) then
    raise exception 'No tienes acceso a este contacto.';
  end if;
  update public.leads set email = nullif(btrim(p_email), ''), address = nullif(btrim(p_address), ''),
    postal_code = nullif(btrim(p_postal), ''), province = nullif(btrim(p_province), ''),
    property_type = nullif(p_property, ''), water_notes = nullif(btrim(p_water), ''),
    install_notes = nullif(btrim(p_install), ''), updated_at = now()
  where id = p_id;
end;
$$;
revoke execute on function public.update_lead_profile(uuid, text, text, text, text, text, text, text) from public, anon;
grant execute on function public.update_lead_profile(uuid, text, text, text, text, text, text, text) to authenticated;

-- Listas permitidas: servicio «presupuestos» y módulo «catalogo».
alter table public.clients drop constraint clients_services_check,
  add constraint clients_services_check check ((services <@ array['agentes','web','software','impresoras','presupuestos']) and cardinality(services) > 0);
alter table public.profiles drop constraint profiles_modules_check,
  add constraint profiles_modules_check check (modules is null or modules <@ array['resumen','resumen_temas','resumen_clientes','actividad','act_conversaciones','act_mensajes','act_leads','act_derivaciones','act_citas','act_avisos','calendarios','avisar','redes','impresoras','impresoras_precios','catalogo']);
