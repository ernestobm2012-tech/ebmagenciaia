// Panel del cliente: solo lectura y solo sus datos (lo garantiza RLS).
import { db, session, can } from './app.js';
import { activityTabs, openConversation } from './activity.js';
import { leadsView } from './leads.js';
import { catalogView, quotesView } from './catalog.js';
import { homeView, statsView } from './dashboard.js';
import { calendarsTab } from './calendars.js';
import { socialTab } from './social.js';
import { printersView } from './printers.js';
import { contactsTab } from './contacts.js';
import { h, q, table, kpi, fmtNum, monthStart } from './ui.js';

export const clientNav = [
  { href: '#/', label: 'Resumen', icon: 'home', module: 'resumen' },
  { href: '#/contactos', label: 'Contactos', icon: 'users', module: 'actividad', key: 'act_leads' },
  { href: '#/conversaciones', label: 'Conversaciones', icon: 'chat', module: 'actividad', key: 'act_conversaciones' },
  { href: '#/calendarios', label: 'Agenda', icon: 'cal', module: 'calendarios' },
  { href: '#/estadisticas', label: 'Estadísticas', icon: 'chart', module: 'resumen', key: 'act_leads' },
  { href: '#/catalogo', label: 'Catálogo', icon: 'box', needs: 'presupuestos', module: 'catalogo' },
  { href: '#/presupuestos', label: 'Presupuestos', icon: 'doc', needs: 'presupuestos', module: 'catalogo' },
  { href: '#/avisos', label: 'Avisos', icon: 'bell', module: 'avisar' },
  { href: '#/redes', label: 'Redes sociales', icon: 'share', module: 'redes' },
  { href: '#/impresoras', label: 'Impresoras', icon: 'print', needs: 'impresoras', module: 'impresoras' },
];

export const clientRoutes = [
  [/^\/$/, home],
  [/^\/contactos$/, contactsListPage],
  [/^\/conversaciones$/, conversationsPage],
  [/^\/estadisticas$/, statsView],
  [/^\/actividad$/, activityPage],
  [/^\/calendarios$/, calendarsPage],
  [/^\/catalogo$/, catalogoPage],
  [/^\/presupuestos$/, presupuestosPage],
  [/^\/avisos$/, contactsPage],
  [/^\/redes$/, socialPage],
  [/^\/impresoras$/, printersPage],
];

// Un negocio con contactos ve la portada nueva; un partner con varios clientes (o sin contactos), la de siempre.
async function home() {
  if (session.clients.length > 1 || !can('act_leads')) return overview();
  return homeView();
}

async function contactsListPage() {
  return h('div', { class: 'page' }, h('h1', {}, 'Contactos'),
    h('p', { class: 'muted' }, 'Todas las personas que han escrito. Toca una para ver su ficha y apuntar lo que habéis hablado.'),
    await leadsView({ clientId: session.client.id, openConversation: can('act_mensajes') ? openConversation : null, only: ['list', 'team'] }));
}

async function catalogoPage() {
  return h('div', { class: 'page' }, h('h1', {}, 'Catálogo'),
    h('p', { class: 'muted' }, 'Los equipos con los que trabajas. Aquí no hay precios: el precio lo pones tú en cada presupuesto.'),
    await catalogView(session.client.id));
}

async function presupuestosPage() {
  return h('div', { class: 'page' }, h('h1', {}, 'Presupuestos'),
    h('p', { class: 'muted' }, 'Los presupuestos de tus contactos. Se crean desde la ficha de cada contacto, en la pestaña «Presupuestos».'),
    await quotesView(session.client.id));
}

async function conversationsPage() {
  const allowed = ['conversations', 'handoffs', 'notifications'].filter((id) => ({ conversations: 'act_conversaciones', handoffs: 'act_derivaciones', notifications: 'act_avisos' })[id] && can({ conversations: 'act_conversaciones', handoffs: 'act_derivaciones', notifications: 'act_avisos' }[id]));
  return h('div', { class: 'page' }, h('h1', {}, 'Conversaciones'),
    h('p', { class: 'muted' }, 'Lo que ha hablado el asistente con cada persona.'),
    activityTabs({ allowed, canOpen: can('act_mensajes') }));
}

async function overview() {
  const since = monthStart().toISOString();
  const count = (t, col = 'created_at') =>
    q(db.from(t).select('*', { count: 'exact', head: true }).gte(col, since));
  const [conversations, leads, handoffs, appointments, topics] = await Promise.all([
    count('conversations', 'started_at'),
    can('act_leads') ? count('leads') : null,
    can('act_derivaciones') ? count('handoffs') : null,
    can('act_citas') ? count('appointments') : null,
    can('resumen_temas')
      ? q(db.from('conversations').select('topic').gte('started_at', since).not('topic', 'is', null).limit(1000))
      : [],
  ]);

  const tally = {};
  for (const { topic } of topics) tally[topic] = (tally[topic] || 0) + 1;
  const top = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([topic, n]) => ({ topic, n }));

  // Un partner ve además el desglose por cada uno de sus clientes.
  const month = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-01`;
  const perClient = session.clients.length > 1 && can('resumen_clientes')
    ? await q(db.from('conversations_monthly').select('*').eq('month', month))
    : [];
  const byId = Object.fromEntries(perClient.map((r) => [r.client_id, r]));

  return h('div', { class: 'page' },
    h('h1', {}, session.client.name),
    h('p', { class: 'muted' }, session.clients.length > 1
      ? 'Esto es lo que han hecho este mes los agentes de tus clientes.'
      : 'Esto es lo que ha hecho tu agente este mes.'),
    h('div', { class: 'kpis' },
      kpi('Conversaciones', fmtNum(conversations)),
      leads === null ? null : kpi('Leads captados', fmtNum(leads)),
      handoffs === null ? null : kpi('Pasadas a una persona', fmtNum(handoffs)),
      appointments === null ? null : kpi('Citas agendadas', fmtNum(appointments))),
    session.clients.length > 1 && can('resumen_clientes') ? [h('h2', {}, 'Por cliente'), table([
      { label: 'Cliente', cell: (r) => r.name },
      { label: 'Conversaciones', num: true, cell: (r) => fmtNum(byId[r.id]?.conversations) },
      { label: 'Pasadas a una persona', num: true, cell: (r) => fmtNum(byId[r.id]?.handed_off) },
    ], session.clients)] : null,
    can('resumen_temas') ? [h('h2', {}, 'Lo que más preguntan'),
      table([
        { label: 'Tema', cell: (r) => r.topic },
        { label: 'Conversaciones', num: true, cell: (r) => fmtNum(r.n) },
      ], top, { empty: 'Aún no hay suficientes conversaciones este mes.' })] : null);
}

async function activityPage() {
  const clientNames = session.clients.length > 1
    ? Object.fromEntries(session.clients.map((c) => [c.id, c.name]))
    : null;
  const TABS = { act_conversaciones: 'conversations', act_leads: 'leads', act_derivaciones: 'handoffs', act_citas: 'appointments', act_avisos: 'notifications' };
  const allowed = Object.entries(TABS).filter(([k]) => can(k)).map(([, id]) => id);
  return h('div', { class: 'page' }, h('h1', {}, 'Actividad'),
    activityTabs({ clientNames, allowed, canOpen: can('act_mensajes') }));
}

// Un partner elige de qué cliente ver los calendarios; el resto ve los suyos.
async function calendarsPage() {
  const holder = h('div', {});
  const show = async (id) => holder.replaceChildren(await calendarsTab(id));
  const picker = session.clients.length > 1
    ? h('select', { class: 'picker', onchange: (e) => show(e.target.value) },
      session.clients.map((c) => h('option', { value: c.id, selected: c.is_own }, c.name)))
    : null;
  await show(session.client.id);
  return h('div', { class: 'page' }, h('h1', {}, 'Agenda'),
    h('p', { class: 'muted' }, 'Las llamadas y citas de tu equipo. Puedes verlas también en Google u Outlook.'),
    picker, holder);
}

// A quién avisa el agente. Un partner elige de qué cliente.
async function contactsPage() {
  const holder = h('div', {});
  const show = async (id) => holder.replaceChildren(await contactsTab(id));
  const picker = session.clients.length > 1
    ? h('select', { class: 'picker', onchange: (e) => show(e.target.value) },
      session.clients.map((c) => h('option', { value: c.id, selected: c.is_own }, c.name)))
    : null;
  await show(session.client.id);
  return h('div', { class: 'page' }, h('h1', {}, 'Avisos'),
    h('p', { class: 'muted' }, 'Las personas a las que el agente avisa cuando entra un contacto o hace falta alguien.'),
    picker, holder);
}

// Un partner elige de qué cliente conectar las redes; el resto, las suyas.
async function socialPage() {
  const holder = h('div', {});
  const show = async (id) => holder.replaceChildren(await socialTab(id));
  const picker = session.clients.length > 1
    ? h('select', { class: 'picker', onchange: (e) => show(e.target.value) },
      session.clients.map((c) => h('option', { value: c.id, selected: c.is_own }, c.name)))
    : null;
  await show(session.client.id);
  return h('div', { class: 'page' }, h('h1', {}, 'Redes sociales'),
    h('p', { class: 'muted' }, 'Conecta tus redes para que el agente conteste por ti.'),
    picker, holder);
}

// Impresoras: un partner puede ver todas las de sus clientes o las de uno en concreto.
async function printersPage() {
  const names = Object.fromEntries(session.clients.map((c) => [c.id, c.name]));
  const allIds = session.clients.map((c) => c.id);
  const canEditPrices = can('impresoras_precios');
  const holder = h('div', {});
  const show = async (id) => holder.replaceChildren(id === 'all'
    ? await printersView(allIds, { clientNames: names, canEditPrices })
    : await printersView([id], { canEditPrices }));
  const picker = session.clients.length > 1
    ? h('select', { class: 'picker', onchange: (e) => show(e.target.value) },
      h('option', { value: 'all' }, 'Todos mis clientes'),
      session.clients.map((c) => h('option', { value: c.id }, c.name)))
    : null;
  await show(session.clients.length > 1 ? 'all' : session.client.id);
  return h('div', { class: 'page' }, h('h1', {}, 'Impresoras'),
    h('p', { class: 'muted' }, 'Cuánto se ha imprimido, cuánto cuesta y cuánto tóner queda en cada impresora.'),
    picker, holder);
}
