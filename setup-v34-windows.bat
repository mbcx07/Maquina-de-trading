@echo off
setlocal
cd /d "%~dp0"

echo =====================================================
echo   QUANTUM DUAL V34 - PREPARACION WINDOWS
ECHO =====================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js no esta instalado o no esta en PATH.
  echo Instala Node.js LTS y vuelve a ejecutar este archivo.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm no esta disponible.
  pause
  exit /b 1
)

where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Python no esta instalado o no esta en PATH.
  echo Recomendado: Python 3.12 x64.
  pause
  exit /b 1
)

echo [1/4] Instalando dependencias frontend...
call npm install
if errorlevel 1 goto :fail

echo.
echo [2/4] Instalando dependencias backend...
pushd backend
call npm install
if errorlevel 1 (
  popd
  goto :fail
)
if not exist .env (
  if exist .env.example copy /Y .env.example .env >nul
)
popd

echo.
echo [3/4] Preparando MT5 Bridge Python...
pushd mt5-bridge
if not exist .venv (
  python -m venv .venv
  if errorlevel 1 (
    popd
    goto :fail
  )
)
call .venv\Scripts\activate.bat
python -m pip install --upgrade pip
pip install -r requirements.txt
if errorlevel 1 (
  popd
  goto :fail
)
if not exist .env (
  if exist .env.example copy /Y .env.example .env >nul
)
popd

echo.
echo [4/4] Verificacion basica backend...
pushd backend
call npm run selftest
if errorlevel 1 (
  popd
  goto :fail
)
call npm run typecheck
if errorlevel 1 (
  popd
  goto :fail
)
popd

echo.
echo =====================================================
echo PREPARACION COMPLETADA
ECHO =====================================================
echo.
echo Antes de arrancar:
echo 1. Abre MetaTrader 5 en Windows.
echo 2. Inicia sesion en una cuenta DEMO.
echo 3. Activa trading algoritmico / Expert Advisors.
echo 4. Edita mt5-bridge\.env y cambia MT5_BRIDGE_TOKEN.
echo 5. Ejecuta start-v34-windows.bat.
echo 6. En Configuracion conecta Binance, MT5 y Telegram.
echo.
pause
exit /b 0

:fail
echo.
echo [ERROR] La preparacion fallo. Revisa el mensaje anterior.
pause
exit /b 1
