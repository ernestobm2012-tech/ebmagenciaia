-- Coste de cada respuesta de las demos de texto (Claude API), para verlo en el panel.
alter table public.demo_text_turns
  add column if not exists input_tokens integer not null default 0,
  add column if not exists output_tokens integer not null default 0,
  add column if not exists cost_usd numeric not null default 0;
