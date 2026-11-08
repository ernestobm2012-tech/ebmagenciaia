-- 08/11/2026: averías como contactos, zona en código y palabras vetadas (aplicado con execute_sql; este archivo lo documenta).
alter table public.leads add column if not exists kind text;            -- 'averia' = cliente actual con una avería
alter table public.leads add column if not exists resolved_at timestamptz; -- cuándo se marcó atendida
alter table public.conversations add column if not exists zone text;     -- 'priority' | 'other' (la fija indicar_provincia)
alter table public.conversations add column if not exists qualified boolean not null default false;
alter table public.agents add column if not exists banned_phrases text[]; -- palabras que cleanReply cambia por «vale»
alter table public.agents add column if not exists zone_priority text[];  -- provincias prioritarias (activa la lógica de zona)

create or replace function public.lead_resolve_averia(p_id uuid, p_on boolean default true)
returns void language plpgsql security definer set search_path to '' as $$
declare v_client uuid;
begin
  select client_id into v_client from public.leads where id = p_id and kind = 'averia';
  if v_client is null or not (select private.can_manage_leads(v_client)) then
    raise exception 'No tienes acceso a esta avería.';
  end if;
  update public.leads set resolved_at = case when p_on then now() else null end, updated_at = now() where id = p_id;
end;
$$;
-- Laura (DZZERO): banned_phrases = perfecto, genial, estupendo, fantástico, excelente, tienes razón, muy bien, qué bien;
-- zone_priority = madrid, guadalajara, toledo, cuenca, albacete, murcia, alicante, valencia.
-- push_event / notify_event se actualizaron para avisar de una avería abierta (kind = 'averia') como «Avería».
