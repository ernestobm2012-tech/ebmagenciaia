// Gestión de leads: lista con filtros (hoy, pendientes, míos, todos) y ficha de cada
// contacto con estado, quién lo lleva, fecha para volver a llamar y notas.
// Los cambios pasan por la función update_lead de la base, que comprueba el acceso.
import { db, session } from './app.js';
import { h, q, table, modal, fmtDateTime, field, toast, errorText } from './ui.js';

export const LEAD_STATUS = {
  new: 'Nuevo',
  to_call: 'Pendiente de llamar',
  called: 'Llamado',
  waiting: 'Esperando respuesta',
  callback: 'Volver a llamar',
  won: 'Cerrado: cliente',
  lost: 'Cerrado: no interesa',
};
const CLOSED = ['won', 'lost'];

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

const FILTERS = [
  { id: 'today', label: 'Hoy', test: (r) => !CLOSED.includes(r.status) && (r.status === 'new' || (r.follow_up_at && new Date(r.follow_up_at) <= endOfToday())) },
  { id: 'open', label: 'Pendientes', test: (r) => !CLOSED.includes(r.status) },
  { id: 'mine', label: 'Míos', test: (r) => r.assigned_to === session.user?.id && !CLOSED.includes(r.status) },
  { id: 'all', label: 'Todos', test: () => true },
];

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
  let query = db.from('leads').select('*, clients(name)').order('created_at', { ascending: false }).limit(500);
  if (clientId) query = query.eq('client_id', clientId);
  const rows = await q(query);

  // Nombres de quien lleva cada lead (lead_team ya filtra por acceso).
  const teams = new Map();
  const team = async (cid) => {
    if (!teams.has(cid)) teams.set(cid, q(db.rpc('lead_team', { p_client: cid })).catch(() => []));
    return teams.get(cid);
  };
  const people = new Map();
  for (const cid of new Set(rows.map((r) => r.client_id))) {
    for (const p of await team(cid)) people.set(p.id, p.name);
  }

  const wrap = h('div', {});
  let current = FILTERS[0];
  const counts = (f) => rows.filter(f.test).length;
  const bar = h('div', { class: 'lead-filters' });

  function render() {
    bar.replaceChildren(...FILTERS.map((f) => h('button', {
      type: 'button', class: `chip${f === current ? ' on' : ''}`,
      onclick: () => { current = f; render(); },
    }, f.id === 'all' ? f.label : `${f.label} · ${counts(f)}`)));
    const list = sortLeads(rows.filter(current.test));
    wrap.replaceChildren(bar, table([
      { label: 'Entró', cell: (r) => fmtDateTime(r.created_at) },
      ...clientCol,
      { label: 'Persona', cell: (r) => h('div', {}, h('b', {}, r.name || '—'), h('div', { class: 'muted small' }, r.contact || '')) },
      { label: 'Motivo', cell: (r) => h('span', { class: 'clip', title: r.reason || '' }, r.reason || '—') },
      { label: 'Estado', cell: (r) => statusBadge(r.status) },
      { label: 'Próxima llamada', cell: nextCall },
      { label: 'Lo lleva', cell: (r) => people.get(r.assigned_to) || '—' },
    ], list, {
      empty: current.id === 'today' ? 'No hay nada pendiente para hoy.' : 'No hay contactos aquí.',
      onRow: (r) => openLead(r, { team, people, openConversation, onSaved: render }),
    }));
  }
  render();
  return wrap;
}

async function openLead(lead, { team, people, openConversation, onSaved }) {
  const history = h('div', { class: 'lead-history' }, h('p', { class: 'empty' }, 'Cargando…'));
  const members = await team(lead.client_id);

  const status = h('select', { name: 'status' },
    Object.entries(LEAD_STATUS).map(([v, l]) => h('option', { value: v, selected: lead.status === v }, l)));
  const when = h('input', { type: 'datetime-local', name: 'follow_up_at', value: toLocalInput(lead.follow_up_at) });
  const who = h('select', { name: 'assigned_to' },
    h('option', { value: '' }, 'Nadie todavía'),
    members.map((m) => h('option', { value: m.id, selected: lead.assigned_to === m.id }, m.name)));
  const note = h('textarea', { name: 'note', rows: 3, placeholder: 'Qué habéis hablado, qué queda pendiente…' });
  const error = h('p', { class: 'error' });
  const save = h('button', { class: 'btn primary', type: 'submit' }, 'Guardar');

  // Atajos: «Volver a llamar» sin fecha propone mañana a la misma hora.
  status.addEventListener('change', () => {
    if (status.value === 'callback' && !when.value) {
      const d = new Date(Date.now() + 86_400_000);
      d.setMinutes(0, 0, 0);
      when.value = toLocalInput(d.toISOString());
    }
  });

  const form = h('form', { class: 'form', onsubmit: submit },
    h('div', { class: 'grid2' },
      field('Estado', status),
      field('Volver a llamar el', when, 'Ese día le llega un aviso a quien lo lleva.'),
      field('Lo lleva', who)),
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
    lead.conversation_id && openConversation
      ? h('p', {}, h('button', { class: 'btn link', type: 'button', onclick: () => openConversation({ id: lead.conversation_id, started_at: lead.created_at }) }, 'Ver la conversación completa'))
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
    try {
      await q(db.rpc('update_lead', {
        p_id: lead.id, p_status: status.value, p_follow_up_at: followUp,
        p_assigned_to: who.value || null, p_note: note.value,
      }));
      Object.assign(lead, { status: status.value, follow_up_at: followUp, assigned_to: who.value || null });
      if (who.value) people.set(who.value, members.find((m) => m.id === who.value)?.name);
      toast('Guardado');
      onSaved();
      close();
    } catch (err) {
      error.textContent = errorText(err);
      save.disabled = false;
    }
  }
}
