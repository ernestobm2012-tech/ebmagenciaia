// Agente de IA en los mensajes directos de Instagram («Instagram API con inicio de
// sesión de Instagram»). El cliente conecta su cuenta profesional desde el panel y
// el agente contesta con el mismo cerebro que el chat de la web (función `chat`).
//   POST ?action=connect     (usuario del panel) -> URL para entrar con Instagram
//   GET  ?code&state         (vuelta de Instagram) -> guarda la cuenta y el aviso de mensajes
//   POST ?action=disconnect  (usuario del panel) -> desconecta la cuenta
//   POST ?action=toggle      (usuario del panel) -> pausa o reactiva las respuestas automáticas
//   GET  ?hub.mode=subscribe (Meta)              -> verificación del webhook
//   POST (con firma)         (Meta)              -> mensaje nuevo: lo contesta
//   POST ?action=maintain    (cron diario)       -> renueva las credenciales que caducan
// Secretos: INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET, INSTAGRAM_VERIFY_TOKEN. Opcional: PANEL_URL.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// deno-lint-ignore no-explicit-any
declare const EdgeRuntime: any;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SUPABASE_URL, SERVICE_KEY);
const APP_ID = Deno.env.get("INSTAGRAM_APP_ID") ?? "";
const APP_SECRET = Deno.env.get("INSTAGRAM_APP_SECRET") ?? "";
const VERIFY_TOKEN = Deno.env.get("INSTAGRAM_VERIFY_TOKEN") ?? "";
const SELF = `${SUPABASE_URL}/functions/v1/instagram`;
const GRAPH = "https://graph.instagram.com/v22.0";
const SCOPES = "instagram_business_basic,instagram_business_manage_messages";
const RETURN_PREFIXES = ["https://ernestobm2012-tech.github.io/", "https://ebmagenciaia.es/", Deno.env.get("PANEL_URL") ?? ""].filter(Boolean);
const CONVERSATION_HOURS = 12;   // pasado este tiempo sin hablar, empieza una conversación nueva
const MAX_TEXT = 900;            // Instagram admite 1000 caracteres por mensaje
const MAX_INPUT = 2000;          // el chat rechaza mensajes más largos
const REFRESH_DAYS = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function logError(message: string, clientId: string | null = null) {
  await db.from("error_log").insert({ client_id: clientId, source: "instagram", message: message.slice(0, 1000) });
}

// ---------------------------------------------------------------- utilidades
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hmac(secret: string, data: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
}

function sameString(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// El chat identifica a cada persona con un uuid: se saca de su id de Instagram.
async function visitorId(accountId: string, senderId: string) {
  const h = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`instagram:${accountId}:${senderId}`))).slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function chunks(text: string) {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > MAX_TEXT) {
    let cut = rest.lastIndexOf("\n", MAX_TEXT);
    if (cut < MAX_TEXT / 2) cut = rest.lastIndexOf(". ", MAX_TEXT) + 1;
    if (cut < MAX_TEXT / 2) cut = MAX_TEXT;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

// ---------------------------------------------------------------- panel
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

async function connect(req: Request, body: Record<string, unknown>) {
  if (!APP_ID || !APP_SECRET) return json({ error: "Falta configurar Instagram (INSTAGRAM_APP_ID e INSTAGRAM_APP_SECRET en Supabase)." }, 503);
  const me = await currentUser(req);
  if (!me) return json({ error: "Tienes que entrar en el panel." }, 401);
  const clientId = String(body.client_id ?? "");
  if (!UUID.test(clientId)) return json({ error: "Cliente no válido." }, 400);
  const { data: client } = await me.asUser.from("clients").select("id").eq("id", clientId).maybeSingle();
  if (!client) return json({ error: "Cliente no encontrado." }, 404);
  const returnUrl = String(body.return_url ?? "");
  if (!RETURN_PREFIXES.some((p) => returnUrl.startsWith(p))) return json({ error: "Dirección de vuelta no permitida." }, 400);

  const state = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  await db.from("social_oauth_states").delete().lt("created_at", new Date(Date.now() - 15 * 60_000).toISOString());
  await db.from("social_oauth_states").insert({ state, client_id: clientId, user_id: me.user.id, return_url: returnUrl });
  const url = new URL("https://www.instagram.com/oauth/authorize");
  url.search = new URLSearchParams({
    client_id: APP_ID, redirect_uri: SELF, response_type: "code", scope: SCOPES, state, force_reauth: "true",
  }).toString();
  return json({ url: url.toString() });
}

function back(returnUrl: string, result: string) {
  const url = new URL(returnUrl);
  url.searchParams.set("instagram", result);
  return Response.redirect(url.toString(), 302);
}

async function callback(url: URL) {
  const state = url.searchParams.get("state") ?? "";
  const { data: pending } = await db.from("social_oauth_states").select("*").eq("state", state).maybeSingle();
  if (!pending || Date.now() - new Date(pending.created_at).getTime() > 15 * 60_000) {
    return new Response("El enlace ha caducado. Vuelve al panel y pulsa otra vez «Conectar Instagram».", { status: 400 });
  }
  await db.from("social_oauth_states").delete().eq("state", state);
  const code = (url.searchParams.get("code") ?? "").replace(/#_$/, "");
  if (url.searchParams.get("error") || !code) return back(pending.return_url, "cancelado");

  // Código -> credencial corta -> credencial de 60 días.
  const shortRes = await fetch("https://api.instagram.com/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: APP_ID, client_secret: APP_SECRET, grant_type: "authorization_code", redirect_uri: SELF, code }),
  });
  const shortData = await shortRes.json().catch(() => ({}));
  const short = Array.isArray(shortData.data) ? shortData.data[0] : shortData;
  if (!shortRes.ok || !short?.access_token) {
    await logError(`oauth: ${JSON.stringify(shortData)}`, pending.client_id);
    return back(pending.return_url, "error");
  }
  const perms = String(short.permissions ?? "");
  if (perms && !perms.includes("instagram_business_manage_messages")) return back(pending.return_url, "sin-permiso");

  const longRes = await fetch(`https://graph.instagram.com/access_token?${new URLSearchParams({
    grant_type: "ig_exchange_token", client_secret: APP_SECRET, access_token: short.access_token,
  })}`);
  const longData = await longRes.json().catch(() => ({}));
  if (!longRes.ok || !longData.access_token) {
    await logError(`token largo: ${JSON.stringify(longData)}`, pending.client_id);
    return back(pending.return_url, "error");
  }
  const token: string = longData.access_token;

  const profileRes = await fetch(`${GRAPH}/me?${new URLSearchParams({ fields: "user_id,username", access_token: token })}`);
  const profile = await profileRes.json().catch(() => ({}));
  const externalId = String(profile.user_id ?? profile.id ?? short.user_id ?? "");
  if (!profileRes.ok || !externalId) {
    await logError(`perfil: ${JSON.stringify(profile)}`, pending.client_id);
    return back(pending.return_url, "error");
  }

  // Una cuenta de Instagram solo puede estar en un cliente.
  const { data: existing } = await db.from("social_accounts").select("id, client_id")
    .eq("platform", "instagram").eq("external_id", externalId).maybeSingle();
  if (existing && existing.client_id !== pending.client_id) return back(pending.return_url, "otro-cliente");

  const { data: account, error } = await db.from("social_accounts").upsert({
    client_id: pending.client_id, platform: "instagram", external_id: externalId,
    username: profile.username ?? null, last_error: null, connected_at: new Date().toISOString(),
  }, { onConflict: "platform,external_id" }).select("id").single();
  if (error || !account) {
    await logError(`guardar cuenta: ${error?.message}`, pending.client_id);
    return back(pending.return_url, "error");
  }
  await db.from("social_tokens").upsert({
    account_id: account.id, access_token: token,
    expires_at: new Date(Date.now() + Number(longData.expires_in ?? 5_184_000) * 1000).toISOString(),
    refreshed_at: new Date().toISOString(),
  });

  // Avisos de mensajes nuevos para esta cuenta.
  const sub = await fetch(`${GRAPH}/me/subscribed_apps?${new URLSearchParams({ subscribed_fields: "messages", access_token: token })}`, { method: "POST" });
  if (!sub.ok) {
    const detail = await sub.text();
    await logError(`subscribed_apps: ${detail}`, pending.client_id);
    await db.from("social_accounts").update({ last_error: "No se pudo activar el aviso de mensajes." }).eq("id", account.id);
    return back(pending.return_url, "error");
  }
  return back(pending.return_url, "conectado");
}

async function accountOf(me: NonNullable<Awaited<ReturnType<typeof currentUser>>>, accountId: unknown) {
  if (typeof accountId !== "string" || !UUID.test(accountId)) return null;
  const { data } = await me.asUser.from("social_accounts").select("id, client_id").eq("id", accountId).maybeSingle();
  return data;
}

async function disconnect(req: Request, body: Record<string, unknown>) {
  const me = await currentUser(req);
  if (!me) return json({ error: "Tienes que entrar en el panel." }, 401);
  const account = await accountOf(me, body.account_id);
  if (!account) return json({ error: "Cuenta no encontrada." }, 404);
  const { data: tok } = await db.from("social_tokens").select("access_token").eq("account_id", account.id).maybeSingle();
  if (tok) {
    await fetch(`${GRAPH}/me/subscribed_apps?access_token=${encodeURIComponent(tok.access_token)}`, { method: "DELETE" }).catch(() => null);
  }
  await db.from("social_accounts").delete().eq("id", account.id);
  return json({ ok: true });
}

async function toggle(req: Request, body: Record<string, unknown>) {
  const me = await currentUser(req);
  if (!me) return json({ error: "Tienes que entrar en el panel." }, 401);
  const account = await accountOf(me, body.account_id);
  if (!account) return json({ error: "Cuenta no encontrada." }, 404);
  await db.from("social_accounts").update({ auto_reply: body.auto_reply === true }).eq("id", account.id);
  return json({ ok: true });
}

// ---------------------------------------------------------------- mensajes
function verifyHook(url: URL) {
  if (VERIFY_TOKEN && url.searchParams.get("hub.mode") === "subscribe" &&
      sameString(url.searchParams.get("hub.verify_token") ?? "", VERIFY_TOKEN)) {
    return new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
}

type Account = { id: string; client_id: string; external_id: string; auto_reply: boolean };

async function sendText(account: Account, token: string, to: string, text: string) {
  for (const part of chunks(text)) {
    const res = await fetch(`${GRAPH}/me/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ recipient: { id: to }, message: { text: part } }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = `Instagram respondió ${res.status}: ${JSON.stringify(data).slice(0, 300)}`;
      await logError(message, account.client_id);
      await db.from("social_accounts").update({ last_error: message.slice(0, 300) }).eq("id", account.id);
      throw new Error(message);
    }
    // Se apunta el mensaje propio para no confundir su eco con una persona escribiendo.
    if (data.message_id) await db.from("social_events").upsert({ mid: String(data.message_id) });
  }
}

// deno-lint-ignore no-explicit-any
async function handleMessage(account: Account, ev: any) {
  const msg = ev.message;
  if (!msg?.mid) return;
  const senderId = String(ev.sender?.id ?? "");
  const recipientId = String(ev.recipient?.id ?? "");

  // Eco de lo que se ha enviado desde la cuenta: si no lo envió el agente, una persona del
  // negocio ha tomado la conversación y el agente se calla.
  if (msg.is_echo || senderId === account.external_id) {
    await new Promise((r) => setTimeout(r, 4000)); // deja tiempo a apuntar los mensajes del propio agente
    const { data: known } = await db.from("social_events").select("mid").eq("mid", msg.mid).maybeSingle();
    if (known) return;
    await db.from("social_events").upsert({ mid: msg.mid });
    const vid = await visitorId(account.external_id, recipientId);
    await db.from("conversations").update({ handed_off: true })
      .eq("client_id", account.client_id).eq("channel", "instagram").eq("visitor_id", vid);
    return;
  }

  // Meta puede repetir un aviso: cada mensaje se procesa una sola vez.
  const { error: dup } = await db.from("social_events").insert({ mid: msg.mid });
  if (dup) return;
  if (!account.auto_reply) return;

  const { data: tok } = await db.from("social_tokens").select("access_token").eq("account_id", account.id).maybeSingle();
  if (!tok) return;
  const vid = await visitorId(account.external_id, senderId);

  const { data: last } = await db.from("conversations").select("id, handed_off, last_message_at")
    .eq("client_id", account.client_id).eq("channel", "instagram").eq("visitor_id", vid)
    .order("last_message_at", { ascending: false }).limit(1).maybeSingle();
  const recent = last && Date.now() - new Date(last.last_message_at).getTime() < CONVERSATION_HOURS * 3_600_000;
  if (recent && last.handed_off) return; // una persona lleva esta conversación

  const text = typeof msg.text === "string" ? msg.text.trim() : "";
  if (!text) {
    await sendText(account, tok.access_token, senderId, "Por aquí solo puedo leer mensajes de texto. ¿Me lo cuentas por escrito?");
    return;
  }

  const { data: client } = await db.from("clients").select("slug").eq("id", account.client_id).maybeSingle();
  if (!client) return;
  const res = await fetch(`${SUPABASE_URL}/functions/v1/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY },
    body: JSON.stringify({
      client: client.slug, visitor_id: vid, message: text.slice(0, MAX_INPUT),
      ...(recent ? { conversation_id: last!.id } : {}),
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.reply) {
    await logError(`chat respondió ${res.status}: ${JSON.stringify(data).slice(0, 300)}`, account.client_id);
    return;
  }
  // La función chat crea las conversaciones como «web»; aquí se marcan como Instagram.
  if (data.conversation_id) await db.from("conversations").update({ channel: "instagram" }).eq("id", data.conversation_id).eq("channel", "web");
  await sendText(account, tok.access_token, senderId, data.reply);
  await db.from("social_accounts").update({ last_error: null }).eq("id", account.id).not("last_error", "is", null);
}

async function webhook(req: Request) {
  const raw = await req.text();
  const signature = (req.headers.get("x-hub-signature-256") ?? "").replace(/^sha256=/, "");
  if (!APP_SECRET || !signature || !sameString(signature, await hmac(APP_SECRET, raw))) {
    return new Response("Forbidden", { status: 403 });
  }
  // deno-lint-ignore no-explicit-any
  let payload: any;
  try { payload = JSON.parse(raw); } catch { return new Response("Bad request", { status: 400 }); }

  const work = (async () => {
    for (const entry of payload.entry ?? []) {
      for (const ev of entry.messaging ?? []) {
        // El id de la entrada es el de la cuenta; si no coincide, se prueba con el resto.
        let account = null;
        for (const id of [entry.id, ev.recipient?.id, ev.sender?.id].map((v) => String(v ?? "")).filter(Boolean)) {
          const { data } = await db.from("social_accounts")
            .select("id, client_id, external_id, auto_reply").eq("platform", "instagram").eq("external_id", id).maybeSingle();
          if (data) { account = data; break; }
        }
        if (!account) continue;
        try {
          await handleMessage(account as Account, ev);
        } catch (err) {
          await logError(`mensaje: ${err instanceof Error ? err.message : err}`, account.client_id);
        }
      }
    }
  })();
  // Meta espera respuesta enseguida; el agente contesta en segundo plano.
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) EdgeRuntime.waitUntil(work);
  else await work;
  return new Response("EVENT_RECEIVED", { status: 200 });
}

// ---------------------------------------------------------------- mantenimiento
async function maintain() {
  const result = { refreshed: 0, errors: 0 };
  const { data: tokens } = await db.from("social_tokens").select("account_id, access_token, expires_at, refreshed_at")
    .lt("expires_at", new Date(Date.now() + REFRESH_DAYS * 86_400_000).toISOString())
    .lt("refreshed_at", new Date(Date.now() - 86_400_000).toISOString());
  for (const t of tokens ?? []) {
    const res = await fetch(`https://graph.instagram.com/refresh_access_token?${new URLSearchParams({
      grant_type: "ig_refresh_token", access_token: t.access_token,
    })}`);
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.access_token) {
      await db.from("social_tokens").update({
        access_token: data.access_token, refreshed_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + Number(data.expires_in ?? 5_184_000) * 1000).toISOString(),
      }).eq("account_id", t.account_id);
      result.refreshed++;
    } else {
      result.errors++;
      const { data: account } = await db.from("social_accounts").select("client_id, username").eq("id", t.account_id).maybeSingle();
      const message = `No se pudo renovar la conexión de Instagram${account?.username ? ` (@${account.username})` : ""}. Hay que volver a conectarla desde el panel.`;
      await db.from("social_accounts").update({ last_error: message }).eq("id", t.account_id);
      await logError(`${message} ${JSON.stringify(data).slice(0, 200)}`, account?.client_id ?? null);
    }
  }
  return result;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  try {
    if (req.method === "GET") {
      if (url.searchParams.has("hub.mode")) return verifyHook(url);
      if (url.searchParams.has("state")) return await callback(url);
      return new Response("Instagram · EBM", { status: 200 });
    }
    if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
    if (!action) return await webhook(req);
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    if (action === "connect") return await connect(req, body);
    if (action === "disconnect") return await disconnect(req, body);
    if (action === "toggle") return await toggle(req, body);
    if (action === "maintain") return json(APP_ID ? await maintain() : { skipped: "Instagram sin configurar" });
    return json({ error: "Acción desconocida" }, 400);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logError(`${action ?? "webhook"}: ${message}`);
    return json({ error: message }, 500);
  }
});
