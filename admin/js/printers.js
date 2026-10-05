// Lector de impresoras: copias mes a mes, coste por copia y tóner de cada impresora.
// Los datos los manda el lector (agente_lector.py) a la función printer-ingest.
import { db } from './app.js';
import { h, q, toast, errorText, fmtNum, fmtEur, fmtDate, fmtDateTime, modal, field } from './ui.js';

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const TONER = [['k', 'Negro'], ['c', 'Cian'], ['m', 'Magenta'], ['y', 'Amarillo']];
const TONER_NAME = { k: 'negro', c: 'cian', m: 'magenta', y: 'amarillo' };
const INSTALLER_URL = 'https://github.com/ernestobm2012-tech/ebmagenciaia/releases/download/lector/LectorImpresoras-Instalador.exe';
const MONTHS_SHOWN = 7;

// Códigos de aviso estándar de las impresoras (Printer MIB, RFC 3805) en palabras normales.
const ALERTS = {
  1: 'Aviso de la impresora', 2: 'Aviso desconocido', 3: 'Tapa abierta', 5: 'Cierre de seguridad abierto',
  8: 'Atasco de papel', 9: 'Falta una pieza', 10: 'Una pieza está casi gastada', 11: 'Una pieza está gastada',
  12: 'Algo está casi vacío', 13: 'Algo está vacío', 14: 'Algo está casi lleno', 15: 'Algo está lleno',
  16: 'Cerca del límite', 17: 'Ha llegado al límite', 18: 'Pieza abierta', 21: 'Pieza apagada', 22: 'Pieza desconectada',
  26: 'Han quitado una pieza', 29: 'Fallo que se puede arreglar', 30: 'Avería', 31: 'Error de almacenamiento',
  32: 'Fallo del motor', 33: 'Memoria llena', 34: 'Temperatura demasiado baja', 35: 'Temperatura demasiado alta',
  36: 'Fallo de sincronización', 37: 'Fallo del sensor de temperatura',
  501: 'Puerta abierta', 504: 'Impresora apagada',
  801: 'Falta una bandeja de papel', 802: 'Cambio de tamaño de papel', 807: 'Queda poco papel', 808: 'Sin papel',
  809: 'Pide cambiar el papel', 810: 'Pide meter papel a mano', 811: 'Bandeja mal colocada', 812: 'Fallo al subir la bandeja',
  813: 'No puede usar el tamaño de papel elegido',
  901: 'Falta la bandeja de salida', 902: 'Bandeja de salida casi llena', 903: 'Bandeja de salida llena',
  1001: 'Fusor frío', 1002: 'Fusor demasiado caliente', 1003: 'Fallo del fusor', 1004: 'Fallo del sensor del fusor',
  1005: 'Ajustando la calidad de impresión',
  1101: 'Tóner agotado', 1102: 'Tinta agotada', 1104: 'Queda poco tóner', 1105: 'Queda poca tinta',
  1107: 'Depósito de tóner usado casi lleno', 1109: 'Depósito de tóner usado lleno',
  1111: 'Tambor casi gastado', 1112: 'Tambor gastado', 1113: 'Queda poco revelador', 1114: 'Revelador agotado',
  1115: 'Falta el cartucho de tóner',
  1301: 'Falta una bandeja', 1302: 'Bandeja casi llena', 1303: 'Bandeja llena', 1304: 'No puede imprimir a doble cara este papel',
  1507: 'Falta un recurso para imprimir', 1509: 'Página muy compleja',
};
const alertText = (a) => ALERTS[a.code] || 'Aviso de la impresora';
const alertClass = (a) => (a.severity === 3 || [8, 13, 30, 32, 808, 1101, 1109, 1112, 1115].includes(a.code) ? 'pr-alert crit' : 'pr-alert');
const REFRESH_MS = 20_000;

const madridMonth = (d = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit' }).format(d);
function lastMonths(n) {
  const [y, m] = madridMonth().split('-').map(Number);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(y, m - 1 - (n - 1 - i), 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
}
const monthLabel = (k) => `${MESES[Number(k.slice(5)) - 1]} ${k.slice(2, 4)}`;
const price = (n) => Number(n) || 0;

function since(date) {
  const min = Math.round((Date.now() - new Date(date)) / 60_000);
  if (min < 1) return 'ahora mismo';
  if (min < 60) return `hace ${min} min`;
  if (min < 48 * 60) return `hace ${Math.round(min / 60)} h`;
  return `el ${fmtDate(date)}`;
}
const ago = (date) => (date ? `Leída ${since(date)}` : 'Sin lecturas todavía');

// Copias de cada mes = último contador del mes menos el último del mes anterior con datos
// (o el primero del mes si es el primer mes). Si la marca no separa b/n y color, todo cuenta como b/n.
function monthlyUse(rows) {
  const out = {};
  const byPrinter = {};
  for (const r of rows) (byPrinter[r.printer_id] ||= []).push(r);
  for (const [id, list] of Object.entries(byPrinter)) {
    list.sort((a, b) => (a.month < b.month ? -1 : 1));
    list.forEach((r, i) => {
      const prev = list[i - 1];
      const from = prev
        ? { bn: prev.last_bn, color: prev.last_color, total: prev.last_total }
        : { bn: r.first_bn, color: r.first_color, total: r.first_total };
      const split = r.last_bn != null && from.bn != null;
      const bn = split ? r.last_bn - from.bn : (r.last_total ?? 0) - (from.total ?? 0);
      const color = split && r.last_color != null && from.color != null ? r.last_color - from.color : 0;
      if (!prev && bn === 0 && color === 0) return;   // una sola lectura: aún no hay consumo
      (out[id] ||= {})[r.month.slice(0, 7)] = { bn: Math.max(0, bn), color: Math.max(0, color) };
    });
  }
  return out;
}

function chart(months, totals) {
  const W = 640, H = 240, L = 50, R = 8, T = 10, B = 28;
  const max = Math.max(0, ...months.map((k) => totals[k].bn + totals[k].color));
  const nice = (v) => {
    if (v <= 0) return 100;
    const p = 10 ** Math.floor(Math.log10(v)), f = v / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  };
  const top = nice(max), pw = W - L - R, ph = H - T - B, slot = pw / months.length, bw = Math.min(52, slot * 0.6);
  const y = (v) => T + ph - (v / top) * ph;
  const bar = (x, yy, w, hh, r) => {
    r = Math.min(r, hh, w / 2);
    return `M${x},${yy + hh}V${yy + r}Q${x},${yy} ${x + r},${yy}H${x + w - r}Q${x + w},${yy} ${x + w},${yy + r}V${yy + hh}Z`;
  };
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Copias por mes en blanco y negro y en color">`;
  for (let i = 0; i <= 4; i++) {
    const v = (top / 4) * i;
    svg += `<line class="pr-grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>`
      + `<text class="pr-axis" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${fmtNum(v)}</text>`;
  }
  months.forEach((k, i) => {
    const t = totals[k], cx = L + slot * (i + 0.5), x = cx - bw / 2;
    const hb = (t.bn / top) * ph, hc = (t.color / top) * ph;
    svg += `<g><title>${monthLabel(k)}: ${fmtNum(t.bn)} en blanco y negro y ${fmtNum(t.color)} en color</title>`;
    if (t.ok) {
      if (hb > 0) svg += `<path fill="var(--pr-bn)" d="${bar(x, y(0) - hb, bw, hb, hc > 0 ? 0 : 4)}"/>`;
      if (hc > 0) svg += `<path fill="var(--pr-color)" d="${bar(x, y(0) - hb - hc - (hb > 0 ? 2 : 0), bw, hc, 4)}"/>`;
    } else {
      svg += `<line x1="${cx - 10}" x2="${cx + 10}" y1="${y(0)}" y2="${y(0)}" stroke="var(--line)" stroke-width="2"/>`;
    }
    svg += `<text class="pr-axis" x="${cx}" y="${H - 8}" text-anchor="middle">${monthLabel(k)}</text></g>`;
  });
  const el = h('div', { class: 'pr-chart' });
  el.innerHTML = `${svg}</svg>`;   // solo números y nombres de mes: nada que venga de usuarios
  return el;
}

function tonerBars(t) {
  if (!t) return h('span', { class: 'muted small' }, 'Sin datos de tóner');
  return h('div', { class: 'pr-toner' }, TONER.filter(([k]) => t[k] != null).map(([k, name]) =>
    h('div', { class: 'pr-tn' }, h('span', {}, name),
      h('span', { class: 'pr-bar' }, h('span', { class: `pr-fill pr-${k}`, style: `width:${t[k]}%` })),
      h('span', { class: t[k] <= 15 ? 'warn' : null }, `${t[k]} %`))));
}

function priceInput(printer, col, onSaved, editable = true) {
  if (!editable) return new Intl.NumberFormat('es-ES', { maximumFractionDigits: 4 }).format(Number(printer[col]) || 0);
  return h('input', {
    type: 'number', min: 0, step: '0.001', class: 'pr-price', value: printer[col],
    'aria-label': col === 'price_bn_eur' ? 'Precio copia blanco y negro' : 'Precio copia color',
    onchange: async (e) => {
      try {
        const value = Math.max(0, Number(e.target.value) || 0);
        await q(db.from('printers').update({ [col]: value }).eq('id', printer.id));
        printer[col] = value;
        toast('Precio guardado.');
        onSaved();
      } catch (err) {
        toast(errorText(err), 'error');
      }
    },
  });
}

// Vista de las impresoras de uno o varios clientes. Se refresca sola mientras está en pantalla.
export async function printersView(clientIds, { clientNames, canEditPrices = true } = {}) {
  const holder = h('div', { class: 'pr' });
  const months = lastMonths(MONTHS_SHOWN);
  const since = `${months[0]}-01T00:00:00+01:00`;

  async function load() {
    const [printers, rows, events] = await Promise.all([
      q(db.from('printers').select('*').in('client_id', clientIds).order('created_at')),
      q(db.rpc('printer_months', { p_client_ids: clientIds, p_since: since })),
      q(db.from('printer_events').select('*').in('client_id', clientIds).order('started_at', { ascending: false }).limit(50)),
    ]);
    return { printers, use: monthlyUse(rows), events };
  }

  function render({ printers, use, events }) {
    if (!printers.length) {
      return holder.replaceChildren(h('div', { class: 'pr-empty' },
        h('p', {}, h('b', {}, 'Todavía no hay impresoras.')),
        h('p', { class: 'muted' }, 'En cuanto el lector mande la primera lectura, aparecerán aquí con sus contadores y su tóner.')));
    }
    const now = months[months.length - 1];
    const totals = Object.fromEntries(months.map((k) => [k, { bn: 0, color: 0, cost: 0, ok: false }]));
    for (const p of printers) {
      for (const k of months) {
        const u = use[p.id]?.[k];
        if (!u) continue;
        const t = totals[k];
        t.bn += u.bn; t.color += u.color; t.ok = true;
        t.cost += u.bn * price(p.price_bn_eur) + u.color * price(p.price_color_eur);
      }
    }
    const cur = totals[now];
    let low = null;
    for (const p of printers) for (const [k, v] of Object.entries(p.last_toner || {}))
      if (low == null || v < low.v) low = { v, k, p };
    const hasPrices = printers.some((p) => price(p.price_bn_eur) || price(p.price_color_eur));
    const rerender = () => render({ printers, use, events });
    const nameOf = Object.fromEntries(printers.map((p) => [p.id, p.name || p.model || 'Impresora']));
    const withAlerts = printers.filter((p) => (p.last_alerts || []).length || p.last_status === 5).length;

    holder.replaceChildren(
      h('div', { class: 'pr-kpis' },
        h('div', { class: 'pr-kpi' }, h('div', { class: 'pr-l' }, 'Copias este mes'),
          h('div', { class: 'pr-v' }, cur.ok ? fmtNum(cur.bn + cur.color) : '—'),
          h('div', { class: 'pr-n' }, cur.ok ? `${fmtNum(cur.bn)} en blanco y negro y ${fmtNum(cur.color)} en color`
            : 'Ya hay una primera lectura. Las copias salen a partir de la siguiente.')),
        h('div', { class: 'pr-kpi' }, h('div', { class: 'pr-l' }, 'Coste de este mes'),
          h('div', { class: 'pr-v' }, cur.ok && hasPrices ? fmtEur(cur.cost) : '—'),
          h('div', { class: 'pr-n' }, hasPrices ? 'Con el precio por copia de cada impresora' : 'Pon el precio por copia abajo, en cada impresora')),
        h('div', { class: 'pr-kpi' }, h('div', { class: 'pr-l' }, 'Impresoras'),
          h('div', { class: 'pr-v' }, String(printers.length)),
          h('div', { class: `pr-n${withAlerts ? ' warn' : ''}` }, withAlerts ? `${withAlerts} con avisos ahora mismo` : [...new Set(printers.map((p) => p.brand).filter(Boolean))].join(', ') || '—')),
        h('div', { class: 'pr-kpi' }, h('div', { class: 'pr-l' }, 'Lo que menos tóner tiene'),
          h('div', { class: `pr-v${low && low.v <= 15 ? ' warn' : ''}` }, low ? `${low.v} %` : '—'),
          h('div', { class: 'pr-n' }, low ? `El ${TONER_NAME[low.k]} de ${low.p.name || low.p.model || 'la impresora'}${low.v <= 15 ? ': queda poco' : ''}` : 'Sin datos todavía'))),

      h('h2', {}, 'Copias mes a mes'),
      h('p', { class: 'muted small' }, 'Cada mes sale de restar el contador del mes anterior. Pasa el dedo o el ratón por una barra para ver el detalle.'),
      h('div', { class: 'pr-legend' },
        h('span', {}, h('i', { class: 'pr-sw pr-swbn' }), 'Blanco y negro'),
        h('span', {}, h('i', { class: 'pr-sw pr-swcolor' }), 'Color')),
      chart(months, totals),

      h('h2', {}, 'Cada impresora'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'pr-table' },
        h('thead', {}, h('tr', {},
          h('th', {}, 'Impresora'), h('th', { class: 'num' }, 'Contador b/n'), h('th', { class: 'num' }, 'Contador color'),
          h('th', { class: 'num' }, 'Este mes'), h('th', { class: 'num' }, 'Precio b/n (€)'), h('th', { class: 'num' }, 'Precio color (€)'),
          h('th', { class: 'num' }, 'Cuesta este mes'), h('th', {}, 'Tóner'))),
        h('tbody', {}, printers.map((p) => {
          const u = use[p.id]?.[now];
          const live = p.last_read_at && Date.now() - new Date(p.last_read_at) < 15 * 60_000;
          return h('tr', {},
            h('td', {},
              h('div', { class: 'pr-name' }, p.name || p.model || 'Impresora'),
              h('div', { class: 'muted small' }, [p.name ? p.model : null, p.serial && !p.serial.startsWith('ip-') ? `Serie ${p.serial}` : null, p.ip].filter(Boolean).join(' · ')),
              clientNames && clientNames[p.client_id] ? h('div', { class: 'muted small' }, clientNames[p.client_id]) : null,
              h('div', { class: 'muted small' }, live ? h('span', { class: 'pr-live' }) : null, ago(p.last_read_at)),
              p.last_status === 5 ? h('div', { class: 'pr-alert crit' }, 'Parada') : null,
              (p.last_alerts || []).map((a) => h('div', { class: alertClass(a), title: a.description || '' },
                alertText(a), a.description && !ALERTS[a.code] ? `: ${a.description}` : '', h('span', { class: 'pr-code' }, ` · código ${a.code}`)))),
            h('td', { class: 'num' }, p.last_bn != null ? fmtNum(p.last_bn) : '—'),
            h('td', { class: 'num' }, p.last_color != null ? fmtNum(p.last_color) : '—'),
            h('td', { class: 'num' }, u ? fmtNum(u.bn + u.color) : '—'),
            h('td', { class: 'num' }, priceInput(p, 'price_bn_eur', rerender, canEditPrices)),
            h('td', { class: 'num' }, priceInput(p, 'price_color_eur', rerender, canEditPrices)),
            h('td', { class: 'num pr-name' }, u ? fmtEur(u.bn * price(p.price_bn_eur) + u.color * price(p.price_color_eur)) : '—'),
            h('td', {}, tonerBars(p.last_toner)));
        })))),
      h('h2', {}, 'Avisos y errores'),
      h('p', { class: 'muted small' }, 'Lo que han avisado las impresoras, con la hora en que empezó y en que se resolvió.'),
      events.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'pr-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Cuándo'), h('th', {}, 'Impresora'), h('th', {}, 'Qué pasa'), h('th', {}, 'Estado'))),
        h('tbody', {}, events.map((e) => h('tr', {},
          h('td', {}, fmtDateTime(e.started_at)),
          h('td', {}, nameOf[e.printer_id] || 'Impresora'),
          h('td', {}, h('span', { class: e.ended_at ? null : 'pr-name' }, alertText(e)),
            e.description ? h('div', { class: 'muted small' }, e.description) : null,
            h('div', { class: 'muted small' }, `Código ${e.code}`)),
          h('td', {}, e.ended_at ? h('span', { class: 'muted' }, `Resuelto el ${fmtDateTime(e.ended_at)}`) : h('span', { class: 'warn' }, 'Sigue activo')))))))
        : h('p', { class: 'muted' }, 'Ningún aviso por ahora. Aquí saldrán los atascos, la falta de papel o de tóner y las averías, con su fecha y hora.'),
      h('p', { class: 'muted small', style: 'margin-top:16px' },
        'El lector solo mira los contadores y el tóner, nunca los documentos. Esta página se actualiza sola cada 20 segundos.'));
  }

  render(await load());
  const timer = setInterval(async () => {
    if (!holder.isConnected) return clearInterval(timer);
    if (document.hidden || holder.contains(document.activeElement)) return;
    try { render(await load()); } catch { /* se reintenta en la siguiente vuelta */ }
  }, REFRESH_MS);
  return holder;
}

// Solo administración: claves del lector de un cliente.
export async function printerKeysCard(clientId) {
  const box = h('div', { class: 'pr-keys' });
  async function draw() {
    const keys = await q(db.from('printer_keys').select('*').eq('client_id', clientId).order('created_at'));
    box.replaceChildren(
      h('h2', {}, 'Claves del lector'),
      h('p', { class: 'muted small' }, 'Cada lector instalado en la red del cliente usa una clave para mandar las lecturas a este panel. Si se pierde un ordenador, desactiva su clave.'),
      keys.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'pr-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Nombre'), h('th', {}, 'Creada'), h('th', {}, 'Último envío'), h('th', {}, ''))),
        h('tbody', {}, keys.map((k) => h('tr', {},
          h('td', {}, k.label, k.active ? null : h('span', { class: 'muted small' }, ' (desactivada)')),
          h('td', {}, fmtDate(k.created_at)),
          h('td', {}, k.last_used_at ? since(k.last_used_at) : 'Nunca'),
          h('td', {}, h('button', { class: 'btn link', type: 'button', onclick: () => toggle(k) }, k.active ? 'Desactivar' : 'Activar'))))))) : null,
      h('button', { class: 'btn primary', type: 'button', onclick: create }, 'Crear clave del lector'));
  }
  async function toggle(k) {
    try {
      await q(db.from('printer_keys').update({ active: !k.active }).eq('id', k.id));
      draw();
    } catch (err) { toast(errorText(err), 'error'); }
  }
  function create() {
    const label = h('input', { name: 'label', required: true, placeholder: 'Oficina principal' });
    const form = h('form', { class: 'form', onsubmit: async (e) => {
      e.preventDefault();
      try {
        const token = await q(db.rpc('create_printer_key', { p_client_id: clientId, p_label: label.value }));
        close();
        showToken(token);
        draw();
      } catch (err) { toast(errorText(err), 'error'); }
    } }, field('Dónde se va a instalar', label), h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Crear')));
    const close = modal('Nueva clave del lector', form);
  }
  function showToken(token) {
    const copy = async () => {
      try { await navigator.clipboard.writeText(token); toast('Clave copiada.'); } catch { toast('Selecciónala y cópiala a mano.', 'error'); }
    };
    modal('Clave del lector', h('div', {},
      h('p', {}, h('b', {}, 'Guárdala ahora: por seguridad no se vuelve a mostrar.'), ' Mándatela por WhatsApp o correo para tenerla a mano.'),
      h('pre', { class: 'mono pr-token' }, token),
      h('button', { class: 'btn', type: 'button', onclick: copy }, 'Copiar la clave'),
      h('h3', { style: 'margin-top:20px' }, 'Cómo se instala en el ordenador del cliente'),
      h('ol', { class: 'pr-steps' },
        h('li', {}, 'Descarga el instalador: ', h('a', { href: INSTALLER_URL }, 'LectorImpresoras-Instalador.exe'), '.'),
        h('li', {}, 'Ábrelo. Si Windows avisa de que «protegió el equipo», pulsa «Más información» y luego «Ejecutar de todas formas».'),
        h('li', {}, 'Pulsa Siguiente, pega esta clave y termina.'),
        h('li', {}, 'Listo: el lector se queda funcionando solo y arranca cada vez que se enciende el ordenador. En unos minutos salen aquí las impresoras.')),
      h('p', { class: 'muted small' }, 'El ordenador tiene que estar en la misma red (wifi o cable) que las impresoras.')));
  }
  await draw();
  return box;
}
