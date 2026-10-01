// Lo que el agente sabe (web, tablas, textos) y las conexiones a sistemas del
// cliente (ERP, tienda, reservas). Pestañas de la ficha de cliente.
import { db } from './app.js';
import { h, q, table, field, modal, toast, formData, errorText, fmtDate, fmtNum, slugify } from './ui.js';

const KINDS = { web: 'Web', table: 'Tabla', text: 'Texto' };
const MAX_TABLE_CHARS = 120000;
// Aproximación: en español, unos 3,5 caracteres por token.
const tokens = (chars) => Math.round(chars / 3.5);

// ---------------------------------------------------------------- conocimiento
async function tableFilesToSources(files) {
  const sources = [];
  for (const file of files) {
    if (/\.(csv|tsv|txt)$/i.test(file.name)) {
      sources.push({ title: file.name, content: (await file.text()).trim() });
      continue;
    }
    const XLSX = await import('https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs');
    const book = XLSX.read(await file.arrayBuffer());
    for (const name of book.SheetNames) {
      const content = XLSX.utils.sheet_to_csv(book.Sheets[name], { blankrows: false }).trim();
      if (content) sources.push({ title: book.SheetNames.length > 1 ? `${file.name} · ${name}` : file.name, content });
    }
  }
  return sources;
}

export async function knowledgeTab(clientId) {
  const wrap = h('div', {});

  const learn = async (url, sourceId) => {
    toast('Leyendo la web… puede tardar un minuto.');
    const { data, error } = await db.functions.invoke('learn-web', { body: { client_id: clientId, url, source_id: sourceId } });
    if (error) {
      // El mensaje útil viene en el cuerpo de la respuesta de la función.
      const detail = await error.context?.json?.().catch(() => null);
      throw new Error(detail?.error || error.message);
    }
    toast(`Web leída: ${data.pages} página(s), ${fmtNum(data.chars)} caracteres.`);
    load();
  };

  const addWeb = () => {
    const note = h('p', { class: 'error' });
    const button = h('button', { class: 'btn primary', type: 'submit' }, 'Leer la web');
    const form = h('form', { class: 'form', onsubmit: async (e) => {
      e.preventDefault();
      button.disabled = true;
      note.textContent = '';
      try { await learn(form.url.value.trim()); close(); } catch (err) { note.textContent = errorText(err); button.disabled = false; }
    } },
      field('Dirección de la web', h('input', { name: 'url', type: 'url', required: true, placeholder: 'https://' }),
        'Se lee esa página y las enlazadas del mismo dominio, hasta 20. No lee PDFs ni contenido que solo aparece tras iniciar sesión.'),
      h('div', { class: 'actions' }, button), note);
    const close = modal('Aprender de una web', form);
  };

  const addTable = () => {
    const note = h('p', { class: 'error' });
    const input = h('input', { type: 'file', accept: '.xlsx,.xls,.csv,.tsv,.txt', multiple: true, required: true });
    const form = h('form', { class: 'form', onsubmit: async (e) => {
      e.preventDefault();
      try {
        const sources = await tableFilesToSources([...input.files]);
        if (!sources.length) throw new Error('No he encontrado datos en el archivo.');
        const tooBig = sources.find((s) => s.content.length > MAX_TABLE_CHARS);
        if (tooBig) throw new Error(`"${tooBig.title}" es demasiado grande (${fmtNum(tooBig.content.length)} caracteres). Sube solo las columnas y filas que el agente necesita.`);
        await q(db.from('knowledge_sources').insert(sources.map((s) => ({ ...s, client_id: clientId, kind: 'table' }))));
        toast(sources.length === 1 ? 'Tabla añadida.' : `${sources.length} tablas añadidas.`);
        close();
        load();
      } catch (err) {
        note.textContent = errorText(err);
      }
    } },
      field('Archivo Excel o CSV', input,
        'Cada hoja se guarda como una tabla. La primera fila debe ser la de títulos. No subas datos personales que el agente no necesite.'),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Subir')), note);
    const close = modal('Subir una tabla', form);
  };

  const editText = (source) => {
    const s = source || {};
    const note = h('p', { class: 'error' });
    const form = h('form', { class: 'form', onsubmit: async (e) => {
      e.preventDefault();
      try {
        const values = { ...formData(form), content: form.content.value };
        if (source) await q(db.from('knowledge_sources').update(values).eq('id', source.id));
        else await q(db.from('knowledge_sources').insert({ ...values, client_id: clientId, kind: 'text' }));
        close();
        load();
      } catch (err) {
        note.textContent = errorText(err);
      }
    } },
      field('Título', h('input', { name: 'title', required: true, value: s.title || '' })),
      field('Contenido', h('textarea', { name: 'content', rows: 16, class: 'mono', required: true }, s.content || ''),
        source && source.kind !== 'text' ? 'Puedes corregirlo a mano. Si recargas la web, se sobrescribe.' : null),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Guardar')), note);
    const close = modal(source ? source.title : 'Añadir texto', form, { wide: true });
  };

  const act = (fn) => async (e) => {
    e.stopPropagation();
    try { await fn(); } catch (err) { toast(errorText(err), 'error'); }
  };

  async function load() {
    const rows = await q(db.from('knowledge_sources').select('*').eq('client_id', clientId).order('created_at'));
    const total = rows.filter((r) => r.active).reduce((n, r) => n + r.content.length, 0);
    wrap.replaceChildren(
      h('p', { class: 'muted' }, 'Además de lo escrito en "Datos del negocio" del agente, puede aprender de la web del cliente, de tablas (Excel o CSV) y de textos. Todo lo activo se envía al agente en cada conversación.'),
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn primary', type: 'button', onclick: addWeb }, 'Aprender de una web'),
        h('button', { class: 'btn', type: 'button', onclick: addTable }, 'Subir tabla (Excel/CSV)'),
        h('button', { class: 'btn', type: 'button', onclick: () => editText(null) }, 'Añadir texto')),
      table([
        { label: 'Fuente', cell: (r) => r.title },
        { label: 'Tipo', cell: (r) => KINDS[r.kind] },
        { label: 'Tamaño', num: true, cell: (r) => `${fmtNum(r.content.length)} car.` },
        { label: 'Actualizada', cell: (r) => fmtDate(r.updated_at) },
        { label: 'Activa', cell: (r) => h('input', {
          type: 'checkbox', checked: r.active, onclick: (e) => e.stopPropagation(),
          onchange: act(async () => { await q(db.from('knowledge_sources').update({ active: !r.active }).eq('id', r.id)); load(); }),
        }) },
        { label: '', cell: (r) => h('div', { class: 'actions' },
          r.kind === 'web' ? h('button', { class: 'btn link', type: 'button', onclick: act(() => learn(r.url, r.id)) }, 'Recargar') : null,
          h('button', { class: 'btn link danger', type: 'button', onclick: act(async () => {
            if (!confirm(`¿Borrar "${r.title}"? El agente dejará de saber lo que contiene.`)) return;
            await q(db.from('knowledge_sources').delete().eq('id', r.id));
            load();
          }) }, 'Borrar')) },
      ], rows, { empty: 'Aún no hay fuentes. Empieza por la web del cliente.', onRow: editText }),
      rows.length ? h('p', { class: `small ${total > 200000 ? 'warn' : 'muted'}` },
        `Total activo: ${fmtNum(total)} caracteres, unos ${fmtNum(tokens(total))} tokens que se envían en cada mensaje. `,
        total > 200000 ? 'Es mucho: encarece cada respuesta. Desactiva lo que el agente no necesite.' : 'Cuanto más grande, más cuesta cada respuesta.') : null);
  }
  await load();
  return wrap;
}

// ---------------------------------------------------------------- conexiones
function connectionForm(clientId, connection, onSaved) {
  const c = connection || {};
  const params = (c.params || []).map((p) => `${p.name} | ${p.description || ''}`).join('\n');
  const toolName = h('input', { name: 'tool_name', required: true, pattern: '[a-z0-9_]{3,50}', value: c.tool_name || '' });
  const name = h('input', {
    name: 'name', required: true, value: c.name || '', placeholder: 'Consultar pedido',
    oninput: () => { if (!connection) toolName.value = slugify(name.value).replaceAll('-', '_'); },
  });
  const note = h('p', { class: 'error' });
  const form = h('form', { class: 'form', onsubmit: submit },
    h('div', { class: 'grid2' },
      field('Nombre', name),
      field('Nombre interno', toolName, 'Minúsculas, números y guion bajo. Es como lo ve el agente.')),
    field('Cuándo debe usarla el agente', h('textarea', { name: 'description', rows: 4, required: true,
      placeholder: 'Consulta el estado de un pedido. Úsala solo cuando la persona haya dado su número de pedido Y el correo con el que compró. No des datos de un pedido si el correo no coincide.' }, c.description || ''),
      'Escribe aquí también cómo verificar la identidad antes de dar datos personales.'),
    field('Dirección de la consulta', h('input', { name: 'url_template', type: 'url', required: true, pattern: 'https://.+',
      placeholder: 'https://erp.cliente.com/api/pedidos/{numero}', value: c.url_template || '' }),
      'Solo https y solo lectura (GET). Pon entre llaves los datos que rellena el agente: {numero}.'),
    field('Datos que rellena el agente', h('textarea', { name: 'params_text', rows: 3, class: 'mono',
      placeholder: 'numero | Número de pedido que da la persona\ncorreo | Correo con el que compró' }, params),
      'Uno por línea: nombre | explicación. Los que no estén entre llaves en la dirección se añaden como ?nombre=valor.'),
    h('div', { class: 'grid2' },
      field('Cabecera de la credencial', h('input', { name: 'auth_header', placeholder: 'Authorization', value: c.auth_header || '' })),
      field('Prefijo', h('input', { name: 'auth_prefix', placeholder: 'Bearer ', value: c.auth_prefix || '' }), 'Con el espacio final si lo lleva.'),
      field('Nombre del secreto', h('input', { name: 'secret_name', pattern: 'ERP_[A-Z0-9_]+', placeholder: 'ERP_CLIENTE_TOKEN', value: c.secret_name || '' }),
        'La clave no se escribe aquí. Se guarda en Supabase › Edge Functions › Secrets con este nombre, que debe empezar por ERP_.'),
      field('Activa', h('input', { name: 'active', type: 'checkbox', checked: c.active ?? true }))),
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit' }, connection ? 'Guardar' : 'Crear conexión')),
    note);

  async function submit(e) {
    e.preventDefault();
    try {
      const { params_text, ...values } = formData(form);
      values.auth_prefix = form.auth_prefix.value;  // el espacio final cuenta
      values.params = (params_text || '').split('\n').map((line) => {
        const [pName, ...rest] = line.split('|');
        return { name: pName.trim(), description: rest.join('|').trim() };
      }).filter((p) => p.name);
      const bad = values.params.find((p) => !/^[a-zA-Z0-9_]+$/.test(p.name));
      if (bad) throw new Error(`"${bad.name}" no vale como nombre de dato: usa letras, números y guion bajo.`);
      if (connection) await q(db.from('api_connections').update(values).eq('id', connection.id));
      else await q(db.from('api_connections').insert({ ...values, client_id: clientId }));
      toast('Conexión guardada.');
      onSaved();
    } catch (err) {
      note.textContent = err.code === '23505' ? 'Ya hay una conexión con ese nombre interno.' : errorText(err);
    }
  }
  return form;
}

export async function connectionsTab(clientId) {
  const wrap = h('div', {});
  const edit = (connection) => {
    const close = modal(connection ? connection.name : 'Nueva conexión',
      connectionForm(clientId, connection, () => { close(); load(); }), { wide: true });
  };
  async function load() {
    const [rows, calls] = await Promise.all([
      q(db.from('api_connections').select('*').eq('client_id', clientId).order('created_at')),
      q(db.from('api_calls').select('*, api_connections(name)').eq('client_id', clientId)
        .order('created_at', { ascending: false }).limit(30)),
    ]);
    wrap.replaceChildren(
      h('p', { class: 'muted' }, 'Permiten al agente consultar datos en vivo del cliente: pedidos, stock, disponibilidad. Solo lectura. Cada consulta queda registrada abajo.'),
      h('div', { class: 'toolbar' }, h('button', { class: 'btn primary', type: 'button', onclick: () => edit(null) }, 'Nueva conexión')),
      table([
        { label: 'Conexión', cell: (r) => r.name },
        { label: 'Dirección', cell: (r) => h('span', { class: 'mono small' }, r.url_template) },
        { label: 'Credencial', cell: (r) => r.secret_name || 'Sin credencial' },
        { label: 'Estado', cell: (r) => (r.active ? 'Activa' : 'Apagada') },
      ], rows, { empty: 'Este cliente no tiene conexiones. El agente responde solo con lo que sabe.', onRow: edit }),
      h('h2', {}, 'Últimas consultas'),
      table([
        { label: 'Fecha', cell: (r) => fmtDate(r.created_at) },
        { label: 'Conexión', cell: (r) => r.api_connections?.name || '—' },
        { label: 'Datos enviados', cell: (r) => h('span', { class: 'mono small' }, JSON.stringify(r.params)) },
        { label: 'Respuesta', num: true, cell: (r) => h('span', { class: r.status >= 400 ? 'warn' : null }, r.status) },
      ], calls, { empty: 'El agente aún no ha consultado nada.' }));
  }
  await load();
  return wrap;
}
