-- «A quién avisar» también para clientes y partners con el permiso «avisar»:
-- ven y gestionan las personas de aviso de sus negocios.
alter table public.profiles drop constraint profiles_modules_check;
alter table public.profiles add constraint profiles_modules_check check (modules is null or modules <@ array[
  'resumen', 'resumen_temas', 'resumen_clientes',
  'actividad', 'act_conversaciones', 'act_mensajes', 'act_leads', 'act_derivaciones', 'act_citas', 'act_avisos',
  'calendarios', 'avisar', 'redes', 'impresoras', 'impresoras_precios'
]::text[]);

alter policy read_own_or_admin on public.notify_contacts
  using ((select private.is_admin()) or (client_id = any ((select private.my_client_ids())::uuid[]) and (select private.can_see('avisar'))));
alter policy admin_insert on public.notify_contacts
  with check ((select private.is_admin()) or (client_id = any ((select private.my_client_ids())::uuid[]) and (select private.can_see('avisar'))));
alter policy admin_update on public.notify_contacts
  using ((select private.is_admin()) or (client_id = any ((select private.my_client_ids())::uuid[]) and (select private.can_see('avisar'))))
  with check ((select private.is_admin()) or (client_id = any ((select private.my_client_ids())::uuid[]) and (select private.can_see('avisar'))));
alter policy admin_delete on public.notify_contacts
  using ((select private.is_admin()) or (client_id = any ((select private.my_client_ids())::uuid[]) and (select private.can_see('avisar'))));
