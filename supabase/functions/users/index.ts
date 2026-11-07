// Gestión de usuarios del panel, solo para administradores.
//   POST ?action=list                                 -> estado de acceso de cada usuario
//   POST ?action=create {email, full_name, role, client_id, send_email}
//                                                     -> da de alta y devuelve el enlace de acceso
//   POST ?action=link   {user_id, send_email}         -> nuevo enlace para fijar la contraseña
//   POST ?action=set_active {user_id, active}         -> activa o desactiva el acceso
//   POST ?action=update {user_id, email?, full_name?}  -> cambia correo o nombre
//   POST ?action=delete {user_id}                     -> borra el usuario (y su perfil)
//   POST ?action=team_list                            -> usuarios del negocio (administrador de equipo)
//   POST ?action=set_modules {user_id, modules}       -> qué puede ver ese usuario
// El administrador de equipo (profiles.team_admin, p. ej. el dueño del negocio) puede usar list/create/link/
// set_active/update/delete/set_modules SOLO sobre usuarios «client» de su propio negocio y solo darles
// módulos que él mismo tiene.
// Roles: client (ve su negocio), partner (ve su negocio y los que cuelgan de él), admin (todo).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const PANEL_URL = Deno.env.get("PANEL_URL") ?? "https://ebmagenciaia.es/admin/";
const FROM = Deno.env.get("NOTIFY_FROM") ?? "EBM Agencia IA <info@ebmagenciaia.es>";
const ROLES = ["client", "partner", "admin"];
const ALL_MODULES = ["resumen", "resumen_temas", "resumen_clientes", "actividad", "act_conversaciones", "act_mensajes", "act_leads",
  "act_derivaciones", "act_citas", "act_avisos", "calendarios", "avisar", "redes", "impresoras", "impresoras_precios", "catalogo",
  "clientes", "estadisticas"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

type Caller = { user: { id: string }; admin: boolean; clientId: string | null; modules: string[] | null };

// Quien llama: administrador de EBM, o administrador de equipo de un negocio (limitado a ese negocio).
async function currentCaller(req: Request): Promise<Caller | null> {
  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data } = await db.auth.getUser(jwt);
  if (!data.user) return null;
  const { data: p } = await db.from("profiles").select("role, client_id, modules, team_admin").eq("id", data.user.id).maybeSingle();
  if (p?.role === "admin") return { user: data.user, admin: true, clientId: null, modules: null };
  if (p?.team_admin && p.role === "client" && p.client_id) {
    return { user: data.user, admin: false, clientId: p.client_id, modules: p.modules ?? null };
  }
  return null;
}

// Módulos que este usuario puede repartir: solo los que tiene él (todos si no tiene lista).
function cleanModules(me: Caller, wanted: unknown): string[] | { error: string } {
  if (!Array.isArray(wanted)) return { error: "Falta la lista de lo que puede ver." };
  const list = [...new Set(wanted.map(String))];
  if (list.some((m) => !ALL_MODULES.includes(m))) return { error: "Hay una opción que no existe." };
  if (!me.admin && me.modules && list.some((m) => !me.modules!.includes(m))) return { error: "No puedes dar acceso a algo que tú no tienes." };
  return list;
}

// ¿Puede esta persona tocar a ese usuario? El administrador, a cualquiera; el de equipo, solo a los «client» de su negocio.
async function canTouch(me: Caller, userId: string) {
  if (me.admin) return true;
  if (userId === me.user.id) return false;
  const { data: t } = await db.from("profiles").select("role, client_id, team_admin").eq("id", userId).maybeSingle();
  return !!t && t.role === "client" && t.client_id === me.clientId && !t.team_admin;
}

// Nombre con el que se presenta el panel a esta persona: el de la marca de su negocio
// (o la del partner del que cuelga) y, si no tiene, EBM.
async function brandFor(clientId: string | null) {
  if (!clientId) return "EBM Agencia IA";
  const { data: c } = await db.from("clients").select("brand_name, parent_client_id").eq("id", clientId).maybeSingle();
  if (c?.brand_name) return c.brand_name as string;
  if (c?.parent_client_id) {
    const { data: b } = await db.from("clients").select("brand_name").eq("id", c.parent_client_id).maybeSingle();
    if (b?.brand_name) return b.brand_name as string;
  }
  return "EBM Agencia IA";
}

async function sendInvite(to: string, name: string | null, link: string, brand: string) {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return false;
  const html = `<div style="font-family:Lato,Arial,sans-serif;font-size:15px;line-height:1.5;color:#242F3D;max-width:520px">
<h2 style="font-size:19px;margin:0 0 12px">${esc(name ? `Hola, ${name}` : "Hola")}</h2>
<p>Te han dado acceso al panel de agentes de ${esc(brand)}. Pulsa el botón para elegir tu contraseña y entrar.</p>
<p style="margin:22px 0"><a href="${esc(link)}" style="background:#1483DC;color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:8px;display:inline-block">Entrar al panel</a></p>
<p style="color:#5E6C7A;font-size:13px">El enlace caduca y solo sirve una vez. Si no lo esperabas, ignora este correo.</p></div>`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [to], subject: `Acceso al panel de ${brand}`, html }),
  });
  return res.ok;
}

async function findUser(id: string) {
  const { data } = await db.auth.admin.getUserById(id);
  return data.user ?? null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  const me = await currentCaller(req);
  if (!me) return json({ error: "Solo los administradores pueden gestionar usuarios." }, 403);
  const action = new URL(req.url).searchParams.get("action");
  // deno-lint-ignore no-explicit-any
  const body = await req.json().catch(() => ({})) as Record<string, any>;

  try {
    if (action === "team_list") {
      if (!me.clientId && !me.admin) return json({ error: "Sin permiso." }, 403);
      const { data: ps, error: pe } = await db.from("profiles").select("id, email, full_name, modules, role, team_admin, created_at")
        .eq("client_id", me.clientId).eq("role", "client").order("created_at");
      if (pe) throw pe;
      const { data, error } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
      if (error) throw error;
      const byId = new Map(data.users.map((u) => [u.id, u]));
      const users = (ps ?? []).map((p) => {
        const u = byId.get(p.id);
        return {
          ...p,
          last_sign_in_at: u?.last_sign_in_at ?? null,
          confirmed: !!u?.email_confirmed_at || !!u?.last_sign_in_at,
          disabled: !!u?.banned_until && new Date(u.banned_until) > new Date(),
        };
      });
      return json({ users });
    }

    if (action === "set_modules") {
      if (!UUID.test(String(body.user_id ?? "")) || !(await canTouch(me, body.user_id))) return json({ error: "No puedes cambiar a este usuario." }, 403);
      const mods = cleanModules(me, body.modules);
      if (!Array.isArray(mods)) return json({ error: mods.error }, 400);
      const { error } = await db.from("profiles").update({ modules: mods }).eq("id", body.user_id);
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === "list") {
      if (!me.admin) return json({ error: "Sin permiso." }, 403);
      const { data, error } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
      if (error) throw error;
      const users: Record<string, unknown> = {};
      for (const u of data.users) {
        users[u.id] = {
          last_sign_in_at: u.last_sign_in_at ?? null,
          confirmed: !!u.email_confirmed_at || !!u.last_sign_in_at,
          disabled: !!u.banned_until && new Date(u.banned_until) > new Date(),
        };
      }
      return json({ users });
    }

    if (action === "create") {
      const email = String(body.email ?? "").trim().toLowerCase();
      const role = me.admin ? String(body.role ?? "") : "client";
      const fullName = String(body.full_name ?? "").trim().slice(0, 120) || null;
      if (!EMAIL.test(email)) return json({ error: "El correo no es válido." }, 400);
      if (!ROLES.includes(role)) return json({ error: "Rol no válido." }, 400);
      let clientId: string | null = null;
      let newModules: string[] | null = null;
      if (!me.admin) {
        clientId = me.clientId;
        const mods = cleanModules(me, body.modules);
        if (!Array.isArray(mods)) return json({ error: mods.error }, 400);
        newModules = mods;
      } else if (role !== "admin") {
        if (!UUID.test(String(body.client_id ?? ""))) return json({ error: "Elige el negocio que va a ver esta persona." }, 400);
        const { data: c } = await db.from("clients").select("id").eq("id", body.client_id).maybeSingle();
        if (!c) return json({ error: "Ese negocio no existe." }, 400);
        clientId = c.id;
      }

      const { data, error } = await db.auth.admin.generateLink({
        type: "invite", email,
        options: { redirectTo: PANEL_URL, data: fullName ? { full_name: fullName } : undefined },
      });
      if (error) {
        const exists = /already|registered|exists/i.test(error.message);
        return json({ error: exists ? "Ya hay un usuario con ese correo." : error.message }, exists ? 409 : 500);
      }
      const id = data.user.id;
      // El alta crea el perfil como «client» sin negocio; aquí se le da el rol y el negocio elegidos.
      const { error: pe } = await db.from("profiles").upsert({
        id, email, full_name: fullName, role, client_id: clientId, ...(newModules ? { modules: newModules } : {}),
      });
      if (pe) throw pe;

      const link = data.properties.action_link;
      const emailed = body.send_email ? await sendInvite(email, fullName, link, await brandFor(clientId)) : false;
      return json({ id, link, emailed });
    }

    if (action === "link") {
      if (!UUID.test(String(body.user_id ?? "")) || !(await canTouch(me, body.user_id))) return json({ error: "No puedes cambiar a este usuario." }, 403);
      const user = UUID.test(String(body.user_id ?? "")) ? await findUser(body.user_id) : null;
      if (!user?.email) return json({ error: "Usuario no encontrado." }, 404);
      const confirmed = !!user.email_confirmed_at || !!user.last_sign_in_at;
      const { data, error } = await db.auth.admin.generateLink({
        type: confirmed ? "recovery" : "invite", email: user.email, options: { redirectTo: PANEL_URL },
      });
      if (error) throw error;
      const { data: p } = await db.from("profiles").select("full_name, client_id").eq("id", user.id).maybeSingle();
      const link = data.properties.action_link;
      const emailed = body.send_email ? await sendInvite(user.email, p?.full_name ?? null, link, await brandFor(p?.client_id ?? null)) : false;
      return json({ link, emailed });
    }

    if (action === "set_active") {
      if (!UUID.test(String(body.user_id ?? ""))) return json({ error: "Usuario no válido." }, 400);
      if (!(await canTouch(me, body.user_id))) return json({ error: "No puedes cambiar a este usuario." }, 403);
      if (body.user_id === me.user.id) return json({ error: "No puedes desactivar tu propio acceso." }, 400);
      const { error } = await db.auth.admin.updateUserById(body.user_id, { ban_duration: body.active ? "none" : "876000h" });
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === "update") {
      if (!UUID.test(String(body.user_id ?? ""))) return json({ error: "Usuario no válido." }, 400);
      if (!(await canTouch(me, body.user_id))) return json({ error: "No puedes cambiar a este usuario." }, 403);
      const user = await findUser(body.user_id);
      if (!user) return json({ error: "Usuario no encontrado." }, 404);
      const email = body.email === undefined ? null : String(body.email).trim().toLowerCase();
      if (email !== null && !EMAIL.test(email)) return json({ error: "El correo no es válido." }, 400);
      const fullName = body.full_name === undefined ? undefined : (String(body.full_name ?? "").trim().slice(0, 120) || null);
      if (email && email !== user.email) {
        const { error } = await db.auth.admin.updateUserById(user.id, { email, email_confirm: true });
        if (error) {
          const exists = /already|registered|exists/i.test(error.message);
          return json({ error: exists ? "Ya hay otro usuario con ese correo." : error.message }, exists ? 409 : 500);
        }
      }
      const changes: Record<string, unknown> = {};
      if (email) changes.email = email;
      if (fullName !== undefined) changes.full_name = fullName;
      if (Object.keys(changes).length) {
        const { error } = await db.from("profiles").update(changes).eq("id", user.id);
        if (error) throw error;
      }
      return json({ ok: true });
    }

    if (action === "delete") {
      if (!UUID.test(String(body.user_id ?? ""))) return json({ error: "Usuario no válido." }, 400);
      if (!(await canTouch(me, body.user_id))) return json({ error: "No puedes cambiar a este usuario." }, 403);
      if (body.user_id === me.user.id) return json({ error: "No puedes borrarte a ti mismo." }, 400);
      const { error } = await db.auth.admin.deleteUser(body.user_id);
      if (error) throw error;
      return json({ ok: true });
    }

    return json({ error: "Acción desconocida" }, 400);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
