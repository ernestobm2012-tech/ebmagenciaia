// Instalar el panel como app y recibir avisos en el móvil (notificaciones push).
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { h, toast, errorText } from './ui.js';

const FN = `${SUPABASE_URL}/functions/v1/push`;
const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

let installEvent = null;
const listeners = new Set();
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; listeners.forEach((f) => f()); });
addEventListener('appinstalled', () => { installEvent = null; listeners.forEach((f) => f()); });

export function registerWorker() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

const toKey = (b64) => {
  const raw = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

async function currentSubscription() {
  if (!supported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

async function call(db, action, body) {
  const { data } = await db.auth.getSession();
  const res = await fetch(`${FN}?action=${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${data.session?.access_token}` },
    body: JSON.stringify(body ?? {}),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || 'No se ha podido completar.');
  return out;
}

async function enable(db) {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Has bloqueado los avisos. Actívalos en los ajustes del navegador para esta web.');
  const { key } = await (await fetch(`${FN}?action=key`)).json();
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription())
    || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(key) }));
  await call(db, 'subscribe', { subscription: sub.toJSON() });
  await call(db, 'test');
}

async function disable(db) {
  const sub = await currentSubscription();
  if (!sub) return;
  await call(db, 'unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe();
}

// Tarjeta del Resumen: instalar la app y activar o quitar los avisos.
export function pushCard(db) {
  const card = h('section', { class: 'push-card' });

  async function render() {
    const sub = await currentSubscription().catch(() => null);
    const busy = (fn) => async (ev) => {
      ev.currentTarget.disabled = true;
      try { await fn(); } catch (err) { toast(errorText(err), 'error'); }
      render();
    };
    const parts = [];

    if (isIos && !isStandalone()) {
      parts.push(h('h2', {}, 'Instala el panel en tu iPhone'),
        h('p', { class: 'muted' }, 'Para recibir avisos, primero añádelo a la pantalla de inicio: pulsa Compartir y luego «Añadir a pantalla de inicio». Ábrelo desde ese icono y vuelve aquí.'));
    } else if (!supported()) {
      parts.push(h('h2', {}, 'Avisos en el móvil'),
        h('p', { class: 'muted' }, 'Este navegador no admite avisos. Prueba con Chrome o Safari actualizados.'));
    } else if (Notification.permission === 'denied') {
      parts.push(h('h2', {}, 'Avisos bloqueados'),
        h('p', { class: 'muted' }, 'Los has bloqueado en este navegador. Actívalos en los ajustes del sitio y recarga la página.'));
    } else if (sub) {
      parts.push(h('h2', {}, 'Avisos activados en este dispositivo'),
        h('p', { class: 'muted' }, 'Te avisaremos cuando entre un contacto, alguien pida hablar con una persona o algo falle.'),
        h('div', { class: 'actions' },
          h('button', { class: 'btn', type: 'button', onclick: busy(() => call(db, 'test')) }, 'Enviar una prueba'),
          h('button', { class: 'btn link', type: 'button', onclick: busy(() => disable(db)) }, 'Quitar los avisos')));
    } else {
      parts.push(h('h2', {}, 'Recibe los avisos en tu móvil'),
        h('p', { class: 'muted' }, 'Una notificación cada vez que entre un contacto, alguien pida hablar con una persona o algo falle.'),
        h('div', { class: 'actions' },
          h('button', { class: 'btn primary', type: 'button', onclick: busy(() => enable(db)) }, 'Activar avisos')));
    }

    if (installEvent && !isStandalone()) {
      parts.push(h('div', { class: 'actions install' },
        h('button', { class: 'btn', type: 'button', onclick: async () => { installEvent.prompt(); await installEvent.userChoice; installEvent = null; render(); } }, 'Instalar como app')));
    }
    card.replaceChildren(...parts);
  }

  listeners.add(render);
  render();
  return card;
}
