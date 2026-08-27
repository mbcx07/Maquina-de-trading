# Quantum Dual V34 — Setup

## Estado de esta rama

La rama `feature/v34-dual-market-engine` separa por completo el frontend de la ejecución firmada.

Arquitectura:

`React dashboard -> V34 backend + SQLite -> Binance / MT5 bridge -> Telegram`

## Reglas implementadas

### Binance Futures

- Máximo 10 posiciones simultáneas.
- Cada posición Crypto debe ser de un símbolo diferente.
- Mientras `BTCUSDT` esté activo, ninguna nueva señal BTCUSDT puede ejecutarse.
- El selector conserva solo la mejor oportunidad por símbolo.
- Existe una restricción SQLite adicional para impedir duplicados por condiciones de carrera.
- El usuario configura porcentaje de margen por trade y leverage solicitado.
- El leverage efectivo nunca supera el permitido por Binance para el símbolo.
- Si el tamaño no cumple mínimos de Binance, la operación se rechaza; no se aumenta el capital automáticamente.
- SL/TP condicionales se envían desde backend mediante el flujo de Algo Service previsto para USD-M Futures.

### Forex / MT5

- Puede haber múltiples operaciones del mismo par.
- Cada retest/reentrada usa un `signalFingerprint` distinto y recibe su propio ticket.
- La misma señal exacta no puede duplicarse.
- Si la cuenta MT5 es netting, una segunda posición independiente del mismo símbolo se bloquea.
- Para retests independientes se requiere una cuenta MT5 de tipo hedging.
- El lotaje puede calcularse como `RISK_TO_SL` o `MARGIN_PERCENT`.

## 1. Seguridad primero

Las claves que estuvieron escritas en el frontend deben considerarse comprometidas y revocarse/rotarse.

Nunca guardar nuevas claves en:

- `App.tsx`
- `services/*.ts` del frontend
- `.env` versionado
- README o screenshots

Usar solo variables de entorno del backend.

Recomendación para Binance:

- deshabilitar withdrawals;
- habilitar únicamente permisos necesarios para Futures;
- usar restricción de IP cuando el servidor tenga IP fija;
- claves distintas para pruebas y producción.

## 2. Backend

```bash
cd backend
cp .env.example .env
npm install
npm run selftest
npm run typecheck
npm run dev
```

Por defecto escucha en:

`http://127.0.0.1:8787`

La base SQLite se crea en:

`backend/data/trading-v34.sqlite`

### Variables principales

```env
APP_MODE=PAPER
CRYPTO_MAX_TRADES=10
CRYPTO_MARGIN_PCT=1
CRYPTO_REQUESTED_LEVERAGE=20
FOREX_MAX_TRADES=20
FOREX_MAX_ENTRIES_PER_SYMBOL=0
```

`CRYPTO_MAX_TRADES` nunca puede ser mayor a 10.

## 3. Frontend

Desde la raíz:

```bash
npm install
npm run dev
```

El dashboard consulta por defecto:

`http://127.0.0.1:8787/api/state`

Para usar otra URL:

```env
VITE_V34_API_BASE=https://tu-backend.example.com
```

## 4. MT5 Bridge

El bridge debe ejecutarse en la misma PC/VPS Windows donde está instalado MetaTrader 5.

```bash
cd mt5-bridge
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
python main.py
```

Endpoint por defecto:

`http://127.0.0.1:8790`

### Cuenta recomendada

Primero usar **MT5 Demo** y verificar en `/health` que:

```json
{
  "account": {
    "hedging": true
  }
}
```

Con `hedging: true`, EURUSD puede mantener tickets independientes para distintos retests.

## 5. Telegram

Configurar solo en `backend/.env`:

```env
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

La app envía eventos de apertura/cierre y alertas operativas.

## 6. Secuencia de pruebas

### Fase A — PAPER

1. `APP_MODE=PAPER`.
2. Confirmar que el motor inicia apagado.
3. Inyectar oportunidades de prueba.
4. Verificar que el selector Crypto nunca devuelve más de 10 símbolos ni repite uno.
5. Verificar que Forex sí permite varios EURUSD con fingerprints diferentes.
6. Cerrar/reabrir el navegador y confirmar que historial y settings permanecen.
7. Reiniciar backend y confirmar persistencia SQLite.

### Fase B — Binance Testnet + MT5 Demo

1. Configurar credenciales nuevas de Binance Testnet.
2. Mantener MT5 en Demo.
3. Seleccionar `TESTNET / DEMO` en la UI.
4. Verificar leverage real confirmado por Binance.
5. Verificar que SL/TP aparezcan como órdenes condicionales vigentes.
6. Verificar reconciliación de posiciones.
7. Probar desconexión de red y reinicio del backend.
8. Probar varios retests del mismo par Forex en cuenta hedging.

### Fase C — REAL

No habilitar hasta completar pruebas de:

- pérdida diaria máxima;
- drawdown máximo;
- cierre/reconciliación tras reinicio;
- posición cerrada manualmente fuera de la app;
- SL/TP ejecutado por broker;
- error parcial (entrada abre y protección falla);
- Telegram caído;
- Binance/MT5 caído;
- emergency stop.

## 7. Endpoints actuales

- `GET /health`
- `GET /api/state`
- `PATCH /api/settings`
- `POST /api/engine/start`
- `POST /api/engine/pause`
- `POST /api/emergency-stop`
- `POST /api/opportunities/ingest`

MT5 bridge:

- `GET /health`
- `GET /account`
- `GET /positions`
- `POST /size`
- `POST /order`
- `POST /close`

## 8. Siguiente bloque técnico

Aún falta completar antes de producción:

1. migrar el scanner/estrategias completamente al backend;
2. reconciliador periódico Binance;
3. reconciliador periódico MT5;
4. detección de cierre y PnL/fees/funding/swap reales;
5. cierre Telegram automático con win rate actualizado;
6. límites diarios de riesgo/drawdown;
7. emergency stop con política de cierre masivo configurable;
8. pruebas integradas contra Binance Testnet y MT5 Demo.
