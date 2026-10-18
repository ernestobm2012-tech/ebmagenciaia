// Recibe los PDF del repositorio privado ebm-documentos y los guarda en la
// pestaña Documentos del cliente. La llama la acción de GitHub de ese repositorio.
//   POST  x-docs-token: <DOCS_INGEST_TOKEN>   multipart { path, file }
//   path = clientes/<slug>/<carpeta>/<Nombre>.pdf
//     carpeta: propuestas, contratos, facturas (cualquier otra = «otro»)
//   ->    { ok: true, id, updated }
// Si ese PDF ya se había subido (mismo path), se sustituye en vez de duplicarlo.
// Secreto: DOCS_INGEST_TOKEN (el mismo valor en Supabase y en el secreto de GitHub).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const TOKEN = Deno.env.get("DOCS_INGEST_TOKEN") ?? "";
const BUCKET = "client-docs";
const MAX_BYTES = 20 * 1024 * 1024;
const KINDS: Record<string, string> = { propuestas: "propuesta", contratos: "contrato", facturas: "factura" };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function sameToken(given: string) {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(TOKEN);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const safeName = (name: string) => name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w.-]+/g, "_");

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  if (TOKEN.length < 24) return json({ error: "Falta el secreto DOCS_INGEST_TOKEN en Supabase (mínimo 24 caracteres)." }, 503);
  if (!sameToken(req.headers.get("x-docs-token") ?? "")) return json({ error: "Clave no válida." }, 401);

  try {
    const form = await req.formData();
    const path = String(form.get("path") ?? "").trim();
    const file = form.get("file");
    const m = path.match(/^clientes\/([a-z0-9-]+)\/(?:([^/]+)\/)?(?:[^/]+\/)*([^/]+)\.pdf$/i);
    if (!m) return json({ error: `Ruta no válida: ${path}. Debe ser clientes/<cliente>/<carpeta>/<nombre>.pdf` }, 400);
    if (!(file instanceof File)) return json({ error: "Falta el archivo." }, 400);
    if (file.size > MAX_BYTES) return json({ error: "El PDF pasa de 20 MB." }, 413);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") return json({ error: "El archivo no es un PDF." }, 415);

    const [, slug, folder, base] = m;
    const { data: client } = await db.from("clients").select("id").eq("slug", slug.toLowerCase()).maybeSingle();
    if (!client) return json({ error: `No hay ningún cliente con el identificador «${slug}».` }, 404);

    const kind = KINDS[(folder ?? "").toLowerCase()] ?? "otro";
    const name = base.replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
    const { data: existing } = await db.from("client_documents").select("id, client_id, storage_path")
      .eq("source_path", path).maybeSingle();
    const storagePath = existing && existing.client_id === client.id
      ? existing.storage_path
      : `${client.id}/${crypto.randomUUID()}-${safeName(base)}.pdf`;

    const { error: upErr } = await db.storage.from(BUCKET)
      .upload(storagePath, bytes, { contentType: "application/pdf", upsert: true });
    if (upErr) throw upErr;

    if (existing) {
      const { error } = await db.from("client_documents").update({
        client_id: client.id, name, kind, storage_path: storagePath, size_bytes: file.size,
      }).eq("id", existing.id);
      if (error) throw error;
      if (existing.storage_path !== storagePath) await db.storage.from(BUCKET).remove([existing.storage_path]);
      return json({ ok: true, id: existing.id, updated: true });
    }
    const { data: doc, error } = await db.from("client_documents").insert({
      client_id: client.id, name, kind, storage_path: storagePath, size_bytes: file.size,
      source_path: path, created_by: null,
    }).select("id").single();
    if (error) {
      await db.storage.from(BUCKET).remove([storagePath]);
      throw error;
    }
    return json({ ok: true, id: doc.id, updated: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.from("error_log").insert({ source: "docs-ingest", message: message.slice(0, 1000) });
    return json({ error: message }, 500);
  }
});
