-- Demos de texto de la web: se cuentan aparte de las de voz.
alter table public.demo_calls add column kind text not null default 'voice' check (kind in ('voice', 'text'));
create index on public.demo_calls (day, kind, ip_hash);
