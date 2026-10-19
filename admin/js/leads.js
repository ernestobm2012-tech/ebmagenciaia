// Gestión de leads: tres vistas.
//   Contactos: lista con filtros y ficha de cada lead (estado, volver a llamar, quién lo
//              gestiona, a qué comercial se pasa, importe si se cierra y notas).
//   Estadísticas: generados, en curso, cerrados, por comercial, por quien llama, por origen y por día.
//   Equipo: personas que llaman y comerciales de cada negocio (no necesitan usuario del panel).
// Los cambios de un lead pasan por la función update_lead de la base, que comprueba el acceso.
import { db, session } from './app.js';
import { h, q, table, modal, fmtDateTime, field, toast, errorText, kpi, fmtNum, fmtEur } from './ui.js';

export const LEAD_STATUS = {
  new: 'Nuevo',
  to_call: 'Pendiente de llamar',
  called: 'Llamado',
  waiting: 'Esperando respuesta',
  callback: 'Volver a llamar',
  with_sales: 'Pasado al comercial',
  won: 'Cerrado: cliente',
  lost: 'Cerrado: no interesa',
};
const CLOSED = ['won', 'lost'];
// Qué hace cada persona con los contactos; el puesto (job_title) lo escribe cada negocio.
const ROLES = { llamadas: 'Llama a los contactos', comercial: 'Comercial: se le pasan para cerrar', otro: 'No lleva contactos' };
const JOB_SUGGESTIONS = ['Teleoperadora', 'Comercial', 'Instalador', 'Fontanero', 'Técnico', 'Jefe de equipo'];
const jobOf = (m) => m.job_title || { llamadas: 'Llama a los contactos', comercial: 'Comercial', otro: '—' }[m.role];
const CHANNELS = { phone: 'Teléfono', web: 'Chat de la web', whatsapp: 'WhatsApp', instagram: 'Instagram' };

const statusBadge = (s) => h('span', { class: `badge lead-${s}` }, LEAD_STATUS[s] || s);

// Fin del día de hoy en hora local: lo que toca hoy incluye lo atrasado.
function endOfToday() {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d;
}

// datetime-local trabaja en hora local sin zona.
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function nextCall(r) {
  if (!r.follow_up_at) return '—';
  const late = new Date(r.follow_up_at) < new Date() && !CLOSED.includes(r.status);
  return h('span', { class: late ? 'lead-late' : null }, fmtDateTime(r.follow_up_at), late ? ' · atrasada' : '');
}

// Lo atrasado y lo más urgente arriba; sin fecha, por orden de llegada.
function sortLeads(rows) {
  return [...rows].sort((a, b) => {
    const fa = a.follow_up_at ? Date.parse(a.follow_up_at) : Infinity;
    const fb = b.follow_up_at ? Date.parse(b.follow_up_at) : Infinity;
    if (fa !== fb) return fa - fb;
    return Date.parse(b.created_at) - Date.parse(a.created_at);
  });
}

// clientId: un solo cliente. clientCol: columnas extra de cliente (admin o partner).
// openConversation: función para enseñar la conversación (o null si no puede verla).
export async function leadsView({ clientId = null, clientCol = [], openConversation = null }) {
  const ctx = { clientId, clientCol, openConversation, rows: [], members: [] };
  const views = [
    { id: 'list', label: 'Contactos', render: () => listView(ctx) },
    { id: 'stats', label: 'Estadísticas', render: () => statsView(ctx) },
    { id: 'team', label: 'Equipo', render: () => teamView(ctx) },
  ];
  const wrap = h('div', {});
  const bar = h('div', { class: 'lead-views' });
  const body = h('div', {});
  let current = views[0];

  ctx.reload = async () => {
    let query = db.from('leads').select('*, clients(name), conversations(channel)').order('created_at', { ascending: false }).limit(2000);
    if (clientId) query = query.eq('client_id', clientId);
    let members = db.from('team_members').select('*').order('name');
    if (clientId) members = members.eq('client_id', clientId);
    [ctx.rows, ctx.members] = await Promise.all([q(query), q(members).catch(() => [])]);
    ctx.memberName = new Map(ctx.members.map((m) => [m.id, m.name]));
  };
  ctx.show = async () => {
    bar.replaceChildren(...views.map((v) => h('button', {
      type: 'button', class: `seg${v === current ? ' on' : ''}`,
      onclick: () => { current = v; ctx.show(); },
    }, v.label)));
    body.replaceChildren(h('p', { class: 'empty' }, 'Cargando…'));
    try {
      body.replaceChildren(await current.render());
    } catch (err) {
      body.replaceChildren(h('p', { class: 'error' }, errorText(err)));
    }
  };
  await ctx.reload();
  wrap.append(bar, body);
  await ctx.show();
  return wrap;
}

// ------------------------------------------------------------------ contactos
function mine(r, ctx) {
  const me = session.user?.id;
  if (!me) return false;
  if (r.assigned_to === me) return true;
  return ctx.members.some((m) => m.profile_id === me && (m.id === r.caller_id || m.id === r.seller_id));
}

function listView(ctx) {
  const filters = [
    { id: 'today', label: 'Hoy', test: (r) => !CLOSED.includes(r.status) && (r.status === 'new' || (r.follow_up_at && new Date(r.follow_up_at) <= endOfToday())) },
    { id: 'open', label: 'Pendientes', test: (r) => !CLOSED.includes(r.status) },
    { id: 'sales', label: 'Con comercial', test: (r) => !CLOSED.includes(r.status) && (r.seller_id || r.status === 'with_sales') },
    { id: 'mine', label: 'Míos', test: (r) => !CLOSED.includes(r.status) && mine(r, ctx) },
    { id: 'all', label: 'Todos', test: () => true },
  ];
  const wrap = h('div', {});
  let current = filters[0];
  const bar = h('div', { class: 'lead-filters' });
  const who = (id) => ctx.memberName.get(id) || '—';

  function render() {
    bar.replaceChildren(...filters.map((f) => h('button', {
      type: 'button', class: `chip${f === current ? ' on' : ''}`,
      onclick: () => { current = f; render(); },
    }, f.id === 'all' ? f.label : `${f.label} · ${ctx.rows.filter(f.test).length}`)));
    const list = sortLeads(ctx.rows.filter(current.test));
    wrap.replaceChildren(bar,
      ...(ctx.members.length ? [] : [h('p', { class: 'muted small' }, 'Para repartir los contactos, da de alta a tu equipo en la pestaña «Equipo».')]),
      table([
        { label: 'Entró', cell: (r) => fmtDateTime(r.created_at) },
        ...ctx.clientCol,
        { label: 'Persona', cell: (r) => h('div', {}, h('b', {}, r.name || '—'), h('div', { class: 'muted small' }, r.contact || '')) },
        { label: 'Motivo', cell: (r) => h('span', { class: 'clip', title: r.reason || '' }, r.reason || '—') },
        { label: 'Estado', cell: (r) => statusBadge(r.status) },
        { label: 'Próxima llamada', cell: nextCall },
        { label: 'Lo gestiona', cell: (r) => who(r.caller_id) },
        { label: 'Comercial', cell: (r) => who(r.seller_id) },
      ], list, {
        empty: current.id === 'today' ? 'No hay nada pendiente para hoy.' : 'No hay contactos aquí.',
        onRow: (r) => openLead(r, ctx, render),
      }));
  }
  render();
  return wrap;
}

function openLead(lead, ctx, onSaved) {
  const history = h('div', { class: 'lead-history' }, h('p', { class: 'empty' }, 'Cargando…'));
  const team = ctx.members.filter((m) => m.client_id === lead.client_id
    && ((m.active && m.role !== 'otro') || m.id === lead.caller_id || m.id === lead.seller_id));
  const option = (m, selected) => h('option', { value: m.id, selected }, `${m.name}${m.job_title ? ` · ${m.job_title}` : ''}${m.active ? '' : ' (de baja)'}`);

  const status = h('select', { name: 'status' },
    Object.entries(LEAD_STATUS).map(([v, l]) => h('option', { value: v, selected: lead.status === v }, l)));
  const when = h('input', { type: 'datetime-local', name: 'follow_up_at', value: toLocalInput(lead.follow_up_at) });
  const caller = h('select', { name: 'caller' },
    h('option', { value: '' }, 'Nadie todavía'),
    [...team].sort((a, b) => (a.role === b.role ? 0 : a.role === 'llamadas' ? -1 : 1)).map((m) => option(m, lead.caller_id === m.id)));
  const seller = h('select', { name: 'seller' },
    h('option', { value: '' }, 'Ninguno'),
    team.filter((m) => m.role === 'comercial').map((m) => option(m, lead.seller_id === m.id)));
  const value = h('input', { type: 'number', name: 'value', min: 0, step: '0.01', inputmode: 'decimal', placeholder: '0,00', value: lead.deal_value ?? '' });
  const note = h('textarea', { name: 'note', rows: 3, placeholder: 'Qué habéis hablado, qué queda pendiente…' });
  const error = h('p', { class: 'error' });
  const save = h('button', { class: 'btn primary', type: 'submit' }, 'Guardar');

  // Atajos: «Volver a llamar» sin fecha propone mañana a la misma hora, y elegir
  // comercial en un contacto abierto lo marca como «Pasado al comercial».
  status.addEventListener('change', () => {
    if (status.value === 'callback' && !when.value) {
      const d = new Date(Date.now() + 86_400_000);
      d.setMinutes(0, 0, 0);
      when.value = toLocalInput(d.toISOString());
    }
  });
  seller.addEventListener('change', () => {
    if (seller.value && !CLOSED.includes(status.value)) status.value = 'with_sales';
  });

  const form = h('form', { class: 'form', onsubmit: submit },
    h('div', { class: 'grid2' },
      field('Estado', status),
      field('Volver a llamar el', when, 'Ese día le llega un aviso a quien lo gestiona.'),
      field('Lo gestiona', caller, team.length ? 'Quien llama al contacto.' : 'Da de alta a tu equipo en la pestaña «Equipo».'),
      field('Comercial', seller, 'Al elegirlo le llega un aviso con el contacto.'),
      field('Importe (€)', value, 'Lo que supone si se cierra. Sale en las estadísticas.')),
    field('Nueva nota', note),
    error,
    h('div', {}, save, ' ',
      when.value ? h('button', { class: 'btn link', type: 'button', onclick: () => { when.value = ''; } }, 'Quitar la fecha') : null));

  const body = h('div', { class: 'lead-card' },
    h('p', { class: 'muted' },
      lead.contact ? [h('b', {}, lead.contact), ' · '] : '',
      `Entró el ${fmtDateTime(lead.created_at)}`,
      lead.clients?.name ? ` · ${lead.clients.name}` : ''),
    form,
    h('h3', {}, 'Historial'),
    history,
    lead.conversation_id && ctx.openConversation
      ? h('p', {}, h('button', { class: 'btn link', type: 'button', onclick: () => ctx.openConversation({ id: lead.conversation_id, started_at: lead.created_at }) }, 'Ver la conversación completa'))
      : null);
  const close = modal(lead.name || lead.contact || 'Contacto', body, { wide: true });

  async function loadHistory() {
    try {
      const notes = await q(db.from('lead_notes').select('*').eq('lead_id', lead.id).order('created_at', { ascending: false }));
      const items = notes.map((n) => h('div', { class: 'lead-note' },
        h('div', { class: 'lead-note-meta' }, fmtDateTime(n.created_at), ' · ', n.author_name || 'Alguien del equipo',
          n.status_to ? ` · ${LEAD_STATUS[n.status_from] || n.status_from} → ${LEAD_STATUS[n.status_to] || n.status_to}` : ''),
        n.body ? h('div', { class: 'bubble-text' }, n.body) : null));
      // Lo que recogió el asistente, siempre al final.
      items.push(h('div', { class: 'lead-note agent' },
        h('div', { class: 'lead-note-meta' }, fmtDateTime(lead.created_at), ' · Asistente'),
        h('div', { class: 'bubble-text' }, lead.reason || 'Nuevo contacto.')));
      history.replaceChildren(...items);
    } catch (err) {
      history.replaceChildren(h('p', { class: 'error' }, errorText(err)));
    }
  }
  loadHistory();

  async function submit(e) {
    e.preventDefault();
    error.textContent = '';
    save.disabled = true;
    const followUp = when.value ? new Date(when.value).toISOString() : null;
    const amount = value.value === '' ? null : Number(value.value);
    try {
      await q(db.rpc('update_lead', {
        p_id: lead.id, p_status: status.value, p_follow_up_at: followUp,
        p_caller: caller.value || null, p_seller: seller.value || null, p_value: amount, p_note: note.value,
      }));
      Object.assign(lead, { status: status.value, follow_up_at: followUp, caller_id: caller.value || null, seller_id: seller.value || null, deal_value: amount });
      toast('Guardado');
      onSaved();
      close();
    } catch (err) {
      error.textContent = errorText(err);
      save.disabled = false;
    }
  }
}

// ------------------------------------------------------------------ estadísticas
const PERIODS = [
  { id: '7', label: '7 días', days: 7 },
  { id: '30', label: '30 días', days: 30 },
  { id: '90', label: '3 meses', days: 90 },
  { id: 'year', label: 'Este año' },
  { id: 'all', label: 'Todo' },
];
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)} %` : '—');
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
function duration(ms) {
  if (ms == null) return '—';
  const hours = ms / 3_600_000;
  if (hours < 1) return `${Math.max(1, Math.round(ms / 60_000))} min`;
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${Math.round(hours / 24)} días`;
}
function bar(value, max) {
  const w = max > 0 ? Math.round((value / max) * 100) : 0;
  return h('span', { class: 'stat-bar' }, h('span', { style: `width:${value ? Math.max(2, w) : 0}%` }));
}
const dayKey = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date(iso));

function statsView(ctx) {
  const wrap = h('div', {});
  const bar1 = h('div', { class: 'lead-filters' });
  let period = PERIODS[1];
  const clients = [...new Map(ctx.rows.map((r) => [r.client_id, r.clients?.name || '—'])).entries()];
  let clientFilter = '';
  const clientSelect = !ctx.clientId && clients.length > 1
    ? h('select', { onchange: (e) => { clientFilter = e.target.value; render(); } },
      h('option', { value: '' }, 'Todos los negocios'), clients.map(([id, name]) => h('option', { value: id }, name)))
    : null;

  function render() {
    bar1.replaceChildren(...PERIODS.map((p) => h('button', {
      type: 'button', class: `chip${p === period ? ' on' : ''}`, onclick: () => { period = p; render(); },
    }, p.label)), ...(clientSelect ? [clientSelect] : []));
    const from = period.days ? Date.now() - period.days * 86_400_000
      : period.id === 'year' ? new Date(new Date().getFullYear(), 0, 1).getTime() : 0;
    const rows = ctx.rows.filter((r) => Date.parse(r.created_at) >= from && (!clientFilter || r.client_id === clientFilter));
    wrap.replaceChildren(bar1, rows.length ? report(rows, ctx, period) : h('p', { class: 'empty' }, 'No hay contactos en este periodo.'));
  }
  render();
  return wrap;
}

function report(rows, ctx, period) {
  const won = rows.filter((r) => r.status === 'won');
  const lost = rows.filter((r) => r.status === 'lost');
  const open = rows.filter((r) => !CLOSED.includes(r.status));
  const passed = rows.filter((r) => r.seller_id || r.passed_at || r.status === 'with_sales');
  const untouched = rows.filter((r) => r.status === 'new');
  const value = won.reduce((a, r) => a + (Number(r.deal_value) || 0), 0);
  const firstCall = avg(rows.filter((r) => r.first_contact_at).map((r) => Date.parse(r.first_contact_at) - Date.parse(r.created_at)));
  const toClose = avg(won.filter((r) => r.closed_at).map((r) => Date.parse(r.closed_at) - Date.parse(r.created_at)));
  const late = open.filter((r) => r.follow_up_at && Date.parse(r.follow_up_at) < Date.now());

  // Estados en el orden del embudo.
  const byStatus = Object.keys(LEAD_STATUS).map((s) => ({ s, n: rows.filter((r) => r.status === s).length }));
  const maxStatus = Math.max(1, ...byStatus.map((x) => x.n));

  // Por persona del equipo (más «Sin asignar»).
  const group = (key, role) => {
    const ids = [...new Set(rows.map((r) => r[key] || ''))];
    return ids.map((id) => {
      const mine = rows.filter((r) => (r[key] || '') === id);
      const m = ctx.members.find((x) => x.id === id);
      return {
        name: id ? (m?.name || '—') : (role === 'comercial' ? 'Sin comercial' : 'Sin asignar'), id,
        total: mine.length,
        open: mine.filter((r) => !CLOSED.includes(r.status)).length,
        contacted: mine.filter((r) => r.first_contact_at || !['new', 'to_call'].includes(r.status)).length,
        passed: mine.filter((r) => r.seller_id || r.status === 'with_sales').length,
        won: mine.filter((r) => r.status === 'won').length,
        lost: mine.filter((r) => r.status === 'lost').length,
        value: mine.filter((r) => r.status === 'won').reduce((a, r) => a + (Number(r.deal_value) || 0), 0),
      };
    }).sort((a, b) => (a.id ? 0 : 1) - (b.id ? 0 : 1) || b.won - a.won || b.total - a.total);
  };
  const sellers = group('seller_id', 'comercial');
  const callers = group('caller_id', 'llamadas');

  // Por origen del contacto.
  const channels = [...new Set(rows.map((r) => r.conversations?.channel || 'otro'))].map((c) => {
    const mine = rows.filter((r) => (r.conversations?.channel || 'otro') === c);
    return { c, total: mine.length, won: mine.filter((r) => r.status === 'won').length };
  }).sort((a, b) => b.total - a.total);

  // Por día (o por semana si el periodo es largo).
  const weekly = !period.days || period.days > 45;
  const bucket = (iso) => {
    if (!weekly) return dayKey(iso);
    const d = new Date(`${dayKey(iso)}T12:00:00`);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return dayKey(d.toISOString());
  };
  const timeline = new Map();
  for (const r of rows) {
    const k = bucket(r.created_at);
    const t = timeline.get(k) || { total: 0, won: 0 };
    t.total++;
    if (r.status === 'won') t.won++;
    timeline.set(k, t);
  }
  const series = [...timeline.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  const maxT = Math.max(1, ...series.map(([, t]) => t.total));
  const label = (k) => (weekly ? 'Semana del ' : '') + new Intl.DateTimeFormat('es-ES', { weekday: weekly ? undefined : 'short', day: '2-digit', month: 'short' }).format(new Date(`${k}T12:00:00`));

  return h('div', {},
    h('div', { class: 'kpis' },
      kpi('Contactos generados', fmtNum(rows.length), untouched.length ? `${fmtNum(untouched.length)} sin tocar todavía` : 'Todos atendidos'),
      kpi('En curso', fmtNum(open.length), late.length ? `${fmtNum(late.length)} con la llamada atrasada` : 'Ninguno atrasado'),
      kpi('Pasados al comercial', fmtNum(passed.length), `${pct(passed.length, rows.length)} de los contactos`),
      kpi('Clientes cerrados', fmtNum(won.length), `${pct(won.length, rows.length)} de los contactos`),
      kpi('No interesados', fmtNum(lost.length), `${pct(lost.length, rows.length)} de los contactos`),
      kpi('Tasa de cierre', pct(won.length, won.length + lost.length), 'De los que ya tienen respuesta'),
      kpi('Importe cerrado', fmtEur(value), won.length ? `Media ${fmtEur(value / won.length)} por cliente` : 'Pon el importe al cerrar'),
      kpi('Hasta la primera llamada', duration(firstCall), toClose != null ? `Hasta cerrar: ${duration(toClose)}` : 'De media')),

    section('Cómo están los contactos', null,
      table([
        { label: 'Estado', cell: (x) => statusBadge(x.s) },
        { label: 'Contactos', num: true, cell: (x) => fmtNum(x.n) },
        { label: '%', num: true, cell: (x) => pct(x.n, rows.length) },
        { label: '', cell: (x) => bar(x.n, maxStatus) },
      ], byStatus)),

    section('Por comercial', 'Contactos que se le han pasado a cada comercial y cómo han acabado.',
      table([
        { label: 'Comercial', cell: (x) => h('b', {}, x.name) },
        { label: 'Recibidos', num: true, cell: (x) => fmtNum(x.total) },
        { label: 'En curso', num: true, cell: (x) => fmtNum(x.open) },
        { label: 'Cerrados', num: true, cell: (x) => fmtNum(x.won) },
        { label: 'No interesa', num: true, cell: (x) => fmtNum(x.lost) },
        { label: 'Tasa de cierre', num: true, cell: (x) => pct(x.won, x.won + x.lost) },
        { label: 'Importe', num: true, cell: (x) => (x.value ? fmtEur(x.value) : '—') },
      ], sellers)),

    section('Por quien llama', 'Contactos que gestiona cada persona: cuántos ha llamado, cuántos ha pasado al comercial y cuántos han acabado en cliente.',
      table([
        { label: 'Persona', cell: (x) => h('b', {}, x.name) },
        { label: 'Asignados', num: true, cell: (x) => fmtNum(x.total) },
        { label: 'Llamados', num: true, cell: (x) => fmtNum(x.contacted) },
        { label: 'Pasados al comercial', num: true, cell: (x) => fmtNum(x.passed) },
        { label: 'Cerrados', num: true, cell: (x) => fmtNum(x.won) },
        { label: 'No interesa', num: true, cell: (x) => fmtNum(x.lost) },
        { label: 'Conversión', num: true, cell: (x) => pct(x.won, x.total) },
      ], callers)),

    section('Por origen', 'Por dónde llegó cada contacto.',
      table([
        { label: 'Origen', cell: (x) => CHANNELS[x.c] || (x.c === 'otro' ? 'Otro' : x.c) },
        { label: 'Contactos', num: true, cell: (x) => fmtNum(x.total) },
        { label: 'Cerrados', num: true, cell: (x) => fmtNum(x.won) },
        { label: 'Conversión', num: true, cell: (x) => pct(x.won, x.total) },
      ], channels)),

    section(weekly ? 'Por semana' : 'Por día', null,
      table([
        { label: weekly ? 'Semana' : 'Día', cell: ([k]) => label(k) },
        { label: 'Contactos', num: true, cell: ([, t]) => fmtNum(t.total) },
        { label: 'Cerrados', num: true, cell: ([, t]) => fmtNum(t.won) },
        { label: '', cell: ([, t]) => bar(t.total, maxT) },
      ], series)));
}

function section(title, hint, ...children) {
  return h('section', { class: 'lead-section' }, h('h3', {}, title), hint ? h('p', { class: 'muted small' }, hint) : null, ...children);
}

// ------------------------------------------------------------------ equipo
async function teamView(ctx) {
  const wrap = h('div', {});
  let clients = [];
  if (ctx.clientId) clients = [{ id: ctx.clientId }];
  else {
    clients = await q(db.from('clients').select('id, name').order('name')).catch(() => []);
    if (session.profile?.role !== 'admin') clients = clients.filter((c) => ctx.rows.some((r) => r.client_id === c.id) || session.profile?.client_id === c.id);
  }
  if (!clients.length) return h('p', { class: 'empty' }, 'No hay ningún negocio.');
  let clientId = clients.length === 1 ? clients[0].id : (session.profile?.client_id && clients.some((c) => c.id === session.profile.client_id) ? session.profile.client_id : clients[0].id);
  const picker = clients.length > 1
    ? field('Negocio', h('select', { onchange: (e) => { clientId = e.target.value; render(); } },
      clients.map((c) => h('option', { value: c.id, selected: c.id === clientId }, c.name))))
    : null;
  const list = h('div', {});

  async function render() {
    const team = ctx.members.filter((m) => m.client_id === clientId);
    const users = await q(db.rpc('lead_team', { p_client: clientId })).catch(() => []);
    const userName = new Map(users.map((u) => [u.id, u.name]));
    list.replaceChildren(
      table([
        { label: 'Nombre', cell: (m) => h('b', {}, m.name) },
        { label: 'Puesto', cell: (m) => jobOf(m) },
        { label: 'Con los contactos', cell: (m) => ({ llamadas: 'Los llama', comercial: 'Se los pasan', otro: '—' }[m.role]) },
        { label: 'Correo', cell: (m) => m.email || '—' },
        { label: 'Teléfono', cell: (m) => m.phone || '—' },
        { label: 'Usuario del panel', cell: (m) => userName.get(m.profile_id) || '—' },
        { label: 'Estado', cell: (m) => (m.active ? 'Activo' : 'De baja') },
      ], team, {
        empty: 'Todavía no hay nadie. Añade a quien llama a los contactos y a los comerciales.',
        onRow: (m) => memberDialog(m, users, team),
      }),
      h('div', { class: 'actions', style: 'margin-top:12px' }, h('button', { class: 'btn primary', type: 'button', onclick: () => memberDialog(null, users, team) }, 'Añadir persona')));
  }

  function memberDialog(m, users, team) {
    const name = h('input', { required: true, value: m?.name || '', placeholder: 'Nombre y apellido' });
    // Puesto libre con sugerencias (los que ya usa el negocio y los típicos).
    const listId = `jobs-${Math.random().toString(36).slice(2)}`;
    const jobs = [...new Set([...team.map((t) => t.job_title).filter(Boolean), ...JOB_SUGGESTIONS])];
    const job = h('input', { list: listId, value: m?.job_title || '', placeholder: 'Teleoperadora, Comercial, Fontanero…' });
    const role = h('select', {}, Object.entries(ROLES).map(([v, l]) => h('option', { value: v, selected: (m?.role || 'llamadas') === v }, l)));
    // Al escribir el puesto se propone qué hace con los contactos (se puede cambiar).
    job.addEventListener('change', () => {
      const t = job.value.toLowerCase();
      if (/comercial|ventas|vendedor/.test(t)) role.value = 'comercial';
      else if (/teleoperador|llama|atenci|recepci/.test(t)) role.value = 'llamadas';
      else if (/instalad|fontaner|t[eé]cnic|montador|electricista/.test(t)) role.value = 'otro';
    });
    const email = h('input', { type: 'email', value: m?.email || '', placeholder: 'nombre@empresa.com' });
    const phone = h('input', { type: 'tel', value: m?.phone || '' });
    const user = h('select', {}, h('option', { value: '' }, 'No tiene'), users.map((u) => h('option', { value: u.id, selected: m?.profile_id === u.id }, u.name)));
    const active = h('input', { type: 'checkbox', checked: m ? m.active : true });
    const error = h('p', { class: 'error' });
    let close = () => {};

    async function submit(e) {
      e.preventDefault();
      error.textContent = '';
      const row = {
        client_id: clientId, name: name.value.trim(), role: role.value, job_title: job.value.trim() || null,
        email: email.value.trim() || null, phone: phone.value.trim() || null,
        profile_id: user.value || null, active: active.checked,
      };
      try {
        if (m) await q(db.from('team_members').update(row).eq('id', m.id));
        else await q(db.from('team_members').insert(row));
        await ctx.reload();
        toast(m ? 'Guardado' : `${row.name} añadido al equipo`);
        close();
        render();
      } catch (err) {
        error.textContent = errorText(err);
      }
    }
    async function remove() {
      if (!confirm(`¿Borrar a ${m.name} del equipo? Sus contactos se quedan, pero sin esa persona. Si solo deja de trabajar, mejor márcalo «de baja».`)) return;
      try {
        await q(db.from('team_members').delete().eq('id', m.id));
        await ctx.reload();
        close();
        render();
      } catch (err) {
        error.textContent = errorText(err);
      }
    }

    close = modal(m ? m.name : 'Añadir persona al equipo', h('form', { class: 'form', onsubmit: submit },
      h('div', { class: 'grid2' },
        field('Nombre', name),
        field('Puesto', h('div', {}, job, h('datalist', { id: listId }, jobs.map((j) => h('option', { value: j })))), 'Escríbelo como lo llaméis vosotros.'),
        field('Con los contactos', role, 'Quien llama los gestiona; al comercial se le pasan para cerrar. Instaladores y técnicos: «No lleva contactos».'),
        field('Correo', email, 'Le llega un aviso cuando le pasen un contacto o toque volver a llamar.'),
        field('Teléfono', phone),
        field('Usuario del panel', user, 'Opcional. Si tiene usuario, ve sus contactos en «Míos» y recibe los avisos en el móvil.')),
      h('label', { class: 'check' }, active, ' Activo (sale en las listas para asignar)'),
      error,
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', type: 'submit' }, m ? 'Guardar' : 'Añadir'),
        m ? h('button', { class: 'btn link danger', type: 'button', onclick: remove }, 'Borrar') : null)));
  }

  wrap.append(
    h('p', { class: 'muted' }, 'Todo el equipo: quien llama a los contactos, comerciales, instaladores, técnicos… Cada uno con su puesto. No hace falta que tengan usuario del panel: con su correo ya reciben los avisos.'),
    ...(picker ? [picker] : []), list);
  await render();
  return wrap;
}
