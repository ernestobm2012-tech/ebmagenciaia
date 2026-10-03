-- Turnos de las demos de texto de la web. Desde ahora el texto no pasa por
-- ElevenLabs: la función demo-chat llama directamente a la API de Claude y
-- cuenta aquí cada respuesta para limitar el gasto.
create table if not exists public.demo_text_turns (
  id bigint generated always as identity primary key,
  day date not null,
  token_id text not null,
  created_at timestamptz not null default now()
);
create index if not exists demo_text_turns_day_idx on public.demo_text_turns (day);
create index if not exists demo_text_turns_token_idx on public.demo_text_turns (token_id);
alter table public.demo_text_turns enable row level security;
comment on table public.demo_text_turns is 'Turnos de las demos de texto de la web (función demo-chat). Solo accede el servidor.';
