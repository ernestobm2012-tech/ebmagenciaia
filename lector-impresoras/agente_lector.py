#!/usr/bin/env python3
"""
Agente lector de contadores de impresoras (SNMP v2c). Solo Python 3, sin instalar nada.
Solo LEE contadores y niveles de tóner. No toca documentos ni cambia nada en las impresoras.

Ejemplos:
    py agente_lector.py --cliente "EBM Agencia IA"          (explora tu red)
    py agente_lector.py --ip 192.168.0.5                    (una impresora concreta)
"""
import argparse
import datetime
import ipaddress
import json
import os
import socket
import sys
import time
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from concurrent.futures import ThreadPoolExecutor

# ---------- SNMP mínimo (BER) ----------

def _len(n):
    if n < 128:
        return bytes([n])
    b = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return bytes([0x80 | len(b)]) + b

def _tlv(tag, data):
    return bytes([tag]) + _len(len(data)) + data

def _int(n):
    b = n.to_bytes((n.bit_length() + 8) // 8, "big", signed=True)
    return _tlv(0x02, b)

def _oid(oid):
    p = [int(x) for x in oid.strip(".").split(".")]
    out = bytes([40 * p[0] + p[1]])
    for x in p[2:]:
        chunk = [x & 0x7F]
        x >>= 7
        while x:
            chunk.append(0x80 | (x & 0x7F))
            x >>= 7
        out += bytes(reversed(chunk))
    return _tlv(0x06, out)

def _read_tlv(buf, i):
    tag = buf[i]
    ln = buf[i + 1]
    i += 2
    if ln & 0x80:
        n = ln & 0x7F
        ln = int.from_bytes(buf[i:i + n], "big")
        i += n
    return tag, buf[i:i + ln], i + ln

def _decode_oid(b):
    parts = [b[0] // 40, b[0] % 40]
    v = 0
    for x in b[1:]:
        v = (v << 7) | (x & 0x7F)
        if not x & 0x80:
            parts.append(v)
            v = 0
    return ".".join(map(str, parts))

def _decode_value(tag, data):
    if tag in (0x02,):
        return int.from_bytes(data, "big", signed=True)
    if tag in (0x41, 0x42, 0x43, 0x46):  # Counter32, Gauge32, TimeTicks, Counter64
        return int.from_bytes(data, "big")
    if tag == 0x04:
        try:
            return data.decode("utf-8")
        except UnicodeDecodeError:
            return data.hex()
    if tag == 0x06:
        return _decode_oid(data)
    if tag == 0x40 and len(data) == 4:
        return ".".join(str(x) for x in data)
    if tag in (0x80, 0x81, 0x82):
        return None  # noSuchObject / noSuchInstance / endOfMibView
    return data.hex()

_rid = [int(time.time()) & 0xFFFFFF]

def snmp_request(ip, comunidad, oid, tipo, timeout=4.0, intentos=4):
    """Como _snmp_una_vez, pero reintenta si la impresora tarda (wifi lenta)."""
    for _ in range(intentos):
        r = _snmp_una_vez(ip, comunidad, oid, tipo, timeout)
        if r != "TIMEOUT":
            return r
    return "TIMEOUT"


def _snmp_una_vez(ip, comunidad, oid, tipo, timeout):
    """tipo: 0xA0 = GET, 0xA1 = GETNEXT. Devuelve (oid, valor) o None."""
    _rid[0] += 1
    vb = _tlv(0x30, _oid(oid) + _tlv(0x05, b""))
    pdu = _tlv(tipo, _int(_rid[0]) + _int(0) + _int(0) + _tlv(0x30, vb))
    msg = _tlv(0x30, _int(1) + _tlv(0x04, comunidad.encode()) + pdu)
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(timeout)
    # En Windows, si un aparato responde «puerto cerrado», el siguiente recvfrom da el
    # error 10054. Se desactiva ese aviso y, si aun así llega, se trata como «no contesta».
    if hasattr(socket, "SIO_UDP_CONNRESET"):
        try:
            s.ioctl(socket.SIO_UDP_CONNRESET, False)
        except (OSError, ValueError):
            pass
    try:
        s.sendto(msg, (ip, 161))
        data, _ = s.recvfrom(65535)
    except (socket.timeout, OSError):
        return "TIMEOUT"
    finally:
        s.close()
    _, body, _ = _read_tlv(data, 0)
    i = 0
    _, _, i = _read_tlv(body, i)            # versión
    _, _, i = _read_tlv(body, i)            # comunidad
    _, pdu_body, _ = _read_tlv(body, i)     # PDU
    j = 0
    _, _, j = _read_tlv(pdu_body, j)        # request-id
    _, err, j = _read_tlv(pdu_body, j)      # error-status
    _, _, j = _read_tlv(pdu_body, j)        # error-index
    if int.from_bytes(err, "big"):
        return None
    _, vbl, _ = _read_tlv(pdu_body, j)
    _, vb0, _ = _read_tlv(vbl, 0)
    _, o, k = _read_tlv(vb0, 0)
    tag, v, _ = _read_tlv(vb0, k)
    return _decode_oid(o), _decode_value(tag, v)

def get(ip, com, oid, estricto=False):
    r = snmp_request(ip, com, oid, 0xA0)
    if r == "TIMEOUT":
        if estricto:
            raise TimeoutError
        return None
    if not r or r[1] is None:
        return None
    return r[1]

def walk(ip, com, base, maximo=5000):
    """Recorre todo lo que cuelga de 'base'."""
    out, cur = [], base
    for _ in range(maximo):
        r = snmp_request(ip, com, cur, 0xA1)
        if r == "TIMEOUT":
            print("  (la impresora dejó de contestar; muestro lo leído hasta aquí)")
            break
        if not r or r[1] is None:
            break
        o, v = r
        if not (o == base or o.startswith(base + ".")):
            break
        out.append((o, v))
        cur = o
    return out

# ---------- Perfiles por marca ----------
# Cada contador es una lista de "sumandos"; cada sumando es una lista de OIDs
# candidatos (se usa el primero que responda). Valor = suma de sumandos.
# estado: "probado" = verificado con una impresora real; "documentado" = sacado de
# documentación pública, SIN probar con hardware real todavía.
X = "1.3.6.1.4.1.253.8.53.13.2.1.6.1.20."
R = "1.3.6.1.4.1.367.3.2.1.2.19.5.1.9."
KM = "1.3.6.1.4.1.18334.1.1.1.5.7.2."
KMB = [KM + "2.1.5.{c}.{f}", KM + "1.5.{c}.{f}"]   # la fuente no deja claro cuál; se prueban las dos
HP = "1.3.6.1.4.1.11.2.3.9.4.2.1.4.1.2."
SH = "1.3.6.1.4.1.2385.1.1.19.2.1.3.5.4."

def _km(c, f):
    return [o.format(c=c, f=f) for o in KMB]

PERFILES = {
    "Xerox": {
        "estado": "total y reparto probados en WorkCentre 6515 (bn/color pendiente de prueba de impresión)",
        "total": [[X + "1"]], "bn": [[X + "34"]], "color": [[X + "33"]],
        "bruto": "1.3.6.1.4.1.253.8.53.13.2.1.6.1.20"},
    "Ricoh": {
        "estado": "documentado, sin probar",
        "total": [[R + "1"]],
        "bn": [[R + "3"], [R + "9"]], "color": [[R + "5"], [R + "11"]],
        "bruto": "1.3.6.1.4.1.367.3.2.1.2.19.5.1.9"},
    "Konica Minolta": {
        "estado": "documentado, sin probar",
        "bn": [_km(1, 1), _km(1, 2)], "color": [_km(2, 1), _km(2, 2)],
        "bruto": "1.3.6.1.4.1.18334.1.1.1.5.7.2"},
    "Lexmark": {
        "estado": "documentado, sin probar",
        "total": [["1.3.6.1.4.1.641.2.1.5.1", "1.3.6.1.4.1.641.2.1.5.1.0"]],
        "bn": [["1.3.6.1.4.1.641.2.1.5.2", "1.3.6.1.4.1.641.2.1.5.2.0"]],
        "color": [["1.3.6.1.4.1.641.2.1.5.3", "1.3.6.1.4.1.641.2.1.5.3.0"]],
        "bruto": "1.3.6.1.4.1.641.2.1.5"},
    "HP": {
        "estado": "documentado, sin probar (bn = total - color)",
        "color": [[HP + "7.0", HP + "7"]], "bn_resta": True,
        "bruto": "1.3.6.1.4.1.11.2.3.9.4.2.1.4.1.2"},
    "Sharp": {
        "estado": "documentado, sin probar",
        "bn": [[SH + "61"]], "color": [[SH + "63"]],
        "bruto": "1.3.6.1.4.1.2385.1.1.19.2.1.3.5.4"},
    "Kyocera": {
        "estado": "sin mapear: se guarda un volcado para mapearlo",
        "total": [["1.3.6.1.4.1.1347.42.3.1.1.1.1"]],
        "bruto": "1.3.6.1.4.1.1347.42.3"},
    "Samsung": {
        "estado": "sin mapear: se guarda un volcado para mapearlo",
        "total": [["1.3.6.1.4.1.236.11.5.1.1.9.2.0"]],
        "bruto": "1.3.6.1.4.1.236.11.5.11"},
}

EMPRESAS = {"253": "Xerox", "367": "Ricoh", "18334": "Konica Minolta", "641": "Lexmark",
            "11": "HP", "2385": "Sharp", "1347": "Kyocera", "236": "Samsung",
            "1602": "Canon", "2435": "Brother"}

OID_DESCR = "1.3.6.1.2.1.1.1.0"
OID_OBJID = "1.3.6.1.2.1.1.2.0"
OID_SERIE = "1.3.6.1.2.1.43.5.1.1.17.1"
OID_TOTAL_STD = "1.3.6.1.2.1.43.10.2.1.4.1.1"
BASE_SUMINISTROS = "1.3.6.1.2.1.43.11.1.1"


def detectar_marca(descr, objid):
    if objid and objid.startswith("1.3.6.1.4.1."):
        emp = objid[len("1.3.6.1.4.1."):].split(".")[0]
        if emp in EMPRESAS:
            return EMPRESAS[emp]
    d = (descr or "").lower()
    for clave, marca in [("xerox", "Xerox"), ("ricoh", "Ricoh"), ("lanier", "Ricoh"),
                         ("savin", "Ricoh"), ("konica", "Konica Minolta"),
                         ("bizhub", "Konica Minolta"), ("olivetti", "Olivetti"),
                         ("kyocera", "Kyocera"), ("ecosys", "Kyocera"),
                         ("lexmark", "Lexmark"), ("sharp", "Sharp"),
                         ("samsung", "Samsung"), ("hp ", "HP"),
                         ("laserjet", "HP"), ("canon", "Canon")]:
        if clave in d:
            return marca
    return "Desconocida"


def leer_contador(ip, com, terminos):
    total = 0
    for candidatos in terminos:
        valor = None
        for oid in candidatos:
            v = get(ip, com, oid)
            if isinstance(v, int):
                valor = v
                break
        if valor is None:
            return None
        total += valor
    return total


def leer_toner(ip, com):
    filas = {}
    for o, v in walk(ip, com, BASE_SUMINISTROS, maximo=200):
        col, fila = o[len(BASE_SUMINISTROS) + 1:].split(".", 1)
        filas.setdefault(fila, {})[col] = v
    out = []
    for c in filas.values():
        desc, mx, nv = c.get("6"), c.get("8"), c.get("9")
        if not isinstance(desc, str):
            continue
        pct = None
        if isinstance(nv, int) and isinstance(mx, int) and mx > 0 and nv >= 0:
            pct = 100 * nv // mx
        out.append({"nombre": desc.split(",")[0].split(";")[0].strip(), "nivel": pct})
    return out


def leer_impresora(ip, com):
    """Devuelve un diccionario con la lectura, o None si no es una impresora SNMP."""
    descr = get(ip, com, OID_DESCR)
    if descr is None:
        return None
    objid = get(ip, com, OID_OBJID)
    marca = detectar_marca(descr, objid)
    perfil = PERFILES.get(marca, {})
    avisos = []
    total = leer_contador(ip, com, perfil["total"]) if "total" in perfil else None
    if total is None:
        total = get(ip, com, OID_TOTAL_STD)
        if not isinstance(total, int):
            total = None
    bn = leer_contador(ip, com, perfil["bn"]) if "bn" in perfil else None
    color = leer_contador(ip, com, perfil["color"]) if "color" in perfil else None
    if perfil.get("bn_resta") and total is not None and color is not None:
        bn = total - color
    if total is None and bn is not None and color is not None:
        total = bn + color
    res = {
        "fecha": datetime.datetime.now().isoformat(timespec="seconds"),
        "ip": ip, "marca": marca,
        "modelo": descr.split(";")[0].strip(),
        "serie": get(ip, com, OID_SERIE),
        "total": total, "bn": bn, "color": color,
        "toner": leer_toner(ip, com),
        "estado_perfil": perfil.get("estado", "marca sin perfil: solo contador total estándar"),
    }
    if (bn is None or color is None) and marca != "Desconocida" and perfil.get("bruto"):
        res["bruto"] = {o: v for o, v in walk(ip, com, perfil["bruto"], maximo=300)}
        avisos.append("no se pudo separar bn/color; guardado volcado para mapear")
    elif marca == "Desconocida":
        avisos.append("marca no reconocida")
    if bn is not None and color is not None and total is not None and bn + color != total:
        avisos.append("bn + color no suma el total")
    res["avisos"] = avisos
    return res


# ---------- Envío a la web ----------
URL_WEB = "https://rhjbpkaesobsbnkvioyh.supabase.co/functions/v1/printer-ingest"


def leer_config():
    """lector.txt junto al programa: líneas clave=..., y opcionalmente red=..., ip=..., cada=..."""
    carpeta = os.path.dirname(sys.executable if getattr(sys, "frozen", False) else os.path.abspath(__file__))
    ruta = os.path.join(carpeta, "lector.txt")
    conf = {}
    if os.path.exists(ruta):
        with open(ruta, encoding="utf-8-sig") as f:
            for linea in f:
                if "=" in linea and not linea.strip().startswith("#"):
                    k, v = linea.split("=", 1)
                    conf[k.strip().lower()] = v.strip()
    return conf


# ---------- Descubrimiento de red ----------

def ip_local():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))   # no envía nada; solo elige la interfaz
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


def sondear(ip, com):
    try:
        r = snmp_request(ip, com, OID_DESCR, 0xA0, timeout=1.5, intentos=2)
    except Exception:
        return None
    return ip if r not in (None, "TIMEOUT") and r[1] is not None else None


def descubrir(redes, com):
    ips = []
    for r in redes:
        ips += [str(h) for h in ipaddress.ip_network(r, strict=False).hosts()] \
            if "/" in r and not r.endswith("/32") else [r.split("/")[0]]
    with ThreadPoolExecutor(max_workers=64) as ex:
        return [ip for ip in ex.map(lambda i: sondear(i, com), ips) if ip]


def subir(url, clave, cliente, lecturas):
    lecturas = [{k: v for k, v in l.items() if k != "bruto"} for l in lecturas]
    cuerpo = json.dumps({"cliente": cliente, "lecturas": lecturas}).encode()
    req = urllib.request.Request(url, data=cuerpo, method="POST",
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + clave})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.status


# ---------- Modo en directo ----------
PAGINA_VIVO = """<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lector en directo</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--ink:#242F3D;--mut:#5E6C7A;--line:#DDE4EC;--navy:#12294A;--bn:#2F6FC7;--co:#D9701F;--new:#E6F6EC}
@media(prefers-color-scheme:dark){:root{--bg:#0E1622;--ink:#E7EDF4;--mut:#9FB0C3;--line:#26364A;--navy:#0A1830;--bn:#4F8BDB;--co:#D2712A;--new:#14382A}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 Lato,system-ui,Segoe UI,sans-serif}
header{background:var(--navy);color:#fff;padding:18px 20px}
header small{font:12px ui-monospace,Consolas,monospace;letter-spacing:.08em;text-transform:uppercase;color:#A9BAD0}
header h1{margin:2px 0 0;font-size:28px;font-weight:900}
main{max-width:980px;margin:0 auto;padding:16px}
.imp{border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:16px}
.imp h2{margin:0;font-size:18px}.sm{color:var(--mut);font:12px ui-monospace,Consolas,monospace}
.cifras{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-top:12px}
.c{border-radius:10px;padding:12px 14px;background:rgba(127,127,127,.08);transition:background .3s}
.c.sube{background:var(--new)}
.c .l{font:11px ui-monospace,Consolas,monospace;letter-spacing:.06em;text-transform:uppercase;color:var(--mut)}
.c .v{font-size:34px;font-weight:900;font-variant-numeric:tabular-nums;line-height:1.15}
.bn .v{color:var(--bn)}.co .v{color:var(--co)}
.ev{margin-top:12px;font-size:14px}.ev div{padding:4px 0;border-top:1px solid var(--line)}
.hoy{font-weight:700}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#2fb170;margin-right:6px;animation:p 1.6s infinite}
@keyframes p{50%{opacity:.3}}@media(prefers-reduced-motion:reduce){.dot{animation:none}}
</style>
<header><small>EBM · Proyectos de Software</small><h1>Lector en directo</h1></header>
<main id="m">Conectando…</main>
<script>
var previo={};
function n(x){return x==null?'—':x.toLocaleString('es-ES')}
async function tick(){
 try{
  var d=await (await fetch('/datos')).json(), h='';
  d.impresoras.forEach(function(p){
   var a=previo[p.ip]||{}, cl=function(k){return a[k]!==undefined&&a[k]!==p[k]?' sube':''};
   h+='<div class="imp"><h2>'+p.modelo+'</h2><div class="sm">serie '+(p.serie||'—')+' · '+p.ip+' · <span class="dot"></span>leído a las '+p.hora+'</div>'+
    '<div class="cifras"><div class="c'+cl('total')+'"><div class="l">Total</div><div class="v">'+n(p.total)+'</div></div>'+
    '<div class="c bn'+cl('bn')+'"><div class="l">Blanco y negro</div><div class="v">'+n(p.bn)+'</div></div>'+
    '<div class="c co'+cl('color')+'"><div class="l">Color</div><div class="v">'+n(p.color)+'</div></div>'+
    '<div class="c"><div class="l">Contado desde que abriste esto</div><div class="v">+'+n(p.sesion)+'</div></div></div>'+
    '<div class="ev">'+(p.eventos.length?p.eventos.map(function(e,i){return '<div class="'+(i?'':'hoy')+'">'+e+'</div>'}).join(''):'<div class="sm">Esperando la primera copia…</div>')+'</div></div>';
   previo[p.ip]={total:p.total,bn:p.bn,color:p.color};
  });
  document.getElementById('m').innerHTML=h||'No hay impresoras.';
 }catch(e){document.getElementById('m').textContent='Sin conexión con el lector…'}
}
tick();setInterval(tick,2000);
</script>"""

ESTADO_VIVO = {"impresoras": []}
CERROJO = threading.Lock()


class _Servidor(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/datos"):
            with CERROJO:
                cuerpo = json.dumps(ESTADO_VIVO, ensure_ascii=False).encode()
            tipo = "application/json; charset=utf-8"
        else:
            cuerpo, tipo = PAGINA_VIVO.encode(), "text/html; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", tipo)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(cuerpo)

    def log_message(self, *args):
        pass


def modo_vivo(ips, com, intervalo, puerto, clave=None, url=URL_WEB):
    """Pregunta cada pocos segundos y cuenta cada copia nueva. Solo escucha en este ordenador."""
    base = {}
    for ip in ips:
        r = leer_impresora(ip, com)
        if not r:
            continue
        base[ip] = {"r": r, "inicial": r["total"] or ((r["bn"] or 0) + (r["color"] or 0)), "eventos": []}
    if not base:
        sys.exit("No he podido leer ninguna impresora.")
    perfiles = {ip: PERFILES.get(b["r"]["marca"], {}) for ip, b in base.items()}

    def publicar():
        with CERROJO:
            ESTADO_VIVO["impresoras"] = [{
                "ip": ip, "modelo": b["r"]["modelo"], "serie": b["r"]["serie"],
                "total": b["r"]["total"], "bn": b["r"]["bn"], "color": b["r"]["color"],
                "hora": datetime.datetime.now().strftime("%H:%M:%S"),
                "sesion": (b["r"]["total"] or 0) - b["inicial"], "eventos": b["eventos"][:8]}
                for ip, b in base.items()]
    publicar()
    servidor = ThreadingHTTPServer(("127.0.0.1", puerto), _Servidor)
    threading.Thread(target=servidor.serve_forever, daemon=True).start()
    print(f"\nEN DIRECTO. Abre en el navegador:  http://localhost:{puerto}")
    print("Cada copia nueva saldrá aquí y en esa página. Para parar: Ctrl + C\n")
    try:
        while True:
            time.sleep(intervalo)
            for ip, b in base.items():
                r, pf = b["r"], perfiles[ip]
                tot = leer_contador(ip, com, pf["total"]) if "total" in pf else None
                if tot is None:
                    tot = get(ip, com, OID_TOTAL_STD)
                bn = leer_contador(ip, com, pf["bn"]) if "bn" in pf else None
                co = leer_contador(ip, com, pf["color"]) if "color" in pf else None
                if not isinstance(tot, int):
                    continue
                if tot != r["total"]:
                    partes = []
                    if bn is not None and r["bn"] is not None and bn > r["bn"]:
                        partes.append(f"+{bn - r['bn']} blanco y negro")
                    if co is not None and r["color"] is not None and co > r["color"]:
                        partes.append(f"+{co - r['color']} color")
                    if not partes:
                        partes.append(f"+{tot - r['total']} página(s)")
                    linea = datetime.datetime.now().strftime("%H:%M:%S") + "  " + ", ".join(partes) + f"  (total {tot})"
                    print(f"  {ip}  {linea}")
                    b["eventos"].insert(0, linea)
                    r["total"] = tot
                if bn is not None:
                    r["bn"] = bn
                if co is not None:
                    r["color"] = co
                if clave and b["eventos"] and b.get("subido") != r["total"]:
                    try:
                        subir(url, clave, "", [r])
                        b["subido"] = r["total"]
                    except Exception as e:
                        print("    (no se pudo enviar a la web:", e, ")")
            publicar()
    except KeyboardInterrupt:
        print("\nParado.")


# ---------- Modo instalado (sin ventana) ----------
# Lo usa el programa instalado: arranca con Windows, lee cada minuto y manda a la web
# cuando cambia un contador (o cada 15 minutos aunque no cambie). Deja un registro en
# %LOCALAPPDATA%\LectorImpresoras\lector.log para poder ver qué ha pasado.
def _ruta_log():
    base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    carpeta = os.path.join(base, "LectorImpresoras")
    os.makedirs(carpeta, exist_ok=True)
    return os.path.join(carpeta, "lector.log")


def log(msg):
    try:
        ruta = _ruta_log()
        if os.path.exists(ruta) and os.path.getsize(ruta) > 1_000_000:
            os.replace(ruta, ruta + ".old")
        with open(ruta, "a", encoding="utf-8") as f:
            f.write(datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S ") + msg + "\n")
    except Exception:
        pass
    print(msg)


def modo_servicio(conf):
    # Solo una copia a la vez (el arranque de Windows y el instalador podrían abrir dos).
    cerrojo = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        cerrojo.bind(("127.0.0.1", 8766))
    except OSError:
        return
    clave = conf.get("clave")
    if not clave:
        log("Falta la clave en lector.txt. Vuelve a instalar el programa y pega la clave.")
        return
    com = conf.get("comunidad", "public")
    fijas = [x.strip() for x in conf.get("ip", "").split(",") if x.strip()]
    redes = [x.strip() for x in conf.get("red", "").split(",") if x.strip()]
    log("Lector en marcha.")
    ips, buscado, enviado, ultimo = [], 0.0, {}, 0.0
    while True:
        try:
            if fijas:
                ips = fijas
            elif not ips and time.time() - buscado > 300 or time.time() - buscado > 6 * 3600:
                mi = ip_local()
                objetivo = redes or ([mi.rsplit(".", 1)[0] + ".0/24"] if mi else [])
                ips = descubrir(objetivo, com) if objetivo else []
                buscado = time.time()
                log(f"Buscadas impresoras en {', '.join(objetivo) or '(sin red)'}: {len(ips)} encontradas.")
            lects = []
            for ip in ips:
                try:
                    r = leer_impresora(ip, com)
                    if r:
                        lects.append(r)
                except Exception as e:
                    log(f"Error leyendo {ip}: {e}")
            firma = {l["ip"]: (l["total"], l["bn"], l["color"]) for l in lects}
            if lects and (firma != enviado or time.time() - ultimo > 15 * 60):
                try:
                    subir(URL_WEB, clave, "", lects)
                    if firma != enviado:
                        log("Enviado: " + "; ".join(f"{l['modelo']} total {l['total']}" for l in lects))
                    enviado, ultimo = firma, time.time()
                except Exception as e:
                    log(f"No se pudo enviar a la web (se reintenta en un minuto): {e}")
        except Exception as e:
            log(f"Error: {e}")
        time.sleep(60)


def main():
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="Lector de contadores de impresoras (solo lee contadores).")
    ap.add_argument("--red", action="append", help="red a explorar, p. ej. 192.168.0.0/24 (por defecto, la tuya)")
    ap.add_argument("--ip", action="append", help="leer solo esta(s) IP, sin explorar")
    ap.add_argument("--comunidad", default="public")
    ap.add_argument("--cliente", default="Sin nombre")
    ap.add_argument("--salida", default="lecturas.json")
    ap.add_argument("--subir", help="URL de la web a la que enviar las lecturas")
    ap.add_argument("--clave", help="clave de acceso para enviar a la web")
    ap.add_argument("--vivo", action="store_true", help="modo en directo: cuenta cada copia y abre una página local")
    ap.add_argument("--intervalo", type=float, default=4, help="segundos entre lecturas en modo directo (por defecto 4)")
    ap.add_argument("--puerto", type=int, default=8765, help="puerto de la página en directo")
    ap.add_argument("--cada", type=float, help="leer y enviar a la web cada N minutos, sin parar")
    a = ap.parse_args()
    conf = leer_config()
    a.clave = a.clave or conf.get("clave")
    a.subir = a.subir or (URL_WEB if a.clave else None)
    if not a.ip and not a.red:
        if conf.get("ip"):
            a.ip = [x.strip() for x in conf["ip"].split(",") if x.strip()]
        elif conf.get("red"):
            a.red = [x.strip() for x in conf["red"].split(",") if x.strip()]
    if a.cada is None and conf.get("cada"):
        a.cada = float(conf["cada"])
    # Con doble clic y una clave guardada: se queda leyendo cada 15 minutos.
    if len(sys.argv) == 1 and a.clave and a.cada is None:
        a.cada = 15

    if a.ip:
        ips = a.ip
    else:
        redes = a.red
        if not redes:
            mi = ip_local()
            if not mi:
                sys.exit("No encuentro tu red. Usa --red 192.168.0.0/24")
            redes = [mi.rsplit(".", 1)[0] + ".0/24"]
        print("Buscando impresoras en", ", ".join(redes), "(puede tardar un minuto)...")
        ips = descubrir(redes, a.comunidad)
        print(f"Encontradas {len(ips)} impresoras que responden por SNMP.")

    if a.vivo:
        if not ips:
            sys.exit("No he encontrado impresoras. Prueba con --ip 192.168.0.5")
        modo_vivo(ips, a.comunidad, a.intervalo, a.puerto, a.clave, a.subir or URL_WEB)
        return

    if a.cada:
        print(f"Leyendo cada {a.cada:g} minutos y enviando a la web. Para parar: Ctrl + C")
        ultimo_descubrimiento = time.time()
        try:
            while True:
                if not a.ip and (not ips or time.time() - ultimo_descubrimiento > 6 * 3600):
                    ips = descubrir(a.red or [ip_local().rsplit(".", 1)[0] + ".0/24"], a.comunidad)
                    ultimo_descubrimiento = time.time()
                lects = [r for r in (leer_impresora(ip, a.comunidad) for ip in ips) if r]
                hora = datetime.datetime.now().strftime("%H:%M")
                try:
                    subir(a.subir, a.clave or "", a.cliente, lects) if a.subir else None
                    print(f"{hora}  {len(lects)} impresora(s) leídas y enviadas")
                except Exception as e:
                    print(f"{hora}  leídas {len(lects)}, pero no se pudo enviar: {e}")
                time.sleep(a.cada * 60)
        except KeyboardInterrupt:
            print("Parado.")
        return

    lecturas = []
    for ip in ips:
        try:
            r = leer_impresora(ip, a.comunidad)
        except Exception as e:           # una impresora rara no debe parar al resto
            print(f"  {ip}: error al leer ({e})")
            continue
        if not r:
            continue
        lecturas.append(r)
        print(f"- {ip} | {r['marca']} | {r['modelo']} | serie {r['serie']}")
        print(f"    total {r['total']} | blanco y negro {r['bn']} | color {r['color']}")
        for t in r["toner"]:
            if "toner" in t["nombre"].lower() or "tóner" in t["nombre"].lower():
                print(f"    {t['nombre']}: {t['nivel']}%")
        for av in r["avisos"]:
            print("    AVISO:", av)

    with open(a.salida, "w", encoding="utf-8") as f:
        json.dump({"cliente": a.cliente, "lecturas": lecturas}, f, ensure_ascii=False, indent=2)
    print(f"\nGuardado en {a.salida}")
    if a.subir:
        try:
            print("Enviado a la web, respuesta:", subir(a.subir, a.clave or "", a.cliente, lecturas))
        except Exception as e:
            print("No se pudo enviar (queda guardado en el archivo):", e)


if __name__ == "__main__":
    if getattr(sys, "frozen", False) and len(sys.argv) == 1:
        modo_servicio(leer_config())
    else:
        main()
