// Clientes: las personas que ya han comprado (contactos cerrados). Cada negocio las mete a mano o con el botón
// «Pasar a clientes» de la ficha de un contacto cerrado. Tabla `customers` (única por teléfono dentro del negocio).
import { db, session } from './app.js';
import { h, q, table, modal, field, toast, errorText, fmtDate } from './ui.js';
import { attachAddress } from './address.js';

const plain = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const normPhone = (t) => {
  const d = String(t || '').replace(/\D/g, '');
  return /^(0034|34)\d{9}$/.test(d) ? d.replace(/^(0034|34)/, '') : d;
};
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export async function customersView() {
  const clientId = session.client.id;
  let rows = [];
  let search = '';
  const box = h('div', {});
  const count = h('span', { class: 'count' }, '');

  async function load() {
    rows = await q(db.from('customers').select('*').eq('client_id', clientId).order('name').limit(5000));
    paint();
  }

  function paint() {
    const term = plain(search).trim();
    const list = rows.filter((r) => !term || plain([r.name, r.phone, r.email, r.town, r.province, r.equipment].join(' ')).includes(term));
    count.textContent = term ? `${list.length} de ${rows.length}` : rows.length;
    box.replaceChildren(table([
      { label: 'Cliente', primary: true, cell: (r) => h('div', {}, h('b', {}, r.name || '—'), h('div', { class: 'muted small' }, [r.phone, r.email].filter(Boolean).join(' · '))) },
      { label: 'Dónde', hideM: true, cell: (r) => [r.town, r.province].filter(Boolean).join(' · ') || '—' },
      { label: 'Equipo instalado', hideM: true, hideT: true, cell: (r) => h('span', { class: 'clip', title: r.equipment || '' }, r.equipment || '—') },
      { label: 'Instalado', hideM: true, hideT: true, nowrap: true, cell: (r) => (r.installed_at ? fmtDate(r.installed_at) : '—') },
      { label: 'Último mantenimiento', hideM: true, hideL: true, nowrap: true, cell: (r) => (r.last_maintenance_at ? fmtDate(r.last_maintenance_at) : '—') },
    ], list, {
      empty: rows.length ? 'Ningún cliente coincide con la búsqueda.' : 'Todavía no hay clientes. Cuando cierres una venta, pásala a Clientes desde su ficha, o añade uno a mano.',
      onRow: (r) => openCustomer(r, { onSaved: load }),
    }));
  }

  const find = h('input', { type: 'search', placeholder: 'Buscar por nombre, teléfono, población…', 'aria-label': 'Buscar clientes', oninput: (e) => { search = e.target.value; paint(); } });
  const page = h('div', { class: 'page customers' },
    h('div', { class: 'section-head' }, h('h1', {}, 'Clientes'), count,
      h('button', { class: 'btn primary', type: 'button', onclick: () => openCustomer(null, { onSaved: load }) }, 'Añadir cliente')),
    h('p', { class: 'muted' }, 'Las personas que ya son clientes tuyos. Aquí quedan su dirección, el equipo que tienen instalado y cuándo fue su último mantenimiento.'),
    h('div', { class: 'lead-controls' }, h('label', { class: 'field inline grow' }, h('span', {}, 'Buscar'), find)),
    box);
  await load();
  return page;
}

// Ficha de un cliente (o alta nueva con c = null).
export function openCustomer(c, { onSaved = () => {} } = {}) {
  const isNew = !c;
  const v = c || {};
  const text = (name, label, extra = {}) => field(label, h('input', { name, value: v[name] ?? '', ...extra }));
  const date = (name, label) => field(label, h('input', { name, type: 'date', value: v[name] || '' }));
  const error = h('p', { class: 'error' });
  const save = h('button', { class: 'btn primary', type: 'submit' }, isNew ? 'Añadir cliente' : 'Guardar');
  const maintenance = h('button', { class: 'btn soft', type: 'button', onclick: () => { form.elements.last_maintenance_at.value = today(); } }, 'Mantenimiento hecho hoy');
  const form = h('form', { class: 'form', onsubmit: submit },
    text('name', 'Nombre y apellidos', { required: true }),
    h('div', { class: 'grid2' }, text('phone', 'Teléfono', { required: true, inputmode: 'tel' }), text('email', 'Correo', { type: 'email' })),
    text('address', 'Dirección'),
    h('div', { class: 'grid3' }, text('town', 'Población'), text('postal_code', 'Código postal', { inputmode: 'numeric' }), text('province', 'Provincia')),
    field('Equipo instalado', h('textarea', { name: 'equipment', rows: 2, placeholder: 'Qué equipo tiene y cómo se instaló' }, v.equipment || '')),
    h('div', { class: 'grid2' }, date('installed_at', 'Fecha de instalación'), date('last_maintenance_at', 'Último mantenimiento')),
    h('div', {}, maintenance),
    field('Notas', h('textarea', { name: 'notes', rows: 3, placeholder: 'Averías, avisos, lo que haya que recordar…' }, v.notes || '')),
    error,
    h('div', { class: 'row-actions' }, save,
      isNew ? null : h('button', { class: 'btn link danger', type: 'button', onclick: remove }, 'Quitar de clientes')));

  attachAddress(form);
  const close = modal(isNew ? 'Nuevo cliente' : (v.name || 'Cliente'), form, { wide: true });

  async function submit(e) {
    e.preventDefault();
    error.textContent = '';
    const f = new FormData(form);
    const g = (k) => String(f.get(k) ?? '').trim() || null;
    const phone = normPhone(g('phone'));
    if (!/^\d{9}$/.test(phone) && !/^\+?\d{10,15}$/.test(String(g('phone') || '').replace(/\s/g, ''))) {
      error.textContent = 'Revisa el teléfono: un móvil o fijo español tiene 9 cifras.';
      return;
    }
    const row = {
      name: g('name'), phone: /^\d{9}$/.test(phone) ? phone : String(g('phone')).replace(/\s/g, ''), email: g('email'), address: g('address'),
      town: g('town'), postal_code: g('postal_code'), province: g('province'), equipment: g('equipment'),
      installed_at: g('installed_at'), last_maintenance_at: g('last_maintenance_at'), notes: g('notes'),
    };
    save.disabled = true;
    try {
      if (isNew) await q(db.from('customers').insert({ ...row, client_id: session.client.id }));
      else await q(db.from('customers').update(row).eq('id', c.id));
      toast(isNew ? 'Cliente añadido' : 'Guardado');
      close();
      onSaved();
    } catch (err) {
      error.textContent = /duplicate|unique/i.test(String(err.message || err))
        ? 'Ya hay un cliente con ese teléfono.' : errorText(err);
      save.disabled = false;
    }
  }

  async function remove() {
    if (!confirm(`¿Quitar a ${v.name || 'este cliente'} de Clientes? El contacto y sus notas no se borran.`)) return;
    try {
      await q(db.from('customers').delete().eq('id', c.id));
      toast('Quitado de clientes');
      close();
      onSaved();
    } catch (err) { error.textContent = errorText(err); }
  }
}
