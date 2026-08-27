# Quantum Dual V34 — Linux Individual

## Alcance de esta edición

Primera versión para validar estabilidad y rentabilidad antes de membresías:

- **Crypto / Binance USD-M Futures:** ejecución automática.
- **Forex:** análisis automático y señales Telegram para ejecución manual.
- **Sin MT5 y sin Wine.**
- **SQLite + bóveda cifrada** en volumen Docker persistente.
- El dashboard no se publica directamente a Internet por defecto.

## Arquitectura

```text
Navegador
   |
   | túnel SSH / VPN privada
   v
127.0.0.1:8080 -> Nginx / React
                     |
                     v
              Backend V34 :8787
                |-- SQLite + Vault AES-256-GCM
                |-- Binance Futures API
                |-- Binance Market Data
                |-- Twelve Data Forex Data
                `-- Telegram Bot API
```

## Requisitos

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

## Acceso seguro al dashboard

Docker publica la interfaz solamente en `127.0.0.1:8080` del VPS.

Desde tu computadora crea un túnel SSH:

```bash
ssh -L 8080:127.0.0.1:8080 USUARIO@IP_DEL_VPS
```

Mientras esa sesión SSH permanezca abierta, entra en tu navegador a:

```text
http://127.0.0.1:8080
```

No cambies el binding a `0.0.0.0:8080` sin colocar antes autenticación HTTPS, firewall o una VPN privada como Tailscale. El dashboard permite controlar un motor de trading y no debe quedar público.

## Persistencia

El volumen Docker `v34_data` contiene:

- `trading-v34.sqlite`
- `.integration-vault-key`
- configuración
- credenciales cifradas
- historial Binance
- métricas
- señales Forex
- backtests

No uses `docker compose ... down -v` salvo que quieras borrar deliberadamente todos esos datos.

## Configuración desde la aplicación

### Binance Futures

En **Configuración > Binance Futures** introduce:

- API Key
- API Secret

Reglas de seguridad:

- habilita solo los permisos necesarios para Futures;
- deshabilita retiros;
- para REAL usa whitelist de la IP fija del VPS;
- usa claves nuevas, nunca claves que hayan aparecido en un repositorio público.

Orden recomendado:

```text
PAPER -> BINANCE TESTNET -> REAL
```

### Telegram

En **Configuración > Telegram** introduce:

- Bot Token
- Chat ID / canal

`Guardar y conectar` envía un mensaje de prueba.

Telegram recibe:

- apertura Crypto;
- cierre Crypto;
- PnL y win rate;
- alertas de riesgo y errores;
- señales Forex para ejecución manual.

### Forex Data

En **Configuración > Forex Data** introduce una API Key de Twelve Data.

Esta integración es únicamente de lectura de mercado. No tiene capacidad para abrir, modificar ni cerrar operaciones.

Configuración inicial V34:

```text
EURUSD
GBPUSD
USDJPY
EURJPY
```

El motor transforma internamente, por ejemplo, `EURUSD` a `EUR/USD`.

Por defecto usa series de 1 minuto y 15 minutos. El intervalo del scanner y los pares pueden cambiarse desde la interfaz.

## Regla Binance: 10 coins distintas

Máximo absoluto: **10 posiciones Crypto simultáneas**.

Cada posición debe tener símbolo diferente. Mientras `BTCUSDT` siga abierto, otra señal `BTCUSDT` no puede abrir una segunda posición.

## Capital Crypto

Ejemplo:

```text
Balance Futures = $100
Margen por operación = 1%
Leverage solicitado = 20x
```

Resultado objetivo:

```text
Margen = $1
Nocional aproximado = $20
```

Si Binance limita ese símbolo a 10x:

```text
Margen = $1
Nocional aproximado = $10
```

Si la cantidad calculada no cumple el mínimo de Binance, V34 omite la operación y no aumenta el porcentaje configurado.

## Forex Signal Only

Forex **nunca envía órdenes a un broker** en esta edición.

Una alerta puede contener:

- par;
- BUY/SELL;
- entrada de referencia;
- SL;
- TP / TP2 / TP3;
- R:R;
- timeframe;
- confianza;
- rolling win rate;
- score;
- número de retest;
- estrategia y motivo.

La misma zona de setup no genera mensajes repetidos continuamente. Para considerarse retest nuevo, el setup debe dejar de ser válido y posteriormente activarse otra vez.

## Arranque del motor

Si Forex está habilitado, el motor exige:

- Forex Data configurado;
- Telegram configurado.

En TESTNET o REAL, si Crypto está habilitado también exige Binance configurado.

El botón **PAUSE ENGINE** bloquea nuevas entradas Binance y nuevas señales Forex.

## Emergency Stop

### PAUSE_ONLY

- bloquea nuevas entradas Binance;
- bloquea nuevas señales Forex;
- conserva las posiciones Binance existentes con sus SL/TP.

### CLOSE_TRACKED

- pausa el motor;
- solicita cierre reduce-only de las posiciones Binance gestionadas por V34;
- Forex no necesita cierres porque no abre posiciones.

## Backtest

La edición Linux muestra por ahora **Backtest Binance** y calcula, entre otras métricas:

- net profit;
- return;
- win rate;
- Profit Factor;
- expectancy;
- max drawdown;
- costos;
- resultados por símbolo;
- bloque out-of-sample.

El rolling backtest utilizado por el scanner sirve para ranking; no sustituye la validación histórica de rentabilidad.

## Actualización

```bash
git pull
docker compose -f docker-compose.linux.yml build
docker compose -f docker-compose.linux.yml up -d
```

El volumen persistente se conserva.

## Apagar / reiniciar

```bash
docker compose -f docker-compose.linux.yml down
docker compose -f docker-compose.linux.yml up -d
```

## Secuencia de validación

1. PAPER.
2. Backtest Binance en varias ventanas históricas.
3. Confirmar calidad y formato de señales Forex Telegram.
4. Binance Testnet.
5. Acumular suficientes operaciones y revisar profit neto, Profit Factor, expectancy, costos y drawdown.
6. Ajustar estrategia/filtros si hace falta.
7. REAL solo después de validar ejecución, SL/TP, reconciliación y límites de riesgo.

Las membresías permanecen fuera de alcance hasta demostrar resultados consistentes en esta instalación individual.
