-- El agente elige a qué persona de "A quién avisar" debe llegar cada aviso.
-- Sin elección, se avisa a todas las personas activas del cliente.
alter table public.leads    add column notify_contact_id uuid references public.notify_contacts (id) on delete set null;
alter table public.handoffs add column notify_contact_id uuid references public.notify_contacts (id) on delete set null;
create index on public.leads (notify_contact_id);
create index on public.handoffs (notify_contact_id);
