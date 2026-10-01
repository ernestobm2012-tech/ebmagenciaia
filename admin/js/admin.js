// Panel de administración de EBM: clientes, agentes, avisos, costes y usuarios.
import { db, session, refresh } from './app.js';
import { MODELS, USD_TO_EUR } from './config.js';
import { activityTabs } from './activity.js';
import { knowledgeTab, connectionsTab } from './knowledge.js';
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
function clientForm(client, onSaved) {
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
      field('Cuota mensual (€)', h('input', { name: 'monthly_fee_eur', type: 'number', min: 0, step: '0.01', value: c.monthly_fee_eur ?? 0 })),
      field('Conversaciones incluidas', h('input', { name: 'included_conversations', type: 'number', min: 0, value: c.included_conversations ?? 0 })),
      field('Tope mensual de IA ($)', h('input', { name: 'ai_budget_usd', type: 'number', min: 0, step: '0.01', value: c.ai_budget_usd ?? 20 }),
        'Si se supera, el agente de este cliente se frena.'),
      field('Web', h('input', { name: 'website_url', type: 'url', placeholder: 'https://', value: c.website_url || '' })),
      field('Persona de contacto', h('input', { name: 'contact_name', value: c.contact_name || '' })),
      field('Correo de contacto', h('input', { name: 'contact_email', type: 'email', value: c.contact_email || '' }))),
    field('Notas', h('textarea', { name: 'notes', rows: 3 }, c.notes || '')),
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit' }, client ? 'Guardar' : 'Crear cliente')),
    note);

  async function submit(e) {
    e.preventDefault();
    try {
      const values = formData(form);
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
  const add = () => {
    const close = modal('Nuevo cliente', clientForm(null, (saved) => {
      close();
      location.hash = `#/clientes/${saved.id}`;
    }), { wide: true });
  };
  return page('Clientes',
    h('div', { class: 'toolbar' }, h('button', { class: 'btn primary', type: 'button', onclick: add }, 'Nuevo cliente')),
    table([
      { label: 'Cliente', cell: (r) => r.name },
      { label: 'Estado', cell: (r) => badge(r.status) },
      { label: 'Plan', cell: (r) => r.plan || '—' },
      { label: 'Cuota', num: true, cell: (r) => fmtEur(r.monthly_fee_eur) },
      { label: 'Alta', cell: (r) => fmtDate(r.created_at) },
    ], clients, { empty: 'Aún no hay clientes.', onRow: (r) => (location.hash = `#/clientes/${r.id}`) }));
}

async function clientPage(id) {
  const client = await q(db.from('clients').select('*').eq('id', id).maybeSingle());
  if (!client) return page('Cliente no encontrado', h('a', { href: '#/clientes' }, 'Volver a clientes'));

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
      h('div', { class: 'spacer' }),
      client.status === 'paused'
        ? h('button', { class: 'btn', type: 'button', onclick: () => setStatus('active') }, 'Reactivar')
        : h('button', { class: 'btn', type: 'button', onclick: () => setStatus('paused') }, 'Pausar')),
    tabs([
      { id: 'data', label: 'Datos', render: async () => clientForm(client, refresh) },
      { id: 'agents', label: 'Agentes', render: () => agentsTab(id) },
      { id: 'knowledge', label: 'Conocimiento', render: () => knowledgeTab(id) },
      { id: 'connections', label: 'Conexiones (ERP/API)', render: () => connectionsTab(id) },
      { id: 'contacts', label: 'A quién avisar', render: () => contactsTab(id) },
      { id: 'install', label: 'Instalar en su web', render: () => installTab(client) },
      { id: 'expenses', label: 'Gastos', render: () => expensesTab(id) },
      { id: 'activity', label: 'Actividad', render: async () => activityTabs({ clientId: id, isAdmin: true }) },
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
  const code = h('textarea', { class: 'mono', rows: 8, readonly: true, onclick: () => code.select() });

  function render() {
    code.value = [
      `<script src="${src}"`,
      `  data-client="${attr(client.slug)}"`,
      `  data-title="${attr(client.name)}"`,
      `  data-welcome="${attr(agent.welcome_message)}"`,
      `  data-color="${color.value}"`,
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
async function usersPage() {
  const [profiles, clients] = await Promise.all([
    q(db.from('profiles').select('*').order('created_at')),
    q(db.from('clients').select('id, name').order('name')),
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

  return page('Usuarios',
    h('p', { class: 'muted' }, 'Los usuarios se crean en Supabase (Authentication › Users › Add user). Aquí decides qué ve cada uno. Un usuario nuevo no ve nada hasta que le asignas un cliente.'),
    table([
      { label: 'Correo', cell: (r) => r.email },
      { label: 'Rol', cell: (r) => {
        const me = r.id === session.user.id;
        return h('select', {
          disabled: me, title: me ? 'No puedes cambiar tu propio rol.' : null,
          onchange: (e) => save(r, { role: e.target.value, ...(e.target.value === 'admin' ? { client_id: null } : {}) }),
        }, [['client', 'Cliente'], ['admin', 'Admin']].map(([v, l]) => h('option', { value: v, selected: r.role === v }, l)));
      } },
      { label: 'Cliente que ve', cell: (r) => h('select', { onchange: (e) => save(r, { client_id: e.target.value || null }) },
        h('option', { value: '' }, '— Ninguno —'),
        clients.map((c) => h('option', { value: c.id, selected: r.client_id === c.id }, c.name))) },
      { label: 'Alta', cell: (r) => fmtDate(r.created_at) },
    ], profiles));
}
