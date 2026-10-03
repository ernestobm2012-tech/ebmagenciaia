// Redes sociales de cada cliente: conectar su Instagram para que el agente conteste
// los mensajes directos. Lo usan el admin (pestaña del cliente) y el propio cliente.
import { db } from './app.js';
import { h, q, toast, errorText } from './ui.js';

// Vuelta de Instagram tras conectar una cuenta: se avisa y se limpia la dirección.
const RESULT = {
  conectado: ['Instagram conectado. El agente ya contesta los mensajes directos.', 'ok'],
  cancelado: ['Has cancelado la conexión con Instagram.', 'error'],
  'sin-permiso': ['Hay que aceptar el permiso de los mensajes. Vuelve a intentarlo.', 'error'],
  'otro-cliente': ['Esa cuenta de Instagram ya está conectada en otro negocio.', 'error'],
  error: ['No se pudo conectar con Instagram. Inténtalo otra vez en unos minutos.', 'error'],
};
const param = new URLSearchParams(location.search).get('instagram');
if (param) {
  const url = new URL(location.href);
  url.searchParams.delete('instagram');
  history.replaceState(null, '', url);
  const [text, kind] = RESULT[param] || RESULT.error;
  setTimeout(() => toast(text, kind), 800);
}

async function call(action, body) {
  const { data, error } = await db.functions.invoke(`instagram?action=${action}`, { body });
  if (error) {
    const detail = await error.context?.json?.().catch(() => null);
    throw new Error(detail?.error || error.message);
  }
  return data;
}

export async function socialTab(clientId) {
  const root = h('div', {});

  async function render() {
    const accounts = await q(db.from('social_accounts').select('*').eq('client_id', clientId).order('connected_at'));

    const connect = async () => {
      toast('Abriendo Instagram…');
      try {
        const { url } = await call('connect', { client_id: clientId, return_url: location.href });
        location.href = url;
      } catch (err) { toast(errorText(err), 'error'); }
    };
    const toggle = (a) => async () => {
      try { await call('toggle', { account_id: a.id, auto_reply: !a.auto_reply }); } catch (err) { toast(errorText(err), 'error'); }
      render();
    };
    const disconnect = (a) => async () => {
      if (!confirm(`¿Desconectar @${a.username || 'esta cuenta'}? El agente dejará de contestar sus mensajes.`)) return;
      try { await call('disconnect', { account_id: a.id }); toast('Instagram desconectado.'); } catch (err) { toast(errorText(err), 'error'); }
      render();
    };

    const rows = accounts.map((a) => h('div', { class: 'social-row' },
      h('div', {},
        h('strong', {}, `@${a.username || a.external_id}`),
        h('div', { class: 'muted small' }, a.last_error
          ? a.last_error
          : a.auto_reply ? 'El agente contesta los mensajes directos.' : 'En pausa: el agente no contesta.')),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'button', onclick: toggle(a) }, a.auto_reply ? 'Pausar' : 'Reactivar'),
        h('button', { class: 'btn link danger', type: 'button', onclick: disconnect(a) }, 'Desconectar'))));

    root.replaceChildren(
      h('div', { class: 'social-card' },
        h('h3', {}, 'Instagram'),
        h('p', { class: 'muted' }, 'El agente contesta los mensajes directos de tu cuenta de Instagram con los datos de tu negocio. '
          + 'Necesitas una cuenta profesional (de empresa o de creador). Si escribes tú una respuesta desde la app de Instagram, '
          + 'el agente se calla en esa conversación y sigues tú.'),
        ...rows,
        h('div', { class: 'actions' },
          h('button', { class: 'btn primary', type: 'button', onclick: connect }, accounts.length ? 'Conectar otra cuenta' : 'Conectar Instagram'))));
  }

  await render();
  return root;
}
