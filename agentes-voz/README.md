# Agentes de voz (ElevenLabs)

Instrucciones de los agentes telefónicos. `_base.txt` es la parte común (cómo hablar al teléfono); cada `.json` es el cuerpo con el que se creó el agente.

| Agente | ID en ElevenLabs | Voz |
|---|---|---|
| Demo · Clínica Dental Sonrisas (Lucía) | agent_2101m3yte6h9f6xv8t1vete5mf6f | Sofia - Customer Support (2BJPFS2QZRUEpfkbclGy) |
| Demo · Estudio Nadia (Nadia) | agent_5101m3ytfp7defkaczw68cfd7a3n | Sofia - Natural Conversations (eZxqQzb5CuYo3Kl6EXfZ) |
| Palmo · Sara (teléfono) | agent_4501m3ytfr8mfn9shp2bvjqvx3g6 | Cristina (dNjJKg63Fr5AXwIdkATa); Antea es premium |
| Demo · Restaurante La Alacena (Marta) | agent_5101m3yvx1j2fe489r97yg42b1ky | Cristina (dNjJKg63Fr5AXwIdkATa); Diego es premium |
| Demo · Talleres Ruiz (Javi) | agent_9701m3yvwygvexrvekyp23sf9wkf | Milo (v4b4rQBhckrIsOHsrbub) |

Las voces Diego y Antea son premium (plan Creator), por eso no están. Los cuatro demos se pueden probar desde la web, en la sección «Pruébalo» (`js/demos.js`). Para mostrar un teléfono hay que rellenar `data-phone` en `.demo-phone`.
La Sara de teléfono usa la herramienta `buscar_producto` (tool_6101m3ytbffve5yah75zye46jadz), que llama al RPC `catalog_search` de Supabase, y está enlazada en `agents.voice_agent_id` de Palmo.

## Demos de texto de la web

Copias de los cuatro agentes de demo, con `conversation.text_only` activo, tope de 300 s, `auth.enable_auth`, 3 a la vez y 30 conversaciones al día. La web los abre desde el botón «Escribir a …» (chat en `js/demos.js`) y los autoriza `demo-token` con `mode: "text"` (3 chats por persona y día, 30 al día, 8 mensajes cada uno).

| Agente | ID |
|---|---|
| Demo texto · Clínica Dental Sonrisas (Lucía) | agent_3701m40awp7ve56vd8282v8annz2 |
| Demo texto · Estudio Nadia (Nadia) | agent_4001m40awq3nf5qtjd9ek5mehxs0 |
| Demo texto · Restaurante La Alacena (Marta) | agent_4601m40awr0gezr9pj4m0vkfat27 |
| Demo texto · Talleres Ruiz (Javi) | agent_3201m40awsbyef59dhptnhvedc67 |

Si cambias el prompt de un agente de voz, cambia también el de su copia de texto (y viceversa).

## Disponibilidad y fechas (arreglado el 03/10/2026)
Los agentes de demo daban huecos relativos («este viernes», «mañana») sin saber qué día era hoy y se contradecían. Ahora cada agente (voz y texto) tiene: la disponibilidad por día de la semana (se repite cada semana), `prompt.timezone = Europe/Madrid` (ElevenLabs le pasa la fecha y la hora de ahora) y un bloque «REGLAS PARA NO EQUIVOCARTE» (no contradecirse, ofrecer primero alternativas con el mismo número de personas, un hueco siempre con su día). Hay una prueba de simulación en ElevenLabs («Marta: sin contradicciones con la disponibilidad», `test_2001m40cnq5sey6tz9a56g1hmbrz`) que se puede lanzar con `agents_run_tests` tras tocar el prompt. `restaurante.txt` ya refleja el cambio; los demás negocios (clínica, peluquería y taller) están actualizados en ElevenLabs con huecos por día de la semana, y sus `.txt` siguen con la versión anterior.
