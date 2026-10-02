-- Qué le hace EBM a cada cliente: agentes de IA, página web, software (o varios).
-- El panel muestra solo las pestañas de lo que tiene contratado.
alter table public.clients
  add column services text[] not null default '{agentes}'
  check (services <@ array['agentes', 'web', 'software']::text[] and cardinality(services) > 0);
