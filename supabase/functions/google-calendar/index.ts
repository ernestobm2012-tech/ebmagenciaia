// Conexión directa de un calendario del panel con Google Calendar (OAuth),
// en los dos sentidos y al momento.
//   POST ?action=connect     (usuario del panel) -> URL para entrar con Google
//   GET  ?code&state         (vuelta de Google)  -> guarda la conexión
//   POST ?action=disconnect  (usuario del panel) -> desconecta
//   POST ?action=pull        (usuario del panel) -> trae cambios ahora
//   POST ?action=flush       (trigger de la BD)  -> manda a Google los cambios del panel
//   POST ?action=notify      (Google)            -> algo cambió en Google: lo trae
//   POST ?action=maintain    (cron)              -> reintentos, renovar avisos, repaso
// Secretos: GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET. Opcional: PANEL_URL.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const db = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";
const SELF = `${SUPABASE_URL}/functions/v1/google-calendar`;
const API = "https://www.googleapis.com/calendar/v3";
const SCOPES = "openid email https://www.googleapis.com/auth/calendar.events";
const TZ = "Europe/Madrid";
const PAST_DAYS = 30;
const FUTURE_DAYS = 365;
const RETURN_PREFIXES = ["https://ernestobm2012-tech.github.io/", "https://ebmagenciaia.es/", Deno.env.get("PANEL_URL") ?? ""].filter(Boolean);
const MAX_ATTEMPTS = 5;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

type Conn = {
  calendar_id: string; account_email: string | null; refresh_token: string; google_calendar_id: string;
  channel_id: string | null; channel_resource_id: string | null; channel_token: string | null;
  channel_expires_at: string | null; pulled_at: string | null;
};
type EventRow = {
  id: string; calendar_id: string; title: string; description: string | null; location: string | null;
  starts_at: string; ends_at: string; all_day: boolean; source: string; google_event_id: string | null;
};
// deno-lint-ignore no-explicit-any
type GEvent = any;

// ---------------------------------------------------------------- fechas
export function madridMidnight(day: string) {
  const [y, m, d] = day.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(guess));
  const hh = Number(parts.find((p) => p.type === "hour")!.value);
  const mm = Number(parts.find((p) => p.type === "minute")!.value);
  return new Date(guess - (hh * 60 + mm) * 60_000);
}
const madridDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);

// Cada cita del panel tiene en Google el mismo identificador (su uuid sin guiones),
// así un envío repetido nunca la duplica.
export const googleIdFor = (uuid: string) => uuid.replaceAll("-", "");
export function uuidFromGoogleId(id: string) {
  if (!/^[0-9a-f]{32}$/.test(id)) return null;
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

// Cita del panel -> evento de Google.
export function toGoogle(e: EventRow) {
  const body: Record<string, unknown> = {
    summary: e.title,
    description: e.description ?? "",
    location: e.location ?? "",
  };
  if (e.all_day) {
    body.start = { date: madridDay(new Date(e.starts_at)) };
    const end = new Date(e.ends_at) > new Date(e.starts_at) ? new Date(e.ends_at) : new Date(new Date(e.starts_at).getTime() + 86_400_000);
    body.end = { date: madridDay(end) };
  } else {
    body.start = { dateTime: e.starts_at, timeZone: TZ };
    body.end = { dateTime: e.ends_at, timeZone: TZ };
  }
  return body;
}

// Evento de Google -> campos de la cita del panel (null si no se puede leer).
export function fromGoogle(g: GEvent) {
  const allDay = !!g.start?.date;
  const start = allDay ? madridMidnight(g.start.date) : g.start?.dateTime ? new Date(g.start.dateTime) : null;
  if (!start) return null;
  let end = allDay ? (g.end?.date ? madridMidnight(g.end.date) : null) : g.end?.dateTime ? new Date(g.end.dateTime) : null;
  if (!end || end < start) end = allDay ? new Date(start.getTime() + 86_400_000) : start;
  return {
    title: String(g.summary || "Ocupado").slice(0, 300),
    description: g.description ? String(g.description).slice(0, 2000) : null,
    location: g.location ? String(g.location).slice(0, 300) : null,
    starts_at: start.toISOString(),
    ends_at: end.toISOString(),
    all_day: allDay,
  };
}

// ---------------------------------------------------------------- Google
const tokens = new Map<string, { token: string; until: number }>();

async function accessToken(conn: Conn) {
  const cached = tokens.get(conn.calendar_id);
  if (cached && cached.until > Date.now() + 60_000) return cached.token;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      refresh_token: conn.refresh_token, grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    const why = data.error === "invalid_grant"
      ? "Google ha retirado el permiso. Vuelve a conectar la cuenta."
      : `Google no da acceso (${data.error ?? res.status}).`;
    throw new Error(why);
  }
  tokens.set(conn.calendar_id, { token: data.access_token, until: Date.now() + data.expires_in * 1000 });
  return data.access_token as string;
}

async function google(conn: Conn, method: string, path: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await accessToken(conn)}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  return { status: res.status, ok: res.ok, data: text ? JSON.parse(text) : null };
}

const calPath = (conn: Conn) => `/calendars/${encodeURIComponent(conn.google_calendar_id)}`;

async function setError(calendarId: string, message: string | null) {
  await db.from("calendar_google").update({ last_error: message?.slice(0, 500) ?? null }).eq("calendar_id", calendarId);
  await db.from("calendars").update({ sync_error: message?.slice(0, 500) ?? null }).eq("id", calendarId);
}

// ---------------------------------------------------------------- panel -> Google
async function pushEvent(conn: Conn, eventId: string) {
  const { data: e } = await db.from("calendar_events").select("*").eq("id", eventId).maybeSingle();
  if (!e || e.source === "import") return;
  const row = e as EventRow;
  const gid = row.google_event_id ?? googleIdFor(row.id);
  const body = toGoogle(row);
  let res = await google(conn, "PATCH", `${calPath(conn)}/events/${gid}`, { ...body, status: "confirmed" });
  if (res.status === 404) res = await google(conn, "POST", `${calPath(conn)}/events`, { ...body, id: gid });
  if (!res.ok) throw new Error(`Google respondió ${res.status}: ${res.data?.error?.message ?? ""}`);
  if (row.google_event_id !== gid) {
    await db.from("calendar_events").update({ google_event_id: gid }).eq("id", row.id);
  }
}

async function deleteEvent(conn: Conn, googleEventId: string) {
  const res = await google(conn, "DELETE", `${calPath(conn)}/events/${encodeURIComponent(googleEventId)}`);
  if (!res.ok && res.status !== 404 && res.status !== 410) throw new Error(`Google respondió ${res.status}`);
}

async function flush() {
  const conns = new Map<string, Conn | null>();
  let done = 0;
  for (let round = 0; round < 10; round++) {
    const { data: jobs, error } = await db.rpc("google_claim_outbox", { p_limit: 50 });
    if (error) throw error;
    if (!jobs?.length) break;
    for (const job of jobs) {
      if (!conns.has(job.calendar_id)) {
        const { data } = await db.from("calendar_google").select("*").eq("calendar_id", job.calendar_id).maybeSingle();
        conns.set(job.calendar_id, data as Conn | null);
      }
      const conn = conns.get(job.calendar_id);
      if (!conn) continue;  // se desconectó: el cambio ya no va a ningún sitio
      try {
        if (job.op === "delete") await deleteEvent(conn, job.google_event_id);
        else await pushEvent(conn, job.event_id);
        done++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (job.attempts + 1 < MAX_ATTEMPTS) {
          await db.from("google_outbox").insert({
            calendar_id: job.calendar_id, event_id: job.event_id, google_event_id: job.google_event_id,
            op: job.op, attempts: job.attempts + 1, last_error: message.slice(0, 500),
          });
        }
        await setError(job.calendar_id, `No se pudo mandar una cita a Google: ${message}`);
        await db.from("error_log").insert({ source: "google-calendar", message: `push: ${message}`.slice(0, 1000) });
      }
    }
  }
  return done;
}

// ---------------------------------------------------------------- Google -> panel
async function pull(conn: Conn, full = false) {
  const startedAt = new Date();
  const params = new URLSearchParams({
    singleEvents: "true", showDeleted: "true", maxResults: "2500",
    timeMin: new Date(Date.now() - PAST_DAYS * 86_400_000).toISOString(),
    timeMax: new Date(Date.now() + FUTURE_DAYS * 86_400_000).toISOString(),
  });
  // Solo lo cambiado desde la última vez (con un minuto de margen).
  if (!full && conn.pulled_at) params.set("updatedMin", new Date(new Date(conn.pulled_at).getTime() - 60_000).toISOString());

  const { data: calendar } = await db.from("calendars").select("client_id").eq("id", conn.calendar_id).single();
  let pageToken: string | undefined;
  let changed = 0;
  do {
    if (pageToken) params.set("pageToken", pageToken);
    const res = await google(conn, "GET", `${calPath(conn)}/events?${params}`);
    if (res.status === 410 && !full) return await pull(conn, true);
    if (!res.ok) throw new Error(`Google respondió ${res.status}: ${res.data?.error?.message ?? ""}`);
    for (const g of res.data.items ?? []) {
      changed += await applyGoogleEvent(conn, calendar!.client_id, g);
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  await db.from("calendar_google").update({ pulled_at: startedAt.toISOString(), last_error: null }).eq("calendar_id", conn.calendar_id);
  await db.from("calendars").update({ last_synced_at: new Date().toISOString(), sync_error: null }).eq("id", conn.calendar_id);
  return changed;
}

async function applyGoogleEvent(conn: Conn, clientId: string, g: GEvent) {
  // ¿Ya la tenemos? Por su id de Google o, si nació en el panel, por su uuid.
  const ownId = uuidFromGoogleId(g.id);
  let { data: existing } = await db.from("calendar_events").select("id")
    .eq("calendar_id", conn.calendar_id).eq("google_event_id", g.id).maybeSingle();
  if (!existing && ownId) {
    ({ data: existing } = await db.from("calendar_events").select("id")
      .eq("calendar_id", conn.calendar_id).eq("id", ownId).maybeSingle());
  }

  if (g.status === "cancelled") {
    if (!existing) return 0;
    await db.from("calendar_events").delete().eq("id", existing.id);
    return 1;
  }
  const fields = fromGoogle(g);
  if (!fields) return 0;
  if (existing) {
    await db.from("calendar_events").update({ ...fields, google_event_id: g.id }).eq("id", existing.id);
  } else {
    await db.from("calendar_events").insert({
      ...fields, calendar_id: conn.calendar_id, client_id: clientId, source: "google", google_event_id: g.id,
    });
  }
  return 1;
}

// ---------------------------------------------------------------- avisos de Google
async function watch(conn: Conn) {
  if (conn.channel_id && conn.channel_resource_id) {
    await google(conn, "POST", "/channels/stop", { id: conn.channel_id, resourceId: conn.channel_resource_id }).catch(() => null);
  }
  const id = crypto.randomUUID();
  const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  const res = await google(conn, "POST", `${calPath(conn)}/events/watch`, {
    id, type: "web_hook", address: `${SELF}?action=notify`, token, params: { ttl: "604800" },
  });
  if (!res.ok) throw new Error(`Google no acepta los avisos (${res.status}): ${res.data?.error?.message ?? ""}`);
  await db.from("calendar_google").update({
    channel_id: id, channel_resource_id: res.data.resourceId, channel_token: token,
    channel_expires_at: new Date(Number(res.data.expiration)).toISOString(),
  }).eq("calendar_id", conn.calendar_id);
}

async function notify(req: Request) {
  const id = req.headers.get("x-goog-channel-id");
  const token = req.headers.get("x-goog-channel-token");
  if (!id || !token) return new Response(null, { status: 400 });
  const { data: conn } = await db.from("calendar_google").select("*").eq("channel_id", id).maybeSingle();
  if (!conn || conn.channel_token !== token) return new Response(null, { status: 404 });
  if (req.headers.get("x-goog-resource-state") === "sync") return new Response(null, { status: 200 });
  try {
    await pull(conn as Conn);
  } catch (err) {
    await setError(conn.calendar_id, err instanceof Error ? err.message : String(err));
  }
  return new Response(null, { status: 200 });
}

// ---------------------------------------------------------------- conectar
async function currentUser(req: Request) {
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data } = await db.auth.getUser(jwt);
  if (!data.user) return null;
  // Con su propio token: RLS decide qué calendarios puede tocar.
  const asUser = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  return { user: data.user, asUser };
}

// deno-lint-ignore no-explicit-any
async function canUse(asUser: any, calendarId: unknown) {
  if (typeof calendarId !== "string") return false;
  const { data } = await asUser.from("calendars").select("id").eq("id", calendarId).maybeSingle();
  return !!data;
}

async function connect(req: Request, body: Record<string, unknown>) {
  if (!CLIENT_ID || !CLIENT_SECRET) return json({ error: "Falta configurar Google (GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en Supabase)." }, 503);
  const me = await currentUser(req);
  if (!me) return json({ error: "Tienes que entrar en el panel." }, 401);
  if (!(await canUse(me.asUser, body.calendar_id))) return json({ error: "Calendario no encontrado." }, 404);
  const returnUrl = String(body.return_url ?? "");
  if (!RETURN_PREFIXES.some((p) => returnUrl.startsWith(p))) return json({ error: "Dirección de vuelta no permitida." }, 400);

  const state = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  await db.from("google_oauth_states").delete().lt("created_at", new Date(Date.now() - 15 * 60_000).toISOString());
  await db.from("google_oauth_states").insert({ state, calendar_id: body.calendar_id, user_id: me.user.id, return_url: returnUrl });
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: SELF, response_type: "code", scope: SCOPES,
    access_type: "offline", prompt: "consent", include_granted_scopes: "true", state,
  }).toString();
  return json({ url: url.toString() });
}

function back(returnUrl: string, result: string) {
  const url = new URL(returnUrl);
  url.searchParams.set("google", result);
  return Response.redirect(url.toString(), 302);
}

async function callback(url: URL) {
  const state = url.searchParams.get("state") ?? "";
  const { data: pending } = await db.from("google_oauth_states").select("*").eq("state", state).maybeSingle();
  if (!pending || Date.now() - new Date(pending.created_at).getTime() > 15 * 60_000) {
    return new Response("El enlace ha caducado. Vuelve al panel y pulsa otra vez «Conectar con Google».", { status: 400 });
  }
  await db.from("google_oauth_states").delete().eq("state", state);
  if (url.searchParams.get("error") || !url.searchParams.get("code")) return back(pending.return_url, "cancelado");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: url.searchParams.get("code")!, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      redirect_uri: SELF, grant_type: "authorization_code",
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.refresh_token) {
    await db.from("error_log").insert({ source: "google-calendar", message: `oauth: ${JSON.stringify(data).slice(0, 500)}` });
    return back(pending.return_url, "error");
  }
  if (!String(data.scope ?? "").includes("calendar.events")) return back(pending.return_url, "sin-permiso");
  let email: string | null = null;
  try {
    email = JSON.parse(atob(String(data.id_token).split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).email ?? null;
  } catch { /* sin correo: no pasa nada */ }

  const conn: Conn = {
    calendar_id: pending.calendar_id, account_email: email, refresh_token: data.refresh_token,
    google_calendar_id: "primary", channel_id: null, channel_resource_id: null, channel_token: null,
    channel_expires_at: null, pulled_at: null,
  };
  tokens.set(conn.calendar_id, { token: data.access_token, until: Date.now() + data.expires_in * 1000 });
  await db.from("calendar_google").upsert({ ...conn, connected_at: new Date().toISOString(), last_error: null });
  // Con Google conectado, el enlace iCal de importación sobra (duplicaría citas).
  await db.from("calendars").update({ google_account: email ?? "Google", ics_import_url: null }).eq("id", conn.calendar_id);
  await db.from("calendar_events").delete().eq("calendar_id", conn.calendar_id).eq("source", "import");

  try {
    // Lo que ya había en el panel sube a Google; lo de Google baja al panel.
    const { data: mine } = await db.from("calendar_events").select("id")
      .eq("calendar_id", conn.calendar_id).in("source", ["panel", "agent"])
      .gte("ends_at", new Date(Date.now() - PAST_DAYS * 86_400_000).toISOString());
    for (const e of mine ?? []) await pushEvent(conn, e.id);
    await pull(conn, true);
    await watch(conn);
  } catch (err) {
    await setError(conn.calendar_id, err instanceof Error ? err.message : String(err));
    return back(pending.return_url, "error");
  }
  return back(pending.return_url, "conectado");
}

async function disconnect(req: Request, body: Record<string, unknown>) {
  const me = await currentUser(req);
  if (!me) return json({ error: "Tienes que entrar en el panel." }, 401);
  if (!(await canUse(me.asUser, body.calendar_id))) return json({ error: "Calendario no encontrado." }, 404);
  const { data: conn } = await db.from("calendar_google").select("*").eq("calendar_id", body.calendar_id).maybeSingle();
  if (conn) {
    if (conn.channel_id) await google(conn, "POST", "/channels/stop", { id: conn.channel_id, resourceId: conn.channel_resource_id }).catch(() => null);
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(conn.refresh_token)}`, { method: "POST" }).catch(() => null);
    await db.from("calendar_google").delete().eq("calendar_id", conn.calendar_id);
  }
  // Lo traído de Google se quita del panel; lo creado aquí se queda (y sigue en Google).
  await db.from("calendar_events").delete().eq("calendar_id", body.calendar_id).eq("source", "google");
  await db.from("calendar_events").update({ google_event_id: null }).eq("calendar_id", body.calendar_id);
  await db.from("calendars").update({ google_account: null, sync_error: null }).eq("id", body.calendar_id);
  tokens.delete(String(body.calendar_id));
  return json({ ok: true });
}

async function pullNow(req: Request, body: Record<string, unknown>) {
  const me = await currentUser(req);
  if (!me) return json({ error: "Tienes que entrar en el panel." }, 401);
  if (!(await canUse(me.asUser, body.calendar_id))) return json({ error: "Calendario no encontrado." }, 404);
  const { data: conn } = await db.from("calendar_google").select("*").eq("calendar_id", body.calendar_id).maybeSingle();
  if (!conn) return json({ error: "Este calendario no está conectado con Google." }, 404);
  try {
    await flush();
    return json({ changed: await pull(conn as Conn) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await setError(conn.calendar_id, message);
    return json({ error: message }, 502);
  }
}

async function maintain() {
  await flush();
  const { data: conns } = await db.from("calendar_google").select("*");
  const result = { renewed: 0, pulled: 0, errors: 0 };
  for (const conn of (conns ?? []) as Conn[]) {
    try {
      // Los avisos caducan a la semana: se renuevan con un día de margen.
      if (!conn.channel_expires_at || new Date(conn.channel_expires_at).getTime() - Date.now() < 86_400_000) {
        await watch(conn);
        result.renewed++;
      }
      // Repaso por si algún aviso se perdió.
      if (!conn.pulled_at || Date.now() - new Date(conn.pulled_at).getTime() > 30 * 60_000) {
        await pull(conn);
        result.pulled++;
      }
    } catch (err) {
      result.errors++;
      await setError(conn.calendar_id, err instanceof Error ? err.message : String(err));
    }
  }
  return result;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  try {
    if (req.method === "GET" && url.searchParams.has("state")) return await callback(url);
    if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
    if (action === "notify") return await notify(req);
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    if (action === "connect") return await connect(req, body);
    if (action === "disconnect") return await disconnect(req, body);
    if (action === "pull") return await pullNow(req, body);
    if (!CLIENT_ID || !CLIENT_SECRET) return json({ skipped: "Google sin configurar" });
    if (action === "flush") return json({ pushed: await flush() });
    if (action === "maintain") return json(await maintain());
    return json({ error: "Acción desconocida" }, 400);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.from("error_log").insert({ source: "google-calendar", message: `${action}: ${message}`.slice(0, 1000) });
    return json({ error: message }, 500);
  }
});
