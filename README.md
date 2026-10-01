# EBM · Panel de agentes de IA

Panel de administración de los agentes de IA de EBM. Web estática (GitHub Pages) que habla con Supabase.

- **Admin**: clientes, agentes (prompt y datos del negocio), a quién avisar, actividad, costes y margen, usuarios.
- **Cliente**: solo lectura de lo suyo (conversaciones, leads, pasos a humano, citas, temas más preguntados).

## Estructura

| Ruta | Qué es |
|---|---|
| `index.html`, `css/`, `js/` | El panel. Sin compilación: HTML, CSS y módulos JS. |
| `js/config.js` | URL y clave pública de Supabase, modelos disponibles. |
| `supabase/migrations/` | Esquema de la base de datos, con RLS por `client_id`. |

## Seguridad

- El repositorio es público. Aquí **no va ninguna clave secreta**: las de Claude, Meta o correo se guardan como secretos de Supabase.
- La clave de `js/config.js` es la *publishable*: sin sesión iniciada no da acceso a ningún dato.
- Los datos los protege RLS: un usuario con rol `client` solo lee las filas de su `client_id`, y nunca ve prompts, costes ni cuotas.
- Un usuario nuevo entra sin cliente asignado y no ve nada hasta que un admin se lo asigna en **Usuarios**.

## Probar en local

```bash
npx serve -l 5173 .
```

## Dar de alta un usuario

1. Supabase › Authentication › Users › Add user.
2. En el panel, **Usuarios**: elige el cliente que puede ver.

Para convertir a alguien en admin la primera vez (SQL Editor de Supabase):

```sql
update public.profiles set role = 'admin' where email = 'correo@ejemplo.com';
```
