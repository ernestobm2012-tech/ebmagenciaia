/**
 * Facturas a Drive · EBM Agencia IA
 *
 * Cada hora busca en Gmail las facturas de los proveedores y las guarda en
 * Google Drive, en "Facturas EBM/AAAA/MM mes". Si el correo trae un PDF, guarda
 * el PDF; si la factura viene dentro del correo (sin adjunto), guarda el correo
 * convertido a PDF. Nunca guarda dos veces la misma.
 *
 * Instalación (una sola vez):
 *   1. script.google.com > Nuevo proyecto > pega este archivo > Guardar.
 *   2. Arriba elige la función "instalar" > Ejecutar > acepta los permisos.
 *   Listo: ya se ejecuta sola cada hora. Para probar al momento, ejecuta "guardarFacturas".
 *
 * Para añadir un proveedor nuevo: añádelo a PROVEEDORES (remitente y nombre).
 */

const CARPETA_RAIZ = 'Facturas EBM';
const DIAS_ATRAS = 120; // la primera vez recoge también las facturas de estos últimos días

// remitente (o parte del correo del remitente) -> nombre que se pone en el archivo
const PROVEEDORES = {
  'cloudflare.com': 'Cloudflare',
  'ionos.es': 'IONOS',
  'dondominio.com': 'DonDominio',
  'anthropic.com': 'Anthropic',
  'stripe.com': 'Anthropic API',
  'zadarma.com': 'Zadarma',
  'googleplay-noreply@google.com': 'Google',
  'payments-noreply@google.com': 'Google',
  'twilio.com': 'Twilio',
  'elevenlabs.io': 'ElevenLabs',
  'resend.com': 'Resend',
  'supabase.com': 'Supabase',
  'github.com': 'GitHub',
};

// Solo correos que son facturas o recibos (no publicidad del mismo proveedor).
const PALABRAS = '(factura OR invoice OR receipt OR recibo OR "recarga de la cuenta" OR "pedido de Google Play")';

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
  'septiembre', 'octubre', 'noviembre', 'diciembre'];

function instalar() {
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('guardarFacturas').timeBased().everyHours(1).create();
  guardarFacturas();
}

function guardarFacturas() {
  const hechas = PropertiesService.getUserProperties();
  const remitentes = Object.keys(PROVEEDORES).map((r) => `from:${r}`).join(' OR ');
  const consulta = `(${remitentes}) ${PALABRAS} newer_than:${DIAS_ATRAS}d`;
  const raiz = carpeta(DriveApp.getRootFolder(), CARPETA_RAIZ);
  let guardadas = 0;

  for (const hilo of GmailApp.search(consulta, 0, 200)) {
    for (const correo of hilo.getMessages()) {
      const id = correo.getId();
      if (hechas.getProperty(id)) continue;
      const proveedor = proveedorDe(correo.getFrom());
      if (!proveedor || !esFactura(correo)) {
        hechas.setProperty(id, 'no');
        continue;
      }

      const fecha = correo.getDate();
      const mes = carpeta(carpeta(raiz, String(fecha.getFullYear())),
        `${String(fecha.getMonth() + 1).padStart(2, '0')} ${MESES[fecha.getMonth()]}`);
      const dia = Utilities.formatDate(fecha, 'Europe/Madrid', 'yyyy-MM-dd');

      const pdfs = correo.getAttachments({ includeInlineImages: false })
        .filter((a) => a.getContentType() === 'application/pdf' || /\.pdf$/i.test(a.getName()));
      if (pdfs.length) {
        pdfs.forEach((a) => mes.createFile(a.copyBlob().setName(`${dia} ${proveedor} - ${limpio(a.getName())}`)));
      } else {
        // Sin adjunto: se guarda el propio correo como PDF.
        const html = `<h3>${escapar(correo.getSubject())}</h3><p>${escapar(correo.getFrom())} · ${dia}</p><hr>${correo.getBody()}`;
        const pdf = Utilities.newBlob(html, 'text/html', 'correo.html').getAs('application/pdf');
        mes.createFile(pdf.setName(`${dia} ${proveedor} - ${limpio(correo.getSubject())}.pdf`));
      }
      hechas.setProperty(id, 'si');
      guardadas++;
    }
  }
  console.log(`Facturas guardadas: ${guardadas}`);
}

function proveedorDe(from) {
  const f = from.toLowerCase();
  const clave = Object.keys(PROVEEDORES).find((r) => f.includes(r.toLowerCase()));
  return clave ? PROVEEDORES[clave] : null;
}

// Descarta avisos que no son cobros (bienvenidas, ofertas, "actualiza tu tarjeta"...).
function esFactura(correo) {
  const asunto = correo.getSubject().toLowerCase();
  if (/(bienvenid|welcome|oferta|descuento|update your card|actualiza|newsletter|novedades)/.test(asunto)) return false;
  return /(factura|invoice|receipt|recibo|recarga|pedido de google play)/.test(asunto + ' ' + correo.getPlainBody().slice(0, 600).toLowerCase());
}

function carpeta(padre, nombre) {
  const it = padre.getFoldersByName(nombre);
  return it.hasNext() ? it.next() : padre.createFolder(nombre);
}

const limpio = (s) => s.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
const escapar = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
