# EBM Agencia IA: contexto del proyecto

Dueño: Ernesto. Habla en español (tuteo), quiere respuestas directas y prácticas. Suele trabajar desde el móvil, así que conviene usar sesiones en la nube y no depender de su ordenador.

## Qué hay aquí

- Web pública de la agencia en GitHub Pages: https://ernestobm2012-tech.github.io/ebmagenciaia/ (HTML/CSS/JS sin build, supabase-js por CDN).
- `js/chat.js`: widget de chat embebible. Atributos `data-client`, `data-title`, `data-welcome`, `data-color`, `data-avatar`, `data-position="left"`, `data-bottom`. Llama a la Edge Function `chat`.
- `demo.html?cliente=<slug>&nombre=<Nombre>`: muestra el agente de cualquier cliente.
- `admin/`: panel (Supabase Auth) con clientes, agentes, conocimiento, conexiones, a quién avisar, código de instalación, gastos, actividad, costes, usuarios (roles client/partner/admin).
- `supabase/migrations/0001…0012` y `supabase/functions/` (`chat`, `learn-web`, `sync-voice`, `notify`, `calendar`, `google-calendar`). Las funciones se despliegan con el conector de Supabase pegando el archivo completo.

Ernesto autorizó hacer commits directamente a `main` y publicar en GitHub Pages en sus webs.

## Servicios

- Supabase, proyecto **ebm-agentes** (`rhjbpkaesobsbnkvioyh`). RLS multi-cliente por `client_id`; funciones auxiliares en el esquema `private`. Secretos (los pone Ernesto, nunca en el chat): `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`, `RESEND_API_KEY`.
- pg_cron: `sync-voice` y `retry-notifications` cada 5 min; `sync-calendars` cada 15 min.
- Calendarios (`calendars`, `calendar_events`): cada cliente crea los que quiera desde el panel (menú Calendarios o pestaña del cliente). Se sincronizan por iCal: se importa la dirección iCal secreta de Google/Outlook y se exporta con `calendar?feed=<token>`. El chat tiene la herramienta `consultar_agenda`, que solo ve horas ocupadas, nunca los títulos.
- Conexión directa con Google Calendar (como GHL), en la función `google-calendar`: OAuth y luego sincronización en los dos sentidos al momento. Del panel a Google va por el trigger de `calendar_events`, que encola en `google_outbox` y avisa con pg_net. De Google al panel va por canales watch, que se renuevan con el cron `google-calendar-maintain` cada 10 minutos. Los tokens están en `calendar_google` (sin acceso desde el panel). En Google, cada cita del panel usa como id su uuid sin guiones. Necesita los secretos `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET`; URI de redirección: `https://rhjbpkaesobsbnkvioyh.supabase.co/functions/v1/google-calendar`.
- Chat: Claude Haiku 4.5 por defecto, con un bucle de herramientas (`guardar_contacto`, `pasar_a_humano` con departamento, y conexiones GET dinámicas), un presupuesto mensual por cliente y un calendario de 35 días en el prompt.
- Agente telefónico en ElevenLabs: "EBM - Asistente telefónico" (`agent_8701m3wg0657eaxbzxk0m0n1s061`), voz Cristina, Haiku 4.5, recogida de nombre/contacto/motivo.
- Número de Zadarma +34 919 930 664 (3,40 €/mes), que estaba en verificación. Después: centralita, extensión, importar en ElevenLabs por SIP (pbx.zadarma.com, TCP) y desvío a `+34919930664@sip.rtc.elevenlabs.io:5060;transport=tcp`.
- Correo con Resend; remitente provisional `EBM Agencia IA <avisos@gestionmypadel.com>`.

## Clientes

- `ebm`: interno.
- `mi-pequeno-rincon`: agente "Claudia", color `#7C9A44`, a la izquierda, con consulta de disponibilidad (`agent_availability` en el proyecto de Supabase de MPR `ztsdkfwnqrlmsirfvoat`). Instalado en mipequenorincon.es (repo `Mi-peque-o-rincon`).
- `palmo`: en modo demo. Agente **"Sara"** con avatar de IA, color `#00a3e0`, catálogo de 1.964 productos (`buscar_producto`) y avisos por departamento. Instalado en https://ernestobm2012-tech.github.io/palmo/ (repo `palmo`). Palmo es cliente directo y también partner/revendedor con su propia marca (`parent_client_id`, `brand_*`): sus clientes finales no deben ver EBM en ningún sitio.

## Pendiente

- Activar Zadarma y conectar el número con ElevenLabs para hacer una prueba de llamada.
- Avatar de Claudia (foto de Beatriz que mandará Ernesto).
- Dominio propio: Pages, URLs del widget, Site URL de Supabase y dominio de Resend.
- Envío de avisos desde un buzón que dará Palmo para sus clientes finales, y marca del partner en los correos de `notify`.
- Crear el cliente OAuth en Google Cloud y poner los secretos (Ernesto, desde casa); después, probar a conectar la Agenda de Ernesto. Verificar la app en Google antes de dársela a clientes (requiere dominio y página de privacidad).
- Que el agente reserve citas en el calendario (ahora solo consulta). Conexión directa con Outlook (Microsoft Graph).
- El calendario "[prueba-interna] Festivos" (EBM) está apagado: falta borrarlo.
- Permisos de partner en el panel, CRM, transferencia de llamadas a una persona, botón para recargar el catálogo y páginas legales.

## Reglas

- Nunca pedir ni pegar claves o contraseñas en el chat; Ernesto las guarda él mismo en los secretos de Supabase.
- No pagar, no crear cuentas, no subir documentos de identidad.
- Los datos de prueba se marcan como `[prueba-interna]` y se borran al terminar. Al personal de Palmo no le llegan correos de prueba.
