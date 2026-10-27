-- Fotos de la carpeta de Drive de un cliente a su web (almacén público site-media).
-- Se inserta una fila por SQL (solo administración) y el trigger avisa a la función
-- google-drive (?action=import), que procesa esa fila una sola vez: busca cada archivo
-- por nombre en la carpeta indicada, lo copia a site-media/<client_id>/<nombre> y, si
-- se pide, lo publica en la galería (site_media). El resultado queda en status/result.
-- Sirve para no tener que pasar las fotos por el móvil: lo que esté en Drive llega a la web.

create table public.drive_imports (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references public.clients (id) on delete cascade,
  folder_id  text not null,
  -- [{ "name": "trabajo-1.jpg", "title": "Recogido de novia", "category": "Recogidos", "sort": 1, "publish": true }]
  items      jsonb not null check (jsonb_typeof(items) = 'array'),
  status     text not null default 'pending' check (status in ('pending', 'working', 'done', 'error')),
  result     jsonb,
  created_at timestamptz not null default now()
);
alter table public.drive_imports enable row level security;
revoke all on public.drive_imports from anon, authenticated;

create function private.drive_import_event() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform net.http_post(
    url := 'https://rhjbpkaesobsbnkvioyh.supabase.co/functions/v1/google-drive?action=import',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := jsonb_build_object('job_id', new.id),
    timeout_milliseconds := 120000
  );
  return new;
end;
$$;

create trigger drive_import after insert on public.drive_imports
  for each row execute function private.drive_import_event();
