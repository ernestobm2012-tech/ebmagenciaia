-- Qué secciones del panel ve cada usuario que no es administrador (lo elige el admin en Usuarios).
-- null = todas las de su negocio. Las impresoras lo comprueban también en la base de datos.
alter table public.profiles add column modules text[]
  check (modules is null or modules <@ array['resumen','actividad','calendarios','redes','impresoras','impresoras_precios']::text[]);
comment on column public.profiles.modules is 'Módulos del panel que ve un usuario no admin. null = todos los de su negocio.';
grant update (modules) on public.profiles to authenticated;

create function private.can_see(p_module text) returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((select p.role = 'admin' or p.modules is null or p_module = any (p.modules)
                   from public.profiles p where p.id = (select auth.uid())), false);
$$;
grant execute on function private.can_see(text) to authenticated;

alter policy read_own_or_admin on public.printers
  using ((select private.is_admin()) or (client_id = any ((select private.my_client_ids())::uuid[]) and (select private.can_see('impresoras'))));
alter policy edit_own_or_admin on public.printers
  using ((select private.is_admin()) or (client_id = any ((select private.my_client_ids())::uuid[]) and (select private.can_see('impresoras_precios'))))
  with check ((select private.is_admin()) or (client_id = any ((select private.my_client_ids())::uuid[]) and (select private.can_see('impresoras_precios'))));
alter policy read_own_or_admin on public.printer_readings
  using ((select private.is_admin()) or (client_id = any ((select private.my_client_ids())::uuid[]) and (select private.can_see('impresoras'))));
alter policy read_own_or_admin on public.printer_events
  using ((select private.is_admin()) or (client_id = any ((select private.my_client_ids())::uuid[]) and (select private.can_see('impresoras'))));
