// Zona de demos: llamadas de voz con los agentes de ElevenLabs y chats de texto con Claude.
// Antes de cada una se pide permiso a la función demo-token, que limita la voz a
// 2 demos por persona y día, 20 al día en total y 40 segundos cada una, y el texto a
// 3 chats por persona y día, 30 al día en total y 8 mensajes cada uno.
import { SUPABASE_URL, SUPABASE_KEY } from '../admin/js/config.js';

const SDK = 'https://cdn.jsdelivr.net/npm/@elevenlabs/client@1.26.0/+esm';
const GATE = `${SUPABASE_URL}/functions/v1/demo-token`;

// Si en este navegador hay una sesión abierta del panel, se manda para que las
// pruebas de administración no gasten el cupo ni cuenten en las estadísticas.
function adminToken() {
  try {
    const ref = new URL(SUPABASE_URL).hostname.split('.')[0];
    const s = JSON.parse(localStorage.getItem(`sb-${ref}-auth-token`) || 'null');
    return s?.access_token && s.expires_at * 1000 > Date.now() ? s.access_token : undefined;
  } catch {
    return undefined;
  }
}
const WARN_AT = 8;      // segundos antes del final en que el agente se despide
const HIDDEN_MAX = 8;   // segundos con la pestaña oculta antes de colgar
const MAX_MESSAGES = 8; // mensajes del cliente en un chat de texto

let active = null; // { card, conversation, stop }

const phone = document.querySelector('.demo-phone');
if (phone?.dataset.phone) {
  const a = phone.querySelector('a');
  a.textContent = phone.dataset.phone;
  a.href = 'tel:' + phone.dataset.phone.replace(/\s+/g, '');
  phone.hidden = false;
}

const clock = (s) => `0:${String(Math.max(0, Math.ceil(s))).padStart(2, '0')}`;

for (const card of document.querySelectorAll('.demo[data-agent]')) {
  const button = card.querySelector('.demo-call');
  const label = button.textContent;
  const status = card.querySelector('.demo-status');

  // Texto de estado; con `contact` añade el enlace al formulario de contacto.
  const set = (text, contact = false) => {
    status.replaceChildren(text);
    if (contact) {
      const a = document.createElement('a');
      a.href = '#contacto';
      a.textContent = ' Déjanos tu contacto';
      status.append(a);
    }
  };

  const reset = () => {
    card.classList.remove('live', 'speaking');
    button.textContent = label;
    button.disabled = false;
    if (active?.card === card) { active.stop?.(); active = null; }
  };

  button.addEventListener('click', async () => {
    if (active?.card === card) {
      button.disabled = true;
      await active.conversation?.endSession();
      return;
    }
    if (active) await active.conversation?.endSession();

    const session = { card, conversation: null, stop: null };
    active = session;
    button.disabled = true;
    set('Comprobando…');
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });

      const res = await fetch(GATE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY },
        body: JSON.stringify({ agent: card.dataset.agent, admin: adminToken() }),
      });
      const gate = await res.json().catch(() => ({}));
      if (res.status === 429) {
        reset();
        set(gate.error === 'persona'
          ? 'Ya has hecho tus 2 demos de hoy.'
          : 'Hoy ya se han hecho muchas pruebas.', true);
        return;
      }
      if (!res.ok) throw new Error(gate.error || 'gate');

      const seconds = Number(gate.seconds) || 40;
      let timedOut = false;
      let warned = false;
      let hiddenSince = null;
      const endsAt = Date.now() + seconds * 1000;

      const { Conversation } = await import(SDK);
      const access = gate.token
        ? { conversationToken: gate.token, connectionType: 'webrtc' }
        : gate.signedUrl
          ? { signedUrl: gate.signedUrl }
          : { agentId: card.dataset.agent, connectionType: 'webrtc' };

      const conversation = await Conversation.startSession({
        ...access,
        onConnect: () => {
          card.classList.add('live');
          button.disabled = false;
          const tick = setInterval(() => {
            const left = (endsAt - Date.now()) / 1000;
            button.textContent = `Colgar · ${clock(left)}`;
            if (document.hidden) {
              hiddenSince ??= Date.now();
              if (Date.now() - hiddenSince > HIDDEN_MAX * 1000) session.conversation?.endSession();
            } else {
              hiddenSince = null;
            }
            if (!warned && left <= WARN_AT) {
              warned = true;
              try {
                session.conversation?.sendUserMessage(
                  '[Aviso del sistema, no es el cliente] La demo termina en unos segundos. '
                  + 'Di ahora, en una sola frase corta y sin preguntas: «Se acaba la demo, déjanos tu contacto en la web.»');
              } catch { /* si no se puede enviar, el tiempo corta igual */ }
            }
            if (left <= 0) {
              timedOut = true;
              session.conversation?.endSession();
            }
          }, 250);
          session.stop = () => clearInterval(tick);
          set('En llamada');
        },
        onModeChange: ({ mode }) => {
          card.classList.toggle('speaking', mode === 'speaking');
        },
        onDisconnect: () => {
          reset();
          if (timedOut) set('Se acaba la demo.', true);
          else set(gate.left > 0 ? `Llamada terminada. Te queda ${gate.left} demo hoy.` : 'Llamada terminada. Has hecho tus 2 demos de hoy.', gate.left <= 0);
        },
        onError: () => { reset(); set('No se ha podido conectar. Inténtalo otra vez.'); },
      });
      if (active === session) session.conversation = conversation;
      else conversation.endSession();
    } catch (err) {
      reset();
      set(err?.name === 'NotAllowedError'
        ? 'Necesito permiso para usar el micrófono.'
        : 'No se ha podido iniciar la demo. Inténtalo otra vez en un rato.');
    }
  });
}


// ---------------------------------------------------------------- chat de texto
// El texto no usa ElevenLabs: demo-token da un permiso firmado y demo-chat responde con Claude.
const CHAT = `${SUPABASE_URL}/functions/v1/demo-chat`;
const GREETING = {
  agent_3701m40awp7ve56vd8282v8annz2: 'Clínica Dental Sonrisas, buenos días, te atiende Lucía.',
  agent_4001m40awq3nf5qtjd9ek5mehxs0: 'Estudio Nadia, hola, buenas.',
  agent_4601m40awr0gezr9pj4m0vkfat27: 'La Alacena, buenas, dime.',
  agent_3201m40awsbyef59dhptnhvedc67: 'Talleres Ruiz, buenos días, soy Javi.',
};

const chat = document.getElementById('demo-chat');
if (chat) {
  const msgs = chat.querySelector('.demo-msgs');
  const form = chat.querySelector('.demo-form');
  const input = form.querySelector('input');
  const send = form.querySelector('button');
  const status = chat.querySelector('.demo-status');
  let session = null; // { token, history, sent, busy }

  const setStatus = (text, contact = false) => {
    status.replaceChildren(text);
    if (contact) {
      const a = document.createElement('a');
      a.href = '#contacto';
      a.textContent = ' Déjanos tu contacto';
      a.addEventListener('click', () => chat.close());
      status.append(a);
    }
  };
  const bubble = (who, text) => {
    msgs.querySelector('.typing')?.remove();
    const li = document.createElement('li');
    li.className = who;
    li.textContent = text;
    msgs.append(li);
    msgs.scrollTop = msgs.scrollHeight;
  };
  const typing = () => {
    if (msgs.querySelector('.typing')) return;
    const li = document.createElement('li');
    li.className = 'ai typing';
    li.textContent = 'Escribiendo…';
    msgs.append(li);
    msgs.scrollTop = msgs.scrollHeight;
  };
  const lock = (locked) => { input.disabled = locked; send.disabled = locked; };
  chat.addEventListener('close', () => { session = null; });
  chat.querySelector('.demo-chat-close').addEventListener('click', () => chat.close());
  chat.addEventListener('click', (e) => { if (e.target === chat) chat.close(); });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const mine = session;
    const text = input.value.trim();
    if (!text || !mine?.token || mine.busy || mine.sent >= MAX_MESSAGES) return;
    mine.busy = true;
    mine.sent += 1;
    mine.history.push({ role: 'user', content: text });
    bubble('me', text);
    input.value = '';
    lock(true);
    typing();
    try {
      const res = await fetch(CHAT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY },
        body: JSON.stringify({ token: mine.token, messages: mine.history }),
      });
      const data = await res.json().catch(() => ({}));
      if (session !== mine) return;
      if (!res.ok || !data.reply) {
        msgs.querySelector('.typing')?.remove();
        if (res.status === 429 || res.status === 401) {
          lock(true);
          setStatus(res.status === 401 ? 'La demo ha caducado.' : 'Has llegado al límite de la demo.', true);
        } else {
          mine.sent -= 1;
          mine.history.pop();
          lock(false);
          setStatus('No se ha podido enviar. Inténtalo otra vez.');
        }
        return;
      }
      mine.history.push({ role: 'assistant', content: data.reply });
      bubble('ai', data.reply);
      if (mine.sent >= MAX_MESSAGES) {
        lock(true);
        setStatus(`Has usado tus ${MAX_MESSAGES} mensajes de la demo.`, true);
      } else {
        lock(false);
        input.focus();
        setStatus(`Te quedan ${MAX_MESSAGES - mine.sent} mensajes.`);
      }
    } catch {
      if (session === mine) {
        msgs.querySelector('.typing')?.remove();
        mine.sent -= 1;
        mine.history.pop();
        lock(false);
        setStatus('No se ha podido enviar. Inténtalo otra vez.');
      }
    } finally {
      mine.busy = false;
    }
  });

  for (const card of document.querySelectorAll('.demo[data-text-agent]')) {
    card.querySelector('.demo-write')?.addEventListener('click', async () => {
      if (active) await active.conversation?.endSession();
      const name = card.querySelector('h3').textContent;
      chat.querySelector('h3').textContent = name;
      chat.querySelector('header p').textContent = card.querySelector('.demo-head p').textContent + ' · demo por escrito';
      chat.querySelector('.avatar').textContent = name[0];
      msgs.replaceChildren();
      input.value = '';
      lock(true);
      setStatus('Conectando…');
      chat.showModal();

      const mine = { token: null, history: [], sent: 0, busy: false };
      session = mine;
      try {
        const res = await fetch(GATE, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY },
          body: JSON.stringify({ agent: card.dataset.textAgent, mode: 'text', admin: adminToken() }),
        });
        const gate = await res.json().catch(() => ({}));
        if (res.status === 429) {
          setStatus(gate.error === 'persona' ? 'Ya has hecho tus 3 chats de hoy.' : 'Hoy ya se han hecho muchas pruebas.', true);
          return;
        }
        if (!res.ok || !gate.token) throw new Error(gate.error || 'gate');
        if (session !== mine) return;
        mine.token = gate.token;
        const hello = GREETING[card.dataset.textAgent];
        if (hello) bubble('ai', hello);
        lock(false);
        input.focus();
        setStatus(`Escribe como un cliente. Tienes ${MAX_MESSAGES} mensajes.`);
      } catch {
        if (session === mine) setStatus('No se ha podido iniciar el chat. Inténtalo otra vez en un rato.');
      }
    });
  }
}
