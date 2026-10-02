# Agentes de voz (ElevenLabs)

Instrucciones de los agentes telefónicos. `_base.txt` es la parte común (cómo hablar al teléfono); cada `.json` es el cuerpo con el que se creó el agente.

| Agente | ID en ElevenLabs | Voz prevista |
|---|---|---|
| Demo · Clínica Dental Sonrisas (Lucía) | agent_2101m3yte6h9f6xv8t1vete5mf6f | Sofia - Customer Support (2BJPFS2QZRUEpfkbclGy) |
| Demo · Estudio Nadia (Nadia) | agent_5101m3ytfp7defkaczw68cfd7a3n | Sofia - Natural Conversations (eZxqQzb5CuYo3Kl6EXfZ) |
| Palmo · Sara (teléfono) | agent_4501m3ytfr8mfn9shp2bvjqvx3g6 | Antea Agente comercial (kkwhMpkWKv52v80GNaks) |
| Demo · Restaurante La Alacena (Diego) | pendiente | Diego (WsvUasyBVDfzPhE0B6jC) |
| Demo · Talleres Ruiz (Javi) | pendiente | Milo (v4b4rQBhckrIsOHsrbub) |

Mientras no se añadan las voces de la biblioteca a la cuenta, los creados usan Cristina (dNjJKg63Fr5AXwIdkATa).
La Sara de teléfono usa la herramienta `buscar_producto` (tool_6101m3ytbffve5yah75zye46jadz), que llama al RPC `catalog_search` de Supabase, y está enlazada en `agents.voice_agent_id` de Palmo.
