// Ficha de llamada: los mismos datos y el mismo orden que la ficha en papel de las teleoperadoras de DZZERO
// (nº cliente, datos de la persona, familia, día y hora de visita, interés en la máquina, qué beben ahora,
// observaciones y reconfirmación). Se guarda con la RPC update_lead_ficha y se puede imprimir en el mismo formato.
import { db, session } from './app.js';
import { h, q, field, toast, errorText } from './ui.js';
import { attachAddress } from './address.js';

const DRINKS = [['embotellada', 'Agua embotellada'], ['grifo', 'Grifo'], ['filtrada', 'Filtrada'], ['aquaservice', 'Aquaservice']];
const SOURCES = [['llamada', 'Llamada'], ['whatsapp', 'WhatsApp'], ['web', 'Web']];
const MACHINE = [['con_instalacion', 'Con instalación'], ['sin_instalacion', 'Sin instalación']];
const pad = (n) => String(n).padStart(2, '0');

function parts(iso) {
  if (!iso) return { date: '', time: '' };
  const d = new Date(iso);
  return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
}
const dmy = (iso) => { if (!iso) return ''; const d = new Date(iso); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`; };

export function callSheetTab(lead, { onChanged = () => {}, members = [], onVisit = () => {} } = {}) {
  const call = parts(lead.follow_up_at);
  const text = (name, label, extra = {}) => field(label, h('input', { name, value: lead[name] ?? '', ...extra }));
  const num = (name, label) => field(label, h('input', { name, type: 'number', min: 0, max: 30, inputmode: 'numeric', value: lead[name] ?? '' }));
  const error = h('p', { class: 'error' });
  const save = h('button', { class: 'btn primary', type: 'submit' }, 'Guardar la ficha');
  const print = h('button', { class: 'btn soft', type: 'button', onclick: () => printSheet({ ...lead, ...read() }) }, 'Imprimir ficha');

  const radio = (v, label) => h('label', { class: 'check' }, h('input', { type: 'radio', name: 'machine_interest', value: v, checked: lead.machine_interest === v }), ' ', label);
  const check = (v, label) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'drinks', value: v, checked: (lead.drinks || []).includes(v) }), ' ', label);

  const form = h('form', { class: 'form call-sheet', onsubmit: submit },
    h('div', { class: 'grid2' },
      text('client_ref', 'Nº de cliente'),
      field('Lead asignado desde', h('select', { name: 'source' },
        h('option', { value: '' }, 'Sin indicar'),
        SOURCES.map(([v, l]) => h('option', { value: v, selected: lead.source === v }, l))),
        `Entró el ${dmy(lead.created_at)}.`)),
    h('div', { class: 'grid2' },
      field('Día de la llamada', h('input', { value: call.date ? dmy(lead.follow_up_at) : '—', disabled: true }), 'Se cambia en «Seguimiento» (volver a llamar el).'),
      field('Hora de la llamada', h('input', { value: call.time || '—', disabled: true }))),
    text('name', 'Nombre y apellidos'),
    text('email', 'Correo', { type: 'email' }),
    text('address', 'Dirección'),
    text('address_extra', 'Piso, puerta, escalera…', { placeholder: 'Ej.: 4.º A, puerta B, escalera 2' }),
    h('div', { class: 'grid2' }, text('town', 'Población'), text('postal_code', 'Código postal', { inputmode: 'numeric' })),
    h('div', { class: 'grid2' }, text('province', 'Provincia'), text('nationality', 'Nacionalidad')),
    text('contact', 'Teléfono', { inputmode: 'tel' }),
    h('div', { class: 'grid3' }, num('family_members', 'Miembros de la familia'), num('children_at_home', 'Hijos en casa'), text('children_ages', 'Edades')),
    h('div', { class: 'grid2' },
      h('div', { class: 'field' }, h('span', {}, 'Interés en máquina'), h('div', { class: 'checks' }, MACHINE.map(([v, l]) => radio(v, l)))),
      h('div', { class: 'field' }, h('span', {}, 'Actualmente beben'), h('div', { class: 'checks' }, DRINKS.map(([v, l]) => check(v, l))))),
    field('Observaciones de la llamada / visita', h('textarea', { name: 'observations', rows: 7, placeholder: 'Qué habéis hablado, qué necesita, qué queda pendiente…' }, lead.observations || '')),
    field('Reconfirmación', h('textarea', { name: 'reconfirmation', rows: 3, placeholder: 'Cuándo se reconfirmó la visita y cómo respondió…' }, lead.reconfirmation || '')),
    error,
    h('div', { class: 'row-actions' }, save, ' ', print));

  attachAddress(form);

  // Lee el formulario como el objeto que espera la base de datos.
  function read() {
    const f = new FormData(form);
    const v = (k) => String(f.get(k) ?? '').trim();
    return {
      client_ref: v('client_ref'), source: v('source'), address_extra: v('address_extra'), name: v('name'), email: v('email'), address: v('address'), town: v('town'),
      postal_code: v('postal_code'), province: v('province'), nationality: v('nationality'), contact: v('contact'),
      family_members: v('family_members'), children_at_home: v('children_at_home'), children_ages: v('children_ages'),
      machine_interest: v('machine_interest') || null, drinks: f.getAll('drinks'),
      observations: v('observations'), reconfirmation: v('reconfirmation'),
    };
  }

  async function submit(e) {
    e.preventDefault();
    error.textContent = '';
    save.disabled = true;
    const data = read();
    try {
      await q(db.rpc('update_lead_ficha', { p_id: lead.id, p_data: data }));
      Object.assign(lead, {
        ...data,
        family_members: data.family_members === '' ? null : Number(data.family_members),
        children_at_home: data.children_at_home === '' ? null : Number(data.children_at_home),
        name: data.name || null, contact: data.contact || null,
      });
      toast('Ficha guardada');
      onChanged();
    } catch (err) { error.textContent = errorText(err); }
    save.disabled = false;
  }
  return h('div', {}, visitBox(lead, { members, onChanged, onVisit }), form);
}


// Visita: se agenda desde la ficha. Solo el día (y, si se quiere, una hora aproximada) va a la «Agenda de visitas»;
// al elegir comercial y hora pasa a la agenda de ese comercial. Se puede cambiar de comercial o de hora cuando haga falta.
// Tramos de visita que usan los comerciales de DZZERO (hora de inicio → hora de fin).
export const VISIT_RANGES = [['10:00', '12:00'], ['11:00', '13:00'], ['12:00', '14:00'], ['13:00', '15:00'], ['15:00', '17:00'], ['16:00', '18:00']];
const h12 = (t) => { const n = +t.slice(0, 2); return n > 12 ? n - 12 : n; };
export const rangeLabel = (start) => { const r = VISIT_RANGES.find((x) => x[0] === start); return r ? `de ${h12(r[0])} a ${h12(r[1])}` : start; };
export function visitTimeText(iso) {
  const d = new Date(iso); const t = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return t === '00:00' ? '' : rangeLabel(t);
}

function visitBox(lead, { members, onChanged, onVisit = () => {} }) {
  const coms = members.filter((m) => m.client_id === lead.client_id && m.role === 'comercial' && (m.active || m.id === lead.visit_member_id));
  const cur = parts(lead.visit_at);
  const hasTime = !!lead.visit_at && cur.time !== '00:00';
  const name = (id) => coms.find((m) => m.id === id)?.name;
  const date = h('input', { type: 'date', value: cur.date });
  const odd = hasTime && !VISIT_RANGES.some((r) => r[0] === cur.time);
  const time = h('select', {},
    h('option', { value: '' }, 'Sin tramo todavía'),
    VISIT_RANGES.map((r) => h('option', { value: r[0], selected: hasTime && cur.time === r[0] }, rangeLabel(r[0]))),
    odd ? h('option', { value: cur.time, selected: true }, `${cur.time} (hora suelta)`) : null);
  const who = h('select', {},
    h('option', { value: '' }, 'Sin asignar todavía (solo el día)'),
    coms.map((m) => h('option', { value: m.id, selected: lead.visit_member_id === m.id }, m.name)));
  const state = h('p', { class: 'visit-state' });
  const warn = h('p', { class: 'visit-warn' });
  const error = h('p', { class: 'error' });
  const save = h('button', { class: 'btn primary', type: 'button', onclick: () => doSave() }, 'Guardar visita');
  const remove = h('button', { class: 'btn link danger', type: 'button', onclick: () => doSave(true) }, 'Quitar la visita');

  function paint() {
    const when = lead.visit_at
      ? new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long', }).format(new Date(lead.visit_at)) + (hasTimeNow() ? `, ${visitTimeText(lead.visit_at)}` : '')
      : null;
    state.replaceChildren(...(when
      ? [h('b', {}, `Visita: ${when}`), ` · ${name(lead.visit_member_id) ? `con ${name(lead.visit_member_id)}` : 'sin comercial asignado todavía'}`]
      : ['Todavía no hay visita agendada.']));
    remove.style.display = lead.visit_at ? '' : 'none';
  }
  const hasTimeNow = () => !!lead.visit_at && parts(lead.visit_at).time !== '00:00';

  // Qué tiene ya ese comercial ese día, para no pisarle una visita.
  async function check() {
    warn.textContent = '';
    if (!who.value || !date.value) return;
    try {
      const cals = await q(db.from('calendars').select('id').eq('client_id', lead.client_id).eq('agenda_group', 'comercial').eq('member_id', who.value));
      if (!cals.length) { warn.textContent = 'Ese comercial todavía no tiene agenda: pídele a EBM que se la cree.'; return; }
      const from = new Date(`${date.value}T00:00`); const to = new Date(from.getTime() + 86_400_000);
      const ev = await q(db.from('calendar_events').select('title, starts_at, ends_at, lead_id').in('calendar_id', cals.map((c) => c.id))
        .gte('starts_at', from.toISOString()).lt('starts_at', to.toISOString()).order('starts_at'));
      const others = ev.filter((e) => e.lead_id !== lead.id);
      if (!others.length) { warn.textContent = `${name(who.value)} no tiene nada más ese día.`; warn.className = 'visit-warn ok'; return; }
      const hhmm = (iso) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
      warn.className = 'visit-warn';
      warn.textContent = `Ese día ${name(who.value)} ya tiene: ${others.map((e) => `${hhmm(e.starts_at)}-${hhmm(e.ends_at)} ${e.title.replace(/^Visita · /, '')}`).join(' · ')}`;
    } catch { /* sin aviso */ }
  }
  [who, date].forEach((el) => el.addEventListener('change', check));
  check();

  async function doSave(removeIt = false) {
    error.textContent = '';
    if (!removeIt && !date.value) { error.textContent = 'Elige el día de la visita.'; return; }
    if (!removeIt && who.value && !time.value) { error.textContent = 'Para asignarla a un comercial elige el tramo de la visita.'; return; }
    save.disabled = true;
    try {
      await q(db.rpc('schedule_visit', {
        p_lead: lead.id, p_date: removeIt ? null : date.value, p_time: removeIt || !time.value ? null : time.value,
        p_member: removeIt || !who.value ? null : who.value, p_minutes: VISIT_RANGES.some((r) => r[0] === time.value) ? 120 : 60,
      }));
      if (removeIt) { Object.assign(lead, { visit_at: null, visit_member_id: null }); if (lead.status === 'scheduled') lead.status = 'new'; date.value = ''; time.value = ''; who.value = ''; }
      else {
        const at = new Date(`${date.value}T${time.value || '00:00'}`).toISOString();
        Object.assign(lead, { visit_at: at, visit_member_id: who.value || null });
        if (who.value) Object.assign(lead, { seller_id: who.value, status: ['won', 'lost'].includes(lead.status) ? lead.status : 'with_sales' });
        else {
          lead.seller_id = null;
          if (['new', 'to_call', 'called', 'waiting', 'callback', 'unreachable', 'with_sales'].includes(lead.status)) lead.status = 'scheduled';
        }
      }
      paint(); check(); onVisit();
      toast(removeIt ? 'Visita quitada' : who.value ? `Visita agendada con ${name(who.value)}` : 'Visita agendada para ese día');
      onChanged();
    } catch (err) { error.textContent = errorText(err); }
    save.disabled = false;
  }

  paint();
  return h('div', { class: 'visit-box' },
    h('h3', {}, 'Visita'),
    state,
    h('div', { class: 'grid3' },
      field('Día de la visita', date),
      field('Tramo (obligatorio si eliges comercial)', time),
      field('Comercial', who)),
    warn, error,
    h('div', { class: 'row-actions' }, save, ' ', remove));
}

// Hoja para imprimir con la misma forma que la ficha en papel.
export function printSheet(lead) {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const call = parts(lead.follow_up_at);
  const visit = parts(lead.visit_at);
  const box = (label, value, cls = '') => `<div class="f ${cls}"><label>${esc(label)}</label><div class="v">${esc(value)}</div></div>`;
  const tick = (on, label) => `<div class="t"><span class="b">${on ? '✕' : ''}</span>${esc(label)}</div>`;
  const business = (session.client?.name || 'DZZERO').toUpperCase();
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Ficha de llamada · ${esc(lead.name || '')}</title>
<style>
@page { size: A4; margin: 14mm; }
body { font: 12px Helvetica, Arial, sans-serif; color: #222; }
h1 { font-size: 15px; margin: 0; } header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 1.5px solid #222; padding-bottom: 8px; margin-bottom: 10px; }
header small { display: block; text-align: right; font-size: 11px; }
.row { display: flex; gap: 10px; } .f { flex: 1; margin-bottom: 8px; } .f.s { flex: 0 0 70px; } .f.m { flex: 0 0 130px; }
label { display: block; font-size: 9px; font-weight: 700; color: #666; text-transform: uppercase; margin-bottom: 2px; }
.v { min-height: 22px; background: #f0f0f0; border: 1px solid #ddd; padding: 3px 6px; }
.sec { font-size: 10px; font-weight: 700; color: #666; text-transform: uppercase; margin: 12px 0 6px; }
.t { display: inline-block; margin: 0 22px 6px 0; } .b { display: inline-block; width: 13px; height: 13px; border: 1px solid #444; margin-right: 6px; text-align: center; line-height: 12px; font-size: 11px; vertical-align: middle; }
.lines { white-space: pre-wrap; min-height: 230px; background: repeating-linear-gradient(#fff, #fff 24px, #bbb 24px, #bbb 25px); line-height: 25px; padding: 0 2px; }
.lines.short { min-height: 75px; }
</style></head><body>
<header><h1>FICHA DE LLAMADA - LEAD ${esc(business)}</h1><div><small>Nº Cliente: ${esc(lead.client_ref || '______')}</small><small><b>Lead asignado desde: ${esc(({ llamada: 'Llamada', whatsapp: 'WhatsApp', web: 'Web' })[lead.source] || '________')} · ${esc(dmy(lead.created_at) || '___/___/______')}</b></small></div></header>
<div class="row">${box('Hora llamada', call.time, 'm')}${box('Día llamada', call.date ? dmy(lead.follow_up_at) : '', 'm')}${box('Email', lead.email)}</div>
${box('Nombre y apellidos', lead.name)}
${box('Dirección', [lead.address, lead.address_extra].filter(Boolean).join(', '))}
<div class="row">${box('Población', lead.town)}${box('C.P.', lead.postal_code, 's')}${box('Nacionalidad', lead.nationality)}</div>
<div class="row">${box('Provincia', lead.province)}${box('Teléfono', lead.contact)}</div>
<div class="row">${box('Miembros familia', lead.family_members)}${box('Nº hijos en casa', lead.children_at_home)}${box('Edades', lead.children_ages)}</div>
<div class="row">${box('Día de visita', visit.date ? dmy(lead.visit_at) : '')}${box('Tramo de visita', visit.time ? visitTimeText(lead.visit_at) : '')}</div>
<div class="row"><div class="f"><div class="sec">Interés en máquina</div>${MACHINE.map(([v, l]) => tick(lead.machine_interest === v, l)).join('')}</div>
<div class="f"><div class="sec">Actualmente beben</div>${DRINKS.map(([v, l]) => tick((lead.drinks || []).includes(v), l)).join('')}</div></div>
<div class="sec">Observaciones de la llamada / visita</div><div class="lines">${esc(lead.observations)}</div>
<div class="sec">Reconfirmación</div><div class="lines short">${esc(lead.reconfirmation)}</div>
<script>window.onload = () => setTimeout(() => window.print(), 250);<\/script></body></html>`;
  const w = window.open('', '_blank');
  if (!w) { toast('Tu navegador ha bloqueado la ventana. Permite las ventanas emergentes para imprimir.', 'error'); return; }
  w.document.open(); w.document.write(html); w.document.close();
}
