// Widget de chat del agente. Autocontenido (trae sus estilos) para poder
// pegarlo en la web de cualquier cliente:
//   <script src=".../js/chat.js" data-client="identificador" data-welcome="..." defer></script>
// Opcionales: data-title, data-color (#hex), data-avatar (dirección https de una
// foto, se muestra redonda) y data-position="left" si la web ya tiene otro botón
// flotante a la derecha, o data-bottom="90" para subirlo (en píxeles) por encima
// de él. data-privacy="dirección" añade un enlace a la política de privacidad.
// Cualquier enlace con el atributo data-open-chat abre el chat.
(() => {
  const script = document.currentScript;
  const ENDPOINT = 'https://rhjbpkaesobsbnkvioyh.supabase.co/functions/v1/chat';
  const CLIENT = script.dataset.client;
  const TITLE = script.dataset.title || 'Asistente';
  const WELCOME = script.dataset.welcome || '¡Hola! ¿En qué puedo ayudarte?';
  const COLOR = /^#[0-9a-f]{3,8}$/i.test(script.dataset.color || '') ? script.dataset.color : '#1483DC';
  // La cabecera usa el color de la marca si se indica; si no, el azul noche de EBM.
  const HEAD = COLOR === '#1483DC' ? '#12294A' : COLOR;
  const SIDE = script.dataset.position === 'left' ? 'left' : 'right';
  const BOTTOM = Math.min(Math.max(parseInt(script.dataset.bottom, 10) || 20, 0), 400);
  const AVATAR = /^https:\/\//.test(script.dataset.avatar || '') ? script.dataset.avatar : null;
  const PRIVACY = /^(https:\/\/|\/|[\w.-]+\.html$)/.test(script.dataset.privacy || '') ? script.dataset.privacy : null;
  const KEY = `ebm-chat-${CLIENT}`;

  // El almacenamiento puede fallar (modo privado, cookies bloqueadas, navegador interno de
  // Instagram o Facebook): ni siquiera se puede nombrar `localStorage` sin que salte un error,
  // así que se pide dentro del try y el chat funciona igual sin él.
  const area = (name) => { try { return window[name]; } catch { return null; } };
  const store = {
    get(name, key) { try { return JSON.parse(area(name).getItem(key)); } catch { return null; } },
    set(name, key, value) { try { area(name).setItem(key, JSON.stringify(value)); } catch { /* sin almacenamiento */ } },
  };
  const newId = () => {
    try { if (crypto.randomUUID) return crypto.randomUUID(); } catch { /* navegador antiguo */ }
    return 'v-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  };
  let visitorId = store.get('localStorage', `${KEY}-visitor`);
  if (!visitorId) {
    visitorId = newId();
    store.set('localStorage', `${KEY}-visitor`, visitorId);
  }
  const state = store.get('sessionStorage', KEY) || { conversationId: null, messages: [] };
  const save = () => store.set('sessionStorage', KEY, state);

  const style = document.createElement('style');
  style.textContent = `
    .ebm-chat-btn, .ebm-chat { font-family: "Lato", -apple-system, "Segoe UI", Arial, sans-serif; box-sizing: border-box; }
    .ebm-chat, .ebm-chat * { box-sizing: border-box; margin: 0; letter-spacing: normal; text-transform: none; text-align: left; }
    .ebm-chat { padding: 0; line-height: 1.45; }
    .ebm-chat-btn { padding: 0; overflow: hidden; position: fixed; ${SIDE}: 20px; bottom: ${BOTTOM}px; z-index: 9998; width: 60px; height: 60px; border-radius: 50%;
      border: 0; background: ${COLOR}; color: #fff; cursor: pointer; box-shadow: 0 12px 30px -10px rgba(18,41,74,.6);
      display: grid; place-items: center; }
    .ebm-chat-btn:focus-visible, .ebm-chat button:focus-visible, .ebm-chat textarea:focus-visible { outline: 2px solid #12294A; outline-offset: 2px; }
    .ebm-chat { position: fixed; ${SIDE}: 20px; bottom: ${BOTTOM + 72}px; z-index: 9999; width: 370px; max-width: calc(100vw - 24px);
      height: 520px; max-height: calc(100dvh - ${BOTTOM + 92}px); display: none; flex-direction: column; overflow: hidden;
      background: #fff; color: #242F3D; border: 1px solid #E1E7EE; border-radius: 16px; box-shadow: 0 24px 60px -20px rgba(18,41,74,.5); }
    .ebm-chat.open { display: flex; }
    .ebm-chat-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 14px 16px; background: ${HEAD}; color: #fff; }
    .ebm-chat-btn img { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; display: block; border: 2px solid #fff; }
    .ebm-chat-who { display: flex; align-items: center; gap: 10px; }
    .ebm-chat-who img { width: 38px; height: 38px; border-radius: 50%; object-fit: cover; flex: none; }
    .ebm-chat-head strong { font-size: 15px; font-weight: 900; }
    .ebm-chat-head small { display: block; font-size: 12px; color: rgba(255,255,255,.78); font-weight: 400; }
    .ebm-chat-head button { border: 0; background: none; color: #fff; font-size: 24px; line-height: 1; cursor: pointer; padding: 2px 8px; }
    .ebm-chat-log { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px; background: #F3F6FA; }
    .ebm-chat-msg { max-width: 86%; padding: 10px 14px; border-radius: 14px; font-size: 15px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
    .ebm-chat-msg.assistant { background: #fff; border: 1px solid #E1E7EE; align-self: flex-start; }
    .ebm-chat-msg.user { background: ${COLOR}; color: #fff; align-self: flex-end; }
    .ebm-chat-msg.typing { color: #5E6C7A; font-style: italic; }
    .ebm-chat form { display: flex; gap: 8px; padding: 12px; width: auto; max-width: none; border-radius: 0; box-shadow: none; border-top: 1px solid #E1E7EE; background: #fff; }
    .ebm-chat textarea { flex: 1; resize: none; font: inherit; font-size: 16px; color: inherit; padding: 10px 12px; border: 1px solid #E1E7EE; border-radius: 10px; height: 44px; max-height: 120px; }
    .ebm-chat form button { border: 0; border-radius: 10px; background: ${COLOR}; color: #fff; font: inherit; font-weight: 700; padding: 0 16px; cursor: pointer; }
    .ebm-chat form button:disabled { opacity: .5; cursor: default; }
    .ebm-chat-note { padding: 0 12px 10px; font-size: 11.5px; color: #5E6C7A; background: #fff; }
    .ebm-chat-note a { color: inherit; text-decoration: underline; }
    @media (max-width: 480px) { .ebm-chat { ${SIDE}: 12px; bottom: ${BOTTOM + 68}px; height: calc(100dvh - ${BOTTOM + 84}px); } }
  `;
  document.head.append(style);

  const el = (tag, props = {}, ...children) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  };

  const log = el('div', { className: 'ebm-chat-log', role: 'log' });
  log.setAttribute('aria-live', 'polite');
  const input = el('textarea', { placeholder: 'Escribe tu mensaje…', rows: 1, maxLength: 2000 });
  input.setAttribute('aria-label', 'Mensaje');
  const send = el('button', { type: 'submit', textContent: 'Enviar' });
  const form = el('form', {}, input, send);
  const close = el('button', { type: 'button', textContent: '×' });
  close.setAttribute('aria-label', 'Cerrar chat');
  const panel = el('div', { className: 'ebm-chat' },
    el('div', { className: 'ebm-chat-head' },
      el('div', { className: 'ebm-chat-who' },
        ...(AVATAR ? [el('img', { src: AVATAR, alt: '' })] : []),
        el('div', {}, el('strong', { textContent: TITLE }), el('small', { textContent: 'Asistente de IA' }))),
      close),
    log, form,
    el('div', { className: 'ebm-chat-note' }, 'Guardamos la conversación para poder atenderte.',
      ...(PRIVACY ? [' ', el('a', { href: PRIVACY, target: '_blank', rel: 'noopener', textContent: 'Privacidad' })] : [])));
  panel.setAttribute('aria-label', TITLE);

  const button = el('button', { className: 'ebm-chat-btn', type: 'button' });
  button.setAttribute('aria-label', 'Abrir chat');
  if (AVATAR) button.append(el('img', { src: AVATAR, alt: '' }));
  else button.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>';

  function bubble(role, text) {
    const node = el('div', { className: `ebm-chat-msg ${role}`, textContent: text });
    log.append(node);
    log.scrollTop = log.scrollHeight;
    return node;
  }

  function toggle(open) {
    panel.classList.toggle('open', open);
    button.setAttribute('aria-expanded', String(open));
    if (open) {
      log.scrollTop = log.scrollHeight;
      input.focus();
    }
  }

  bubble('assistant', WELCOME);
  state.messages.forEach((m) => bubble(m.role, m.text));

  button.addEventListener('click', () => toggle(!panel.classList.contains('open')));
  close.addEventListener('click', () => toggle(false));
  document.querySelectorAll('[data-open-chat]').forEach((link) =>
    link.addEventListener('click', (e) => { e.preventDefault(); toggle(true); }));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || send.disabled) return;
    input.value = '';
    send.disabled = true;
    bubble('user', text);
    state.messages.push({ role: 'user', text });
    const typing = bubble('assistant typing', 'Escribiendo…');
    let reply;
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client: CLIENT, visitor_id: visitorId, conversation_id: state.conversationId, message: text }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      state.conversationId = data.conversation_id || state.conversationId;
      reply = data.reply.replace(/\*\*/g, '');
    } catch {
      reply = 'Ahora mismo no puedo responder. Prueba en un momento o usa el formulario de contacto.';
    }
    typing.remove();
    bubble('assistant', reply);
    state.messages.push({ role: 'assistant', text: reply });
    save();
    send.disabled = false;
    input.focus();
  });

  document.body.append(panel, button);
})();
