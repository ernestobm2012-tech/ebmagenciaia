// Importa las llamadas del agente telefónico desde ElevenLabs: conversación,
// transcripción, coste y el contacto que haya dejado la persona.
// No recibe datos de fuera: solo va a buscarlos con la clave de ElevenLabs,
// así que puede llamarla cualquiera (el cron, el panel) sin riesgo.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const API = "https://api.elevenlabs.io/v1/convai";
const MIN_SECONDS_BETWEEN_RUNS = 30;
const MAX_NEW_PER_RUN = 20;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// Valor recogido por el análisis de la llamada; vacío si no se dijo.
function collected(results: Record<string, { value?: unknown }> | undefined, key: string) {
  const value = String(results?.[key]?.value ?? "").trim();
  return value && !/^(null|none|n\/a|desconocido)$/i.test(value) ? value : null;
}

// Número desde el que llaman; null si viene oculto.
function callerNumber(raw: unknown) {
  const value = String(raw ?? "").trim();
  return value.replace(/\D/g, "").length >= 9 ? value : null;
}

const hasPhoneOrEmail = (text: string) => text.includes("@") || text.replace(/\D/g, "").length >= 9;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const key = Deno.env.get("ELEVENLABS_API_KEY");
  if (!key) return json({ error: "Falta el secreto ELEVENLABS_API_KEY en Supabase." }, 503);

  const { data: state } = await db.from("sync_state").select("last_run").eq("name", "voice").maybeSingle();
  if (state && Date.now() - new Date(state.last_run).getTime() < MIN_SECONDS_BETWEEN_RUNS * 1000) {
    return json({ skipped: true });
  }
  await db.from("sync_state").upsert({ name: "voice", last_run: new Date().toISOString() });

  const get = async (path: string) => {
    const res = await fetch(API + path, { headers: { "xi-api-key": key }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`ElevenLabs respondió ${res.status}`);
    return await res.json();
  };

  const { data: agents } = await db.from("agents").select("id, client_id, voice_agent_id")
    .not("voice_agent_id", "is", null);
  let imported = 0;
  let leads = 0;

  try {
    for (const agent of agents ?? []) {
      const list = await get(`/conversations?agent_id=${encodeURIComponent(agent.voice_agent_id)}&page_size=50`);
      const ids: string[] = (list.conversations ?? [])
        .filter((c: { status: string }) => c.status === "done")
        .map((c: { conversation_id: string }) => c.conversation_id);
      if (!ids.length) continue;
      const { data: known } = await db.from("conversations").select("external_id").in("external_id", ids);
      const have = new Set((known ?? []).map((k) => k.external_id));

      for (const id of ids) {
        if (have.has(id) || imported >= MAX_NEW_PER_RUN) continue;
        const call = await get(`/conversations/${id}`);
        const meta = call.metadata ?? {};
        const started = (meta.start_time_unix_secs ?? Math.floor(Date.now() / 1000)) * 1000;
        const duration = meta.call_duration_secs ?? 0;
        const turns = (call.transcript ?? []).filter((t: { message?: string }) => t.message);
        const summary = call.analysis?.transcript_summary ?? null;

        const { data: conversation, error } = await db.from("conversations").insert({
          client_id: agent.client_id, agent_id: agent.id, channel: "phone", external_id: id,
          visitor_id: meta.phone_call?.external_number ?? null,
          summary, status: "closed", message_count: turns.length, duration_secs: duration,
          started_at: new Date(started).toISOString(),
          last_message_at: new Date(started + duration * 1000).toISOString(),
        }).select("id").single();
        if (error) continue;  // otra ejecución la importó a la vez

        if (turns.length) {
          await db.from("messages").insert(turns.map((t: { role: string; message: string; time_in_call_secs?: number }) => ({
            client_id: agent.client_id, conversation_id: conversation.id,
            role: t.role === "user" ? "user" : "assistant", content: t.message,
            created_at: new Date(started + (t.time_in_call_secs ?? 0) * 1000).toISOString(),
          })));
        }
        await db.from("usage_events").insert({
          client_id: agent.client_id, conversation_id: conversation.id, model: "elevenlabs-voice",
          cost_usd: Number(meta.cost_fiat ?? 0), created_at: new Date(started).toISOString(),
        });

        const results = call.analysis?.data_collection_results;
        const name = collected(results, "nombre");
        let contact = collected(results, "contacto");
        // Si pidió que le llamen "al mismo desde el que llamo", el análisis
        // apunta eso en vez de cifras: se guarda el número entrante.
        const caller = callerNumber(meta.phone_call?.external_number);
        if (caller && contact && !hasPhoneOrEmail(contact)) {
          contact = `${caller} (el número desde el que llamó)`;
        }
        if (contact) {
          await db.from("leads").insert({
            client_id: agent.client_id, conversation_id: conversation.id,
            name, contact,
            reason: collected(results, "motivo") ?? summary,
          });
          leads++;
        }
        imported++;
      }
    }
  } catch (err) {
    await db.from("error_log").insert({ source: "sync-voice", message: String(err).slice(0, 1000) });
    return json({ error: String(err), imported, leads }, 502);
  }
  return json({ imported, leads });
});
