-- Responsable del negocio: un usuario «client» que puede dar de alta a su equipo y elegir qué ve cada persona.
-- Solo un administrador de EBM puede marcarlo (profiles no tiene política de UPDATE para el propio usuario).
alter table public.profiles add column if not exists team_admin boolean not null default false;

-- Dos permisos nuevos para poder dejar ver «Clientes» y «Estadísticas» por separado.
alter table public.profiles drop constraint profiles_modules_check;
alter table public.profiles add constraint profiles_modules_check check (
  modules is null or modules <@ array['resumen','resumen_temas','resumen_clientes','actividad','act_conversaciones','act_mensajes','act_leads',
    'act_derivaciones','act_citas','act_avisos','calendarios','avisar','redes','impresoras','impresoras_precios','catalogo',
    'clientes','estadisticas']::text[]);

-- Quien ya veía los contactos conserva Clientes (antes iba con ellos); Estadísticas solo lo conservan los de DZZERO que ya la veían (resumen).
update public.profiles set modules = (select array_agg(distinct x) from unnest(modules || array['clientes']) x)
  where modules is not null and 'act_leads' = any(modules);
update public.profiles set modules = (select array_agg(distinct x) from unnest(modules || array['estadisticas']) x)
  where modules is not null and 'act_leads' = any(modules) and 'resumen' = any(modules);

update public.profiles set team_admin = true where email = 'o.lopez@dzzero.com';
