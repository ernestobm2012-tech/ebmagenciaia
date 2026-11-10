// Agente de chat. Recibe un mensaje del widget, responde con Claude usando el
// prompt y los datos del cliente, y guarda conversación, leads, pasos a humano
// y el coste de cada llamada. Es pública (la llama el widget), así que valida
// todo y aplica los límites del agente y el tope de gasto del cliente.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// USD por millón de tokens (entrada, salida). La caché: lectura 0,1x, escritura 1,25x.
const PRICES: Record<string, [number, number]> = {
  "claude-haiku-4-5": [1, 5],
  "claude-sonnet-5-5": [2, 10],
};

const MAX_MESSAGE_CHARS = 2000;
const MAX_TOOL_ROUNDS = 3;
const MAX_KNOWLEDGE_CHARS = 300_000;
const MAX_API_RESULT_CHARS = 4000;

const BASE_TOOLS: Anthropic.Tool[] = [
  {
    name: "guardar_contacto",
    description:
      "Guarda los datos de una persona interesada para que el equipo la contacte. Úsala en cuanto tengas un nombre y una forma de contacto (teléfono o correo). No la uses sin forma de contacto.",
    input_schema: {
      type: "object",
      properties: {
        nombre: { type: "string", description: "Nombre de la persona" },
        contacto: { type: "string", description: "Teléfono o correo que ha dado" },
        motivo: { type: "string", description: "Qué necesita, en una frase" },
      },
      required: ["nombre", "contacto", "motivo"],
      additionalProperties: false,
    },
  },
  {
    name: "pasar_a_humano",
    description:
      "Avisa de que esta conversación necesita a una persona: lo pide el usuario, hay una queja, o la pregunta no se puede responder con los datos del negocio.",
    input_schema: {
      type: "object",
      properties: {
        motivo: { type: "string", description: "Por qué hace falta una persona" },
        tipo: { type: "string", enum: ["averia", "otro"], description: "«averia» si es un cliente actual con una avería o incidencia en su equipo; si no, «otro»" },
        nombre: { type: "string", description: "Nombre de la persona (obligatorio en una avería)" },
        telefono: { type: "string", description: "Teléfono de 9 cifras (obligatorio en una avería)" },
      },
      required: ["motivo"],
      additionalProperties: false,
    },
  },
];

// ---- Zona (solo agentes con zone_priority): esta lógica vive aquí, no en el prompt ----
const norm = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
const PROVINCES: Record<string, string[]> = {
  "alava": ["araba"], "albacete": [], "alicante": ["alacant"], "almeria": [], "asturias": [], "avila": [], "badajoz": [], "barcelona": [],
  "burgos": [], "caceres": [], "cadiz": [], "cantabria": [], "castellon": ["castello"], "ciudad real": [], "cordoba": [], "cuenca": [],
  "girona": ["gerona"], "granada": [], "guadalajara": [], "guipuzcoa": ["gipuzkoa"], "huelva": [], "huesca": [], "jaen": [], "la rioja": ["rioja"],
  "las palmas": [], "leon": [], "lleida": ["lerida"], "lugo": [], "madrid": [], "malaga": [], "murcia": [], "navarra": [], "ourense": ["orense"],
  "palencia": [], "pontevedra": [], "salamanca": [], "santa cruz de tenerife": ["tenerife"], "segovia": [], "sevilla": [], "soria": [],
  "tarragona": [], "teruel": [], "toledo": [], "valencia": [], "valladolid": [], "vizcaya": ["bizkaia"], "zamora": [], "zaragoza": [],
  "a coruna": ["la coruna", "coruna"], "baleares": ["illes balears", "mallorca"], "ceuta": [], "melilla": [],
};
function provinceOf(input: string): string | null {
  const t = ` ${norm(input)} `;
  let best: string | null = null;
  for (const [name, aliases] of Object.entries(PROVINCES)) {
    for (const n of [name, ...aliases]) {
      if (t.includes(` ${n} `) && (!best || n.length > best.length)) best = name;
    }
  }
  return best;
}
const ZONE_TOOLS: Anthropic.Tool[] = [
  {
    name: "indicar_provincia",
    description:
      "Llámala en cuanto sepas el pueblo o ciudad de la persona, con su PROVINCIA (sácala tú del pueblo). Te devuelve qué hacer a continuación: síguelo al pie de la letra. Sin esta llamada no puedes consultar la agenda ni reservar.",
    input_schema: {
      type: "object",
      properties: { provincia: { type: "string", description: "Provincia del pueblo o ciudad" } },
      required: ["provincia"],
      additionalProperties: false,
    },
  },
  {
    name: "confirmar_interes",
    description:
      "Llámala cuando hayas hecho las preguntas de comprobación de interés (solo si indicar_provincia te lo pidió). interes = «real» si quiere resolverlo de verdad; «curioso» si solo se informa o mira.",
    input_schema: {
      type: "object",
      properties: {
        interes: { type: "string", enum: ["real", "curioso"] },
        resumen: { type: "string", description: "Lo que ha contado, en una frase" },
      },
      required: ["interes", "resumen"],
      additionalProperties: false,
    },
  },
];
async function zoneTool(name: string, input: Record<string, string>, conversationId: string, priority: string[]) {
  if (name === "indicar_provincia") {
    const prov = provinceOf(input.provincia ?? "");
    if (!prov) return "Error: no reconozco esa provincia. Saca la provincia del pueblo que te ha dicho y vuelve a llamar a esta herramienta (o pregúntasela).";
    const prio = priority.map(norm).includes(prov);
    await db.from("conversations").update({ zone: prio ? "priority" : "other", qualified: prio }).eq("id", conversationId);
    if (prio) return `Provincia: ${prov}. Sigue ya con el agendado: pide JUNTOS nombre y teléfono (y el código postal si falta, una vez); luego ofrece la primera hora libre. No comentes nada sobre zonas.`;
    // 10/11/2026 (Ernesto): fuera de zona UNA sola pregunta antes de agendar (la de la prisa), y nada más.
    return `Provincia: ${prov}. Antes de agendar haz UNA sola pregunta, con tus palabras y natural, que viene a decir: «¿Tienes pensado hacer algo con el agua ahora mismo o lo estás mirando sin prisa?». No hagas ninguna otra pregunta de comprobación (nada de «¿seguro que te interesa?», casa/negocio ni cómo se apaña) y no la repitas. Con su respuesta llama a confirmar_interes con interes «real» y sigue: si dice que va sin prisa o solo se informa, ofrécele igualmente una vez la llamada de una compañera («lo mejor es que hables con una compañera y lo veas con calma»); si acepta, nombre y teléfono juntos y la primera hora libre. Solo usa «curioso» si rechaza claramente la llamada. No comentes nada sobre zonas.`;
  }
  // confirmar_interes
  if (input.interes === "real") {
    await db.from("conversations").update({ qualified: true }).eq("id", conversationId);
    return "Interés confirmado. Sigue con el agendado: pide JUNTOS nombre y teléfono (y el código postal si falta), luego ofrece la primera hora libre.";
  }
  return "Interés bajo: NO ofrezcas la llamada ni insistas. Si ya tienes su nombre o teléfono, llama a guardar_contacto con motivo «Fuera de zona, interés bajo: …» y lo que contó. Despídete cálido, sin disculparte, diciendo que si más adelante quiere avanzar puede escribir aquí o llamar al 919 895 040.";
}
async function zoneGate(conversationId: string): Promise<string | null> {
  const { data } = await db.from("conversations").select("zone, qualified").eq("id", conversationId).maybeSingle();
  if (!data?.zone) return "Error: antes de consultar la agenda o reservar tienes que preguntar el pueblo o ciudad y llamar a indicar_provincia.";
  if (data.zone === "other" && !data.qualified) return "Error: antes de consultar la agenda o reservar tienes que hacer las preguntas de comprobación de interés y llamar a confirmar_interes.";
  return null;
}

// Limpieza del texto antes de enviarlo: sin negritas en markdown (el chat no las pinta) y sin las palabras que el cliente
// ha vetado (se cambian por «vale»).
const escRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function cleanReply(text: string, banned: string[] | null): string {
  let t = text.replace(/\*\*(.+?)\*\*/gs, "$1").replace(/__(.+?)__/gs, "$1");
  for (const w of banned ?? []) {
    const re = new RegExp(`(^|[^\\p{L}])((?:(?:lo|te|la|me|se)\\s+)?)(${escRe(w)})(?![\\p{L}])`, "giu");
    t = t.replace(re, (_m, pre: string, clitic: string, _w: string, off: number, str: string) => {
      const before = str.slice(0, off + pre.length).replace(/[\s¡¿]+$/u, "");
      const start = before === "" || /[.!?\n]$/.test(before);
      if (clitic && !start) return pre; // «lo entiendo», «te entiendo»: se quita entero, no se deja «lo vale»
      return `${pre}${start ? "Vale" : "vale"}`;
    });
  }
  t = t.replace(/\b(vale)(\s*[,.!]*\s*)vale\b/gi, "$1");
  return t.replace(/\s+([,.!?])/g, "$1").replace(/,\s*([.!?])/g, "$1").replace(/[ \t]{2,}/g, " ");
}

type Contact = { id: string; name: string; department: string | null; notify_when: string | null };

// Si el cliente tiene personas a las que avisar, el agente elige a cuál debe
// llegar cada aviso. Solo puede elegir de esa lista: nunca inventa correos.
function baseTools(contacts: Contact[]): Anthropic.Tool[] {
  const options = contacts.filter((c) => c.department);
  if (!options.length) return BASE_TOOLS;
  const guide = options.map((c) => `${c.department}: ${c.notify_when || c.name}`).join(" | ");
  return BASE_TOOLS.map((tool) => ({
    ...tool,
    input_schema: {
      ...tool.input_schema,
      properties: {
        ...(tool.input_schema.properties as Record<string, unknown>),
        departamento: {
          type: "string",
          enum: [...new Set(options.map((c) => c.department!))],
          description: `Departamento al que debe llegar el aviso. Elige el que mejor encaje; si ninguno encaja, omítelo. ${guide}`,
        },
      },
    },
  }));
}

type Connection = {
  id: string; tool_name: string; description: string; url_template: string;
  params: { name: string; description?: string }[];
  auth_header: string | null; auth_prefix: string; secret_name: string | null;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const isUuid = (v: unknown) => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);

function costUsd(model: string, u: Anthropic.Usage) {
  const [inPrice, outPrice] = PRICES[model] ?? PRICES["claude-sonnet-5-5"];
  return (
    (u.input_tokens * inPrice +
      (u.cache_creation_input_tokens ?? 0) * inPrice * 1.25 +
      (u.cache_read_input_tokens ?? 0) * inPrice * 0.1 +
      u.output_tokens * outPrice) / 1_000_000
  );
}

// Fecha de hoy y calendario de las próximas semanas. Los modelos se equivocan
// al calcular qué día de la semana cae una fecha; así solo tienen que leerlo.
function todayBlock() {
  const weekday = new Intl.DateTimeFormat("es-ES", { weekday: "long", timeZone: "Europe/Madrid" });
  const iso = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" });
  const days = Array.from({ length: 35 }, (_, i) => {
    const d = new Date(Date.now() + i * 86_400_000);
    return `${weekday.format(d)} ${iso.format(d)}`;
  });
  const now = new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
  return `Hoy es ${days[0]} y en España son las ${now}. Para saber qué fecha es "el sábado que viene" o qué día de la semana cae una fecha, no lo calcules: léelo en este calendario de los próximos días: ${days.join(", ")}.`;
}

// Teléfono que la persona ya ha escrito: las cifras se cuentan aquí (el modelo contaba mal y pedía confirmar uno correcto).
function phoneHint(userTexts: string[]): string | null {
  let found: string | null = null;
  for (const t of userTexts) {
    for (const m of t.matchAll(/\+?\d[\d\s.\-]{5,}\d/g)) {
      const clean = (s: string) => { let d = s.replace(/\D/g, ""); if (d.length === 11 && d.startsWith("34")) d = d.slice(2); return d; };
      const whole = clean(m[0]);
      const parts = m[0].split(/\s+/).map(clean).filter((d) => d.length === 9);
      if (whole.length === 9) found = whole;
      else if (parts.length) found = parts[parts.length - 1];
      else if (whole.length >= 6) found = whole;
    }
  }
  if (!found) return null;
  return found.length === 9
    ? `TELÉFONO QUE LA PERSONA YA HA DADO: ${found}. Tiene exactamente 9 cifras: es VÁLIDO (lo ha comprobado el sistema). No le pidas que lo repita, no se lo hagas confirmar y no cuestiones sus cifras: úsalo tal cual.`
    : `La persona ha escrito el número ${found}, que tiene ${found.length} cifras (un teléfono español tiene 9). Pídele solo una vez, con naturalidad, que lo repita.`;
}

// Cada conexión a un sistema del cliente se ofrece al agente como una herramienta.
function connectionTool(c: Connection): Anthropic.Tool {
  return {
    name: c.tool_name,
    description: c.description,
    input_schema: {
      type: "object",
      properties: Object.fromEntries(c.params.map((p) => [p.name, { type: "string", description: p.description ?? "" }])),
      required: c.params.map((p) => p.name),
      additionalProperties: false,
    },
  };
}

// Consulta de solo lectura (GET) al sistema del cliente. La credencial sale de
// un secreto ERP_*, nunca de la base de datos.
async function callConnection(c: Connection, input: Record<string, string>, clientId: string, conversationId: string) {
  let url = c.url_template;
  const extra = new URLSearchParams();
  for (const p of c.params) {
    const value = String(input[p.name] ?? "");
    if (url.includes(`{${p.name}}`)) url = url.replaceAll(`{${p.name}}`, encodeURIComponent(value));
    else extra.set(p.name, value);
  }
  const target = new URL(url);
  extra.forEach((v, k) => target.searchParams.set(k, v));
  if (target.protocol !== "https:") throw new Error("La conexión debe usar https");

  const headers: Record<string, string> = { Accept: "application/json" };
  if (c.auth_header && c.secret_name?.startsWith("ERP_")) {
    const secret = Deno.env.get(c.secret_name);
    if (!secret) throw new Error(`Falta el secreto ${c.secret_name}`);
    headers[c.auth_header] = `${c.auth_prefix}${secret}`;
  }
  const res = await fetch(target, { headers, signal: AbortSignal.timeout(10_000) });
  const text = (await res.text()).slice(0, MAX_API_RESULT_CHARS);
  await db.from("api_calls").insert({
    client_id: clientId, connection_id: c.id, conversation_id: conversationId, params: input, status: res.status,
  });
  if (!res.ok) throw new Error(`El sistema respondió ${res.status}`);
  return text || "Sin datos.";
}

type Calendar = {
  id: string; name: string;
  booking_enabled: boolean; booking_minutes: number; booking_notice_minutes: number;
  booking_hours: Record<string, string[]>;
  booking_kind?: string; member_id?: string | null; booking_type_id?: string | null;
  booking_step_minutes?: number | null; agenda_group?: string | null; booking_capacity?: number | null;
};
// Duración de cada hueco: si el calendario tiene paso propio (llamadas cada 5 min) manda ese; si no, la duración de la cita.
const slotLen = (c: Calendar) => c.booking_step_minutes ?? c.booking_minutes;
const MAX_AGENDA_DAYS = 31;
// Las agendas de «llamadas del equipo» se ven como una sola: el asistente no elige
// persona; la llamada se pone a quien esté libre a esa hora y tenga menos ese día.
const POOL = "Llamadas del equipo";
const isPool = (c: Calendar) => c.booking_enabled && c.booking_kind === "llamada";
// Lo que el asistente ve como agendas: las normales y, si hay, el grupo de llamadas.
function visibleAgendas(calendars: Calendar[]) {
  const pool = calendars.filter(isPool);
  const rest = calendars.filter((c) => !isPool(c));
  return { pool, rest, names: [...rest.map((c) => c.name), ...(pool.length ? [POOL] : [])] };
}

// Si el cliente tiene calendarios, el agente puede ver cuándo está ocupado.
// Solo ve horas, nunca el título ni los datos de las citas (pueden ser personales).
function agendaTool(calendars: Calendar[]): Anthropic.Tool {
  const { names, pool } = visibleAgendas(calendars);
  return {
    name: "consultar_agenda",
    description:
      `Consulta qué horas están ocupadas en la agenda del negocio entre dos fechas (máximo ${MAX_AGENDA_DAYS} días). ` +
      "Úsala antes de proponer o confirmar un día u hora. Lo que no aparece como ocupado está libre, " +
      "siempre dentro del horario del negocio. Si la agenda acepta reservas, también te da los huecos libres para citas: " +
      "propón solo esos. Nunca digas qué hay en las horas ocupadas: solo que no están disponibles." +
      (pool.length ? ` La agenda «${POOL}» sirve para programar una llamada de una persona del equipo cuando el cliente no puede hablar ahora o pide que le llamen a una hora: consúltala y ofrece solo sus huecos libres.` : ""),
    input_schema: {
      type: "object",
      properties: {
        desde: { type: "string", description: "Primer día, formato AAAA-MM-DD" },
        hasta: { type: "string", description: "Último día incluido, formato AAAA-MM-DD" },
        ...(names.length > 1 ? {
          calendario: { type: "string", enum: names, description: "Solo esta agenda. Omítelo para ver todas." },
        } : {}),
      },
      required: ["desde", "hasta"],
      additionalProperties: false,
    },
  };
}

// Medianoche en Madrid del día AAAA-MM-DD, como instante UTC.
function madridMidnight(day: string) {
  const [y, m, d] = day.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(guess));
  const hh = Number(parts.find((p) => p.type === "hour")!.value);
  const mm = Number(parts.find((p) => p.type === "minute")!.value);
  return new Date(guess - (hh * 60 + mm) * 60_000);
}

// Horas seguidas a un mismo paso se resumen en tramos («09:30-12:00») para no gastar miles de palabras.
function squash(times: string[], step: number) {
  const mins = (t: string) => +t.slice(0, 2) * 60 + +t.slice(3);
  const out: string[] = [];
  let i = 0;
  while (i < times.length) {
    let j = i;
    while (j + 1 < times.length && mins(times[j + 1]) - mins(times[j]) === step) j++;
    out.push(j === i ? times[i] : `${times[i]}-${times[j]}`);
    i = j + 1;
  }
  return out.join(", ") + (out.some((x) => x.includes("-")) ? ` (en cada tramo hay una hora libre cada ${step} min)` : "");
}

async function checkAgenda(input: Record<string, string>, clientId: string, calendars: Calendar[]) {
  const valid = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d ?? "");
  if (!valid(input.desde) || !valid(input.hasta)) throw new Error("Fechas en formato AAAA-MM-DD");
  const from = madridMidnight(input.desde);
  const [y, m, d] = input.hasta.split("-").map(Number);
  const to = madridMidnight(new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10));
  if (to <= from) throw new Error("La fecha final es anterior a la inicial");
  if (to.getTime() - from.getTime() > (MAX_AGENDA_DAYS + 1) * 86_400_000) throw new Error(`Como máximo ${MAX_AGENDA_DAYS} días por consulta`);

  const { pool, rest } = visibleAgendas(calendars);
  const wantPool = pool.length && (!input.calendario || input.calendario === POOL);
  const chosen = input.calendario ? rest.filter((c) => c.name === input.calendario) : rest;
  if (!chosen.length && !wantPool) throw new Error("Esa agenda no existe");
  const ids = [...chosen, ...(wantPool ? pool : [])].map((c) => c.id);
  const { data, error } = await db.from("calendar_events").select("calendar_id, starts_at, ends_at, all_day")
    .eq("client_id", clientId).in("calendar_id", ids)
    .lt("starts_at", to.toISOString()).gt("ends_at", from.toISOString()).order("starts_at").limit(3000);
  if (error) throw error;

  // Del grupo de llamadas no se enseñan las horas ocupadas de cada persona, solo los huecos.
  const own = (data ?? []).filter((e) => chosen.some((c) => c.id === e.calendar_id));
  const text = chosen.length ? formatAgenda(own, input.desde, input.hasta, chosen.length > 1 ? chosen : null) : "";
  const poolText = wantPool ? (() => {
    const days: string[] = [];
    const step = Math.min(...pool.map(slotLen));
    for (const iso of daysBetween(input.desde, input.hasta)) {
      const free = poolSlots(pool, iso, data ?? []);
      if (free.length) days.push(`${iso}: ${squash(free, step)}`);
    }
    return `Huecos libres para programar una llamada («${POOL}», una hora libre cada ${step} min; al ofrecer horas, propón dos separadas al menos 15 minutos entre sí):\n` +
      (days.length ? days.join("\n") : "ninguno en estas fechas");
  })() : "";
  const slots = chosen.filter((c) => c.booking_enabled).map((c) => {
    const busy = (data ?? []).filter((e) => e.calendar_id === c.id);
    const days: string[] = [];
    for (const iso of daysBetween(input.desde, input.hasta)) {
      const free = freeSlots(c, iso, busy);
      if (free.length) days.push(`${iso}: ${free.join(", ")}`);
    }
    return `Huecos libres para reservar en "${c.name}" (citas de ${slotLen(c)} min):\n` +
      (days.length ? days.join("\n") : "ninguno en estas fechas");
  });
  return [text, ...slots, poolText].filter(Boolean).join("\n\n");
}

// Huecos del grupo de llamadas: una hora vale si al menos una persona está libre.
function poolSlots(pool: Calendar[], day: string, busy: Busy[]) {
  const all = new Set<string>();
  for (const c of pool) for (const t of freeSlots(c, day, busy.filter((e) => e.calendar_id === c.id))) all.add(t);
  return [...all].sort();
}

function daysBetween(desde: string, hasta: string) {
  const [y, m, d] = desde.split("-").map(Number);
  const out: string[] = [];
  for (let i = 0; i < 62; i++) {
    const iso = new Date(Date.UTC(y, m - 1, d + i)).toISOString().slice(0, 10);
    if (iso > hasta) break;
    out.push(iso);
  }
  return out;
}

// Instante UTC de una hora de reloj de Madrid (AAAA-MM-DD, HH:MM), con el cambio de hora bien.
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

// Horas de inicio libres de un día según el horario del calendario, sus citas y la antelación mínima.
// Capacidad: cuántas citas caben a la vez (dos teleoperadoras en una sola agenda = 2). Un evento de todo el día (festivo) lo cierra.
function freeSlots(cal: Calendar, day: string, busy: Busy[]) {
  const [y, m, d] = day.split("-").map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7;
  const earliest = Date.now() + cal.booking_notice_minutes * 60_000;
  const len = slotLen(cal);
  const capacity = cal.booking_capacity ?? 1;
  const out: string[] = [];
  for (const range of cal.booking_hours?.[String(weekday)] ?? []) {
    const match = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(range.replace(/\s/g, ""));
    if (!match) continue;
    const open = +match[1] * 60 + +match[2];
    const close = +match[3] * 60 + +match[4];
    for (let t = open; t + len <= close; t += len) {
      const hhmm = `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
      const start = madridAt(day, hhmm);
      const end = new Date(start.getTime() + len * 60_000);
      if (start.getTime() < earliest) continue;
      const overlap = busy.filter((e) => new Date(e.starts_at) < end && new Date(e.ends_at) > start);
      if (overlap.some((e) => e.all_day) || overlap.length >= capacity) continue;
      out.push(hhmm);
    }
  }
  return out;
}

// Reserva de citas: solo en calendarios que la aceptan y solo en huecos libres.
function bookingTool(calendars: Calendar[]): Anthropic.Tool {
  const { names, pool } = visibleAgendas(calendars);
  return {
    name: "reservar_cita",
    description:
      "Reserva una cita en la agenda. Antes usa consultar_agenda y propón solo huecos libres para reservar. " +
      "Pide nombre y teléfono y resérvala en cuanto la persona haya elegido una hora que tú le has ofrecido, sin pedir otra confirmación. " +
      "No digas nunca que la cita o la llamada está apuntada hasta que esta herramienta te devuelva que se ha reservado. " +
      "Si falla porque el hueco ya no está libre, vuelve a consultar la agenda y ofrece otro." +
      (pool.length ? ` Para programar una llamada del equipo (el cliente pide que le llamen a una hora), usa la agenda «${POOL}»: ` +
        "no digas el nombre de quién llamará. Usa franja_desde y franja_hasta (la franja que elige la persona: mañana, tarde o ahora mismo) y dile SOLO la franja, nunca la hora exacta." : ""),
    input_schema: {
      type: "object",
      properties: {
        ...(names.length > 1 || pool.length ? { calendario: { type: "string", enum: names, description: "Agenda donde reservar" } } : {}),
        fecha: { type: "string", description: "Día, formato AAAA-MM-DD" },
        hora: { type: "string", description: "Hora de inicio, formato HH:MM (hora de España). Solo para citas normales; en las llamadas del equipo usa franja_desde y franja_hasta." },
        franja_desde: { type: "string", description: "SOLO llamadas del equipo: inicio de la franja que ha elegido la persona, HH:MM. El sistema elige el hueco exacto dentro de la franja." },
        franja_hasta: { type: "string", description: "SOLO llamadas del equipo: fin de la franja que ha elegido la persona, HH:MM (normalmente una hora después del inicio)." },
        nombre: { type: "string", description: "Nombre de la persona" },
        telefono: { type: "string", description: "Teléfono de la persona" },
        motivo: { type: "string", description: "Para qué es la cita, en una frase" },
      },
      required: [...(names.length > 1 || pool.length ? ["calendario"] : []), "fecha", "nombre", "telefono", "motivo"],
      additionalProperties: false,
    },
  };
}

async function bookAppointment(input: Record<string, string>, clientId: string, conversationId: string, calendars: Calendar[]) {
  const { pool, rest } = visibleAgendas(calendars);
  if (pool.length && (input.calendario === POOL || (!input.calendario && !rest.some((c) => c.booking_enabled)))) {
    return await bookCall(input, clientId, conversationId, pool);
  }
  const bookable = rest.filter((c) => c.booking_enabled);
  const cal = input.calendario ? bookable.find((c) => c.name === input.calendario) : bookable[0];
  if (!cal) throw new Error("Esa agenda no acepta reservas");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.fecha ?? "") || !/^\d{1,2}:\d{2}$/.test(input.hora ?? "")) {
    throw new Error("Fecha AAAA-MM-DD y hora HH:MM");
  }
  const hora = input.hora.padStart(5, "0");
  const start = madridAt(input.fecha, hora);
  const already = (await bookingsOf(conversationId)).find((e) => new Date(e.starts_at).getTime() === start.getTime());
  if (already) return `Esa cita YA está reservada para el ${whenEs(new Date(already.starts_at))}. No la repitas: confírmasela a la persona una sola vez.`;
  const end = new Date(start.getTime() + slotLen(cal) * 60_000);
  const dayStart = madridMidnight(input.fecha);
  const { data: busy, error } = await db.from("calendar_events").select("calendar_id, starts_at, ends_at, all_day")
    .eq("calendar_id", cal.id).lt("starts_at", new Date(dayStart.getTime() + 26 * 3_600_000).toISOString())
    .gt("ends_at", dayStart.toISOString()).limit(500);
  if (error) throw error;
  if (!freeSlots(cal, input.fecha, busy ?? []).includes(hora)) {
    throw new Error("Esa hora no es un hueco libre para reservar. Consulta la agenda y ofrece otra.");
  }
  const description = `Teléfono: ${input.telefono}\nMotivo: ${input.motivo}\nReservada por el agente de chat.`;
  const { data: id, error: e2 } = await db.rpc("book_appointment", {
    p_calendar: cal.id, p_start: start.toISOString(), p_end: end.toISOString(),
    p_title: `Cita: ${input.nombre}`.slice(0, 200), p_description: description, p_conversation: conversationId,
  });
  if (e2) throw e2;
  if (!id) throw new Error("Ese hueco se acaba de ocupar. Consulta la agenda y ofrece otro.");
  if (cal.booking_type_id) await db.from("calendar_events").update({ type_id: cal.booking_type_id }).eq("id", id);
  await dropOldBookings(conversationId, id);
  const when = new Intl.DateTimeFormat("es-ES", {
    timeZone: "Europe/Madrid", weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit",
  }).format(start);
  // Aviso al negocio por el mismo camino que un contacto nuevo.
  await db.from("leads").insert({
    client_id: clientId, conversation_id: conversationId, name: input.nombre, contact: input.telefono,
    reason: `Cita reservada (${cal.name}) el ${when}: ${input.motivo}`,
  });
  return `Cita reservada en "${cal.name}" el ${when} (${slotLen(cal)} min). Confírmaselo a la persona.`;
}

// Lo que ya se ha reservado en esta conversación. El historial que ve el modelo solo trae texto,
// no sus llamadas a herramientas: sin esto no sabe que ya reservó y vuelve a reservar.
async function bookingsOf(conversationId: string) {
  const { data } = await db.from("calendar_events").select("id, title, starts_at, calendar_id")
    .eq("conversation_id", conversationId).eq("source", "agent").order("starts_at");
  return data ?? [];
}
const whenEs = (d: Date) => new Intl.DateTimeFormat("es-ES", {
  timeZone: "Europe/Madrid", weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit",
}).format(d);
// Si la persona cambia de hora, la reserva anterior de esta conversación se quita para no dejar dos.
async function dropOldBookings(conversationId: string, keepId: string) {
  const old = (await bookingsOf(conversationId)).filter((e) => e.id !== keepId);
  if (old.length) await db.from("calendar_events").delete().in("id", old.map((e) => e.id));
}

// Llamada programada: se pone a una persona del grupo libre a esa hora (la que menos
// tenga ese día) y el lead queda a su nombre, en «Volver a llamar» a esa hora.
// Con una agenda común de teleoperadoras (sin persona), el lead queda sin asignar y lo coge quien llame.
async function bookCall(input: Record<string, string>, clientId: string, conversationId: string, pool: Calendar[]) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.fecha ?? "")) throw new Error("Fecha AAAA-MM-DD");
  const isT = (t?: string) => /^\d{1,2}:\d{2}$/.test(t ?? "");
  const franja = isT(input.franja_desde) && isT(input.franja_hasta);
  if (!franja && !isT(input.hora)) throw new Error("Indica la franja de la llamada: franja_desde y franja_hasta (HH:MM).");
  const dayStart = madridMidnight(input.fecha);
  const { data: busy, error } = await db.from("calendar_events").select("calendar_id, starts_at, ends_at, all_day")
    .in("calendar_id", pool.map((c) => c.id)).lt("starts_at", new Date(dayStart.getTime() + 26 * 3_600_000).toISOString())
    .gt("ends_at", dayStart.toISOString()).limit(2000);
  if (error) throw error;
  const { data: said } = await db.from("messages").select("role, content").eq("conversation_id", conversationId).in("role", ["user", "assistant"]);
  const mins = (t: string) => +t.split(":")[0] * 60 + +t.split(":")[1];
  let hora: string;
  if (franja) {
    // La persona elige una franja (p. ej. 16:00-17:00); el sistema agenda en el primer hueco de 5 min libre dentro de ella.
    if (!(said ?? []).some((m) => m.role === "assistant" && /a qué hora/i.test(String(m.content)))) {
      throw new Error("Todavía no le has preguntado a qué hora le viene bien (por la mañana, por la tarde o ahora mismo). Pregúntaselo y reserva cuando conteste.");
    }
    const from = mins(input.franja_desde), to = mins(input.franja_hasta);
    const cand = poolSlots(pool, input.fecha, busy ?? []).filter((t) => mins(t) >= from && mins(t) < to);
    if (!cand.length) throw new Error("En esa franja no queda ningún hueco libre. Mira la lista de huecos reales y ofrece otra franja u otro día.");
    hora = cand[0];
  } else {
    hora = input.hora.padStart(5, "0");
    // Sin franja: no se reserva una hora de la que no se ha hablado (el modelo reservaba al recibir nombre y teléfono).
    const hm = hora.replace(/^0/, "");
    const hourRe = new RegExp(`(^|\\D)0?${hm.replace(":", "[:.h]")}(\\D|$)`);
    const hourRe2 = hora.endsWith(":00") ? new RegExp(`las 0?${hm.split(":")[0]}(\\D|$)`, "i") : null;
    if (!(said ?? []).some((m) => hourRe.test(String(m.content)) || (hourRe2 && hourRe2.test(String(m.content))))) {
      throw new Error("Todavía no le has ofrecido esa hora ni la ha pedido la persona: ofrécele una franja y reserva solo cuando la elija.");
    }
  }
  const already = (await bookingsOf(conversationId)).find((e) => new Date(e.starts_at).getTime() === madridAt(input.fecha, hora).getTime());
  if (already) return `Esa llamada YA está programada para el ${whenEs(new Date(already.starts_at))}. No la repitas: confírmasela a la persona una sola vez.`;
  const load = (c: Calendar) => (busy ?? []).filter((e) => e.calendar_id === c.id).length;
  const free = pool.filter((c) => freeSlots(c, input.fecha, (busy ?? []).filter((e) => e.calendar_id === c.id)).includes(hora))
    .sort((a, b) => load(a) - load(b) || Math.random() - 0.5);
  if (!free.length) throw new Error("A esa hora no hay nadie libre para llamar. Consulta la agenda y ofrece otra franja.");

  const start = madridAt(input.fecha, hora);
  const description = `Teléfono: ${input.telefono}\nMotivo: ${input.motivo}\nLlamada programada por el asistente.`;
  for (const cal of free) {
    const end = new Date(start.getTime() + slotLen(cal) * 60_000);
    const { data: id, error: e2 } = await db.rpc("book_appointment", {
      p_calendar: cal.id, p_start: start.toISOString(), p_end: end.toISOString(),
      p_title: `Llamar a ${input.nombre} · ${input.telefono}`.slice(0, 200), p_description: description, p_conversation: conversationId,
    });
    if (e2) throw e2;
    if (!id) continue; // otra conversación la ha cogido justo ahora: se prueba con la siguiente persona
    if (cal.booking_type_id) await db.from("calendar_events").update({ type_id: cal.booking_type_id }).eq("id", id);
    const when = new Intl.DateTimeFormat("es-ES", {
      timeZone: "Europe/Madrid", weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit",
    }).format(start);
    await dropOldBookings(conversationId, id);
    // El lead de esta conversación (o uno nuevo) queda a nombre de quien llamará.
    const reason = `Llamar el ${when}${franja ? ` (al cliente se le dijo entre las ${input.franja_desde} y las ${input.franja_hasta})` : ""}: ${input.motivo}`;
    const { data: existing } = await db.from("leads").select("id").eq("conversation_id", conversationId)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    let leadId = existing?.id as string | undefined;
    if (leadId) {
      await db.from("leads").update({ name: input.nombre, contact: input.telefono, reason, status: "callback", follow_up_at: start.toISOString(), updated_at: new Date().toISOString() }).eq("id", leadId);
    } else {
      const { data: lead, error: e3 } = await db.from("leads").insert({
        client_id: clientId, conversation_id: conversationId, name: input.nombre, contact: input.telefono,
        reason, status: "callback", follow_up_at: start.toISOString(),
      }).select("id").single();
      if (e3) throw e3;
      leadId = lead.id;
    }
    // Se asigna aparte para que salte el aviso a esa persona.
    if (cal.member_id) await db.from("leads").update({ caller_id: cal.member_id }).eq("id", leadId);
    if (franja) {
      const dayTxt = new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", weekday: "long", day: "numeric", month: "long" }).format(start);
      return `Llamada programada (${dayTxt}). Dile a la persona SOLO la franja: «te llamará una compañera entre las ${input.franja_desde.padStart(5, "0")} y las ${input.franja_hasta.padStart(5, "0")}» al ${input.telefono}. No le digas la hora exacta.`;
    }
    return `Llamada programada para el ${when}. Dile a la persona que una compañera le llamará a esa hora al ${input.telefono}.`;
  }
  throw new Error("Esa hora se acaba de ocupar. Consulta la agenda y ofrece otra.");
}

type Busy = { calendar_id: string; starts_at: string; ends_at: string; all_day: boolean };

// Una línea por día con las horas ocupadas, en hora de Madrid.
export function formatAgenda(events: Busy[], desde: string, hasta: string, named: Calendar[] | null) {
  const day = new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", weekday: "long", day: "numeric", month: "long" });
  const time = new Intl.DateTimeFormat("es-ES", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const nameOf = Object.fromEntries((named ?? []).map((c) => [c.id, c.name]));
  const [y, m, d0] = desde.split("-").map(Number);
  const lines: string[] = [];
  for (let i = 0; ; i++) {
    const iso = new Date(Date.UTC(y, m - 1, d0 + i)).toISOString().slice(0, 10);
    if (iso > hasta) break;
    const start = madridMidnight(iso);
    const next = madridMidnight(new Date(Date.UTC(y, m - 1, d0 + i + 1)).toISOString().slice(0, 10));
    const busy = events.filter((e) => new Date(e.starts_at) < next && new Date(e.ends_at) > start).map((e) => {
      const s = new Date(e.starts_at);
      const en = new Date(e.ends_at);
      const range = e.all_day || (s <= start && en >= next) ? "todo el día"
        : `${s < start ? "00:00" : time.format(s)}-${en >= next ? "24:00" : time.format(en)}`;
      return named ? `${range} (${nameOf[e.calendar_id]})` : range;
    });
    lines.push(`${day.format(start)} (${iso}): ${busy.length ? `ocupado ${busy.join(", ")}` : "nada ocupado"}`);
  }
  return lines.join("\n");
}

async function runTool(
  name: string, input: Record<string, string>, clientId: string, conversationId: string,
  connections: Connection[], contacts: Contact[], calendars: Calendar[], zonePriority: string[] | null = null,
) {
  // Agentes con lógica de zona (DZZERO): sin provincia (y, fuera de zona, sin interés confirmado) no se agenda.
  if (zonePriority?.length) {
    if (name === "indicar_provincia" || name === "confirmar_interes") return await zoneTool(name, input, conversationId, zonePriority);
    if (name === "consultar_agenda" || name === "reservar_cita") {
      const gate = await zoneGate(conversationId);
      if (gate) return gate;
    }
  }
  if (name === "consultar_agenda" && calendars.length) return await checkAgenda(input, clientId, calendars);
  if (name === "reservar_cita" && calendars.some((c) => c.booking_enabled)) {
    return await bookAppointment(input, clientId, conversationId, calendars);
  }
  const wanted = (input.departamento ?? "").toLowerCase();
  const notify_contact_id = wanted
    ? contacts.find((c) => (c.department ?? "").toLowerCase() === wanted)?.id ?? null
    : null;
  if (name === "guardar_contacto") {
    const { error } = await db.from("leads").insert({
      client_id: clientId, conversation_id: conversationId,
      name: input.nombre, contact: input.contacto, reason: input.motivo, notify_contact_id,
    });
    if (error) throw error;
    return "Contacto guardado. El equipo le escribirá.";
  }
  if (name === "pasar_a_humano") {
    let reason = input.motivo;
    if (input.tipo === "averia") {
      // Una avería necesita nombre y teléfono ANTES de avisar, y se avisa una sola vez por conversación.
      const phone = String(input.telefono ?? "").replace(/[^\d+]/g, "");
      if (phone.replace(/\D/g, "").length < 9) return "Error: falta el teléfono (9 cifras). Pídeselo y vuelve a llamar a pasar_a_humano; no avises antes de tenerlo.";
      const { data: already } = await db.from("leads").select("id").eq("conversation_id", conversationId).eq("kind", "averia").limit(1);
      if (already?.length) return "El aviso de la avería ya está registrado. No lo repitas: despídete.";
      const who = String(input.nombre ?? "").trim() || "Sin nombre";
      reason = `Cliente actual · Avería: ${input.motivo} · Nombre: ${who} · Teléfono: ${phone}`;
      // Queda también como contacto «Avería»: se ve el primero en el resumen del panel hasta que se marque atendida.
      const { error: le } = await db.from("leads").insert({
        client_id: clientId, conversation_id: conversationId, name: who, contact: phone,
        reason: `Avería: ${input.motivo}`, kind: "averia", status: "new",
      });
      if (le) throw le;
    }
    const { error } = await db.from("handoffs").insert({
      client_id: clientId, conversation_id: conversationId, reason, notify_contact_id,
    });
    if (error) throw error;
    await db.from("conversations").update({ handed_off: true }).eq("id", conversationId);
    return "Aviso registrado. Una persona revisará la conversación.";
  }
  const connection = connections.find((c) => c.tool_name === name);
  if (connection) return await callConnection(connection, input, clientId, conversationId);
  return "Herramienta desconocida.";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: { client?: string; conversation_id?: string; visitor_id?: string; message?: string; action?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  // El widget pide el saludo al agente para enseñar siempre el que se configura en el panel.
  if (body.action === "welcome" && typeof body.client === "string") {
    const { data: c } = await db.from("clients").select("id").eq("slug", body.client).maybeSingle();
    const { data: a } = c ? await db.from("agents").select("welcome_message")
      .eq("client_id", c.id).eq("active", true).order("created_at").limit(1).maybeSingle() : { data: null };
    return json({ welcome: a?.welcome_message ?? null });
  }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!body.client || !isUuid(body.visitor_id) || !message || message.length > MAX_MESSAGE_CHARS) {
    return json({ error: "invalid_request" }, 400);
  }

  const { data: client } = await db.from("clients")
    .select("id, status, ai_budget_usd").eq("slug", body.client).maybeSingle();
  if (!client) return json({ error: "unknown_client" }, 404);

  const { data: agent } = await db.from("agents").select("*")
    .eq("client_id", client.id).eq("active", true).order("created_at").limit(1).maybeSingle();
  if (!agent || client.status === "paused") return json({ error: "agent_unavailable" }, 503);

  // Conversación: se continúa solo si es de este cliente y de este visitante.
  let conversation: { id: string; message_count: number } | null = null;
  if (isUuid(body.conversation_id)) {
    const { data } = await db.from("conversations").select("id, message_count")
      .eq("id", body.conversation_id).eq("client_id", client.id).eq("visitor_id", body.visitor_id).maybeSingle();
    conversation = data;
  }

  // Límites contra abusos (message_count cuenta mensajes del usuario y del agente).
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const { data: today } = await db.from("conversations").select("message_count")
    .eq("client_id", client.id).eq("visitor_id", body.visitor_id).gte("last_message_at", dayStart.toISOString());
  const sentToday = (today ?? []).reduce((n, c) => n + c.message_count, 0) / 2;
  if (
    sentToday >= agent.max_messages_per_user_day ||
    (conversation && conversation.message_count / 2 >= agent.max_messages_per_conversation)
  ) {
    return json({
      conversation_id: conversation?.id ?? null,
      reply: "Hemos llegado al límite de mensajes de esta conversación. Déjanos tu contacto en el formulario y te escribimos.",
      limited: true,
    });
  }

  if (!conversation) {
    const { data, error } = await db.from("conversations")
      .insert({ client_id: client.id, agent_id: agent.id, channel: "web", visitor_id: body.visitor_id })
      .select("id, message_count").single();
    if (error) return json({ error: "server_error" }, 500);
    conversation = data;
  }
  const conversationId = conversation!.id;

  await db.from("messages").insert({
    client_id: client.id, conversation_id: conversationId, role: "user", content: message,
  });

  let reply: string;
  let failed = false;
  try {
    // Tope mensual de gasto del cliente: si se ha superado, no se llama a la IA.
    const month = new Date();
    const monthIso = `${month.getUTCFullYear()}-${String(month.getUTCMonth() + 1).padStart(2, "0")}-01`;
    const { data: usage } = await db.from("usage_monthly").select("cost_usd")
      .eq("client_id", client.id).eq("month", monthIso).maybeSingle();
    if (Number(usage?.cost_usd ?? 0) >= Number(client.ai_budget_usd)) throw new Error("Tope mensual de IA superado");

    const [{ data: history }, { data: sources }, { data: conns }, { data: people }, { data: cals }] = await Promise.all([
      db.from("messages").select("role, content")
        .eq("conversation_id", conversationId).in("role", ["user", "assistant"])
        .order("created_at", { ascending: false }).limit(agent.max_history_messages),
      // Orden fijo para que el texto del sistema sea idéntico entre llamadas y la caché funcione.
      db.from("knowledge_sources").select("kind, title, content")
        .eq("client_id", client.id).eq("active", true).order("created_at"),
      db.from("api_connections").select("*").eq("client_id", client.id).eq("active", true).order("created_at"),
      db.from("notify_contacts").select("id, name, department, notify_when")
        .eq("client_id", client.id).eq("active", true).order("created_at"),
      db.from("calendars").select("id, name, booking_enabled, booking_minutes, booking_hours, booking_notice_minutes, booking_kind, member_id, booking_type_id, booking_step_minutes, agenda_group, booking_capacity").eq("client_id", client.id).eq("active", true).order("created_at"),
    ]);
    const connections = (conns ?? []) as Connection[];
    const contacts = (people ?? []) as Contact[];
    // Las agendas de visitas y de comerciales son internas del equipo: el asistente no las ve.
    const calendars = ((cals ?? []) as Calendar[]).filter((c) => c.agenda_group !== "visitas" && c.agenda_group !== "comercial");
    const zonePriority: string[] | null = Array.isArray(agent.zone_priority) && agent.zone_priority.length ? agent.zone_priority : null;
    const tools = [
      ...baseTools(contacts),
      ...(zonePriority ? ZONE_TOOLS : []),
      ...(calendars.length ? [agendaTool(calendars)] : []),
      ...(calendars.some((c) => c.booking_enabled) ? [bookingTool(calendars.filter((c) => c.booking_enabled))] : []),
      ...connections.filter((c) => !["consultar_agenda", "reservar_cita"].includes(c.tool_name)).map(connectionTool),
    ];

    const messages: Anthropic.MessageParam[] = (history ?? []).reverse()
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
    while (messages.length && messages[0].role !== "user") messages.shift();

    let knowledge = agent.knowledge;
    for (const s of sources ?? []) {
      knowledge += `\n\n<fuente tipo="${s.kind}" titulo="${s.title.replaceAll('"', "'")}">\n${s.content}\n</fuente>`;
    }
    const system: Anthropic.TextBlockParam[] = [{
      type: "text",
      text: `${agent.system_prompt}\n\n<datos_del_negocio>\n${knowledge.slice(0, MAX_KNOWLEDGE_CHARS)}\n</datos_del_negocio>`,
      cache_control: { type: "ephemeral" },
    }, {
      // Fuera del bloque en caché: cambia con la fecha y la hora.
      type: "text",
      text: todayBlock(),
    }];

    const madeBookings = await bookingsOf(conversationId);
    if (madeBookings.length) {
      system.push({
        type: "text",
        text: "YA RESERVADO en esta conversación (ya lo hiciste con reservar_cita en un mensaje anterior): " +
          madeBookings.map((e) => `${e.title} el ${whenEs(new Date(e.starts_at))}`).join("; ") +
          ". Está hecho y confirmado: NO lo vuelvas a reservar ni lo repitas, no te disculpes ni digas que «antes no estaba guardado». " +
          "Solo si la persona pide cambiar la hora, reserva la nueva.",
      });
    }
    // Teléfono ya dado, validado en código.
    const ph = phoneHint((history ?? []).filter((m) => m.role === "user").map((m) => String(m.content)));
    if (ph) system.push({ type: "text", text: ph });
    // Huecos reales de las llamadas del equipo, calculados aquí: el modelo inventaba horas ocupadas o libres.
    const poolCals = calendars.filter(isPool);
    if (poolCals.length) {
      const nowD = new Date();
      const { data: busyPool } = await db.from("calendar_events").select("calendar_id, starts_at, ends_at, all_day")
        .in("calendar_id", poolCals.map((c) => c.id)).lt("starts_at", new Date(nowD.getTime() + 7 * 86_400_000).toISOString())
        .gt("ends_at", nowD.toISOString()).limit(2000);
      const step = Math.min(...poolCals.map(slotLen));
      const isoF = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" });
      const wdF = new Intl.DateTimeFormat("es-ES", { weekday: "long", timeZone: "Europe/Madrid" });
      const lines: string[] = [];
      for (let i = 0; i < 7 && lines.length < 3; i++) {
        const d = new Date(nowD.getTime() + i * 86_400_000);
        const day = isoF.format(d);
        const free = poolSlots(poolCals, day, busyPool ?? []);
        if (free.length) lines.push(`${wdF.format(d)} ${day}: ${squash(free, step)}`);
      }
      const todayIso = isoF.format(nowD);
      const firstDay = lines[0]?.split(" ")[1]?.replace(":", "") ?? "";
      const notToday = !!lines.length && firstDay !== todayIso;
      system.push({
        type: "text",
        text: "HUECOS REALES PARA LLAMAR (los calcula el sistema ahora mismo; es la ÚNICA fuente de verdad):\n" +
          (lines.length ? lines.join("\n") : "ninguno en los próximos días") +
          "\nCÓMO PROGRAMAR LA LLAMADA: el orden de la conversación no cambia (primero charla, casa/negocio, pueblo o ciudad y provincia, y nombre y teléfono juntos). SOLO cuando ya tengas pueblo, nombre y teléfono (y no antes) NO preguntes si quiere que le llamen ni le ofrezcas una hora concreta: pregunta, con tus palabras, «¿A qué hora te viene bien que te llamemos: por la mañana, por la tarde o ahora mismo?». En cuanto conteste, reserva con reservar_cita usando franja_desde y franja_hasta (el sistema elige el hueco exacto dentro de la franja). Franjas: «ahora mismo» → desde la primera hora libre de la lista hasta una hora después; «por la mañana» → 09:30 a 10:30; «por la tarde» → 16:00 a 18:00; una hora concreta («a las 4») → esa hora hasta una hora después; «entre las 4 y las 5» → tal cual. El día lo eliges tú: hoy si la franja aún no ha pasado y en la lista hay huecos dentro de ella; si no, el siguiente día de la lista. " +
          (notToday ? "HOY NO SE PUEDE LLAMAR (fuera de horario, festivo o sin huecos): díselo claro («ahora mismo no te puedo llamar; el horario es …») y usa el primer día de la lista. " : "Hoy sí hay huecos. ") +
          "Al confirmar, di SOLO la franja («Te llamará una compañera entre las 16:00 y las 17:00»), nunca la hora exacta ni «apuntado: … a las 16:05». Si el sistema dice que en esa franja no hay hueco, mira la lista y ofrece otra franja; no digas que algo está ocupado si en la lista hay horas libres dentro de esa franja. Nunca digas «no tengo acceso a esa hora».",
      });
    }
    let text = "";
    const done = new Set<string>(madeBookings.length ? ["reservar_cita"] : []);
    let nudged = false;
    let forceTool = false;
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const response = await anthropic.messages.create({
        model: agent.model, max_tokens: agent.max_output_tokens, system, tools, messages,
        // Sonnet 5.5 no admite tool_choice "any": el aviso interno de arriba basta (si no, el chat falla con 400).
      });
      forceTool = false;
      await db.from("usage_events").insert({
        client_id: client.id, conversation_id: conversationId, model: agent.model,
        input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens,
        cache_read_tokens: response.usage.cache_read_input_tokens ?? 0,
        cache_write_tokens: response.usage.cache_creation_input_tokens ?? 0,
        cost_usd: costUsd(agent.model, response.usage),
      });
      if (response.stop_reason === "refusal") throw new Error("La IA ha rechazado la petición");

      text = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text).join("\n").trim() || text;
      const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      // Red de seguridad: si dice que ya está apuntado sin haber llamado a la herramienta, se le obliga a hacerlo.
      if (response.stop_reason !== "tool_use" && !nudged && round < MAX_TOOL_ROUNDS && !done.has("reservar_cita") && !done.has("guardar_contacto")
        && calendars.some((c) => c.booking_enabled) && /\bapuntad[oa]\b|te (llama|llamar[aá]|llamamos)\b.{0,40}\b(a las|\d{1,2}:\d{2})/i.test(text)) {
        nudged = true;
        forceTool = true; // en la siguiente vuelta tiene que usar una herramienta, no puede volver a contestar solo con texto
        messages.push({ role: "assistant", content: response.content });
        messages.push({ role: "user", content: "[Sistema: todavía no has reservado nada con reservar_cita, así que la persona NO tiene la llamada apuntada. Si tienes día, hora, nombre y teléfono, reserva ahora con la herramienta y confirma solo si te devuelve que se ha reservado. Si te falta algo, pídelo sin decir que está apuntado. No menciones este aviso.]" });
        continue;
      }
      if (response.stop_reason !== "tool_use" || !toolUses.length || round === MAX_TOOL_ROUNDS) break;

      messages.push({ role: "assistant", content: response.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const use of toolUses) {
        try {
          const content = await runTool(use.name, use.input as Record<string, string>, client.id, conversationId, connections, contacts, calendars, zonePriority);
          results.push({ type: "tool_result", tool_use_id: use.id, content });
          if (!/^(error|no se ha|no se pudo|ese hueco)/i.test(String(content))) done.add(use.name);
        } catch (err) {
          results.push({ type: "tool_result", tool_use_id: use.id, content: `Error: ${err}`, is_error: true });
        }
      }
      messages.push({ role: "user", content: results });
    }
    if (!text) throw new Error("Respuesta vacía de la IA");
    reply = cleanReply(text, agent.banned_phrases ?? null);
  } catch (err) {
    // Plan B: mensaje cortés, el mensaje queda como lead pendiente y se registra el error.
    failed = true;
    reply = agent.fallback_message;
    const detail = err instanceof Anthropic.APIError ? `${err.status} ${err.message}` : String(err);
    await db.from("error_log").insert({
      client_id: client.id, conversation_id: conversationId, source: "chat", message: detail.slice(0, 1000),
    });
    await db.from("leads").insert({
      client_id: client.id, conversation_id: conversationId, status: "pending",
      reason: `Sin respuesta de la IA. Escribió: ${message.slice(0, 300)}`,
    });
  }

  await db.from("messages").insert({
    client_id: client.id, conversation_id: conversationId, role: "assistant", content: reply,
  });
  await db.from("conversations")
    .update({ message_count: conversation!.message_count + 2, last_message_at: new Date().toISOString() })
    .eq("id", conversationId);

  return json({ conversation_id: conversationId, reply, failed });
});
