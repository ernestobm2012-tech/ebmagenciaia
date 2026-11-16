// Avisa por correo cuando entra un contacto (lead), un paso a humano o un
// mensaje del formulario de la web. La llama la base de datos al insertar la
// fila. Solo recibe { kind, id }: los datos los lee ella misma, y marca la fila
// como avisada para no enviar dos veces aunque la llamen de nuevo.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const PANEL_URL = Deno.env.get("PANEL_URL") ?? "https://ebmagenciaia.es/admin/";
// Remitente: info@ebmagenciaia.es (dominio verificado en Resend). Se puede cambiar con
// el secreto NOTIFY_FROM.
const FROM = Deno.env.get("NOTIFY_FROM") ?? "EBM Agencia IA <info@ebmagenciaia.es>";

const TABLES: Record<string, string> = { lead: "leads", handoff: "handoffs", contact: "contact_messages" };
const CHANNELS: Record<string, string> = { web: "chat web", phone: "teléfono", whatsapp: "WhatsApp", instagram: "Instagram", email: "correo" };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

function layout(title: string, rows: [string, unknown][], footer: string, extra = "") {
  const lines = rows.filter(([, v]) => v).map(([k, v]) =>
    `<tr><td style="padding:6px 16px 6px 0;color:#5E6C7A;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:6px 0;color:#242F3D">${esc(v).replace(/\n/g, "<br>")}</td></tr>`).join("");
  return `<div style="font-family:Lato,Arial,sans-serif;font-size:15px;line-height:1.5;color:#242F3D;max-width:560px">
<h2 style="font-size:19px;margin:0 0 12px">${esc(title)}</h2>
<table style="border-collapse:collapse">${lines}</table>${extra}
<p style="margin:18px 0 0"><a href="${PANEL_URL}" style="color:#1483DC">Abrir el panel</a></p>
<p style="margin:18px 0 0;color:#5E6C7A;font-size:13px">${esc(footer)}</p></div>`;
}

// Teléfono para wa.me y tel:. Nueve cifras españolas → +34. Con prefijo (+ o 00),
// tal cual. Si no parece un teléfono, nada. WhatsApp no se ofrece para fijos.
function phoneOf(contact: unknown): string | null {
  const raw = String(contact ?? "");
  if (/@/.test(raw) && !/\d{9}/.test(raw.replace(/[\s.-]/g, ""))) return null;
  const m = raw.match(/(\+|00)?[\d\s.-]{9,18}/);
  if (!m) return null;
  const d = m[0].replace(/\D/g, "");
  if (m[1]) return d.replace(/^00/, "");
  if (/^[6789]\d{8}$/.test(d)) return "34" + d;
  if (/^34[6789]\d{8}$/.test(d)) return d;
  return null;
}

const button = (href: string, label: string, color: string) =>
  `<a href="${esc(href)}" style="display:inline-block;margin:0 8px 8px 0;padding:10px 18px;border-radius:999px;background:${color};color:#fff;text-decoration:none;font-weight:bold">${esc(label)}</a>`;

// La conversación entera (hasta 30 mensajes) para leerla sin abrir el panel.
function transcript(msgs: { role: string; content: string }[], agentName: string) {
  if (!msgs.length) return "";
  const items = msgs.map((m) => {
    const me = m.role === "assistant";
    return `<div style="margin:0 0 8px;${me ? "" : "text-align:right"}"><div style="display:inline-block;max-width:85%;text-align:left;padding:8px 12px;border-radius:12px;background:${me ? "#F1F4F7" : "#E3F1FC"}"><div style="font-size:12px;color:#5E6C7A">${me ? esc(agentName) : "Cliente"}</div>${esc(m.content).replace(/\n/g, "<br>")}</div></div>`;
  }).join("");
  return `<h3 style="font-size:16px;margin:22px 0 10px">La conversación</h3>${items}`;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return json({ error: "Falta el secreto RESEND_API_KEY en Supabase." }, 503);

  const { kind, id } = await req.json().catch(() => ({}));
  const table = TABLES[kind];
  if (!table || typeof id !== "string") return json({ error: "invalid_request" }, 400);

  // Reserva el aviso: si ya estaba marcado, otra llamada lo envió.
  const { data: row } = await db.from(table).update({ notified_at: new Date().toISOString() })
    .eq("id", id).is("notified_at", null).select("*").maybeSingle();
  if (!row) return json({ skipped: true });

  let to: string[] = [];
  let subject = "";
  let html = "";
  let demoNote = "";
  let from = FROM;
  let replyTo: string | undefined;
  let pushText: { title: string; body: string } | null = null;

  if (kind === "contact") {
    const { data: admins } = await db.from("profiles").select("email").eq("role", "admin");
    to = (admins ?? []).map((a) => a.email).filter(Boolean);
    subject = `Nuevo mensaje de la web: ${row.name}`;
    html = layout("Nuevo mensaje del formulario de la web", [
      ["Nombre", row.name], ["Correo", row.email], ["Teléfono", row.phone], ["Interés", row.service], ["Mensaje", row.message],
    ], "Aviso automático de la web de EBM.");
  } else {
    const [{ data: client }, { data: contacts }, { data: conv }, { data: msgs }] = await Promise.all([
      db.from("clients").select("name, status, contact_email").eq("id", row.client_id).maybeSingle(),
      db.from("notify_contacts").select("id, email").eq("client_id", row.client_id).eq("active", true),
      row.conversation_id
        ? db.from("conversations").select("channel, summary, agents(name)").eq("id", row.conversation_id).maybeSingle()
        : Promise.resolve({ data: null }),
      row.conversation_id
        ? db.from("messages").select("role, content").eq("conversation_id", row.conversation_id)
          .in("role", ["user", "assistant"]).order("created_at", { ascending: false }).limit(30)
        : Promise.resolve({ data: [] }),
    ]);
    // El correo del cliente sale con el nombre de su negocio, no con el de EBM
    // (misma dirección verificada en Resend).
    if (client?.name) from = `${client.name.replace(/[<>"]/g, "")} <${FROM.match(/<([^>]+)>/)?.[1] ?? FROM}>`;
    // Si el agente eligió a una persona, solo a ella; si no, a todas las activas.
    const chosen = (contacts ?? []).filter((c) => c.id === row.notify_contact_id);
    to = (chosen.length ? chosen : contacts ?? []).map((c) => c.email);
    if (!to.length && client?.contact_email) to = [client.contact_email];
    // Cliente en demo: el aviso va solo a los administradores de EBM, para no
    // escribir a su equipo durante las pruebas.
    if (client?.status === "demo") {
      const { data: admins } = await db.from("profiles").select("email").eq("role", "admin");
      demoNote = to.join(", ") || "nadie (sin destinatarios)";
      to = (admins ?? []).map((a) => a.email).filter(Boolean);
    }
    const channel = CHANNELS[conv?.channel ?? ""] ?? "el agente";
    const footer = `Aviso automático del asistente de ${client?.name ?? "tu negocio"}.`;
    // deno-lint-ignore no-explicit-any
    const agentName = (conv as any)?.agents?.name ?? "Asistente";
    const chat = transcript([...(msgs ?? [])].reverse(), agentName);
    if (kind === "lead") {
      subject = `${agentName}: ${row.name ?? "alguien"} quiere hablar contigo`;
      pushText = { title: subject, body: [row.contact, row.reason].filter(Boolean).join(" · ").slice(0, 180) };
      const phone = phoneOf(row.contact);
      const mail = String(row.contact ?? "").match(/[^\s<>@]+@[^\s<>@]+\.[a-z]{2,}/i)?.[0];
      if (mail) replyTo = mail;
      const first = String(row.name ?? "").trim().split(/\s+/)[0];
      const hello = `Hola${first ? " " + first : ""}, te escribo de ${client?.name ?? "nuestro negocio"} por la consulta que nos dejaste en la web.`;
      const buttons = [
        phone && !/^34[89]/.test(phone) && button(`https://wa.me/${phone}?text=${encodeURIComponent(hello)}`, "Responder por WhatsApp", "#25A35A"),
        phone && button(`tel:+${phone}`, "Llamar", "#1483DC"),
        mail && button(`mailto:${mail}`, "Responder por correo", "#1483DC"),
      ].filter(Boolean).join("");
      html = layout(`Nuevo contacto en ${client?.name ?? ""}`, [
        ["Nombre", row.name], ["Contacto", row.contact], ["Qué necesita", row.reason], ["Canal", channel],
        ["Resumen", conv?.summary], ["Demo: en real iría a", demoNote],
      ], footer, (buttons ? `<p style="margin:18px 0 0">${buttons}</p>` : "") + chat);
    } else {
      subject = `Una conversación necesita a una persona (${channel})`;
      pushText = { title: `${agentName}: una conversación necesita a una persona`, body: String(row.reason ?? "").slice(0, 180) };
      html = layout(`Atención: conversación para revisar en ${client?.name ?? ""}`, [
        ["Motivo", row.reason], ["Canal", channel], ["Demo: en real iría a", demoNote],
      ], footer, chat);
    }
    if (demoNote) subject = `[DEMO] ${subject}`;
  }

  let status = "failed";
  let detail = "Sin destinatarios: añade a alguien en 'A quién avisar'.";
  if (to.length) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, subject, html, ...(replyTo ? { reply_to: replyTo } : {}) }),
    });
    status = res.ok ? "sent" : "failed";
    detail = res.ok ? "" : `Resend respondió ${res.status}: ${(await res.text()).slice(0, 300)}`;
  }

  // Negocios con web propia (p. ej. Mi Pequeño Rincón): aviso al móvil desde SU
  // panel. Si falla, el correo ya ha salido igual.
  if (row.client_id && pushText) {
    const { data: integ } = await db.from("client_integrations").select("webhook_url, token")
      .eq("client_id", row.client_id).maybeSingle();
    if (integ?.webhook_url) {
      await fetch(integ.webhook_url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-integration-token": integ.token },
        body: JSON.stringify({ action: "push", ...pushText, conversation_id: row.conversation_id ?? null }),
        signal: AbortSignal.timeout(8000),
      }).catch(() => {});
    }
  }

  if (row.client_id) {
    await db.from("notifications").insert({
      client_id: row.client_id, conversation_id: row.conversation_id ?? null, subject, body: to.join(", "), status,
    });
  }
  if (status === "failed") {
    // Se libera la marca para poder reintentar cuando se arregle la causa.
    await db.from(table).update({ notified_at: null }).eq("id", id);
    await db.from("error_log").insert({ client_id: row.client_id ?? null, source: "notify", message: detail });
    return json({ error: detail }, 502);
  }
  return json({ sent: to.length });
});
