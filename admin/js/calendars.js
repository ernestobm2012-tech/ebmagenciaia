// Calendarios de cada cliente: los que necesite (uno por persona, sala,
// servicio…), su agenda y el enlace con Google/Outlook en los dos sentidos.
// Lo usan el admin (pestaña del cliente) y el propio cliente (su menú).
import { db } from './app.js';
import { SUPABASE_URL } from './config.js';
import { h, q, field, modal, toast, formData, errorText } from './ui.js';

const DAYS_SHOWN = 14;
const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/calendar`;
const COLORS = ['#1483DC', '#7C9A44', '#E07A1F', '#C24545', '#8E5CC9', '#17A2B8', '#5E6C7A'];
// Tipos de cita con los que empieza cada negocio (colores comprobados para que se
// distingan también con daltonismo). Cada negocio los cambia en «Tipos y colores».
const DEFAULT_TYPES = [
  ['Cliente nuevo', '#1483DC', true],
  ['Segunda llamada', '#D9A400'],
  ['Segunda visita', '#8E5CC9'],
  ['Instalación', '#2FA36B'],
  ['Seguimiento', '#E07A1F'],
  ['Técnico / RMA', '#B8325A'],
];
const TYPE_COLORS = ['#1483DC', '#D9A400', '#8E5CC9', '#2FA36B', '#E07A1F', '#B8325A', '#17A2B8', '#5E6C7A'];

const feedUrl = (cal) => `${FUNCTION_URL}?feed=${cal.feed_token}`;
const WEEKDAYS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const RANGE = /^([01]?\d|2[0-3]):[0-5]\d-([01]?\d|2[0-4]):[0-5]\d$/;

// "09:00-14:00, 16:30-21:30" -> ["09:00-14:00", "16:30-21:30"]; null si algún tramo está mal.
function parseRanges(text) {
  const parts = (text || '').split(/[,;]/).map((t) => t.replace(/\s/g, '')).filter(Boolean);
  if (parts.some((t) => !RANGE.test(t))) return null;
  const mins = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
  if (parts.some((t) => { const [a, b] = t.split('-'); return mins(b) <= mins(a); })) return null;
  return parts;
}

// Vuelta de Google tras conectar una cuenta: se avisa y se limpia la dirección.
const GOOGLE_RESULT = {
  conectado: ['Calendario conectado con Google. Desde ahora se sincroniza al momento.', 'ok'],
  cancelado: ['Has cancelado la conexión con Google.', 'error'],
  'sin-permiso': ['Hay que marcar la casilla de permiso del calendario. Vuelve a intentarlo.', 'error'],
  error: ['No se pudo conectar con Google. Inténtalo otra vez en unos minutos.', 'error'],
};
const OUTLOOK_RESULT = {
  conectado: ['Calendario conectado con Outlook. Desde ahora se sincroniza al momento.', 'ok'],
  cancelado: ['Has cancelado la conexión con Outlook.', 'error'],
  'sin-permiso': ['Hay que aceptar el permiso del calendario. Vuelve a intentarlo.', 'error'],
  'otro-proveedor': ['Este calendario ya está conectado con Google. Desconéctalo primero.', 'error'],
  error: ['No se pudo conectar con Outlook. Inténtalo otra vez en unos minutos.', 'error'],
};
const outlookResult = new URLSearchParams(location.search).get('outlook');
if (outlookResult) {
  const url = new URL(location.href);
  url.searchParams.delete('outlook');
  history.replaceState(null, '', url);
  const [text, kind] = OUTLOOK_RESULT[outlookResult] || OUTLOOK_RESULT.error;
  setTimeout(() => toast(text, kind), 800);
}
const googleResult = new URLSearchParams(location.search).get('google');
if (googleResult) {
  const url = new URL(location.href);
  url.searchParams.delete('google');
  history.replaceState(null, '', url);
  const [text, kind] = GOOGLE_RESULT[googleResult] || GOOGLE_RESULT.error;
  setTimeout(() => toast(text, kind), 800);
}

async function callOutlook(action, body) {
  const { data, error } = await db.functions.invoke(`microsoft-calendar?action=${action}`, { body });
  if (error) {
    const detail = await error.context?.json?.().catch(() => null);
    throw new Error(detail?.error || error.message);
  }
  return data;
}

async function callGoogle(action, body) {
  const { data, error } = await db.functions.invoke(`google-calendar?action=${action}`, { body });
  if (error) {
    const detail = await error.context?.json?.().catch(() => null);
    throw new Error(detail?.error || error.message);
  }
  return data;
}
const pad = (n) => String(n).padStart(2, '0');
const dateInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeInput = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
// Fecha y hora de los campos del formulario, en la hora local del navegador.
const fromInputs = (date, time = '00:00') => {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm);
};

const dayFmt = new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
const wdFmt = new Intl.DateTimeFormat('es-ES', { weekday: 'short' });
const monthFmt = new Intl.DateTimeFormat('es-ES', { month: 'long', year: 'numeric' });
const shortFmt = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short' });
const HOUR_PX = 60;
const VIEW_KEY = 'ebm-cal-view';
const VIEWS = [['day', 'Día'], ['week', 'Semana'], ['month', 'Mes'], ['list', 'Lista']];
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const toMinutes = (hhmm) => { const [hh, mm] = hhmm.split(':').map(Number); return hh * 60 + mm; };
const mondayOf = (d) => addDays(startOfDay(d), -((d.getDay() + 6) % 7));
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);

// En el móvil se empieza por el día; en el ordenador, por la semana.
function readView() {
  let saved = null;
  try { saved = localStorage.getItem(VIEW_KEY); } catch { /* sin almacenamiento */ }
  if (VIEWS.some(([v]) => v === saved)) return saved;
  return window.matchMedia?.('(max-width: 700px)').matches ? 'day' : 'week';
}

// Días que abarca cada vista: [desde, hasta).
function rangeOf(view, anchor) {
  if (view === 'day') return [anchor, addDays(anchor, 1)];
  if (view === 'week') { const s = mondayOf(anchor); return [s, addDays(s, 7)]; }
  if (view === 'month') {
    const s = mondayOf(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
    const e = addDays(mondayOf(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0)), 7);
    return [s, e];
  }
  return [anchor, addDays(anchor, DAYS_SHOWN)];
}

function titleOf(view, anchor, from, to) {
  if (view === 'day') return cap(dayFmt.format(anchor));
  if (view === 'month') return cap(monthFmt.format(anchor));
  const last = addDays(to, -1);
  return `${shortFmt.format(from)} – ${shortFmt.format(last)} ${last.getFullYear()}`;
}
const timeFmt = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' });
const agoFmt = new Intl.RelativeTimeFormat('es-ES', { numeric: 'auto' });

function ago(when) {
  if (!when) return 'nunca';
  const min = Math.round((new Date(when) - Date.now()) / 60_000);
  if (Math.abs(min) < 60) return agoFmt.format(min, 'minute');
  if (Math.abs(min) < 1440) return agoFmt.format(Math.round(min / 60), 'hour');
  return agoFmt.format(Math.round(min / 1440), 'day');
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Enlace copiado.');
  } catch {
    toast('No he podido copiarlo. Mantén pulsado el texto para copiarlo.', 'error');
  }
}

// clientId: el cliente cuyos calendarios se gestionan.
export async function calendarsTab(clientId) {
  const wrap = h('div', { class: 'calendars' });
  // Día de referencia de la vista y vista elegida (se recuerda en este navegador).
  let anchor = startOfDay(new Date());
  let view = readView();
  let calendars = [];
  let types = [];
  const hidden = new Set();
  const hiddenTypes = new Set();

  async function load() {
    [calendars, types] = await Promise.all([
      q(db.from('calendars').select('*').eq('client_id', clientId).order('created_at')),
      q(db.from('appointment_types').select('*').eq('client_id', clientId).order('sort')).catch(() => []),
    ]);
    // La primera vez, los tipos de cita de ejemplo (luego cada negocio los cambia).
    if (!types.length && calendars.length) {
      try {
        types = await q(db.from('appointment_types').insert(DEFAULT_TYPES.map(([name, color, def], i) =>
          ({ client_id: clientId, name, color, sort: i, is_default: !!def }))).select('*'));
      } catch { types = []; }
    }
    await render();
  }

  async function render() {
    const [from, to] = rangeOf(view, anchor);
    const visible = calendars.filter((c) => !hidden.has(c.id)).map((c) => c.id);
    const events = visible.length
      ? await q(db.from('calendar_events').select('*').in('calendar_id', visible)
        .lt('starts_at', to.toISOString()).gt('ends_at', from.toISOString()).order('starts_at').limit(2000))
      : [];

    wrap.replaceChildren(
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn primary', type: 'button', onclick: () => editCalendar() }, 'Nuevo calendario'),
        ...(calendars.length ? [h('button', { class: 'btn', type: 'button', onclick: () => editEvent() }, 'Nueva cita')] : [])),
      calendars.length
        ? h('div', { class: 'cal-list' }, calendars.map(calendarCard))
        : h('p', { class: 'empty' }, 'Todavía no hay calendarios. Crea uno por cada persona, sala o servicio que tenga agenda propia.'),
      ...(calendars.length ? [agenda(events, from, to)] : []));
  }

  function calendarCard(cal) {
    const status = cal.google_account
      ? (cal.sync_error ? `Google: ${cal.sync_error}` : `Conectado con Google (${cal.google_account}) · al momento`)
      : cal.microsoft_account
      ? (cal.sync_error ? `Outlook: ${cal.sync_error}` : `Conectado con Outlook (${cal.microsoft_account}) · al momento`)
      : !cal.ics_import_url
        ? 'Sin enlazar con Google/Outlook'
        : cal.sync_error ? `Error al traerlo: ${cal.sync_error}` : `Traído de Google/Outlook ${ago(cal.last_synced_at)}`;
    return h('div', { class: `cal-card${cal.active ? '' : ' off'}` },
      h('label', { class: 'cal-name' },
        h('input', { type: 'checkbox', checked: !hidden.has(cal.id), onchange: (e) => {
          e.target.checked ? hidden.delete(cal.id) : hidden.add(cal.id);
          render();
        } }),
        h('span', { class: 'dot', style: `background:${cal.color}` }),
        h('strong', {}, cal.name), cal.active ? null : h('span', { class: 'muted small' }, ' (apagado)')),
      cal.booking_enabled ? h('div', { class: 'small muted' }, `El agente reserva citas de ${cal.booking_minutes} min`) : null,
      h('div', { class: `small ${cal.sync_error ? 'error' : 'muted'}` }, status),
      h('div', { class: 'cal-actions' },
        cal.google_account ? [
          h('button', { class: 'btn link', type: 'button', onclick: () => googlePull(cal) }, 'Traer ahora'),
          h('button', { class: 'btn link danger', type: 'button', onclick: () => googleDisconnect(cal) }, 'Desconectar Google'),
        ] : cal.microsoft_account ? [
          h('button', { class: 'btn link', type: 'button', onclick: () => outlookPull(cal) }, 'Traer ahora'),
          h('button', { class: 'btn link danger', type: 'button', onclick: () => outlookDisconnect(cal) }, 'Desconectar Outlook'),
        ] : [
          h('button', { class: 'btn small-primary', type: 'button', onclick: () => googleConnect(cal) }, 'Conectar con Google'),
          h('button', { class: 'btn small-primary', type: 'button', onclick: () => outlookConnect(cal) }, 'Conectar con Outlook'),
          h('button', { class: 'btn link', type: 'button', onclick: () => linkCalendar(cal) }, 'iPhone u otro (enlace)'),
          cal.ics_import_url ? h('button', { class: 'btn link', type: 'button', onclick: () => syncNow(cal) }, 'Traer ahora') : null,
        ],
        h('button', { class: 'btn link', type: 'button', onclick: () => editCalendar(cal) }, 'Editar')));
  }

  // ------------------------------------------------------------ Google directo
  async function googleConnect(cal) {
    toast('Abriendo Google…');
    try {
      const { url } = await callGoogle('connect', { calendar_id: cal.id, return_url: location.href });
      location.href = url;
    } catch (err) {
      toast(errorText(err), 'error');
    }
  }

  async function googlePull(cal) {
    toast('Trayendo de Google…');
    try {
      const { changed } = await callGoogle('pull', { calendar_id: cal.id });
      toast(changed ? `Listo: ${changed} cambios traídos.` : 'Listo: ya estaba al día.');
    } catch (err) {
      toast(errorText(err), 'error');
    }
    load();
  }

  async function googleDisconnect(cal) {
    if (!confirm(`¿Desconectar "${cal.name}" de Google (${cal.google_account})? Las citas de Google dejarán de verse aquí; las creadas en el panel se quedan.`)) return;
    try {
      await callGoogle('disconnect', { calendar_id: cal.id });
      toast('Desconectado de Google.');
    } catch (err) {
      toast(errorText(err), 'error');
    }
    load();
  }

  // ------------------------------------------------------------ Outlook directo
  async function outlookConnect(cal) {
    toast('Abriendo Outlook…');
    try {
      const { url } = await callOutlook('connect', { calendar_id: cal.id, return_url: location.href });
      location.href = url;
    } catch (err) {
      toast(errorText(err), 'error');
    }
  }

  async function outlookPull(cal) {
    toast('Trayendo de Outlook…');
    try {
      const { changed } = await callOutlook('pull', { calendar_id: cal.id });
      toast(changed ? `Listo: ${changed} cambios traídos.` : 'Listo: ya estaba al día.');
    } catch (err) {
      toast(errorText(err), 'error');
    }
    load();
  }

  async function outlookDisconnect(cal) {
    if (!confirm(`¿Desconectar "${cal.name}" de Outlook (${cal.microsoft_account})? Las citas de Outlook dejarán de verse aquí; las creadas en el panel se quedan.`)) return;
    try {
      await callOutlook('disconnect', { calendar_id: cal.id });
      toast('Desconectado de Outlook.');
    } catch (err) {
      toast(errorText(err), 'error');
    }
    load();
  }

  // Color de una cita: el de su tipo; si no tiene, las del agente van con el tipo por
  // defecto y el resto con el color de su calendario.
  function typeOf(e) {
    return types.find((t) => t.id === e.type_id) || (e.source === 'agent' ? types.find((t) => t.is_default) : null) || null;
  }
  const colorOf = (e, cal) => typeOf(e)?.color || cal?.color || '#5E6C7A';
  const typeKey = (e) => typeOf(e)?.id || 'none';

  // ------------------------------------------------------------ agenda: día, semana, mes y lista
  function go(dir) {
    if (view === 'day') anchor = addDays(anchor, dir);
    else if (view === 'week') anchor = addDays(anchor, 7 * dir);
    else if (view === 'month') anchor = new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1);
    else anchor = addDays(anchor, DAYS_SHOWN * dir);
    render();
  }
  function setView(v, day = null) {
    view = v;
    if (day) anchor = startOfDay(day);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* sin almacenamiento: da igual */ }
    render();
  }

  function agenda(allEvents, from, to) {
    const byCal = Object.fromEntries(calendars.map((c) => [c.id, c]));
    const events = allEvents.filter((e) => !hiddenTypes.has(typeKey(e)));
    const untyped = allEvents.some((e) => typeKey(e) === 'none');
    const shown = calendars.filter((c) => !hidden.has(c.id));
    const body = view === 'month' ? monthGrid(events, byCal, from, to)
      : view === 'list' ? listView(events, byCal, from, to)
      : timeGrid(events, byCal, shown, view === 'day' ? [from] : Array.from({ length: 7 }, (_, i) => addDays(from, i)));
    const hasHours = shown.some((c) => c.booking_enabled && Object.keys(c.booking_hours || {}).length);
    return h('div', { class: 'agenda-wrap' },
      h('div', { class: 'agenda-nav' },
        h('div', { class: 'agenda-move' },
          h('button', { class: 'btn', type: 'button', 'aria-label': 'Anterior', onclick: () => go(-1) }, '‹'),
          h('button', { class: 'btn', type: 'button', onclick: () => { anchor = startOfDay(new Date()); render(); } }, 'Hoy'),
          h('button', { class: 'btn', type: 'button', 'aria-label': 'Siguiente', onclick: () => go(1) }, '›')),
        h('strong', { class: 'agenda-title' }, titleOf(view, anchor, from, to)),
        h('div', { class: 'agenda-views' }, VIEWS.map(([v, label]) =>
          h('button', { type: 'button', class: `seg${v === view ? ' on' : ''}`, onclick: () => setView(v) }, label)))),
      legend(untyped),
      hasHours && (view === 'day' || view === 'week')
        ? h('p', { class: 'muted small agenda-legend' }, h('span', { class: 'swatch-avail' }), 'Horario en el que se pueden dar citas. Toca un hueco para crear una cita a esa hora.')
        : h('p', { class: 'muted small agenda-legend' }, view === 'month' ? 'Toca un día para verlo por horas.' : view === 'list' ? '' : 'Toca un hueco para crear una cita a esa hora.'),
      body);
  }

  // Leyenda de colores: tocar un tipo lo oculta o lo vuelve a enseñar.
  function legend(untyped) {
    const item = (key, name, color) => h('button', {
      type: 'button', class: `type-pill${hiddenTypes.has(key) ? ' off' : ''}`, style: `--c:${color}`,
      title: hiddenTypes.has(key) ? 'Volver a enseñar' : 'Ocultar este tipo',
      onclick: () => { hiddenTypes.has(key) ? hiddenTypes.delete(key) : hiddenTypes.add(key); render(); },
    }, h('i', {}), name);
    return h('div', { class: 'type-legend' },
      types.map((t) => item(t.id, t.name, t.color)),
      ...(untyped ? [item('none', 'Sin tipo (color del calendario)', '#9AA7B4')] : []),
      h('button', { class: 'btn link small', type: 'button', onclick: editTypes }, 'Tipos y colores'));
  }

  function editTypes() {
    const rows = types.map((t) => ({ ...t }));
    const list = h('div', { class: 'type-edit' });
    const note = h('p', { class: 'error' });
    function draw() {
      list.replaceChildren(...rows.map((t, i) => h('div', { class: 'type-row' },
        h('input', { type: 'color', value: t.color, oninput: (e) => { t.color = e.target.value; } }),
        h('input', { value: t.name, placeholder: 'Nombre del tipo', oninput: (e) => { t.name = e.target.value; } }),
        h('label', { class: 'check small', title: 'Las citas que reserva el asistente salen con este color' },
          h('input', { type: 'radio', name: 'def', checked: !!t.is_default, onchange: () => { rows.forEach((r) => { r.is_default = r === t; }); } }), ' Asistente'),
        h('button', { class: 'btn link danger', type: 'button', onclick: () => { rows.splice(i, 1); draw(); } }, 'Quitar'))),
      h('div', { class: 'swatches' }, h('span', { class: 'muted small' }, 'Colores sugeridos: '),
        TYPE_COLORS.map((c) => h('button', { type: 'button', class: 'swatch', style: `background:${c}`, title: c, onclick: () => {
          rows.push({ name: '', color: c, sort: rows.length, is_default: false, client_id: clientId });
          draw();
          list.querySelector('.type-row:last-of-type input:not([type])')?.focus();
        } }))));
    }
    async function save() {
      note.textContent = '';
      if (rows.some((r) => !r.name.trim())) return (note.textContent = 'Pon nombre a todos los tipos (o quita los que sobren).');
      try {
        const keep = rows.filter((r) => r.id).map((r) => r.id);
        const gone = types.filter((t) => !keep.includes(t.id)).map((t) => t.id);
        if (gone.length) await q(db.from('appointment_types').delete().in('id', gone));
        for (const [i, r] of rows.entries()) {
          const row = { name: r.name.trim(), color: r.color, sort: i, is_default: !!r.is_default };
          if (r.id) await q(db.from('appointment_types').update(row).eq('id', r.id));
          else await q(db.from('appointment_types').insert({ ...row, client_id: clientId }));
        }
        close();
        toast('Tipos de cita guardados.');
        load();
      } catch (err) {
        note.textContent = errorText(err);
      }
    }
    draw();
    const close = modal('Tipos de cita y colores', h('div', { class: 'form' },
      h('p', { class: 'muted' }, 'Cada cita se pinta del color de su tipo, para ver de un vistazo cómo está la agenda. Toca un color sugerido para añadir un tipo nuevo.'),
      list,
      h('button', { class: 'btn', type: 'button', onclick: () => { rows.push({ name: '', color: TYPE_COLORS[rows.length % TYPE_COLORS.length], is_default: false }); draw(); } }, 'Añadir tipo'),
      note,
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'button', onclick: save }, 'Guardar'))));
  }

  // Cuadrícula por horas (Día y Semana).
  function timeGrid(events, byCal, shown, days) {
    const timed = events.filter((e) => !e.all_day);
    const allDay = events.filter((e) => e.all_day);
    // Horas visibles: de 8 a 21 como mínimo, ampliadas al horario de citas y a las citas que haya.
    let first = 8;
    let last = 21;
    for (const c of shown) {
      if (!c.booking_enabled) continue;
      for (const ranges of Object.values(c.booking_hours || {})) {
        for (const r of ranges) {
          const [a, b] = r.split('-').map(toMinutes);
          first = Math.min(first, Math.floor(a / 60));
          last = Math.max(last, Math.ceil(b / 60));
        }
      }
    }
    for (const e of timed) {
      const st = new Date(e.starts_at);
      const en = new Date(e.ends_at);
      if (days.some((d) => sameDay(d, st))) first = Math.min(first, st.getHours());
      if (days.some((d) => sameDay(d, en))) last = Math.max(last, en.getHours() + (en.getMinutes() ? 1 : 0));
    }
    first = Math.max(0, first);
    last = Math.min(24, Math.max(last, first + 1));
    const height = (last - first) * HOUR_PX;
    const today = startOfDay(new Date());

    const head = h('div', { class: 'tg-row tg-head' }, h('div', { class: 'tg-corner' }),
      days.map((d) => h('button', {
        type: 'button', class: `tg-day${sameDay(d, today) ? ' today' : ''}`, title: 'Ver este día',
        onclick: () => setView('day', d),
      }, h('span', { class: 'tg-wd' }, wdFmt.format(d)), h('span', { class: 'tg-num' }, d.getDate()))));

    const allRow = allDay.length ? h('div', { class: 'tg-row tg-all' }, h('div', { class: 'tg-corner tg-allday small muted' }, 'Todo el día'),
      days.map((d) => h('div', { class: 'tg-allcell' },
        allDay.filter((e) => new Date(e.starts_at) < addDays(d, 1) && new Date(e.ends_at) > d)
          .map((e) => chip(e, byCal[e.calendar_id]))))) : '';

    const hours = h('div', { class: 'tg-hours', style: `height:${height}px` },
      Array.from({ length: last - first }, (_, i) => h('span', { style: `top:${i * HOUR_PX}px` }, `${pad(first + i)}:00`)));

    const cols = days.map((d) => {
      const col = h('div', { class: `tg-col${sameDay(d, today) ? ' today' : ''}`, style: `height:${height}px;--hour:${HOUR_PX}px` });
      // Horario de citas de los calendarios que se ven.
      const dow = String(((d.getDay() + 6) % 7) + 1);
      for (const c of shown) {
        if (!c.booking_enabled) continue;
        for (const r of c.booking_hours?.[dow] || []) {
          const [a, b] = r.split('-').map(toMinutes);
          const top = ((a - first * 60) / 60) * HOUR_PX;
          col.append(h('div', { class: 'tg-avail', style: `top:${top}px;height:${((b - a) / 60) * HOUR_PX}px` }));
        }
      }
      // Tocar un hueco: cita nueva a esa hora (en tramos de 30 minutos).
      col.addEventListener('click', (ev) => {
        if (ev.target !== col && !ev.target.classList.contains('tg-avail')) return;
        const y = ev.clientY - col.getBoundingClientRect().top;
        const mins = first * 60 + Math.floor((y / HOUR_PX) * 2) * 30;
        editEvent(null, new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(mins / 60), mins % 60));
      });
      // Citas del día, en columnas si se pisan.
      const next = addDays(d, 1);
      const items = timed.filter((e) => new Date(e.starts_at) < next && new Date(e.ends_at) > d)
        .map((e) => ({ e, s: Math.max(+new Date(e.starts_at), +d), en: Math.min(+new Date(e.ends_at), +next) }))
        .sort((a, b) => a.s - b.s || b.en - a.en);
      const lanes = [];
      for (const it of items) {
        let lane = lanes.findIndex((end) => end <= it.s);
        if (lane === -1) { lane = lanes.length; lanes.push(0); }
        lanes[lane] = it.en;
        it.lane = lane;
      }
      for (const it of items) {
        const overlap = items.filter((o) => o.s < it.en && o.en > it.s);
        it.cols = Math.max(...overlap.map((o) => o.lane)) + 1;
      }
      for (const it of items) {
        const startMin = (it.s - +d) / 60_000;
        const endMin = (it.en - +d) / 60_000;
        const top = Math.max(0, ((startMin - first * 60) / 60) * HOUR_PX);
        const bottom = Math.min(height, ((endMin - first * 60) / 60) * HOUR_PX);
        const cal = byCal[it.e.calendar_id];
        const short = bottom - top < 40;
        const roomy = bottom - top >= 72;
        col.append(h('button', {
          type: 'button', class: `tg-event${short ? ' short' : ''}`,
          style: `top:${top}px;height:${Math.max(18, bottom - top - 2)}px;left:calc(${(it.lane / it.cols) * 100}% + 2px);width:calc(${100 / it.cols}% - 4px);--c:${colorOf(it.e, cal)}`,
          title: `${timeFmt.format(new Date(it.e.starts_at))} – ${timeFmt.format(new Date(it.e.ends_at))} · ${it.e.title}${typeOf(it.e) ? ` · ${typeOf(it.e).name}` : ''}${cal ? ` · ${cal.name}` : ''}`,
          onclick: () => editEvent(it.e),
        },
        h('span', { class: 'tg-ev-time' }, timeFmt.format(new Date(it.e.starts_at))),
        h('span', { class: 'tg-ev-title' }, it.e.title),
        roomy ? h('span', { class: 'tg-ev-cal' }, h('i', { style: `background:${cal?.color || '#5E6C7A'}` }), [typeOf(it.e)?.name, cal?.name].filter(Boolean).join(' · ')) : ''));
      }
      // Línea de la hora actual.
      if (sameDay(d, today)) {
        const now = new Date();
        const m = now.getHours() * 60 + now.getMinutes();
        if (m >= first * 60 && m <= last * 60) col.append(h('div', { class: 'tg-now', style: `top:${((m - first * 60) / 60) * HOUR_PX}px` }));
      }
      return col;
    });

    const grid = h('div', { class: `tg${days.length === 1 ? ' tg-single' : ''}`, style: `--days:${days.length}` },
      h('div', { class: 'tg-top' }, head, allRow), h('div', { class: 'tg-row tg-body' }, hours, cols));
    const scroller = h('div', { class: 'tg-scroll' }, grid);
    // Al abrir, se baja hasta la hora actual o la primera cita.
    requestAnimationFrame(() => {
      const ref = days.some((d) => sameDay(d, today)) ? new Date().getHours() - 1 : first;
      scroller.scrollTop = Math.max(0, (ref - first) * HOUR_PX);
    });
    return scroller;
  }

  function chip(e, cal) {
    return h('button', { type: 'button', class: 'mg-chip', style: `--c:${colorOf(e, cal)}`, title: `${e.title}${typeOf(e) ? ` · ${typeOf(e).name}` : ''}${cal ? ` · ${cal.name}` : ''}`, onclick: (ev) => { ev.stopPropagation(); editEvent(e); } },
      e.all_day ? '' : h('span', { class: 'mg-time' }, timeFmt.format(new Date(e.starts_at))),
      h('span', { class: 'mg-title' }, e.title));
  }

  // Mes completo.
  function monthGrid(events, byCal, from, to) {
    const month = anchor.getMonth();
    const today = startOfDay(new Date());
    const cells = [];
    for (let d = from; d < to; d = addDays(d, 1)) {
      const next = addDays(d, 1);
      const items = events.filter((e) => new Date(e.starts_at) < next && new Date(e.ends_at) > d)
        .sort((a, b) => (b.all_day - a.all_day) || (new Date(a.starts_at) - new Date(b.starts_at)));
      const day = d;
      cells.push(h('div', {
        class: `mg-cell${d.getMonth() !== month ? ' out' : ''}${sameDay(d, today) ? ' today' : ''}`,
        onclick: () => setView('day', day),
      },
      h('span', { class: 'mg-num' }, d.getDate()),
      h('div', { class: 'mg-items' }, items.slice(0, 3).map((e) => chip(e, byCal[e.calendar_id]))),
      items.length > 3 ? h('span', { class: 'mg-more' }, `+${items.length - 3} más`) : '',
      items.length ? h('span', { class: 'mg-dots' }, items.slice(0, 4).map((e) => h('i', { style: `background:${colorOf(e, byCal[e.calendar_id])}` }))) : ''));
    }
    return h('div', { class: 'mg' },
      ['L', 'M', 'X', 'J', 'V', 'S', 'D'].map((x) => h('div', { class: 'mg-wd' }, x)),
      cells);
  }

  // Lista de días (la vista de antes).
  function listView(events, byCal, from, to) {
    const days = [];
    for (let d = from; d < to; d = addDays(d, 1)) {
      const next = addDays(d, 1);
      const items = events.filter((e) => new Date(e.starts_at) < next && new Date(e.ends_at) > d);
      days.push(h('div', { class: 'day' },
        h('div', { class: 'day-head' }, dayFmt.format(d),
          h('button', { class: 'btn link small', type: 'button', onclick: () => editEvent(null, d) }, '+ cita')),
        items.length
          ? items.map((e) => eventRow(e, byCal[e.calendar_id], d))
          : h('div', { class: 'muted small day-empty' }, 'Libre')));
    }
    return h('div', { class: 'agenda' }, days);
  }

  function eventRow(e, cal, day) {
    const s = new Date(e.starts_at);
    const en = new Date(e.ends_at);
    const when = e.all_day ? 'Todo el día'
      : s < day ? `hasta ${timeFmt.format(en)}` : `${timeFmt.format(s)} – ${timeFmt.format(en)}`;
    const origin = { import: 'Enlace', google: 'Google', microsoft: 'Outlook', agent: 'Agente' }[e.source];
    return h('button', { class: 'event', type: 'button', style: `border-left-color:${colorOf(e, cal)}`, onclick: () => editEvent(e) },
      h('span', { class: 'event-time' }, when),
      h('span', { class: 'event-title' }, e.title),
      h('span', { class: 'muted small' }, [typeOf(e)?.name, cal?.name, origin].filter(Boolean).join(' · ')));
  }

  // ------------------------------------------------------------ calendarios
  function editCalendar(cal = null) {
    const note = h('p', { class: 'error' });
    const color = cal?.color || COLORS[calendars.length % COLORS.length];
    const form = h('form', { class: 'form', onsubmit: save },
      field('Nombre', h('input', { name: 'name', required: true, value: cal?.name || '', placeholder: 'Ej.: Agenda de Beatriz, Sala 1, Reformas' })),
      field('Color', h('input', { name: 'color', type: 'color', value: color })),
      cal ? h('label', { class: 'check' }, h('input', { name: 'active', type: 'checkbox', checked: cal.active }),
        ' Activo (apagado deja de sincronizarse y de verse en Google/Outlook)') : null,
      h('h3', {}, 'Citas que reserva el agente'),
      h('label', { class: 'check' }, h('input', { name: 'booking_enabled', type: 'checkbox', checked: !!cal?.booking_enabled }),
        ' El agente puede reservar citas en este calendario'),
      h('div', { class: 'grid2' },
        field('Duración de cada cita (min)', h('input', { name: 'booking_minutes', type: 'number', min: 10, max: 240, step: 5, value: cal?.booking_minutes ?? 30 })),
        field('Antelación mínima (horas)', h('input', { name: 'booking_notice_hours', type: 'number', min: 0, max: 168, step: 1, value: Math.round((cal?.booking_notice_minutes ?? 120) / 60) }))),
      h('p', { class: 'muted small' }, 'Horario en el que se pueden reservar citas. Ej.: 16:30-21:30. Dos tramos: 09:00-14:00, 16:30-21:30. Vacío = ese día no.'),
      h('div', { class: 'grid2' }, WEEKDAYS.map((name, i) =>
        field(name, h('input', { name: `hours_${i + 1}`, placeholder: 'cerrado', value: (cal?.booking_hours?.[String(i + 1)] || []).join(', ') })))),
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', type: 'submit' }, cal ? 'Guardar' : 'Crear calendario'),
        cal ? h('span', { class: 'spacer' }) : null,
        cal ? h('button', { class: 'btn danger', type: 'button', onclick: remove }, 'Borrar') : null),
      note);

    async function save(e) {
      e.preventDefault();
      const f = formData(form);
      const hours = {};
      for (let i = 1; i <= 7; i++) {
        const ranges = parseRanges(f[`hours_${i}`]);
        if (!ranges) return (note.textContent = `Revisa el horario del ${WEEKDAYS[i - 1].toLowerCase()}: escribe tramos como 16:30-21:30.`);
        if (ranges.length) hours[i] = ranges;
        delete f[`hours_${i}`];
      }
      if (f.booking_enabled && !Object.keys(hours).length) return (note.textContent = 'Para reservar citas, pon el horario de al menos un día.');
      const data = {
        ...f, booking_hours: hours,
        booking_minutes: Math.min(240, Math.max(10, f.booking_minutes || 30)),
        booking_notice_minutes: Math.min(168, Math.max(0, f.booking_notice_hours || 0)) * 60,
      };
      delete data.booking_notice_hours;
      try {
        if (cal) await q(db.from('calendars').update(data).eq('id', cal.id));
        else await q(db.from('calendars').insert({ ...data, client_id: clientId }));
        close();
        toast(cal ? 'Calendario guardado.' : 'Calendario creado.');
        load();
      } catch (err) {
        note.textContent = errorText(err);
      }
    }

    async function remove() {
      if (!confirm(`¿Borrar el calendario "${cal.name}" y todas sus citas? No se puede deshacer.`)) return;
      try {
        await q(db.from('calendars').delete().eq('id', cal.id));
        close();
        toast('Calendario borrado.');
        load();
      } catch (err) {
        note.textContent = errorText(err);
      }
    }

    const close = modal(cal ? 'Editar calendario' : 'Nuevo calendario', form);
  }

  function linkCalendar(cal) {
    const note = h('p', { class: 'error' });
    const out = h('input', { readonly: true, value: feedUrl(cal), class: 'mono', onclick: (e) => e.target.select() });
    const input = h('input', { type: 'url', value: cal.ics_import_url || '', placeholder: 'https://calendar.google.com/calendar/ical/…/basic.ics' });

    const saveImport = async () => {
      const value = input.value.trim() || null;
      if (value && !/^(https|webcal):\/\//i.test(value)) return (note.textContent = 'Tiene que empezar por https:// o webcal://');
      try {
        await q(db.from('calendars').update({ ics_import_url: value }).eq('id', cal.id));
        cal.ics_import_url = value;
        close();
        if (value) await syncNow(cal);
        else { toast('Enlace quitado.'); load(); }
      } catch (err) {
        note.textContent = errorText(err);
      }
    };

    const newToken = async () => {
      if (!confirm('El enlace actual dejará de funcionar y habrá que volver a añadir el nuevo en Google/Outlook. ¿Seguir?')) return;
      try {
        cal.feed_token = await q(db.rpc('new_calendar_feed_token', { p_calendar: cal.id }));
        out.value = feedUrl(cal);
        toast('Enlace nuevo creado.');
      } catch (err) {
        note.textContent = errorText(err);
      }
    };

    const close = modal(`Enlazar "${cal.name}"`, h('div', { class: 'form' },
      h('h3', {}, '1. Ver estas citas en Google u Outlook'),
      h('p', { class: 'muted small' }, 'Copia este enlace y añádelo como calendario por URL. Es privado: quien lo tenga ve las citas, no lo publiques.'),
      out,
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', type: 'button', onclick: () => copy(out.value) }, 'Copiar enlace'),
        h('button', { class: 'btn link danger', type: 'button', onclick: newToken }, 'Cambiar enlace')),
      h('ul', { class: 'steps small' },
        h('li', {}, h('strong', {}, 'Google Calendar: '), 'en calendar.google.com (en el móvil, en el navegador con "versión de ordenador"), a la izquierda en "Otros calendarios" pulsa + → "Desde URL", pega el enlace y "Añadir calendario".'),
        h('li', {}, h('strong', {}, 'Outlook: '), 'en outlook.com o Outlook, "Agregar calendario" → "Suscribirse desde la Web", pega el enlace e "Importar".'),
        h('li', {}, h('strong', {}, 'iPhone: '), 'Ajustes → Calendario → Cuentas → Añadir cuenta → Otra → "Añadir calendario suscrito".'),
        h('li', { class: 'muted' }, 'Google y Outlook actualizan estos calendarios cada pocas horas (Google puede tardar hasta un día). Para ver un cambio al momento, mira esta agenda.')),
      h('h3', {}, '2. Traer aquí las citas de Google u Outlook'),
      h('p', { class: 'muted small' }, 'Así el agente sabe cuándo está ocupado. Se trae cada 15 minutos.'),
      field('Dirección iCal secreta', input),
      h('ul', { class: 'steps small' },
        h('li', {}, h('strong', {}, 'Google Calendar: '), 'en calendar.google.com, en el calendario → ⋮ → "Configuración y uso compartido" → "Integrar el calendario" → copia la "Dirección secreta en formato iCal".'),
        h('li', {}, h('strong', {}, 'Outlook: '), 'Configuración → Calendario → Calendarios compartidos → "Publicar un calendario" → elige el calendario y "Puede ver todos los detalles" → Publicar → copia el enlace ICS.')),
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', type: 'button', onclick: saveImport }, 'Guardar y traer'),
        cal.ics_import_url ? h('button', { class: 'btn danger', type: 'button', onclick: () => { input.value = ''; saveImport(); } }, 'Quitar') : null),
      note), { wide: true });
  }

  async function syncNow(cal) {
    toast('Trayendo el calendario…');
    try {
      const { data, error } = await db.functions.invoke('calendar', { body: { calendar_id: cal.id } });
      if (error) {
        const body = await error.context?.json?.().catch(() => null);
        throw new Error(body?.error || error.message);
      }
      const result = data?.synced?.[0];
      if (result?.error) toast(result.error, 'error');
      else toast(`Listo: ${result?.events ?? 0} citas traídas.`);
    } catch (err) {
      toast(errorText(err), 'error');
    }
    load();
  }

  // ------------------------------------------------------------ citas
  function editEvent(ev = null, day = null) {
    if (ev?.source === 'import') return showImported(ev);
    const note = h('p', { class: 'error' });
    const start = ev ? new Date(ev.starts_at)
      : day ? (day.getHours() || day.getMinutes() ? new Date(day) : new Date(day.getFullYear(), day.getMonth(), day.getDate(), 10))
      : new Date(new Date().setMinutes(0, 0, 0) + 3_600_000);
    const end = ev ? new Date(ev.ends_at) : new Date(start.getTime() + 3_600_000);
    const lastDay = ev?.all_day ? addDays(new Date(ev.ends_at), -1) : start;

    const allDay = h('input', { name: 'all_day', type: 'checkbox', checked: !!ev?.all_day, onchange: toggle });
    const times = h('div', { class: 'grid2' },
      field('Empieza', h('input', { name: 'start_time', type: 'time', value: timeInput(start) })),
      field('Termina', h('input', { name: 'end_time', type: 'time', value: timeInput(end) })));
    const until = field('Hasta el día', h('input', { name: 'end_date', type: 'date', value: dateInput(lastDay) }));
    function toggle() {
      times.hidden = allDay.checked;
      until.hidden = !allDay.checked;
    }

    let typeId = ev?.type_id || '';
    const typePick = h('div', { class: 'type-pick' });
    const drawTypes = () => typePick.replaceChildren(
      ...types.map((t) => h('button', {
        type: 'button', class: `type-pill${typeId === t.id ? ' on' : ''}`, style: `--c:${t.color}`,
        onclick: () => { typeId = typeId === t.id ? '' : t.id; drawTypes(); },
      }, h('i', {}), t.name)),
      h('button', { type: 'button', class: 'btn link small', onclick: () => { close(); editTypes(); } }, 'Tipos y colores'));
    drawTypes();

    const form = h('form', { class: 'form', onsubmit: save },
      ...(types.length ? [h('div', { class: 'field' }, h('span', {}, 'Tipo de cita'), typePick)] : []),
      field('Calendario', h('select', { name: 'calendar_id', required: true },
        calendars.filter((c) => c.active || c.id === ev?.calendar_id).map((c) =>
          h('option', { value: c.id, selected: c.id === (ev?.calendar_id || calendars.find((x) => !hidden.has(x.id))?.id) }, c.name)))),
      field('Título', h('input', { name: 'title', required: true, value: ev?.title || '', placeholder: 'Ej.: Cumpleaños de Lucas · familia García' })),
      field('Día', h('input', { name: 'date', type: 'date', required: true, value: dateInput(start) })),
      h('label', { class: 'check' }, allDay, ' Todo el día'),
      times, until,
      field('Lugar', h('input', { name: 'location', value: ev?.location || '' })),
      field('Notas', h('textarea', { name: 'description', rows: 3 }, ev?.description || '')),
      ev?.source === 'agent' ? h('p', { class: 'muted small' }, 'Esta cita la creó el agente.') : null,
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', type: 'submit' }, ev ? 'Guardar' : 'Crear cita'),
        ev ? h('span', { class: 'spacer' }) : null,
        ev ? h('button', { class: 'btn danger', type: 'button', onclick: remove }, 'Borrar') : null),
      note);
    toggle();

    async function save(e) {
      e.preventDefault();
      const f = formData(form);
      let startsAt;
      let endsAt;
      if (f.all_day) {
        startsAt = fromInputs(f.date);
        endsAt = addDays(fromInputs(f.end_date || f.date), 1);
      } else {
        startsAt = fromInputs(f.date, f.start_time || '00:00');
        endsAt = fromInputs(f.date, f.end_time || f.start_time || '00:00');
      }
      if (endsAt <= startsAt) return (note.textContent = 'La cita tiene que terminar después de empezar.');
      const row = {
        calendar_id: f.calendar_id, title: f.title, location: f.location, description: f.description, type_id: typeId || null,
        all_day: f.all_day, starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString(),
      };
      try {
        if (ev) await q(db.from('calendar_events').update(row).eq('id', ev.id));
        // client_id lo pone la base de datos a partir del calendario.
        else await q(db.from('calendar_events').insert({ ...row, client_id: clientId, source: 'panel' }));
        close();
        toast(ev ? 'Cita guardada.' : 'Cita creada.');
        render();
      } catch (err) {
        note.textContent = errorText(err);
      }
    }

    async function remove() {
      if (!confirm(`¿Borrar "${ev.title}"?`)) return;
      try {
        await q(db.from('calendar_events').delete().eq('id', ev.id));
        close();
        toast('Cita borrada.');
        render();
      } catch (err) {
        note.textContent = errorText(err);
      }
    }

    const close = modal(ev ? 'Editar cita' : 'Nueva cita', form);
  }

  function showImported(ev) {
    const s = new Date(ev.starts_at);
    const en = new Date(ev.ends_at);
    modal(ev.title, h('div', { class: 'form' },
      h('p', {}, ev.all_day ? `${dayFmt.format(s)} · todo el día`
        : `${dayFmt.format(s)} · ${timeFmt.format(s)} – ${timeFmt.format(en)}`),
      ev.location ? h('p', { class: 'muted' }, ev.location) : null,
      ev.description ? h('p', { class: 'muted pre' }, ev.description) : null,
      h('p', { class: 'muted small' }, 'Esta cita viene de Google/Outlook. Para cambiarla o borrarla, hazlo allí; aquí se actualiza sola en unos minutos.')));
  }

  await load();
  return wrap;
}
