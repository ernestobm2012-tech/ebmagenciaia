#!/usr/bin/env python3
"""Hook Stop de EBM: no deja terminar la respuesta si en este turno se ha cambiado algo
(archivos, base de datos, funciones, agentes) y no se ha guardado la memoria de Drive.
CLAUDE.md se comprueba también: si se tocó código y no CLAUDE.md, se avisa en el mismo mensaje."""
import json, sys

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if data.get("stop_hook_active"):          # ya avisó una vez en este turno: no repetir
    sys.exit(0)

path = data.get("transcript_path")
events = []
try:
    with open(path, encoding="utf-8") as f:
        for line in f:
            try:
                events.append(json.loads(line))
            except Exception:
                pass
except Exception:
    sys.exit(0)

def is_real_user(ev):
    if ev.get("type") != "user":
        return False
    c = (ev.get("message") or {}).get("content")
    if isinstance(c, str):
        return bool(c.strip())
    return any(b.get("type") == "text" for b in c or [] if isinstance(b, dict))

start = 0
for i, ev in enumerate(events):
    if is_real_user(ev):
        start = i
uses = []
for ev in events[start:]:
    if ev.get("type") != "assistant":
        continue
    for b in (ev.get("message") or {}).get("content") or []:
        if isinstance(b, dict) and b.get("type") == "tool_use":
            uses.append((b.get("name", ""), b.get("input") or {}))

changed = claude_md = memory = False
for name, inp in uses:
    text = json.dumps(inp, ensure_ascii=False)
    if name in ("Edit", "Write", "NotebookEdit"):
        fp = str(inp.get("file_path", ""))
        if "/scratchpad/" in fp or "/tmp/" in fp:
            continue
        changed = True
        if fp.endswith("CLAUDE.md"):
            claude_md = True
    elif name == "Bash":
        cmd = str(inp.get("command", ""))
        if "git commit" in cmd or "git push" in cmd:
            changed = True
        if "CLAUDE.md" in cmd and ("git add" in cmd or "git commit" in cmd or "sed -i" in cmd or "open(" in cmd):
            claude_md = True
    elif name.endswith("deploy_edge_function") or name.endswith("apply_migration"):
        changed = True
    elif name.endswith("execute_sql"):
        low = str(inp.get("query", "")).lower()
        if any(w in low for w in ("update ", "insert ", "alter ", "create ", "drop ", "delete ")):
            changed = True
    elif "ElevenLabs__agents_update" in name or "ElevenLabs__agents_create" in name:
        changed = True
    elif name.endswith("Google_Drive__create_file"):
        if "memoria de trabajo" in str(inp.get("title", "")).lower():
            memory = True
        else:
            changed = True

if changed and not memory:
    msg = ("EBM · memoria sin actualizar. En esta conversación has cambiado cosas y Ernesto no quiere que se pierdan. "
           "Antes de terminar: (1) guarda en Drive una versión nueva de «Memoria de trabajo EBM» "
           "(carpeta _Memoria, id 1SBlvvLEqEmgxa_G5bPih7yV940sdtUNh; crea el documento nuevo y renombra el anterior con «(anterior)») "
           "con lo hecho, las decisiones y lo pendiente")
    if not claude_md:
        msg += "; (2) apunta en CLAUDE.md lo técnico (qué se cambió y cómo), con commit y push a la rama y a main"
    msg += ". Después dilo en una línea."
    print(msg, file=sys.stderr)
    sys.exit(2)
sys.exit(0)
