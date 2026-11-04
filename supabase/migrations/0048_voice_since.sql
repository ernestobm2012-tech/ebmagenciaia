-- Fecha desde la que sync-voice importa las llamadas de un agente de voz.
-- Sirve para limpiar las pruebas de un cliente sin que se vuelvan a importar.
alter table agents add column if not exists voice_since timestamptz;
