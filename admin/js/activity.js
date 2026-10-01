// Listados de actividad (conversaciones, leads, derivaciones, citas, avisos).
// Los usan el panel de admin y el del cliente; RLS decide qué filas llegan.
import { db } from './app.js';
import { h, q, table, tabs, badge, modal, fmtDateTime, errorText } from './ui.js';

const CHANNELS = { web: 'Web', whatsapp: 'WhatsApp', instagram: 'Instagram', email: 'Correo', phone: 'Teléfono' };
const LIMIT = 200;

// clientId: filtra por cliente. showClient: añade la columna "Cliente" (solo admin).
function list(tableName, { clientId, showClient, orderBy = 'created_at' }) {
  let query = db.from(tableName).select(showClient ? '*, clients(name)' : '*')
    .order(orderBy, { ascending: false }).limit(LIMIT);
  if (clientId) query = query.eq('client_id', clientId);
  return q(query);
}

const clientCol = (showClient) => (showClient ? [{ label: 'Cliente', cell: (r) => r.clients?.name || '—' }] : []);

async function openConversation(conv) {
  const body = h('div', { class: 'chat' }, h('p', { class: 'empty' }, 'Cargando…'));
  modal(`Conversación · ${fmtDateTime(conv.started_at)}`, body, { wide: true });
  try {
    const messages = await q(db.from('messages').select('role, content, created_at')
      .eq('conversation_id', conv.id).order('created_at'));
    body.replaceChildren(...(messages.length
      ? messages.map((m) => h('div', { class: `bubble ${m.role}` },
          h('div', { class: 'bubble-text' }, m.content),
          h('div', { class: 'bubble-meta' }, fmtDateTime(m.created_at))))
      : [h('p', { class: 'empty' }, 'Esta conversación no tiene mensajes.')]));
  } catch (err) {
    body.replaceChildren(h('p', { class: 'error' }, errorText(err)));
  }
}

export function activityTabs({ clientId = null, showClient = false, isAdmin = false } = {}) {
  const opts = { clientId, showClient };
  const items = [
    {
      id: 'conversations', label: 'Conversaciones',
      render: async () => table([
        { label: 'Inicio', cell: (r) => fmtDateTime(r.started_at) },
        ...clientCol(showClient),
        { label: 'Canal', cell: (r) => CHANNELS[r.channel] || r.channel },
        { label: 'Resumen', cell: (r) => h('span', { class: 'clip', title: r.summary || r.topic || '' }, r.summary || r.topic || '—') },
        { label: 'Mensajes', num: true, cell: (r) => r.message_count },
        { label: 'Humano', cell: (r) => (r.handed_off ? 'Sí' : '—') },
        { label: 'Estado', cell: (r) => badge(r.status) },
      ], await list('conversations', { ...opts, orderBy: 'started_at' }),
      { empty: 'Aún no hay conversaciones.', onRow: openConversation }),
    },
    {
      id: 'leads', label: 'Leads',
      render: async () => table([
        { label: 'Fecha', cell: (r) => fmtDateTime(r.created_at) },
        ...clientCol(showClient),
        { label: 'Nombre', cell: (r) => r.name || '—' },
        { label: 'Contacto', cell: (r) => r.contact || '—' },
        { label: 'Motivo', cell: (r) => r.reason || '—' },
        { label: 'Estado', cell: (r) => badge(r.status) },
      ], await list('leads', opts), { empty: 'Aún no hay leads.' }),
    },
    {
      id: 'handoffs', label: 'Pasos a humano',
      render: async () => table([
        { label: 'Fecha', cell: (r) => fmtDateTime(r.created_at) },
        ...clientCol(showClient),
        { label: 'Motivo', cell: (r) => r.reason || '—' },
      ], await list('handoffs', opts), { empty: 'El agente no ha tenido que pasar ninguna conversación.' }),
    },
    {
      id: 'appointments', label: 'Citas',
      render: async () => table([
        { label: 'Cita', cell: (r) => fmtDateTime(r.scheduled_at) },
        ...clientCol(showClient),
        { label: 'Nombre', cell: (r) => r.name || '—' },
        { label: 'Contacto', cell: (r) => r.contact || '—' },
        { label: 'Notas', cell: (r) => r.notes || '—' },
      ], await list('appointments', opts), { empty: 'Aún no hay citas.' }),
    },
    {
      id: 'notifications', label: 'Avisos enviados',
      render: async () => table([
        { label: 'Fecha', cell: (r) => fmtDateTime(r.created_at) },
        ...clientCol(showClient),
        { label: 'Asunto', cell: (r) => r.subject || '—' },
        { label: 'Estado', cell: (r) => badge(r.status) },
      ], await list('notifications', opts), { empty: 'Aún no se ha enviado ningún aviso.' }),
    },
  ];
  if (isAdmin) {
    items.push({
      id: 'errors', label: 'Errores',
      render: async () => table([
        { label: 'Fecha', cell: (r) => fmtDateTime(r.created_at) },
        ...clientCol(showClient),
        { label: 'Origen', cell: (r) => r.source || '—' },
        { label: 'Mensaje', cell: (r) => r.message || '—' },
      ], await list('error_log', opts), { empty: 'Sin errores. Bien.' }),
    });
  }
  return tabs(items);
}
