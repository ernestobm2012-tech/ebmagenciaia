// Recibe las lecturas del lector de impresoras (agente_lector.py) que corre en la red del cliente.
//   POST  Authorization: Bearer lec_…   { cliente, lecturas: [{ serie, modelo, marca, ip, total, bn, color, toner: [{nombre, nivel}] }] }
//   ->    { ok: true, impresoras, guardadas }
// La clave identifica al cliente (tabla printer_keys, solo se guarda su hash). Solo llegan
// contadores y tóner: nunca documentos. Se guarda una lectura si cambia algún contador
// o cada 6 horas; los últimos valores quedan siempre en `printers` para verlos en directo.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const MAX_LECTURAS = 100;
const HEARTBEAT_MS = 6 * 3600_000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function sha256(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Avisos que solo dicen que todo va bien (cerrado, encendido, ahorro de energía, lista…): no se guardan.
const QUIET = new Set([4, 6, 7, 19, 20, 23, 24, 25, 27, 503, 505, 506, 507, 1501, 1502, 1503, 1504, 1505, 1506]);

function alertList(list: unknown) {
  if (!Array.isArray(list)) return null;
  const seen = new Set<string>();
  const out: { code: number; severity: number | null; description: string | null }[] = [];
  for (const a of list.slice(0, 30)) {
    const code = a?.codigo;
    if (typeof code !== "number" || !Number.isInteger(code) || QUIET.has(code)) continue;
    const description = typeof a?.descripcion === "string" && a.descripcion.trim() ? a.descripcion.trim().slice(0, 160) : null;
    const key = `${code}|${description ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ code, severity: Number.isInteger(a?.severidad) ? a.severidad : null, description });
  }
  return out;
}

// Abre los avisos nuevos y cierra los que ya no están.
async function syncEvents(printerId: string, clientId: string, alerts: ReturnType<typeof alertList>, now: string) {
  if (!alerts) return;
  const { data: open } = await db.from("printer_events").select("id, code, description")
    .eq("printer_id", printerId).is("ended_at", null);
  const key = (code: number, d: string | null) => `${code}|${d ?? ""}`;
  const current = new Set(alerts.map((a) => key(a.code, a.description)));
  const already = new Set((open ?? []).map((e) => key(e.code, e.description)));
  const toClose = (open ?? []).filter((e) => !current.has(key(e.code, e.description))).map((e) => e.id);
  if (toClose.length) await db.from("printer_events").update({ ended_at: now }).in("id", toClose);
  const toOpen = alerts.filter((a) => !already.has(key(a.code, a.description)))
    .map((a) => ({ printer_id: printerId, client_id: clientId, ...a, started_at: now }));
  if (toOpen.length) await db.from("printer_events").insert(toOpen);
}

const count = (v: unknown) =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 1e12 ? v : null;
const text = (v: unknown, max = 120) =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

// De la lista del lector a { k, c, m, y } (solo cartuchos de tóner, no tambores ni residuos).
function tonerMap(list: unknown) {
  if (!Array.isArray(list)) return null;
  const out: Record<string, number> = {};
  for (const t of list.slice(0, 20)) {
    const name = String(t?.nombre ?? "").toLowerCase();
    const level = t?.nivel;
    if (!/toner|tóner/.test(name) || /drum|tambor/.test(name)) continue;
    if (typeof level !== "number" || level < 0 || level > 100) continue;
    const k = /black|negro|bk/.test(name) ? "k" : /cyan|cian/.test(name) ? "c"
      : /magenta/.test(name) ? "m" : /yellow|amarillo/.test(name) ? "y" : null;
    if (k && !(k in out)) out[k] = Math.round(level);
  }
  return Object.keys(out).length ? out : null;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Usa POST" }, 405);
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!/^lec_[0-9a-f]{48}$/.test(token)) return json({ error: "Falta la clave del lector" }, 401);

  const { data: key } = await db.from("printer_keys").select("id, client_id, active")
    .eq("key_hash", await sha256(token)).maybeSingle();
  if (!key || !key.active) return json({ error: "Clave no válida" }, 401);

  let body: { lecturas?: unknown };
  try { body = await req.json(); } catch { return json({ error: "JSON no válido" }, 400); }
  const lecturas = Array.isArray(body.lecturas) ? body.lecturas.slice(0, MAX_LECTURAS) : [];

  const now = new Date();
  let saved = 0, printers = 0;
  for (const l of lecturas as Record<string, unknown>[]) {
    const ip = text(l.ip, 45);
    const serial = text(l.serie, 80) ?? (ip ? `ip-${ip}` : null);
    if (!serial) continue;
    const total = count(l.total), bn = count(l.bn), color = count(l.color);
    if (total == null && bn == null && color == null) continue;
    const toner = tonerMap(l.toner);
    const alerts = alertList(l.alertas);
    const status = Number.isInteger(l.estado) && (l.estado as number) >= 1 && (l.estado as number) <= 5 ? l.estado : null;

    const { data: printer, error } = await db.from("printers").upsert({
      client_id: key.client_id, serial,
      model: text(l.modelo), brand: text(l.marca, 40), ip,
      last_read_at: now.toISOString(), last_total: total, last_bn: bn, last_color: color,
      ...(toner ? { last_toner: toner } : {}),
      ...(alerts ? { last_alerts: alerts, last_status: status } : {}),
    }, { onConflict: "client_id,serial" }).select("id").single();
    if (error || !printer) continue;
    printers++;
    await syncEvents(printer.id, key.client_id, alerts, now.toISOString());

    const { data: prev } = await db.from("printer_readings").select("read_at, total, bn, color")
      .eq("printer_id", printer.id).order("read_at", { ascending: false }).limit(1).maybeSingle();
    const changed = !prev || prev.total !== total || prev.bn !== bn || prev.color !== color;
    const stale = prev && now.getTime() - new Date(prev.read_at).getTime() > HEARTBEAT_MS;
    if (changed || stale) {
      const { error: e2 } = await db.from("printer_readings").insert({
        printer_id: printer.id, client_id: key.client_id, read_at: now.toISOString(), total, bn, color, toner,
      });
      if (!e2) saved++;
    }
  }
  await db.from("printer_keys").update({ last_used_at: now.toISOString() }).eq("id", key.id);
  return json({ ok: true, impresoras: printers, guardadas: saved });
});
