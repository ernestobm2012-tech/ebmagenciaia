-- Gastos fijos de la agencia. Con client_id son de ese cliente (su número, su
-- dominio); sin client_id son generales (suscripciones, herramientas).
-- El coste variable de la IA no va aquí: sale de usage_events.
create table public.expenses (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid references public.clients (id) on delete cascade,
  concept     text not null,
  provider    text,
  amount      numeric(10,2) not null check (amount >= 0),   -- sin IVA
  currency    text not null default 'EUR' check (currency in ('EUR', 'USD')),
  vat_pct     numeric(4,1) not null default 21 check (vat_pct between 0 and 100),
  period      text not null default 'monthly' check (period in ('monthly', 'annual', 'once')),
  start_date  date not null default current_date,
  end_date    date,
  notes       text,
  created_at  timestamptz not null default now()
);
create index on public.expenses (client_id);

alter table public.expenses enable row level security;
revoke all on public.expenses from anon;
grant select, insert, update, delete on public.expenses to authenticated;
create policy admin_all on public.expenses for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
