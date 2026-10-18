// Prepara correos desde los buzones de DonDominio (ebermejo@ e info@ebmagenciaia.es).
// La llama la base de datos al insertar una fila en `outgoing_mail` y solo recibe
// { id }: los datos los lee ella misma y marca la fila para no repetirla.
//   mode = 'draft' -> deja el correo en Borradores por IMAP (sale en Outlook)
//   mode = 'send'  -> lo envía por SMTP (465, Supabase no deja salir por 587)
//                     y guarda la copia en Enviados
// Añade la firma de la cuenta y adjunta los PDF de `client_documents`.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const IMAP_HOST = "imap.dondominio.com";
const SMTP_HOST = "smtp.dondominio.com";

const signature = (name: string, email: string) => `
<table cellpadding="0" cellspacing="0" border="0" style="font-family:Lato,Calibri,Arial,sans-serif;font-size:14px;line-height:1.45;color:#242F3D;border-collapse:collapse;">
  <tr>
    <td style="padding:0 18px 0 0;vertical-align:middle;">
      <a href="https://ebmagenciaia.es" style="text-decoration:none;"><img src="https://ebmagenciaia.es/assets/firma-ebm-logo.png" width="170" alt="EBM Agencia IA" style="display:block;border:0;width:170px;height:auto;"></a>
    </td>
    <td style="padding:0 0 0 18px;border-left:3px solid #1483DC;vertical-align:middle;">
      <div style="font-size:18px;font-weight:bold;color:#242F3D;">${name}</div>
      <div style="font-size:13px;color:#5E6C7A;padding:0 0 8px 0;">Webs, software y agentes de IA para tu negocio</div>
      <div style="font-size:14px;color:#242F3D;"><a href="tel:+34698935800" style="color:#1483DC;text-decoration:none;font-weight:bold;">698 935 800</a> &nbsp;·&nbsp; <a href="mailto:${email}" style="color:#1483DC;text-decoration:none;">${email}</a></div>
      <div style="font-size:14px;color:#242F3D;"><a href="https://ebmagenciaia.es" style="color:#1483DC;text-decoration:none;">ebmagenciaia.es</a> &nbsp;·&nbsp; Instagram <a href="https://instagram.com/ebmagenciaia" style="color:#1483DC;text-decoration:none;">@ebmagenciaia</a></div>
    </td>
  </tr>
</table>`;

const ACCOUNTS: Record<string, { email: string; name: string; secret: string }> = {
  ebermejo: { email: "ebermejo@ebmagenciaia.es", name: "Ernesto Bermejo", secret: "MAIL_EBERMEJO_PASSWORD" },
  info: { email: "info@ebmagenciaia.es", name: "EBM Agencia IA", secret: "MAIL_INFO_PASSWORD" },
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const wrap = (s: string) => s.replace(/.{1,76}/g, "$&\r\n");
// Cabecera con tildes (RFC 2047).
const word = (s: string) => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(enc.encode(s))}?=`;
const addr = (name: string, email: string) => `${word(name)} <${email}>`;

const toText = (html: string) =>
  html.replace(/<(br|\/p|\/div|\/tr|\/h\d|\/li)[^>]*>/gi, "\n").replace(/<li[^>]*>/gi, "- ").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

function buildMessage(from: string, to: string[], cc: string[], subject: string, html: string,
  files: { name: string; data: Uint8Array }[]) {
  const id = crypto.randomUUID();
  const alt = `alt-${id}`, mix = `mix-${id}`;
  const page = `<!doctype html><html><head><meta charset="utf-8"></head><body style="font-family:Lato,Calibri,Arial,sans-serif;font-size:15px;line-height:1.55;color:#242F3D;">${html}</body></html>`;
  const head = [
    `From: ${from}`,
    `To: ${to.join(", ")}`,
    ...(cc.length ? [`Cc: ${cc.join(", ")}`] : []),
    `Subject: ${word(subject)}`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${id}@ebmagenciaia.es>`,
    "MIME-Version: 1.0",
  ];
  const body = [
    `--${alt}`, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "",
    wrap(b64(enc.encode(toText(html)))),
    `--${alt}`, "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: base64", "",
    wrap(b64(enc.encode(page))),
    `--${alt}--`,
  ].join("\r\n");
  if (!files.length) return [...head, `Content-Type: multipart/alternative; boundary="${alt}"`, "", body].join("\r\n");
  const parts = files.map((f) => [
    `--${mix}`, `Content-Type: application/pdf; name="${word(f.name)}"`, "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${word(f.name)}"`, "", wrap(b64(f.data)),
  ].join("\r\n"));
  return [...head, `Content-Type: multipart/mixed; boundary="${mix}"`, "",
    `--${mix}`, `Content-Type: multipart/alternative; boundary="${alt}"`, "", body,
    ...parts, `--${mix}--`, ""].join("\r\n");
}

// Conexión TLS que lee línea a línea.
class Line {
  private buf = "";
  private constructor(private conn: Deno.TlsConn) {}
  static async open(host: string, port: number) { return new Line(await Deno.connectTls({ hostname: host, port })); }
  async read(): Promise<string> {
    while (!this.buf.includes("\r\n")) {
      const chunk = new Uint8Array(16384);
      const n = await this.conn.read(chunk);
      if (n === null) throw new Error("El servidor cerró la conexión");
      this.buf += dec.decode(chunk.subarray(0, n));
    }
    const i = this.buf.indexOf("\r\n");
    const line = this.buf.slice(0, i);
    this.buf = this.buf.slice(i + 2);
    return line;
  }
  async write(s: string) {
    const data = enc.encode(s);
    for (let off = 0; off < data.length;) off += await this.conn.write(data.subarray(off));
  }
  close() { try { this.conn.close(); } catch { /* ya cerrada */ } }
}

const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

class Imap {
  private n = 0;
  private constructor(private c: Line) {}
  static async login(user: string, pass: string) {
    const c = await Line.open(IMAP_HOST, 993);
    await c.read(); // saludo
    const imap = new Imap(c);
    await imap.cmd(`LOGIN ${quote(user)} ${quote(pass)}`);
    return imap;
  }
  async cmd(command: string, literal?: string): Promise<string[]> {
    const tag = `a${++this.n}`;
    const out: string[] = [];
    if (literal !== undefined) {
      await this.c.write(`${tag} ${command} {${enc.encode(literal).length}}\r\n`);
      const cont = await this.c.read();
      if (!cont.startsWith("+")) throw new Error(`IMAP: ${cont}`);
      await this.c.write(literal + "\r\n");
    } else {
      await this.c.write(`${tag} ${command}\r\n`);
    }
    for (;;) {
      const line = await this.c.read();
      if (line.startsWith(`${tag} `)) {
        if (!/^\S+ OK/i.test(line)) throw new Error(`IMAP: ${line.replace(/LOGIN .*/i, "LOGIN …")}`);
        return out;
      }
      out.push(line);
    }
  }
  // Carpeta por su marca (\Drafts, \Sent) o, si el servidor no la da, por el nombre.
  async folder(flag: string, names: RegExp) {
    const boxes = (await this.cmd('LIST "" "*"')).map((l) => {
      const m = l.match(/^\* LIST \(([^)]*)\) (?:"(?:[^"\\]|\\.)*"|NIL) (.+)$/i);
      return m ? { flags: m[1], name: m[2].trim() } : null;
    }).filter(Boolean) as { flags: string; name: string }[];
    const box = boxes.find((b) => b.flags.toLowerCase().includes(flag.toLowerCase()))
      ?? boxes.find((b) => names.test(b.name));
    if (!box) throw new Error(`No encuentro la carpeta ${flag}`);
    return box.name.startsWith('"') ? box.name : quote(box.name);
  }
  async logout() { try { await this.cmd("LOGOUT"); } catch { /* da igual */ } this.c.close(); }
}

async function smtpSend(user: string, pass: string, rcpt: string[], message: string) {
  const c = await Line.open(SMTP_HOST, 465);
  const reply = async (ok: number) => {
    let line;
    do { line = await c.read(); } while (/^\d{3}-/.test(line));
    if (Number(line.slice(0, 3)) !== ok) throw new Error(`SMTP: ${line}`);
  };
  try {
    await reply(220);
    await c.write("EHLO ebmagenciaia.es\r\n"); await reply(250);
    await c.write(`AUTH PLAIN ${b64(enc.encode(`\0${user}\0${pass}`))}\r\n`); await reply(235);
    await c.write(`MAIL FROM:<${user}>\r\n`); await reply(250);
    for (const r of rcpt) { await c.write(`RCPT TO:<${r}>\r\n`); await reply(250); }
    await c.write("DATA\r\n"); await reply(354);
    await c.write(message.replace(/\r\n\./g, "\r\n..") + "\r\n.\r\n"); await reply(250);
    await c.write("QUIT\r\n");
  } finally { c.close(); }
}

const EMAIL = /^[^\s@<>,"]+@[^\s@<>,"]+\.[a-z]{2,}$/i;

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const { id } = await req.json().catch(() => ({}));
  if (typeof id !== "string") return json({ error: "invalid_request" }, 400);

  // Reserva la fila: si no está pendiente, otra llamada ya la hizo.
  const { data: row } = await db.from("outgoing_mail").update({ status: "working" })
    .eq("id", id).eq("status", "pending").select("*").maybeSingle();
  if (!row) return json({ skipped: true });

  const finish = (patch: Record<string, unknown>) =>
    db.from("outgoing_mail").update({ ...patch, processed_at: new Date().toISOString() }).eq("id", id);

  try {
    const acc = ACCOUNTS[row.account];
    const pass = Deno.env.get(acc.secret);
    if (!pass) throw new Error(`Falta el secreto ${acc.secret} en Supabase.`);
    const to: string[] = row.to_addr ?? [], cc: string[] = row.cc_addr ?? [];
    const bad = [...to, ...cc].filter((a) => !EMAIL.test(a));
    if (!to.length || bad.length) throw new Error(`Dirección no válida: ${bad.join(", ") || "sin destinatario"}`);

    const files: { name: string; data: Uint8Array }[] = [];
    if (row.document_ids?.length) {
      const { data: docs } = await db.from("client_documents").select("id, name, storage_path").in("id", row.document_ids);
      for (const docId of row.document_ids) {
        const d = docs?.find((x) => x.id === docId);
        if (!d) throw new Error(`No existe el documento ${docId}`);
        const { data: blob, error } = await db.storage.from("client-docs").download(d.storage_path);
        if (error || !blob) throw new Error(`No se pudo leer ${d.name}`);
        const name = /\.pdf$/i.test(d.name) ? d.name : `${d.name}.pdf`;
        files.push({ name, data: new Uint8Array(await blob.arrayBuffer()) });
      }
    }

    const html = `${row.body_html}<br><br>${signature(acc.name, acc.email)}`;
    const message = buildMessage(addr(acc.name, acc.email), to, cc, row.subject, html, files);

    if (row.mode === "send") await smtpSend(acc.email, pass, [...to, ...cc], message);

    const imap = await Imap.login(acc.email, pass);
    try {
      const box = row.mode === "send"
        ? await imap.folder("\\Sent", /sent|enviad/i)
        : await imap.folder("\\Drafts", /draft|borrador/i);
      await imap.cmd(`APPEND ${box} (${row.mode === "send" ? "\\Seen" : "\\Draft \\Seen"})`, message);
    } catch (e) {
      // Si ya se envió, que no se repita: solo falla la copia en Enviados.
      if (row.mode !== "send") throw e;
      await finish({ status: "done", error: `Enviado, pero sin copia en Enviados: ${(e as Error).message}` });
      return json({ ok: true });
    } finally { await imap.logout(); }

    await finish({ status: "done", error: null });
    return json({ ok: true });
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    await finish({ status: "error", error: msg.slice(0, 500) });
    return json({ error: msg }, 500);
  }
});
