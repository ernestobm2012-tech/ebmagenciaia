// Reservas desde la web pública de un negocio (Henko Peluquería y las que vengan).
// Es pública (la llama la web), así que valida todo y frena abusos con una huella diaria.
//   POST { action: "info",    client: "<slug>" }
//        -> textos de la web, servicios, equipo, fotos y vídeos
//   POST { action: "slots",   client, service_id, member_id?, from: "AAAA-MM-DD", days? }
//        -> horas libres de cada día y quién puede a esa hora
//   POST { action: "book",    client, service_id, member_id?, date, time, name, phone, email?, notes? }
//        -> crea la cita en el calendario de la persona (o de quien esté libre)
//   POST { action: "booking", token }  -> datos de una cita (enlace del cliente)
//   POST { action: "cancel",  token }  -> la anula si aún hay tiempo
// Cada persona del equipo reserva en su calendario (calendars.member_id) con su horario
// (booking_hours) y su antelación mínima (booking_notice_minutes).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const db = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const STEP_MINUTES = 15;           // las horas de inicio van de 15 en 15
const MAX_DAYS_PER_QUERY = 14;
const DEFAULT_DAYS_AHEAD = 60;     // hasta cuándo se puede reservar (site_settings.data.booking_days_ahead)
const DEFAULT_CANCEL_HOURS = 2;    // hasta cuántas horas antes se puede anular (data.cancel_hours)
const MAX_ATTEMPTS_PER_DAY = 8;    // reservas por persona y día desde la web

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const fail = (message: string, status = 400) => json({ error: message }, status);
const isUuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);
const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const clean = (v: unknown, n: number) => typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "";
const mediaUrl = (path: string) => `${SUPABASE_URL}/storage/v1/object/public/site-media/${path}`;

type Calendar = {
  id: string; member_id: string; booking_hours: Record<string, string[]>;
  booking_notice_minutes: number; booking_type_id: string | null;
};
type Service = {
  id: string; name: string; price_eur: number | null; duration_minutes: number;
  member_ids: string[]; bookable: boolean;
};
type Busy = { calendar_id: string; starts_at: string; ends_at: string };

// ---- Horas de Madrid (con el cambio de hora bien), como en la función chat.
function madridAt(day: string, hhmm: string) {
  const [y, m, d] = day.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, h, mi);
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const offset = (t: number) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - t;
  };
  let t = wall - offset(wall);
  t = wall - offset(t);
  return new Date(t);
}
const madridToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(new Date());
const addDays = (day: string, n: number) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const whenEs = (d: Date) => new Intl.DateTimeFormat("es-ES", {
  timeZone: "Europe/Madrid", weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit",
}).format(d);

// Horas de inicio libres de un día en un calendario para un servicio de cierta duración.
function freeStarts(cal: Calendar, day: string, minutes: number, busy: Busy[]) {
  const [y, m, d] = day.split("-").map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7;
  const earliest = Date.now() + cal.booking_notice_minutes * 60_000;
  const out: string[] = [];
  for (const range of cal.booking_hours?.[String(weekday)] ?? []) {
    const match = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(range.replace(/\s/g, ""));
    if (!match) continue;
    const open = +match[1] * 60 + +match[2];
    const close = +match[3] * 60 + +match[4];
    for (let t = open; t + minutes <= close; t += STEP_MINUTES) {
      const start = madridAt(day, hhmm(t));
      const end = new Date(start.getTime() + minutes * 60_000);
      if (start.getTime() < earliest) continue;
      if (busy.some((e) => e.calendar_id === cal.id && new Date(e.starts_at) < end && new Date(e.ends_at) > start)) continue;
      out.push(hhmm(t));
    }
  }
  return out;
}

async function hmac(data: string) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function loadClient(slug: unknown) {
  if (typeof slug !== "string" || !/^[a-z0-9-]{2,60}$/.test(slug)) return null;
  const { data } = await db.from("clients").select("id, name, status").eq("slug", slug).maybeSingle();
  return data;
}

async function settingsOf(clientId: string) {
  const { data } = await db.from("site_settings").select("data").eq("client_id", clientId).maybeSingle();
  return (data?.data ?? {}) as Record<string, unknown>;
}

// Personas que reservan: activas, visibles en la web y con un calendario que acepta reservas.
async function bookableTeam(clientId: string) {
  const [{ data: members }, { data: calendars }] = await Promise.all([
    db.from("team_members").select("id, name, job_title, bio, photo_url, sort")
      .eq("client_id", clientId).eq("active", true).eq("show_on_web", true).order("sort").order("name"),
    db.from("calendars").select("id, member_id, booking_hours, booking_notice_minutes, booking_type_id")
      .eq("client_id", clientId).eq("active", true).eq("booking_enabled", true).not("member_id", "is", null),
  ]);
  const byMember = new Map<string, Calendar>();
  for (const c of (calendars ?? []) as Calendar[]) if (!byMember.has(c.member_id)) byMember.set(c.member_id, c);
  return { members: members ?? [], byMember };
}

async function loadService(clientId: string, id: unknown) {
  if (!isUuid(id)) return null;
  const { data } = await db.from("services").select("id, name, price_eur, duration_minutes, member_ids, bookable")
    .eq("client_id", clientId).eq("id", id).eq("active", true).maybeSingle();
  return data as Service | null;
}

// Calendarios que pueden hacer este servicio (de una persona concreta o de todo el equipo).
function candidates(service: Service, byMember: Map<string, Calendar>, memberId: unknown) {
  const can = (id: string) => !service.member_ids?.length || service.member_ids.includes(id);
  if (isUuid(memberId)) {
    const cal = byMember.get(memberId);
    return cal && can(memberId) ? [cal] : [];
  }
  return [...byMember.entries()].filter(([id]) => can(id)).map(([, c]) => c);
}

async function busyBetween(calendarIds: string[], from: Date, to: Date) {
  if (!calendarIds.length) return [] as Busy[];
  const { data, error } = await db.from("calendar_events").select("calendar_id, starts_at, ends_at")
    .in("calendar_id", calendarIds).lt("starts_at", to.toISOString()).gt("ends_at", from.toISOString()).limit(5000);
  if (error) throw error;
  return (data ?? []) as Busy[];
}

async function info(clientId: string) {
  const [settings, { data: services }, team, { data: media }] = await Promise.all([
    settingsOf(clientId),
    db.from("services").select("id, name, category, description, price_eur, price_from, duration_minutes, member_ids, bookable")
      .eq("client_id", clientId).eq("active", true).order("sort").order("name"),
    bookableTeam(clientId),
    db.from("site_media").select("id, kind, storage_path, youtube_id, title, category")
      .eq("client_id", clientId).eq("published", true).order("sort").order("created_at", { ascending: false }),
  ]);
  return {
    settings,
    services: services ?? [],
    team: team.members.map((m) => ({ ...m, bookable: team.byMember.has(m.id) })),
    media: (media ?? []).map((m) => ({
      id: m.id, kind: m.kind, title: m.title, category: m.category,
      ...(m.kind === "photo" ? { url: mediaUrl(m.storage_path!) } : { youtube_id: m.youtube_id }),
    })),
  };
}

async function slots(clientId: string, body: Record<string, unknown>) {
  const service = await loadService(clientId, body.service_id);
  if (!service || !service.bookable) return fail("Ese servicio no se puede reservar en la web.");
  const settings = await settingsOf(clientId);
  const today = madridToday();
  const last = addDays(today, Number(settings.booking_days_ahead) || DEFAULT_DAYS_AHEAD);
  const from = isDay(body.from) && body.from > today ? body.from : today;
  const days = Math.min(Math.max(Number(body.days) || 7, 1), MAX_DAYS_PER_QUERY);
  const team = await bookableTeam(clientId);
  const cals = candidates(service, team.byMember, body.member_id);
  const list = Array.from({ length: days }, (_, i) => addDays(from, i)).filter((d) => d <= last);
  if (!cals.length || !list.length) return json({ days: [], last_day: last });
  const busy = await busyBetween(cals.map((c) => c.id), madridAt(list[0], "00:00"), madridAt(addDays(list.at(-1)!, 1), "00:00"));
  return json({
    last_day: last,
    days: list.map((day) => {
      const at = new Map<string, string[]>();
      for (const c of cals) for (const t of freeStarts(c, day, service.duration_minutes, busy)) {
        at.set(t, [...(at.get(t) ?? []), c.member_id]);
      }
      return { date: day, slots: [...at.entries()].sort().map(([time, members]) => ({ time, members })) };
    }),
  });
}

async function book(clientId: string, clientName: string, body: Record<string, unknown>, req: Request) {
  if (clean(body.website, 10)) return fail("No se ha podido reservar.");   // campo trampa para robots
  const name = clean(body.name, 80);
  const phoneRaw = clean(body.phone, 30);
  const digits = phoneRaw.replace(/[^\d+]/g, "");
  const email = clean(body.email, 120).toLowerCase();
  const notes = clean(body.notes, 500);
  if (name.length < 2) return fail("Escribe tu nombre.");
  const phone = digits.startsWith("+") ? digits : digits.replace(/^0034|^34(?=\d{9}$)/, "");
  if (!/^\+?\d{9,15}$/.test(phone) || (!phone.startsWith("+") && phone.length !== 9)) {
    return fail("Revisa el teléfono: deben ser 9 cifras.");
  }
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail("Revisa el correo.");
  if (!isDay(body.date) || typeof body.time !== "string" || !/^\d{2}:\d{2}$/.test(body.time)) return fail("Elige día y hora.");

  const ip = (req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "?";
  const visitor = await hmac(`reserva|${madridToday()}|${ip}|${req.headers.get("user-agent") ?? ""}`);
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const { count } = await db.from("web_booking_attempts").select("id", { count: "exact", head: true })
    .eq("visitor", visitor).gte("created_at", since);
  if ((count ?? 0) >= MAX_ATTEMPTS_PER_DAY) return fail("Has hecho muchas reservas hoy. Llámanos o escríbenos por WhatsApp.", 429);
  await db.from("web_booking_attempts").insert({ client_id: clientId, visitor });

  const service = await loadService(clientId, body.service_id);
  if (!service || !service.bookable) return fail("Ese servicio no se puede reservar en la web.");
  const settings = await settingsOf(clientId);
  if (body.date > addDays(madridToday(), Number(settings.booking_days_ahead) || DEFAULT_DAYS_AHEAD)) {
    return fail("Esa fecha aún no está abierta.");
  }
  const team = await bookableTeam(clientId);
  const cals = candidates(service, team.byMember, body.member_id);
  const start = madridAt(body.date, body.time);
  const end = new Date(start.getTime() + service.duration_minutes * 60_000);
  const dayBusy = await busyBetween(cals.map((c) => c.id), madridAt(body.date, "00:00"), madridAt(addDays(body.date, 1), "00:00"));
  // Solo quien tiene ese hueco libre; si da igual la persona, primero quien tenga menos citas ese día.
  const free = cals.filter((c) => freeStarts(c, body.date as string, service.duration_minutes, dayBusy).includes(body.time as string))
    .sort((a, b) => dayBusy.filter((e) => e.calendar_id === a.id).length - dayBusy.filter((e) => e.calendar_id === b.id).length);
  if (!free.length) return fail("Esa hora acaba de ocuparse. Elige otra, por favor.", 409);

  // Cliente del negocio: se reconoce por el teléfono.
  let { data: customer } = await db.from("customers").select("id, email").eq("client_id", clientId).eq("phone", phone).maybeSingle();
  if (!customer) {
    const { data, error } = await db.from("customers").insert({ client_id: clientId, name, phone, email: email || null })
      .select("id, email").single();
    if (error) {   // otra reserva del mismo teléfono a la vez
      ({ data: customer } = await db.from("customers").select("id, email").eq("client_id", clientId).eq("phone", phone).maybeSingle());
    } else customer = data;
  } else if (email && !customer.email) {
    await db.from("customers").update({ email }).eq("id", customer.id);
  }

  const description = [`Teléfono: ${phone}`, email && `Correo: ${email}`, notes && `Notas: ${notes}`, "Reservada desde la web."]
    .filter(Boolean).join("\n");
  for (const cal of free) {
    const { data, error } = await db.rpc("book_service", {
      p_calendar: cal.id, p_start: start.toISOString(), p_end: end.toISOString(),
      p_title: `${service.name} · ${name}`, p_description: description, p_service: service.id,
      p_customer: customer?.id ?? null, p_price: service.price_eur, p_type: cal.booking_type_id,
    });
    if (error) throw error;
    const row = (data ?? [])[0];
    if (!row) continue;
    const member = team.members.find((m) => m.id === cal.member_id);
    await notify("cita", row.id);
    return json({
      ok: true, token: row.manage_token, when: whenEs(start), service: service.name,
      member: member?.name ?? null, business: clientName,
    });
  }
  return fail("Esa hora acaba de ocuparse. Elige otra, por favor.", 409);
}

// Aviso al móvil del negocio (y de administración); si falla, la cita sigue hecha.
async function notify(kind: string, id: string) {
  try {
    await fetch(`${SUPABASE_URL}/functions/v1/push?action=send`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, id }),
    });
  } catch { /* sin aviso */ }
}

async function byToken(token: unknown) {
  if (typeof token !== "string" || !/^[0-9a-f]{36}$/.test(token)) return null;
  const { data } = await db.from("calendar_events")
    .select("id, client_id, starts_at, ends_at, title, service_id, calendar_id, services(name), calendars(member_id, team_members(name)), clients(name, slug)")
    .eq("manage_token", token).maybeSingle();
  return data as null | {
    id: string; client_id: string; starts_at: string; ends_at: string; title: string;
    services: { name: string } | null; calendars: { team_members: { name: string } | null } | null;
    clients: { name: string; slug: string } | null;
  };
}

async function cancelHours(clientId: string) {
  const s = await settingsOf(clientId);
  return Number.isFinite(Number(s.cancel_hours)) && s.cancel_hours !== null && s.cancel_hours !== undefined
    ? Number(s.cancel_hours) : DEFAULT_CANCEL_HOURS;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return fail("Método no permitido", 405);
  let body: Record<string, unknown>;
  try { body = JSON.parse(await req.text()); } catch { return fail("Petición no válida"); }

  try {
    if (body.action === "booking" || body.action === "cancel") {
      const ev = await byToken(body.token);
      if (!ev) return fail("No encontramos esa cita. Puede que ya esté anulada.", 404);
      const start = new Date(ev.starts_at);
      const hours = await cancelHours(ev.client_id);
      const canCancel = start.getTime() - Date.now() > hours * 3_600_000;
      if (body.action === "booking") {
        return json({
          when: whenEs(start), starts_at: ev.starts_at, service: ev.services?.name ?? ev.title,
          member: ev.calendars?.team_members?.name ?? null, business: ev.clients?.name, client: ev.clients?.slug,
          can_cancel: canCancel, cancel_hours: hours, past: start.getTime() < Date.now(),
        });
      }
      if (!canCancel) return fail(`Ya no se puede anular desde la web (hasta ${hours} h antes). Llámanos, por favor.`, 409);
      await notify("cita_anulada", ev.id);   // el aviso lee la cita antes de borrarla
      const { error } = await db.from("calendar_events").delete().eq("id", ev.id);
      if (error) throw error;
      return json({ ok: true });
    }

    const client = await loadClient(body.client);
    if (!client) return fail("Negocio no encontrado", 404);
    if (body.action === "info") return json(await info(client.id));
    if (body.action === "slots") return await slots(client.id, body);
    if (body.action === "book") return await book(client.id, client.name, body, req);
    return fail("Acción no válida");
  } catch (err) {
    console.error(err);
    await db.from("error_log").insert({ source: "reservas", message: String((err as Error)?.message ?? err).slice(0, 500) });
    return fail("No se ha podido completar. Inténtalo otra vez o escríbenos por WhatsApp.", 500);
  }
});
