// Gastos fijos: los generales de la agencia (suscripciones, dominios) y los de
// cada cliente (su número, su dominio). El coste variable de la IA no se apunta
// aquí; sale solo de las conversaciones.
import { db } from './app.js';
import { USD_TO_EUR } from './config.js';
import { elevenUsageCard } from './usage.js';
import { h, q, table, field, modal, toast, kpi, formData, errorText, fmtDate, fmtEur } from './ui.js';

const PERIODS = { monthly: 'Mensual', annual: 'Anual', once: 'Pago único' };
const money = (n, currency) => new Intl.NumberFormat('es-ES', { style: 'currency', currency }).format(Number(n) || 0);

const today = () => new Date().toISOString().slice(0, 10);
export const isActive = (e) => e.start_date <= today() && (!e.end_date || e.end_date >= today());

// Lo que supone al mes, en euros y sin IVA. Los pagos únicos no cuentan como gasto mensual.
export function monthlyEur(e) {
  if (!isActive(e) || e.period === 'once') return 0;
  const eur = Number(e.amount) * (e.currency === 'USD' ? USD_TO_EUR : 1);
  return e.period === 'annual' ? eur / 12 : eur;
}
const withVat = (e) => monthlyEur(e) * (1 + Number(e.vat_pct) / 100);
const sum = (rows, fn) => rows.reduce((a, r) => a + fn(r), 0);

export const fetchExpenses = () => q(db.from('expenses').select('*, clients(name)').order('created_at'));

function expenseForm(expense, clients, fixedClientId, onSaved) {
  const e = expense || {};
  const note = h('p', { class: 'error' });
  const option = (value, label, selected) => h('option', { value, selected }, label);
  const form = h('form', { class: 'form', onsubmit: submit },
    h('div', { class: 'grid2' },
      field('Concepto', h('input', { name: 'concept', required: true, value: e.concept || '', placeholder: 'Dominio, suscripción, número…' })),
      field('Proveedor', h('input', { name: 'provider', value: e.provider || '' })),
      fixedClientId ? null : field('De quién es el gasto', h('select', { name: 'client_id' },
        option('', '— General de la agencia —', !e.client_id),
        clients.map((c) => option(c.id, c.name, e.client_id === c.id)))),
      field('Cada cuánto se paga', h('select', { name: 'period' },
        Object.entries(PERIODS).map(([v, l]) => option(v, l, (e.period || 'monthly') === v)))),
      field('Importe sin IVA', h('input', { name: 'amount', type: 'number', min: 0, step: '0.01', required: true, value: e.amount ?? '' }),
        'El de cada pago: al mes si es mensual, al año si es anual.'),
      field('Moneda', h('select', { name: 'currency' },
        option('EUR', 'Euros', (e.currency || 'EUR') === 'EUR'), option('USD', 'Dólares', e.currency === 'USD'))),
      field('IVA (%)', h('input', { name: 'vat_pct', type: 'number', min: 0, max: 100, step: '0.1', value: e.vat_pct ?? 21 }),
        'Pon 0 si el proveedor no te cobra IVA.'),
      field('Desde', h('input', { name: 'start_date', type: 'date', required: true, value: e.start_date || today() })),
      field('Hasta', h('input', { name: 'end_date', type: 'date', value: e.end_date || '' }), 'Vacío si sigue activo.')),
    field('Notas', h('textarea', { name: 'notes', rows: 2 }, e.notes || '')),
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', type: 'submit' }, expense ? 'Guardar' : 'Añadir gasto'),
      expense ? h('button', { class: 'btn link danger', type: 'button', onclick: remove }, 'Borrar') : null),
    note);

  async function submit(ev) {
    ev.preventDefault();
    try {
      const values = formData(form);
      values.end_date ||= null;
      if (fixedClientId) values.client_id = fixedClientId;
      else values.client_id ||= null;
      if (expense) await q(db.from('expenses').update(values).eq('id', expense.id));
      else await q(db.from('expenses').insert(values));
      toast('Gasto guardado.');
      onSaved();
    } catch (err) {
      note.textContent = errorText(err);
    }
  }
  async function remove() {
    if (!confirm(`¿Borrar el gasto "${expense.concept}"? Si solo ha terminado, mejor ponle fecha en "Hasta".`)) return;
    try {
      await q(db.from('expenses').delete().eq('id', expense.id));
      onSaved();
    } catch (err) {
      note.textContent = errorText(err);
    }
  }
  return form;
}

// clientId: muestra solo los gastos de ese cliente. Sin él, todos.
async function expensesView(clientId) {
  const wrap = h('div', {});
  const clients = clientId ? [] : await q(db.from('clients').select('id, name').order('name'));
  const edit = (expense) => {
    const close = modal(expense ? expense.concept : 'Nuevo gasto',
      expenseForm(expense, clients, clientId, () => { close(); load(); }), { wide: true });
  };

  async function load() {
    let rows = await fetchExpenses();
    if (clientId) rows = rows.filter((r) => r.client_id === clientId);
    const general = rows.filter((r) => !r.client_id);
    const ofClients = rows.filter((r) => r.client_id);
    wrap.replaceChildren(
      h('div', { class: 'kpis' },
        kpi('Gasto fijo al mes', fmtEur(sum(rows, monthlyEur)), `${fmtEur(sum(rows, withVat))} con IVA`),
        clientId ? null : kpi('Generales de la agencia', fmtEur(sum(general, monthlyEur)), 'al mes, sin IVA'),
        clientId ? null : kpi('De clientes', fmtEur(sum(ofClients, monthlyEur)), 'al mes, sin IVA'),
        kpi('Al año', fmtEur(sum(rows, monthlyEur) * 12), 'sin IVA, si nada cambia')),
      h('div', { class: 'toolbar' }, h('button', { class: 'btn primary', type: 'button', onclick: () => edit(null) }, 'Añadir gasto')),
      table([
        { label: 'Concepto', cell: (r) => r.concept },
        ...(clientId ? [] : [{ label: 'De', cell: (r) => r.clients?.name || 'Agencia' }]),
        { label: 'Proveedor', cell: (r) => r.provider || '—' },
        { label: 'Importe', num: true, cell: (r) => `${money(r.amount, r.currency)} · ${PERIODS[r.period].toLowerCase()}` },
        { label: 'IVA', num: true, cell: (r) => `${Number(r.vat_pct)} %` },
        { label: 'Al mes', num: true, cell: (r) => (r.period === 'once' ? '—' : fmtEur(monthlyEur(r))) },
        { label: 'Al mes con IVA', num: true, cell: (r) => (r.period === 'once' ? '—' : fmtEur(withVat(r))) },
        { label: 'Desde', cell: (r) => fmtDate(r.start_date) },
        { label: 'Estado', cell: (r) => (isActive(r) ? 'Activo' : 'Terminado') },
      ], rows, { empty: 'Aún no hay gastos apuntados.', onRow: edit }),
      h('p', { class: 'muted small' }, `Aquí van los gastos fijos. El coste de la IA de cada conversación se suma solo y se ve en Costes y margen. Los importes en dólares se pasan a euros con un cambio orientativo de 1 $ = ${USD_TO_EUR} €.`));
  }
  await load();
  return wrap;
}

export const expensesTab = (clientId) => expensesView(clientId);

export async function expensesPage() {
  return h('div', { class: 'page' }, h('h1', {}, 'Gastos'),
    h('p', { class: 'muted' }, 'Todo lo que pagas de forma fija: suscripciones, dominios, números de teléfono. Los generales de la agencia y los de cada cliente.'),
    await expensesView(null),
    await elevenUsageCard());
}
