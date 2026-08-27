# Quantum Dual V34 — Prueba individual

## Objetivo actual

Antes de construir membresías, probar V34 como una sola instalación y medir si el sistema es rentable y estable.

Arquitectura individual:

`Dashboard React -> Backend V34 + SQLite -> Binance Futures / MT5 Bridge -> Telegram`

## 1. Binance

Desde `Configuración > Integraciones`:

1. Introducir API Key.
2. Introducir API Secret.
3. Pulsar `Guardar y conectar`.
4. Verificar conexión antes de usar TESTNET o REAL.

Las credenciales se almacenan cifradas en el backend. No se vuelven a mostrar completas al navegador.

Reglas Crypto:

- máximo 10 posiciones;
- cada posición debe ser una coin diferente;
- una coin abierta bloquea nuevas entradas de esa misma coin;
- porcentaje configurado = margen objetivo por trade;
- leverage solicitado se limita automáticamente al máximo permitido;
- SL/TP se colocan en Binance;
- si la protección falla después de abrir, se intenta cierre reduce-only de emergencia;
- reconciliación periódica recupera PnL, comisiones y funding reales.

## 2. Telegram

Desde `Configuración > Integraciones`:

1. Introducir Bot Token.
2. Introducir Chat ID.
3. Pulsar `Guardar y conectar`.
4. La aplicación envía un mensaje de prueba.

Telegram recibe aperturas, cierres, PnL, win rate y alertas operativas.

## 3. MT5 — conexión individual recomendada

### Requisitos

Usar una PC o VPS Windows con:

- MetaTrader 5 instalado;
- una cuenta MT5 Demo abierta e iniciada sesión;
- Python instalado;
- trading algorítmico habilitado en MT5.

Para poder mantener varios tickets independientes del mismo par, la cuenta debe ser **hedging**. Una cuenta netting no sirve para la lógica de retests múltiples.

### Instalar el bridge

En la misma PC/VPS donde está MT5:

```bat
cd mt5-bridge
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
```

Editar `mt5-bridge/.env`:

```env
MT5_BRIDGE_HOST=127.0.0.1
MT5_BRIDGE_PORT=8790
MT5_BRIDGE_TOKEN=pon-un-token-largo-y-aleatorio

# Estos campos son opcionales.
# Para la prueba individual es preferible dejar MetaTrader ya iniciado sesión.
MT5_LOGIN=
MT5_PASSWORD=
MT5_SERVER=
MT5_TERMINAL_PATH=
```

Arrancar la aplicación completa del bridge:

```bat
uvicorn app:app --host 127.0.0.1 --port 8790
```

El bridge expone ejecución, cuenta, posiciones, historial y market data M1/M5/M15/H1.

### Si backend y MT5 están en la misma PC

Usar:

```text
Bridge URL: http://127.0.0.1:8790
Bridge Token: el mismo MT5_BRIDGE_TOKEN
```

### Si MT5 está en otro VPS

No exponer el puerto 8790 directamente a Internet. Usar VPN privada/Tailscale o un reverse proxy HTTPS autenticado y restringido por firewall.

### Validación MT5

La prueba de conexión debe confirmar:

- `tradeAllowed = true`;
- `tradeExpert = true`;
- `hedging = true` si se quieren múltiples retests del mismo par;
- balance/equity correctos;
- servidor y login correctos.

## 4. Backend

```bash
cd backend
cp .env.example .env
npm install
npm run selftest
npm run typecheck
npm run dev
```

Backend por defecto:

`http://127.0.0.1:8787`

SQLite:

`backend/data/trading-v34.sqlite`

La llave local de cifrado se genera fuera de Git. En producción se debe usar `INTEGRATION_MASTER_KEY` mediante Secret Manager/KMS.

## 5. Frontend

Desde la raíz:

```bash
npm install
npm run dev
```

El frontend consulta por defecto:

`http://127.0.0.1:8787`

## 6. Secuencia correcta de prueba

### Etapa A — PAPER / observación

Objetivo: comprobar scanner, ranking y señales sin dinero.

- revisar frecuencia de señales;
- validar que Crypto nunca repite símbolos;
- validar retests Forex;
- revisar SL/TP propuestos;
- medir backtest rodante y distribución por símbolo;
- verificar persistencia tras reiniciar navegador/backend.

### Etapa B — Binance Testnet + MT5 Demo

Esta es la prueba importante de ejecución real sin capital real.

Verificar durante suficientes operaciones:

- orden realmente abierta por broker;
- tamaño correcto;
- leverage correcto;
- SL y TP colocados;
- cierre por SL/TP detectado;
- PnL real recuperado;
- fees/funding/swap correctos;
- Telegram de apertura y cierre;
- reinicio del backend con posiciones abiertas;
- cierre manual desde Binance/MT5;
- desconexión/reconexión de red;
- retests múltiples del mismo par en MT5 hedging.

### Etapa C — Capital real pequeño

Solo después de que Testnet/Demo sea estable.

Usar tamaño pequeño y no aumentar capital por unos pocos trades positivos.

## 7. Cómo decidir si realmente es rentable

No usar solo win rate. Evaluar por separado Crypto y Forex:

- mínimo 100 operaciones cerradas por motor antes de una conclusión preliminar;
- profit neto después de comisiones, funding y swap;
- Profit Factor;
- expectancy por operación;
- drawdown máximo;
- average win / average loss;
- rendimiento por símbolo;
- rendimiento por estrategia/setup;
- estabilidad por semana, no solo resultado acumulado;
- slippage real contra entrada teórica.

Como referencia de prueba interna, no como garantía de rentabilidad, buscamos un Profit Factor sostenido mayor a 1 y expectancy neta positiva. El sistema no debe pasar a capital significativo solo por tener un win rate alto.

## 8. Lo que todavía falta antes de considerarlo listo para dinero real

1. Terminar la tarjeta visual de conexión MT5 en Configuración usando los endpoints cifrados ya preparados.
2. Hacer una prueba end-to-end real del bridge con un terminal MT5 Demo.
3. Hacer una prueba end-to-end con Binance Testnet.
4. Validar específicamente el endpoint vigente de SL/TP condicional de Binance en Testnet.
5. Añadir un reporte de rendimiento por día/semana y curva de equity en el dashboard.
6. Añadir exportación CSV del historial para auditoría.
7. Añadir control explícito de spread máximo para Forex y slippage observado.
8. Añadir política configurable del Emergency Stop: solo pausar o cerrar todas las posiciones.
9. Mantener al menos una fase Demo/Testnet suficientemente amplia antes de REAL.

## 9. Membresías

Se posponen. Primero se prueba una sola cuenta. La bóveda de integraciones ya usa `workspace_id`, pero el resto de la plataforma seguirá tratándose como instalación individual hasta demostrar estabilidad y rentabilidad.
