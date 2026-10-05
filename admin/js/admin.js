// Panel de administración de EBM: clientes, agentes, avisos, costes y usuarios.
import { db, session, refresh } from './app.js';
import { MODELS, USD_TO_EUR } from './config.js';
import { activityTabs } from './activity.js';
import { knowledgeTab, connectionsTab } from './knowledge.js';
import { calendarsTab } from './calendars.js';
import { socialTab } from './social.js';
import { statsPage } from './stats.js';
import { printersView, printerKeysCard } from './printers.js';
import { expensesPage, expensesTab, fetchExpenses, monthlyEur } from './expenses.js';
import {
  h, q, table, tabs, badge, kpi, field, modal, toast, formData, errorText, slugify,
  fmtDate, fmtNum, fmtEur, fmtUsd, monthStart,
} from './ui.js';

export const adminNav = [
  { href: '#/', label: 'Resumen' },
  { href: '#/contactos', label: 'Contactos web' },
  { href: '#/clientes', label: 'Clientes' },
  { href: '#/actividad', label: 'Actividad' },
  { href: '#/estadisticas', label: 'Estadísticas' },
  { href: '#/impresoras', label: 'Impresoras' },
  { href: '#/costes', label: 'Costes y margen' },
  { href: '#/gastos', label: 'Gastos' },
  { href: '#/usuarios', label: 'Usuarios' },
];

export const adminRoutes = [
  [/^\/$/, overview],
  [/^\/contactos$/, contactsPage],
  [/^\/clientes$/, clientsPage],
  [/^\/clientes\/([0-9a-f-]{36})$/, clientPage],
  [/^\/actividad$/, activityPage],
  [/^\/estadisticas$/, statsPage],
  [/^\/impresoras$/, printersPage],
  [/^\/costes$/, costsPage],
  [/^\/gastos$/, expensesPage],
  [/^\/usuarios$/, usersPage],
];

const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
const page = (title, ...children) => h('div', { class: 'page' }, h('h1', {}, title), children);

// Clientes con sus cifras del mes: conversaciones y gasto de IA.
async function clientsWithMonth(month) {
  const [clients, convs, usage] = await Promise.all([
    q(db.from('clients').select('*').order('name')),
    q(db.from('conversations_monthly').select('*').eq('month', month)),
    q(db.from('usage_monthly').select('*').eq('month', month)),
  ]);
  const byClient = (rows) => Object.fromEntries(rows.map((r) => [r.client_id, r]));
  const c = byClient(convs);
  const u = byClient(usage);
  return clients.map((cl) => ({
    ...cl,
    conversations: Number(c[cl.id]?.conversations || 0),
    handed_off: Number(c[cl.id]?.handed_off || 0),
    calls: Number(u[cl.id]?.calls || 0),
    input_tokens: Number(u[cl.id]?.input_tokens || 0),
    output_tokens: Number(u[cl.id]?.output_tokens || 0),
    cost_usd: Number(u[cl.id]?.cost_usd || 0),
  }));
}

function budgetCell(r) {
  const pct = r.ai_budget_usd > 0 ? Math.round((r.cost_usd / r.ai_budget_usd) * 100) : 0;
  return h('span', { class: pct >= 80 ? 'warn' : null }, `${pct} %`);
}

// ---------------------------------------------------------------- resumen
async function overview() {
  const since = monthStart().toISOString();
  const count = (t) => q(db.from(t).select('*', { count: 'exact', head: true }).gte('created_at', since));
  const [rows, leads, errors] = await Promise.all([
    clientsWithMonth(isoDate(monthStart())), count('leads'), count('error_log'),
  ]);
  const sum = (key) => rows.reduce((a, r) => a + r[key], 0);
  const active = rows.filter((r) => r.status === 'active');
  const fees = active.reduce((a, r) => a + Number(r.monthly_fee_eur), 0);

  return page('Resumen del mes',
    h('div', { class: 'kpis' },
      kpi('Clientes activos', active.length,
        `${rows.filter((r) => r.status === 'demo').length} en demo · ${rows.filter((r) => r.status === 'paused').length} pausados`),
      kpi('Conversaciones', fmtNum(sum('conversations')), `${fmtNum(sum('handed_off'))} pasadas a humano`),
      kpi('Leads', fmtNum(leads)),
      kpi('Coste de IA', fmtUsd(sum('cost_usd')), `≈ ${fmtEur(sum('cost_usd') * USD_TO_EUR)}`),
      kpi('Cuotas activas', fmtEur(fees), 'al mes'),
      kpi('Errores', fmtNum(errors), errors ? 'Revisa Actividad › Errores' : 'Todo en orden')),
    h('h2', {}, 'Clientes'),
    table([
      { label: 'Cliente', cell: (r) => r.name },
      { label: 'Estado', cell: (r) => badge(r.status) },
      { label: 'Conversaciones', num: true, cell: (r) => fmtNum(r.conversations) },
      { label: 'Coste IA', num: true, cell: (r) => fmtUsd(r.cost_usd) },
      { label: 'Tope usado', num: true, cell: budgetCell },
    ], rows, { empty: 'Aún no hay clientes. Crea el primero en Clientes.', onRow: (r) => (location.hash = `#/clientes/${r.id}`) }));
}

// ---------------------------------------------------------------- contactos web
const SERVICES = { web: 'Página web', 'web-gestion': 'Web + gestión', software: 'Software a medida', agentes: 'Agentes de IA', otro: 'Otro' };

async function contactsPage() {
  const rows = await q(db.from('contact_messages').select('*').order('created_at', { ascending: false }).limit(200));
  const setStatus = async (row, status) => {
    try {
      await q(db.from('contact_messages').update({ status }).eq('id', row.id));
      row.status = status;
    } catch (err) {
      toast(errorText(err), 'error');
      refresh();
    }
  };
  const open = (r) => modal(`${r.name} · ${fmtDate(r.created_at)}`, h('div', { class: 'form' },
    h('p', {}, h('a', { href: `mailto:${r.email}` }, r.email), r.phone ? ` · ${r.phone}` : ''),
    h('p', { class: 'muted' }, SERVICES[r.service] || 'Sin servicio indicado'),
    h('div', { class: 'bubble-text' }, r.message)));

  return page('Contactos web', h('p', { class: 'muted' }, 'Mensajes que llegan desde el formulario de la web pública.'),
    table([
      { label: 'Fecha', cell: (r) => fmtDate(r.created_at) },
      { label: 'Nombre', cell: (r) => r.name },
      { label: 'Correo', cell: (r) => r.email },
      { label: 'Teléfono', cell: (r) => r.phone || '—' },
      { label: 'Interés', cell: (r) => SERVICES[r.service] || '—' },
      { label: 'Mensaje', cell: (r) => h('button', { class: 'btn link', type: 'button', onclick: () => open(r) }, 'Leer') },
      { label: 'Estado', cell: (r) => h('select', { onchange: (e) => setStatus(r, e.target.value) },
        [['new', 'Nuevo'], ['contacted', 'Contactado'], ['closed', 'Cerrado']].map(([v, l]) =>
          h('option', { value: v, selected: r.status === v }, l))) },
    ], rows, { empty: 'Aún no ha escrito nadie.' }));
}

// ---------------------------------------------------------------- clientes
// partners: clientes que pueden hacer de partner (todos menos el propio).
const SERVICES_OFFERED = [['agentes', 'Agentes de IA'], ['web', 'Página web'], ['software', 'Software'], ['impresoras', 'Lector de impresoras']];
const servicesText = (r) => (r.services || []).map((s) => Object.fromEntries(SERVICES_OFFERED)[s] || s).join(' · ');

function clientForm(client, onSaved, partners = []) {
  const c = client || {};
  const slug = h('input', { name: 'slug', required: true, pattern: '[a-z0-9-]+', value: c.slug || '' });
  const name = h('input', {
    name: 'name', required: true, value: c.name || '',
    oninput: () => { if (!client) slug.value = slugify(name.value); },
  });
  const note = h('p', { class: 'error' });
  const form = h('form', { class: 'form', onsubmit: submit },
    h('div', { class: 'grid2' },
      field('Nombre del negocio', name),
      field('Identificador', slug, 'Minúsculas y guiones. Lo usará el widget de chat.'),
      field('Estado', h('select', { name: 'status' },
        [['demo', 'Demo'], ['active', 'Activo'], ['paused', 'Pausado']].map(([v, l]) =>
          h('option', { value: v, selected: (c.status || 'demo') === v }, l)))),
      field('Plan', h('input', { name: 'plan', value: c.plan || '' })),
      h('div', { class: 'field' }, h('span', {}, 'Qué le hacemos'),
        h('div', { class: 'checks' }, SERVICES_OFFERED.map(([v, l]) =>
          h('label', { class: 'check' }, h('input', { type: 'checkbox', name: `service_${v}`, checked: (c.services || ['agentes']).includes(v) }), ` ${l}`))),
        h('small', {}, 'Las pestañas del cliente se adaptan a esto.')),
      field('Cuota mensual (€)', h('input', { name: 'monthly_fee_eur', type: 'number', min: 0, step: '0.01', value: c.monthly_fee_eur ?? 0 })),
      field('Conversaciones incluidas', h('input', { name: 'included_conversations', type: 'number', min: 0, value: c.included_conversations ?? 0 })),
      field('Tope mensual de IA ($)', h('input', { name: 'ai_budget_usd', type: 'number', min: 0, step: '0.01', value: c.ai_budget_usd ?? 20 }),
        'Si se supera, el agente de este cliente se frena.'),
      field('Web', h('input', { name: 'website_url', type: 'url', placeholder: 'https://', value: c.website_url || '' })),
      field('Persona de contacto', h('input', { name: 'contact_name', value: c.contact_name || '' })),
      field('Correo de contacto', h('input', { name: 'contact_email', type: 'email', value: c.contact_email || '' })),
      field('Se factura a través de', h('select', { name: 'parent_client_id' },
        h('option', { value: '' }, '— Directamente a EBM —'),
        partners.filter((p) => p.id !== c.id).map((p) => h('option', { value: p.id, selected: c.parent_client_id === p.id }, p.name))),
        'Si eliges un partner, este cliente ve la marca del partner y el partner lo ve en su panel.')),
    h('h2', {}, 'Marca propia (solo partners)'),
    h('p', { class: 'muted' }, 'Rellénalo si este cliente revende agentes a sus propios clientes. Ellos verán este nombre, logo y color en el panel y en los avisos, en lugar de los de EBM.'),
    h('div', { class: 'grid2' },
      field('Nombre de marca', h('input', { name: 'brand_name', value: c.brand_name || '' })),
      field('Color (#RRGGBB)', h('input', { name: 'brand_color', pattern: '#[0-9a-fA-F]{6}', placeholder: '#00A3E0', value: c.brand_color || '' })),
      field('Logo (dirección https)', h('input', { name: 'brand_logo_url', type: 'url', pattern: 'https://.+', value: c.brand_logo_url || '' }))),
    field('Notas', h('textarea', { name: 'notes', rows: 3 }, c.notes || '')),
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit' }, client ? 'Guardar' : 'Crear cliente')),
    note);

  async function submit(e) {
    e.preventDefault();
    try {
      const values = formData(form);
      values.services = SERVICES_OFFERED.map(([v]) => v).filter((v) => values[`service_${v}`]);
      for (const [v] of SERVICES_OFFERED) delete values[`service_${v}`];
      if (!values.services.length) return (note.textContent = 'Marca al menos un servicio.');
      const saved = client
        ? await q(db.from('clients').update(values).eq('id', client.id).select().single())
        : await q(db.from('clients').insert(values).select().single());
      toast('Cliente guardado.');
      onSaved(saved);
    } catch (err) {
      note.textContent = err.code === '23505' ? 'Ya existe un cliente con ese identificador.' : errorText(err);
    }
  }
  return form;
}

async function clientsPage() {
  const clients = await q(db.from('clients').select('*').order('name'));
  const nameOf = Object.fromEntries(clients.map((c) => [c.id, c.name]));
  const add = () => {
    const close = modal('Nuevo cliente', clientForm(null, (saved) => {
      close();
      location.hash = `#/clientes/${saved.id}`;
    }, clients), { wide: true });
  };
  return page('Clientes',
    h('div', { class: 'toolbar' }, h('button', { class: 'btn primary', type: 'button', onclick: add }, 'Nuevo cliente')),
    table([
      { label: 'Cliente', cell: (r) => r.name },
      { label: 'Estado', cell: (r) => badge(r.status) },
      { label: 'Servicios', cell: servicesText },
      { label: 'A través de', cell: (r) => nameOf[r.parent_client_id] || '—' },
      { label: 'Plan', cell: (r) => r.plan || '—' },
      { label: 'Cuota', num: true, cell: (r) => fmtEur(r.monthly_fee_eur) },
      { label: 'Alta', cell: (r) => fmtDate(r.created_at) },
    ], clients, { empty: 'Aún no hay clientes.', onRow: (r) => (location.hash = `#/clientes/${r.id}`) }));
}

async function clientPage(id) {
  const [client, partners] = await Promise.all([
    q(db.from('clients').select('*').eq('id', id).maybeSingle()),
    q(db.from('clients').select('id, name').order('name')),
  ]);
  if (!client) return page('Cliente no encontrado', h('a', { href: '#/clientes' }, 'Volver a clientes'));
  const hasAgents = (client.services || ['agentes']).includes('agentes');

  const setStatus = async (status) => {
    try {
      await q(db.from('clients').update({ status }).eq('id', id));
      toast(status === 'paused' ? 'Cliente pausado: su agente deja de responder.' : 'Cliente activado.');
      refresh();
    } catch (err) {
      toast(errorText(err), 'error');
    }
  };

  return h('div', { class: 'page' },
    h('a', { href: '#/clientes', class: 'back' }, '← Clientes'),
    h('div', { class: 'title-row' }, h('h1', {}, client.name), badge(client.status),
      h('span', { class: 'muted small' }, servicesText(client)),
      h('div', { class: 'spacer' }),
      client.status === 'paused'
        ? h('button', { class: 'btn', type: 'button', onclick: () => setStatus('active') }, 'Reactivar')
        : h('button', { class: 'btn', type: 'button', onclick: () => setStatus('paused') }, 'Pausar')),
    tabs([
      { id: 'data', label: 'Datos', render: async () => clientForm(client, refresh, partners) },
      ...(hasAgents ? [
        { id: 'agents', label: 'Agentes', render: () => agentsTab(id) },
        { id: 'knowledge', label: 'Conocimiento', render: () => knowledgeTab(id) },
        { id: 'connections', label: 'Conexiones (ERP/API)', render: () => connectionsTab(id) },
        { id: 'contacts', label: 'A quién avisar', render: () => contactsTab(id) },
        { id: 'calendars', label: 'Calendarios', render: () => calendarsTab(id) },
        { id: 'social', label: 'Redes sociales', render: () => socialTab(id) },
        { id: 'install', label: 'Instalar en su web', render: () => installTab(client) },
      ] : []),
      ...((client.services || []).includes('impresoras') ? [{ id: 'printers', label: 'Impresoras', render: async () =>
        h('div', {}, await printersView([id]), await printerKeysCard(id)) }] : []),
      { id: 'expenses', label: 'Gastos', render: () => expensesTab(id) },
      ...(hasAgents ? [{ id: 'activity', label: 'Actividad', render: async () => activityTabs({ clientId: id, isAdmin: true }) }] : []),
    ]));
}

// ---------------------------------------------------------------- agentes
const AGENT_ROLES = [['general', 'General'], ['ventas', 'Ventas'], ['soporte', 'Soporte'], ['citas', 'Citas'], ['enrutador', 'Enrutador']];

function agentForm(clientId, agent, onSaved) {
  const a = agent || {};
  const num = (name, def, min = 1) => h('input', { name, type: 'number', min, value: a[name] ?? def });
  const note = h('p', { class: 'error' });
  const form = h('form', { class: 'form', onsubmit: submit },
    h('div', { class: 'grid2' },
      field('Nombre', h('input', { name: 'name', required: true, value: a.name || '' })),
      field('Función', h('select', { name: 'role' },
        AGENT_ROLES.map(([v, l]) => h('option', { value: v, selected: (a.role || 'general') === v }, l)))),
      field('Modelo', h('select', { name: 'model' },
        MODELS.map((m) => h('option', { value: m.id, selected: (a.model || MODELS[0].id) === m.id }, m.label)))),
      field('Activo', h('input', { name: 'active', type: 'checkbox', checked: a.active ?? true })),
      field('Agente de voz (ElevenLabs)', h('input', { name: 'voice_agent_id', class: 'mono', placeholder: 'agent_…', value: a.voice_agent_id || '' }),
        'Id del agente telefónico. Sus llamadas se importan aquí cada 5 minutos. El prompt de voz se edita en ElevenLabs.')),
    field('Instrucciones (prompt)', h('textarea', { name: 'system_prompt', rows: 12, class: 'mono' }, a.system_prompt || ''),
      'Cómo debe hablar y qué puede y no puede hacer.'),
    field('Datos del negocio', h('textarea', { name: 'knowledge', rows: 10, class: 'mono' }, a.knowledge || ''),
      'Servicios, horarios, precios, preguntas frecuentes. El agente solo responde con lo que haya aquí.'),
    field('Mensaje de bienvenida', h('input', { name: 'welcome_message', value: a.welcome_message ?? '¡Hola! ¿En qué puedo ayudarte?' })),
    field('Mensaje si falla la IA', h('input', { name: 'fallback_message', value: a.fallback_message ?? 'Ahora mismo no puedo responderte. Un compañero te escribirá en breve.' }),
      'Se envía si la IA no responde o el cliente supera su tope. El mensaje se guarda como lead pendiente.'),
    h('div', { class: 'grid2' },
      field('Longitud máxima de respuesta (tokens)', num('max_output_tokens', 500, 50)),
      field('Mensajes de historial que se envían', num('max_history_messages', 20, 2)),
      field('Máx. mensajes por conversación', num('max_messages_per_conversation', 40)),
      field('Máx. mensajes por usuario y día', num('max_messages_per_user_day', 80))),
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit' }, agent ? 'Guardar' : 'Crear agente')),
    note);

  async function submit(e) {
    e.preventDefault();
    try {
      const values = formData(form);
      for (const key of ['system_prompt', 'knowledge', 'welcome_message', 'fallback_message']) values[key] ??= '';
      if (agent) await q(db.from('agents').update(values).eq('id', agent.id));
      else await q(db.from('agents').insert({ ...values, client_id: clientId }));
      toast('Agente guardado.');
      onSaved();
    } catch (err) {
      note.textContent = errorText(err);
    }
  }
  return form;
}

async function agentsTab(clientId) {
  const wrap = h('div', {});
  const edit = (agent) => {
    const close = modal(agent ? `Agente · ${agent.name}` : 'Nuevo agente',
      agentForm(clientId, agent, () => { close(); load(); }), { wide: true });
  };
  async function load() {
    const agents = await q(db.from('agents').select('*').eq('client_id', clientId).order('created_at'));
    wrap.replaceChildren(
      h('div', { class: 'toolbar' }, h('button', { class: 'btn primary', type: 'button', onclick: () => edit(null) }, 'Nuevo agente')),
      table([
        { label: 'Agente', cell: (r) => r.name },
        { label: 'Función', cell: (r) => r.role },
        { label: 'Modelo', cell: (r) => h('span', { class: 'mono small' }, r.model) },
        { label: 'Estado', cell: (r) => (r.active ? 'Activo' : 'Apagado') },
        { label: 'Editado', cell: (r) => fmtDate(r.updated_at) },
      ], agents, { empty: 'Este cliente aún no tiene agente.', onRow: edit }));
  }
  await load();
  return wrap;
}

// ---------------------------------------------------------------- avisos
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Filas copiadas de Excel: nombre, departamento, correo, cuándo avisar.
function parsePasted(text) {
  const good = [];
  const bad = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [name, department, email, notify_when] = line.split('\t').map((s) => s.trim());
    if (name && EMAIL_RE.test(email || '')) good.push({ name, department: department || null, email, notify_when: notify_when || null });
    else bad.push(line);
  }
  return { good, bad };
}

async function contactsTab(clientId) {
  const wrap = h('div', {});

  const remove = async (row) => {
    if (!confirm(`¿Quitar a ${row.name} de la lista de avisos?`)) return;
    try {
      await q(db.from('notify_contacts').delete().eq('id', row.id));
      load();
    } catch (err) {
      toast(errorText(err), 'error');
    }
  };

  const insert = async (rows) => {
    await q(db.from('notify_contacts').insert(rows.map((r) => ({ ...r, client_id: clientId }))));
    toast(rows.length === 1 ? 'Persona añadida.' : `${rows.length} personas añadidas.`);
    load();
  };

  const add = () => {
    const note = h('p', { class: 'error' });
    const form = h('form', { class: 'form', onsubmit: async (e) => {
      e.preventDefault();
      try { await insert([formData(form)]); close(); } catch (err) { note.textContent = errorText(err); }
    } },
      h('div', { class: 'grid2' },
        field('Nombre', h('input', { name: 'name', required: true })),
        field('Departamento', h('input', { name: 'department' })),
        field('Correo', h('input', { name: 'email', type: 'email', required: true }))),
      field('Cuándo se le avisa', h('textarea', { name: 'notify_when', rows: 2 }),
        'Ej.: "Presupuestos de reformas" o "Quejas y devoluciones". El agente decide con esto.'),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Añadir')), note);
    const close = modal('Añadir persona', form);
  };

  const paste = () => {
    const note = h('p', { class: 'error' });
    const area = h('textarea', { rows: 10, class: 'mono', placeholder: 'Nombre\tDepartamento\tCorreo\tCuándo avisar' });
    const go = async () => {
      const { good, bad } = parsePasted(area.value);
      if (!good.length) return (note.textContent = 'No he encontrado ninguna fila válida.');
      if (bad.length && !confirm(`${bad.length} fila(s) sin nombre o con correo incorrecto se van a omitir. ¿Importar las otras ${good.length}?`)) return;
      try { await insert(good); close(); } catch (err) { note.textContent = errorText(err); }
    };
    const close = modal('Pegar desde Excel', h('div', { class: 'form' },
      h('p', { class: 'muted' }, 'Copia las filas en Excel con las columnas en este orden: nombre, departamento, correo, cuándo avisar. Sin la fila de títulos.'),
      area,
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'button', onclick: go }, 'Importar')), note), { wide: true });
  };

  async function load() {
    const rows = await q(db.from('notify_contacts').select('*').eq('client_id', clientId).order('name'));
    wrap.replaceChildren(
      h('p', { class: 'muted' }, 'El agente solo puede avisar a las personas de esta lista. Nunca inventa correos.'),
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn primary', type: 'button', onclick: add }, 'Añadir persona'),
        h('button', { class: 'btn', type: 'button', onclick: paste }, 'Pegar desde Excel')),
      table([
        { label: 'Nombre', cell: (r) => r.name },
        { label: 'Departamento', cell: (r) => r.department || '—' },
        { label: 'Correo', cell: (r) => r.email },
        { label: 'Cuándo se le avisa', cell: (r) => r.notify_when || '—' },
        { label: '', cell: (r) => h('button', { class: 'btn link danger', type: 'button', onclick: () => remove(r) }, 'Quitar') },
      ], rows, { empty: 'Aún no hay nadie en la lista.' }));
  }
  await load();
  return wrap;
}

// ---------------------------------------------------------------- instalar
// Código que el cliente (o su programador) pega en su web para tener el chat.
async function installTab(client) {
  const agent = await q(db.from('agents').select('name, welcome_message').eq('client_id', client.id)
    .eq('active', true).order('created_at').limit(1).maybeSingle());
  if (!agent) return h('p', { class: 'empty' }, 'Este cliente aún no tiene un agente activo. Créalo en la pestaña Agentes.');

  const attr = (text) => String(text).replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  const src = new URL('../js/chat.js', location.href).href;
  const demo = `${new URL('../demo.html', location.href).href}?cliente=${client.slug}&nombre=${encodeURIComponent(client.name)}`;
  const color = h('input', { type: 'color', value: '#1483DC', oninput: render });
  const side = h('select', { onchange: render },
    h('option', { value: 'right' }, 'Abajo a la derecha'), h('option', { value: 'left' }, 'Abajo a la izquierda'));
  const avatar = h('input', { type: 'url', placeholder: 'https://…/foto.jpg', oninput: render });
  const code = h('textarea', { class: 'mono', rows: 9, readonly: true, onclick: () => code.select() });

  function render() {
    code.value = [
      `<script src="${src}"`,
      `  data-client="${attr(client.slug)}"`,
      `  data-title="${attr(client.name)}"`,
      `  data-welcome="${attr(agent.welcome_message)}"`,
      `  data-color="${color.value}"`,
      ...(/^https:\/\/\S+$/.test(avatar.value.trim()) ? [`  data-avatar="${attr(avatar.value.trim())}"`] : []),
      ...(side.value === 'left' ? ['  data-position="left"'] : []),
      '  defer></' + 'script>',
    ].join('\n');
  }
  render();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code.value);
      toast('Código copiado.');
    } catch {
      code.select();
      toast('No he podido copiarlo. Está seleccionado: pulsa Ctrl+C.', 'error');
    }
  };

  return h('div', { class: 'form' },
    h('p', { class: 'muted' }, 'Este es el código que hay que pegar en la web del cliente. Se coloca una sola vez, justo antes de la etiqueta de cierre </body>, en todas las páginas donde deba aparecer el chat.'),
    h('div', { class: 'grid2' },
      field('Color del botón', color, 'Usa el color principal de la web del cliente.'),
      field('Posición', side, 'Cámbiala si su web ya tiene un botón de WhatsApp en esa esquina.')),
    field('Foto del avatar (opcional)', avatar, 'Dirección https de una foto cuadrada. Se muestra redonda en el botón y en la cabecera del chat. Sin foto, sale el icono.'),
    field('Código para pegar', code),
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', type: 'button', onclick: copy }, 'Copiar código'),
      h('a', { class: 'btn', href: demo, target: '_blank', rel: 'noopener' }, 'Abrir demo')),
    h('p', { class: 'muted small' }, 'El código no contiene ninguna clave. Si pausas al cliente o apagas su agente, el chat deja de responder sin tocar su web. Si cambias el mensaje de bienvenida, hay que volver a pasarle el código.'));
}

// ---------------------------------------------------------------- actividad
async function activityPage() {
  const sync = async () => {
    const { data, error } = await db.functions.invoke('sync-voice', { body: {} });
    if (error) {
      const detail = await error.context?.json?.().catch(() => null);
      return toast(detail?.error || error.message, 'error');
    }
    toast(data.skipped ? 'Se acaba de sincronizar. Prueba en medio minuto.' : `Llamadas nuevas: ${data.imported}. Contactos: ${data.leads}.`);
    if (data.imported) refresh();
  };
  return page('Actividad', h('p', { class: 'muted' }, 'Lo último de todos los clientes.'),
    h('div', { class: 'toolbar' }, h('button', { class: 'btn', type: 'button', onclick: sync }, 'Traer llamadas ahora')),
    activityTabs({ showClient: true, isAdmin: true }));
}

// ---------------------------------------------------------------- costes
async function costsPage() {
  const body = h('div', {});
  const months = [0, -1, -2].map((o) => monthStart(o));
  const label = (d) => d.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
  const select = h('select', { onchange: () => load(select.value) },
    months.map((d) => h('option', { value: isoDate(d) }, label(d))));

  async function load(month) {
    body.replaceChildren(h('p', { class: 'empty' }, 'Cargando…'));
    try {
      const [rows, expenses] = await Promise.all([clientsWithMonth(month), fetchExpenses()]);
      const fixedOf = (id) => expenses.filter((e) => e.client_id === id).reduce((a, e) => a + monthlyEur(e), 0);
      rows.forEach((r) => { r.fixed_eur = fixedOf(r.id); });
      const general = fixedOf(null);
      const eur = (r) => r.cost_usd * USD_TO_EUR;
      const margin = (r) => Number(r.monthly_fee_eur) - eur(r) - r.fixed_eur;
      const total = (fn) => rows.reduce((a, r) => a + fn(r), 0);
      body.replaceChildren(
        h('div', { class: 'kpis' },
          kpi('Cobrado', fmtEur(total((r) => (r.status === 'active' ? Number(r.monthly_fee_eur) : 0))), 'cuotas de clientes activos'),
          kpi('Coste de IA', fmtUsd(total((r) => r.cost_usd)), `≈ ${fmtEur(total(eur))}`),
          kpi('Gastos fijos', fmtEur(total((r) => r.fixed_eur) + general), `${fmtEur(general)} generales de la agencia`),
          kpi('Resultado', fmtEur(total((r) => (r.status === 'active' ? Number(r.monthly_fee_eur) : 0)) - total(eur) - total((r) => r.fixed_eur) - general), 'cobrado − IA − gastos fijos')),
        table([
          { label: 'Cliente', cell: (r) => r.name },
          { label: 'Estado', cell: (r) => badge(r.status) },
          { label: 'Conversaciones', num: true, cell: (r) => `${fmtNum(r.conversations)} / ${fmtNum(r.included_conversations)}` },
          { label: 'Tokens entrada', num: true, cell: (r) => fmtNum(r.input_tokens) },
          { label: 'Tokens salida', num: true, cell: (r) => fmtNum(r.output_tokens) },
          { label: 'Coste IA', num: true, cell: (r) => fmtUsd(r.cost_usd) },
          { label: 'Tope usado', num: true, cell: budgetCell },
          { label: 'Gastos fijos', num: true, cell: (r) => fmtEur(r.fixed_eur) },
          { label: 'Cuota', num: true, cell: (r) => fmtEur(r.monthly_fee_eur) },
          { label: 'Margen', num: true, cell: (r) => h('span', { class: margin(r) < 0 ? 'warn' : null }, fmtEur(margin(r))) },
        ], rows, { empty: 'Aún no hay clientes.' }),
        h('p', { class: 'muted small' }, `Margen = cuota − coste de IA − gastos fijos del cliente, sin IVA, con un cambio orientativo de 1 $ = ${USD_TO_EUR} €. Los gastos fijos son los vigentes hoy (se apuntan en Gastos).`));
    } catch (err) {
      body.replaceChildren(h('p', { class: 'error' }, errorText(err)));
    }
  }
  await load(select.value);
  return page('Costes y margen', h('div', { class: 'toolbar' }, field('Mes', select)), body);
}

// ---------------------------------------------------------------- usuarios
const ROLES = {
  client: {
    label: 'Cliente',
    help: 'Ve solo el negocio que le asignes: resumen, actividad (conversaciones, contactos y avisos) y sus calendarios, que puede crear y editar. No puede cambiar agentes, conocimiento ni costes.',
  },
  partner: {
    label: 'Partner',
    help: 'Lo mismo que un Cliente, y además ve todos los negocios que cuelgan del suyo (sus clientes finales), con sus cifras. Usa la marca del partner, no la de EBM.',
  },
  admin: {
    label: 'Admin',
    help: 'Acceso total: clientes, agentes, costes, gastos y usuarios. Solo para el equipo de EBM.',
  },
};

async function callUsers(action, body = {}) {
  const { data, error } = await db.functions.invoke(`users?action=${action}`, { body });
  if (error) {
    const detail = await error.context?.json?.().catch(() => null);
    throw new Error(detail?.error || error.message);
  }
  return data;
}

// Ventana con el enlace de acceso para copiárselo a la persona (WhatsApp, correo…).
function linkModal(title, result, email) {
  const input = h('input', { type: 'text', readonly: true, value: result.link, onfocus: (e) => e.target.select() });
  const close = modal(title, h('div', { class: 'form' },
    h('p', {}, result.emailed
      ? `Le hemos enviado el enlace a ${email}. Si no le llega, mira en spam o pásaselo tú.`
      : 'No se ha enviado ningún correo: pásale tú este enlace.'),
    field('Enlace de acceso', input, 'Sirve una sola vez y caduca. Con él la persona elige su contraseña y entra.'),
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', type: 'button', onclick: async () => {
        try { await navigator.clipboard.writeText(result.link); toast('Enlace copiado.'); } catch { input.select(); toast('Cópialo a mano: ya está seleccionado.', 'error'); }
      } }, 'Copiar enlace'),
      h('button', { class: 'btn', type: 'button', onclick: () => { close(); refresh(); } }, 'Cerrar'))));
}

async function usersPage() {
  const [profiles, clients, access] = await Promise.all([
    q(db.from('profiles').select('*').order('created_at')),
    q(db.from('clients').select('id, name').order('name')),
    callUsers('list').then((r) => r.users).catch(() => ({})),
  ]);

  const save = async (profile, changes) => {
    try {
      await q(db.from('profiles').update(changes).eq('id', profile.id));
      Object.assign(profile, changes);
      toast('Usuario actualizado.');
    } catch (err) {
      toast(errorText(err), 'error');
      refresh();
    }
  };

  const newLink = async (profile) => {
    try {
      const result = await callUsers('link', { user_id: profile.id, send_email: false });
      linkModal('Nuevo enlace de acceso', result, profile.email);
    } catch (err) { toast(errorText(err), 'error'); }
  };

  const toggle = async (profile, active) => {
    if (!active && !confirm(`¿Quitarle el acceso a ${profile.email}? Podrás volver a activarlo.`)) return;
    try {
      await callUsers('set_active', { user_id: profile.id, active });
      toast(active ? 'Acceso activado.' : 'Acceso desactivado.');
      refresh();
    } catch (err) { toast(errorText(err), 'error'); }
  };

  function addUser() {
    const role = h('select', { name: 'role' }, Object.entries(ROLES).map(([v, r]) => h('option', { value: v }, r.label)));
    const business = h('select', { name: 'client_id' },
      h('option', { value: '' }, '— Elige un negocio —'),
      clients.map((c) => h('option', { value: c.id }, c.name)));
    const businessField = field('Negocio que va a ver', business);
    const help = h('p', { class: 'muted' }, ROLES.client.help);
    role.addEventListener('change', () => {
      help.textContent = ROLES[role.value].help;
      businessField.hidden = role.value === 'admin';
    });

    const form = h('form', { class: 'form', onsubmit: async (e) => {
      e.preventDefault();
      const d = formData(form);
      const submit = form.querySelector('button[type=submit]');
      submit.disabled = true;
      try {
        const result = await callUsers('create', {
          email: d.email, full_name: d.full_name, role: d.role, client_id: d.role === 'admin' ? null : d.client_id, send_email: d.send_email,
        });
        close();
        linkModal('Usuario creado', result, d.email);
      } catch (err) {
        toast(errorText(err), 'error');
        submit.disabled = false;
      }
    } },
      field('Correo', h('input', { type: 'email', name: 'email', required: true, autocomplete: 'off' })),
      field('Nombre (opcional)', h('input', { type: 'text', name: 'full_name', maxlength: 120 })),
      field('Rol', role), help, businessField,
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'send_email', checked: true }), 'Enviarle el enlace por correo'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', type: 'submit' }, 'Crear usuario'),
        h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancelar')));
    const close = modal('Añadir usuario', form);
  }

  const stateCell = (r) => {
    const a = access[r.id];
    if (!a) return '—';
    if (a.disabled) return h('span', { class: 'badge paused' }, 'Desactivado');
    if (!a.confirmed) return h('span', { class: 'badge pending' }, 'Invitado');
    return h('span', {}, h('span', { class: 'badge active' }, 'Activo'), ' ',
      h('small', { class: 'muted' }, a.last_sign_in_at ? `visto ${fmtDate(a.last_sign_in_at)}` : ''));
  };

  return page('Usuarios',
    h('div', { class: 'toolbar' }, h('button', { class: 'btn primary', type: 'button', onclick: addUser }, 'Añadir usuario')),
    h('p', { class: 'muted' }, 'Al crear un usuario le llega un enlace para elegir su contraseña. Hasta que le asignas un negocio no ve nada (salvo los administradores).'),
    h('div', { class: 'roles' }, Object.values(ROLES).map((r) => h('div', { class: 'role-card' }, h('strong', {}, r.label), h('p', { class: 'muted' }, r.help)))),
    table([
      { label: 'Correo', cell: (r) => h('span', {}, r.email, r.full_name ? h('small', { class: 'muted' }, ` · ${r.full_name}`) : null) },
      { label: 'Rol', cell: (r) => {
        const me = r.id === session.user.id;
        return h('select', {
          disabled: me, title: me ? 'No puedes cambiar tu propio rol.' : null,
          onchange: (e) => save(r, { role: e.target.value, ...(e.target.value === 'admin' ? { client_id: null } : {}) }),
        }, Object.entries(ROLES).map(([v, x]) => h('option', { value: v, selected: r.role === v }, x.label)));
      } },
      { label: 'Negocio que ve', cell: (r) => h('select', { onchange: (e) => save(r, { client_id: e.target.value || null }) },
        h('option', { value: '' }, '— Ninguno —'),
        clients.map((c) => h('option', { value: c.id, selected: r.client_id === c.id }, c.name))) },
      { label: 'Acceso', cell: stateCell },
      { label: '', cell: (r) => {
        if (r.id === session.user.id) return '';
        const a = access[r.id];
        return h('span', { class: 'actions' },
          h('button', { class: 'btn link', type: 'button', onclick: () => newLink(r) }, 'Enlace de acceso'),
          a?.disabled
            ? h('button', { class: 'btn link', type: 'button', onclick: () => toggle(r, true) }, 'Activar')
            : h('button', { class: 'btn link danger', type: 'button', onclick: () => toggle(r, false) }, 'Desactivar'));
      } },
    ], profiles));
}

// ---------------------------------------------------------------- impresoras
// Todas las impresoras de los clientes con el lector contratado.
async function printersPage() {
  const clients = await q(db.from('clients').select('id, name, services').contains('services', ['impresoras']).order('name'));
  if (!clients.length) {
    return page('Impresoras', h('p', { class: 'empty' }, 'Ningún cliente tiene el lector de impresoras. Actívalo en Clientes › Datos › «Lector de impresoras».'));
  }
  const names = Object.fromEntries(clients.map((c) => [c.id, c.name]));
  return page('Impresoras',
    h('p', { class: 'muted' }, 'Las impresoras de todos los clientes con el lector. Las claves del lector se crean en la ficha de cada cliente.'),
    await printersView(clients.map((c) => c.id), { clientNames: names }));
}
