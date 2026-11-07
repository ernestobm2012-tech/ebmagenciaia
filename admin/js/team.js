// «Usuarios» del panel del cliente: el responsable del negocio (profiles.team_admin) da de alta a su gente
// y elige qué ve cada persona. Todo pasa por la función `users`, que solo le deja tocar a usuarios de su
// negocio y repartir lo que él mismo puede ver.
import { db, session } from './app.js';
import { h, table, field, modal, toast, formData, errorText, fmtDate } from './ui.js';

// Cada casilla de lo que se puede dejar ver. need = permisos imprescindibles; extra = los que se dan además si el
// responsable los tiene. requires = otra casilla que debe estar marcada.
const BOXES = [
  { id: 'resumen', label: 'Resumen', help: 'La portada con las llamadas que tocan hoy.', need: ['resumen'], extra: ['resumen_temas'] },
  { id: 'contactos', label: 'Contactos', help: 'Ver los contactos, abrir su ficha y leer su conversación.', need: ['actividad', 'act_leads', 'act_mensajes'], extra: ['act_derivaciones', 'act_citas', 'act_avisos'] },
  { id: 'conversaciones', label: 'Conversaciones', help: 'La lista de conversaciones del asistente.', need: ['actividad', 'act_conversaciones', 'act_mensajes'], extra: [] },
  { id: 'clientes', label: 'Clientes', help: 'Las personas que ya han comprado.', need: ['clientes'], extra: [] },
  { id: 'estadisticas', label: 'Estadísticas', help: 'Las cifras del negocio. Necesita también Contactos.', need: ['estadisticas', 'act_leads'], extra: [], requires: 'contactos' },
  { id: 'agenda', label: 'Agenda', help: 'Ver las agendas de llamadas y visitas.', need: ['calendarios'], extra: [] },
  { id: 'avisos', label: 'Avisos', help: 'A quién avisa el asistente.', need: ['avisar'], extra: [] },
  { id: 'redes', label: 'Redes sociales', help: 'La conexión con Instagram.', need: ['redes'], extra: [] },
  { id: 'catalogo', label: 'Catálogo y presupuestos', help: 'El catálogo de equipos y los presupuestos con sus precios.', need: ['catalogo'], extra: [] },
];

async function call(action, body = {}) {
  const { data, error } = await db.functions.invoke(`users?action=${action}`, { body });
  if (error) {
    const detail = await error.context?.json?.().catch(() => null);
    throw new Error(detail?.error || error.message);
  }
  return data;
}

const mine = () => session.profile?.modules; // null = todo
const has = (list, keys) => keys.every((k) => !list || list.includes(k));
const available = () => BOXES.filter((b) => has(mine(), b.need));

function checks(selected) {
  const rows = available().map((b) => {
    const input = h('input', { type: 'checkbox', name: `box_${b.id}`, checked: selected ? has(selected, b.need) : false });
    return { b, input, row: h('label', { class: 'check module-check' }, input, h('span', {}, h('b', {}, b.label), h('small', { class: 'muted' }, ` ${b.help}`))) };
  });
  const byId = Object.fromEntries(rows.map((r) => [r.b.id, r.input]));
  rows.forEach(({ b, input }) => {
    if (!b.requires || !byId[b.requires]) return;
    input.addEventListener('change', () => { if (input.checked) byId[b.requires].checked = true; });
    byId[b.requires].addEventListener('change', () => { if (!byId[b.requires].checked) input.checked = false; });
  });
  return h('div', { class: 'module-checks' }, rows.map((r) => r.row));
}

// De las casillas a la lista de permisos. Lo que el usuario ya tuviera y no sale en casillas se conserva.
function read(form, previous) {
  const out = new Set();
  const grouped = new Set(BOXES.flatMap((b) => [...b.need, ...b.extra]));
  for (const b of BOXES) {
    const el = form.querySelector(`[name="box_${b.id}"]`);
    if (!el?.checked) continue;
    b.need.forEach((k) => out.add(k));
    b.extra.filter((k) => has(mine(), [k])).forEach((k) => out.add(k));
  }
  (previous || []).filter((k) => !grouped.has(k)).forEach((k) => out.add(k));
  return [...out];
}

function seesText(u) {
  if (!u.modules) return 'Todo';
  const names = BOXES.filter((b) => has(u.modules, b.need)).map((b) => b.label);
  return names.length ? names.join(', ') : 'Nada';
}

export async function teamView() {
  const page = h('div', { class: 'page' });
  const body = h('div', {});

  function linkModal(title, result, email) {
    const input = h('input', { type: 'text', readonly: true, value: result.link, onfocus: (e) => e.target.select() });
    const close = modal(title, h('div', { class: 'form' },
      h('p', {}, result.emailed
        ? `Le hemos enviado el enlace a ${email}. Si no le llega, mira en spam o pásaselo tú.`
        : 'No se ha enviado ningún correo: pásale tú este enlace.'),
      field('Enlace de acceso', input, 'Sirve una sola vez y caduca. Con él la persona elige su contraseña y entra.'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', type: 'button', onclick: async () => {
          try { await navigator.clipboard.writeText(result.link); toast('Enlace copiado.'); } catch { input.select(); toast('Cópialo a mano: ya está seleccionado.', 'error'); }
        } }, 'Copiar enlace'),
        h('button', { class: 'btn', type: 'button', onclick: () => { close(); load(); } }, 'Cerrar'))));
  }

  function addUser() {
    const form = h('form', { class: 'form', onsubmit: async (e) => {
      e.preventDefault();
      const d = formData(form);
      const submit = form.querySelector('button[type=submit]');
      submit.disabled = true;
      try {
        const result = await call('create', { email: d.email, full_name: d.full_name, modules: read(form, []), send_email: d.send_email });
        close();
        linkModal('Usuario creado', result, d.email);
      } catch (err) { toast(errorText(err), 'error'); submit.disabled = false; }
    } },
      field('Correo', h('input', { type: 'email', name: 'email', required: true, autocomplete: 'off' })),
      field('Nombre', h('input', { type: 'text', name: 'full_name', maxlength: 120 })),
      h('div', { class: 'field' }, h('span', {}, 'Qué puede ver'), checks(null),
        h('small', {}, 'Solo verá lo que marques. Puedes cambiarlo cuando quieras.')),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'send_email', checked: true }), 'Enviarle el enlace por correo'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', type: 'submit' }, 'Crear usuario'),
        h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancelar')));
    const close = modal('Añadir usuario', form, { wide: true });
  }

  function editUser(u) {
    const form = h('form', { class: 'form', onsubmit: async (e) => {
      e.preventDefault();
      const d = formData(form);
      const submit = form.querySelector('button[type=submit]');
      submit.disabled = true;
      try {
        const email = (d.email || '').toLowerCase();
        if (email !== u.email || (d.full_name || null) !== (u.full_name || null)) {
          await call('update', { user_id: u.id, email, full_name: d.full_name || null });
        }
        await call('set_modules', { user_id: u.id, modules: read(form, u.modules) });
        close();
        toast('Guardado.');
        load();
      } catch (err) { toast(errorText(err), 'error'); submit.disabled = false; }
    } },
      field('Correo', h('input', { type: 'email', name: 'email', required: true, value: u.email || '' })),
      field('Nombre', h('input', { type: 'text', name: 'full_name', maxlength: 120, value: u.full_name || '' })),
      h('div', { class: 'field' }, h('span', {}, 'Qué puede ver'), checks(u.modules),
        h('small', {}, 'Lo que no marques no le aparece en el menú.')),
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', type: 'submit' }, 'Guardar'),
        h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancelar')));
    const close = modal(`Editar ${u.full_name || u.email}`, form, { wide: true });
  }

  async function newLink(u) {
    try { linkModal('Nuevo enlace de acceso', await call('link', { user_id: u.id, send_email: false }), u.email); }
    catch (err) { toast(errorText(err), 'error'); }
  }
  async function toggle(u, active) {
    if (!active && !confirm(`¿Quitarle el acceso a ${u.full_name || u.email}? Podrás volver a activarlo.`)) return;
    try { await call('set_active', { user_id: u.id, active }); toast(active ? 'Acceso activado.' : 'Acceso desactivado.'); load(); }
    catch (err) { toast(errorText(err), 'error'); }
  }
  async function remove(u) {
    if (!confirm(`¿Borrar a ${u.full_name || u.email}? Perderá el acceso para siempre. Si solo quieres quitárselo un tiempo, usa «Desactivar».`)) return;
    try { await call('delete', { user_id: u.id }); toast('Usuario borrado.'); load(); }
    catch (err) { toast(errorText(err), 'error'); }
  }

  async function load() {
    body.replaceChildren(h('p', { class: 'empty' }, 'Cargando…'));
    try {
      const { users } = await call('team_list');
      const me = session.user.id;
      body.replaceChildren(table([
        { label: 'Persona', primary: true, cell: (u) => h('span', {}, u.full_name || u.email, u.team_admin ? h('small', { class: 'muted' }, ' · responsable') : null, u.full_name ? h('small', { class: 'muted', style: 'display:block' }, u.email) : null) },
        { label: 'Qué ve', hideM: true, cell: (u) => h('small', {}, u.id === me || u.team_admin ? 'Todo lo tuyo' : seesText(u)) },
        { label: 'Acceso', cell: (u) => (u.disabled ? h('span', { class: 'badge paused' }, 'Desactivado')
          : !u.confirmed ? h('span', { class: 'badge pending' }, 'Invitado')
            : h('span', {}, h('span', { class: 'badge active' }, 'Activo'), ' ', h('small', { class: 'muted' }, u.last_sign_in_at ? `visto ${fmtDate(u.last_sign_in_at)}` : ''))) },
        { label: '', cell: (u) => (u.team_admin || u.id === me ? null : h('span', { class: 'actions', onclick: (e) => e.stopPropagation() },
          h('button', { class: 'btn link', type: 'button', onclick: () => editUser(u) }, 'Editar'),
          h('button', { class: 'btn link', type: 'button', onclick: () => newLink(u) }, 'Enlace de acceso'),
          u.disabled
            ? h('button', { class: 'btn link', type: 'button', onclick: () => toggle(u, true) }, 'Activar')
            : h('button', { class: 'btn link danger', type: 'button', onclick: () => toggle(u, false) }, 'Desactivar'),
          h('button', { class: 'btn link danger', type: 'button', onclick: () => remove(u) }, 'Borrar'))) },
      ], users, { empty: 'Todavía no has dado de alta a nadie.', onRow: (u) => (u.team_admin || u.id === me ? null : editUser(u)) }));
    } catch (err) { body.replaceChildren(h('p', { class: 'error' }, errorText(err))); }
  }

  page.append(h('h1', {}, 'Usuarios'),
    h('p', { class: 'muted' }, 'Da de alta a tu equipo y elige qué ve cada persona. Cada una recibe un enlace para elegir su contraseña.'),
    h('div', { class: 'toolbar' }, h('button', { class: 'btn primary', type: 'button', onclick: addUser }, 'Añadir usuario')),
    body);
  await load();
  return page;
}
