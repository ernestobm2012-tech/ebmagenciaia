// Notificaciones push para la app instalable del panel.
//   GET  ?action=key           -> clave pública VAPID (la crea la primera vez)
//   POST ?action=subscribe     (usuario del panel) -> guarda este móvil
//   POST ?action=unsubscribe   (usuario del panel) -> lo quita
//   POST ?action=test          (usuario del panel) -> manda una prueba a sus móviles
//   POST ?action=send {kind,id} (la base de datos) -> avisa de un contacto, un paso
//                               a humano, un mensaje de la web, un error o una cita de la
//                               web de un negocio (cita / cita_anulada, desde la función reservas)
//   POST ?action=digest        (cron, cada tarde) -> resumen del día a los administradores
//   POST ?action=digest-test   (usuario del panel) -> manda el resumen de hoy solo a sus móviles
//   POST ?action=followups     (cron, cada 10 min) -> «toca volver a llamar»: push y correo a quien
//                               lleva el lead (o a todo el equipo del cliente si no lo lleva nadie)
//   POST ?action=assigned {lead_id, member_id} (la base de datos) -> aviso a la persona del
//                               equipo a la que se pasa un lead (correo y, si tiene panel, push)
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
const FROM = Deno.env.get("NOTIFY_FROM") ?? "EBM Agencia IA <info@ebmagenciaia.es>";

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
  if (!["lead", "handoff", "contact", "error", "cita", "cita_anulada"].includes(kind) || typeof id !== "string") return { error: "invalid_request" };
  if (kind === "cita" || kind === "cita_anulada") return await appointment(kind, id);
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

// Cita reservada (o anulada) por un cliente desde la web del negocio (función reservas).
// El aviso abre el panel propio del negocio si lo tiene (site_settings.data.admin_url).
async function appointment(kind: string, id: string) {
  const { data: ev } = await db.from("calendar_events")
    .select("id, client_id, title, starts_at, calendars(team_members(name))").eq("id", id).maybeSingle();
  if (!ev) return { skipped: "not_found" };
  const key = `${kind}:${id}`;
  const { data: prev } = await db.from("push_log").select("sent_at").eq("key", key).maybeSingle();
  if (prev) return { skipped: "duplicate" };
  await db.from("push_log").upsert({ key, sent_at: new Date().toISOString() });

  const [{ data: client }, { data: site }] = await Promise.all([
    db.from("clients").select("id, name, status, parent_client_id").eq("id", ev.client_id).maybeSingle(),
    db.from("site_settings").select("data").eq("client_id", ev.client_id).maybeSingle(),
  ]);
  const demo = client?.status === "demo" ? "[DEMO] " : "";
  const who = (ev.calendars as { team_members?: { name?: string } } | null)?.team_members?.name;
  const url = typeof site?.data?.admin_url === "string" ? site.data.admin_url : `${PANEL_URL}#/calendarios`;
  const payload: Payload = {
    title: `${demo}${kind === "cita" ? "Nueva cita" : "Cita anulada"}${client?.name ? ` · ${client.name}` : ""}`,
    body: short(`${timeFmt.format(new Date(ev.starts_at))}${who ? ` con ${who}` : ""} · ${ev.title}`, 140),
    url, tag: key,
  };
  return { sent: await deliver(await recipients(client), payload) };
}

// ---- Resumen diario: cuántas conversaciones, llamadas, contactos y avisos ha habido hoy.
const madridDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(new Date());
function madridMidnight() {
  const now = new Date();
  const asMadrid = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Madrid" })).getTime();
  const asUtc = new Date(now.toLocaleString("en-US", { timeZone: "UTC" })).getTime();
  return new Date(Date.parse(`${madridDay()}T00:00:00Z`) - (asMadrid - asUtc)).toISOString();
}
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

async function digestPayload(): Promise<Payload> {
  const since = madridMidnight();
  const [convs, leads, handoffs, contacts, errors, clients] = await Promise.all([
    db.from("conversations").select("client_id, channel").gte("started_at", since),
    db.from("leads").select("client_id").gte("created_at", since),
    db.from("handoffs").select("client_id").gte("created_at", since),
    db.from("contact_messages").select("id", { count: "exact", head: true }).gte("created_at", since),
    db.from("error_log").select("id", { count: "exact", head: true }).gte("created_at", since),
    db.from("clients").select("id, name"),
  ]);
  const name = new Map((clients.data ?? []).map((c) => [c.id as string, c.name as string]));
  const rows = convs.data ?? [];
  const calls = rows.filter((c) => c.channel === "phone").length;
  const chats = rows.length - calls;
  const nLeads = (leads.data ?? []).length;
  const nHand = (handoffs.data ?? []).length;
  const nContacts = contacts.count ?? 0;
  const nErrors = errors.count ?? 0;

  const parts: string[] = [];
  if (!rows.length && !nLeads && !nHand && !nContacts) {
    parts.push("Hoy ha sido un día tranquilo: sin llamadas, chats ni contactos nuevos.");
  } else {
    const bits = [plural(calls, "llamada", "llamadas"), plural(chats, "chat", "chats")];
    parts.push(bits.join(" y ") + ".");
    const todo = [] as string[];
    if (nLeads) todo.push(plural(nLeads, "contacto nuevo", "contactos nuevos"));
    if (nHand) todo.push(plural(nHand, "conversación pasada a una persona", "conversaciones pasadas a una persona"));
    if (nContacts) todo.push(plural(nContacts, "mensaje desde la web", "mensajes desde la web"));
    if (todo.length) parts.push("Por atender: " + todo.join(", ") + ".");
    // Desglose por cliente, los tres con más actividad.
    const per = new Map<string, number>();
    for (const c of rows) per.set(c.client_id, (per.get(c.client_id) ?? 0) + 1);
    const top = [...per.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([id, n]) => `${name.get(id) ?? "Cliente"}: ${n}`);
    if (top.length > 1) parts.push(top.join(" · "));
  }
  if (nErrors) parts.push(`Ojo: ${plural(nErrors, "error registrado", "errores registrados")}.`);
  const urgent = nLeads + nHand + nContacts > 0;
  return {
    title: urgent ? "Resumen de hoy: hay cosas por atender" : "Resumen de hoy",
    body: short(parts.join(" "), 220),
    url: `${PANEL_URL}#/actividad`,
    tag: `digest:${madridDay()}`,
  };
}

// ---- Volver a llamar: cuando llega la fecha que el equipo puso en el lead.
const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const timeFmt = new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

async function mail(to: string[], subject: string, html: string) {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key || !to.length) return false;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to, subject, html }),
  });
  return res.ok;
}

const card = (title: string, lead: { name?: string | null; contact?: string | null; reason?: string | null }, extra = "") =>
  `<div style="font-family:Lato,Arial,sans-serif;font-size:15px;line-height:1.5;color:#242F3D;max-width:560px">
<h2 style="font-size:19px;margin:0 0 12px">${esc(title)}</h2>
<p style="margin:0 0 6px"><b>Nombre:</b> ${esc(lead.name || "—")}</p>
<p style="margin:0 0 6px"><b>Contacto:</b> ${esc(lead.contact || "—")}</p>
<p style="margin:0 0 6px"><b>Motivo:</b> ${esc(lead.reason || "—")}</p>${extra}
<p style="margin:18px 0 0"><a href="${PANEL_URL}#/actividad" style="color:#1483DC">Abrir el contacto en el panel</a></p></div>`;

type Member = { id: string; name: string; role: string; email: string | null; profile_id: string | null; active: boolean };

// A quién avisar de un lead: la persona del equipo (su correo y, si tiene usuario, su móvil).
// En clientes demo, solo a administración.
async function memberTargets(client: { status: string } | null, member: Member | null) {
  if (client?.status === "demo") {
    const ids = await adminIds();
    const { data: people } = await db.from("profiles").select("email").in("id", ids);
    return { ids, emails: (people ?? []).map((p) => p.email).filter(Boolean) as string[] };
  }
  const ids = member?.profile_id ? [member.profile_id] : [];
  const emails = member?.email ? [member.email] : [];
  if (!member?.email && member?.profile_id) {
    const { data: p } = await db.from("profiles").select("email").eq("id", member.profile_id).maybeSingle();
    if (p?.email) emails.push(p.email);
  }
  return { ids, emails };
}

async function assigned(leadId: string, memberId: string) {
  const { data: lead } = await db.from("leads").select("id, client_id, name, contact, reason, follow_up_at").eq("id", leadId).maybeSingle();
  const { data: member } = await db.from("team_members").select("id, name, role, email, profile_id, active").eq("id", memberId).maybeSingle();
  if (!lead || !member || !member.active) return { skipped: true };
  const { data: client } = await db.from("clients").select("id, name, status").eq("id", lead.client_id).maybeSingle();
  const { ids, emails } = await memberTargets(client, member as Member);
  const demo = client?.status === "demo" ? `[DEMO · para ${member.name}] ` : "";
  const who = lead.name || lead.contact || "un contacto";
  const title = member.role === "comercial" ? `Te han pasado un contacto: ${who}` : `Tienes un contacto para llamar: ${who}`;
  const { data: subs } = ids.length
    ? await db.from("push_subscriptions").select("id, user_id, endpoint, p256dh, auth").in("user_id", ids)
    : { data: [] };
  const sent = await deliver((subs ?? []) as Sub[], {
    title: `${demo}${title}`, body: short(`${lead.contact ?? ""}${lead.reason ? ` · ${lead.reason}` : ""}`, 140),
    url: `${PANEL_URL}#/actividad`, tag: `assigned:${lead.id}:${member.id}`,
  });
  const extra = lead.follow_up_at ? `\n<p style="margin:0 0 6px"><b>Volver a llamar:</b> ${esc(timeFmt.format(new Date(lead.follow_up_at)))}</p>` : "";
  const mailed = await mail(emails, `${demo}${title}${client?.name ? ` · ${client.name}` : ""}`, card(`Hola, ${member.name.split(" ")[0]}. ${title}`, lead, extra));
  return { sent, mailed };
}

async function followups() {
  const { data } = await db.from("leads")
    .select("id, client_id, name, contact, reason, follow_up_at, followup_notified_at, assigned_to, caller_id")
    .lte("follow_up_at", new Date().toISOString())
    .not("status", "in", "(won,lost)")
    .limit(200);
  const due = (data ?? []).filter((r) => !r.followup_notified_at || Date.parse(r.followup_notified_at) < Date.parse(r.follow_up_at));
  let sent = 0, mailed = 0;
  for (const lead of due) {
    // Se marca antes de avisar: si algo falla, mejor un aviso de menos que repetirlo cada 10 minutos.
    await db.from("leads").update({ followup_notified_at: new Date().toISOString() }).eq("id", lead.id);
    const { data: client } = await db.from("clients").select("id, name, status, parent_client_id").eq("id", lead.client_id).maybeSingle();
    let ids: string[];
    let to: string[] = [];
    const { data: caller } = lead.caller_id
      ? await db.from("team_members").select("id, name, role, email, profile_id, active").eq("id", lead.caller_id).maybeSingle()
      : { data: null };
    if (client?.status === "demo") ids = await adminIds();
    else if (caller?.active && (caller.email || caller.profile_id)) {
      ({ ids, emails: to } = await memberTargets(client, caller as Member));
    } else if (lead.assigned_to) ids = [lead.assigned_to];
    else {
      const owners = [client?.id, client?.parent_client_id].filter(Boolean) as string[];
      const { data: team } = await db.from("profiles").select("id, role, client_id").in("role", ["client", "partner"]).in("client_id", owners);
      ids = (team ?? []).filter((p) => p.client_id === client?.id || p.role === "partner").map((p) => p.id);
      if (!ids.length) ids = await adminIds();
    }
    const demo = client?.status === "demo" ? "[DEMO] " : "";
    const who = lead.name || lead.contact || "un contacto";
    const { data: subs } = ids.length
      ? await db.from("push_subscriptions").select("id, user_id, endpoint, p256dh, auth").in("user_id", ids)
      : { data: [] };
    sent += await deliver((subs ?? []) as Sub[], {
      title: `${demo}Toca volver a llamar${client?.name ? ` · ${client.name}` : ""}`,
      body: short(`${who}${lead.contact && lead.name ? ` (${lead.contact})` : ""}${lead.reason ? `: ${lead.reason}` : ""}`, 140),
      url: `${PANEL_URL}#/actividad`, tag: `followup:${lead.id}`,
    });
    if (!to.length && ids.length) {
      const { data: people } = await db.from("profiles").select("email").in("id", ids);
      to = (people ?? []).map((p) => p.email).filter(Boolean) as string[];
    }
    const extra = `\n<p style="margin:0 0 6px"><b>Quedasteis en llamar:</b> ${esc(timeFmt.format(new Date(lead.follow_up_at)))}</p>`;
    if (await mail(to, `${demo}Toca volver a llamar: ${who}`, card(`Toca volver a llamar a ${who}`, lead, extra))) mailed++;
  }
  return { due: due.length, sent, mailed };
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
    if (action === "followups") return json(await followups());
    if (action === "assigned") return json(await assigned(String(body.lead_id ?? ""), String(body.member_id ?? "")));
    if (action === "digest") {
      // Solo por la tarde-noche (para que el resumen sea del día completo) y uno al día,
      // aunque el cron se dispare dos veces o alguien llame a la dirección.
      const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", hour: "2-digit", hourCycle: "h23" }).format(new Date()));
      if (hour < 20) return json({ skipped: "too_early" });
      const key = `digest:${madridDay()}`;
      const { data: prev } = await db.from("push_log").select("sent_at").eq("key", key).maybeSingle();
      if (prev) return json({ skipped: "duplicate" });
      await db.from("push_log").upsert({ key, sent_at: new Date().toISOString() });
      const subs = ((await db.from("push_subscriptions").select("id, user_id, endpoint, p256dh, auth").in("user_id", await adminIds())).data ?? []) as Sub[];
      return json({ sent: await deliver(subs, await digestPayload()) });
    }

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
    if (action === "digest-test") {
      const { data: me } = await db.from("profiles").select("role").eq("id", user.id).maybeSingle();
      if (me?.role !== "admin") return json({ error: "Solo administración." }, 403);
      const { data: subs } = await db.from("push_subscriptions").select("id, user_id, endpoint, p256dh, auth").eq("user_id", user.id);
      return json({ sent: await deliver((subs ?? []) as Sub[], await digestPayload()) });
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
