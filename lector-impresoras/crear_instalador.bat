@echo off
chcp 65001 >nul
echo ==============================================
echo  Creando el programa "LectorImpresoras.exe"
echo ==============================================
echo.
py -m pip install --quiet pyinstaller
if errorlevel 1 (
  echo No he podido instalar PyInstaller. Revisa tu conexion a internet.
  pause
  exit /b 1
)
py -m PyInstaller --onefile --name LectorImpresoras --console agente_lector.py
if errorlevel 1 (
  echo Algo ha fallado al crear el programa.
  pause
  exit /b 1
)
echo.
echo Listo. El programa esta en la carpeta "dist": LectorImpresoras.exe
echo Pruebalo asi:   dist\LectorImpresoras.exe --cliente "Mi cliente"
pause
