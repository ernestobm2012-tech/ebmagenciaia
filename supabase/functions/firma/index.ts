// Firma de propuestas por el cliente desde ebmagenciaia.es/firmar.html?t=<token>.
//   POST {action: "get", token}  -> datos de la propuesta y enlace al PDF (1 hora)
//   POST {action: "sign", token, ...datos, signature_png} -> firma
// Al firmar: se añade al PDF original una hoja de aceptación (datos de quien firma,
// su firma y la de Ernesto (app_assets «firma_ebm»), fecha, IP, navegador y huella
// SHA-256 del PDF original), se guarda en
// Documentos como «contrato», se sube a Google Drive (función google-drive, carpeta
// del cliente › Contratos) y se avisa por correo a EBM y a quien firma (función mail).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SUPABASE_URL, SERVICE_KEY);
const BUCKET = "client-docs";
// A dónde llega el aviso de propuesta firmada.
const NOTIFY_TO = (Deno.env.get("SIGN_NOTIFY_TO") ?? "info@ebmagenciaia.es,ebermejo@ebmagenciaia.es").split(",").map((s) => s.trim()).filter(Boolean);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const clean = (v: unknown, max = 200) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const safeName = (name: string) => name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\w.-]+/g, "_");
// Las fuentes estándar del PDF solo saben escribir el juego de caracteres de Windows (WinAnsi).
const pdfText = (s: string) => s.replace(/[^\x20-\x7E\u00A0-\u00FF€‘’“”–—…•]/g, "");

async function sha256(bytes: Uint8Array) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...hash].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function madrid(d: Date) {
  return new Intl.DateTimeFormat("es-ES", {
    timeZone: "Europe/Madrid", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(d);
}

async function load(token: string) {
  if (!/^[0-9a-f]{32,64}$/.test(token)) return null;
  const { data } = await db.from("signature_requests")
    .select("*, clients(id, name, contact_name, contact_email, contact_email_alt, contact_phone), client_documents!signature_requests_document_id_fkey(id, name, storage_path)")
    .eq("token", token).maybeSingle();
  return data;
}

async function getInfo(token: string) {
  const r = await load(token);
  if (!r || r.status === "cancelled") return json({ error: "Este enlace no es válido. Pide a EBM uno nuevo." }, 404);
  const base = { client: r.clients?.name ?? "", document: r.client_documents?.name ?? "Propuesta" };
  if (r.status === "signed") return json({ ...base, status: "signed", signed_at: r.signed_at, signer_name: r.signer_name });
  if (new Date(r.expires_at) < new Date()) return json({ error: "Este enlace ha caducado. Pide a EBM uno nuevo." }, 410);
  const { data: url } = await db.storage.from(BUCKET).createSignedUrl(r.client_documents.storage_path, 3600);
  return json({
    ...base, status: "pending", pdf_url: url?.signedUrl ?? null,
    prefill: { company_name: r.clients?.name ?? "", signer_name: r.clients?.contact_name ?? "", signer_email: r.clients?.contact_email_alt || r.clients?.contact_email || "", signer_phone: r.clients?.contact_phone ?? "" },
  });
}

// Hoja final con la aceptación, la firma y las evidencias.
async function acceptancePage(original: Uint8Array, d: Record<string, string>, png: Uint8Array, ebmPng: Uint8Array | null) {
  const pdf = await PDFDocument.load(original, { ignoreEncryption: true });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const first = pdf.getPage(0).getSize();
  const page = pdf.addPage([first.width, first.height]);
  const { width, height } = page.getSize();
  const M = 56;
  const navy = rgb(0.07, 0.16, 0.29);
  const soft = rgb(0.37, 0.42, 0.48);
  const blue = rgb(0.08, 0.51, 0.86);
  let y = height - M;

  const lines = (text: string, size: number, f = font, maxW = width - 2 * M) => {
    const out: string[] = [];
    for (const para of pdfText(text).split("\n")) {
      let line = "";
      for (const word of para.split(" ")) {
        const next = line ? `${line} ${word}` : word;
        if (f.widthOfTextAtSize(next, size) > maxW && line) { out.push(line); line = word; } else line = next;
      }
      out.push(line);
    }
    return out;
  };
  const write = (text: string, size = 10.5, f = font, color = navy, gap = 4) => {
    for (const l of lines(text, size, f)) {
      page.drawText(l, { x: M, y: y - size, size, font: f, color });
      y -= size + gap;
    }
  };

  page.drawRectangle({ x: 0, y: height - 6, width, height: 6, color: blue });
  write("Aceptación de la propuesta", 20, bold, navy, 8);
  write(`${d.document} · ${d.client}`, 11, font, soft, 4);
  y -= 14;
  write(`${d.signer_name}, con DNI/NIE ${d.signer_nif}${d.signer_role ? `, como ${d.signer_role}` : ""}${d.company_name ? ` de ${d.company_name}` : ""}${d.company_cif ? ` (CIF ${d.company_cif})` : ""}, declara que ha leído la propuesta de las páginas anteriores y acepta sus condiciones, precios y servicios tal y como figuran en ella. EBM Agencia IA (Ernesto Bermejo, NIF 47498439N) se compromete a prestarlos en esas mismas condiciones.`, 11, font, navy, 5);
  y -= 16;

  const rows: [string, string][] = [
    ["Empresa", [d.company_name, d.company_cif].filter(Boolean).join(" · ") || "—"],
    ["Firmante", `${d.signer_name} · ${d.signer_nif}`],
    ["Cargo", d.signer_role || "—"],
    ["Correo", d.signer_email || "—"],
    ["Teléfono", d.signer_phone || "—"],
    ["Fecha y hora", `${d.when} (hora de Madrid)`],
  ];
  for (const [k, v] of rows) {
    page.drawText(pdfText(k), { x: M, y: y - 10, size: 9.5, font: bold, color: soft });
    const vl = lines(v, 10.5, font, width - 2 * M - 110);
    vl.forEach((l, i) => page.drawText(l, { x: M + 110, y: y - 10 - i * 14, size: 10.5, font, color: navy }));
    y -= Math.max(1, vl.length) * 14 + 6;
  }
  y -= 14;

  // Dos firmas: la del cliente y la de EBM (si está guardada en app_assets).
  const boxW = (width - 2 * M - 24) / 2, boxH = 110;
  const box = async (x: number, title: string, sigPng: Uint8Array | null, name: string, sub: string) => {
    page.drawText(pdfText(title), { x, y: y - 10, size: 9.5, font: bold, color: soft });
    const top = y - 18;
    page.drawRectangle({ x, y: top - boxH, width: boxW, height: boxH, borderColor: rgb(0.88, 0.91, 0.93), borderWidth: 1 });
    if (sigPng) {
      const img = await pdf.embedPng(sigPng);
      const scale = Math.min((boxW - 16) / img.width, (boxH - 16) / img.height);
      page.drawImage(img, { x: x + (boxW - img.width * scale) / 2, y: top - boxH + (boxH - img.height * scale) / 2, width: img.width * scale, height: img.height * scale });
    }
    lines(name, 10.5, font, boxW).forEach((l, i) => page.drawText(l, { x, y: top - boxH - 16 - i * 13, size: 10.5, font, color: navy }));
    lines(sub, 9, font, boxW).forEach((l, i) => page.drawText(l, { x, y: top - boxH - 30 - i * 12, size: 9, font, color: soft }));
  };
  await box(M, "Por el cliente", png, d.typed_name, [d.signer_nif, d.signer_role, d.company_name].filter(Boolean).join(" · "));
  await box(M + boxW + 24, "Por EBM Agencia IA", ebmPng, "Ernesto Bermejo", "NIF 47498439N · EBM Agencia IA");
  y -= 18 + boxH + 30 + 12 + 30;

  write("Evidencias de la firma electrónica", 9.5, bold, soft, 4);
  write(`Firmado desde el enlace personal enviado por EBM Agencia IA. IP: ${d.ip || "desconocida"}. Navegador: ${d.user_agent || "desconocido"}.`, 8.5, font, soft, 3);
  write(`Huella SHA-256 de la propuesta original: ${d.doc_sha256}`, 8.5, font, soft, 3);
  write("EBM Agencia IA · Ernesto Bermejo · NIF 47498439N · ebmagenciaia.es", 8.5, font, soft, 3);

  pdf.setTitle(pdfText(`${d.document} (firmada)`));
  pdf.setAuthor("EBM Agencia IA");
  return await pdf.save();
}

async function sign(req: Request, body: Record<string, unknown>) {
  const r = await load(clean(body.token, 80));
  if (!r || r.status === "cancelled") return json({ error: "Este enlace no es válido." }, 404);
  if (r.status === "signed") return json({ ok: true, already: true });
  if (new Date(r.expires_at) < new Date()) return json({ error: "Este enlace ha caducado." }, 410);

  const d = {
    signer_name: clean(body.signer_name, 120), signer_nif: clean(body.signer_nif, 20).toUpperCase(),
    signer_role: clean(body.signer_role, 80), company_name: clean(body.company_name, 160),
    company_cif: clean(body.company_cif, 20).toUpperCase(), signer_email: clean(body.signer_email, 160).toLowerCase(),
    signer_phone: clean(body.signer_phone, 30), typed_name: clean(body.typed_name, 120),
  };
  if (!d.signer_name || !d.signer_nif || !d.typed_name) return json({ error: "Faltan tu nombre, tu DNI o el nombre bajo la firma." }, 400);
  if (d.signer_email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.signer_email)) return json({ error: "El correo no parece correcto." }, 400);
  if (body.accept !== true) return json({ error: "Tienes que marcar que aceptas la propuesta." }, 400);
  const sig = String(body.signature_png ?? "");
  const m = sig.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!m || sig.length > 600_000) return json({ error: "Falta la firma." }, 400);
  const png = Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0));

  // Se reserva la solicitud para que dos envíos a la vez no generen dos firmas.
  const { data: claimed } = await db.from("signature_requests").update({ status: "signed", signed_at: new Date().toISOString() })
    .eq("id", r.id).eq("status", "pending").select("id, signed_at").maybeSingle();
  if (!claimed) return json({ ok: true, already: true });

  try {
    const { data: blob, error } = await db.storage.from(BUCKET).download(r.client_documents.storage_path);
    if (error || !blob) throw new Error("No se pudo leer la propuesta.");
    const original = new Uint8Array(await blob.arrayBuffer());
    const docSha = await sha256(original);
    const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
    const ua = clean(body.user_agent || req.headers.get("user-agent"), 300);
    const when = madrid(new Date(claimed.signed_at));
    const { data: asset } = await db.from("app_assets").select("value").eq("key", "firma_ebm").maybeSingle();
    const ebm = String(asset?.value ?? "").match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
    const ebmPng = ebm ? Uint8Array.from(atob(ebm[1]), (c) => c.charCodeAt(0)) : null;
    const signed = await acceptancePage(original, {
      ...d, ip, user_agent: ua, when, doc_sha256: docSha,
      document: r.client_documents.name, client: r.clients?.name ?? "",
    }, png, ebmPng);

    const name = `${r.client_documents.name} (firmada)`;
    const path = `${r.client_id}/${crypto.randomUUID()}-${safeName(name)}.pdf`;
    const { error: upErr } = await db.storage.from(BUCKET).upload(path, signed, { contentType: "application/pdf" });
    if (upErr) throw upErr;
    const { data: doc, error: docErr } = await db.from("client_documents").insert({
      client_id: r.client_id, name, kind: "contrato", storage_path: path, size_bytes: signed.length,
      notes: `Firmada por ${d.signer_name} el ${when}.`, created_by: null,
    }).select("id").single();
    if (docErr) throw docErr;

    await db.from("signature_requests").update({
      ...d, signature_png: sig, ip, user_agent: ua, doc_sha256: docSha, signed_document_id: doc.id,
    }).eq("id", r.id);

    // Google Drive: si falla, queda apuntado y se puede reintentar desde el panel.
    let driveId: string | null = null, driveError: string | null = null;
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/google-drive?action=upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ document_id: doc.id, folder: "Contratos" }),
      });
      const out = await res.json().catch(() => ({}));
      if (res.ok && out.id) driveId = out.id; else driveError = out.error ?? `HTTP ${res.status}`;
    } catch (e) {
      driveError = e instanceof Error ? e.message : String(e);
    }
    await db.from("signature_requests").update({ drive_file_id: driveId, drive_error: driveError }).eq("id", r.id);

    // Correos: aviso a EBM y copia a quien firma, los dos con el PDF firmado.
    const hello = d.signer_name.split(" ")[0];
    await db.from("outgoing_mail").insert([
      {
        account: "ebermejo", mode: "send", to_addr: NOTIFY_TO, client_id: r.client_id, document_ids: [doc.id],
        subject: `Propuesta firmada: ${r.clients?.name ?? ""}`,
        body_html: `<p><b>${esc(d.signer_name)}</b>${d.signer_role ? ` (${esc(d.signer_role)})` : ""} ha firmado «${esc(r.client_documents.name)}» de <b>${esc(r.clients?.name ?? "")}</b> el ${esc(when)}.</p><p>Te adjunto el PDF firmado. Ya está en el panel (Documentos del cliente)${driveId ? " y en Google Drive, en la carpeta del cliente › Contratos" : `. No se pudo subir a Google Drive: ${esc(driveError ?? "")}`}.</p>`,
      },
      ...(d.signer_email ? [{
        account: "ebermejo", mode: "send", to_addr: [d.signer_email], client_id: r.client_id, document_ids: [doc.id],
        subject: `Propuesta aceptada · EBM Agencia IA`,
        body_html: `<p>Hola, ${esc(hello)}:</p><p>Muchas gracias por la confianza. Te adjunto la propuesta con tu firma para que la tengas guardada.</p><p>En breve me pongo en contacto contigo para empezar.</p><p>Un saludo,</p>`,
      }] : []),
    ]);
    return json({ ok: true });
  } catch (err) {
    // Si algo falla, la solicitud vuelve a quedar pendiente para poder firmar otra vez.
    await db.from("signature_requests").update({ status: "pending", signed_at: null }).eq("id", r.id);
    throw err;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  try {
    if (body.action === "get") return await getInfo(clean(body.token, 80));
    if (body.action === "sign") return await sign(req, body);
    return json({ error: "Acción desconocida" }, 400);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.from("error_log").insert({ source: "firma", message: message.slice(0, 1000) });
    return json({ error: "No se ha podido guardar la firma. Inténtalo de nuevo en un momento." }, 500);
  }
});
