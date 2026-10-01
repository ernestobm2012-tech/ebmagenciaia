import { SUPABASE_URL, SUPABASE_KEY } from '../admin/js/config.js';

const form = document.getElementById('contact-form');
const note = form.querySelector('.form-note');
const button = form.querySelector('button[type="submit"]');

function say(text, kind) {
  note.textContent = text;
  note.className = `form-note ${kind || ''}`;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!form.reportValidity()) return;
  // Campo trampa: las personas no lo ven; si viene relleno es un bot.
  if (form.website.value) return say('¡Gracias! Te respondo pronto.', 'ok');

  button.disabled = true;
  say('Enviando…');
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/contact_messages`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        name: form.name.value.trim(),
        email: form.email.value.trim(),
        phone: form.phone.value.trim() || null,
        service: form.service.value || null,
        message: form.message.value.trim(),
      }),
    });
    if (!res.ok) throw new Error(await res.text());
    form.reset();
    say('Mensaje recibido. Te respondo yo en cuanto lo lea.', 'ok');
  } catch {
    say('No se ha podido enviar. Prueba otra vez en un momento.', 'error');
  } finally {
    button.disabled = false;
  }
});
