// Estadísticas: visitas a la web pública y usos de cada demo, por día.
// Los datos salen de las funciones admin_web_stats y admin_demo_stats (solo administración).
import { db } from './app.js';
import { h, q, table, kpi, fmtNum } from './ui.js';

// Cada demo tiene un agente de voz y otro de texto (ids de ElevenLabs que usa demo-token).
const DEMOS = [
  { name: 'Clínica (Lucía)', voice: 'agent_2101m3yte6h9f6xv8t1vete5mf6f', text: 'agent_3701m40awp7ve56vd8282v8annz2' },
  { name: 'Peluquería (Nadia)', voice: 'agent_5101m3ytfp7defkaczw68cfd7a3n', text: 'agent_4001m40awq3nf5qtjd9ek5mehxs0' },
  { name: 'Restaurante (Marta)', voice: 'agent_5101m3yvx1j2fe489r97yg42b1ky', text: 'agent_4601m40awr0gezr9pj4m0vkfat27' },
  { name: 'Taller (Javi)', voice: 'agent_9701m3yvwygvexrvekyp23sf9wkf', text: 'agent_3201m40awsbyef59dhptnhvedc67' },
];

const madridDay = (offset = 0) => {
  const d = new Date(Date.now() - offset * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(d);
};
const lastDays = (n) => Array.from({ length: n }, (_, i) => madridDay(i));
const dayLabel = (day) => new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: '2-digit', month: 'short' })
  .format(new Date(`${day}T12:00:00`));
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

function bar(value, max) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return h('span', { style: `display:inline-block;height:8px;width:${value ? pct : 0}%;min-width:${value ? 3 : 0}px;background:#1483DC;border-radius:4px;vertical-align:middle` });
}

function section(title, hint, ...children) {
  return h('section', { style: 'margin-top:28px' }, h('h2', {}, title), hint ? h('p', { class: 'muted small' }, hint) : null, ...children);
}

function webSection(web) {
  const byDay = Object.fromEntries((web.daily || []).map((d) => [d.day, d]));
  const get = (day) => byDay[day] || { visits: 0, people: 0 };
  const days14 = lastDays(14);
  const range = (n) => lastDays(n).map(get);
  const max = Math.max(1, ...days14.map((d) => get(d).visits));
  const [today, yesterday] = [get(madridDay(0)), get(madridDay(1))];
  const w7 = range(7);
  const w30 = range(30);
  return section('Web pública', 'Visitas a ebmagenciaia.es sin cookies ni IP. «Personas» cuenta navegadores distintos cada día (si alguien vuelve otro día, cuenta de nuevo). No cuenta robots ni el panel.',
    h('div', { class: 'kpis' },
      kpi('Hoy', fmtNum(today.visits), `${fmtNum(today.people)} personas`),
      kpi('Ayer', fmtNum(yesterday.visits), `${fmtNum(yesterday.people)} personas`),
      kpi('Últimos 7 días', fmtNum(sum(w7.map((d) => d.visits))), `${fmtNum(sum(w7.map((d) => d.people)))} personas-día`),
      kpi('Últimos 30 días', fmtNum(sum(w30.map((d) => d.visits))), `${fmtNum(sum(w30.map((d) => d.people)))} personas-día`)),
    table([
      { label: 'Día', cell: (r) => dayLabel(r) },
      { label: 'Visitas', num: true, cell: (r) => fmtNum(get(r).visits) },
      { label: 'Personas', num: true, cell: (r) => fmtNum(get(r).people) },
      { label: '', cell: (r) => bar(get(r).visits, max) },
    ], days14),
    h('div', { class: 'grid2', style: 'margin-top:20px' },
      h('div', {}, h('h3', {}, 'Páginas más vistas (30 días)'),
        table([
          { label: 'Página', cell: (r) => r.path },
          { label: 'Visitas', num: true, cell: (r) => fmtNum(r.visits) },
        ], web.pages || [], { empty: 'Aún no hay visitas.' })),
      h('div', {}, h('h3', {}, 'De dónde vienen (30 días)'),
        table([
          { label: 'Origen', cell: (r) => r.ref },
          { label: 'Visitas', num: true, cell: (r) => fmtNum(r.visits) },
        ], web.referrers || [], { empty: 'Aún no hay visitas.' }),
        h('h3', { style: 'margin-top:16px' }, 'Dispositivos (30 días)'),
        table([
          { label: 'Tipo', cell: (r) => r.device },
          { label: 'Visitas', num: true, cell: (r) => fmtNum(r.visits) },
        ], web.devices || [], { empty: 'Aún no hay visitas.' }))));
}

function demosSection(rows) {
  const key = (day, agent, kind) => `${day}|${agent}|${kind}`;
  const m = {};
  for (const r of rows) m[key(r.day, r.agent_id, r.kind)] = r;
  const starts = (day, agent, kind) => m[key(day, agent, kind)]?.starts || 0;
  const people = (day, agent, kind) => m[key(day, agent, kind)]?.people || 0;
  const cell = (day, d) => {
    const v = starts(day, d.voice, 'voice');
    const t = starts(day, d.text, 'text');
    return v || t ? `${v} voz · ${t} texto` : '—';
  };
  const days14 = lastDays(14);
  const days30 = lastDays(30);
  const total = (days, kind) => sum(days.flatMap((day) => DEMOS.map((d) => starts(day, kind === 'voice' ? d.voice : d.text, kind))));
  const today = madridDay(0);
  return section('Demos de la web', 'Cada vez que alguien empieza una demo cuenta un uso. «Personas» son navegadores distintos por día.',
    h('div', { class: 'kpis' },
      kpi('Hoy · voz', fmtNum(total([today], 'voice')), 'llamadas de demo'),
      kpi('Hoy · texto', fmtNum(total([today], 'text')), 'chats de demo'),
      kpi('7 días · voz', fmtNum(total(days14.slice(0, 7), 'voice')), 'llamadas de demo'),
      kpi('7 días · texto', fmtNum(total(days14.slice(0, 7), 'text')), 'chats de demo')),
    table([
      { label: 'Día', cell: (r) => dayLabel(r) },
      ...DEMOS.map((d) => ({ label: d.name, num: true, cell: (r) => cell(r, d) })),
      { label: 'Total', num: true, cell: (r) => fmtNum(sum(DEMOS.map((d) => starts(r, d.voice, 'voice') + starts(r, d.text, 'text')))) },
    ], days14),
    h('h3', { style: 'margin-top:20px' }, 'Últimos 30 días, por demo'),
    table([
      { label: 'Demo', cell: (d) => d.name },
      { label: 'Voz (usos)', num: true, cell: (d) => fmtNum(sum(days30.map((day) => starts(day, d.voice, 'voice')))) },
      { label: 'Voz (personas)', num: true, cell: (d) => fmtNum(sum(days30.map((day) => people(day, d.voice, 'voice')))) },
      { label: 'Texto (usos)', num: true, cell: (d) => fmtNum(sum(days30.map((day) => starts(day, d.text, 'text')))) },
      { label: 'Texto (personas)', num: true, cell: (d) => fmtNum(sum(days30.map((day) => people(day, d.text, 'text')))) },
    ], DEMOS));
}

export async function statsPage() {
  const wrap = h('div', { class: 'page' }, h('h1', {}, 'Estadísticas'), h('p', { class: 'muted' }, 'Cargando…'));
  try {
    const [web, demos] = await Promise.all([
      q(db.rpc('admin_web_stats', { p_days: 30 })),
      q(db.rpc('admin_demo_stats', { p_days: 30 })),
    ]);
    wrap.replaceChildren(h('h1', {}, 'Estadísticas'),
      h('p', { class: 'muted' }, 'Quién entra en la web pública y cuánto se usa cada demo. Se actualiza cada vez que abres esta pantalla.'),
      webSection(web), demosSection(demos));
  } catch (err) {
    wrap.replaceChildren(h('h1', {}, 'Estadísticas'), h('p', { class: 'error' }, 'No se pudieron cargar las estadísticas.'));
  }
  return wrap;
}
