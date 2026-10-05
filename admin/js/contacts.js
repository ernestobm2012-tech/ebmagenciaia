// «A quién avisar»: las personas a las que el agente puede mandar avisos.
// La usan el admin (ficha del cliente) y el cliente o partner si tiene el permiso «avisar».
import { db } from './app.js';
import { h, q, table, field, modal, toast, formData, errorText } from './ui.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Filas copiadas de Excel: nombre, departamento, correo, cuándo avisar.
function parsePasted(text) {
  const good = [];
  const bad = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [name, department, email, notify_when] = line.split('\t').map((s) => s.trim());
    if (name && EMAIL_RE.test(email || '')) good.push({ name, department: department || null, email, notify_when: notify_when || null });
    else bad.push(line);
  }
  return { good, bad };
}

export async function contactsTab(clientId) {
  const wrap = h('div', {});

  const remove = async (row) => {
    if (!confirm(`¿Quitar a ${row.name} de la lista de avisos?`)) return;
    try {
      await q(db.from('notify_contacts').delete().eq('id', row.id));
      load();
    } catch (err) {
      toast(errorText(err), 'error');
    }
  };

  const insert = async (rows) => {
    await q(db.from('notify_contacts').insert(rows.map((r) => ({ ...r, client_id: clientId }))));
    toast(rows.length === 1 ? 'Persona añadida.' : `${rows.length} personas añadidas.`);
    load();
  };

  const add = () => {
    const note = h('p', { class: 'error' });
    const form = h('form', { class: 'form', onsubmit: async (e) => {
      e.preventDefault();
      try { await insert([formData(form)]); close(); } catch (err) { note.textContent = errorText(err); }
    } },
      h('div', { class: 'grid2' },
        field('Nombre', h('input', { name: 'name', required: true })),
        field('Departamento', h('input', { name: 'department' })),
        field('Correo', h('input', { name: 'email', type: 'email', required: true }))),
      field('Cuándo se le avisa', h('textarea', { name: 'notify_when', rows: 2 }),
        'Ej.: "Presupuestos de reformas" o "Quejas y devoluciones". El agente decide con esto.'),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Añadir')), note);
    const close = modal('Añadir persona', form);
  };

  const paste = () => {
    const note = h('p', { class: 'error' });
    const area = h('textarea', { rows: 10, class: 'mono', placeholder: 'Nombre\tDepartamento\tCorreo\tCuándo avisar' });
    const go = async () => {
      const { good, bad } = parsePasted(area.value);
      if (!good.length) return (note.textContent = 'No he encontrado ninguna fila válida.');
      if (bad.length && !confirm(`${bad.length} fila(s) sin nombre o con correo incorrecto se van a omitir. ¿Importar las otras ${good.length}?`)) return;
      try { await insert(good); close(); } catch (err) { note.textContent = errorText(err); }
    };
    const close = modal('Pegar desde Excel', h('div', { class: 'form' },
      h('p', { class: 'muted' }, 'Copia las filas en Excel con las columnas en este orden: nombre, departamento, correo, cuándo avisar. Sin la fila de títulos.'),
      area,
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'button', onclick: go }, 'Importar')), note), { wide: true });
  };

  async function load() {
    const rows = await q(db.from('notify_contacts').select('*').eq('client_id', clientId).order('name'));
    wrap.replaceChildren(
      h('p', { class: 'muted' }, 'El agente solo puede avisar a las personas de esta lista. Nunca inventa correos.'),
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn primary', type: 'button', onclick: add }, 'Añadir persona'),
        h('button', { class: 'btn', type: 'button', onclick: paste }, 'Pegar desde Excel')),
      table([
        { label: 'Nombre', cell: (r) => r.name },
        { label: 'Departamento', cell: (r) => r.department || '—' },
        { label: 'Correo', cell: (r) => r.email },
        { label: 'Cuándo se le avisa', cell: (r) => r.notify_when || '—' },
        { label: '', cell: (r) => h('button', { class: 'btn link danger', type: 'button', onclick: () => remove(r) }, 'Quitar') },
      ], rows, { empty: 'Aún no hay nadie en la lista.' }));
  }
  await load();
  return wrap;
}

