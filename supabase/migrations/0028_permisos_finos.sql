-- Permisos más finos por usuario: dentro de Resumen y de Actividad, el admin elige
-- qué partes ve cada persona. La base de datos también lo comprueba en las tablas
-- con datos sensibles (mensajes, contactos, derivaciones, citas y avisos).
alter table public.profiles drop constraint profiles_modules_check;
alter table public.profiles add constraint profiles_modules_check check (modules is null or modules <@ array[
  'resumen', 'resumen_temas', 'resumen_clientes',
  'actividad', 'act_conversaciones', 'act_mensajes', 'act_leads', 'act_derivaciones', 'act_citas', 'act_avisos',
  'calendarios', 'redes', 'impresoras', 'impresoras_precios'
]::text[]);

alter policy read_own_or_admin on public.messages
  using ((select private.is_admin()) or (client_id = any ((select private.my_client_ids())::uuid[]) and (select private.can_see('act_mensajes'))));
alter policy read_own_or_admin on public.leads
  using ((select private.is_admin()) or (client_id = any ((select private.my_client_ids())::uuid[]) and (select private.can_see('act_leads'))));
alter policy read_own_or_admin on public.handoffs
  using ((select private.is_admin()) or (client_id = any ((select private.my_client_ids())::uuid[]) and (select private.can_see('act_derivaciones'))));
alter policy read_own_or_admin on public.appointments
  using ((select private.is_admin()) or (client_id = any ((select private.my_client_ids())::uuid[]) and (select private.can_see('act_citas'))));
alter policy read_own_or_admin on public.notifications
  using ((select private.is_admin()) or (client_id = any ((select private.my_client_ids())::uuid[]) and (select private.can_see('act_avisos'))));
