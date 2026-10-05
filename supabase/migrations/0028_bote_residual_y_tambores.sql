-- Bote residual (tóner usado) y tambores de cada impresora, a partir de la tabla de consumibles.
alter table public.printers add column last_supplies jsonb;
comment on column public.printers.last_supplies is 'Bote residual y tambores: {"residuo": {"lleno": 0-100|null, "estado": "bien|casi_lleno|lleno|desconocido"}, "tambores": {"k":91,...}}';
