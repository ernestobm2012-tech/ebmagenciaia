// Utilidades de interfaz. Todo el texto se inserta como nodo de texto (nunca
// innerHTML): las conversaciones vienen de usuarios finales y no son de fiar.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'selected' || k === 'disabled') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// Ejecuta una consulta de Supabase y lanza si hay error.
export async function q(query) {
  const { data, error, count } = await query;
  if (error) throw error;
  return count != null && data == null ? count : data;
}

const dateFmt = new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const numFmt = new Intl.NumberFormat('es-ES');

export const fmtDate = (d) => (d ? dateFmt.format(new Date(d)) : '—');
export const fmtDateTime = (d) => (d ? dateTimeFmt.format(new Date(d)) : '—');
export const fmtNum = (n) => numFmt.format(Number(n) || 0);
export const fmtEur = (n) => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(Number(n) || 0);
export const fmtUsd = (n) => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'USD' }).format(Number(n) || 0);

export function monthStart(offset = 0) {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + offset, 1);
}

export function slugify(text) {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function toast(message, kind = 'ok') {
  const el = h('div', { class: `toast ${kind}`, role: 'status' }, message);
  document.body.append(el);
  setTimeout(() => el.remove(), 4000);
}

export function errorText(err) {
  return err?.message || String(err);
}

export function modal(title, body, { wide = false, onClose = null } = {}) {
  const close = () => {
    if (!overlay.isConnected) return;
    overlay.remove();
    if (onClose) onClose();
  };
  const overlay = h('div', { class: 'overlay', onclick: (e) => e.target === overlay && close() },
    h('div', { class: `modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true' },
      h('header', {}, h('h2', {}, title),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Cerrar', onclick: close }, '×')),
      h('div', { class: 'modal-body' }, body)));
  document.body.append(overlay);
  return close;
}

const STATUS_LABELS = {
  demo: 'Demo', active: 'Activo', paused: 'Pausado',
  open: 'Abierta', closed: 'Cerrada',
  new: 'Nuevo', pending: 'Pendiente', contacted: 'Contactado',
  sent: 'Enviado', failed: 'Fallido',
};

export function badge(status) {
  return h('span', { class: `badge ${status}` }, STATUS_LABELS[status] || status);
}

// columns: [{ label, cell: (row) => Node|string, num?: bool }]
export function table(columns, rows, { empty = 'Todavía no hay datos.', onRow, rowClass = null } = {}) {
  if (!rows.length) return h('p', { class: 'empty' }, empty);
  // En el móvil cada fila se convierte en una tarjeta (cards-m); «primary» marca la columna que hace de título.
  return h('div', { class: 'table-wrap cards-m' },
    h('table', {},
      h('thead', {}, h('tr', {}, columns.map((c) => h('th', { class: [c.num ? 'num' : '', c.hideM ? 'hide-m' : '', c.hideL ? 'hide-l' : '', c.hideT ? 'hide-t' : '', c.nowrap ? 'nw' : ''].join(' ').trim() || null }, c.label)))),
      h('tbody', {}, rows.map((row) =>
        h('tr', { class: [onRow ? 'clickable' : '', rowClass ? rowClass(row) : ''].join(' ').trim() || null, onclick: onRow ? () => onRow(row) : null },
          columns.map((c) => h('td', { class: [c.num ? 'num' : '', c.primary ? 'primary' : '', c.hideM ? 'hide-m' : '', c.hideL ? 'hide-l' : '', c.hideT ? 'hide-t' : '', c.nowrap ? 'nw' : ''].join(' ').trim() || null, 'data-label': c.label }, c.cell(row))))))));
}

export function kpi(label, value, hint) {
  return h('div', { class: 'kpi' },
    h('div', { class: 'kpi-label' }, label),
    h('div', { class: 'kpi-value' }, value),
    hint ? h('div', { class: 'kpi-hint' }, hint) : null);
}

export function field(label, control, hint) {
  return h('label', { class: 'field' }, h('span', {}, label), control,
    hint ? h('small', {}, hint) : null);
}

// tabs: [{ id, label, render: async () => Node }]
export function tabs(items) {
  const panel = h('div', { class: 'tab-panel' });
  const buttons = items.map((t) => h('button', { type: 'button', class: 'tab', onclick: () => select(t) }, t.label));
  async function select(t) {
    buttons.forEach((b, i) => b.classList.toggle('active', items[i] === t));
    panel.replaceChildren(h('p', { class: 'empty' }, 'Cargando…'));
    try {
      panel.replaceChildren(await t.render());
    } catch (err) {
      panel.replaceChildren(h('p', { class: 'error' }, errorText(err)));
    }
  }
  select(items[0]);
  return h('div', {}, h('div', { class: 'tabs' }, buttons), panel);
}

// Lee un formulario como objeto; los campos vacíos pasan a null.
export function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'number') out[el.name] = el.value === '' ? 0 : Number(el.value);
    else out[el.name] = el.value.trim() === '' ? null : el.value.trim();
  }
  return out;
}

// Iconos del menú y de los paneles. Son constantes de este archivo (nunca texto de usuarios).
const ICONS = {
  home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.5 7.2L4 20l1-4.5A8 8 0 1 1 21 12z"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>',
  cal: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  chart: '<path d="M4 20V4M4 20h16"/><path d="M8 16v-5M12 16V8M16 16v-8"/>',
  bell: '<path d="M6 17V11a6 6 0 0 1 12 0v6l2 2H4z"/><path d="M10 21h4"/>',
  share: '<circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.2 10.8l7.6-3.6M8.2 13.2l7.6 3.6"/>',
  print: '<path d="M7 9V4h10v5M7 17H4v-7h16v7h-3"/><rect x="7" y="14" width="10" height="6" rx="1"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/>',
  out: '<path d="M9 4H5v16h4M16 8l4 4-4 4M20 12H9"/>',
  box: '<path d="M3 7.5L12 3l9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5L12 12l9-4.5M12 12v9"/>',
  doc: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h7"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
};
export function icon(name, cls = 'i') {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('class', cls);
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = ICONS[name] || '';
  return el;
}
