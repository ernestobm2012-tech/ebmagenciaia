// Conexión directa de un calendario del panel con Outlook / Microsoft 365
// (Microsoft Graph), en los dos sentidos y al momento. Mismo esquema que google-calendar.
//   POST ?action=connect     (usuario del panel) -> URL para entrar con Microsoft
//   GET  ?code&state         (vuelta de Microsoft) -> guarda la conexión
//   POST ?action=disconnect  (usuario del panel) -> desconecta
//   POST ?action=pull        (usuario del panel) -> trae cambios ahora
//   POST ?action=flush       (trigger de la BD)  -> manda a Outlook los cambios del panel
//   POST ?action=notify      (Microsoft)         -> algo cambió en Outlook: lo trae
//   POST ?action=maintain    (cron)              -> reintentos, renovar avisos, repaso
// Secretos: MICROSOFT_CLIENT_ID y MICROSOFT_CLIENT_SECRET. Opcionales: MICROSOFT_TENANT, PANEL_URL.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// deno-lint-ignore no-explicit-any
declare const EdgeRuntime: any;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const db = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CLIENT_ID = Deno.env.get("MICROSOFT_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("MICROSOFT_CLIENT_SECRET") ?? "";
const TENANT = Deno.env.get("MICROSOFT_TENANT") ?? "common";
const SELF = `${SUPABASE_URL}/functions/v1/microsoft-calendar`;
const AUTH = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0`;
const GRAPH = "https://graph.microsoft.com/v1.0";
const SCOPES = "offline_access openid email profile User.Read Calendars.ReadWrite";
const TZ = "Europe/Madrid";
const GRAPH_TZ = "Romance Standard Time"; // Madrid, en la nomenclatura de Windows
const PAST_DAYS = 30;
const FUTURE_DAYS = 365;
const SUBSCRIPTION_MINUTES = 4200; // Microsoft permite hasta 4230 para eventos
const RETURN_PREFIXES = ["https://ernestobm2012-tech.github.io/", "https://ebmagenciaia.es/", Deno.env.get("PANEL_URL") ?? ""].filter(Boolean);
const MAX_ATTEMPTS = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

type Conn = {
  calendar_id: string; account_email: string | null; refresh_token: string;
  subscription_id: string | null; subscription_secret: string | null;
  subscription_expires_at: string | null; pulled_at: string | null;
};
type EventRow = {
  id: string; calendar_id: string; title: string; description: string | null; location: string | null;
  starts_at: string; ends_at: string; all_day: boolean; source: string; microsoft_event_id: string | null;
  created_at: string;
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
const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

function madridOffsetMinutes(utcMs: number) {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const g = (t: string) => Number(p.find((x) => x.type === t)!.value);
  return (Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - utcMs) / 60_000;
}
// Hora local de Madrid ("2026-10-05T10:00:00.0000000") -> instante real.
function fromMadridLocal(s: string) {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/)!;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  let t = guess - madridOffsetMinutes(guess) * 60_000;
  t = guess - madridOffsetMinutes(t) * 60_000;
  return new Date(t);
}
function parseGraphTime(v: { dateTime: string; timeZone?: string }) {
  return v.timeZone === "UTC" ? new Date(`${v.dateTime.slice(0, 19)}Z`) : fromMadridLocal(v.dateTime);
}

// Cita del panel -> evento de Outlook.
export function toGraph(e: EventRow) {
  const body: Record<string, unknown> = {
    subject: e.title,
    body: { contentType: "text", content: e.description ?? "" },
    location: { displayName: e.location ?? "" },
    isAllDay: e.all_day,
  };
  if (e.all_day) {
    const start = madridDay(new Date(e.starts_at));
    let end = madridDay(new Date(e.ends_at));
    if (end <= start) end = nextDay(start);
    body.start = { dateTime: `${start}T00:00:00`, timeZone: TZ };
    body.end = { dateTime: `${end}T00:00:00`, timeZone: TZ };
  } else {
    body.start = { dateTime: new Date(e.starts_at).toISOString().slice(0, 19), timeZone: "UTC" };
    body.end = { dateTime: new Date(e.ends_at).toISOString().slice(0, 19), timeZone: "UTC" };
  }
  return body;
}

// Evento de Outlook -> campos de la cita del panel (null si no se puede leer).
export function fromGraph(g: GEvent) {
  if (!g.start?.dateTime) return null;
  const allDay = !!g.isAllDay;
  const start = allDay ? madridMidnight(g.start.dateTime.slice(0, 10)) : parseGraphTime(g.start);
  let end = allDay
    ? (g.end?.dateTime ? madridMidnight(g.end.dateTime.slice(0, 10)) : null)
    : g.end?.dateTime ? parseGraphTime(g.end) : null;
  if (!end || end < start) end = allDay ? new Date(start.getTime() + 86_400_000) : start;
  const text = g.body?.content ? String(g.body.content).replace(/\r\n/g, "\n").trim() : "";
  return {
    title: String(g.subject || "Ocupado").slice(0, 300),
    description: text ? text.slice(0, 2000) : null,
    location: g.location?.displayName ? String(g.location.displayName).slice(0, 300) : null,
    starts_at: start.toISOString(),
    ends_at: end.toISOString(),
    all_day: allDay,
  };
}

// ---------------------------------------------------------------- Microsoft Graph
const tokens = new Map<string, { token: string; until: number }>();

async function accessToken(conn: Conn) {
  const cached = tokens.get(conn.calendar_id);
  if (cached && cached.until > Date.now() + 60_000) return cached.token;
  const res = await fetch(`${AUTH}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: "refresh_token",
      refresh_token: conn.refresh_token, scope: SCOPES,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    const why = data.error === "invalid_grant"
      ? "Microsoft ha retirado el permiso. Vuelve a conectar la cuenta."
      : `Microsoft no da acceso (${data.error ?? res.status}).`;
    throw new Error(why);
  }
  // Microsoft renueva el token de actualización: hay que guardar el nuevo.
  if (data.refresh_token && data.refresh_token !== conn.refresh_token) {
    conn.refresh_token = data.refresh_token;
    await db.from("calendar_microsoft").update({ refresh_token: data.refresh_token }).eq("calendar_id", conn.calendar_id);
  }
  tokens.set(conn.calendar_id, { token: data.access_token, until: Date.now() + data.expires_in * 1000 });
  return data.access_token as string;
}

async function graph(conn: Conn, method: string, path: string, body?: unknown) {
  const res = await fetch(path.startsWith("http") ? path : `${GRAPH}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await accessToken(conn)}`,
      "Content-Type": "application/json",
      Prefer: `outlook.timezone="${GRAPH_TZ}", outlook.body-content-type="text"`,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  // deno-lint-ignore no-explicit-any
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* respuesta sin cuerpo */ }
  return { status: res.status, ok: res.ok, data };
}
const graphError = (res: { status: number; data: GEvent }) =>
  `Microsoft respondió ${res.status}: ${res.data?.error?.message ?? ""}`;

async function setError(calendarId: string, message: string | null) {
  await db.from("calendar_microsoft").update({ last_error: message?.slice(0, 500) ?? null }).eq("calendar_id", calendarId);
  await db.from("calendars").update({ sync_error: message?.slice(0, 500) ?? null }).eq("id", calendarId);
}

// ---------------------------------------------------------------- panel -> Outlook
async function pushEvent(conn: Conn, eventId: string) {
  const { data: e } = await db.from("calendar_events").select("*").eq("id", eventId).maybeSingle();
  if (!e || e.source === "import") return;
  const row = e as EventRow;
  const body = toGraph(row);
  let res = row.microsoft_event_id
    ? await graph(conn, "PATCH", `/me/events/${encodeURIComponent(row.microsoft_event_id)}`, body)
    : null;
  if (!res || res.status === 404) {
    // transactionId evita duplicados si se reintenta el envío y sirve para reconocer la cita al volver.
    res = await graph(conn, "POST", "/me/events", { ...body, transactionId: row.id });
  }
  if (!res.ok) throw new Error(graphError(res));
  const msId = res.data?.id as string | undefined;
  if (msId && msId !== row.microsoft_event_id) {
    await db.from("calendar_events").update({ microsoft_event_id: msId }).eq("id", row.id);
  }
}

async function deleteEvent(conn: Conn, microsoftEventId: string) {
  const res = await graph(conn, "DELETE", `/me/events/${encodeURIComponent(microsoftEventId)}`);
  if (!res.ok && res.status !== 404 && res.status !== 410) throw new Error(graphError(res));
}

async function flush() {
  const conns = new Map<string, Conn | null>();
  let done = 0;
  for (let round = 0; round < 10; round++) {
    const { data: jobs, error } = await db.rpc("microsoft_claim_outbox", { p_limit: 50 });
    if (error) throw error;
    if (!jobs?.length) break;
    for (const job of jobs) {
      if (!conns.has(job.calendar_id)) {
        const { data } = await db.from("calendar_microsoft").select("*").eq("calendar_id", job.calendar_id).maybeSingle();
        conns.set(job.calendar_id, data as Conn | null);
      }
      const conn = conns.get(job.calendar_id);
      if (!conn) continue;
      try {
        if (job.op === "delete") await deleteEvent(conn, job.microsoft_event_id);
        else await pushEvent(conn, job.event_id);
        done++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (job.attempts + 1 < MAX_ATTEMPTS) {
          await db.from("microsoft_outbox").insert({
            calendar_id: job.calendar_id, event_id: job.event_id, microsoft_event_id: job.microsoft_event_id,
            op: job.op, attempts: job.attempts + 1, last_error: message.slice(0, 500),
          });
        }
        await setError(job.calendar_id, `No se pudo mandar una cita a Outlook: ${message}`);
        await db.from("error_log").insert({ source: "microsoft-calendar", message: `push: ${message}`.slice(0, 1000) });
      }
    }
  }
  return done;
}

// ---------------------------------------------------------------- Outlook -> panel
async function pull(conn: Conn) {
  const startedAt = new Date();
  const from = new Date(Date.now() - PAST_DAYS * 86_400_000).toISOString();
  const to = new Date(Date.now() + FUTURE_DAYS * 86_400_000).toISOString();
  const select = "id,subject,body,location,start,end,isAllDay,isCancelled,transactionId";
  const { data: calendar } = await db.from("calendars").select("client_id").eq("id", conn.calendar_id).single();

  const seen = new Set<string>();
  let changed = 0;
  let next: string | null =
    `/me/calendarView?startDateTime=${encodeURIComponent(from)}&endDateTime=${encodeURIComponent(to)}&$top=250&$select=${select}`;
  while (next) {
    const res = await graph(conn, "GET", next);
    if (!res.ok) throw new Error(graphError(res));
    for (const g of res.data.value ?? []) {
      seen.add(g.id);
      changed += await applyEvent(conn, calendar!.client_id, g);
    }
    next = res.data["@odata.nextLink"] ?? null;
  }

  // Lo que ya no está en Outlook se quita del panel (salvo lo recién creado, que puede no estar aún).
  const { data: known } = await db.from("calendar_events").select("id, microsoft_event_id, created_at")
    .eq("calendar_id", conn.calendar_id).not("microsoft_event_id", "is", null)
    .gte("ends_at", from).lte("starts_at", to);
  for (const k of known ?? []) {
    if (seen.has(k.microsoft_event_id) || Date.now() - new Date(k.created_at).getTime() < 5 * 60_000) continue;
    await db.from("calendar_events").delete().eq("id", k.id);
    changed++;
  }

  await db.from("calendar_microsoft").update({ pulled_at: startedAt.toISOString(), last_error: null }).eq("calendar_id", conn.calendar_id);
  await db.from("calendars").update({ last_synced_at: new Date().toISOString(), sync_error: null }).eq("id", conn.calendar_id);
  return changed;
}

async function applyEvent(conn: Conn, clientId: string, g: GEvent) {
  let { data: existing } = await db.from("calendar_events").select("id")
    .eq("calendar_id", conn.calendar_id).eq("microsoft_event_id", g.id).maybeSingle();
  // Una cita creada en el panel vuelve con su identificador de panel en transactionId.
  if (!existing && typeof g.transactionId === "string" && UUID.test(g.transactionId)) {
    ({ data: existing } = await db.from("calendar_events").select("id")
      .eq("calendar_id", conn.calendar_id).eq("id", g.transactionId).maybeSingle());
  }
  if (g.isCancelled) {
    if (!existing) return 0;
    await db.from("calendar_events").delete().eq("id", existing.id);
    return 1;
  }
  const fields = fromGraph(g);
  if (!fields) return 0;
  if (existing) {
    await db.from("calendar_events").update({ ...fields, microsoft_event_id: g.id }).eq("id", existing.id);
  } else {
    await db.from("calendar_events").insert({
      ...fields, calendar_id: conn.calendar_id, client_id: clientId, source: "microsoft", microsoft_event_id: g.id,
    });
  }
  return 1;
}

// ---------------------------------------------------------------- avisos de Microsoft
async function watch(conn: Conn) {
  const expiration = new Date(Date.now() + SUBSCRIPTION_MINUTES * 60_000).toISOString();
  if (conn.subscription_id) {
    const res = await graph(conn, "PATCH", `/subscriptions/${conn.subscription_id}`, { expirationDateTime: expiration });
    if (res.ok) {
      await db.from("calendar_microsoft").update({ subscription_expires_at: res.data?.expirationDateTime ?? expiration })
        .eq("calendar_id", conn.calendar_id);
      return;
    }
  }
  const secret = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  const res = await graph(conn, "POST", "/subscriptions", {
    changeType: "created,updated,deleted", notificationUrl: `${SELF}?action=notify`,
    resource: "me/events", expirationDateTime: expiration, clientState: secret,
  });
  if (!res.ok) throw new Error(`Microsoft no acepta los avisos (${res.status}): ${res.data?.error?.message ?? ""}`);
  await db.from("calendar_microsoft").update({
    subscription_id: res.data.id, subscription_secret: secret,
    subscription_expires_at: res.data.expirationDateTime ?? expiration,
  }).eq("calendar_id", conn.calendar_id);
}

async function notify(req: Request, url: URL) {
  // Microsoft comprueba la dirección al crear la suscripción: hay que devolver el código tal cual.
  const validation = url.searchParams.get("validationToken");
  if (validation) return new Response(validation, { status: 200, headers: { "Content-Type": "text/plain" } });

  const body = await req.json().catch(() => null);
  const work = (async () => {
    const done = new Set<string>();
    for (const n of body?.value ?? []) {
      if (!n?.subscriptionId || done.has(n.subscriptionId)) continue;
      const { data: conn } = await db.from("calendar_microsoft").select("*").eq("subscription_id", n.subscriptionId).maybeSingle();
      if (!conn || conn.subscription_secret !== n.clientState) continue;
      done.add(n.subscriptionId);
      try {
        await pull(conn as Conn);
      } catch (err) {
        await setError(conn.calendar_id, err instanceof Error ? err.message : String(err));
      }
    }
  })();
  // Microsoft espera respuesta en pocos segundos: se contesta ya y se trabaja después.
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(work);
  else await work;
  return new Response(null, { status: 202 });
}

// ---------------------------------------------------------------- conectar
async function currentUser(req: Request) {
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data } = await db.auth.getUser(jwt);
  if (!data.user) return null;
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
  if (!CLIENT_ID || !CLIENT_SECRET) return json({ error: "Falta configurar Outlook (MICROSOFT_CLIENT_ID y MICROSOFT_CLIENT_SECRET en Supabase)." }, 503);
  const me = await currentUser(req);
  if (!me) return json({ error: "Tienes que entrar en el panel." }, 401);
  if (!(await canUse(me.asUser, body.calendar_id))) return json({ error: "Calendario no encontrado." }, 404);
  const returnUrl = String(body.return_url ?? "");
  if (!RETURN_PREFIXES.some((p) => returnUrl.startsWith(p))) return json({ error: "Dirección de vuelta no permitida." }, 400);
  const { data: g } = await db.from("calendar_google").select("calendar_id").eq("calendar_id", body.calendar_id).maybeSingle();
  if (g) return json({ error: "Este calendario ya está conectado con Google. Desconéctalo primero." }, 409);

  const state = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  await db.from("microsoft_oauth_states").delete().lt("created_at", new Date(Date.now() - 15 * 60_000).toISOString());
  await db.from("microsoft_oauth_states").insert({ state, calendar_id: body.calendar_id, user_id: me.user.id, return_url: returnUrl });
  const url = new URL(`${AUTH}/authorize`);
  url.search = new URLSearchParams({
    client_id: CLIENT_ID, response_type: "code", redirect_uri: SELF, response_mode: "query",
    scope: SCOPES, prompt: "select_account", state,
  }).toString();
  return json({ url: url.toString() });
}

function back(returnUrl: string, result: string) {
  const url = new URL(returnUrl);
  url.searchParams.set("outlook", result);
  return Response.redirect(url.toString(), 302);
}

async function callback(url: URL) {
  const state = url.searchParams.get("state") ?? "";
  const { data: pending } = await db.from("microsoft_oauth_states").select("*").eq("state", state).maybeSingle();
  if (!pending || Date.now() - new Date(pending.created_at).getTime() > 15 * 60_000) {
    return new Response("El enlace ha caducado. Vuelve al panel y pulsa otra vez «Conectar con Outlook».", { status: 400 });
  }
  await db.from("microsoft_oauth_states").delete().eq("state", state);
  if (url.searchParams.get("error") || !url.searchParams.get("code")) return back(pending.return_url, "cancelado");

  const res = await fetch(`${AUTH}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: "authorization_code",
      code: url.searchParams.get("code")!, redirect_uri: SELF, scope: SCOPES,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.refresh_token) {
    await db.from("error_log").insert({ source: "microsoft-calendar", message: `oauth: ${JSON.stringify(data).slice(0, 500)}` });
    return back(pending.return_url, "error");
  }
  if (!String(data.scope ?? "").toLowerCase().includes("calendars.readwrite")) return back(pending.return_url, "sin-permiso");

  const conn: Conn = {
    calendar_id: pending.calendar_id, account_email: null, refresh_token: data.refresh_token,
    subscription_id: null, subscription_secret: null, subscription_expires_at: null, pulled_at: null,
  };
  tokens.set(conn.calendar_id, { token: data.access_token, until: Date.now() + data.expires_in * 1000 });
  const profile = await graph(conn, "GET", "/me?$select=mail,userPrincipalName");
  const email: string = profile.data?.mail ?? profile.data?.userPrincipalName ?? "Outlook";
  conn.account_email = email;

  const { error: insertError } = await db.from("calendar_microsoft")
    .upsert({ ...conn, connected_at: new Date().toISOString(), last_error: null });
  if (insertError) {
    await db.from("error_log").insert({ source: "microsoft-calendar", message: `connect: ${insertError.message}`.slice(0, 500) });
    return back(pending.return_url, /Google/.test(insertError.message) ? "otro-proveedor" : "error");
  }
  // Con Outlook conectado, el enlace iCal de importación sobra (duplicaría citas).
  await db.from("calendars").update({ microsoft_account: email, ics_import_url: null }).eq("id", conn.calendar_id);
  await db.from("calendar_events").delete().eq("calendar_id", conn.calendar_id).eq("source", "import");

  try {
    const { data: mine } = await db.from("calendar_events").select("id")
      .eq("calendar_id", conn.calendar_id).in("source", ["panel", "agent"])
      .gte("ends_at", new Date(Date.now() - PAST_DAYS * 86_400_000).toISOString());
    for (const e of mine ?? []) await pushEvent(conn, e.id);
    await pull(conn);
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
  const { data: conn } = await db.from("calendar_microsoft").select("*").eq("calendar_id", body.calendar_id).maybeSingle();
  if (conn) {
    if (conn.subscription_id) await graph(conn as Conn, "DELETE", `/subscriptions/${conn.subscription_id}`).catch(() => null);
    await db.from("calendar_microsoft").delete().eq("calendar_id", conn.calendar_id);
  }
  await db.from("calendar_events").delete().eq("calendar_id", body.calendar_id).eq("source", "microsoft");
  await db.from("calendar_events").update({ microsoft_event_id: null }).eq("calendar_id", body.calendar_id);
  await db.from("calendars").update({ microsoft_account: null, sync_error: null }).eq("id", body.calendar_id);
  tokens.delete(String(body.calendar_id));
  return json({ ok: true });
}

async function pullNow(req: Request, body: Record<string, unknown>) {
  const me = await currentUser(req);
  if (!me) return json({ error: "Tienes que entrar en el panel." }, 401);
  if (!(await canUse(me.asUser, body.calendar_id))) return json({ error: "Calendario no encontrado." }, 404);
  const { data: conn } = await db.from("calendar_microsoft").select("*").eq("calendar_id", body.calendar_id).maybeSingle();
  if (!conn) return json({ error: "Este calendario no está conectado con Outlook." }, 404);
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
  const { data: conns } = await db.from("calendar_microsoft").select("*");
  const result = { renewed: 0, pulled: 0, errors: 0 };
  for (const conn of (conns ?? []) as Conn[]) {
    try {
      // Los avisos caducan a los 3 días: se renuevan con medio día de margen.
      if (!conn.subscription_expires_at || new Date(conn.subscription_expires_at).getTime() - Date.now() < 12 * 3_600_000) {
        await watch(conn);
        result.renewed++;
      }
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
    if (action === "notify") return await notify(req, url);
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    if (action === "connect") return await connect(req, body);
    if (action === "disconnect") return await disconnect(req, body);
    if (action === "pull") return await pullNow(req, body);
    if (!CLIENT_ID || !CLIENT_SECRET) return json({ skipped: "Outlook sin configurar" });
    if (action === "flush") return json({ pushed: await flush() });
    if (action === "maintain") return json(await maintain());
    return json({ error: "Acción desconocida" }, 400);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.from("error_log").insert({ source: "microsoft-calendar", message: `${action}: ${message}`.slice(0, 1000) });
    return json({ error: message }, 500);
  }
});
