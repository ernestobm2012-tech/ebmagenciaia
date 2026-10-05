// Gasto real de ElevenLabs (voz y LLM de los agentes), leído de su API desde la
// función eleven-usage. ElevenLabs lo da en céntimos de dólar.
import { db } from './app.js';
import { USD_TO_EUR } from './config.js';
import { h, table, kpi, fmtUsd, fmtEur, fmtNum, fmtDate } from './ui.js';

const LABELS = { 'Conversational AI': 'Voz y plataforma', 'Conversational AI - LLM': 'LLM (cerebro)' };
const label = (k) => LABELS[k] || k;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

export async function elevenUsageCard() {
  const box = h('div', { style: 'margin-top:28px' }, h('h2', {}, 'ElevenLabs: gasto real'), h('p', { class: 'muted' }, 'Cargando…'));
  const { data, error } = await db.functions.invoke('eleven-usage', { body: { days: 31 } });
  const fail = (msg) => box.replaceChildren(h('h2', {}, 'ElevenLabs: gasto real'), h('p', { class: 'error' }, msg));
  if (error || data?.error) return fail(data?.error || 'No se pudo leer el gasto de ElevenLabs.'), box;

  const types = Object.keys(data.usd);
  const monthStartMs = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1);
  const idx = data.time.map((t, i) => (t >= monthStartMs ? i : -1)).filter((i) => i >= 0);
  const usdDay = (i) => types.reduce((a, t) => a + (data.usd[t][i] || 0), 0) / 100;
  const minDay = (i) => Object.values(data.minutes).reduce((a, v) => a + (v[i] || 0), 0);
  const usdMonth = sum(idx.map(usdDay));
  const minMonth = sum(idx.map(minDay));
  const usdOf = (t) => sum(idx.map((i) => (data.usd[t][i] || 0) / 100));

  const rows = data.time.map((t, i) => ({ t, i })).filter(({ i }) => usdDay(i) > 0 || minDay(i) > 0).reverse().slice(0, 14);
  box.replaceChildren(
    h('h2', {}, 'ElevenLabs: gasto real'),
    h('div', { class: 'kpis' },
      kpi('Este mes', fmtUsd(usdMonth), `≈ ${fmtEur(usdMonth * USD_TO_EUR)} · lo que consume tu plan`),
      kpi('Minutos de voz', fmtNum(Math.round(minMonth)), 'este mes'),
      kpi('Por minuto', minMonth > 0 ? fmtUsd(usdOf('Conversational AI') / minMonth + usdOf('Conversational AI - LLM') / minMonth) : '—', 'voz + LLM, sin la telefonía'),
      ...types.filter((t) => usdOf(t) > 0).map((t) => kpi(label(t), fmtUsd(usdOf(t)), 'este mes'))),
    table([
      { label: 'Día', cell: (r) => fmtDate(r.t) },
      ...types.map((t) => ({ label: label(t), num: true, cell: (r) => fmtUsd((data.usd[t][r.i] || 0) / 100) })),
      { label: 'Total', num: true, cell: (r) => fmtUsd(usdDay(r.i)) },
      { label: 'Minutos', num: true, cell: (r) => fmtNum(Math.round(minDay(r.i) * 10) / 10) },
    ], rows, { empty: 'Sin consumo este mes.' }),
    h('p', { class: 'muted small' }, `Es el consumo que ElevenLabs contabiliza (la misma cifra de Analíticas → Solicitudes de API). Tu cuota mensual del plan se paga aparte, en Gastos. Cambio orientativo 1 $ = ${USD_TO_EUR} €.`));
  return box;
}
