// Zona de demos: llamadas de voz desde el navegador a los agentes de ElevenLabs.
// Antes de cada llamada se pide permiso a la función demo-token, que limita a
// 2 demos por persona y día, 20 al día en total y 40 segundos cada una.
import { SUPABASE_URL, SUPABASE_KEY } from '../admin/js/config.js';

const SDK = 'https://cdn.jsdelivr.net/npm/@elevenlabs/client@1.26.0/+esm';
const GATE = `${SUPABASE_URL}/functions/v1/demo-token`;
const WARN_AT = 8;      // segundos antes del final en que el agente se despide
const HIDDEN_MAX = 8;   // segundos con la pestaña oculta antes de colgar

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
        body: JSON.stringify({ agent: card.dataset.agent }),
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
