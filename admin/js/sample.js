// Modo de ejemplo: todo el panel del cliente con datos de muestra (contactos, conversaciones,
// agenda, presupuestos, estadísticas). Se activa con «#/?ejemplo», se recuerda mientras la
// pestaña esté abierta y NO guarda nada: todo vive en memoria del navegador.
// El catálogo de productos es el real del negocio (solo lo ve quien ha entrado con permiso);
// los precios de los presupuestos de muestra son inventados.
import { h, icon } from './ui.js';

const KEY = 'ebm_sample';

export function initSampleFlag() {
  try { if (/ejemplo/.test(location.hash)) sessionStorage.setItem(KEY, '1'); } catch { /* sin almacenamiento */ }
}
export const sampleOn = () => { try { return sessionStorage.getItem(KEY) === '1'; } catch { return /ejemplo/.test(location.hash); } };
export function exitSample() {
  try { sessionStorage.removeItem(KEY); } catch { /* nada */ }
  location.hash = '#/';
  location.reload();
}
export function sampleBanner() {
  return h('div', { class: 'sample-banner' }, icon('target'),
    'Ejemplo con datos inventados: pruébalo todo, no se guarda nada. ',
    h('a', { href: '#/', onclick: (e) => { e.preventDefault(); exitSample(); } }, 'Ver los míos'));
}

// ------------------------------------------------------------------ generador de datos
function seeded(seed = 7) {
  let s = seed;
  const rnd = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  return { rnd, pick };
}

const FALLBACK_PRODUCTS = [
  ['COVA', 'Ósmosis inversa doméstica'], ['REIN', 'Ósmosis inversa doméstica'], ['SANE', 'Ósmosis inversa doméstica'],
  ['Fuente DZZERO de pie', 'Fuente de ósmosis'], ['Grifo Paris mate', 'Grifos'],
];

function build(clientId, clientName, services, products) {
  const { rnd, pick } = seeded(7);
  const iso = (d) => d.toISOString();
  const now = new Date();
  const members = [
    { id: 'm1', client_id: clientId, name: 'Laura Méndez', role: 'llamadas', job_title: 'Teleoperadora', active: true, email: null, profile_id: null },
    { id: 'm2', client_id: clientId, name: 'Ángela López', role: 'llamadas', job_title: 'Teleoperadora', active: true, email: null, profile_id: null },
    { id: 'm3', client_id: clientId, name: 'Óscar López', role: 'comercial', job_title: 'Comercial', active: true, email: null, profile_id: null },
    { id: 'm4', client_id: clientId, name: 'Juan Antonio', role: 'comercial', job_title: 'Comercial', active: true, email: null, profile_id: null },
  ];
  const names = ['Marta García', 'Luis Romero', 'Carmen Pérez', 'Javier Molina', 'Rosa Lozano', 'Pedro Sanz', 'Elena Torres', 'Sergio Vidal', 'Daniel Ferrer', 'Lucía Ortega', 'Ana Navarro', 'Pablo Gil', 'Irene Castro', 'Diego Ramos', 'Nuria Prieto', 'Raúl Campos', 'Beatriz Núñez', 'Álvaro Soto'];
  const places = [['Madrid', 28936, 'Madrid'], ['Fuenlabrada', 28942, 'Madrid'], ['Toledo', 45001, 'Toledo'], ['Guadalajara', 19001, 'Guadalajara'], ['Almería', 4100, 'Almería'], ['Valencia', 46001, 'Valencia'], ['Sevilla', 41001, 'Sevilla'], ['Getafe', 28901, 'Madrid']];
  const hours = [9, 10, 10, 11, 12, 13, 16, 17, 18, 19, 20, 21, 22];
  const clientsJoin = { name: clientName, services };
  const leads = [];
  const averiaAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
  leads.push({ id: 'lead-averia', client_id: clientId, name: 'Antonio Ruiz', contact: '600123456', reason: 'Avería: la máquina pierde agua por debajo', kind: 'averia', status: 'new', resolved_at: null, created_at: averiaAt, updated_at: averiaAt, conversations: { channel: 'web' } });
  for (let i = 0; i < 142; i++) {
    const day = Math.floor(Math.pow(rnd(), 0.8) * 30);
    const d = new Date(now); d.setDate(d.getDate() - day); d.setHours(pick(hours), Math.floor(rnd() * 60), 0, 0);
    if (d > now) d.setTime(now.getTime() - 3_600_000 * (1 + rnd() * 5));
    const [city, cp, prov] = pick(places);
    const roll = rnd();
    const status = day === 0 && roll < 0.5 ? 'new' : roll < 0.12 ? 'won' : roll < 0.22 ? 'lost' : roll < 0.42 ? 'with_sales' : roll < 0.7 ? 'called' : roll < 0.8 ? 'waiting' : 'callback';
    const home = rnd() < 0.72;
    leads.push({
      id: `s${i}`, client_id: clientId, conversation_id: i < 14 ? `cv${i}` : null, name: pick(names), contact: `6${String(10000000 + Math.floor(rnd() * 89999999))}`,
      reason: `${city} (${String(cp).padStart(5, '0')}) · ${home ? 'casa' : 'negocio'}: ${pick(['compra garrafas', 'bebe del grifo', 'usa jarra con filtro', 'familia de 4', 'quiere información'])}`,
      status, created_at: iso(d), updated_at: iso(d), caller_id: status === 'new' ? null : (rnd() < 0.55 ? 'm1' : 'm2'),
      seller_id: ['with_sales', 'won'].includes(status) ? (rnd() < 0.7 ? 'm3' : 'm4') : null,
      first_contact_at: ['new', 'callback'].includes(status) ? null : iso(new Date(d.getTime() + (8 + rnd() * 50) * 60_000)),
      follow_up_at: null, deal_value: null, passed_at: null, closed_at: null,
      email: null, address: null, postal_code: String(cp).padStart(5, '0'), province: prov, property_type: home ? 'casa' : 'negocio', water_notes: null, install_notes: null,
      clients: clientsJoin, conversations: { channel: pick(['whatsapp', 'whatsapp', 'whatsapp', 'web', 'phone']) },
    });
  }
  // Las llamadas de hoy.
  const today = [['Marta García', 'Fuenlabrada (28942) · casa: compra garrafas', 10, 0], ['Luis Romero', 'Toledo (45001) · negocio: oficina de 12 personas', 10, 30],
    ['Carmen Pérez', 'Getafe (28901) · casa: bebe del grifo', 11, 0], ['Javier Molina', 'Guadalajara (19001) · casa: familia de 4', 12, 0],
    ['Rosa Lozano', 'Almería (04100) · negocio: bar', 12, 30], ['Pedro Sanz', 'Illescas (45200) · casa: usa jarra con filtro', 16, 0]];
  today.forEach(([name, reason, hh, mm], i) => {
    const f = new Date(now); f.setHours(hh, mm, 0, 0);
    leads.unshift({
      id: `t${i}`, client_id: clientId, conversation_id: `cvt${i}`, name, contact: `6${String(20000000 + i * 1111111)}`, reason, status: i === 0 ? 'new' : 'callback',
      created_at: iso(new Date(now.getTime() - (i === 0 ? 720_000 : 3_600_000 * (3 + i)))), updated_at: iso(new Date(now.getTime() - 3_600_000 * (2 + i))),
      caller_id: i % 2 ? 'm2' : 'm1', seller_id: null, first_contact_at: null, follow_up_at: i === 0 ? null : iso(f), deal_value: null,
      email: null, address: null, postal_code: reason.match(/\((\d{5})\)/)?.[1] || null, province: null, property_type: /negocio/.test(reason) ? 'negocio' : 'casa', water_notes: null, install_notes: null,
      clients: clientsJoin, conversations: { channel: 'whatsapp' },
    });
  });

  // Catálogo: el real si hay; si no, unos productos de muestra.
  const prods = products.length ? products : FALLBACK_PRODUCTS.map(([name, category], i) => ({
    id: `p${i}`, client_id: clientId, name, category, description: null, features: null, sheet_url: null, active: true, sort: i, created_at: iso(now) }));
  const machines = prods.filter((p) => p.active && p.category !== 'Grifos');
  const taps = prods.filter((p) => p.active && p.category === 'Grifos');
  const priceOf = (p) => {
    const base = /fuente/i.test(p.category || '') || /fuente/i.test(p.name) ? 900 + Math.floor(rnd() * 600)
      : /ROH2ICE/i.test(p.name) ? 1500 + Math.floor(rnd() * 400)
        : /grifo/i.test(p.category || '') ? 90 + Math.floor(rnd() * 90) : 480 + Math.floor(rnd() * 420);
    const cash = Math.round(base / 5) * 5;
    return { cash, monthly: /grifo/i.test(p.category || '') ? null : Math.round(cash / 40 * 2) / 2 };
  };

  const leadProducts = [];
  const quotes = [];
  const quoteItems = [];
  const sellable = leads.filter((l) => ['won', 'with_sales', 'called'].includes(l.status)).slice(0, 40);
  let number = 0;
  sellable.forEach((lead, i) => {
    if (!machines.length) return;
    const chosen = [pick(machines)];
    if (rnd() < 0.3) chosen.push(pick(machines.filter((m) => m !== chosen[0])) || chosen[0]);
    if (taps.length && rnd() < 0.55) chosen.push(pick(taps));
    chosen.forEach((p) => leadProducts.push({ id: `lp${lead.id}-${p.id}`, client_id: clientId, lead_id: lead.id, product_id: p.id, name: p.name, qty: 1, notes: null, created_at: lead.created_at }));
    if (lead.status === 'called' && rnd() < 0.6) return; // solo algunos tienen presupuesto
    number += 1;
    const qid = `q${number}`;
    const offer = pick(['both', 'both', 'cash', 'monthly']);
    const months = pick([36, 48, 60]);
    const items = chosen.map((p, n) => { const pr = priceOf(p); return { id: `${qid}i${n}`, quote_id: qid, product_id: p.id, name: p.name, description: p.description, qty: 1, unit_cash: pr.cash, unit_monthly: pr.monthly, sort: n }; });
    items.push({ id: `${qid}ix`, quote_id: qid, product_id: null, name: 'Instalación y puesta en marcha', description: null, qty: 1, unit_cash: pick([90, 120, 150]), unit_monthly: null, sort: 9 });
    const discount = rnd() < 0.3 ? pick([50, 100]) : 0;
    const cash = Math.max(0, items.reduce((a, x) => a + (x.unit_cash || 0) * x.qty, 0) - discount);
    const monthly = items.reduce((a, x) => a + (x.unit_monthly || 0) * x.qty, 0);
    let status = lead.status === 'won' ? 'accepted' : lead.status === 'with_sales' ? pick(['sent', 'sent', 'draft', 'rejected']) : pick(['draft', 'sent']);
    const created = new Date(new Date(lead.created_at).getTime() + 86_400_000 * (1 + rnd() * 3));
    if (created > now) created.setTime(now.getTime() - 3_600_000);
    quotes.push({
      id: qid, client_id: clientId, lead_id: lead.id, number, status, offer, months, discount_eur: discount, cash_total: cash, monthly_total: monthly,
      valid_until: iso(new Date(created.getTime() + 30 * 86_400_000)).slice(0, 10), intro: 'Gracias por la llamada. Te enseño lo que hemos hablado.',
      conditions: 'Instalación incluida. Garantía y mantenimiento según lo hablado con tu asesor.', customer_name: lead.name, customer_contact: lead.contact,
      customer_address: `${lead.postal_code} ${lead.province}`, created_by: null, created_at: iso(created), updated_at: iso(created), sent_at: status === 'draft' ? null : iso(created), decided_at: ['accepted', 'rejected'].includes(status) ? iso(created) : null,
    });
    quoteItems.push(...items);
    if (status === 'accepted') {
      lead.deal_value = offer === 'monthly' ? monthly * months : cash;
      lead.closed_at = iso(created); lead.passed_at = lead.passed_at || lead.created_at;
    }
    if (i < 6) { lead.email = `${lead.name.split(' ')[0].toLowerCase()}@ejemplo.es`; lead.address = `Calle Mayor ${10 + i}`; lead.water_notes = 'Compra garrafas cada semana y le cansa cargarlas.'; lead.install_notes = 'Debajo del fregadero, con toma de agua y desagüe.'; }
  });
  // Los ganados sin presupuesto también llevan importe.
  leads.filter((l) => l.status === 'won' && l.deal_value == null).forEach((l) => { l.deal_value = 1200 + Math.floor(rnd() * 1500); });
  leads.filter((l) => ['with_sales', 'won'].includes(l.status)).forEach((l) => { l.passed_at = l.passed_at || l.created_at; });

  // Conversaciones de muestra.
  const conversations = [];
  const messages = [];
  const script = [
    ['assistant', 'Hola, buenas. Soy el asistente virtual de DZZERO y hago un primer filtro. ¿En qué te puedo ayudar?'],
    ['user', 'Hola, he visto vuestro anuncio del agua. ¿Cómo funciona?'],
    ['assistant', 'Cuéntame un poco: ¿para casa o para un negocio? ¿Cómo bebes agua ahora?'],
    ['user', 'Para casa, compramos garrafas y es un rollo cargarlas.'],
    ['assistant', 'Te entiendo. Un asesor te llama y te lo explica sin compromiso. ¿Me dices tu nombre y tu teléfono?'],
    ['user', 'Vale, mi teléfono es el de este chat.'],
    ['assistant', 'Perfecto, te dejo apuntada la llamada. ¡Hasta pronto!'],
  ];
  leads.filter((l) => l.conversation_id).forEach((l, i) => {
    conversations.push({ id: l.conversation_id, client_id: clientId, started_at: l.created_at, channel: l.conversations.channel, summary: l.reason, topic: pick(['Ósmosis', 'Precio', 'Garrafas', 'Instalación']), message_count: script.length, handed_off: false, status: 'closed' });
    script.forEach(([role, content], n) => messages.push({ id: `m${i}-${n}`, conversation_id: l.conversation_id, role, content, created_at: iso(new Date(new Date(l.created_at).getTime() + n * 40_000)) }));
  });

  // Agenda: dos agendas de llamadas y las llamadas de hoy y los próximos días.
  const calendars = [
    { id: 'c1', client_id: clientId, name: 'Agenda de Laura', color: '#1483DC', active: true, member_id: 'm1', booking_enabled: true, booking_kind: 'llamada', booking_minutes: 30, booking_step_minutes: 5, agenda_group: 'llamadas', created_at: iso(now) },
    { id: 'c2', client_id: clientId, name: 'Agenda de Ángela', color: '#2FA36B', active: true, member_id: 'm2', booking_enabled: true, booking_kind: 'llamada', booking_minutes: 30, booking_step_minutes: 5, agenda_group: 'llamadas', created_at: iso(now) },
    { id: 'c3', client_id: clientId, name: 'Agenda de visitas', color: '#2FA36B', active: true, member_id: null, booking_enabled: false, booking_kind: 'cita', booking_minutes: 60, agenda_group: 'visitas', created_at: iso(now) },
    { id: 'c4', client_id: clientId, name: 'Calendario de Óscar', color: '#1483DC', active: true, member_id: 'm3', booking_enabled: false, booking_kind: 'cita', booking_minutes: 60, agenda_group: 'comercial', created_at: iso(now) },
    { id: 'c5', client_id: clientId, name: 'Calendario de Juan Antonio', color: '#8E5CC9', active: true, member_id: 'm4', booking_enabled: false, booking_kind: 'cita', booking_minutes: 60, agenda_group: 'comercial', created_at: iso(now) },
  ];
  const types = [['Cliente nuevo', '#1483DC', true], ['Segunda llamada', '#D9A400', false], ['Segunda visita', '#8E5CC9', false], ['Instalación', '#2FA36B', false], ['Seguimiento', '#E07A1F', false]]
    .map(([name, color, def], i) => ({ id: `ty${i}`, client_id: clientId, name, color, sort: i, is_default: def }));
  const customers = [
    ['Antonio Navarro', '600111222', 'Fuenlabrada', 'Madrid', 'Fuente de ósmosis con agua fría y caliente', -5, -1],
    ['Marisa Gómez', '600333444', 'Getafe', 'Madrid', 'Ósmosis inversa debajo del fregadero', -3, -2],
    ['Bar La Plaza', '600555666', 'Illescas', 'Toledo', 'Fuente de pie, agua fría y caliente', -2, null],
    ['Raúl Prieto', '600777888', 'Guadalajara', 'Guadalajara', 'Ósmosis inversa doméstica', -1, null],
  ].map(([name, phone, town, province, equipment, im, mm], i) => ({
    id: `cu${i}`, client_id: clientId, name, phone, email: null, address: `Calle Mayor ${i + 3}`, town, postal_code: null, province, equipment,
    installed_at: iso(new Date(now.getFullYear(), now.getMonth() + im, 10)).slice(0, 10),
    last_maintenance_at: mm == null ? null : iso(new Date(now.getFullYear(), now.getMonth() + mm, 12)).slice(0, 10),
    notes: null, lead_id: null, created_at: iso(now),
  }));
  const events = [];
  leads.filter((l) => l.status === 'callback').slice(0, 14).forEach((l, i) => {
    const st = l.follow_up_at ? new Date(l.follow_up_at) : new Date(now.getTime() + (i + 1) * 3_600_000 * 5);
    const en = new Date(st.getTime() + 5 * 60_000);
    events.push({ id: `e${i}`, client_id: clientId, calendar_id: l.caller_id === 'm2' ? 'c2' : 'c1', title: `Llamar a ${l.name} · ${l.contact}`, starts_at: iso(st), ends_at: iso(en), all_day: false, type_id: 'ty0', source: 'agent', conversation_id: l.conversation_id });
  });
  // Visitas de muestra: unas sin comercial (solo el día) y otras ya con comercial y hora.
  leads.filter((l) => l.conversation_id).slice(14, 20).forEach((l, i) => {
    const day = new Date(now); day.setDate(day.getDate() + (i % 4)); day.setHours(0, 0, 0, 0);
    const withCom = i % 3 !== 0;
    const st = new Date(day.getTime() + (10 + i) * 3_600_000);
    l.visit_at = iso(withCom ? st : day); l.visit_member_id = withCom ? (i % 2 ? 'm3' : 'm4') : null;
    events.push({ id: `v${i}`, client_id: clientId, calendar_id: withCom ? (i % 2 ? 'c4' : 'c5') : 'c3', title: `Visita · ${l.name} · ${l.contact}`, starts_at: iso(withCom ? st : day), ends_at: iso(withCom ? new Date(st.getTime() + 3_600_000) : new Date(day.getTime() + 86_400_000)), all_day: !withCom, source: 'panel', lead_id: l.id });
  });

  return {
    leads, lead_presence: [], customers, team_members: members, lead_notes: [], lead_products: leadProducts, products: prods, quotes, quote_items: quoteItems,
    conversations, messages, calendars, appointment_types: types, calendar_events: events,
    handoffs: [], notifications: [], appointments: [], notify_contacts: [
      { id: 'n1', client_id: clientId, name: 'Atención al cliente', email: 'atencionalcliente@ejemplo.es', department: 'general', active: true },
    ], conversations_monthly: [], clients: [{ id: clientId, name: clientName, logo_url: null, services }],
  };
}

// ------------------------------------------------------------------ base de datos en memoria
function makeTable(tables, name, relations) {
  tables[name] = tables[name] || [];
  const filters = []; const orders = []; let mode = 'select'; let payload = null; let one = false; let wantCount = false; let head = false;
  const match = (r) => filters.every((f) => f(r));
  const api = {
    select(_cols, opts) { if (opts?.count) wantCount = true; if (opts?.head) head = true; return api; },
    limit() { return api; },
    order(k, opts) { orders.push([k, opts?.ascending === false ? -1 : 1]); return api; },
    eq(k, v) { filters.push((r) => r[k] === v); return api; },
    neq(k, v) { filters.push((r) => r[k] !== v); return api; },
    in(k, vs) { filters.push((r) => vs.includes(r[k])); return api; },
    gte(k, v) { filters.push((r) => r[k] == null || String(r[k]) >= String(v)); return api; },
    gt(k, v) { filters.push((r) => r[k] == null || String(r[k]) > String(v)); return api; },
    lt(k, v) { filters.push((r) => r[k] == null || String(r[k]) < String(v)); return api; },
    lte(k, v) { filters.push((r) => r[k] == null || String(r[k]) <= String(v)); return api; },
    not(k, op, v) { if (op === 'is' && v === null) filters.push((r) => r[k] != null); return api; },
    maybeSingle() { one = true; return api; },
    single() { one = true; return api; },
    insert(x) { mode = 'insert'; payload = x; return api; },
    update(x) { mode = 'update'; payload = x; return api; },
    delete() { mode = 'delete'; return api; },
    then(ok, fail) {
      try {
        const t = tables[name];
        let data = null; let count;
        if (mode === 'insert') {
          const arr = (Array.isArray(payload) ? payload : [payload]).map((r) => {
            const row = { id: `${name}-${Math.random().toString(36).slice(2, 9)}`, created_at: new Date().toISOString(), ...r };
            if (name === 'quotes') { row.number = Math.max(0, ...t.filter((x) => x.client_id === row.client_id).map((x) => x.number)) + 1; row.status = row.status || 'draft'; }
            if (name === 'products') { row.active = row.active ?? true; row.sort = row.sort ?? 0; }
            return row;
          });
          t.push(...arr); data = one ? arr[0] : arr;
        } else if (mode === 'update') { t.filter(match).forEach((r) => Object.assign(r, payload, { updated_at: new Date().toISOString() })); }
        else if (mode === 'delete') {
          tables[name] = t.filter((r) => !match(r));
          if (name === 'quotes') tables.quote_items = tables.quote_items.filter((i) => tables.quotes.some((x) => x.id === i.quote_id));
        } else {
          let rows = t.filter(match).map((r) => (relations[name] ? relations[name](r) : r));
          for (let i = orders.length - 1; i >= 0; i--) {
            const [k, dir] = orders[i];
            rows = [...rows].sort((a, b) => dir * (String(a[k] ?? '').localeCompare(String(b[k] ?? ''), 'es', { numeric: true })));
          }
          if (wantCount) count = rows.length;
          data = head ? null : (one ? (rows[0] || null) : rows);
        }
        return Promise.resolve({ data, error: null, count }).then(ok, fail);
      } catch (error) { return Promise.resolve({ data: null, error }).then(ok, fail); }
    },
  };
  return api;
}

export async function makeSampleDb(real, { clientId, clientName, services }) {
  let products = [];
  try {
    const { data } = await real.from('products').select('*').eq('client_id', clientId).order('category').order('name');
    products = data || [];
  } catch { /* sin catálogo todavía */ }
  const tables = build(clientId, clientName, services, products);
  const relations = {
    quotes: (r) => ({ ...r, leads: tables.leads.find((l) => l.id === r.lead_id) || null }),
  };
  const stamp = () => new Date().toISOString();
  const rpc = (fn, args = {}) => {
    const done = (data = null) => Promise.resolve({ data, error: null });
    if (fn === 'update_lead') {
      const l = tables.leads.find((x) => x.id === args.p_id);
      if (l) {
        if (args.p_note) tables.lead_notes.push({ id: `ln${Math.random()}`, lead_id: l.id, client_id: clientId, body: args.p_note, author_name: 'Tú', status_from: l.status, status_to: args.p_status, created_at: stamp() });
        Object.assign(l, { status: args.p_status, follow_up_at: args.p_follow_up_at, caller_id: args.p_caller, seller_id: args.p_seller, deal_value: args.p_value ?? l.deal_value, updated_at: stamp() });
        if (args.p_seller && !l.passed_at) l.passed_at = stamp();
        if (['won', 'lost'].includes(args.p_status)) l.closed_at = stamp();
      }
      return done();
    }
    if (fn === 'update_lead_profile') {
      const l = tables.leads.find((x) => x.id === args.p_id);
      if (l) Object.assign(l, { email: args.p_email || null, address: args.p_address || null, postal_code: args.p_postal || null, province: args.p_province || null, property_type: args.p_property || null, water_notes: args.p_water || null, install_notes: args.p_install || null });
      return done();
    }
    if (fn === 'update_lead_ficha') {
      const l = tables.leads.find((x) => x.id === args.p_id);
      if (l) {
        const d = { ...args.p_data };
        ['family_members', 'children_at_home'].forEach((k) => { if (k in d) d[k] = d[k] === '' ? null : Number(d[k]); });
        Object.keys(d).forEach((k) => { if (d[k] === '') d[k] = null; });
        Object.assign(l, d, { updated_at: stamp() });
      }
      return done();
    }
    if (fn === 'lead_resolve_averia') {
      const l = tables.leads.find((x) => x.id === args.p_id);
      if (l) l.resolved_at = args.p_on === false ? null : new Date().toISOString();
      return done();
    }
    if (fn === 'lead_presence_set' || fn === 'lead_presence_set2') return done();
    if (fn === 'lead_to_customer') {
      const l = tables.leads.find((x) => x.id === args.p_lead);
      if (!l) return done();
      const phone = String(l.contact || '').replace(/\D/g, '').slice(-9);
      const row = { id: `cu${Math.random()}`, client_id: clientId, name: l.name || 'Sin nombre', phone, email: l.email, address: l.address, town: l.town, postal_code: l.postal_code, province: l.province, equipment: null, installed_at: null, last_maintenance_at: null, notes: null, lead_id: l.id, created_at: new Date().toISOString() };
      tables.customers.push(row);
      return done(row.id);
    }
    if (fn === 'schedule_visit') {
      const l = tables.leads.find((x) => x.id === args.p_lead);
      if (!l) return done();
      tables.calendar_events = tables.calendar_events.filter((e) => e.lead_id !== l.id);
      if (!args.p_date) { Object.assign(l, { visit_at: null, visit_member_id: null }); return done({ removed: true }); }
      const day = new Date(`${args.p_date}T${args.p_time || '00:00'}`);
      const cal = args.p_member ? tables.calendars.find((c) => c.member_id === args.p_member && c.agenda_group === 'comercial') : tables.calendars.find((c) => c.agenda_group === 'visitas');
      tables.calendar_events.push({ id: `v${Math.random()}`, client_id: clientId, calendar_id: cal?.id, title: `Visita · ${l.name} · ${l.contact}`, starts_at: day.toISOString(), ends_at: new Date(day.getTime() + (args.p_time ? (args.p_minutes || 60) * 60_000 : 86_400_000)).toISOString(), all_day: !args.p_time, source: 'panel', lead_id: l.id });
      Object.assign(l, { visit_at: day.toISOString(), visit_member_id: args.p_member || null });
      if (args.p_member) Object.assign(l, { seller_id: args.p_member, status: ['won', 'lost'].includes(l.status) ? l.status : 'with_sales' });
      return done({ ok: true });
    }
    if (fn === 'lead_team') return done([]);
    return real.rpc(fn, args);
  };
  return {
    from: (name) => (name in tables ? makeTable(tables, name, relations) : real.from(name)),
    rpc,
    auth: real.auth,
    storage: real.storage,
    functions: { invoke: async () => ({ data: null, error: new Error('Esto es un ejemplo: aquí no se conecta nada.') }) },
  };
}
