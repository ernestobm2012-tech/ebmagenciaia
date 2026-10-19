-- Puesto libre para cada persona del equipo (Teleoperadora, Comercial, Instalador,
-- Fontanero…). `role` sigue diciendo qué hace con los contactos: 'llamadas' (los llama),
-- 'comercial' (se le pasan para cerrar) u 'otro' (instaladores, técnicos…: no entra en
-- los repartos de contactos).
alter table public.team_members drop constraint team_members_role_check,
  add constraint team_members_role_check check (role in ('llamadas', 'comercial', 'otro'));
alter table public.team_members add column job_title text;
