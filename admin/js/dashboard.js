// Portada y estadísticas del panel del cliente: lo que tiene que hacer hoy y cómo va todo.
// Los datos son los contactos (leads) y el equipo del negocio; RLS decide qué llega.
// Con «#/?ejemplo» se enseñan datos de muestra (solo en el navegador, no se guarda nada).
import { db, session } from './app.js';
import { h, q, icon, fmtNum, toast } from './ui.js';
import { LEAD_STATUS, openLead } from './leads.js';
import { openConversation } from './activity.js';

const CLOSED = ['won', 'lost'];
const SVG = 'http://www.w3.org/2000/svg';

function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...children.flat().filter(Boolean));
  return el;
}

const pad = (n) => String(n).padStart(2, '0');
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)} %` : '—');
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const CHANNELS = { phone: 'Teléfono', web: 'Chat de la web', whatsapp: 'WhatsApp', instagram: 'Instagram', otro: 'Otro' };
const COLORS = ['#1483DC', '#17B8C2', '#8E5CC9', '#E07A1F', '#2FA36B', '#B8325A'];

function duration(ms) {
  if (ms == null) return '—';
  const hours = ms / 3_600_000;
  if (hours < 1) return `${Math.max(1, Math.round(ms / 60_000))} min`;
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${Math.round(hours / 24)} días`;
}

function ago(iso) {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 2) return 'ahora mismo';
  if (mins < 60) return `hace ${mins} min`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `hace ${hrs} h`;
  const days = Math.round(hrs / 24);
  return days === 1 ? 'ayer' : `hace ${days} días`;
}

// Lo que escribe el asistente en el motivo: «Llamar el jueves, 5 de noviembre, 09:30: Madrid (28936) · casa: …».
const cleanReason = (r) => (r || '').replace(/^Llamar el [^:]*\d{2}:\d{2}:\s*/i, '').replace(/^Cita reservada[^:]*:\s*/i, '');
function place(r) {
  const m = (r.reason || '').match(/([A-Za-zÁÉÍÓÚÜÑáéíóúüñ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ .'-]{1,40}?)\s*\((\d{5})\)/);
  return m ? m[1].trim() : null;
}
function kind(r) {
  const m = (r.reason || '').match(/·\s*(casa|negocio)\b/i);
  return m ? m[1].toLowerCase() : null;
}
const phoneOf = (r) => {
  const digits = (r.contact || '').replace(/[^\d+]/g, '');
  return digits.replace(/\D/g, '').length >= 9 ? digits : null;
};
const initials = (name) => (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

// ------------------------------------------------------------------ clasificación de los contactos
const isCalled = (r) => !!r.first_contact_at || ['called', 'waiting', 'with_sales', 'won', 'lost'].includes(r.status);
const isScheduled = (r) => isCalled(r) || !!r.follow_up_at;
const isPassed = (r) => !!r.seller_id || !!r.passed_at || r.status === 'with_sales';

function funnel(rows) {
  const stages = [
    { id: 'in', label: 'Contactos', icon: 'users', color: COLORS[0], n: rows.length },
    { id: 'sched', label: 'Llamadas agendadas', icon: 'cal', color: COLORS[1], n: rows.filter(isScheduled).length },
    { id: 'done', label: 'Llamadas hechas', icon: 'phone', color: COLORS[2], n: rows.filter(isCalled).length },
    { id: 'sales', label: 'Pasados al comercial', icon: 'target', color: COLORS[3], n: rows.filter(isPassed).length },
    { id: 'won', label: 'Ventas cerradas', icon: 'check', color: COLORS[4], n: rows.filter((r) => r.status === 'won').length },
  ];
  stages.forEach((s, i) => {
    s.of = i === 0 ? 100 : (stages[i - 1].n ? Math.round((s.n / stages[i - 1].n) * 100) : 0);
    s.hint = i === 0 ? 'de anuncios, web y teléfono'
      : `${s.of} % de ${['', 'los contactos', 'las agendadas', 'las hechas', 'los pasados'][i]}`;
  });
  return stages;
}

// ------------------------------------------------------------------ datos
async function load() {
  const clientId = session.client.id;
  if (/ejemplo/.test(location.hash)) return { ...sample(), sample: true };
  const [rows, members] = await Promise.all([
    q(db.from('leads').select('*, conversations(channel)').eq('client_id', clientId).order('created_at', { ascending: false }).limit(2000)),
    q(db.from('team_members').select('*').eq('client_id', clientId).order('name')).catch(() => []),
  ]);
  return { rows, members, sample: false };
}

// Datos de muestra con generador fijo: la misma vista cada vez, para enseñarla.
function sample() {
  let seed = 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const members = [
    { id: 'm1', name: 'Laura Méndez', role: 'llamadas', job_title: 'Teleoperadora', active: true, client_id: 'x' },
    { id: 'm2', name: 'Ángela López', role: 'llamadas', job_title: 'Teleoperadora', active: true, client_id: 'x' },
    { id: 'm3', name: 'Óscar López', role: 'comercial', job_title: 'Comercial', active: true, client_id: 'x' },
  ];
  const names = ['Marta García', 'Luis Romero', 'Carmen Pérez', 'Javier Molina', 'Rosa Lozano', 'Pedro Sanz', 'Elena Torres', 'Sergio Vidal', 'Daniel Ferrer', 'Lucía Ortega', 'Ana Navarro', 'Pablo Gil', 'Irene Castro', 'Diego Ramos', 'Nuria Prieto'];
  const places = [['Madrid', 28936], ['Madrid', 28942], ['Toledo', 45001], ['Guadalajara', 19001], ['Almería', 4100], ['Valencia', 46001], ['Sevilla', 41001], ['Madrid', 28001]];
  const hours = [9, 10, 10, 11, 12, 13, 16, 17, 18, 19, 20, 21, 22];
  const now = new Date();
  const rows = [];
  for (let i = 0; i < 142; i++) {
    const day = Math.floor(Math.pow(rnd(), 0.8) * 30);
    const d = new Date(now); d.setDate(d.getDate() - day); d.setHours(pick(hours), Math.floor(rnd() * 60), 0, 0);
    if (d > now) d.setTime(now.getTime() - 3_600_000 * (1 + rnd() * 5));
    const [city, cp] = pick(places);
    const roll = rnd();
    const status = day === 0 && roll < 0.5 ? 'new' : roll < 0.12 ? 'won' : roll < 0.22 ? 'lost' : roll < 0.42 ? 'with_sales' : roll < 0.7 ? 'called' : roll < 0.8 ? 'waiting' : 'callback';
    const caller = rnd() < 0.55 ? 'm1' : 'm2';
    const created = d.toISOString();
    rows.push({
      id: `s${i}`, client_id: 'x', name: pick(names), contact: `6${String(10000000 + Math.floor(rnd() * 89999999))}`,
      reason: `${city} (${String(cp).padStart(5, '0')}) · ${rnd() < 0.72 ? 'casa' : 'negocio'}: ${pick(['compra garrafas', 'bebe del grifo', 'usa jarra con filtro', 'familia de 4', 'quiere información'])}`,
      status, created_at: created, updated_at: created, caller_id: ['new'].includes(status) ? null : caller,
      seller_id: ['with_sales', 'won'].includes(status) ? 'm3' : null,
      first_contact_at: ['new', 'callback'].includes(status) ? null : new Date(d.getTime() + (8 + rnd() * 50) * 60_000).toISOString(),
      follow_up_at: null, deal_value: status === 'won' ? 1000 + Math.floor(rnd() * 2000) : null,
      conversations: { channel: pick(['whatsapp', 'whatsapp', 'whatsapp', 'web', 'phone']) },
    });
  }
  // Las llamadas de hoy.
  const today = [['Marta García', 'Fuenlabrada · Madrid (28942) · casa: compra garrafas', 10, 0], ['Luis Romero', 'Toledo (45001) · negocio: oficina de 12 personas', 10, 30],
    ['Carmen Pérez', 'Getafe · Madrid (28901) · casa: bebe del grifo', 11, 0], ['Javier Molina', 'Guadalajara (19001) · casa: familia de 4', 12, 0],
    ['Rosa Lozano', 'Almería (04100) · negocio: bar', 12, 30], ['Pedro Sanz', 'Illescas · Toledo (45200) · casa: usa jarra con filtro', 16, 0]];
  today.forEach(([name, reason, hh, mm], i) => {
    const f = new Date(now); f.setHours(hh, mm, 0, 0);
    rows.unshift({
      id: `t${i}`, client_id: 'x', name, contact: `6${String(20000000 + i * 1111111)}`, reason, status: 'callback',
      created_at: new Date(now.getTime() - 3_600_000 * (3 + i)).toISOString(), updated_at: new Date(now.getTime() - 3_600_000 * (2 + i)).toISOString(),
      caller_id: i % 2 ? 'm2' : 'm1', seller_id: null, first_contact_at: null, follow_up_at: f.toISOString(), deal_value: null,
      conversations: { channel: 'whatsapp' },
    });
  });
  return { rows, members };
}

const greeting = () => {
  const hr = new Date().getHours();
  return hr < 6 ? 'Buenas noches' : hr < 14 ? 'Buenos días' : hr < 21 ? 'Buenas tardes' : 'Buenas noches';
};
const firstName = () => {
  const n = (session.profile?.full_name || '').trim().split(/\s+/)[0] || '';
  return n ? n[0].toUpperCase() + n.slice(1).toLowerCase() : '';
};

function sampleBanner() {
  return h('div', { class: 'sample-banner' }, icon('target'), 'Estás viendo datos de ejemplo, solo para enseñar cómo queda. ',
    h('a', { href: '#/' }, 'Ver los míos'));
}

// ------------------------------------------------------------------ portada
export async function homeView() {
  const { rows, members, sample: isSample } = await load();
  const memberName = new Map(members.map((m) => [m.id, m.name]));
  const ctx = { members, memberName, openConversation: isSample ? null : openConversation, rows };

  const now = new Date();
  const endToday = new Date(now); endToday.setHours(23, 59, 59, 999);
  const todays = rows.filter((r) => !CLOSED.includes(r.status)
    && ((r.follow_up_at && new Date(r.follow_up_at) <= endToday) || r.status === 'new'))
    .sort((a, b) => (a.follow_up_at ? Date.parse(a.follow_up_at) : Infinity) - (b.follow_up_at ? Date.parse(b.follow_up_at) : Infinity));

  const last30 = rows.filter((r) => Date.parse(r.created_at) >= Date.now() - 30 * 86_400_000);
  const stages = funnel(last30);
  const prev30 = rows.filter((r) => { const t = Date.parse(r.created_at); return t < Date.now() - 30 * 86_400_000 && t >= Date.now() - 60 * 86_400_000; });
  const delta = prev30.length ? Math.round(((last30.length - prev30.length) / prev30.length) * 100) : null;

  const callList = h('div', { class: 'calls' });
  const redraw = () => {
    callList.replaceChildren(...(todays.length ? todays.map((r, i) => callCard(r, i, ctx, isSample, redraw)) : [
      h('div', { class: 'calls-empty' }, icon('check'), h('div', {}, h('b', {}, 'No hay nada pendiente para hoy'),
        h('div', { class: 'muted' }, 'Cuando entre un contacto o toque volver a llamar a alguien, aparecerá aquí.'))),
    ]));
  };
  redraw();

  const kpis = [
    { icon: 'users', color: COLORS[0], label: 'Contactos nuevos', n: stages[0].n, hint: delta == null ? 'últimos 30 días' : `${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta)} % que los 30 días anteriores`, good: delta == null || delta >= 0 },
    { icon: 'phone', color: COLORS[2], label: 'Llamadas hechas', n: stages[2].n, hint: `${stages[2].of} % de las agendadas`, good: true },
    { icon: 'target', color: COLORS[3], label: 'Pasados al comercial', n: stages[3].n, hint: `${stages[3].of} % de las llamadas`, good: true },
    { icon: 'check', color: COLORS[4], label: 'Ventas cerradas', n: stages[4].n, hint: `${stages[4].of} % de los pasados`, good: true },
  ];

  const events = rows.slice().sort((a, b) => Date.parse(b.updated_at || b.created_at) - Date.parse(a.updated_at || a.created_at)).slice(0, 7);
  const EVENT = { won: ['Venta cerrada', COLORS[4]], with_sales: ['Pasado al comercial', COLORS[2]], called: ['Llamada hecha', COLORS[1]], waiting: ['Esperando respuesta', COLORS[3]], callback: ['Llamada agendada', COLORS[3]], lost: ['No interesa', '#8A97A5'], new: ['Nuevo contacto', COLORS[0]], to_call: ['Pendiente de llamar', COLORS[0]] };

  const callsToday = todays.filter((r) => r.follow_up_at && sameDay(new Date(r.follow_up_at), now)).length;
  const dateText = new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long' }).format(now);
  return h('div', { class: 'page home' },
    h('h1', {}, `${greeting()}${firstName() ? `, ${firstName()}` : ''}`),
    h('p', { class: 'muted' }, `${dateText[0].toUpperCase()}${dateText.slice(1)} · ${callsToday ? `hoy hay ${callsToday} ${callsToday === 1 ? 'llamada' : 'llamadas'} para vuestro equipo` : 'hoy no hay llamadas agendadas'}`),
    isSample ? sampleBanner() : null,
    h('div', { class: 'home-grid' },
      h('section', { class: 'home-main' },
        h('div', { class: 'section-head' }, h('h2', {}, 'Hoy toca llamar'), h('span', { class: 'count' }, todays.length)),
        callList),
      h('section', { class: 'home-side' },
        h('div', { class: 'dkpis' }, kpis.map((k) => h('div', { class: 'dkpi' },
          h('span', { class: 'ico', style: `background:${k.color}` }, icon(k.icon)),
          h('div', {}, h('div', { class: 'lbl' }, k.label), h('div', { class: 'num' }, fmtNum(k.n)),
            h('div', { class: `hint${k.good ? ' up' : ' down'}` }, k.hint))))),
        h('div', { class: 'timeline' }, h('h3', {}, 'Lo último que ha pasado'),
          events.length ? events.map((r) => {
            const [text, color] = EVENT[r.status] || [LEAD_STATUS[r.status] || r.status, '#8A97A5'];
            return h('div', { class: 'ev' }, h('i', { style: `background:${color}` }),
              h('div', {}, h('b', {}, text), ` · ${r.name || r.contact || 'Contacto'}`,
                h('small', {}, `${ago(r.updated_at || r.created_at)}${r.caller_id && memberName.get(r.caller_id) ? ` · ${memberName.get(r.caller_id)}` : ''}`)));
          }) : h('p', { class: 'muted' }, 'Todavía no ha pasado nada.')))),
    h('p', { class: 'muted small tip' }, 'Toca un contacto para ver su ficha, apuntar lo que habéis hablado o cambiar la hora de la llamada.'));
}

function callCard(r, i, ctx, isSample, redraw) {
  const f = r.follow_up_at ? new Date(r.follow_up_at) : null;
  const late = f && f < new Date() && !sameDay(f, new Date());
  const time = f ? (late ? new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short' }).format(f) : hhmm(f)) : 'Nuevo';
  const phone = phoneOf(r);
  const open = () => (isSample ? toast('Esto es un ejemplo: con tus contactos se abre la ficha.') : openLead(r, ctx, redraw));
  return h('div', { class: `call${i === 0 ? ' first' : ''}`, onclick: open },
    h('div', { class: 'when' }, h('b', {}, time), h('small', {}, late ? 'atrasada' : f ? 'hoy' : 'sin llamar')),
    h('span', { class: 'avatar', style: `background:${COLORS[(r.name || '').length % COLORS.length]}` }, initials(r.name)),
    h('div', { class: 'person' }, h('b', {}, r.name || 'Sin nombre'),
      h('small', {}, [r.contact, cleanReason(r.reason)].filter(Boolean).join(' · '))),
    phone ? h('a', { class: `btn ${i === 0 ? 'primary' : 'soft'} call-btn`, href: `tel:${phone}`, onclick: (e) => e.stopPropagation() },
      icon('phone'), i === 0 ? 'Llamar ahora' : 'Llamar') : null,
    h('span', { class: 'btn soft call-btn' }, 'Ver ficha'));
}

// ------------------------------------------------------------------ estadísticas
const PERIODS = [
  { id: '7', label: '7 días', days: 7 },
  { id: '30', label: '30 días', days: 30 },
  { id: '90', label: '3 meses', days: 90 },
  { id: 'year', label: 'Este año' },
  { id: 'all', label: 'Todo' },
];

export async function statsView() {
  const { rows: all, members, sample: isSample } = await load();
  const page = h('div', { class: 'page stats' },
    h('h1', {}, 'Estadísticas'),
    h('p', { class: 'muted', id: 'stats-sub' }, ''),
    isSample ? sampleBanner() : null);
  const bar = h('div', { class: 'lead-filters' });
  const body = h('div', {});
  let period = PERIODS[1];

  function render() {
    bar.replaceChildren(...PERIODS.map((p) => h('button', { type: 'button', class: `chip${p === period ? ' on' : ''}`, onclick: () => { period = p; render(); } }, p.label)));
    const from = period.days ? Date.now() - period.days * 86_400_000
      : period.id === 'year' ? new Date(new Date().getFullYear(), 0, 1).getTime() : 0;
    const rows = all.filter((r) => Date.parse(r.created_at) >= from);
    page.querySelector('#stats-sub').textContent = rows.length
      ? 'Desde que entra el contacto hasta que se cierra la venta.'
      : 'Todavía no hay contactos en este periodo.';
    body.replaceChildren(rows.length ? report(rows, members, period) : h('p', { class: 'empty' }, 'Cuando entren contactos, aquí verás cómo van.'));
  }
  page.append(bar, body);
  render();
  return page;
}

function report(rows, members, period) {
  const stages = funnel(rows);
  const memberName = new Map(members.map((m) => [m.id, m.name]));
  const firstCall = avg(rows.filter((r) => r.first_contact_at).map((r) => Date.parse(r.first_contact_at) - Date.parse(r.created_at)));
  const value = rows.filter((r) => r.status === 'won').reduce((a, r) => a + (Number(r.deal_value) || 0), 0);

  // Quién llama.
  const ids = [...new Set(rows.map((r) => r.caller_id || ''))];
  const callers = ids.map((id) => {
    const mine = rows.filter((r) => (r.caller_id || '') === id);
    return { name: id ? (memberName.get(id) || '—') : 'Sin asignar', n: mine.length, called: mine.filter(isCalled).length };
  }).sort((a, b) => (a.name === 'Sin asignar') - (b.name === 'Sin asignar') || b.n - a.n);
  const maxCaller = Math.max(1, ...callers.map((c) => c.n));

  // De dónde llegan: provincia (del motivo) y canal.
  const tally = (fn) => {
    const m = new Map();
    rows.forEach((r) => { const k = fn(r); if (k) m.set(k, (m.get(k) || 0) + 1); });
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  const places = tally(place);
  const placedTotal = places.reduce((a, [, n]) => a + n, 0);
  const shownPlaces = places.slice(0, 7);
  const otherPlaces = places.slice(7).reduce((a, [, n]) => a + n, 0);
  const channels = tally((r) => CHANNELS[r.conversations?.channel || 'otro'] || 'Otro');
  const kinds = { casa: rows.filter((r) => kind(r) === 'casa').length, negocio: rows.filter((r) => kind(r) === 'negocio').length };
  const kindTotal = kinds.casa + kinds.negocio;

  return h('div', {},
    h('div', { class: 'funnel' }, stages.map((s) => h('div', { class: 'stage' },
      h('div', { class: 'l' }, h('span', { style: `color:${s.color}` }, icon(s.icon)), s.label),
      h('div', { class: 'n' }, fmtNum(s.n)),
      h('div', { class: 'bar' }, h('i', { style: `width:${Math.max(s.n ? 3 : 0, stages[0].n ? Math.round((s.n / stages[0].n) * 100) : 0)}%;background:${s.color}` })),
      h('div', { class: 'p', style: `color:${s.color}` }, s.hint)))),
    h('div', { class: 'cards2' },
      h('div', { class: 'card' },
        h('h3', {}, 'Quién llama'),
        callers.map((c, i) => hbar(c.name, c.n, maxCaller, COLORS[i % COLORS.length], `${c.called} llamados`)),
        h('div', { class: 'big-stat' }, h('h3', {}, 'Cuánto tardan en llamar'), h('div', { class: 'v' }, duration(firstCall)), h('small', {}, 'de media, desde que entra el contacto')),
        value ? h('div', { class: 'big-stat' }, h('h3', {}, 'Importe de las ventas'), h('div', { class: 'v' }, new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(value))) : null,
        h('h3', { class: 'spaced' }, period.days && period.days <= 45 ? 'Contactos por día' : 'Contactos por semana'),
        timeline(rows, period)),
      h('div', { class: 'card' },
        h('h3', {}, 'De dónde llegan'),
        placedTotal ? h('div', { class: 'tags' }, shownPlaces.map(([n, c]) => h('span', { class: 'tag' }, n, h('small', {}, c))),
          otherPlaces ? h('span', { class: 'tag' }, 'Otras', h('small', {}, otherPlaces)) : null)
          : h('p', { class: 'muted small' }, 'Todavía no hay datos de provincia.'),
        h('div', { class: 'chan' }, channels.map(([n, c], i) => hbar(n, c, channels[0][1], COLORS[i % COLORS.length], ''))),
        kindTotal ? [h('h3', { class: 'spaced' }, 'Casa o negocio'),
          h('div', { class: 'split' }, h('i', { style: `width:${(kinds.casa / kindTotal) * 100}%;background:${COLORS[0]}` }), h('i', { style: `width:${(kinds.negocio / kindTotal) * 100}%;background:#17D6E0` })),
          h('div', { class: 'split-l' }, h('span', {}, h('b', {}, 'Casa'), ` · ${kinds.casa} contactos`), h('span', {}, h('b', {}, 'Negocio'), ` · ${kinds.negocio} contactos`))] : null,
        h('h3', { class: 'spaced' }, 'A qué hora escriben'),
        hours(rows))));
}

function hbar(label, n, max, color, hint) {
  return h('div', { class: 'hb' }, h('span', { class: 'nm' }, label),
    h('div', { class: 'tr' }, h('i', { style: `width:${n ? Math.max(3, Math.round((n / max) * 100)) : 0}%;background:${color}` })),
    h('b', {}, fmtNum(n)), hint ? h('small', {}, hint) : null);
}

// Gráfico de área de contactos por día (o por semana si el periodo es largo).
function timeline(rows, period) {
  const weekly = !(period.days && period.days <= 45);
  const key = (iso) => {
    const d = new Date(iso); d.setHours(12, 0, 0, 0);
    if (weekly) d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const map = new Map();
  rows.forEach((r) => map.set(key(r.created_at), (map.get(key(r.created_at)) || 0) + 1));
  // Rellena los huecos para que la curva no engañe.
  const keys = [...map.keys()].sort();
  const series = [];
  if (keys.length) {
    const step = weekly ? 7 : 1;
    const d = new Date(`${keys[0]}T12:00:00`);
    const end = new Date(`${keys[keys.length - 1]}T12:00:00`);
    while (d <= end) { const k = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; series.push([k, map.get(k) || 0]); d.setDate(d.getDate() + step); }
  }
  if (series.length < 2) return h('p', { class: 'muted small' }, 'Se verá cuando haya contactos de varios días.');
  const w = 520, hh = 130, max = Math.max(1, ...series.map(([, n]) => n));
  const pts = series.map(([, n], i) => [(i / (series.length - 1)) * w, hh - (n / max) * (hh - 12) - 4]);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const fmt = (k) => new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short' }).format(new Date(`${k}T12:00:00`));
  return h('div', { class: 'area' },
    svg('svg', { viewBox: `0 0 ${w} ${hh + 4}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': 'Contactos a lo largo del tiempo' },
      svg('defs', {}, svg('linearGradient', { id: 'ag', x1: '0', y1: '0', x2: '0', y2: '1' },
        svg('stop', { offset: '0', 'stop-color': '#1483DC', 'stop-opacity': '.35' }), svg('stop', { offset: '1', 'stop-color': '#1483DC', 'stop-opacity': '0' }))),
      svg('path', { d: `${line} L${w},${hh} L0,${hh}Z`, fill: 'url(#ag)' }),
      svg('path', { d: line, fill: 'none', stroke: '#1483DC', 'stroke-width': '3', 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke' })),
    h('div', { class: 'area-x' }, h('span', {}, fmt(series[0][0])), h('span', {}, `máx. ${max}`), h('span', {}, fmt(series[series.length - 1][0]))));
}

function hours(rows) {
  const buckets = Array.from({ length: 24 }, () => 0);
  rows.forEach((r) => { buckets[new Date(r.created_at).getHours()]++; });
  const range = buckets.slice(8, 24);
  const max = Math.max(1, ...range);
  return h('div', {}, h('div', { class: 'hours' }, range.map((n, i) => h('i', { title: `${i + 8}:00 · ${n}`, style: `height:${Math.max(4, Math.round((n / max) * 100))}%;opacity:${(0.3 + 0.7 * (n / max)).toFixed(2)}` }))),
    h('div', { class: 'hours-x' }, ['8:00', '12:00', '16:00', '20:00', '23:00'].map((t) => h('span', {}, t))));
}
