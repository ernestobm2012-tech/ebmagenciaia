// Agente de chat. Recibe un mensaje del widget, responde con Claude usando el
// prompt y los datos del cliente, y guarda conversación, leads, pasos a humano
// y el coste de cada llamada. Es pública (la llama el widget), así que valida
// todo y aplica los límites del agente y el tope de gasto del cliente.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// USD por millón de tokens (entrada, salida). La caché: lectura 0,1x, escritura 1,25x.
const PRICES: Record<string, [number, number]> = {
  "claude-haiku-4-5": [1, 5],
  "claude-sonnet-5-5": [2, 10],
};

const MAX_MESSAGE_CHARS = 2000;
const MAX_TOOL_ROUNDS = 3;
const MAX_KNOWLEDGE_CHARS = 300_000;
const MAX_API_RESULT_CHARS = 4000;

const BASE_TOOLS: Anthropic.Tool[] = [
  {
    name: "guardar_contacto",
    description:
      "Guarda los datos de una persona interesada para que el equipo la contacte. Úsala en cuanto tengas un nombre y una forma de contacto (teléfono o correo). No la uses sin forma de contacto.",
    input_schema: {
      type: "object",
      properties: {
        nombre: { type: "string", description: "Nombre de la persona" },
        contacto: { type: "string", description: "Teléfono o correo que ha dado" },
        motivo: { type: "string", description: "Qué necesita, en una frase" },
      },
      required: ["nombre", "contacto", "motivo"],
      additionalProperties: false,
    },
  },
  {
    name: "pasar_a_humano",
    description:
      "Avisa de que esta conversación necesita a una persona: lo pide el usuario, hay una queja, o la pregunta no se puede responder con los datos del negocio.",
    input_schema: {
      type: "object",
      properties: { motivo: { type: "string", description: "Por qué hace falta una persona" } },
      required: ["motivo"],
      additionalProperties: false,
    },
  },
];

type Contact = { id: string; name: string; department: string | null; notify_when: string | null };

// Si el cliente tiene personas a las que avisar, el agente elige a cuál debe
// llegar cada aviso. Solo puede elegir de esa lista: nunca inventa correos.
function baseTools(contacts: Contact[]): Anthropic.Tool[] {
  const options = contacts.filter((c) => c.department);
  if (!options.length) return BASE_TOOLS;
  const guide = options.map((c) => `${c.department}: ${c.notify_when || c.name}`).join(" | ");
  return BASE_TOOLS.map((tool) => ({
    ...tool,
    input_schema: {
      ...tool.input_schema,
      properties: {
        ...(tool.input_schema.properties as Record<string, unknown>),
        departamento: {
          type: "string",
          enum: [...new Set(options.map((c) => c.department!))],
          description: `Departamento al que debe llegar el aviso. Elige el que mejor encaje; si ninguno encaja, omítelo. ${guide}`,
        },
      },
    },
  }));
}

type Connection = {
  id: string; tool_name: string; description: string; url_template: string;
  params: { name: string; description?: string }[];
  auth_header: string | null; auth_prefix: string; secret_name: string | null;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const isUuid = (v: unknown) => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);

function costUsd(model: string, u: Anthropic.Usage) {
  const [inPrice, outPrice] = PRICES[model] ?? PRICES["claude-sonnet-5-5"];
  return (
    (u.input_tokens * inPrice +
      (u.cache_creation_input_tokens ?? 0) * inPrice * 1.25 +
      (u.cache_read_input_tokens ?? 0) * inPrice * 0.1 +
      u.output_tokens * outPrice) / 1_000_000
  );
}

// Fecha de hoy y calendario de las próximas semanas. Los modelos se equivocan
// al calcular qué día de la semana cae una fecha; así solo tienen que leerlo.
function todayBlock() {
  const weekday = new Intl.DateTimeFormat("es-ES", { weekday: "long", timeZone: "Europe/Madrid" });
  const iso = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" });
  const days = Array.from({ length: 35 }, (_, i) => {
    const d = new Date(Date.now() + i * 86_400_000);
    return `${weekday.format(d)} ${iso.format(d)}`;
  });
  return `Hoy es ${days[0]}. Para saber qué fecha es "el sábado que viene" o qué día de la semana cae una fecha, no lo calcules: léelo en este calendario de los próximos días: ${days.join(", ")}.`;
}

// Cada conexión a un sistema del cliente se ofrece al agente como una herramienta.
function connectionTool(c: Connection): Anthropic.Tool {
  return {
    name: c.tool_name,
    description: c.description,
    input_schema: {
      type: "object",
      properties: Object.fromEntries(c.params.map((p) => [p.name, { type: "string", description: p.description ?? "" }])),
      required: c.params.map((p) => p.name),
      additionalProperties: false,
    },
  };
}

// Consulta de solo lectura (GET) al sistema del cliente. La credencial sale de
// un secreto ERP_*, nunca de la base de datos.
async function callConnection(c: Connection, input: Record<string, string>, clientId: string, conversationId: string) {
  let url = c.url_template;
  const extra = new URLSearchParams();
  for (const p of c.params) {
    const value = String(input[p.name] ?? "");
    if (url.includes(`{${p.name}}`)) url = url.replaceAll(`{${p.name}}`, encodeURIComponent(value));
    else extra.set(p.name, value);
  }
  const target = new URL(url);
  extra.forEach((v, k) => target.searchParams.set(k, v));
  if (target.protocol !== "https:") throw new Error("La conexión debe usar https");

  const headers: Record<string, string> = { Accept: "application/json" };
  if (c.auth_header && c.secret_name?.startsWith("ERP_")) {
    const secret = Deno.env.get(c.secret_name);
    if (!secret) throw new Error(`Falta el secreto ${c.secret_name}`);
    headers[c.auth_header] = `${c.auth_prefix}${secret}`;
  }
  const res = await fetch(target, { headers, signal: AbortSignal.timeout(10_000) });
  const text = (await res.text()).slice(0, MAX_API_RESULT_CHARS);
  await db.from("api_calls").insert({
    client_id: clientId, connection_id: c.id, conversation_id: conversationId, params: input, status: res.status,
  });
  if (!res.ok) throw new Error(`El sistema respondió ${res.status}`);
  return text || "Sin datos.";
}

type Calendar = { id: string; name: string };
const MAX_AGENDA_DAYS = 31;

// Si el cliente tiene calendarios, el agente puede ver cuándo está ocupado.
// Solo ve horas, nunca el título ni los datos de las citas (pueden ser personales).
function agendaTool(calendars: Calendar[]): Anthropic.Tool {
  const names = calendars.map((c) => c.name);
  return {
    name: "consultar_agenda",
    description:
      `Consulta qué horas están ocupadas en la agenda del negocio entre dos fechas (máximo ${MAX_AGENDA_DAYS} días). ` +
      "Úsala antes de proponer o confirmar un día u hora. Lo que no aparece como ocupado está libre, " +
      "siempre dentro del horario del negocio. Nunca digas qué hay en las horas ocupadas: solo que no están disponibles.",
    input_schema: {
      type: "object",
      properties: {
        desde: { type: "string", description: "Primer día, formato AAAA-MM-DD" },
        hasta: { type: "string", description: "Último día incluido, formato AAAA-MM-DD" },
        ...(names.length > 1 ? {
          calendario: { type: "string", enum: names, description: "Solo esta agenda. Omítelo para ver todas." },
        } : {}),
      },
      required: ["desde", "hasta"],
      additionalProperties: false,
    },
  };
}

// Medianoche en Madrid del día AAAA-MM-DD, como instante UTC.
function madridMidnight(day: string) {
  const [y, m, d] = day.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(guess));
  const hh = Number(parts.find((p) => p.type === "hour")!.value);
  const mm = Number(parts.find((p) => p.type === "minute")!.value);
  return new Date(guess - (hh * 60 + mm) * 60_000);
}

async function checkAgenda(input: Record<string, string>, clientId: string, calendars: Calendar[]) {
  const valid = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d ?? "");
  if (!valid(input.desde) || !valid(input.hasta)) throw new Error("Fechas en formato AAAA-MM-DD");
  const from = madridMidnight(input.desde);
  const [y, m, d] = input.hasta.split("-").map(Number);
  const to = madridMidnight(new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10));
  if (to <= from) throw new Error("La fecha final es anterior a la inicial");
  if (to.getTime() - from.getTime() > (MAX_AGENDA_DAYS + 1) * 86_400_000) throw new Error(`Como máximo ${MAX_AGENDA_DAYS} días por consulta`);

  const chosen = input.calendario ? calendars.filter((c) => c.name === input.calendario) : calendars;
  if (!chosen.length) throw new Error("Esa agenda no existe");
  const { data, error } = await db.from("calendar_events").select("calendar_id, starts_at, ends_at, all_day")
    .eq("client_id", clientId).in("calendar_id", chosen.map((c) => c.id))
    .lt("starts_at", to.toISOString()).gt("ends_at", from.toISOString()).order("starts_at").limit(500);
  if (error) throw error;

  return formatAgenda(data ?? [], input.desde, input.hasta, chosen.length > 1 ? calendars : null);
}

type Busy = { calendar_id: string; starts_at: string; ends_at: string; all_day: boolean };

// Una línea por día con las horas ocupadas, en hora de Madrid.
export function formatAgenda(events: Busy[], desde: string, hasta: string, named: Calendar[] | null) {
  const day = new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", weekday: "long", day: "numeric", month: "long" });
  const time = new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const nameOf = Object.fromEntries((named ?? []).map((c) => [c.id, c.name]));
  const [y, m, d0] = desde.split("-").map(Number);
  const lines: string[] = [];
  for (let i = 0; ; i++) {
    const iso = new Date(Date.UTC(y, m - 1, d0 + i)).toISOString().slice(0, 10);
    if (iso > hasta) break;
    const start = madridMidnight(iso);
    const next = madridMidnight(new Date(Date.UTC(y, m - 1, d0 + i + 1)).toISOString().slice(0, 10));
    const busy = events.filter((e) => new Date(e.starts_at) < next && new Date(e.ends_at) > start).map((e) => {
      const s = new Date(e.starts_at);
      const en = new Date(e.ends_at);
      const range = e.all_day || (s <= start && en >= next) ? "todo el día"
        : `${s < start ? "00:00" : time.format(s)}-${en >= next ? "24:00" : time.format(en)}`;
      return named ? `${range} (${nameOf[e.calendar_id]})` : range;
    });
    lines.push(`${day.format(start)} (${iso}): ${busy.length ? `ocupado ${busy.join(", ")}` : "nada ocupado"}`);
  }
  return lines.join("\n");
}

async function runTool(
  name: string, input: Record<string, string>, clientId: string, conversationId: string,
  connections: Connection[], contacts: Contact[], calendars: Calendar[],
) {
  if (name === "consultar_agenda" && calendars.length) return await checkAgenda(input, clientId, calendars);
  const wanted = (input.departamento ?? "").toLowerCase();
  const notify_contact_id = wanted
    ? contacts.find((c) => (c.department ?? "").toLowerCase() === wanted)?.id ?? null
    : null;
  if (name === "guardar_contacto") {
    const { error } = await db.from("leads").insert({
      client_id: clientId, conversation_id: conversationId,
      name: input.nombre, contact: input.contacto, reason: input.motivo, notify_contact_id,
    });
    if (error) throw error;
    return "Contacto guardado. El equipo le escribirá.";
  }
  if (name === "pasar_a_humano") {
    const { error } = await db.from("handoffs").insert({
      client_id: clientId, conversation_id: conversationId, reason: input.motivo, notify_contact_id,
    });
    if (error) throw error;
    await db.from("conversations").update({ handed_off: true }).eq("id", conversationId);
    return "Aviso registrado. Una persona revisará la conversación.";
  }
  const connection = connections.find((c) => c.tool_name === name);
  if (connection) return await callConnection(connection, input, clientId, conversationId);
  return "Herramienta desconocida.";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: { client?: string; conversation_id?: string; visitor_id?: string; message?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!body.client || !isUuid(body.visitor_id) || !message || message.length > MAX_MESSAGE_CHARS) {
    return json({ error: "invalid_request" }, 400);
  }

  const { data: client } = await db.from("clients")
    .select("id, status, ai_budget_usd").eq("slug", body.client).maybeSingle();
  if (!client) return json({ error: "unknown_client" }, 404);

  const { data: agent } = await db.from("agents").select("*")
    .eq("client_id", client.id).eq("active", true).order("created_at").limit(1).maybeSingle();
  if (!agent || client.status === "paused") return json({ error: "agent_unavailable" }, 503);

  // Conversación: se continúa solo si es de este cliente y de este visitante.
  let conversation: { id: string; message_count: number } | null = null;
  if (isUuid(body.conversation_id)) {
    const { data } = await db.from("conversations").select("id, message_count")
      .eq("id", body.conversation_id).eq("client_id", client.id).eq("visitor_id", body.visitor_id).maybeSingle();
    conversation = data;
  }

  // Límites contra abusos (message_count cuenta mensajes del usuario y del agente).
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const { data: today } = await db.from("conversations").select("message_count")
    .eq("client_id", client.id).eq("visitor_id", body.visitor_id).gte("last_message_at", dayStart.toISOString());
  const sentToday = (today ?? []).reduce((n, c) => n + c.message_count, 0) / 2;
  if (
    sentToday >= agent.max_messages_per_user_day ||
    (conversation && conversation.message_count / 2 >= agent.max_messages_per_conversation)
  ) {
    return json({
      conversation_id: conversation?.id ?? null,
      reply: "Hemos llegado al límite de mensajes de esta conversación. Déjanos tu contacto en el formulario y te escribimos.",
      limited: true,
    });
  }

  if (!conversation) {
    const { data, error } = await db.from("conversations")
      .insert({ client_id: client.id, agent_id: agent.id, channel: "web", visitor_id: body.visitor_id })
      .select("id, message_count").single();
    if (error) return json({ error: "server_error" }, 500);
    conversation = data;
  }
  const conversationId = conversation!.id;

  await db.from("messages").insert({
    client_id: client.id, conversation_id: conversationId, role: "user", content: message,
  });

  let reply: string;
  let failed = false;
  try {
    // Tope mensual de gasto del cliente: si se ha superado, no se llama a la IA.
    const month = new Date();
    const monthIso = `${month.getUTCFullYear()}-${String(month.getUTCMonth() + 1).padStart(2, "0")}-01`;
    const { data: usage } = await db.from("usage_monthly").select("cost_usd")
      .eq("client_id", client.id).eq("month", monthIso).maybeSingle();
    if (Number(usage?.cost_usd ?? 0) >= Number(client.ai_budget_usd)) throw new Error("Tope mensual de IA superado");

    const [{ data: history }, { data: sources }, { data: conns }, { data: people }, { data: cals }] = await Promise.all([
      db.from("messages").select("role, content")
        .eq("conversation_id", conversationId).in("role", ["user", "assistant"])
        .order("created_at", { ascending: false }).limit(agent.max_history_messages),
      // Orden fijo para que el texto del sistema sea idéntico entre llamadas y la caché funcione.
      db.from("knowledge_sources").select("kind, title, content")
        .eq("client_id", client.id).eq("active", true).order("created_at"),
      db.from("api_connections").select("*").eq("client_id", client.id).eq("active", true).order("created_at"),
      db.from("notify_contacts").select("id, name, department, notify_when")
        .eq("client_id", client.id).eq("active", true).order("created_at"),
      db.from("calendars").select("id, name").eq("client_id", client.id).eq("active", true).order("created_at"),
    ]);
    const connections = (conns ?? []) as Connection[];
    const contacts = (people ?? []) as Contact[];
    const calendars = (cals ?? []) as Calendar[];
    const tools = [
      ...baseTools(contacts),
      ...(calendars.length ? [agendaTool(calendars)] : []),
      ...connections.filter((c) => c.tool_name !== "consultar_agenda").map(connectionTool),
    ];

    const messages: Anthropic.MessageParam[] = (history ?? []).reverse()
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
    while (messages.length && messages[0].role !== "user") messages.shift();

    let knowledge = agent.knowledge;
    for (const s of sources ?? []) {
      knowledge += `\n\n<fuente tipo="${s.kind}" titulo="${s.title.replaceAll('"', "'")}">\n${s.content}\n</fuente>`;
    }
    const system: Anthropic.TextBlockParam[] = [{
      type: "text",
      text: `${agent.system_prompt}\n\n<datos_del_negocio>\n${knowledge.slice(0, MAX_KNOWLEDGE_CHARS)}\n</datos_del_negocio>`,
      cache_control: { type: "ephemeral" },
    }, {
      // Fuera del bloque en caché: cambia cada día.
      type: "text",
      text: todayBlock(),
    }];

    let text = "";
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const response = await anthropic.messages.create({
        model: agent.model, max_tokens: agent.max_output_tokens, system, tools, messages,
      });
      await db.from("usage_events").insert({
        client_id: client.id, conversation_id: conversationId, model: agent.model,
        input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens,
        cache_read_tokens: response.usage.cache_read_input_tokens ?? 0,
        cache_write_tokens: response.usage.cache_creation_input_tokens ?? 0,
        cost_usd: costUsd(agent.model, response.usage),
      });
      if (response.stop_reason === "refusal") throw new Error("La IA ha rechazado la petición");

      text = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text).join("\n").trim() || text;
      const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (response.stop_reason !== "tool_use" || !toolUses.length || round === MAX_TOOL_ROUNDS) break;

      messages.push({ role: "assistant", content: response.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const use of toolUses) {
        try {
          const content = await runTool(use.name, use.input as Record<string, string>, client.id, conversationId, connections, contacts, calendars);
          results.push({ type: "tool_result", tool_use_id: use.id, content });
        } catch (err) {
          results.push({ type: "tool_result", tool_use_id: use.id, content: `Error: ${err}`, is_error: true });
        }
      }
      messages.push({ role: "user", content: results });
    }
    if (!text) throw new Error("Respuesta vacía de la IA");
    reply = text;
  } catch (err) {
    // Plan B: mensaje cortés, el mensaje queda como lead pendiente y se registra el error.
    failed = true;
    reply = agent.fallback_message;
    const detail = err instanceof Anthropic.APIError ? `${err.status} ${err.message}` : String(err);
    await db.from("error_log").insert({
      client_id: client.id, conversation_id: conversationId, source: "chat", message: detail.slice(0, 1000),
    });
    await db.from("leads").insert({
      client_id: client.id, conversation_id: conversationId, status: "pending",
      reason: `Sin respuesta de la IA. Escribió: ${message.slice(0, 300)}`,
    });
  }

  await db.from("messages").insert({
    client_id: client.id, conversation_id: conversationId, role: "assistant", content: reply,
  });
  await db.from("conversations")
    .update({ message_count: conversation!.message_count + 2, last_message_at: new Date().toISOString() })
    .eq("id", conversationId);

  return json({ conversation_id: conversationId, reply, failed });
});
