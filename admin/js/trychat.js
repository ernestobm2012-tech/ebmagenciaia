// «Probar el chat»: hablar por escrito con el asistente de texto de un cliente desde el
// panel. Usa la misma función `chat` que la web y WhatsApp (Claude, sin ElevenLabs), así
// que hace lo mismo que con un cliente de verdad: guarda contactos y programa llamadas.
import { db } from './app.js';
import { SUPABASE_URL } from './config.js';
import { h, q, toast, errorText } from './ui.js';

const CHAT_URL = `${SUPABASE_URL}/functions/v1/chat`;
const DEMO_PAGE = 'https://ebmagenciaia.es/demo.html';

function newId() {
  try { if (crypto.randomUUID) return crypto.randomUUID(); } catch { /* navegador antiguo */ }
  return 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
}

export async function tryChatTab(client) {
  const [agent] = await q(db.from('agents').select('name, welcome_message, active').eq('client_id', client.id)
    .eq('active', true).order('created_at').limit(1));
  if (!agent) return h('p', { class: 'empty' }, 'Este cliente no tiene ningún asistente activo.');

  const name = agent.name || 'Asistente';
  let visitorId = newId();
  let conversationId = null;
  const log = h('div', { class: 'try-log', 'aria-live': 'polite' });
  const input = h('textarea', { rows: 1, placeholder: `Escribe a ${name}…`, maxlength: 2000 });
  const send = h('button', { class: 'btn primary', type: 'submit' }, 'Enviar');

  const bubble = (role, text) => {
    const b = h('div', { class: `try-bubble ${role}` }, text);
    log.append(b);
    log.scrollTop = log.scrollHeight;
    return b;
  };
  function reset() {
    visitorId = newId();
    conversationId = null;
    log.replaceChildren();
    if (agent.welcome_message) bubble('bot', agent.welcome_message);
    input.focus();
  }

  async function submit(e) {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.style.height = '';
    bubble('me', text);
    const typing = bubble('bot typing', 'Escribiendo…');
    send.disabled = true;
    try {
      const res = await fetch(CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client: client.slug, visitor_id: visitorId, conversation_id: conversationId, message: text }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `El chat respondió ${res.status}`);
      conversationId = data.conversation_id || conversationId;
      typing.remove();
      bubble('bot', String(data.reply || '').replace(/\*\*/g, ''));
    } catch (err) {
      typing.remove();
      bubble('error', errorText(err));
    } finally {
      send.disabled = false;
      input.focus();
    }
  }

  // Enter envía; Mayúsculas+Enter, salto de línea. El cuadro crece con el texto.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });
  input.addEventListener('input', () => {
    input.style.height = '';
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  });

  const form = h('form', { class: 'try-form', onsubmit: submit }, input, send);
  const link = `${DEMO_PAGE}?cliente=${encodeURIComponent(client.slug)}&nombre=${encodeURIComponent(client.name)}`;
  async function copyLink() {
    try { await navigator.clipboard.writeText(link); toast('Enlace copiado.'); } catch { prompt('Copia el enlace:', link); }
  }

  reset();
  return h('div', { class: 'try-wrap' },
    h('p', { class: 'muted' }, `Escribe como si fueras un cliente. ${name} contesta igual que en la web o en WhatsApp: guarda los contactos y programa las llamadas en las agendas de verdad, así que lo que hagas aquí sale en Actividad y en Calendarios.`),
    h('div', { class: 'try-chat' },
      h('div', { class: 'try-head' },
        h('span', { class: 'try-avatar' }, name.charAt(0)),
        h('div', {}, h('b', {}, name), h('div', { class: 'small muted' }, client.name)),
        h('button', { class: 'btn link small', type: 'button', onclick: reset }, 'Empezar de nuevo')),
      log, form),
    h('p', { class: 'small muted try-share' }, 'Para enseñárselo a alguien sin entrar al panel: ',
      h('button', { class: 'btn link small', type: 'button', onclick: copyLink }, 'copiar el enlace de la demo'),
      ' (abre una página con el chat flotante).'));
}
