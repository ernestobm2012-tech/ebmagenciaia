// Documentos de cada cliente: propuestas, contratos y facturas en PDF.
// Se guardan en el almacén privado `client-docs` y solo los ve la administración.
import { db } from './app.js';
import { h, q, table, field, toast, errorText, fmtDate } from './ui.js';

const BUCKET = 'client-docs';
const KINDS = { propuesta: 'Propuesta', contrato: 'Contrato', factura: 'Factura', otro: 'Otro' };
const MAX_BYTES = 20 * 1024 * 1024;

const fmtSize = (n) => (n == null ? '—' : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

function safeName(name) {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]+/g, '_');
}

async function signedUrl(doc, download) {
  const { data, error } = await db.storage.from(BUCKET)
    .createSignedUrl(doc.storage_path, 300, download ? { download: `${safeName(doc.name)}.pdf` } : undefined);
  if (error) throw error;
  return data.signedUrl;
}

export async function documentsTab(clientId) {
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
        h('button', { class: 'btn link danger', type: 'button', onclick: () => remove(d) }, 'Borrar')) },
    ], docs, { empty: 'Todavía no hay documentos de este cliente.' }));
  }
  await load();

  wrap.append(
    h('p', { class: 'muted' }, 'Propuestas, contratos y facturas de este cliente. Solo los ve la administración; los enlaces para verlos caducan a los 5 minutos.'),
    list, form);
  return wrap;
}
