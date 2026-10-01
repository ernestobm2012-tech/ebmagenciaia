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

export function modal(title, body, { wide = false } = {}) {
  const close = () => overlay.remove();
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
export function table(columns, rows, { empty = 'Todavía no hay datos.', onRow } = {}) {
  if (!rows.length) return h('p', { class: 'empty' }, empty);
  return h('div', { class: 'table-wrap' },
    h('table', {},
      h('thead', {}, h('tr', {}, columns.map((c) => h('th', { class: c.num ? 'num' : null }, c.label)))),
      h('tbody', {}, rows.map((row) =>
        h('tr', { class: onRow ? 'clickable' : null, onclick: onRow ? () => onRow(row) : null },
          columns.map((c) => h('td', { class: c.num ? 'num' : null }, c.cell(row))))))));
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
