import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { h, q, toast, errorText, field } from './ui.js';
import { adminRoutes, adminNav } from './admin.js';
import { clientRoutes, clientNav } from './client.js';

const root = document.getElementById('root');
const logo = () => h('img', { src: 'assets/logo-ebm.png', alt: 'EBM', class: 'logo' });

export let db = null;
export let session = { user: null, profile: null, client: null };
// Mientras se cambia la contraseña desde el enlace del correo no se entra al panel.
let recovering = false;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  root.replaceChildren(h('div', { class: 'auth' }, h('div', { class: 'auth-card' }, logo(),
    h('h1', {}, 'Falta conectar Supabase'),
    h('p', {}, 'Rellena SUPABASE_URL y SUPABASE_KEY en js/config.js con los datos del proyecto.'))));
} else {
  // Quien llega desde el enlace de invitación aún no tiene contraseña: se la pedimos.
  let invited = /type=invite/.test(location.hash);
  db = createClient(SUPABASE_URL, SUPABASE_KEY);
  db.auth.onAuthStateChange((event, s) => {
    // Fuera del callback: supabase-js no permite llamadas a la API dentro de él.
    setTimeout(() => {
      if (event === 'PASSWORD_RECOVERY' || (invited && s)) {
        invited = false;
        renderNewPassword();
      }
      else if (event === 'SIGNED_OUT') renderLogin();
      else if (event === 'INITIAL_SESSION' || (event === 'SIGNED_IN' && !session.user)) start(s);
    }, 0);
  });
  window.addEventListener('hashchange', route);
}

async function start(s) {
  if (!s) return renderLogin();
  try {
    const profile = await q(db.from('profiles').select('*').eq('id', s.user.id).maybeSingle());
    if (!profile) throw new Error('Tu usuario no tiene perfil. Avisa a EBM.');
    const client = profile.role === 'client' ? (await q(db.rpc('my_client')))[0] || null : null;
    if (recovering) return;
    session = { user: s.user, profile, client };
    renderShell();
  } catch (err) {
    renderLogin(errorText(err));
  }
}

function renderLogin(message) {
  session = { user: null, profile: null, client: null };
  const note = h('p', { class: message ? 'error' : 'muted' }, message || '');
  const form = h('form', { class: 'auth-card', onsubmit: submit }, logo(),
    h('h1', {}, 'Panel de agentes'),
    h('p', { class: 'muted' }, 'Entra con tu correo y contraseña.'),
    field('Correo', h('input', { type: 'email', name: 'email', required: true, autocomplete: 'username' })),
    field('Contraseña', h('input', { type: 'password', name: 'password', required: true, autocomplete: 'current-password' })),
    h('button', { class: 'btn primary', type: 'submit' }, 'Entrar'),
    h('button', { class: 'btn link', type: 'button', onclick: forgot }, 'He olvidado mi contraseña'),
    note);

  async function submit(e) {
    e.preventDefault();
    note.className = 'muted';
    note.textContent = 'Entrando…';
    const { error } = await db.auth.signInWithPassword({ email: form.email.value, password: form.password.value });
    if (error) {
      note.className = 'error';
      note.textContent = 'Correo o contraseña incorrectos.';
    }
  }

  async function forgot() {
    if (!form.email.value) {
      note.className = 'error';
      note.textContent = 'Escribe tu correo y vuelve a pulsar.';
      return;
    }
    const { error } = await db.auth.resetPasswordForEmail(form.email.value,
      { redirectTo: location.origin + location.pathname });
    note.className = error ? 'error' : 'muted';
    note.textContent = error ? errorText(error) : 'Si el correo existe, te llegará un enlace para cambiarla.';
  }

  root.replaceChildren(h('div', { class: 'auth' }, form));
}

function renderNewPassword() {
  const note = h('p', { class: 'error' });
  const form = h('form', { class: 'auth-card', onsubmit: submit }, logo(),
    h('h1', {}, 'Nueva contraseña'),
    field('Contraseña nueva', h('input', { type: 'password', name: 'password', required: true, minlength: 8, autocomplete: 'new-password' })),
    h('button', { class: 'btn primary', type: 'submit' }, 'Guardar'), note);

  async function submit(e) {
    e.preventDefault();
    const { error } = await db.auth.updateUser({ password: form.password.value });
    if (error) return (note.textContent = errorText(error));
    toast('Contraseña cambiada.');
    recovering = false;
    const { data } = await db.auth.getSession();
    start(data.session);
  }

  recovering = true;
  root.replaceChildren(h('div', { class: 'auth' }, form));
}

let outlet;

function renderShell() {
  const isAdmin = session.profile.role === 'admin';
  const nav = isAdmin ? adminNav : clientNav;
  outlet = h('main', { class: 'main' });
  root.replaceChildren(h('div', { class: 'shell' },
    h('aside', { class: 'sidebar' },
      h('a', { href: '#/', class: 'brand' }, logo()),
      h('div', { class: 'who' }, isAdmin ? 'Administración' : session.client?.name || 'Sin cliente asignado'),
      h('nav', {}, nav.map((n) => h('a', { href: n.href, 'data-nav': n.href }, n.label))),
      h('div', { class: 'sidebar-foot' },
        h('div', { class: 'muted small' }, session.profile.email),
        h('button', { class: 'btn link', type: 'button', onclick: () => db.auth.signOut() }, 'Cerrar sesión'))),
    outlet));
  route();
}

async function route() {
  if (!session.user || !outlet) return;
  const isAdmin = session.profile.role === 'admin';
  const path = location.hash.replace(/^#/, '') || '/';
  const routes = isAdmin ? adminRoutes : clientRoutes;

  document.querySelectorAll('[data-nav]').forEach((a) => {
    const target = a.dataset.nav.slice(1);
    a.classList.toggle('active', target === '/' ? path === '/' : path.startsWith(target));
  });

  if (!isAdmin && !session.client) {
    return outlet.replaceChildren(h('div', { class: 'page' }, h('h1', {}, 'Tu cuenta está casi lista'),
      h('p', {}, 'Todavía no tienes un negocio asignado. Escríbenos y lo activamos.')));
  }

  for (const [pattern, view] of routes) {
    const match = path.match(pattern);
    if (!match) continue;
    outlet.replaceChildren(h('p', { class: 'empty' }, 'Cargando…'));
    try {
      const node = await view(...match.slice(1));
      // Si el usuario ya navegó a otra ruta mientras cargaba, no pisar.
      if ((location.hash.replace(/^#/, '') || '/') === path) outlet.replaceChildren(node);
    } catch (err) {
      outlet.replaceChildren(h('p', { class: 'error' }, errorText(err)));
    }
    return;
  }
  location.hash = '#/';
}

export const refresh = route;
