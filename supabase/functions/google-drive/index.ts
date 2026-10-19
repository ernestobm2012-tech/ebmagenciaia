// Copia en Google Drive de los documentos firmados (y de lo que haga falta más
// adelante), en la carpeta de cada cliente dentro de «Ebm agencia ia».
//   POST ?action=connect  (admin del panel)  -> URL para entrar con Google
//   GET  ?code&state      (vuelta de Google) -> guarda la conexión
//   POST ?action=status   (admin del panel)  -> si está conectado y con qué cuenta
//   POST ?action=upload   (función firma con la clave de servicio, o admin) {document_id, folder}
//                          -> sube el PDF a <carpeta del cliente>/<folder>
// Secretos: GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET (los mismos del calendario).
// En Google Cloud hay que tener activada la API de Drive y esta función como URI de redirección.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SUPABASE_URL, SERVICE_KEY);
const CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";
const SELF = `${SUPABASE_URL}/functions/v1/google-drive`;
const SCOPES = "openid email https://www.googleapis.com/auth/drive";
// Carpeta «Ebm agencia ia» del Drive de Ernesto.
const ROOT_FOLDER = Deno.env.get("DRIVE_ROOT_FOLDER_ID") ?? "113ekwHrzH5EJ2WedAaSJUaZ70MKco08q";
const RETURN_PREFIXES = ["https://ernestobm2012-tech.github.io/", "https://ebmagenciaia.es/", Deno.env.get("PANEL_URL") ?? ""].filter(Boolean);
const FOLDER_MIME = "application/vnd.google-apps.folder";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

async function currentAdmin(req: Request) {
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data } = await db.auth.getUser(jwt);
  if (!data.user) return null;
  const { data: p } = await db.from("profiles").select("role").eq("id", data.user.id).maybeSingle();
  return p?.role === "admin" ? data.user : null;
}

async function connect(req: Request, body: Record<string, unknown>) {
  if (!CLIENT_ID || !CLIENT_SECRET) return json({ error: "Falta configurar Google en Supabase." }, 503);
  const me = await currentAdmin(req);
  if (!me) return json({ error: "Solo administración." }, 403);
  const returnUrl = String(body.return_url ?? "");
  if (!RETURN_PREFIXES.some((p) => returnUrl.startsWith(p))) return json({ error: "Dirección de vuelta no permitida." }, 400);
  const state = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  await db.from("drive_oauth_states").delete().lt("created_at", new Date(Date.now() - 15 * 60_000).toISOString());
  await db.from("drive_oauth_states").insert({ state, user_id: me.id, return_url: returnUrl });
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: SELF, response_type: "code", scope: SCOPES,
    access_type: "offline", prompt: "consent", include_granted_scopes: "true", state,
  }).toString();
  return json({ url: url.toString() });
}

function back(returnUrl: string, result: string) {
  const url = new URL(returnUrl);
  url.searchParams.set("drive", result);
  return Response.redirect(url.toString(), 302);
}

async function callback(url: URL) {
  const state = url.searchParams.get("state") ?? "";
  const { data: pending } = await db.from("drive_oauth_states").select("*").eq("state", state).maybeSingle();
  if (!pending || Date.now() - new Date(pending.created_at).getTime() > 15 * 60_000) {
    return new Response("El enlace ha caducado. Vuelve al panel y pulsa otra vez «Conectar Google Drive».", { status: 400 });
  }
  await db.from("drive_oauth_states").delete().eq("state", state);
  if (url.searchParams.get("error") || !url.searchParams.get("code")) return back(pending.return_url, "cancelado");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: url.searchParams.get("code")!, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      redirect_uri: SELF, grant_type: "authorization_code",
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.refresh_token) {
    await db.from("error_log").insert({ source: "google-drive", message: `oauth: ${JSON.stringify(data).slice(0, 500)}` });
    return back(pending.return_url, "error");
  }
  if (!String(data.scope ?? "").includes("/auth/drive")) return back(pending.return_url, "sin-permiso");
  let email: string | null = null;
  try {
    email = JSON.parse(atob(String(data.id_token).split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).email ?? null;
  } catch { /* sin correo: no pasa nada */ }
  await db.from("drive_google").upsert({ id: 1, account_email: email, refresh_token: data.refresh_token, root_folder_id: ROOT_FOLDER, connected_at: new Date().toISOString() });
  return back(pending.return_url, "ok");
}

// Sin conexión no es un fallo: queda apuntado en la firma y no se avisa al móvil.
class NotConnected extends Error {}

async function accessToken() {
  const { data: conn } = await db.from("drive_google").select("refresh_token, root_folder_id").eq("id", 1).maybeSingle();
  if (!conn) throw new NotConnected("Falta conectar Google Drive: en Documentos de cualquier cliente, bloque Firmas, pulsa «Conectar Google Drive».");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: conn.refresh_token, grant_type: "refresh_token" }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Google Drive: ${data.error_description || data.error || res.status}`);
  return { token: data.access_token as string, root: conn.root_folder_id || ROOT_FOLDER };
}

const q = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

// Carpeta con ese nombre dentro de parent; si no existe, se crea.
async function folder(token: string, parent: string, name: string) {
  const search = new URL("https://www.googleapis.com/drive/v3/files");
  search.search = new URLSearchParams({
    q: `'${q(parent)}' in parents and name = '${q(name)}' and mimeType = '${FOLDER_MIME}' and trashed = false`,
    fields: "files(id)", pageSize: "1", supportsAllDrives: "true", includeItemsFromAllDrives: "true",
  }).toString();
  const found = await (await fetch(search, { headers: { Authorization: `Bearer ${token}` } })).json();
  if (found.files?.[0]?.id) return found.files[0].id as string;
  const res = await fetch("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parent] }),
  });
  const made = await res.json();
  if (!res.ok) throw new Error(`Google Drive: ${made.error?.message ?? res.status}`);
  return made.id as string;
}

async function upload(body: Record<string, unknown>) {
  const { data: doc } = await db.from("client_documents").select("id, client_id, name, storage_path").eq("id", String(body.document_id ?? "")).maybeSingle();
  if (!doc) throw new Error("Documento no encontrado.");
  const { data: client } = await db.from("clients").select("id, name, drive_folder_id").eq("id", doc.client_id).maybeSingle();
  const { token, root } = await accessToken();

  let clientFolder = client?.drive_folder_id as string | null;
  if (!clientFolder) {
    clientFolder = await folder(token, root, client?.name ?? "Sin cliente");
    await db.from("clients").update({ drive_folder_id: clientFolder }).eq("id", doc.client_id);
  }
  const target = await folder(token, clientFolder, String(body.folder || "Contratos"));

  const { data: blob, error } = await db.storage.from("client-docs").download(doc.storage_path);
  if (error || !blob) throw new Error("No se pudo leer el PDF.");
  const boundary = `b${crypto.randomUUID()}`;
  const meta = JSON.stringify({ name: /\.pdf$/i.test(doc.name) ? doc.name : `${doc.name}.pdf`, parents: [target], mimeType: "application/pdf" });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const enc = new TextEncoder();
  const head = enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`);
  const tail = enc.encode(`\r\n--${boundary}--`);
  const payload = new Uint8Array(head.length + bytes.length + tail.length);
  payload.set(head, 0); payload.set(bytes, head.length); payload.set(tail, head.length + bytes.length);
  const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body: payload,
  });
  const out = await res.json();
  if (!res.ok) throw new Error(`Google Drive: ${out.error?.message ?? res.status}`);
  return { id: out.id as string, link: out.webViewLink as string };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  try {
    if (req.method === "GET" && url.searchParams.has("state")) return await callback(url);
    if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    if (action === "connect") return await connect(req, body);
    if (action === "status") {
      if (!(await currentAdmin(req))) return json({ error: "Solo administración." }, 403);
      const { data } = await db.from("drive_google").select("account_email, connected_at").eq("id", 1).maybeSingle();
      return json({ connected: !!data, email: data?.account_email ?? null });
    }
    if (action === "upload") {
      // La llama la función firma (clave de servicio) o el panel para reintentar (administración).
      if ((req.headers.get("authorization") ?? "") !== `Bearer ${SERVICE_KEY}` && !(await currentAdmin(req))) return json({ error: "No autorizado" }, 401);
      return json(await upload(body));
    }
    return json({ error: "Acción desconocida" }, 400);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!(err instanceof NotConnected)) {
      await db.from("error_log").insert({ source: "google-drive", message: `${action}: ${message}`.slice(0, 1000) });
    }
    return json({ error: message }, 500);
  }
});
