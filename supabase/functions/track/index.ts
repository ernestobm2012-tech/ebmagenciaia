// Cuenta las visitas a la web pública, sin cookies y sin guardar la IP.
//   POST { p: "/ruta", r: "https://de-donde-viene" }  ->  204
// Se guarda el día, la página, el dominio de origen, el tipo de dispositivo y una
// huella (HMAC de día+IP+navegador con una clave del servidor) que cambia cada día y
// no se puede deshacer: sirve para contar personas distintas sin identificar a nadie.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const MAX_PER_VISITOR_DAY = 300;
const BOT = /bot|crawl|spider|slurp|headless|lighthouse|preview|facebookexternalhit|whatsapp|telegram|curl|wget|python|node-fetch|axios|monitor|uptime|pingdom|gtmetrix|pagespeed/i;
const OWN_HOSTS = ["ebmagenciaia.es", "www.ebmagenciaia.es", "ernestobm2012-tech.github.io"];

const madridDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(new Date());

async function hmac(data: string) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return new Response(null, { status: 405, headers: CORS });
  const ok = () => new Response(null, { status: 204, headers: CORS });

  const ua = req.headers.get("user-agent") ?? "";
  if (!ua || BOT.test(ua)) return ok();

  let body: { p?: unknown; r?: unknown } = {};
  try { body = JSON.parse(await req.text()); } catch { return ok(); }
  let path = typeof body.p === "string" ? body.p.split("?")[0].split("#")[0].slice(0, 200) : "";
  if (!path.startsWith("/") || path.startsWith("/admin")) return ok();
  path = path.replace(/index\.html$/, "") || "/";

  let referrer: string | null = null;
  if (typeof body.r === "string" && body.r) {
    try {
      const host = new URL(body.r).hostname.replace(/^www\./, "");
      if (host && !OWN_HOSTS.includes(host)) referrer = host.slice(0, 100);
    } catch { /* sin origen */ }
  }
  const device = /ipad|tablet/i.test(ua) ? "tablet" : /mobi|android|iphone/i.test(ua) ? "móvil" : "ordenador";

  const day = madridDay();
  const ip = (req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "desconocida";
  const visitor = await hmac(`web|${day}|${ip}|${ua}`);

  const { count } = await db.from("web_visits").select("id", { count: "exact", head: true }).eq("day", day).eq("visitor", visitor);
  if ((count ?? 0) >= MAX_PER_VISITOR_DAY) return ok();
  await db.from("web_visits").insert({ day, path, visitor, referrer, device });
  return ok();
});
