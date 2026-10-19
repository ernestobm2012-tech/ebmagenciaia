-- Firma de Ernesto (EBM) para la hoja de aceptación de las propuestas firmadas.
-- PNG con fondo transparente en base64 (data:image/png;base64,…). Solo service_role.
create table public.app_assets (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);
alter table public.app_assets enable row level security;
revoke all on public.app_assets from anon, authenticated;
