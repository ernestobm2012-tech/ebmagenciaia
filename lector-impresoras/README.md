# Lector de impresoras

Programa que se instala en un ordenador de la red del cliente, lee por SNMP los contadores
(total, blanco y negro, color) y el tóner de cada impresora y los manda al panel
(`ebmagenciaia.es/admin/` → Impresoras). Solo lee contadores; nunca documentos.

## Instalar en un cliente (sin Python)
1. En el panel: Clientes → el cliente → Datos → marcar «Lector de impresoras» → pestaña Impresoras → «Crear clave del lector».
2. En el ordenador del cliente: descargar https://github.com/ernestobm2012-tech/ebmagenciaia/releases/download/lector/LectorImpresoras-Instalador.exe, abrirlo, pegar la clave y terminar. Sin permisos de administrador.
3. Queda instalado en `%LOCALAPPDATA%\Programs\LectorImpresoras`, arranca con Windows (carpeta Inicio), sin ventana: lee cada minuto y envía si cambia un contador o cada 15 min. Registro en `%LOCALAPPDATA%\LectorImpresoras\lector.log`.

El instalador lo fabrica GitHub Actions (`.github/workflows/lector-instalador.yml`, Inno Setup en `instalador/`) con cada cambio en esta carpeta y lo sube a la release `lector`. Sin firma de código: Windows SmartScreen avisa la primera vez.

Otras opciones: `--vivo` cuenta cada copia y abre una página local en http://localhost:8765; `--ip 192.168.0.5` para una impresora concreta; `--cada 5` para leer cada 5 minutos.

`crear_instalador.bat` (en Windows con Python) crea `dist/LectorImpresoras.exe` con PyInstaller. Sin firma de código, Windows avisa de «programa no reconocido».

## Marcas
Xerox probada con una WorkCentre 6515 real (total y tóner confirmados; b/n = `…6.1.20.34`, color = `…6.1.20.33`, pendiente de confirmar con una copia en b/n). Ricoh, Konica Minolta, Lexmark, HP y Sharp: OIDs sacados de documentación pública, sin probar. Kyocera y Samsung: sin reparto b/n-color; el lector guarda un volcado para mapearlas.
