// Correos a las clientas de los negocios con reservas (primero, Henko Peluquería).
// Salen con Resend desde reservas@ebmagenciaia.es con el nombre del negocio y la
// respuesta va al correo del negocio. Cada envío queda en message_log (así no se repite).
//   POST { action: "confirm", event_id }        -> confirmación al reservar (la llama reservas)
//   POST { action: "waitlist", client_id, day } -> «se ha liberado un hueco» (trigger al borrar una cita)
//   POST { action: "gift", gift_id }             -> tarjeta regalo reservada en la web (se paga en el salón)
//   POST ?action=cron                            -> cada hora: recordatorio del día antes, petición de
//                                                   reseña, «te echamos de menos» y cumpleaños
// Lo que se manda se decide en site_settings.data.messages del negocio:
//   { reminder, review, comeback, comeback_weeks, comeback_coupon, birthday, birthday_coupon }
// Las ofertas (comeback y cumpleaños) solo van a quien marcó customers.marketing_ok y
// todas llevan enlace de baja (baja.html?t=<unsub_token> en la web del negocio).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const FROM_ADDRESS = "reservas@ebmagenciaia.es";
const BATCH = 40;   // correos de cada tipo por pasada

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const isUuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);
const first = (name: string) => (name || "").trim().split(/\s+/)[0] || "";

const madrid = (d: Date, opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", ...opts }).format(d);
const whenEs = (d: Date) => madrid(d, { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
const madridDay = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(d);
const madridHour = () => +new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", hour: "2-digit", hourCycle: "h23" }).format(new Date());
const addDays = (day: string, n: number) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const dayLong = (day: string) =>
  new Intl.DateTimeFormat("es-ES", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`));

type Settings = Record<string, any>;
type Business = { id: string; name: string; settings: Settings };

async function business(clientId: string): Promise<Business | null> {
  const [{ data: c }, { data: s }] = await Promise.all([
    db.from("clients").select("id, name").eq("id", clientId).maybeSingle(),
    db.from("site_settings").select("data").eq("client_id", clientId).maybeSingle(),
  ]);
  if (!c) return null;
  return { id: c.id, name: c.name, settings: (s?.data ?? {}) as Settings };
}
const siteUrl = (b: Business) => {
  const u = String(b.settings.site_url || "");
  return u ? (u.endsWith("/") ? u : `${u}/`) : "";
};
const brandName = (b: Business) => String(b.settings.brand_name || b.settings.name || b.name);
const enabled = (b: Business, key: string) => b.settings.messages?.[key] !== false;

// ---- Plantilla: sobria, con los colores del negocio.
function layout(b: Business, o: { title: string; body: string; button?: { text: string; href: string }; unsub?: string }) {
  const s = b.settings, ink = s.brand_color || "#684C33", bg = s.brand_bg || "#F1ECE8";
  const contact = [s.address, s.phone && `Tel. ${String(s.phone).replace(/(\d{3})(\d{3})(\d{3})/, "$1 $2 $3")}`].filter(Boolean).join(" · ");
  return `<!doctype html><html lang="es"><body style="margin:0;background:${bg};padding:24px 12px">
<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;font-family:Helvetica,Arial,sans-serif;color:#242424">
  <div style="padding:26px 28px 6px;text-align:center">
    <div style="font-family:Georgia,'Times New Roman',serif;font-style:italic;font-size:30px;color:${ink}">${esc(brandName(b))}</div>
    ${s.tagline ? `<div style="font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#8a7d75;margin-top:4px">${esc(s.tagline)}</div>` : ""}
  </div>
  <div style="padding:14px 28px 26px;font-size:15px;line-height:1.6">
    <h1 style="font-family:Georgia,'Times New Roman',serif;font-weight:normal;font-size:23px;margin:10px 0 14px;color:#242424">${esc(o.title)}</h1>
    ${o.body}
    ${o.button ? `<p style="text-align:center;margin:26px 0 8px"><a href="${esc(o.button.href)}" style="background:${ink};color:#fff;text-decoration:none;padding:13px 26px;border-radius:999px;display:inline-block;font-size:15px">${esc(o.button.text)}</a></p>` : ""}
  </div>
  <div style="border-top:1px solid #eee;padding:16px 28px;font-size:12px;color:#8a7d75;text-align:center;line-height:1.5">
    ${esc(contact)}${o.unsub ? `<br><a href="${esc(o.unsub)}" style="color:#8a7d75">No quiero recibir más ofertas</a>` : ""}
  </div>
</div></body></html>`;
}

async function send(b: Business, log: { customer_id?: string | null; event_id?: string | null; kind: string },
  to: string, subject: string, html: string) {
  // Reserva el envío antes de mandarlo: si otra pasada ya lo hizo, el índice único lo frena.
  const { data: row, error } = await db.from("message_log")
    .insert({ client_id: b.id, customer_id: log.customer_id ?? null, event_id: log.event_id ?? null, kind: log.kind, to_email: to })
    .select("id").single();
  if (error) return false;
  const key = Deno.env.get("RESEND_API_KEY");
  let ok = false, err = "";
  if (!key) err = "Falta RESEND_API_KEY";
  else {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `${brandName(b)} <${FROM_ADDRESS}>`, to: [to], subject, html,
        ...(b.settings.email ? { reply_to: b.settings.email } : {}),
      }),
    });
    ok = res.ok;
    if (!ok) err = (await res.text()).slice(0, 300);
  }
  if (!ok) await db.from("message_log").update({ ok: false, error: err }).eq("id", row.id);
  return ok;
}

const okEmail = (e: unknown): e is string => typeof e === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

type Ev = {
  id: string; client_id: string; starts_at: string; ends_at: string; manage_token: string | null;
  discount_eur: number | null; customer_id: string | null;
  customers: { name: string; email: string | null; unsub_token: string } | null;
  services: { name: string } | null;
  calendars: { team_members: { name: string } | null } | null;
  coupons: { code: string; kind: string; value: number } | null;
};
const EV_FIELDS = "id, client_id, starts_at, ends_at, manage_token, discount_eur, customer_id, customers(name, email, unsub_token), services(name), calendars(team_members(name)), coupons(code, kind, value)";

const couponText = (c: { kind: string; value: number }) =>
  c.kind === "percent" ? `${Number(c.value).toLocaleString("es-ES")} % de descuento` : `${Number(c.value).toLocaleString("es-ES")} € de descuento`;

function appointmentBlock(ev: Ev) {
  const who = ev.calendars?.team_members?.name;
  return `<table style="width:100%;border-collapse:collapse;background:#faf7f5;border-radius:10px;margin:6px 0 4px"><tr><td style="padding:14px 16px;font-size:15px;line-height:1.7">
    <b>${esc(ev.services?.name || "Tu cita")}</b><br>
    ${esc(whenEs(new Date(ev.starts_at)))}${who ? `<br>Con ${esc(who)}` : ""}
    ${ev.coupons ? `<br>Cupón ${esc(ev.coupons.code)}: ${esc(couponText(ev.coupons))}` : ""}
  </td></tr></table>`;
}

// ---- Confirmación al reservar
async function confirm(eventId: unknown) {
  if (!isUuid(eventId)) return json({ error: "Falta la cita" }, 400);
  const { data } = await db.from("calendar_events").select(EV_FIELDS).eq("id", eventId).maybeSingle();
  const ev = data as Ev | null;
  if (!ev || !okEmail(ev.customers?.email)) return json({ ok: true, sent: false });
  const b = await business(ev.client_id);
  if (!b) return json({ ok: true, sent: false });
  const site = siteUrl(b);
  const sent = await send(b, { customer_id: ev.customer_id, event_id: ev.id, kind: "confirm" }, ev.customers!.email!,
    `Tu cita en ${brandName(b)}: ${madrid(new Date(ev.starts_at), { weekday: "long", day: "numeric", month: "long" })}`,
    layout(b, {
      title: `¡Te esperamos, ${first(ev.customers!.name)}!`,
      body: `<p style="margin:0 0 10px">Tu cita queda apuntada:</p>${appointmentBlock(ev)}
        <p style="margin:14px 0 0">Si te surge algo, puedes verla o anularla desde el enlace. Y si necesitas cambiarla, contesta a este correo o escríbenos por WhatsApp.</p>`,
      button: site && ev.manage_token ? { text: "Ver o anular mi cita", href: `${site}cita.html?t=${ev.manage_token}` } : undefined,
    }));
  return json({ ok: true, sent });
}

// ---- Lista de espera: se liberó un hueco ese día
async function waitlist(clientId: unknown, day: unknown) {
  if (!isUuid(clientId) || typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return json({ error: "Datos" }, 400);
  if (day < madridDay()) return json({ ok: true, sent: 0 });
  const b = await business(clientId);
  if (!b) return json({ ok: true, sent: 0 });
  const { data: rows } = await db.from("waitlist").select("id, name, email, service_id, services(name)")
    .eq("client_id", clientId).eq("day", day).is("notified_at", null).limit(BATCH);
  const site = siteUrl(b);
  let sent = 0;
  for (const w of (rows ?? []) as any[]) {
    await db.from("waitlist").update({ notified_at: new Date().toISOString() }).eq("id", w.id);
    if (!okEmail(w.email)) continue;
    const link = site ? `${site}#reservar${w.service_id ? `?servicio=${w.service_id}` : ""}` : "";
    if (await send(b, { kind: "waitlist" }, w.email, `Se ha liberado un hueco el ${dayLong(day)}`,
      layout(b, {
        title: `${first(w.name)}, ¡hay un hueco!`,
        body: `<p style="margin:0 0 10px">Nos pediste que te avisáramos si quedaba algo libre el <b>${esc(dayLong(day))}</b>${w.services?.name ? ` para <b>${esc(w.services.name)}</b>` : ""}. Acaba de liberarse una hora.</p>
          <p style="margin:0">Hemos avisado a todas las personas que esperaban ese día, así que el primero que reserve se lo queda.</p>`,
        button: link ? { text: "Reservar ahora", href: link } : undefined,
      }))) sent++;
  }
  return json({ ok: true, sent });
}

// ---- Tarjeta regalo reservada: se paga y se recoge en el salón
async function gift(giftId: unknown) {
  if (!isUuid(giftId)) return json({ error: "Falta la tarjeta" }, 400);
  const { data: g } = await db.from("gift_cards").select("id, client_id, code, amount, buyer_name, buyer_email, recipient_name").eq("id", giftId).maybeSingle();
  if (!g || !okEmail(g.buyer_email)) return json({ ok: true, sent: false });
  const b = await business(g.client_id);
  if (!b) return json({ ok: true, sent: false });
  const amount = `${Number(g.amount).toLocaleString("es-ES")} €`;
  const sent = await send(b, { event_id: g.id, kind: "gift" }, g.buyer_email,
    `Tu tarjeta regalo de ${brandName(b)} (${amount}) está reservada`,
    layout(b, {
      title: `¡Qué buen regalo, ${first(g.buyer_name)}!`,
      body: `<p style="margin:0 0 10px">Hemos reservado tu tarjeta regalo${g.recipient_name ? ` para <b>${esc(g.recipient_name)}</b>` : ""} de <b>${esc(amount)}</b>.</p>
        <p style="text-align:center;margin:12px 0"><span style="display:inline-block;border:2px dashed ${esc(b.settings.brand_color || "#684C33")};padding:8px 18px;border-radius:8px;font-size:20px;letter-spacing:.12em"><b>${esc(g.code)}</b></span></p>
        <p style="margin:0 0 10px">Pásate por el salón cuando te venga bien para pagarla y te la damos preparada. Solo tienes que decirnos tu nombre o este código.</p>
        ${b.settings.address ? `<p style="margin:0">Estamos en ${esc(b.settings.address)}.</p>` : ""}`,
    }));
  return json({ ok: true, sent });
}

// ---- Cada hora
async function cron() {
  const { data: list } = await db.from("site_settings").select("client_id, data");
  const hour = madridHour();
  const out: Record<string, number> = { reminder: 0, review: 0, comeback: 0, birthday: 0 };
  for (const row of list ?? []) {
    if (!row.data?.messages) continue;   // solo negocios que lo tienen activado
    const b = await business(row.client_id);
    if (!b) continue;
    if (hour >= 10 && hour < 21 && enabled(b, "reminder")) out.reminder += await reminders(b);
    if (hour >= 10 && hour < 21 && enabled(b, "review")) out.review += await reviews(b);
    if (hour === 11 && enabled(b, "comeback")) out.comeback += await comebacks(b);
    if (hour === 10 && enabled(b, "birthday")) out.birthday += await birthdays(b);
  }
  return json({ ok: true, ...out });
}

async function alreadySent(eventIds: string[], kind: string) {
  if (!eventIds.length) return new Set<string>();
  const { data } = await db.from("message_log").select("event_id").eq("kind", kind).eq("ok", true).in("event_id", eventIds);
  return new Set((data ?? []).map((r) => r.event_id));
}

// Recordatorio: citas de mañana (desde las 10:00 del día antes), si se reservaron hace más de 3 h.
async function reminders(b: Business) {
  const tomorrow = addDays(madridDay(), 1);
  const from = new Date(`${tomorrow}T00:00:00Z`).getTime() - 3 * 3_600_000;   // margen por la zona horaria
  const { data } = await db.from("calendar_events").select(EV_FIELDS)
    .eq("client_id", b.id).not("customer_id", "is", null)
    .gte("starts_at", new Date(from).toISOString()).lt("starts_at", new Date(from + 30 * 3_600_000).toISOString())
    .lt("created_at", new Date(Date.now() - 3 * 3_600_000).toISOString()).limit(200);
  const evs = ((data ?? []) as Ev[]).filter((e) => madridDay(new Date(e.starts_at)) === tomorrow && okEmail(e.customers?.email));
  const done = await alreadySent(evs.map((e) => e.id), "reminder");
  const site = siteUrl(b);
  let n = 0;
  for (const ev of evs.filter((e) => !done.has(e.id)).slice(0, BATCH)) {
    if (await send(b, { customer_id: ev.customer_id, event_id: ev.id, kind: "reminder" }, ev.customers!.email!,
      `Mañana te esperamos en ${brandName(b)} a las ${madrid(new Date(ev.starts_at), { hour: "2-digit", minute: "2-digit" })}`,
      layout(b, {
        title: `Hasta mañana, ${first(ev.customers!.name)}`,
        body: `<p style="margin:0 0 10px">Te recordamos tu cita:</p>${appointmentBlock(ev)}
          ${b.settings.address ? `<p style="margin:14px 0 0">Estamos en ${esc(b.settings.address)}.</p>` : ""}
          <p style="margin:10px 0 0">Si no puedes venir, avísanos para que otra persona pueda aprovechar la hora. ¡Gracias!</p>`,
        button: site && ev.manage_token ? { text: "Ver o anular mi cita", href: `${site}cita.html?t=${ev.manage_token}` } : undefined,
      }))) n++;
  }
  return n;
}

// Reseña: entre 2 y 26 h después de la cita, una vez cada 90 días por clienta.
async function reviews(b: Business) {
  const url = b.settings.review_url ||
    (b.settings.maps_query ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(b.settings.maps_query)}` : "");
  if (!url) return 0;
  const { data } = await db.from("calendar_events").select(EV_FIELDS)
    .eq("client_id", b.id).eq("no_show", false).not("customer_id", "is", null)
    .gte("ends_at", new Date(Date.now() - 26 * 3_600_000).toISOString()).lte("ends_at", new Date(Date.now() - 2 * 3_600_000).toISOString())
    .limit(200);
  const evs = ((data ?? []) as Ev[]).filter((e) => okEmail(e.customers?.email));
  if (!evs.length) return 0;
  const { data: recent } = await db.from("message_log").select("customer_id, event_id").eq("client_id", b.id).eq("kind", "review").eq("ok", true)
    .gte("created_at", new Date(Date.now() - 90 * 86_400_000).toISOString());
  const skip = new Set((recent ?? []).flatMap((r) => [r.customer_id, r.event_id]));
  let n = 0;
  const seen = new Set<string>();
  for (const ev of evs) {
    if (n >= BATCH || skip.has(ev.id) || skip.has(ev.customer_id) || seen.has(ev.customer_id!)) continue;
    seen.add(ev.customer_id!);
    if (await send(b, { customer_id: ev.customer_id, event_id: ev.id, kind: "review" }, ev.customers!.email!,
      `¿Qué tal ayer en ${brandName(b)}?`,
      layout(b, {
        title: `Gracias por venir, ${first(ev.customers!.name)}`,
        body: `<p style="margin:0 0 10px">Esperamos que te fueras encantada con tu ${esc((ev.services?.name || "visita").toLowerCase())}.</p>
          <p style="margin:0">Si te ha gustado, nos ayudas muchísimo dejando tu opinión en Google. Solo es un minuto y así más gente del pueblo nos conoce.</p>`,
        button: { text: "Dejar mi opinión", href: url },
      }))) n++;
  }
  return n;
}

async function couponLine(b: Business, code: unknown) {
  if (typeof code !== "string" || !code) return null;
  const today = madridDay();
  const { data } = await db.from("coupons").select("code, kind, value, valid_from, valid_until, active")
    .eq("client_id", b.id).eq("code", code.toUpperCase()).maybeSingle();
  if (!data?.active || (data.valid_from && data.valid_from > today) || (data.valid_until && data.valid_until < today)) return null;
  return data;
}

// «Te echamos de menos»: clientas con permiso que llevan N semanas sin venir y sin cita a la vista.
async function comebacks(b: Business) {
  const weeks = Number(b.settings.messages?.comeback_weeks) || 7;
  const { data: people } = await db.from("customers").select("id, name, email, unsub_token")
    .eq("client_id", b.id).eq("marketing_ok", true).not("email", "is", null).limit(2000);
  if (!people?.length) return 0;
  const ids = people.map((p) => p.id);
  const { data: evs } = await db.from("calendar_events").select("customer_id, ends_at").in("customer_id", ids).eq("no_show", false);
  const last = new Map<string, number>(), future = new Set<string>();
  for (const e of evs ?? []) {
    const t = new Date(e.ends_at).getTime();
    if (t > Date.now()) future.add(e.customer_id);
    else last.set(e.customer_id, Math.max(last.get(e.customer_id) ?? 0, t));
  }
  const { data: recent } = await db.from("message_log").select("customer_id").eq("client_id", b.id).eq("kind", "comeback")
    .gte("created_at", new Date(Date.now() - 60 * 86_400_000).toISOString());
  const skip = new Set((recent ?? []).map((r) => r.customer_id));
  const limit = Date.now() - weeks * 7 * 86_400_000;
  const coupon = await couponLine(b, b.settings.messages?.comeback_coupon);
  const site = siteUrl(b);
  let n = 0;
  for (const p of people) {
    if (n >= BATCH) break;
    const l = last.get(p.id);
    if (!l || l > limit || future.has(p.id) || skip.has(p.id) || !okEmail(p.email)) continue;
    if (await send(b, { customer_id: p.id, kind: "comeback" }, p.email,
      coupon ? `${first(p.name)}, te guardamos un ${couponText(coupon).replace(" de descuento", "")} de descuento` : `${first(p.name)}, ¿te hacemos hueco?`,
      layout(b, {
        title: `Te echamos de menos, ${first(p.name)}`,
        body: `<p style="margin:0 0 10px">Hace unas semanas que no te vemos por el salón. Cuando te apetezca darte un capricho, aquí estamos.</p>
          ${coupon ? `<p style="margin:0 0 10px">Para tu próxima cita tienes <b>${esc(couponText(coupon))}</b> con el código:</p>
          <p style="text-align:center;margin:12px 0"><span style="display:inline-block;border:2px dashed ${esc(b.settings.brand_color || "#684C33")};padding:8px 18px;border-radius:8px;font-size:20px;letter-spacing:.12em"><b>${esc(coupon.code)}</b></span></p>
          <p style="margin:0;font-size:13px;color:#8a7d75">Escríbelo al reservar en la web${coupon.valid_until ? `. Vale hasta el ${esc(dayLong(coupon.valid_until))}` : ""}.</p>` : ""}`,
        button: site ? { text: "Pedir cita", href: `${site}#reservar` } : undefined,
        unsub: site ? `${site}baja.html?t=${p.unsub_token}` : undefined,
      }))) n++;
  }
  return n;
}

// Cumpleaños (solo con permiso para ofertas), una vez al año.
async function birthdays(b: Business) {
  const today = madridDay(), md = today.slice(5);
  const { data: people } = await db.from("customers").select("id, name, email, birthday, unsub_token")
    .eq("client_id", b.id).eq("marketing_ok", true).not("birthday", "is", null).not("email", "is", null).limit(5000);
  const list = (people ?? []).filter((p) => String(p.birthday).slice(5) === md && okEmail(p.email));
  if (!list.length) return 0;
  const { data: recent } = await db.from("message_log").select("customer_id").eq("client_id", b.id).eq("kind", "birthday")
    .gte("created_at", new Date(Date.now() - 300 * 86_400_000).toISOString());
  const skip = new Set((recent ?? []).map((r) => r.customer_id));
  const coupon = await couponLine(b, b.settings.messages?.birthday_coupon);
  const site = siteUrl(b);
  let n = 0;
  for (const p of list) {
    if (n >= BATCH || skip.has(p.id)) continue;
    if (await send(b, { customer_id: p.id, kind: "birthday" }, p.email, `¡Feliz cumpleaños, ${first(p.name)}!`,
      layout(b, {
        title: `¡Feliz cumpleaños, ${first(p.name)}!`,
        body: `<p style="margin:0 0 10px">Desde ${esc(brandName(b))} te deseamos un día precioso.</p>
          ${coupon ? `<p style="margin:0 0 10px">Y como regalo, en tu próxima cita tienes <b>${esc(couponText(coupon))}</b> con el código:</p>
          <p style="text-align:center;margin:12px 0"><span style="display:inline-block;border:2px dashed ${esc(b.settings.brand_color || "#684C33")};padding:8px 18px;border-radius:8px;font-size:20px;letter-spacing:.12em"><b>${esc(coupon.code)}</b></span></p>` : ""}`,
        button: site ? { text: "Pedir cita", href: `${site}#reservar` } : undefined,
        unsub: site ? `${site}baja.html?t=${p.unsub_token}` : undefined,
      }))) n++;
  }
  return n;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  const action = new URL(req.url).searchParams.get("action");
  let body: Record<string, unknown> = {};
  try { body = JSON.parse((await req.text()) || "{}"); } catch { /* vacío */ }
  try {
    const a = action || body.action;
    if (a === "confirm") return await confirm(body.event_id);
    if (a === "waitlist") return await waitlist(body.client_id, body.day);
    if (a === "gift") return await gift(body.gift_id);
    if (a === "cron") return await cron();
    return json({ error: "Acción no válida" }, 400);
  } catch (err) {
    console.error(err);
    await db.from("error_log").insert({ source: "citas-mensajes", message: String((err as Error)?.message ?? err).slice(0, 500) });
    return json({ error: "Error" }, 500);
  }
});
