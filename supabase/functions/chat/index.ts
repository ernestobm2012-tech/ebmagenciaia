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

const TOOLS: Anthropic.Tool[] = [
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

async function runTool(name: string, input: Record<string, string>, clientId: string, conversationId: string) {
  if (name === "guardar_contacto") {
    const { error } = await db.from("leads").insert({
      client_id: clientId, conversation_id: conversationId,
      name: input.nombre, contact: input.contacto, reason: input.motivo,
    });
    if (error) throw error;
    return "Contacto guardado. El equipo le escribirá.";
  }
  if (name === "pasar_a_humano") {
    const { error } = await db.from("handoffs").insert({
      client_id: clientId, conversation_id: conversationId, reason: input.motivo,
    });
    if (error) throw error;
    await db.from("conversations").update({ handed_off: true }).eq("id", conversationId);
    return "Aviso registrado. Una persona revisará la conversación.";
  }
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

    const { data: history } = await db.from("messages").select("role, content")
      .eq("conversation_id", conversationId).in("role", ["user", "assistant"])
      .order("created_at", { ascending: false }).limit(agent.max_history_messages);
    const messages: Anthropic.MessageParam[] = (history ?? []).reverse()
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
    while (messages.length && messages[0].role !== "user") messages.shift();

    const system: Anthropic.TextBlockParam[] = [{
      type: "text",
      text: `${agent.system_prompt}\n\n<datos_del_negocio>\n${agent.knowledge}\n</datos_del_negocio>`,
      cache_control: { type: "ephemeral" },
    }];

    let text = "";
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const response = await anthropic.messages.create({
        model: agent.model, max_tokens: agent.max_output_tokens, system, tools: TOOLS, messages,
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
          const content = await runTool(use.name, use.input as Record<string, string>, client.id, conversationId);
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
