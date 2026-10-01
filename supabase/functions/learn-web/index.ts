// Lee la web de un cliente (la página indicada y las enlazadas del mismo
// dominio) y la guarda como fuente de conocimiento del agente. Solo admin.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_PAGES = 20;
const MAX_CHARS = 120_000;
const MAX_HTML_BYTES = 1_000_000;
const SKIP_EXT = /\.(pdf|jpe?g|png|gif|webp|svg|ico|css|js|zip|mp4|mp3|xml|json|woff2?)(\?|$)/i;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// Solo webs públicas: nada de redes internas.
function isPublicUrl(u: URL) {
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || !h.includes(".")) return false;
  if (/^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h.includes(":")) return false;
  return true;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", euro: "€" };
const decode = (s: string) =>
  s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);

function extract(html: string) {
  const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim();
  const links = [...html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)/gi)].map((m) => decode(m[1]));
  const text = decode(
    html.replace(/<(script|style|noscript|svg|template|iframe|title)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<\/(p|div|section|article|li|h[1-6]|tr|header|footer|br)>|<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  );
  const lines = text.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  return { title, links, lines };
}

async function fetchHtml(url: URL) {
  const res = await fetch(url, {
    headers: { "User-Agent": "EBM-Agentes/1.0 (lectura de la web del cliente)" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok || !(res.headers.get("content-type") ?? "").includes("html")) return null;
  const html = await res.text();
  return html.length > MAX_HTML_BYTES ? html.slice(0, MAX_HTML_BYTES) : html;
}

async function crawl(start: URL) {
  const queue = [start.href];
  const seen = new Set(queue);
  const seenLines = new Set<string>();
  const parts: string[] = [];
  let pages = 0;
  let chars = 0;
  let siteTitle = "";

  while (queue.length && pages < MAX_PAGES && chars < MAX_CHARS) {
    const url = new URL(queue.shift()!);
    let html: string | null = null;
    try {
      html = await fetchHtml(url);
    } catch {
      continue;
    }
    if (!html) continue;
    const { title, links, lines } = extract(html);
    siteTitle ||= title;
    // Menús y pies se repiten en todas las páginas: cada línea se guarda una sola vez.
    const fresh = lines.filter((l) => !seenLines.has(l) && (seenLines.add(l), true));
    if (fresh.length) {
      const block = `## ${title || url.pathname}\n${url.href}\n${fresh.join("\n")}`;
      parts.push(block);
      chars += block.length;
      pages++;
    }
    for (const href of links) {
      try {
        const next = new URL(href, url);
        next.hash = "";
        if (next.origin === start.origin && isPublicUrl(next) && !SKIP_EXT.test(next.pathname) && !seen.has(next.href)) {
          seen.add(next.href);
          queue.push(next.href);
        }
      } catch { /* enlace mal formado */ }
    }
  }
  return { pages, title: siteTitle || start.hostname, content: parts.join("\n\n").slice(0, MAX_CHARS) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: auth } = await db.auth.getUser(token);
  if (!auth?.user) return json({ error: "unauthorized" }, 401);
  const { data: profile } = await db.from("profiles").select("role").eq("id", auth.user.id).maybeSingle();
  if (profile?.role !== "admin") return json({ error: "forbidden" }, 403);

  let body: { client_id?: string; url?: string; source_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  let start: URL;
  try {
    start = new URL(body.url ?? "");
  } catch {
    return json({ error: "La dirección no es válida." }, 400);
  }
  if (!body.client_id || !isPublicUrl(start)) return json({ error: "La dirección no es válida." }, 400);

  const { pages, title, content } = await crawl(start);
  if (!pages) return json({ error: "No he podido leer texto de esa web. Puede que cargue su contenido con JavaScript o que bloquee la lectura." }, 422);

  const row = { client_id: body.client_id, kind: "web", url: start.href, pages, title, content };
  const query = body.source_id
    ? db.from("knowledge_sources").update(row).eq("id", body.source_id).eq("client_id", body.client_id)
    : db.from("knowledge_sources").insert(row);
  const { data, error } = await query.select("id, title, pages").single();
  if (error) return json({ error: error.message }, 500);
  return json({ ...data, chars: row.content.length });
});
