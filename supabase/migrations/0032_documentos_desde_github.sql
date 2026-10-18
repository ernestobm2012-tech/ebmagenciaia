-- Documentos que llegan solos al panel desde el repositorio privado
-- ebm-documentos: cada PDF de clientes/<slug>/<carpeta>/ lo manda una acción de
-- GitHub a la función `docs-ingest`, que lo guarda en `client-docs`.
-- `source_path` es su ruta en el repositorio: si el PDF cambia, se sustituye.
alter table public.client_documents add column source_path text unique;
