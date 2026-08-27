@echo off
setlocal
cd /d "%~dp0"

echo =====================================================
echo   QUANTUM DUAL V34 - ARRANQUE LOCAL
ECHO =====================================================
echo.

if not exist backend\node_modules (
  echo [ERROR] Backend no preparado. Ejecuta setup-v34-windows.bat primero.
  pause
  exit /b 1
)

if not exist node_modules (
  echo [ERROR] Frontend no preparado. Ejecuta setup-v34-windows.bat primero.
  pause
  exit /b 1
)

if not exist mt5-bridge\.venv\Scripts\python.exe (
  echo [ERROR] MT5 Bridge no preparado. Ejecuta setup-v34-windows.bat primero.
  pause
  exit /b 1
)

if not exist mt5-bridge\.env (
  echo [ERROR] Falta mt5-bridge\.env
  pause
  exit /b 1
)

echo Abriendo MT5 Bridge en puerto 8790...
start "V34 MT5 Bridge" cmd /k "cd /d %~dp0mt5-bridge && call .venv\Scripts\activate.bat && uvicorn app:app --host 127.0.0.1 --port 8790"

timeout /t 2 /nobreak >nul

echo Abriendo backend V34 en puerto 8787...
start "V34 Backend" cmd /k "cd /d %~dp0backend && npm run dev"

timeout /t 2 /nobreak >nul

echo Abriendo frontend V34...
start "V34 Frontend" cmd /k "cd /d %~dp0 && npm run dev"

echo.
echo Servicios iniciados en ventanas separadas.
echo.
echo MT5 Bridge: http://127.0.0.1:8790
echo Backend:    http://127.0.0.1:8787
echo Frontend:   revisa la URL que muestre Vite, normalmente http://localhost:3000 o 5173
echo.
echo Deja MetaTrader 5 abierto durante la prueba Forex.
echo Para detener todo, cierra las tres ventanas de servicio.
echo.
pause
