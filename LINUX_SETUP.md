# Quantum Dual V34 — Linux Individual

## Objetivo de esta edición

Esta es la primera edición de validación individual.

- **Crypto / Binance USD-M Futures:** ejecución automática.
- **Forex:** análisis automático y señales Telegram únicamente.
- **No MT5.**
- **No Wine.**
- **No ejecución Forex automática.**
- SQLite y bóveda de credenciales permanecen en un volumen Docker persistente.

## Arquitectura

```text
Internet
   |
   v
Nginx / Frontend :8080
   |
   v
Backend V34 :8787 (red Docker interna)
   |-- SQLite + Vault AES-256-GCM
   |-- Binance Futures API
   |-- Binance Market Data
   |-- Twelve Data Forex Market Data
   `-- Telegram Bot API
```

Solo el puerto `8080` se publica por defecto.

## Requisitos Linux

Probado/objetivo:

- Ubuntu 22.04/24.04 o Debian moderno.
- Git.
- Docker Engine.
- Docker Compose plugin (`docker compose`).

## Instalación

```bash
git clone https://github.com/mbcx07/Maquina-de-trading.git
cd Maquina-de-trading
git checkout feature/v34-dual-market-engine

docker compose -f docker-compose.linux.yml build
docker compose -f docker-compose.linux.yml up -d
```

Comprobar:

```bash
docker compose -f docker-compose.linux.yml ps
docker compose -f docker-compose.linux.yml logs -f backend
```

Abrir en navegador:

```text
http://IP_DEL_SERVIDOR:8080
```

## Persistencia

El volumen `v34_data` contiene:

- `trading-v34.sqlite`
- `.integration-vault-key`

No borrar ese volumen si se desea conservar:

- configuración;
- claves cifradas;
- historial de operaciones;
- métricas;
- señales Forex;
- backtests.

Backup recomendado:

```bash
docker run --rm \
  -v maquina-de-trading_v34_data:/source:ro \
  -v "$PWD":/backup \
  alpine sh -c 'cd /source && tar czf /backup/v34-data-backup.tgz .'
```

## Primera configuración

Entrar a **Configuración** en V34.

### Binance Futures

Introducir:

- API Key
- API Secret

Recomendaciones:

- habilitar únicamente los permisos necesarios para Futures;
- deshabilitar withdrawals;
- en REAL usar whitelist de la IP pública fija del VPS;
- usar claves nuevas, no las que alguna vez estuvieron en el repositorio público.

Empezar en `PAPER`, después `BINANCE TESTNET` y solo posteriormente `REAL`.

### Telegram

Introducir:

- Bot Token
- Chat ID / canal

`Guardar y conectar` envía automáticamente un mensaje de prueba.

Telegram recibe:

- apertura Crypto;
- cierre Crypto;
- PnL y win rate;
- alertas de riesgo;
- errores de protección;
- señales Forex manuales.

### Forex Data

Forex usa Twelve Data únicamente como proveedor de datos.

Introducir la API Key en la tarjeta **FOREX DATA**.

V34 solicita series `1min` y `15min` para cada par configurado.

Símbolos V34:

```text
EURUSD
GBPUSD
USDJPY
EURJPY
```

El cliente transforma internamente `EURUSD` a `EUR/USD` para el proveedor.

Configuración inicial conservadora:

- 4 pares;
- escaneo cada 15 minutos;
- máximo 4 señales por ciclo.

La propia UI muestra una estimación de créditos por día.

## Regla Binance

Máximo absoluto: **10 posiciones Crypto simultáneas**.

Cada posición debe ser una coin diferente.

Ejemplo válido:

```text
BTCUSDT
ETHUSDT
SOLUSDT
XRPUSDT
BNBUSDT
DOGEUSDT
ADAUSDT
AVAXUSDT
LINKUSDT
SUIUSDT
```

Ejemplo inválido:

```text
BTCUSDT posición 1
BTCUSDT posición 2
```

Mientras BTCUSDT permanezca activo, una nueva oportunidad BTCUSDT queda bloqueada.

## Regla de capital Crypto

Ejemplo:

```text
Futures balance = $100
Margen/trade = 1%
Leverage solicitado = 20x
```

Objetivo:

```text
Margen = $1
Nocional aproximado = $20
```

Si la coin permite máximo 10x:

```text
Margen = $1
Nocional aproximado = $10
```

Si Binance no permite el tamaño mínimo requerido, V34 **omite** la operación. No aumenta silenciosamente el porcentaje configurado.

## Forex Signal Only

Forex nunca ejecuta órdenes.

Cada señal enviada a Telegram contiene:

- par;
- BUY/SELL;
- entrada de referencia;
- SL;
- TP;
- TP2/TP3 cuando existan;
- R:R;
- timeframe;
- confianza;
- rolling win rate;
- score;
- número de retest;
- estrategia/motivo.

Una señal consecutiva dentro de la misma zona no se repite. Para generar un nuevo retest el setup debe dejar de ser válido y posteriormente volver a activarse.

## Arranque del motor

El motor no inicia Forex si falta:

- API Key de Forex Data; o
- Telegram.

En `TESTNET`/`REAL`, Crypto tampoco inicia si faltan las credenciales Binance.

## Emergency Stop

### PAUSE_ONLY

- bloquea nuevas entradas Binance;
- bloquea nuevas señales Forex;
- mantiene posiciones Binance existentes con sus protecciones.

### CLOSE_TRACKED

- pausa el motor;
- solicita cierre reduce-only de las posiciones Binance registradas por V34;
- Forex no necesita cierres porque no abre operaciones.

## Backtest

La edición Linux muestra por ahora **Backtest Binance**.

Incluye:

- net profit;
- return;
- win rate;
- profit factor;
- expectancy;
- max drawdown;
- costos;
- trades;
- resultados por símbolo;
- bloque out-of-sample.

El rolling backtest del scanner no sustituye la prueba histórica de rentabilidad.

## Actualizar la aplicación

```bash
git pull
docker compose -f docker-compose.linux.yml build
docker compose -f docker-compose.linux.yml up -d
```

El volumen de datos no se elimina con esos comandos.

## Apagar

```bash
docker compose -f docker-compose.linux.yml down
```

Para reiniciar:

```bash
docker compose -f docker-compose.linux.yml up -d
```

No usar `down -v` salvo que se quiera borrar deliberadamente la base, historial y bóveda.

## Secuencia recomendada de validación

1. PAPER.
2. Backtest de varias ventanas Binance.
3. Verificar señales Forex Telegram.
4. Binance Testnet.
5. Acumular operaciones y evaluar métricas.
6. Ajustar estrategia/filtros si es necesario.
7. REAL solo después de validar ejecución, SL/TP, reconciliación, costos y drawdown.
