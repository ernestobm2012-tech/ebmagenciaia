// Sincroniza los calendarios de los clientes con Google/Outlook mediante iCal.
//   GET  ?feed=<token>       -> el calendario en formato iCal, para suscribirse
//                               desde Google/Outlook (solo los eventos creados aquí).
//   POST {}                  -> trae los calendarios de fuera que tocan (cron).
//   POST { calendar_id }     -> trae ese calendario ahora (botón del panel).
// No recibe datos que se guarden tal cual: solo lee las URLs ya guardadas en
// calendars, así que puede llamarla cualquiera sin riesgo.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import ICAL from "npm:ical.js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const TZ = "Europe/Madrid";
const PAST_DAYS = 30;
const FUTURE_DAYS = 365;
const MAX_EVENTS = 3000;
const MAX_ICS_BYTES = 5_000_000;
const AUTO_EVERY_MIN = 10;       // el cron no repite un calendario antes de esto
const MANUAL_EVERY_SECS = 30;    // el botón del panel, tampoco antes de esto

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// ---------------------------------------------------------------- utilidades
function isPublicUrl(u: URL) {
  if (u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || !h.includes(".")) return false;
  if (/^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h.includes(":")) return false;
  return true;
}

// Descarga el .ics siguiendo redirecciones solo hacia webs públicas.
async function fetchIcs(raw: string) {
  let url = new URL(raw.replace(/^webcal:/i, "https:"));
  for (let hop = 0; hop < 4; hop++) {
    if (!isPublicUrl(url)) throw new Error("La dirección del calendario no es una web pública https.");
    const res = await fetch(url, {
      redirect: "manual",
      headers: { "User-Agent": "EBM-Agentes/1.0 (calendario)" },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location")!, url);
      continue;
    }
    if (!res.ok) throw new Error(`El calendario respondió ${res.status}. Revisa que la dirección siga siendo válida.`);
    const text = await res.text();
    if (text.length > MAX_ICS_BYTES) throw new Error("El calendario es demasiado grande.");
    if (!text.includes("BEGIN:VCALENDAR")) throw new Error("Esa dirección no devuelve un calendario iCal.");
    return text;
  }
  throw new Error("Demasiadas redirecciones.");
}

// Medianoche en Madrid de una fecha (año, mes 1-12, día), como instante UTC.
function madridMidnight(y: number, m: number, d: number) {
  const guess = Date.UTC(y, m - 1, d);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(guess));
  const hh = Number(parts.find((p) => p.type === "hour")!.value);
  const mm = Number(parts.find((p) => p.type === "minute")!.value);
  return new Date(guess - (hh * 60 + mm) * 60_000);
}

// deno-lint-ignore no-explicit-any
function toDate(t: any) {
  return t.isDate ? madridMidnight(t.year, t.month, t.day) : t.toJSDate();
}

type Row = {
  title: string; description: string | null; location: string | null;
  starts_at: string; ends_at: string; all_day: boolean; external_uid: string;
};

// Convierte un .ics en eventos dentro de la ventana, expandiendo las repeticiones.
export function parseIcs(text: string, from: Date, to: Date): Row[] {
  const root = new ICAL.Component(ICAL.parse(text));
  for (const tz of root.getAllSubcomponents("vtimezone")) {
    ICAL.TimezoneService.register(new ICAL.Timezone(tz));
  }
  const masters = new Map<string, ICAL.Event>();
  const exceptions: ICAL.Event[] = [];
  for (const comp of root.getAllSubcomponents("vevent")) {
    const ev = new ICAL.Event(comp);
    if (!ev.startDate) continue;
    if (ev.isRecurrenceException()) exceptions.push(ev);
    else masters.set(ev.uid, ev);
  }
  for (const ex of exceptions) masters.get(ex.uid)?.relateException(ex);

  const rows: Row[] = [];
  const push = (ev: ICAL.Event, start: ICAL.Time, end: ICAL.Time | null, key: string) => {
    if (String(ev.component.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED") return;
    const s = toDate(start);
    let e = end ? toDate(end) : null;
    if (!e || e < s) e = start.isDate ? new Date(s.getTime() + 86_400_000) : s;
    if (e <= from || s >= to) return;
    rows.push({
      title: (ev.summary || "Ocupado").slice(0, 300),
      description: ev.description ? String(ev.description).slice(0, 2000) : null,
      location: ev.location ? String(ev.location).slice(0, 300) : null,
      starts_at: s.toISOString(), ends_at: e.toISOString(), all_day: !!start.isDate,
      external_uid: key.slice(0, 500),
    });
  };

  for (const ev of masters.values()) {
    if (rows.length >= MAX_EVENTS) break;
    if (!ev.isRecurring()) {
      push(ev, ev.startDate, ev.endDate, ev.uid);
      continue;
    }
    const it = ev.iterator();
    const limit = ICAL.Time.fromJSDate(to, true);
    let next: ICAL.Time | null;
    let n = 0;
    while ((next = it.next()) && n++ < 2000 && rows.length < MAX_EVENTS) {
      if (next.compare(limit) > 0) break;
      const occ = ev.getOccurrenceDetails(next);
      push(occ.item, occ.startDate, occ.endDate, `${ev.uid}#${occ.recurrenceId.toString()}`);
    }
  }
  return rows.slice(0, MAX_EVENTS);
}

// ---------------------------------------------------------------- exportar
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
function madridDate(d: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(d).replace(/-/g, "");
}
// Líneas de 75 octetos como pide iCal (aproximado por caracteres).
const fold = (line: string) => line.match(/.{1,73}/gu)!.join("\r\n ");

async function feed(token: string) {
  if (!/^[0-9a-f]{48}$/.test(token)) return new Response("No encontrado", { status: 404, headers: CORS });
  const { data: cal } = await db.from("calendars").select("id, name, active").eq("feed_token", token).maybeSingle();
  if (!cal || !cal.active) return new Response("No encontrado", { status: 404, headers: CORS });

  const from = new Date(Date.now() - PAST_DAYS * 86_400_000).toISOString();
  const to = new Date(Date.now() + FUTURE_DAYS * 86_400_000).toISOString();
  const { data: events } = await db.from("calendar_events")
    .select("id, title, description, location, starts_at, ends_at, all_day, updated_at")
    .eq("calendar_id", cal.id).neq("source", "import")
    .gte("ends_at", from).lte("starts_at", to).order("starts_at").limit(MAX_EVENTS);

  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//EBM Agentes//Calendario//ES", "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH", `X-WR-CALNAME:${esc(cal.name)}`, `X-WR-TIMEZONE:${TZ}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H",
  ];
  for (const e of events ?? []) {
    const s = new Date(e.starts_at);
    const en = new Date(e.ends_at);
    lines.push("BEGIN:VEVENT", `UID:${e.id}@ebm-agentes`, `DTSTAMP:${stamp(new Date(e.updated_at))}`);
    if (e.all_day) {
      lines.push(`DTSTART;VALUE=DATE:${madridDate(s)}`, `DTEND;VALUE=DATE:${madridDate(en > s ? en : new Date(s.getTime() + 86_400_000))}`);
    } else {
      lines.push(`DTSTART:${stamp(s)}`, `DTEND:${stamp(en)}`);
    }
    lines.push(`SUMMARY:${esc(e.title)}`);
    if (e.description) lines.push(`DESCRIPTION:${esc(e.description)}`);
    if (e.location) lines.push(`LOCATION:${esc(e.location)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return new Response(lines.map(fold).join("\r\n") + "\r\n", {
    headers: { ...CORS, "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "max-age=300" },
  });
}

// ---------------------------------------------------------------- importar
type Cal = { id: string; client_id: string; ics_import_url: string };

async function syncOne(cal: Cal) {
  const from = new Date(Date.now() - PAST_DAYS * 86_400_000);
  const to = new Date(Date.now() + FUTURE_DAYS * 86_400_000);
  try {
    const rows = parseIcs(await fetchIcs(cal.ics_import_url), from, to);
    // Se sustituye todo lo importado: así lo borrado o movido fuera también cambia aquí.
    const { error: delError } = await db.from("calendar_events").delete()
      .eq("calendar_id", cal.id).eq("source", "import");
    if (delError) throw delError;
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await db.from("calendar_events").insert(rows.slice(i, i + 500).map((r) => ({
        ...r, calendar_id: cal.id, client_id: cal.client_id, source: "import",
      })));
      if (error) throw error;
    }
    await db.from("calendars").update({ last_synced_at: new Date().toISOString(), sync_error: null }).eq("id", cal.id);
    return { id: cal.id, events: rows.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.from("calendars").update({ last_synced_at: new Date().toISOString(), sync_error: message.slice(0, 500) })
      .eq("id", cal.id);
    await db.from("error_log").insert({ client_id: cal.client_id, source: "calendar", message: message.slice(0, 1000) });
    return { id: cal.id, error: message };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const url = new URL(req.url);
  if (req.method === "GET") return await feed(url.searchParams.get("feed") ?? "");
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  const body = await req.json().catch(() => ({}));
  const one = typeof body?.calendar_id === "string" ? body.calendar_id : null;

  let query = db.from("calendars").select("id, client_id, ics_import_url, last_synced_at")
    .eq("active", true).not("ics_import_url", "is", null);
  if (one) query = query.eq("id", one);
  const { data: cals, error } = await query;
  if (error) return json({ error: error.message }, 500);

  const wait = one ? MANUAL_EVERY_SECS * 1000 : AUTO_EVERY_MIN * 60_000 - 30_000;
  const due = (cals ?? []).filter((c) => !c.last_synced_at || Date.now() - new Date(c.last_synced_at).getTime() >= wait);
  if (one && !due.length) {
    return json({ error: cals?.length ? "Se acaba de sincronizar. Espera unos segundos." : "Ese calendario no tiene dirección para importar." }, 429);
  }

  const results = [];
  for (const cal of due.slice(0, 20)) results.push(await syncOne(cal as Cal));
  return json({ synced: results });
});
