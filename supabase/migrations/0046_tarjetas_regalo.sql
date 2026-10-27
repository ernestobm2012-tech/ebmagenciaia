-- Tarjetas regalo (primero, Henko): se reservan en la web y se pagan en el salón
-- (decisión de Ernesto, 27/10/2026: nada de pago online). Al reservarla, el salón recibe
-- un aviso y quien la compra un correo con el código; en el panel se marca como pagada
-- (desde ese día vale un año), se descuenta lo que se va gastando y se puede anular.
create table public.gift_cards (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null references public.clients (id) on delete cascade,
  code           text not null,
  amount         numeric(8,2) not null check (amount > 0),
  balance        numeric(8,2) not null check (balance >= 0),
  status         text not null default 'reservada' check (status in ('reservada', 'pagada', 'usada', 'anulada')),
  buyer_name     text not null,
  buyer_phone    text,
  buyer_email    text,
  recipient_name text,
  message        text,
  notes          text,
  source         text not null default 'web' check (source in ('web', 'panel')),
  paid_at        timestamptz,
  expires_at     date,
  created_at     timestamptz not null default now(),
  unique (client_id, code)
);
create index gift_cards_client on public.gift_cards (client_id, created_at desc);

alter table public.gift_cards enable row level security;
revoke all on public.gift_cards from anon, authenticated;
grant select, insert, update, delete on public.gift_cards to authenticated;
create policy own_or_admin on public.gift_cards for all to authenticated
  using ((select private.is_admin()) or client_id = any ((select private.my_client_ids())::uuid[]))
  with check ((select private.is_admin()) or client_id = any ((select private.my_client_ids())::uuid[]));
-- La empleada con agenda propia puede cobrarlas y descontarlas, pero no borrarlas.
create policy staff_no_delete on public.gift_cards as restrictive for delete to authenticated
  using (not (select private.is_staff_only()));

alter table public.message_log drop constraint message_log_kind_check;
alter table public.message_log add constraint message_log_kind_check
  check (kind in ('confirm', 'reminder', 'review', 'comeback', 'birthday', 'waitlist', 'gift'));
