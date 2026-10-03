// Guardia de las demos de voz de la web. Antes de empezar una llamada, la web
// pide aquí permiso; si hay cupo, se devuelve un token de un solo uso para esa
// llamada. Los agentes de demo exigen ese token, así que nadie puede llamarlos
// por su cuenta.
//   POST { agent, mode? }  ->  { token | signedUrl | direct, seconds, left }  |  429 { error: "persona" | "dia" }
// mode "voice" (por defecto): 2 demos por persona y día, 20 en total al día, 40 segundos cada una.
// mode "text": 3 chats por persona y día, 30 en total al día, 5 minutos y 8 mensajes cada uno
// (los mensajes los limita la web). Cada modo usa sus propios agentes.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const LIMITS = {
  voice: { perPerson: 2, perDay: 20, seconds: 40 },
  text: { perPerson: 3, perDay: 30, seconds: 300 },
} as const;
type Mode = keyof typeof LIMITS;
const DEMO_AGENTS: Record<Mode, Set<string>> = {
  voice: new Set([
    "agent_2101m3yte6h9f6xv8t1vete5mf6f", // Clínica (Lucía)
    "agent_5101m3ytfp7defkaczw68cfd7a3n", // Peluquería (Nadia)
    "agent_5101m3yvx1j2fe489r97yg42b1ky", // Restaurante (Marta)
    "agent_9701m3yvwygvexrvekyp23sf9wkf", // Taller (Javi)
  ]),
  text: new Set([
    "agent_3701m40awp7ve56vd8282v8annz2", // Clínica (Lucía), texto
    "agent_4001m40awq3nf5qtjd9ek5mehxs0", // Peluquería (Nadia), texto
    "agent_4601m40awr0gezr9pj4m0vkfat27", // Restaurante (Marta), texto
    "agent_3201m40awsbyef59dhptnhvedc67", // Taller (Javi), texto
  ]),
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const madridDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(new Date());

// Huella de la conexión: HMAC con una clave que no sale del servidor.
async function fingerprint(req: Request, day: string) {
  const ip = (req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "desconocida";
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${day}|${ip}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  const apiKey = Deno.env.get("ELEVENLABS_API_KEY");
  if (!apiKey) return json({ error: "No disponible" }, 503);

  const body = await req.json().catch(() => ({}));
  const { agent } = body;
  const mode: Mode = body.mode === "text" ? "text" : "voice";
  if (typeof agent !== "string" || !DEMO_AGENTS[mode].has(agent)) return json({ error: "Demo no válida" }, 400);
  const { perPerson, perDay, seconds } = LIMITS[mode];

  const day = madridDay();
  const ip_hash = await fingerprint(req, day);
  const [{ count: mine }, { count: today }] = await Promise.all([
    db.from("demo_calls").select("id", { count: "exact", head: true }).eq("day", day).eq("kind", mode).eq("ip_hash", ip_hash),
    db.from("demo_calls").select("id", { count: "exact", head: true }).eq("day", day).eq("kind", mode),
  ]);
  if ((mine ?? 0) >= perPerson) return json({ error: "persona" }, 429);
  if ((today ?? 0) >= perDay) return json({ error: "dia" }, 429);

  // Primero un token para WebRTC; si no se puede, una dirección firmada (WebSocket).
  const ask = async (path: string) => {
    const r = await fetch(`https://api.elevenlabs.io/v1/convai/conversation/${path}?agent_id=${encodeURIComponent(agent)}`, {
      headers: { "xi-api-key": apiKey }, signal: AbortSignal.timeout(10_000),
    });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };
  // El texto solo funciona por WebSocket: dirección firmada.
  const t = mode === "voice" ? await ask("token") : { status: 0, data: {} as Record<string, string> };
  let access: { token?: string; signedUrl?: string } | null = t.data?.token ? { token: t.data.token } : null;
  let status = t.status;
  if (!access) {
    const u = await ask("get-signed-url");
    status = u.status;
    if (u.data?.signed_url) access = { signedUrl: u.data.signed_url };
  }
  // Sin permiso para pedir tokens (la clave de ElevenLabs necesita acceso a Agentes) se
  // sigue contando y limitando aquí, y la web llama al agente directamente mientras este
  // siga siendo público. Si el agente exige token, esa llamada fallará y no gastará nada.
  if (!access) console.log(`demo-token: ElevenLabs respondió ${status}`);

  await db.from("demo_calls").insert({ day, ip_hash, agent_id: agent, kind: mode });
  return json({ ...(access ?? { direct: true }), seconds, left: Math.max(0, perPerson - (mine ?? 0) - 1) });
});
