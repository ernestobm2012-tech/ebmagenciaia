-- Ficha de llamada de DZZERO (07/11/2026): los mismos datos que la ficha en papel que usan sus teleoperadoras.
alter table public.leads
  add column if not exists client_ref text,          -- Nº cliente
  add column if not exists town text,                -- población
  add column if not exists nationality text,
  add column if not exists family_members smallint,
  add column if not exists children_at_home smallint,
  add column if not exists children_ages text,
  add column if not exists visit_at timestamptz,     -- día y hora de la visita
  add column if not exists machine_interest text,    -- con_instalacion | sin_instalacion
  add column if not exists drinks text[],            -- embotellada | grifo | filtrada | aquaservice
  add column if not exists observations text,        -- observaciones de la llamada / visita
  add column if not exists reconfirmation text;

-- Un solo punto de entrada para guardar la ficha (mismo permiso que update_lead_profile).
-- Solo cambia los campos que llegan en p_data.
create or replace function public.update_lead_ficha(p_id uuid, p_data jsonb)
returns void language plpgsql security definer set search_path = '' as $f$
declare v_client uuid;
begin
  select client_id into v_client from public.leads where id = p_id;
  if v_client is null or not (select private.can_manage_leads(v_client)) then
    raise exception 'No tienes acceso a este contacto.';
  end if;
  update public.leads set
    name = case when p_data ? 'name' then nullif(btrim(p_data->>'name'), '') else name end,
    contact = case when p_data ? 'contact' then nullif(btrim(p_data->>'contact'), '') else contact end,
    email = case when p_data ? 'email' then nullif(btrim(p_data->>'email'), '') else email end,
    address = case when p_data ? 'address' then nullif(btrim(p_data->>'address'), '') else address end,
    town = case when p_data ? 'town' then nullif(btrim(p_data->>'town'), '') else town end,
    postal_code = case when p_data ? 'postal_code' then nullif(btrim(p_data->>'postal_code'), '') else postal_code end,
    nationality = case when p_data ? 'nationality' then nullif(btrim(p_data->>'nationality'), '') else nationality end,
    province = case when p_data ? 'province' then nullif(btrim(p_data->>'province'), '') else province end,
    client_ref = case when p_data ? 'client_ref' then nullif(btrim(p_data->>'client_ref'), '') else client_ref end,
    family_members = case when p_data ? 'family_members' then nullif(btrim(p_data->>'family_members'), '')::smallint else family_members end,
    children_at_home = case when p_data ? 'children_at_home' then nullif(btrim(p_data->>'children_at_home'), '')::smallint else children_at_home end,
    children_ages = case when p_data ? 'children_ages' then nullif(btrim(p_data->>'children_ages'), '') else children_ages end,
    visit_at = case when p_data ? 'visit_at' then nullif(p_data->>'visit_at', '')::timestamptz else visit_at end,
    machine_interest = case when p_data ? 'machine_interest' then nullif(p_data->>'machine_interest', '') else machine_interest end,
    drinks = case when p_data ? 'drinks' then array(select jsonb_array_elements_text(p_data->'drinks')) else drinks end,
    observations = case when p_data ? 'observations' then nullif(btrim(p_data->>'observations'), '') else observations end,
    reconfirmation = case when p_data ? 'reconfirmation' then nullif(btrim(p_data->>'reconfirmation'), '') else reconfirmation end,
    property_type = case when p_data ? 'property_type' then nullif(p_data->>'property_type', '') else property_type end,
    updated_at = now()
  where id = p_id;
end $f$;
revoke all on function public.update_lead_ficha(uuid, jsonb) from public, anon;
grant execute on function public.update_lead_ficha(uuid, jsonb) to authenticated;
