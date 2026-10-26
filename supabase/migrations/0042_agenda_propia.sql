-- Acceso propio para cada empleada de un negocio (primero, Henko Peluquería): con
-- profiles.agenda_scope = 'own' la persona solo ve su agenda (los calendarios de la
-- ficha de equipo enlazada a su usuario, team_members.profile_id), las citas de esas
-- agendas y los clientes que tienen cita con ella. Puede crear, mover y anular sus
-- citas y dar de alta clientes, pero no tocar servicios, equipo, fotos ni textos de la
-- web. La dueña sigue con 'all' (todo su negocio). Se hace con políticas RESTRICTIVE,
-- que se suman a las own_or_admin que ya había sin cambiarlas.
-- Además, cada cliente del negocio puede tener su profesional habitual.

alter table public.profiles
  add column agenda_scope text not null default 'all' check (agenda_scope in ('all', 'own'));

alter table public.customers
  add column preferred_member_id uuid references public.team_members (id) on delete set null;

create function private.is_staff_only() returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((select p.role = 'client' and p.agenda_scope = 'own'
                   from public.profiles p where p.id = (select auth.uid())), false);
$$;

create function private.my_calendar_ids() returns uuid[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(c.id), '{}')
  from public.calendars c
  join public.team_members t on t.id = c.member_id
  where t.profile_id = (select auth.uid()) and t.active;
$$;

-- Agendas: la empleada solo ve las suyas y no crea, cambia ni borra calendarios.
create policy staff_own_read on public.calendars as restrictive for select to authenticated
  using (not (select private.is_staff_only()) or id = any ((select private.my_calendar_ids())::uuid[]));
create policy staff_no_insert on public.calendars as restrictive for insert to authenticated
  with check (not (select private.is_staff_only()));
create policy staff_no_update on public.calendars as restrictive for update to authenticated
  using (not (select private.is_staff_only()));
create policy staff_no_delete on public.calendars as restrictive for delete to authenticated
  using (not (select private.is_staff_only()));

-- Citas: solo las de sus agendas (verlas, crearlas, moverlas y anularlas).
create policy staff_own_events on public.calendar_events as restrictive for all to authenticated
  using (not (select private.is_staff_only()) or calendar_id = any ((select private.my_calendar_ids())::uuid[]))
  with check (not (select private.is_staff_only()) or calendar_id = any ((select private.my_calendar_ids())::uuid[]));

-- Clientes: ve los que tienen o han tenido cita con ella o la tienen de habitual;
-- puede dar de alta clientes nuevos y editar los suyos, pero no borrar.
create function private.staff_sees_customer(p_customer uuid, p_preferred uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.calendar_events e
                 where e.customer_id = p_customer and e.calendar_id = any ((select private.my_calendar_ids())::uuid[]))
      or exists (select 1 from public.team_members t
                 where t.id = p_preferred and t.profile_id = (select auth.uid()));
$$;
create policy staff_own_customers on public.customers as restrictive for select to authenticated
  using (not (select private.is_staff_only()) or (select private.staff_sees_customer(id, preferred_member_id)));
create policy staff_update_customers on public.customers as restrictive for update to authenticated
  using (not (select private.is_staff_only()) or (select private.staff_sees_customer(id, preferred_member_id)));
create policy staff_no_delete on public.customers as restrictive for delete to authenticated
  using (not (select private.is_staff_only()));

-- Servicios, fotos, textos de la web, tipos de cita y equipo: la empleada solo los lee.
do $$
declare t text;
begin
  foreach t in array array['services', 'site_media', 'site_settings', 'appointment_types', 'team_members']
  loop
    execute format('create policy staff_no_insert on public.%I as restrictive for insert to authenticated
      with check (not (select private.is_staff_only()))', t);
    execute format('create policy staff_no_update on public.%I as restrictive for update to authenticated
      using (not (select private.is_staff_only()))', t);
    execute format('create policy staff_no_delete on public.%I as restrictive for delete to authenticated
      using (not (select private.is_staff_only()))', t);
  end loop;
end $$;

-- Fotos de la web en el almacén: tampoco las sube ni las borra.
create policy site_media_staff_no_write on storage.objects as restrictive for insert to authenticated
  with check (bucket_id <> 'site-media' or not (select private.is_staff_only()));
create policy site_media_staff_no_update on storage.objects as restrictive for update to authenticated
  using (bucket_id <> 'site-media' or not (select private.is_staff_only()));
create policy site_media_staff_no_delete on storage.objects as restrictive for delete to authenticated
  using (bucket_id <> 'site-media' or not (select private.is_staff_only()));
