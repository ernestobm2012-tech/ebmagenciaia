// Notificaciones push para la app instalable del panel.
//   GET  ?action=key           -> clave pública VAPID (la crea la primera vez)
//   POST ?action=subscribe     (usuario del panel) -> guarda este móvil
//   POST ?action=unsubscribe   (usuario del panel) -> lo quita
//   POST ?action=test          (usuario del panel) -> manda una prueba a sus móviles
//   POST ?action=send {kind,id} (la base de datos) -> avisa de un contacto, un paso
//                               a humano, un mensaje de la web o un error
// Esta función nunca escribe en error_log: un fallo aquí no debe provocar más avisos.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const db = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const PANEL_URL = Deno.env.get("PANEL_URL") ?? "https://ebmagenciaia.es/admin/";
const CONTACT = "mailto:ernestobm2012@gmail.com";
const MAX_SUBSCRIPTIONS_PER_USER = 10;
const ERROR_COOLDOWN_MS = 30 * 60_000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

type Sub = { id: string; user_id: string; endpoint: string; p256dh: string; auth: string };
type Payload = { title: string; body: string; url: string; tag: string };

async function vapid() {
  const read = async () => (await db.from("push_config").select("public_key, private_key").eq("id", 1).maybeSingle()).data;
  let keys = await read();
  if (!keys) {
    const fresh = webpush.generateVAPIDKeys();
    await db.from("push_config").upsert(
      { id: 1, public_key: fresh.publicKey, private_key: fresh.privateKey },
      { onConflict: "id", ignoreDuplicates: true },
    );
    keys = await read();
  }
  return keys!;
}

async function deliver(subs: Sub[], payload: Payload) {
  if (!subs.length) return 0;
  const keys = await vapid();
  webpush.setVapidDetails(CONTACT, keys.public_key, keys.private_key);
  const text = JSON.stringify(payload);
  let sent = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, text, { TTL: 86_400, urgency: "high" });
      sent++;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      // El móvil ya no existe (app desinstalada o permiso retirado): se olvida.
      if (status === 404 || status === 410) await db.from("push_subscriptions").delete().eq("id", s.id);
    }
  }));
  return sent;
}

async function adminIds() {
  const { data } = await db.from("profiles").select("id").eq("role", "admin");
  return (data ?? []).map((p) => p.id as string);
}

// Quién debe enterarse: los administradores y, salvo en demos, las personas del cliente
// (y los partners de los que cuelga).
async function recipients(client: { id: string; status: string; parent_client_id: string | null } | null) {
  const ids = new Set(await adminIds());
  if (client && client.status !== "demo") {
    const owners = [client.id, client.parent_client_id].filter(Boolean) as string[];
    const { data } = await db.from("profiles").select("id, role, client_id").in("role", ["client", "partner"]).in("client_id", owners);
    for (const p of data ?? []) {
      if (p.client_id === client.id || p.role === "partner") ids.add(p.id);
    }
  }
  const { data: subs } = await db.from("push_subscriptions").select("id, user_id, endpoint, p256dh, auth").in("user_id", [...ids]);
  return (subs ?? []) as Sub[];
}

const short = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

async function send(kind: string, id: string) {
  if (!["lead", "handoff", "contact", "error"].includes(kind) || typeof id !== "string") return { error: "invalid_request" };
  const table = { lead: "leads", handoff: "handoffs", contact: "contact_messages", error: "error_log" }[kind]!;
  const { data: row } = await db.from(table).select("*").eq("id", id).maybeSingle();
  if (!row) return { skipped: "not_found" };

  // Un aviso por hecho; los errores, como mucho uno cada 30 minutos por origen.
  const key = kind === "error" ? `error:${row.source ?? "?"}` : `${kind}:${id}`;
  const { data: prev } = await db.from("push_log").select("sent_at").eq("key", key).maybeSingle();
  if (prev && (kind !== "error" || Date.now() - new Date(prev.sent_at).getTime() < ERROR_COOLDOWN_MS)) return { skipped: "duplicate" };
  await db.from("push_log").upsert({ key, sent_at: new Date().toISOString() });

  let client = null;
  if (row.client_id && kind !== "contact" && kind !== "error") {
    ({ data: client } = await db.from("clients").select("id, name, status, parent_client_id").eq("id", row.client_id).maybeSingle());
  }
  const demo = client?.status === "demo" ? "[DEMO] " : "";
  const where = client?.name ? ` · ${client.name}` : "";
  let payload: Payload;
  if (kind === "lead") {
    payload = { title: `${demo}Nuevo contacto${where}`, body: short(`${row.name ?? "Sin nombre"}: ${row.reason ?? row.contact ?? ""}`, 140), url: `${PANEL_URL}#/actividad`, tag: key };
  } else if (kind === "handoff") {
    payload = { title: `${demo}Hay que atender a alguien${where}`, body: short(row.reason ?? "Una conversación necesita a una persona.", 140), url: `${PANEL_URL}#/actividad`, tag: key };
  } else if (kind === "contact") {
    payload = { title: "Nuevo mensaje de la web", body: short(`${row.name ?? ""}: ${row.message ?? ""}`, 140), url: `${PANEL_URL}#/contactos`, tag: key };
  } else {
    payload = { title: `Algo falla: ${short(row.source, 40) || "sistema"}`, body: short(row.message, 140), url: PANEL_URL, tag: key };
  }

  // Contactos de la web y errores son solo para administración.
  const subs = kind === "contact" || kind === "error"
    ? ((await db.from("push_subscriptions").select("id, user_id, endpoint, p256dh, auth").in("user_id", await adminIds())).data ?? []) as Sub[]
    : await recipients(client);
  return { sent: await deliver(subs, payload) };
}

async function currentUser(req: Request) {
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data } = await db.auth.getUser(jwt);
  return data.user ?? null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const action = new URL(req.url).searchParams.get("action");
  try {
    if (req.method === "GET" && action === "key") return json({ key: (await vapid()).public_key });
    if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
    const body = await req.json().catch(() => ({})) as Record<string, any>;

    if (action === "send") return json(await send(body.kind, body.id));

    const user = await currentUser(req);
    if (!user) return json({ error: "Tienes que entrar en el panel." }, 401);

    if (action === "subscribe") {
      const s = body.subscription;
      if (typeof s?.endpoint !== "string" || !s.endpoint.startsWith("https://") || typeof s?.keys?.p256dh !== "string" || typeof s?.keys?.auth !== "string") {
        return json({ error: "Suscripción no válida." }, 400);
      }
      const { count } = await db.from("push_subscriptions").select("id", { count: "exact", head: true }).eq("user_id", user.id);
      if ((count ?? 0) >= MAX_SUBSCRIPTIONS_PER_USER) return json({ error: "Demasiados dispositivos. Quita alguno primero." }, 400);
      await db.from("push_subscriptions").upsert({
        user_id: user.id, endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth,
        user_agent: String(req.headers.get("user-agent") ?? "").slice(0, 300),
      }, { onConflict: "endpoint" });
      return json({ ok: true });
    }
    if (action === "unsubscribe") {
      await db.from("push_subscriptions").delete().eq("user_id", user.id).eq("endpoint", String(body.endpoint ?? ""));
      return json({ ok: true });
    }
    if (action === "test") {
      const { data: subs } = await db.from("push_subscriptions").select("id, user_id, endpoint, p256dh, auth").eq("user_id", user.id);
      const sent = await deliver((subs ?? []) as Sub[], {
        title: "Avisos activados", body: "Así te llegarán los avisos del panel.", url: PANEL_URL, tag: "prueba",
      });
      return json({ sent });
    }
    return json({ error: "Acción desconocida" }, 400);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
