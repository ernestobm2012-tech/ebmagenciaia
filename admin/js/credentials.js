// Resumen (solo administración): cuándo caducan las claves de terceros.
import { h, toast, errorText } from './ui.js';

const DAY = 86400000;
const fmt = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
const daysLeft = (iso) => Math.round((new Date(`${iso}T00:00:00`) - new Date().setHours(0, 0, 0, 0)) / DAY);

export function credentialsCard(db) {
  const card = h('section', { class: 'cred-card' });

  async function render() {
    const { data, error } = await db.from('credential_expiry').select('*').order('label');
    if (error || !data?.length) return card.replaceChildren();
    const rows = data.map((c) => {
      const left = c.expires_at ? daysLeft(c.expires_at) : null;
      const state = left === null ? 'sin-fecha' : left <= 30 ? 'urgente' : left <= 90 ? 'pronto' : 'bien';
      const text = left === null ? 'Falta poner la fecha de caducidad'
        : left < 0 ? `Caducó hace ${-left} días`
        : left === 0 ? 'Caduca hoy'
        : `Caduca el ${fmt(c.expires_at)} · quedan ${left} días`;
      const input = h('input', { type: 'date', value: c.expires_at ?? '' });
      const save = async () => {
        try {
          const { error: e } = await db.from('credential_expiry')
            .update({ expires_at: input.value || null, updated_at: new Date().toISOString() }).eq('key', c.key);
          if (e) throw e;
          toast('Fecha guardada.');
        } catch (err) { toast(errorText(err), 'error'); }
        render();
      };
      return h('div', { class: `cred-row ${state}` },
        h('div', {},
          h('strong', {}, c.label),
          h('div', { class: 'cred-text' }, text),
          c.note ? h('div', { class: 'cred-note' }, c.note) : null),
        h('div', { class: 'cred-edit' }, input, h('button', { class: 'btn', type: 'button', onclick: save }, 'Guardar')));
    });
    card.replaceChildren(h('h2', {}, 'Claves que caducan'), ...rows);
  }

  render();
  return card;
}
