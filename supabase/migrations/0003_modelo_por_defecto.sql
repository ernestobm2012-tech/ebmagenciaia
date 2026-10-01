-- Identificador de modelo sin fecha, como lo publica Anthropic.
alter table public.agents alter column model set default 'claude-haiku-4-5';
