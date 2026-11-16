// Da a la web propia de un negocio (p. ej. el panel de Mi Pequeño Rincón) sus
// conversaciones con el asistente y los contactos que dejó cada una. No hay
// usuario de EBM: autentica con la cabecera x-integration-token, que se guarda
// en client_integrations (solo service_role) y en el servidor del negocio.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const token = req.headers.get("x-integration-token") ?? "";
  if (token.length < 32) return json({ error: "unauthorized" }, 401);
  const { data: integ } = await db.from("client_integrations").select("client_id").eq("token", token).maybeSingle();
  if (!integ) return json({ error: "unauthorized" }, 401);
  const clientId = integ.client_id;

  const { action, conversation_id, days } = await req.json().catch(() => ({}));

  if (action === "messages") {
    if (typeof conversation_id !== "string") return json({ error: "invalid_request" }, 400);
    const { data: conv } = await db.from("conversations").select("id")
      .eq("id", conversation_id).eq("client_id", clientId).maybeSingle();
    if (!conv) return json({ error: "not_found" }, 404);
    const { data: msgs } = await db.from("messages").select("role, content, created_at")
      .eq("conversation_id", conversation_id).in("role", ["user", "assistant"])
      .order("created_at").limit(200);
    return json({ messages: msgs ?? [] });
  }

  // Lista: conversaciones de los últimos N días (máx. 180), con su contacto si lo dejó.
  const since = new Date(Date.now() - Math.min(Number(days) || 60, 180) * 864e5).toISOString();
  const { data: convs } = await db.from("conversations")
    .select("id, channel, started_at, last_message_at, message_count, summary, handed_off")
    .eq("client_id", clientId).gte("started_at", since)
    .order("last_message_at", { ascending: false }).limit(200);
  const ids = (convs ?? []).map((c) => c.id);
  const [{ data: leads }, { data: firsts }] = ids.length
    ? await Promise.all([
      db.from("leads").select("conversation_id, name, contact, reason, created_at").in("conversation_id", ids),
      db.from("messages").select("conversation_id, content, created_at").in("conversation_id", ids)
        .eq("role", "user").order("created_at").limit(2000),
    ])
    : [{ data: [] }, { data: [] }];
  const leadOf = new Map((leads ?? []).map((l) => [l.conversation_id, l]));
  const firstOf = new Map<string, string>();
  for (const m of firsts ?? []) if (!firstOf.has(m.conversation_id)) firstOf.set(m.conversation_id, m.content);
  return json({
    conversations: (convs ?? []).map((c) => ({
      ...c,
      lead: leadOf.get(c.id) ?? null,
      first_message: (firstOf.get(c.id) ?? "").slice(0, 200),
    })),
  });
});
