// Documentos de cada cliente: propuestas, contratos y facturas en PDF.
// Se guardan en el almacén privado `client-docs` y solo los ve la administración.
// Cada documento se puede enviar por correo (función `mail`, desde ebermejo@ o info@)
// o por WhatsApp (en el móvil se comparte el PDF; en el ordenador, un enlace de 30 días).
import { db } from './app.js';
import { h, q, table, field, toast, errorText, fmtDate, modal } from './ui.js';

const BUCKET = 'client-docs';
const KINDS = { propuesta: 'Propuesta', contrato: 'Contrato', factura: 'Factura', otro: 'Otro' };
const MAX_BYTES = 20 * 1024 * 1024;

const fmtSize = (n) => (n == null ? '—' : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

function safeName(name) {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]+/g, '_');
}

const SHARE_SECONDS = 30 * 86_400;

async function signedUrl(doc, download, seconds = 300) {
  const { data, error } = await db.storage.from(BUCKET)
    .createSignedUrl(doc.storage_path, seconds, download ? { download: `${safeName(doc.name)}.pdf` } : undefined);
  if (error) throw error;
  return data.signedUrl;
}

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';
const docLabel = (doc) => doc.name.replace(/\s+\d{1,2}-\d{1,2}$/, '');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Texto plano a HTML de correo: un párrafo por bloque, saltos de línea dentro.
const toHtml = (text) => text.trim().split(/\n{2,}/)
  .map((p) => `<p style="margin:0 0 12px">${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
// Teléfono a formato de wa.me: solo cifras y, si son 9, con el 34 delante.
function waNumber(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  return d.length === 9 ? `34${d}` : d;
}

function whatsappDialog(doc, client) {
  const hello = firstName(client?.contact_name);
  const text = h('textarea', { rows: 8 },
    `Hola${hello ? `, ${hello}` : ''}. Te paso la ${docLabel(doc).toLowerCase().startsWith('propuesta') ? 'propuesta' : `«${docLabel(doc)}»`} que hemos hablado. Te la he mandado también por correo.\n\nCualquier duda me dices y lo vemos.\n\nUn saludo,\nErnesto`);
  const phone = h('input', { type: 'tel', placeholder: 'Opcional: 6XX XXX XXX', value: client?.contact_phone || '' });
  const error = h('p', { class: 'error' });
  const canShareFiles = !!(navigator.canShare && navigator.canShare({ files: [new File([''], 'a.pdf', { type: 'application/pdf' })] }));

  async function shareFile() {
    error.textContent = '';
    try {
      // Se copia el texto por si WhatsApp no lo pega solo junto al PDF.
      try { await navigator.clipboard.writeText(text.value); } catch { /* sin permiso: da igual */ }
      const blob = await (await fetch(await signedUrl(doc, false))).blob();
      const file = new File([blob], `${safeName(doc.name)}.pdf`, { type: 'application/pdf' });
      await navigator.share({ files: [file], text: text.value });
    } catch (err) {
      if (err?.name !== 'AbortError') error.textContent = errorText(err);
    }
  }
  async function openLink() {
    error.textContent = '';
    try {
      const url = await signedUrl(doc, false, SHARE_SECONDS);
      const msg = `${text.value}\n\n${docLabel(doc)} (PDF): ${url}`;
      const n = waNumber(phone.value);
      window.open(`https://wa.me/${n}?text=${encodeURIComponent(msg)}`, '_blank', 'noopener');
      if (n && n !== waNumber(client?.contact_phone)) {
        await db.from('clients').update({ contact_phone: phone.value.trim() }).eq('id', client.id);
        if (client) client.contact_phone = phone.value.trim();
      }
    } catch (err) {
      error.textContent = errorText(err);
    }
  }

  modal(`Enviar por WhatsApp · ${doc.name}`, h('div', { class: 'form' },
    field('Mensaje', text),
    canShareFiles
      ? h('p', { class: 'muted' }, 'En el móvil se abre el menú de compartir: elige WhatsApp Business y el contacto. Se envía el PDF con el mensaje (el texto también queda copiado, por si hay que pegarlo).')
      : field('Teléfono (opcional)', phone, 'Si lo dejas vacío, WhatsApp te deja elegir el contacto. Se envía un enlace al PDF que dura 30 días.'),
    error,
    h('div', { class: 'actions' },
      canShareFiles ? h('button', { class: 'btn primary', type: 'button', onclick: shareFile }, 'Compartir el PDF por WhatsApp') : null,
      h('button', { class: canShareFiles ? 'btn' : 'btn primary', type: 'button', onclick: openLink }, canShareFiles ? 'Enviar un enlace' : 'Abrir WhatsApp'))));
}

function emailDialog(doc, client) {
  const hello = firstName(client?.contact_name);
  const to = h('input', { type: 'email', required: true, value: client?.contact_email || '' });
  const subject = h('input', { required: true, value: `${docLabel(doc)} · EBM Agencia IA` });
  const body = h('textarea', { rows: 9 },
    `Hola${hello ? `, ${hello}` : ''}:\n\nTe adjunto ${docLabel(doc).toLowerCase().startsWith('propuesta') ? 'la propuesta' : `«${docLabel(doc)}»`} que hemos hablado.\n\nCualquier duda me llamas o me escribes cuando quieras.\n\nUn saludo,`);
  const account = h('select', {}, h('option', { value: 'ebermejo' }, 'ebermejo@ebmagenciaia.es'), h('option', { value: 'info' }, 'info@ebmagenciaia.es'));
  const error = h('p', { class: 'error' });
  const send = h('button', { class: 'btn primary', type: 'submit' }, 'Enviar con el PDF adjunto');
  let close = () => {};

  async function submit(ev) {
    ev.preventDefault();
    error.textContent = '';
    send.disabled = true;
    try {
      const [row] = await q(db.from('outgoing_mail').insert({
        account: account.value, mode: 'send', to_addr: to.value.split(/[,;\s]+/).filter(Boolean),
        subject: subject.value.trim(), body_html: toHtml(body.value), document_ids: [doc.id], client_id: client?.id ?? null,
      }).select('id'));
      // La función lo envía en unos segundos; se espera un poco para decir cómo ha ido.
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        const [st] = await q(db.from('outgoing_mail').select('status, error').eq('id', row.id));
        if (st?.status === 'done') { toast('Correo enviado.'); close(); return; }
        if (st?.status === 'error') throw new Error(st.error || 'No se pudo enviar.');
      }
      toast('El correo está saliendo. Lo verás en Enviados.');
      close();
    } catch (err) {
      error.textContent = errorText(err);
      send.disabled = false;
    }
  }

  close = modal(`Enviar por correo · ${doc.name}`, h('form', { class: 'form', onsubmit: submit },
    h('div', { class: 'grid2' }, field('Para', to, 'Varias direcciones, separadas por comas.'), field('Desde', account)),
    field('Asunto', subject),
    field('Mensaje', body, 'Se añade tu firma y el PDF adjunto.'),
    error,
    h('div', { class: 'actions' }, send)));
}

export async function documentsTab(clientId) {
  const [client] = await q(db.from('clients').select('id, name, contact_name, contact_email, contact_phone').eq('id', clientId));
  const wrap = h('div', {});
  const note = h('p', { class: 'error' });
  const fileInput = h('input', { type: 'file', name: 'file', accept: 'application/pdf', required: true });
  const nameInput = h('input', { name: 'name', placeholder: 'Propuesta agentes de IA · octubre 2026' });
  const kindSelect = h('select', { name: 'kind' }, Object.entries(KINDS).map(([v, l]) => h('option', { value: v }, l)));
  const uploadBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Subir PDF');

  fileInput.addEventListener('change', () => {
    const f = fileInput.files[0];
    if (f && !nameInput.value) nameInput.value = f.name.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ');
  });

  const form = h('form', { class: 'form doc-card', onsubmit: upload },
    h('h3', {}, 'Guardar un documento'),
    h('div', { class: 'grid2' },
      field('Archivo PDF', fileInput, 'Hasta 20 MB.'),
      field('Tipo', kindSelect),
      field('Nombre', nameInput, 'Cómo aparecerá en la lista.')),
    h('div', { class: 'actions' }, uploadBtn), note);

  async function upload(ev) {
    ev.preventDefault();
    note.textContent = '';
    const file = fileInput.files[0];
    if (!file) return;
    if (file.type && file.type !== 'application/pdf') { note.textContent = 'Solo se pueden subir PDF.'; return; }
    if (file.size > MAX_BYTES) { note.textContent = 'El PDF pasa de 20 MB.'; return; }
    const name = nameInput.value.trim() || file.name.replace(/\.pdf$/i, '');
    const path = `${clientId}/${crypto.randomUUID()}-${safeName(file.name)}`;
    uploadBtn.disabled = true;
    try {
      const { error } = await db.storage.from(BUCKET).upload(path, file, { contentType: 'application/pdf' });
      if (error) throw error;
      try {
        await q(db.from('client_documents').insert({
          client_id: clientId, name, kind: kindSelect.value, storage_path: path, size_bytes: file.size,
        }));
      } catch (err) {
        await db.storage.from(BUCKET).remove([path]);
        throw err;
      }
      toast('Documento guardado.');
      form.reset();
      await load();
    } catch (err) {
      note.textContent = errorText(err);
    } finally {
      uploadBtn.disabled = false;
    }
  }

  async function open(doc, download) {
    try {
      const url = await signedUrl(doc, download);
      if (download) location.href = url;
      else window.open(url, '_blank', 'noopener');
    } catch (err) {
      toast(errorText(err), 'error');
    }
  }

  async function remove(doc) {
    if (!confirm(`¿Borrar «${doc.name}»? No se puede deshacer.`)) return;
    try {
      const { error } = await db.storage.from(BUCKET).remove([doc.storage_path]);
      if (error) throw error;
      await q(db.from('client_documents').delete().eq('id', doc.id));
      toast('Documento borrado.');
      await load();
    } catch (err) {
      toast(errorText(err), 'error');
    }
  }

  const list = h('div', {});
  async function load() {
    const docs = await q(db.from('client_documents').select('*').eq('client_id', clientId).order('created_at', { ascending: false }));
    list.replaceChildren(table([
      { label: 'Documento', cell: (d) => h('button', { class: 'btn link', type: 'button', onclick: () => open(d, false) }, d.name) },
      { label: 'Tipo', cell: (d) => KINDS[d.kind] || d.kind },
      { label: 'Fecha', cell: (d) => fmtDate(d.created_at) },
      { label: 'Tamaño', cell: (d) => fmtSize(d.size_bytes), num: true },
      { label: '', cell: (d) => h('span', {},
        h('button', { class: 'btn link', type: 'button', onclick: () => open(d, true) }, 'Descargar'), ' · ',
        h('button', { class: 'btn link', type: 'button', onclick: () => whatsappDialog(d, client) }, 'WhatsApp'), ' · ',
        h('button', { class: 'btn link', type: 'button', onclick: () => emailDialog(d, client) }, 'Correo'), ' · ',
        h('button', { class: 'btn link danger', type: 'button', onclick: () => remove(d) }, 'Borrar')) },
    ], docs, { empty: 'Todavía no hay documentos de este cliente.' }));
  }
  await load();

  wrap.append(
    h('p', { class: 'muted' }, 'Propuestas, contratos y facturas de este cliente. Solo los ve la administración. Desde aquí puedes enviar cada uno por WhatsApp o por correo.'),
    list, form);
  return wrap;
}
