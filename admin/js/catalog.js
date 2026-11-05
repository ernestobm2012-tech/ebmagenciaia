// Catálogo de productos (sin precios), ficha del contacto con el equipo que se va a montar
// y presupuestos. El precio lo pone el comercial en cada presupuesto: a pago único,
// mensual o las dos cosas. El PDF se genera en el navegador (imprimir › guardar como PDF).
import { db, session } from './app.js';
import { h, q, table, modal, field, toast, errorText, fmtDate, fmtEur, formData } from './ui.js';

const STATUS = { draft: 'Borrador', sent: 'Enviado', accepted: 'Aceptado', rejected: 'Rechazado' };
const OFFER = { cash: 'Solo pago único', monthly: 'Solo cuotas mensuales', both: 'Las dos formas' };
const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
// replaceChildren pinta «null» si le pasas null: aquí se descartan los vacíos.
const fill = (el, ...nodes) => el.replaceChildren(...nodes.filter(Boolean));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ------------------------------------------------------------------ página con pestañas (ficha del cliente, admin)
export async function catalogPage(clientId) {
  const wrap = h('div', {});
  const bar = h('div', { class: 'lead-views' });
  const body = h('div', {});
  const views = [
    { label: 'Catálogo', render: () => catalogView(clientId) },
    { label: 'Presupuestos', render: () => quotesView(clientId) },
  ];
  let current = views[0];
  async function show() {
    bar.replaceChildren(...views.map((v) => h('button', { type: 'button', class: `seg${v === current ? ' on' : ''}`, onclick: () => { current = v; show(); } }, v.label)));
    body.replaceChildren(h('p', { class: 'empty' }, 'Cargando…'));
    try { body.replaceChildren(await current.render()); } catch (err) { body.replaceChildren(h('p', { class: 'error' }, errorText(err))); }
  }
  wrap.append(bar, body);
  await show();
  return wrap;
}

// ------------------------------------------------------------------ catálogo
export async function catalogView(clientId) {
  const wrap = h('div', {});
  let rows = [];
  let category = '';
  let search = '';

  async function load() {
    rows = await q(db.from('products').select('*').eq('client_id', clientId).order('category', { nullsFirst: false }).order('name'));
    render();
  }

  function render() {
    const cats = [...new Set(rows.map((r) => r.category).filter(Boolean))].sort();
    const text = search.trim().toLowerCase();
    const list = rows.filter((r) => (!category || r.category === category)
      && (!text || `${r.name} ${r.category || ''} ${r.description || ''}`.toLowerCase().includes(text)));
    const find = h('input', { type: 'search', placeholder: 'Buscar un producto…', value: search, class: 'cat-search',
      oninput: (e) => { search = e.target.value; const pos = e.target.selectionStart; render(); const el = wrap.querySelector('.cat-search'); el.focus(); el.setSelectionRange(pos, pos); } });
    fill(wrap, 
      h('div', { class: 'title-row' },
        h('button', { class: 'btn primary', type: 'button', onclick: () => editProduct(null) }, 'Añadir producto'),
        h('button', { class: 'btn', type: 'button', onclick: importProducts }, 'Importar una lista'),
        h('div', { class: 'spacer' }), find),
      cats.length ? h('div', { class: 'lead-filters' },
        h('button', { type: 'button', class: `chip${category === '' ? ' on' : ''}`, onclick: () => { category = ''; render(); } }, `Todos · ${rows.length}`),
        ...cats.map((c) => h('button', { type: 'button', class: `chip${category === c ? ' on' : ''}`, onclick: () => { category = c; render(); } },
          `${c} · ${rows.filter((r) => r.category === c).length}`))) : null,
      table([
        { label: 'Producto', primary: true, cell: (r) => h('div', {}, h('b', {}, r.name), r.description ? h('div', { class: 'muted small clip', style: 'display:block' }, r.description) : null) },
        { label: 'Tipo', cell: (r) => r.category || '—' },
        { label: 'Estado', cell: (r) => h('span', { class: `badge ${r.active ? 'active' : 'paused'}` }, r.active ? 'En catálogo' : 'Retirado') },
      ], list, { empty: rows.length ? 'Ningún producto con ese filtro.' : 'Todavía no hay productos. Añade el primero o importa tu lista.', onRow: editProduct }));
  }

  function editProduct(p) {
    const cats = [...new Set(rows.map((r) => r.category).filter(Boolean))].sort();
    const error = h('p', { class: 'error' });
    const form = h('form', { class: 'form', onsubmit: submit },
      field('Nombre', h('input', { name: 'name', required: true, value: p?.name || '', placeholder: 'Ej.: Ósmosis inversa compacta' })),
      field('Tipo', h('input', { name: 'category', value: p?.category || '', list: 'cat-list', placeholder: 'Ej.: Ósmosis, Descalcificador, Fuente…' }),
        'Sirve para agrupar el catálogo.'),
      h('datalist', { id: 'cat-list' }, cats.map((c) => h('option', { value: c }))),
      field('Descripción corta', h('textarea', { name: 'description', rows: 2, placeholder: 'Qué es y para quién va bien.' }, p?.description || ''),
        'Sale en el presupuesto.'),
      field('Características', h('textarea', { name: 'features', rows: 4, placeholder: 'Una por línea.' }, p?.features || ''),
        'Sale como lista en el presupuesto.'),
      field('Enlace a la ficha técnica', h('input', { name: 'sheet_url', type: 'url', value: p?.sheet_url || '', placeholder: 'https://…' })),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'active', checked: p ? p.active : true }), h('span', {}, 'Está en el catálogo (si lo retiras no se puede elegir, pero se conservan los presupuestos antiguos)')),
      error,
      h('div', {}, h('button', { class: 'btn primary', type: 'submit' }, 'Guardar'), ' ',
        p ? h('button', { class: 'btn danger', type: 'button', onclick: remove }, 'Borrar') : null));
    const close = modal(p ? p.name : 'Nuevo producto', form);

    async function submit(e) {
      e.preventDefault();
      error.textContent = '';
      const v = formData(form);
      const row = { name: v.name, category: v.category, description: v.description, features: v.features, sheet_url: v.sheet_url, active: !!v.active };
      try {
        if (p) await q(db.from('products').update(row).eq('id', p.id));
        else await q(db.from('products').insert({ ...row, client_id: clientId }));
        toast('Guardado');
        close();
        await load();
      } catch (err) { error.textContent = errorText(err); }
    }
    async function remove() {
      if (!confirm(`¿Borrar «${p.name}»? Mejor retíralo del catálogo si ya salió en algún presupuesto.`)) return;
      try { await q(db.from('products').delete().eq('id', p.id)); toast('Borrado'); close(); await load(); } catch (err) { error.textContent = errorText(err); }
    }
  }

  // Lista pegada o archivo CSV/TXT: nombre ; tipo ; descripción (separado por ; , o tabulador).
  function importProducts() {
    const area = h('textarea', { rows: 10, placeholder: 'Un producto por línea:\nÓsmosis compacta ; Ósmosis ; Para casa, bajo el fregadero\nDescalcificador 20 L ; Descalcificador ; Para viviendas de hasta 4 personas' });
    const file = h('input', { type: 'file', accept: '.csv,.txt,text/csv,text/plain' });
    file.addEventListener('change', async () => { if (file.files[0]) area.value = await file.files[0].text(); });
    const error = h('p', { class: 'error' });
    const go = h('button', { class: 'btn primary', type: 'button', onclick: run }, 'Importar');
    const close = modal('Importar una lista de productos', h('div', { class: 'form' },
      h('p', { class: 'muted' }, 'Pega aquí tu lista o sube un archivo de texto o CSV (si lo tienes en Excel, guárdalo como CSV). Columnas: nombre, tipo y descripción; la primera es la única obligatoria.'),
      file, area, error, h('div', {}, go)));

    async function run() {
      error.textContent = '';
      const lines = area.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (!lines.length) { error.textContent = 'No hay nada que importar.'; return; }
      const sep = lines.some((l) => l.includes('\t')) ? '\t' : lines.some((l) => l.includes(';')) ? ';' : ',';
      const parsed = lines.map((l) => l.split(sep).map((c) => c.trim().replace(/^"|"$/g, '')));
      if (/^(nombre|producto|name)$/i.test(parsed[0][0])) parsed.shift();
      const known = new Set(rows.map((r) => r.name.toLowerCase()));
      const fresh = parsed.filter((c) => c[0] && !known.has(c[0].toLowerCase()))
        .map((c) => ({ client_id: clientId, name: c[0], category: c[1] || null, description: c[2] || null }));
      if (!fresh.length) { error.textContent = 'Todos esos productos ya están en el catálogo.'; return; }
      go.disabled = true;
      try {
        await q(db.from('products').insert(fresh));
        toast(`${fresh.length} productos añadidos`);
        close();
        await load();
      } catch (err) { error.textContent = errorText(err); go.disabled = false; }
    }
  }

  await load();
  return wrap;
}

// ------------------------------------------------------------------ presupuestos: lista
export async function quotesView(clientId, { leadId = null, lead = null, ctx = null } = {}) {
  const wrap = h('div', {});
  async function load() {
    let query = db.from('quotes').select('*, leads(id, name, contact, client_id, status, follow_up_at, caller_id, seller_id, clients(name))').order('created_at', { ascending: false }).limit(500);
    if (clientId) query = query.eq('client_id', clientId);
    if (leadId) query = query.eq('lead_id', leadId);
    const rows = await q(query);
    fill(wrap, 
      leadId ? h('p', {}, h('button', { class: 'btn primary', type: 'button', onclick: () => openQuote(null, { lead, clientId: lead.client_id, onSaved: load }) }, 'Nuevo presupuesto')) : null,
      table([
        { label: 'Nº', cell: (r) => `#${r.number}` },
        { label: 'Fecha', hideM: true, cell: (r) => fmtDate(r.created_at) },
        { label: 'Cliente', primary: true, cell: (r) => r.customer_name || r.leads?.name || '—' },
        { label: 'Estado', cell: (r) => h('span', { class: `badge q-${r.status}` }, STATUS[r.status]) },
        { label: 'Pago único', num: true, cell: (r) => (r.cash_total != null && r.offer !== 'monthly' ? fmtEur(r.cash_total) : '—') },
        { label: 'Al mes', num: true, cell: (r) => (r.monthly_total != null && r.offer !== 'cash' ? `${fmtEur(r.monthly_total)}${r.months ? ` × ${r.months}` : ''}` : '—') },
      ], rows, {
        empty: leadId ? 'Este contacto todavía no tiene presupuestos.' : 'Todavía no hay presupuestos. Se crean desde la ficha de cada contacto.',
        onRow: (r) => openQuote(r, { lead: lead || r.leads, clientId: r.client_id, onSaved: load }),
      }));
  }
  await load();
  void ctx;
  return wrap;
}

// ------------------------------------------------------------------ ficha completa y equipo (dentro del contacto)
export async function fichaTab(lead, { onChanged = () => {} } = {}) {
  const wrap = h('div', {});
  let equipment = [];
  let catalog = [];

  async function load() {
    [equipment, catalog] = await Promise.all([
      q(db.from('lead_products').select('*').eq('lead_id', lead.id).order('created_at')),
      q(db.from('products').select('id, name, category, description, active').eq('client_id', lead.client_id).eq('active', true).order('category').order('name')),
    ]);
    render();
  }

  function render() {
    const error = h('p', { class: 'error' });
    const property = h('select', { name: 'property_type' },
      h('option', { value: '' }, '—'),
      h('option', { value: 'casa', selected: lead.property_type === 'casa' }, 'Casa'),
      h('option', { value: 'negocio', selected: lead.property_type === 'negocio' }, 'Negocio'));
    const input = (name, label, extra = {}) => field(label, h('input', { name, value: lead[name] || '', ...extra }));
    const save = h('button', { class: 'btn primary', type: 'submit' }, 'Guardar la ficha');
    const form = h('form', { class: 'form', onsubmit: submit },
      h('div', { class: 'grid2' },
        field('Es', property),
        input('email', 'Correo', { type: 'email' }),
        input('address', 'Dirección de la instalación'),
        input('postal_code', 'Código postal', { inputmode: 'numeric' }),
        input('province', 'Provincia')),
      field('Cómo es el agua y cómo se apaña ahora', h('textarea', { name: 'water_notes', rows: 3, placeholder: 'Qué bebe, cuánto gasta, qué le molesta…' }, lead.water_notes || '')),
      field('Notas de la instalación', h('textarea', { name: 'install_notes', rows: 3, placeholder: 'Dónde iría, toma de agua, desagüe, horario para ir…' }, lead.install_notes || '')),
      error, h('div', {}, save));

    async function submit(e) {
      e.preventDefault();
      error.textContent = '';
      save.disabled = true;
      const v = Object.fromEntries(new FormData(form));
      try {
        await q(db.rpc('update_lead_profile', { p_id: lead.id, p_email: v.email, p_address: v.address, p_postal: v.postal_code,
          p_province: v.province, p_property: v.property_type, p_water: v.water_notes, p_install: v.install_notes }));
        Object.assign(lead, { email: v.email || null, address: v.address || null, postal_code: v.postal_code || null, province: v.province || null,
          property_type: v.property_type || null, water_notes: v.water_notes || null, install_notes: v.install_notes || null });
        toast('Ficha guardada');
        onChanged();
      } catch (err) { error.textContent = errorText(err); }
      save.disabled = false;
    }

    // Equipo
    const pick = h('select', {}, h('option', { value: '' }, 'Elige un producto del catálogo…'),
      catalog.map((p) => h('option', { value: p.id }, `${p.category ? `${p.category} · ` : ''}${p.name}`)));
    const qty = h('input', { type: 'number', min: 1, value: 1, style: 'width:70px' });
    const add = async () => {
      const p = catalog.find((x) => x.id === pick.value);
      if (!p) return;
      try {
        await q(db.from('lead_products').insert({ client_id: lead.client_id, lead_id: lead.id, product_id: p.id, name: p.name, qty: Number(qty.value) || 1 }));
        await load();
      } catch (err) { toast(errorText(err), 'error'); }
    };
    fill(wrap, 
      h('h3', {}, 'Datos del cliente'), form,
      h('h3', {}, 'Equipo que se va a montar'),
      catalog.length ? null : h('p', { class: 'muted small' }, 'El catálogo está vacío: añade productos en el menú «Catálogo».'),
      equipment.length ? h('div', { class: 'table-wrap' }, h('table', {}, h('tbody', {}, equipment.map((e) => h('tr', {},
        h('td', {}, h('b', {}, e.name)), h('td', {}, `× ${e.qty}`),
        h('td', { class: 'num' }, h('button', { class: 'btn link', type: 'button', onclick: async () => { await q(db.from('lead_products').delete().eq('id', e.id)); await load(); } }, 'Quitar'))))))) : h('p', { class: 'empty' }, 'Todavía no hay equipo elegido.'),
      h('div', { class: 'title-row' }, pick, qty, h('button', { class: 'btn', type: 'button', onclick: add }, 'Añadir')),
      equipment.length ? h('p', {}, h('button', { class: 'btn primary', type: 'button', onclick: () => openQuote(null, { lead, clientId: lead.client_id, fromEquipment: equipment, onSaved: onChanged }) }, 'Crear presupuesto con este equipo')) : null);
  }

  await load();
  return wrap;
}

// ------------------------------------------------------------------ editor de presupuesto
async function brandOf(clientId, lead) {
  if (session.client?.id === clientId) return { name: session.client.name, logo: session.clientLogo };
  const row = await q(db.from('clients').select('name, logo_url').eq('id', clientId).maybeSingle()).catch(() => null);
  return { name: row?.name || lead?.clients?.name || '', logo: row?.logo_url || null };
}

export async function openQuote(quote, { lead = null, clientId, fromEquipment = null, onSaved = () => {} }) {
  const isNew = !quote;
  const q0 = quote || {};
  const [catalog, itemRows] = await Promise.all([
    q(db.from('products').select('id, name, description, active').eq('client_id', clientId).eq('active', true).order('name')),
    isNew ? [] : q(db.from('quote_items').select('*').eq('quote_id', quote.id).order('sort')),
  ]);
  let items = isNew
    ? (fromEquipment || []).map((e) => ({ product_id: e.product_id, name: e.name, description: catalog.find((c) => c.id === e.product_id)?.description || '', qty: e.qty, unit_cash: null, unit_monthly: null }))
    : itemRows.map((i) => ({ ...i }));

  const state = {
    offer: q0.offer || 'both', months: q0.months ?? 60, discount: q0.discount_eur ?? 0,
    valid_until: q0.valid_until || '', intro: q0.intro ?? '', conditions: q0.conditions ?? '',
    customer_name: q0.customer_name ?? lead?.name ?? '', customer_contact: q0.customer_contact ?? [lead?.contact, lead?.email].filter(Boolean).join(' · '),
    customer_address: q0.customer_address ?? [lead?.address, [lead?.postal_code, lead?.province].filter(Boolean).join(' ')].filter(Boolean).join(', '),
  };
  const totals = h('div', { class: 'quote-totals' });
  const itemsBox = h('div', { class: 'quote-items' });
  const error = h('p', { class: 'error' });
  const locked = q0.status === 'accepted';

  const calc = () => {
    const cash = items.reduce((a, i) => a + (num(i.unit_cash) || 0) * i.qty, 0) - (num(state.discount) || 0);
    const monthly = items.reduce((a, i) => a + (num(i.unit_monthly) || 0) * i.qty, 0);
    return { cash: Math.max(0, cash), monthly };
  };
  function paintTotals() {
    const t = calc();
    fill(totals, 
      state.offer !== 'monthly' ? h('div', {}, 'Pago único: ', h('b', {}, fmtEur(t.cash))) : null,
      state.offer !== 'cash' ? h('div', {}, 'Cuota mensual: ', h('b', {}, fmtEur(t.monthly)), state.months ? ` × ${state.months} meses = ${fmtEur(t.monthly * state.months)}` : '') : null);
  }
  function paintItems() {
    fill(itemsBox, 
      items.length ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Concepto'), h('th', {}, 'Uds.'),
          state.offer !== 'monthly' ? h('th', { class: 'num' }, 'Precio ud. (€)') : null,
          state.offer !== 'cash' ? h('th', { class: 'num' }, 'Al mes ud. (€)') : null, h('th', {}))),
        h('tbody', {}, items.map((it, idx) => {
          const money = (key) => h('input', { type: 'number', min: 0, step: '0.01', inputmode: 'decimal', style: 'width:110px', value: it[key] ?? '', disabled: locked,
            oninput: (e) => { it[key] = e.target.value === '' ? null : Number(e.target.value); paintTotals(); } });
          return h('tr', {},
            h('td', { class: 'q-name' }, h('input', { value: it.name, disabled: locked, oninput: (e) => { it.name = e.target.value; } }),
              h('input', { class: 'small', placeholder: 'Descripción (opcional)', value: it.description || '', disabled: locked, oninput: (e) => { it.description = e.target.value; } })),
            h('td', { 'data-label': 'Uds.' }, h('input', { type: 'number', min: 1, style: 'width:60px', value: it.qty, disabled: locked, oninput: (e) => { it.qty = Math.max(1, Number(e.target.value) || 1); paintTotals(); } })),
            state.offer !== 'monthly' ? h('td', { class: 'num', 'data-label': 'Precio ud. (€)' }, money('unit_cash')) : null,
            state.offer !== 'cash' ? h('td', { class: 'num', 'data-label': 'Al mes ud. (€)' }, money('unit_monthly')) : null,
            h('td', { class: 'q-del' }, locked ? null : h('button', { class: 'btn link', type: 'button', onclick: () => { items.splice(idx, 1); paintItems(); paintTotals(); } }, 'Quitar')));
        })))) : h('p', { class: 'empty' }, 'Añade el equipo y las líneas que quieras (instalación, mantenimiento…).'));
  }

  const pick = h('select', {}, h('option', { value: '' }, 'Añadir del catálogo…'), catalog.map((p) => h('option', { value: p.id }, p.name)));
  pick.addEventListener('change', () => {
    const p = catalog.find((x) => x.id === pick.value);
    if (p) { items.push({ product_id: p.id, name: p.name, description: p.description || '', qty: 1, unit_cash: null, unit_monthly: null }); paintItems(); paintTotals(); }
    pick.value = '';
  });
  const offerSel = h('select', { disabled: locked, onchange: (e) => { state.offer = e.target.value; paintItems(); paintTotals(); } },
    Object.entries(OFFER).map(([v, l]) => h('option', { value: v, selected: state.offer === v }, l)));
  const bind = (key, extra = {}) => h('input', { value: state[key] ?? '', disabled: locked, oninput: (e) => { state[key] = e.target.value; if (key === 'months' || key === 'discount') paintTotals(); }, ...extra });
  const area = (key, rows, ph) => h('textarea', { rows, placeholder: ph, disabled: locked, oninput: (e) => { state[key] = e.target.value; } }, state[key] || '');

  const body = h('div', { class: 'form quote-editor' },
    h('div', { class: 'grid2' },
      field('Cliente', bind('customer_name')), field('Contacto', bind('customer_contact')),
      field('Dirección', bind('customer_address')), field('Válido hasta', bind('valid_until', { type: 'date' }))),
    h('h3', {}, 'Equipo y precios'),
    h('div', { class: 'grid2' }, field('Cómo se ofrece', offerSel), field('Meses de cuotas', bind('months', { type: 'number', min: 1, inputmode: 'numeric' }))),
    itemsBox,
    locked ? null : h('div', { class: 'title-row' }, pick,
      h('button', { class: 'btn', type: 'button', onclick: () => { items.push({ product_id: null, name: '', description: '', qty: 1, unit_cash: null, unit_monthly: null }); paintItems(); } }, 'Añadir una línea libre')),
    h('div', { class: 'grid2' }, field('Descuento en pago único (€)', bind('discount', { type: 'number', min: 0, step: '0.01', inputmode: 'decimal' }))),
    totals,
    field('Texto de presentación', area('intro', 3, 'Opcional: un saludo o lo que habéis hablado.')),
    field('Condiciones', area('conditions', 4, 'Instalación, garantía, mantenimiento, forma de pago…')),
    error);

  const buttons = h('div', { class: 'title-row' });
  const close = modal(isNew ? 'Nuevo presupuesto' : `Presupuesto #${q0.number}`, h('div', {}, body, buttons), { wide: true });
  paintItems();
  paintTotals();

  let current = quote;
  async function persist(status) {
    error.textContent = '';
    const clean = items.filter((i) => i.name.trim());
    if (!clean.length) throw new Error('Añade al menos una línea.');
    const t = calc();
    const row = {
      client_id: clientId, lead_id: lead?.id ?? null, offer: state.offer, months: num(state.months),
      discount_eur: num(state.discount) || 0, cash_total: t.cash, monthly_total: t.monthly,
      valid_until: state.valid_until || null, intro: state.intro?.trim() || null, conditions: state.conditions?.trim() || null,
      customer_name: state.customer_name?.trim() || null, customer_contact: state.customer_contact?.trim() || null, customer_address: state.customer_address?.trim() || null,
      status: status || current?.status || 'draft',
      ...(status === 'sent' ? { sent_at: new Date().toISOString() } : {}),
      ...(status === 'accepted' || status === 'rejected' ? { decided_at: new Date().toISOString() } : {}),
    };
    if (!current) {
      const created = await q(db.from('quotes').insert({ ...row, created_by: session.user?.id }).select().single());
      current = created;
    } else {
      await q(db.from('quotes').update(row).eq('id', current.id));
      current = { ...current, ...row };
      await q(db.from('quote_items').delete().eq('quote_id', current.id));
    }
    await q(db.from('quote_items').insert(clean.map((i, n) => ({
      quote_id: current.id, product_id: i.product_id || null, name: i.name.trim(), description: i.description?.trim() || null,
      qty: i.qty, unit_cash: num(i.unit_cash), unit_monthly: num(i.unit_monthly), sort: n }))));
    return { quote: current, items: clean };
  }

  const act = (label, cls, fn) => h('button', { class: `btn ${cls}`, type: 'button', onclick: async (e) => {
    e.target.disabled = true;
    try { await fn(); } catch (err) { error.textContent = errorText(err); }
    e.target.disabled = false;
  } }, label);

  if (!locked) {
    buttons.append(act('Guardar', 'primary', async () => { await persist(); toast('Presupuesto guardado'); onSaved(); close(); }));
  }
  buttons.append(act('Ver / guardar en PDF', '', async () => {
    const saved = locked ? { quote: current, items } : await persist();
    onSaved();
    await printQuote(saved.quote, saved.items, lead, await brandOf(clientId, lead));
  }));
  if (!locked) {
    buttons.append(act('Marcar como enviado', '', async () => { await persist('sent'); toast('Marcado como enviado'); onSaved(); close(); }));
    buttons.append(act('Aceptado', '', async () => {
      const t = calc();
      let amount = t.cash;
      if (state.offer === 'monthly') amount = t.monthly * (num(state.months) || 1);
      if (state.offer === 'both') {
        const asked = prompt(`¿Qué ha elegido?\n1 = pago único (${fmtEur(t.cash)})\n2 = cuotas (${fmtEur(t.monthly)} × ${state.months || 1} = ${fmtEur(t.monthly * (num(state.months) || 1))})`, '1');
        if (asked == null) return;
        if (asked.trim() === '2') amount = t.monthly * (num(state.months) || 1);
      }
      const saved = await persist('accepted');
      if (lead?.id) {
        await q(db.rpc('update_lead', { p_id: lead.id, p_status: 'won', p_follow_up_at: lead.follow_up_at ?? null,
          p_caller: lead.caller_id ?? null, p_seller: lead.seller_id ?? null, p_value: amount, p_note: `Presupuesto #${saved.quote.number} aceptado: ${fmtEur(amount)}.` }));
        Object.assign(lead, { status: 'won', deal_value: amount });
      }
      toast('Aceptado: el contacto pasa a cliente');
      onSaved(); close();
    }));
    buttons.append(act('Rechazado', '', async () => { await persist('rejected'); toast('Marcado como rechazado'); onSaved(); close(); }));
  }
  if (current && !locked) buttons.append(act('Borrar', 'danger', async () => {
    if (!confirm('¿Borrar este presupuesto?')) return;
    await q(db.from('quotes').delete().eq('id', current.id));
    onSaved(); close();
  }));
}

// ------------------------------------------------------------------ PDF (ventana de impresión)
async function toDataUrl(url) {
  try {
    const blob = await (await fetch(url)).blob();
    return await new Promise((ok, fail) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = fail; r.readAsDataURL(blob); });
  } catch { return null; }
}

async function printQuote(quote, items, lead, brand) {
  const money = (n) => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(Number(n) || 0);
  const showCash = quote.offer !== 'monthly';
  const showMonthly = quote.offer !== 'cash';
  const productIds = items.map((i) => i.product_id).filter(Boolean);
  const features = {};
  if (productIds.length) {
    const prods = await q(db.from('products').select('id, features').in('id', productIds)).catch(() => []);
    for (const p of prods) features[p.id] = p.features;
  }
  // El logo se incrusta en la página para que salga siempre al imprimir.
  const logo = brand.logo ? await toDataUrl(new URL(brand.logo, location.href).href) : null;
  const rows = items.map((i) => {
    const list = (features[i.product_id] || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return `<tr><td><b>${esc(i.name)}</b>${i.description ? `<div class="d">${esc(i.description)}</div>` : ''}${list.length ? `<ul>${list.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}</td>
      <td class="n">${i.qty}</td>${showCash ? `<td class="n">${i.unit_cash != null ? money(i.unit_cash) : '—'}</td>` : ''}${showMonthly ? `<td class="n">${i.unit_monthly != null ? money(i.unit_monthly) : '—'}</td>` : ''}</tr>`;
  }).join('');
  const months = quote.months || 0;
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Presupuesto ${quote.number} · ${esc(brand.name)}</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body { font: 13px/1.5 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #1c2430; margin: 0; }
  header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #1483dc; padding-bottom: 14px; margin-bottom: 20px; }
  header img { height: 54px; width: 54px; border-radius: 50%; object-fit: cover; margin-right: 12px; }
  .brand { display: flex; align-items: center; font-weight: 800; font-size: 18px; letter-spacing: .04em; text-transform: uppercase; }
  .meta { text-align: right; color: #5a6676; }
  .meta b { color: #1c2430; font-size: 16px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: #1483dc; margin: 22px 0 6px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; color: #5a6676; border-bottom: 1px solid #cfd6df; padding: 6px 4px; }
  td { padding: 9px 4px; border-bottom: 1px solid #e6eaf0; vertical-align: top; }
  .n { text-align: right; white-space: nowrap; }
  .d { color: #5a6676; font-size: 12px; } ul { margin: 4px 0 0 16px; padding: 0; color: #3b4656; font-size: 12px; }
  .tot { margin: 18px 0 0 auto; width: 320px; background: #f2f7fd; border-radius: 10px; padding: 12px 16px; }
  .tot div { display: flex; justify-content: space-between; padding: 3px 0; }
  .tot .big { font-size: 17px; font-weight: 800; border-top: 1px solid #cfe0f3; margin-top: 6px; padding-top: 8px; }
  .box { white-space: pre-wrap; } .small { color: #5a6676; font-size: 11px; margin-top: 26px; }
  @media screen { body { max-width: 820px; margin: 0 auto; padding: 28px 24px 60px; } }
  @media print { .bar { display: none; } }
  .bar { position: fixed; top: 10px; right: 10px; } .bar button { font: inherit; padding: 8px 14px; border-radius: 8px; border: 0; background: #1483dc; color: #fff; cursor: pointer; }
</style></head><body>
<div class="bar"><button onclick="print()">Imprimir o guardar como PDF</button></div>
<header><div class="brand">${logo ? `<img src="${esc(logo)}" alt="">` : ''}${esc(brand.name)}</div>
  <div class="meta"><b>Presupuesto nº ${quote.number}</b><br>${fmtDate(quote.created_at || new Date())}${quote.valid_until ? `<br>Válido hasta el ${fmtDate(quote.valid_until)}` : ''}</div></header>
${quote.customer_name || quote.customer_contact || quote.customer_address ? `<h2>Para</h2><div><b>${esc(quote.customer_name)}</b>${quote.customer_contact ? `<br>${esc(quote.customer_contact)}` : ''}${quote.customer_address ? `<br>${esc(quote.customer_address)}` : ''}</div>` : ''}
${quote.intro ? `<div class="box" style="margin-top:16px">${esc(quote.intro)}</div>` : ''}
<h2>Equipo</h2>
<table><thead><tr><th>Concepto</th><th class="n">Uds.</th>${showCash ? '<th class="n">Precio ud.</th>' : ''}${showMonthly ? '<th class="n">Al mes ud.</th>' : ''}</tr></thead><tbody>${rows}</tbody></table>
<div class="tot">
  ${showCash ? `${Number(quote.discount_eur) ? `<div><span>Descuento</span><span>− ${money(quote.discount_eur)}</span></div>` : ''}<div class="big"><span>Pago único</span><span>${money(quote.cash_total)}</span></div>` : ''}
  ${showMonthly ? `<div class="${showCash ? '' : 'big'}"><span>Cuota mensual${months ? ` (${months} meses)` : ''}</span><span>${money(quote.monthly_total)}</span></div>` : ''}
</div>
${quote.conditions ? `<h2>Condiciones</h2><div class="box">${esc(quote.conditions)}</div>` : ''}
</body></html>`;
  const w = window.open('', '_blank');
  if (!w) { toast('El navegador ha bloqueado la ventana. Permite las ventanas emergentes para ver el PDF.', 'error'); return; }
  w.document.open();
  w.document.write(html);
  w.document.close();
}
