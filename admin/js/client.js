// Panel del cliente: solo lectura y solo sus datos (lo garantiza RLS).
import { db, session } from './app.js';
import { activityTabs } from './activity.js';
import { h, q, table, kpi, fmtNum, monthStart } from './ui.js';

export const clientNav = [
  { href: '#/', label: 'Resumen' },
  { href: '#/actividad', label: 'Actividad' },
];

export const clientRoutes = [
  [/^\/$/, overview],
  [/^\/actividad$/, activityPage],
];

async function overview() {
  const since = monthStart().toISOString();
  const count = (t, col = 'created_at') =>
    q(db.from(t).select('*', { count: 'exact', head: true }).gte(col, since));
  const [conversations, leads, handoffs, appointments, topics] = await Promise.all([
    count('conversations', 'started_at'), count('leads'), count('handoffs'), count('appointments'),
    q(db.from('conversations').select('topic').gte('started_at', since).not('topic', 'is', null).limit(1000)),
  ]);

  const tally = {};
  for (const { topic } of topics) tally[topic] = (tally[topic] || 0) + 1;
  const top = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([topic, n]) => ({ topic, n }));

  // Un partner ve además el desglose por cada uno de sus clientes.
  const month = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-01`;
  const perClient = session.clients.length > 1
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
      kpi('Leads captados', fmtNum(leads)),
      kpi('Pasadas a una persona', fmtNum(handoffs)),
      kpi('Citas agendadas', fmtNum(appointments))),
    session.clients.length > 1 ? [h('h2', {}, 'Por cliente'), table([
      { label: 'Cliente', cell: (r) => r.name },
      { label: 'Conversaciones', num: true, cell: (r) => fmtNum(byId[r.id]?.conversations) },
      { label: 'Pasadas a una persona', num: true, cell: (r) => fmtNum(byId[r.id]?.handed_off) },
    ], session.clients)] : null,
    h('h2', {}, 'Lo que más preguntan'),
    table([
      { label: 'Tema', cell: (r) => r.topic },
      { label: 'Conversaciones', num: true, cell: (r) => fmtNum(r.n) },
    ], top, { empty: 'Aún no hay suficientes conversaciones este mes.' }));
}

async function activityPage() {
  const clientNames = session.clients.length > 1
    ? Object.fromEntries(session.clients.map((c) => [c.id, c.name]))
    : null;
  return h('div', { class: 'page' }, h('h1', {}, 'Actividad'), activityTabs({ clientNames }));
}
