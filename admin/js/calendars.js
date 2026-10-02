// Calendarios de cada cliente: los que necesite (uno por persona, sala,
// servicio…), su agenda y el enlace con Google/Outlook en los dos sentidos.
// Lo usan el admin (pestaña del cliente) y el propio cliente (su menú).
import { db } from './app.js';
import { SUPABASE_URL } from './config.js';
import { h, q, field, modal, toast, formData, errorText } from './ui.js';

const DAYS_SHOWN = 14;
const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/calendar`;
const COLORS = ['#1483DC', '#7C9A44', '#E07A1F', '#C24545', '#8E5CC9', '#17A2B8', '#5E6C7A'];

const feedUrl = (cal) => `${FUNCTION_URL}?feed=${cal.feed_token}`;

// Vuelta de Google tras conectar una cuenta: se avisa y se limpia la dirección.
const GOOGLE_RESULT = {
  conectado: ['Calendario conectado con Google. Desde ahora se sincroniza al momento.', 'ok'],
  cancelado: ['Has cancelado la conexión con Google.', 'error'],
  'sin-permiso': ['Hay que marcar la casilla de permiso del calendario. Vuelve a intentarlo.', 'error'],
  error: ['No se pudo conectar con Google. Inténtalo otra vez en unos minutos.', 'error'],
};
const googleResult = new URLSearchParams(location.search).get('google');
if (googleResult) {
  const url = new URL(location.href);
  url.searchParams.delete('google');
  history.replaceState(null, '', url);
  const [text, kind] = GOOGLE_RESULT[googleResult] || GOOGLE_RESULT.error;
  setTimeout(() => toast(text, kind), 800);
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
  let from = startOfDay(new Date());
  let calendars = [];
  const hidden = new Set();

  async function load() {
    calendars = await q(db.from('calendars').select('*').eq('client_id', clientId).order('created_at'));
    await render();
  }

  async function render() {
    const to = addDays(from, DAYS_SHOWN);
    const visible = calendars.filter((c) => !hidden.has(c.id)).map((c) => c.id);
    const events = visible.length
      ? await q(db.from('calendar_events').select('*').in('calendar_id', visible)
        .lt('starts_at', to.toISOString()).gt('ends_at', from.toISOString()).order('starts_at').limit(1000))
      : [];

    wrap.replaceChildren(
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn primary', type: 'button', onclick: () => editCalendar() }, 'Nuevo calendario'),
        calendars.length ? h('button', { class: 'btn', type: 'button', onclick: () => editEvent() }, 'Nueva cita') : null),
      calendars.length
        ? h('div', { class: 'cal-list' }, calendars.map(calendarCard))
        : h('p', { class: 'empty' }, 'Todavía no hay calendarios. Crea uno por cada persona, sala o servicio que tenga agenda propia.'),
      calendars.length ? agenda(events, to) : null);
  }

  function calendarCard(cal) {
    const status = cal.google_account
      ? (cal.sync_error ? `Google: ${cal.sync_error}` : `Conectado con Google (${cal.google_account}) · al momento`)
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
      h('div', { class: `small ${cal.sync_error ? 'error' : 'muted'}` }, status),
      h('div', { class: 'cal-actions' },
        cal.google_account ? [
          h('button', { class: 'btn link', type: 'button', onclick: () => googlePull(cal) }, 'Traer ahora'),
          h('button', { class: 'btn link danger', type: 'button', onclick: () => googleDisconnect(cal) }, 'Desconectar Google'),
        ] : [
          h('button', { class: 'btn small-primary', type: 'button', onclick: () => googleConnect(cal) }, 'Conectar con Google'),
          h('button', { class: 'btn link', type: 'button', onclick: () => linkCalendar(cal) }, 'Outlook, iPhone o enlace'),
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

  function agenda(events, to) {
    const byCal = Object.fromEntries(calendars.map((c) => [c.id, c]));
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
    const last = addDays(to, -1);
    return h('div', {},
      h('div', { class: 'agenda-nav' },
        h('button', { class: 'btn', type: 'button', onclick: () => { from = addDays(from, -DAYS_SHOWN); render(); } }, '←'),
        h('button', { class: 'btn', type: 'button', onclick: () => { from = startOfDay(new Date()); render(); } }, 'Hoy'),
        h('button', { class: 'btn', type: 'button', onclick: () => { from = addDays(from, DAYS_SHOWN); render(); } }, '→'),
        h('span', { class: 'muted small' }, `${dayFmt.format(from)} – ${dayFmt.format(last)}`)),
      h('div', { class: 'agenda' }, days));
  }

  function eventRow(e, cal, day) {
    const s = new Date(e.starts_at);
    const en = new Date(e.ends_at);
    const when = e.all_day ? 'Todo el día'
      : s < day ? `hasta ${timeFmt.format(en)}` : `${timeFmt.format(s)} – ${timeFmt.format(en)}`;
    const origin = { import: 'Google/Outlook', google: 'Google', agent: 'Agente' }[e.source];
    return h('button', { class: 'event', type: 'button', style: `border-left-color:${cal?.color || '#999'}`, onclick: () => editEvent(e) },
      h('span', { class: 'event-time' }, when),
      h('span', { class: 'event-title' }, e.title),
      h('span', { class: 'muted small' }, [cal?.name, origin].filter(Boolean).join(' · ')));
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
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', type: 'submit' }, cal ? 'Guardar' : 'Crear calendario'),
        cal ? h('span', { class: 'spacer' }) : null,
        cal ? h('button', { class: 'btn danger', type: 'button', onclick: remove }, 'Borrar') : null),
      note);

    async function save(e) {
      e.preventDefault();
      const data = formData(form);
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
    const start = ev ? new Date(ev.starts_at) : day ? new Date(day.getFullYear(), day.getMonth(), day.getDate(), 10) : new Date(new Date().setMinutes(0, 0, 0) + 3_600_000);
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

    const form = h('form', { class: 'form', onsubmit: save },
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
        calendar_id: f.calendar_id, title: f.title, location: f.location, description: f.description,
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
