// Zona de demos: llamadas de voz desde el navegador a los agentes de ElevenLabs.
const SDK = 'https://cdn.jsdelivr.net/npm/@elevenlabs/client@1.26.0/+esm';

let active = null; // { card, conversation }

const phone = document.querySelector('.demo-phone');
if (phone?.dataset.phone) {
  const a = phone.querySelector('a');
  a.textContent = phone.dataset.phone;
  a.href = 'tel:' + phone.dataset.phone.replace(/\s+/g, '');
  phone.hidden = false;
}

for (const card of document.querySelectorAll('.demo[data-agent]')) {
  const button = card.querySelector('.demo-call');
  const label = button.textContent;
  const status = card.querySelector('.demo-status');
  const set = (text) => { status.textContent = text; };

  const reset = () => {
    card.classList.remove('live', 'speaking');
    button.textContent = label;
    button.disabled = false;
    if (active?.card === card) active = null;
  };

  button.addEventListener('click', async () => {
    if (active?.card === card) {
      button.disabled = true;
      await active.conversation?.endSession();
      return;
    }
    if (active) await active.conversation?.endSession();

    active = { card, conversation: null };
    button.disabled = true;
    set('Conectando…');
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
      const { Conversation } = await import(SDK);
      const conversation = await Conversation.startSession({
        agentId: card.dataset.agent,
        connectionType: 'webrtc',
        onConnect: () => {
          card.classList.add('live');
          button.textContent = 'Colgar';
          button.disabled = false;
          set('En llamada');
        },
        onModeChange: ({ mode }) => {
          card.classList.toggle('speaking', mode === 'speaking');
          set(mode === 'speaking' ? 'Hablando…' : 'Te escucha');
        },
        onDisconnect: () => { reset(); set('Llamada terminada'); },
        onError: () => { reset(); set('No se ha podido conectar. Inténtalo otra vez.'); },
      });
      if (active?.card === card) active.conversation = conversation;
      else conversation.endSession();
    } catch (err) {
      reset();
      set(err?.name === 'NotAllowedError'
        ? 'Necesito permiso para usar el micrófono.'
        : 'No se ha podido conectar. Inténtalo otra vez.');
    }
  });
}
