# EBM Agencia IA: contexto del proyecto

Dueño: Ernesto. Habla en español (tuteo), quiere respuestas directas y prácticas. Suele trabajar desde el móvil, así que conviene usar sesiones en la nube y no depender de su ordenador.

## Qué hay aquí

- Web pública de la agencia en GitHub Pages: https://ebmagenciaia.es/ (dominio propio con el archivo `CNAME`; también sigue en https://ernestobm2012-tech.github.io/ebmagenciaia/). HTML/CSS/JS sin build, supabase-js por CDN.
- `js/chat.js`: widget de chat embebible. Atributos `data-client`, `data-title`, `data-welcome`, `data-color`, `data-avatar`, `data-position="left"`, `data-bottom`. Llama a la Edge Function `chat`.
- `demo.html?cliente=<slug>&nombre=<Nombre>`: muestra el agente de cualquier cliente.
- Sección «Pruébalo» (`#demos`, `js/demos.js`): llamadas de voz desde el navegador a los cuatro agentes demo de ElevenLabs (Lucía, Nadia, Marta, Javi; ver `agentes-voz/README.md`). El número de Twilio para demos está pendiente de importar en ElevenLabs (lo hace Ernesto con sus credenciales).
- `admin/`: panel (Supabase Auth) con clientes (cada uno con `services`: agentes, web y/o software; las pestañas de agente solo salen si tiene agentes), agentes, conocimiento, conexiones, a quién avisar, código de instalación, gastos, actividad, costes, usuarios (roles client/partner/admin).
- `supabase/migrations/0001…0013` y `supabase/functions/` (`chat`, `learn-web`, `sync-voice`, `notify`, `calendar`, `google-calendar`). Las funciones se despliegan con el conector de Supabase pegando el archivo completo.

Ernesto autorizó hacer commits directamente a `main` y publicar en GitHub Pages en sus webs, y fusionar él mismo los pull requests de sus repositorios (Mi-peque-o-rincon, ebmagenciaia, palmo) sin pedir permiso cada vez.

## Servicios

- Supabase, proyecto **ebm-agentes** (`rhjbpkaesobsbnkvioyh`). RLS multi-cliente por `client_id`; funciones auxiliares en el esquema `private`. Secretos (los pone Ernesto, nunca en el chat): `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`, `RESEND_API_KEY`.
- pg_cron: `sync-voice` y `retry-notifications` cada 5 min; `sync-calendars` cada 15 min.
- Calendarios (`calendars`, `calendar_events`): cada cliente crea los que quiera desde el panel (menú Calendarios o pestaña del cliente). Se sincronizan por iCal: se importa la dirección iCal secreta de Google/Outlook y se exporta con `calendar?feed=<token>`. El chat tiene la herramienta `consultar_agenda`, que solo ve horas ocupadas, nunca los títulos.
- Conexión directa con Google Calendar (como GHL), en la función `google-calendar`: OAuth y luego sincronización en los dos sentidos al momento. Del panel a Google va por el trigger de `calendar_events`, que encola en `google_outbox` y avisa con pg_net. De Google al panel va por canales watch, que se renuevan con el cron `google-calendar-maintain` cada 10 minutos. Los tokens están en `calendar_google` (sin acceso desde el panel). En Google, cada cita del panel usa como id su uuid sin guiones. Necesita los secretos `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET`; URI de redirección: `https://rhjbpkaesobsbnkvioyh.supabase.co/functions/v1/google-calendar`.
- Chat: Claude Haiku 4.5 por defecto, con un bucle de herramientas (`guardar_contacto`, `pasar_a_humano` con departamento, y conexiones GET dinámicas), un presupuesto mensual por cliente y un calendario de 35 días en el prompt.
- Agente telefónico en ElevenLabs: "EBM - Asistente telefónico" (`agent_8701m3wg0657eaxbzxk0m0n1s061`), voz Cristina, Haiku 4.5, recogida de nombre/contacto/motivo.
- Número de Zadarma +34 919 930 664 (3,40 €/mes), activo. Es un número de pruebas, no está atado a Palmo (Palmo puede no seguir como cliente). Pendiente: importarlo en ElevenLabs como SIP trunk (sin autenticación, TCP, salida pbx.zadarma.com), asignarlo a un agente y, en Zadarma, el número → Servidor externo (SIP URI) = `+34919930664@sip.rtc.elevenlabs.io:5060;transport=tcp`. No guardar lo de Zadarma antes de importarlo en ElevenLabs.
- Twilio: el paquete regulatorio «Telefono probar agentes» está aprobado (02/10/2026) pero aún no hay número comprado; sería el de demos (importar en ElevenLabs y asignarlo a la Clínica Lucía).
- Correo con Resend; remitente provisional `EBM Agencia IA <avisos@gestionmypadel.com>`.

## Clientes

- `ebm`: interno.
- `gestionmypadel` y `lienzo-blanco`: páginas web propias de Ernesto (services `{web}`, sin cuota). Están para ver sus gastos.
- Dominios: gestionmypadel.com en Cloudflare (cuenta de Ernesto; 10,46 $/año; correo por Cloudflare); lienzoblanco.es en IONOS (cuenta de Beatriz; 1 €/mes + IVA); mipequenorincon.es en DonDominio (cuenta de Beatriz; 4,95 €/año + IVA). Gastos generales: Claude Pro (18 €/mes + IVA), Google AI Plus (1,99 €/mes hasta el 25/12/2026 y luego 4,99 €, con IVA), número de Zadarma. Resend, Supabase, GitHub y ElevenLabs en plan gratis; GoHighLevel, gratis por la formación.
- Los conectores de Gmail y Calendar están en ernestobm2012@gmail.com (antes en mipqrincon@gmail.com).
- `mi-pequeno-rincon` (agentes + web): agente "Claudia", color `#7C9A44`, a la izquierda, con consulta de disponibilidad (`agent_availability` en el proyecto de Supabase de MPR `ztsdkfwnqrlmsirfvoat`). Instalado en mipequenorincon.es (repo `Mi-peque-o-rincon`).
- `palmo`: en modo demo. Agente **"Sara"** con avatar de IA, color `#00a3e0`, catálogo de 1.964 productos (`buscar_producto`) y avisos por departamento. Instalado en https://ernestobm2012-tech.github.io/palmo/ (repo `palmo`). Palmo es cliente directo y también partner/revendedor con su propia marca (`parent_client_id`, `brand_*`): sus clientes finales no deben ver EBM en ningún sitio.

## Pendiente

- Número de Twilio para demos: el paquete regulatorio está aprobado pero falta comprar el número (Ernesto). Luego importarlo en ElevenLabs (Ernesto, con sus credenciales), asignarlo a la Clínica Lucía y pasarme solo el número para ponerlo en `.demo-phone[data-phone]` de la web.
- Zadarma +34 919 930 664 ya funciona con el agente de teléfono de Palmo (trunk SIP importado como «Palmo»; se puede reasignar). Repetir la llamada de prueba tras los últimos ajustes de Sara y comprobar el saludo y la voz entrecortada.
- Calendarios: crear el cliente OAuth en Google Cloud y poner `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET` en Supabase (Ernesto, desde el ordenador); después, conectar la Agenda de Ernesto y probar. Verificar la app en Google antes de dársela a clientes (ya hay dominio; falta página de privacidad). Actualizar la guía PPTX con «Conectar con Google».
- Dominio ebmagenciaia.es: Email Routing «Agregar registros faltantes», verificar el dominio en Resend (luego `NOTIFY_FROM` = avisos@ebmagenciaia.es) y añadirlo en Supabase Auth → URL Configuration.
- Google Search Console: propiedad verificada; falta enviar `sitemap.xml` y pedir la indexación de la portada.
- Palmo puede no seguir como cliente: confirmar con ellos que sus nombres y correos pueden salir en el agente (en especial vperez@).
- Conocimiento de fabricantes (Xerox, Lexmark, Kyocera…) para Sara: propuesto, sin hacer.
- Voces de pago (Diego, Antea): requieren plan Creator de ElevenLabs. Mientras, restaurante con Cristina.
- Avatar de Claudia (foto de Beatriz que mandará Ernesto).
- Envío de avisos desde un buzón que dará Palmo y marca del partner en los correos de `notify`.
- Que el agente reserve citas en el calendario (ahora solo consulta). Conexión directa con Outlook.
- Limpieza: calendario «[prueba-interna] Festivos» (EBM) y conversaciones de prueba por borrar.
- Panel de escritorio con más imagen (el móvil ya está rehecho), páginas legales, permisos de partner, CRM, transferencia de llamadas y botón para recargar el catálogo.

## Reglas

- Nunca pedir ni pegar claves o contraseñas en el chat; Ernesto las guarda él mismo en los secretos de Supabase.
- No pagar, no crear cuentas, no subir documentos de identidad.
- Los datos de prueba se marcan como `[prueba-interna]` y se borran al terminar. Al personal de Palmo no le llegan correos de prueba.
