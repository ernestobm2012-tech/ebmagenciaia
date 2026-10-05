// Gasto de ElevenLabs para el panel de administración: dólares y minutos por día,
// con el reparto por tipo (voz de agentes, LLM, otros), más lo que cuestan las demos
// de texto de la web (Claude API). Solo para administradores.
//   POST { days? }  ->  { time: [ms], usd: {tipo: [céntimos]}, minutes: {tipo: [..]}, demoText: {turns, usd} }
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: auth } = jwt ? await db.auth.getUser(jwt) : { data: { user: null } };
  if (!auth.user) return json({ error: "Inicia sesión." }, 401);
  const { data: me } = await db.from("profiles").select("role").eq("id", auth.user.id).maybeSingle();
  if (me?.role !== "admin") return json({ error: "Solo administración." }, 403);

  const key = Deno.env.get("ELEVENLABS_API_KEY");
  if (!key) return json({ error: "Falta el secreto ELEVENLABS_API_KEY." }, 503);

  const body = await req.json().catch(() => ({}));
  const days = Math.min(90, Math.max(1, Number(body.days) || 31));
  const end = Date.now();
  const start = end - days * 86_400_000;
  const get = async (metric: string) => {
    const url = `https://api.elevenlabs.io/v1/usage/character-stats?start_unix=${start}&end_unix=${end}&breakdown_type=product_type&metric=${metric}&aggregation_interval=day`;
    const r = await fetch(url, { headers: { "xi-api-key": key }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`ElevenLabs respondió ${r.status} (${metric})`);
    return await r.json() as { time: number[]; usage: Record<string, number[]> };
  };
  try {
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString().slice(0, 10);
    const [usd, minutes, turns, events] = await Promise.all([
      get("fiat_units_spent"), get("minutes_used"),
      db.from("demo_text_turns").select("day, cost_usd").gte("day", monthStart),
      db.from("usage_events").select("created_at, model, cost_usd").like("model", "claude%").gte("created_at", monthStart),
    ]);
    // Claude (Anthropic) según nuestros registros: chats de clientes + demos de texto, por día (hora de Madrid).
    const claudeByDay: Record<string, { chats: number; demos: number; calls: number }> = {};
    const bucket = (d: string) => (claudeByDay[d] ??= { chats: 0, demos: 0, calls: 0 });
    const madrid = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(new Date(iso));
    for (const e of events.data ?? []) { const b = bucket(madrid(e.created_at)); b.chats += Number(e.cost_usd); b.calls++; }
    for (const t of turns.data ?? []) { const b = bucket(t.day); b.demos += Number(t.cost_usd ?? 0); b.calls++; }
    const demoRows = turns.data ?? [];
    const demoText = { turns: demoRows.length, usd: demoRows.reduce((a, r) => a + Number(r.cost_usd ?? 0), 0) };
    return json({ time: usd.time, usd: usd.usage, minutes: minutes.usage, demoText, claudeByDay });
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 502);
  }
});
