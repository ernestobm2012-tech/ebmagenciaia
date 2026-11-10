// Autocompletado de direcciones con CartoCiudad (IGN, Gobierno de España): servicio público y gratuito, sin clave.
// Se engancha a un formulario que tenga campos «address», «town», «postal_code» y «province». Al escribir sale un
// desplegable de direcciones reales; al elegir una se rellenan la calle con su número, la población, el código postal
// y la provincia. Si el servicio no responde, el campo sigue siendo un texto normal.
import { h } from './ui.js';

const API = 'https://www.cartociudad.es/geocoder/api/geocoder/candidates';
const SMALL = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'y', 'en', 'a', 'al']);

// «CALLE GUADALAJARA 38» → «Calle Guadalajara 38»
function nice(s) {
  return String(s || '').toLowerCase().split(/(\s+)/).map((w, i) => (/\s+/.test(w) || (SMALL.has(w) && i > 0)) ? w : w.charAt(0).toUpperCase() + w.slice(1)).join('');
}

async function search(term, signal) {
  const res = await fetch(`${API}?q=${encodeURIComponent(term)}&limit=7&countrycode=es`, { signal });
  if (!res.ok) throw new Error(`CartoCiudad ${res.status}`);
  return await res.json();
}

// Si el navegador no deja leer la respuesta (CORS), se pide como script con retorno de llamada (JSONP).
function jsonp(term) {
  return new Promise((resolve, reject) => {
    const cb = `__cc${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const s = document.createElement('script');
    const done = () => { delete window[cb]; s.remove(); };
    window[cb] = (data) => { done(); resolve(data); };
    s.onerror = () => { done(); reject(new Error('CartoCiudad')); };
    s.src = `${API.replace('/candidates', '/candidatesJsonp')}?q=${encodeURIComponent(term)}&limit=7&countrycode=es&callback=${cb}`;
    document.head.appendChild(s);
    setTimeout(() => { if (window[cb]) { done(); reject(new Error('Tiempo agotado')); } }, 8000);
  });
}

export function attachAddress(form) {
  const input = form.querySelector('input[name="address"]');
  if (!input || input.dataset.ac) return;
  input.dataset.ac = '1';
  input.setAttribute('autocomplete', 'off');
  const set = (name, value) => { const el = form.querySelector(`[name="${name}"]`); if (el && value) { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); } };

  const list = h('div', { class: 'ac-list', hidden: true, role: 'listbox' });
  const wrap = input.parentElement;
  wrap.classList.add('ac-wrap');
  wrap.appendChild(list);
  let timer = null; let ctl = null; let last = '';

  const hide = () => { list.hidden = true; list.replaceChildren(); };
  function pick(c) {
    const street = nice(String(c.address || '').split(',')[0]);
    input.value = c.type === 'portal' || c.portalNumber ? street : street;
    set('town', nice(c.poblacion || c.muni));
    set('postal_code', c.postalCode);
    set('province', nice(c.province));
    hide();
    input.focus();
  }
  function show(items) {
    list.replaceChildren();
    const seen = new Set();
    for (const c of items) {
      if (!c?.address || seen.has(c.id || c.address)) continue;
      seen.add(c.id || c.address);
      const line1 = nice(String(c.address).split(',')[0]);
      const line2 = [c.postalCode, nice(c.poblacion || c.muni), nice(c.province)].filter(Boolean).join(' · ');
      list.appendChild(h('button', { type: 'button', class: 'ac-item', role: 'option', onmousedown: (e) => { e.preventDefault(); pick(c); } },
        h('strong', {}, line1), h('span', {}, line2)));
    }
    if (!list.children.length) return hide();
    list.appendChild(h('small', { class: 'ac-credit' }, 'Direcciones de CartoCiudad (IGN)'));
    list.hidden = false;
  }
  async function run(term) {
    if (ctl) ctl.abort();
    ctl = new AbortController();
    let items;
    // Primero como script (JSONP): la respuesta de /candidates no lleva cabecera CORS y el navegador no la dejaría leer.
    try { items = await jsonp(term); } catch {
      try { items = await search(term, ctl.signal); } catch { return hide(); }
    }
    if (term === last) show(Array.isArray(items) ? items : []);
  }
  input.addEventListener('input', () => {
    clearTimeout(timer);
    last = input.value.trim();
    if (last.length < 4) return hide();
    timer = setTimeout(() => run(last), 300);
  });
  input.addEventListener('blur', () => setTimeout(hide, 150));
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
}
