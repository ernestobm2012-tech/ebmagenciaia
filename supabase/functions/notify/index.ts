// Avisa por correo cuando entra un contacto (lead), un paso a humano o un
// mensaje del formulario de la web. La llama la base de datos al insertar la
// fila. Solo recibe { kind, id }: los datos los lee ella misma, y marca la fila
// como avisada para no enviar dos veces aunque la llamen de nuevo.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const PANEL_URL = Deno.env.get("PANEL_URL") ?? "https://ernestobm2012-tech.github.io/ebmagenciaia/admin/";
// Remitente provisional: gestionmypadel.com es el dominio verificado en Resend
// hasta que la agencia tenga el suyo (entonces basta con definir NOTIFY_FROM).
const FROM = Deno.env.get("NOTIFY_FROM") ?? "EBM Agencia IA <avisos@gestionmypadel.com>";

const TABLES: Record<string, string> = { lead: "leads", handoff: "handoffs", contact: "contact_messages" };
const CHANNELS: Record<string, string> = { web: "chat web", phone: "teléfono", whatsapp: "WhatsApp", instagram: "Instagram", email: "correo" };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

function layout(title: string, rows: [string, unknown][], footer: string) {
  const lines = rows.filter(([, v]) => v).map(([k, v]) =>
    `<tr><td style="padding:6px 16px 6px 0;color:#5E6C7A;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:6px 0;color:#242F3D">${esc(v).replace(/\n/g, "<br>")}</td></tr>`).join("");
  return `<div style="font-family:Lato,Arial,sans-serif;font-size:15px;line-height:1.5;color:#242F3D;max-width:560px">
<h2 style="font-size:19px;margin:0 0 12px">${esc(title)}</h2>
<table style="border-collapse:collapse">${lines}</table>
<p style="margin:18px 0 0"><a href="${PANEL_URL}" style="color:#1483DC">Abrir el panel</a></p>
<p style="margin:18px 0 0;color:#5E6C7A;font-size:13px">${esc(footer)}</p></div>`;
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

  if (kind === "contact") {
    const { data: admins } = await db.from("profiles").select("email").eq("role", "admin");
    to = (admins ?? []).map((a) => a.email).filter(Boolean);
    subject = `Nuevo mensaje de la web: ${row.name}`;
    html = layout("Nuevo mensaje del formulario de la web", [
      ["Nombre", row.name], ["Correo", row.email], ["Teléfono", row.phone], ["Interés", row.service], ["Mensaje", row.message],
    ], "Aviso automático de la web de EBM.");
  } else {
    const [{ data: client }, { data: contacts }, { data: conv }] = await Promise.all([
      db.from("clients").select("name, status, contact_email").eq("id", row.client_id).maybeSingle(),
      db.from("notify_contacts").select("id, email").eq("client_id", row.client_id).eq("active", true),
      row.conversation_id
        ? db.from("conversations").select("channel, summary").eq("id", row.conversation_id).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
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
    if (kind === "lead") {
      subject = `Nuevo contacto por ${channel}: ${row.name ?? "sin nombre"}`;
      html = layout(`Nuevo contacto en ${client?.name ?? ""}`, [
        ["Nombre", row.name], ["Contacto", row.contact], ["Qué necesita", row.reason], ["Canal", channel],
        ["Resumen", conv?.summary], ["Demo: en real iría a", demoNote],
      ], footer);
    } else {
      subject = `Una conversación necesita a una persona (${channel})`;
      html = layout(`Atención: conversación para revisar en ${client?.name ?? ""}`, [
        ["Motivo", row.reason], ["Canal", channel], ["Demo: en real iría a", demoNote],
      ], footer);
    }
    if (demoNote) subject = `[DEMO] ${subject}`;
  }

  let status = "failed";
  let detail = "Sin destinatarios: añade a alguien en 'A quién avisar'.";
  if (to.length) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, to, subject, html }),
    });
    status = res.ok ? "sent" : "failed";
    detail = res.ok ? "" : `Resend respondió ${res.status}: ${(await res.text()).slice(0, 300)}`;
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
