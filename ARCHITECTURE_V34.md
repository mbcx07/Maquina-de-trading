# V34 Dual-Market Trading Platform

## Objetivo

Convertir la aplicación actual en una plataforma persistente de trading automático con dos motores independientes:

- **Crypto Engine**: Binance USDⓈ-M Futures.
- **Forex Engine**: MetaTrader 5.

La interfaz web será únicamente panel de control, monitorización, configuración y reportes. Las API keys, firmas y ejecución de órdenes vivirán en backend.

## 1. Configuración de riesgo y ejecución

### Crypto

Parámetros configurables desde la UI:

- `cryptoEnabled`
- `maxConcurrentCryptoTrades` (default 10)
- `marginPctPerTrade` — porcentaje del balance de Futures asignado como margen por operación.
- `requestedLeverage`
- `maxAccountExposurePct`
- `maxLossPctPerTrade`
- `minSignalConfidence`
- `minRollingWinRate`
- selección de universo: todos los perpetuos USDT elegibles o whitelist/blacklist.

Ejemplo:

- Balance Futures: 100 USDT
- `marginPctPerTrade = 1`
- Margen objetivo = 1 USDT
- `requestedLeverage = 20`
- Nocional objetivo ≈ 20 USDT

El motor debe consultar el máximo de apalancamiento válido para el símbolo y usar:

`effectiveLeverage = min(requestedLeverage, maxAllowedLeverage)`

Nunca debe aumentar el porcentaje de margen configurado para alcanzar el mínimo de una moneda. Si el tamaño no cumple filtros `LOT_SIZE`, `MARKET_LOT_SIZE`, `MIN_NOTIONAL`/notional aplicable, se omite la operación y se registra la razón.

### Forex

Parámetros configurables:

- `forexEnabled`
- `maxConcurrentForexTrades`
- `riskMode`: `MARGIN_PERCENT` o `RISK_TO_SL`
- porcentaje por operación
- lotaje mínimo/máximo permitido
- símbolos habilitados
- magic number del sistema
- desviación/slippage máxima

## 2. Ranking y selección de oportunidades

El scanner no ejecuta la primera señal encontrada.

Flujo:

1. Escanear todos los símbolos elegibles.
2. Construir un `OpportunityScore` común.
3. Ordenar de mayor a menor.
4. Mantener una cola dinámica de oportunidades.
5. Ejecutar únicamente hasta completar los slots disponibles.

Score sugerido:

- confianza de señal
- rolling win rate
- profit factor del backtest
- expectancy
- estructura multi-timeframe
- ADX / momentum
- calidad de soporte/resistencia
- volatilidad ATR
- volumen/liquidez
- distancia razonable a SL
- relación riesgo/beneficio
- penalización por correlación/exposición repetida

La UI debe mostrar al menos Top 10 y permitir escoger `maxConcurrentCryptoTrades`.

## 3. Gestión de posiciones

Cada posición debe guardar:

- `id`
- `broker`: `BINANCE` | `MT5`
- símbolo
- lado BUY/SELL
- estrategia
- timeframe
- confidence
- rollingWinRate
- entry
- SL
- TP1/TP2/TP3
- leverage / lot size
- marginUsed
- notional
- commission
- funding/swap si aplica
- unrealizedPnl
- realizedPnl
- openTime
- closeTime
- closeReason: TP, SL, MANUAL, LIQUIDATION, EXTERNAL, ERROR
- brokerOrderId / ticket
- raw signal metadata

Estados:

`PENDING -> OPENING -> OPEN -> CLOSING -> CLOSED`

Estados de error adicionales:

`REJECTED`, `ORPHANED`, `SYNC_REQUIRED`.

## 4. Persistencia

No usar `localStorage` como fuente de verdad.

Persistir en base de datos:

- settings
- signals
- opportunities
- trades
- trade_events
- equity_snapshots
- telegram_events
- engine_state

Para primera versión puede utilizarse SQLite en backend. Para despliegue multiusuario o cloud, PostgreSQL.

Al recargar la web:

1. UI consulta `/api/state`.
2. Backend devuelve settings, posiciones abiertas, historial y métricas.
3. Backend reconcilia con Binance y MT5 antes de marcar el estado como `SYNCED`.

## 5. Métricas

Separar métricas por:

- Crypto
- Forex
- Global

Métricas mínimas:

- balance
- equity
- realized PnL
- unrealized PnL
- profit neto
- win rate
- loss rate
- profit factor
- expectancy
- average win
- average loss
- largest win/loss
- max drawdown
- número de operaciones
- operaciones abiertas
- fees/commission
- funding/swap
- rendimiento diario/semanal/mensual

## 6. Telegram

Alertas configurables:

### Apertura

- mercado
- símbolo
- BUY/SELL
- entry
- SL
- TP
- leverage/lote
- margen asignado
- confidence
- rolling WR
- estrategia

### Cierre

- símbolo
- resultado WIN/LOSS
- precio de cierre
- PnL USDT / moneda de cuenta
- PnL %
- duración
- razón de cierre
- win rate actualizado
- profit acumulado

También alertar:

- motor pausado
- error de API
- orden rechazada
- pérdida de sincronización
- límite de drawdown alcanzado
- emergency stop activado

## 7. Arquitectura backend

Servicios sugeridos:

- `api-server`
- `signal-engine`
- `crypto-execution-service`
- `mt5-bridge`
- `position-reconciler`
- `telegram-service`
- `metrics-service`
- `database`

La web NO debe firmar órdenes ni conocer API secrets.

## 8. Seguridad

Las credenciales actualmente embebidas en `services/binance.ts` deben revocarse y rotarse inmediatamente.

Nueva política:

- claves solo en variables de entorno/secrets del servidor
- nunca en React/Vite
- nunca en Git
- permiso de retiro deshabilitado
- API restringida al trading necesario
- IP whitelist si la infraestructura lo permite
- claves independientes para testnet y producción

## 9. UI V34

Dashboard de dos columnas funcionales:

### Crypto

- balance Binance Futures
- slots usados / máximos
- Top 10 oportunidades
- posiciones abiertas
- historial
- métricas

### Forex

- balance/equity MT5
- slots usados / máximos
- mejores pares
- posiciones abiertas
- historial
- métricas

Cabecera global:

- PAPER / TESTNET / REAL
- ENGINE ON/OFF
- Emergency Stop
- estado Binance
- estado MT5
- estado Telegram
- DB SYNC

## 10. Reglas de seguridad operativa

Antes de habilitar REAL:

1. PAPER trading obligatorio.
2. Binance testnet.
3. MT5 demo.
4. Verificación de SL/TP nativos.
5. Reconciliación tras reinicio.
6. Prueba de desconexión.
7. Límite de pérdida diaria.
8. Límite de drawdown total.
9. Emergency stop.
10. Nunca abrir más posiciones que el máximo configurado.

## 11. Prioridad de implementación

1. Eliminar ejecución y secretos del frontend.
2. Crear backend + DB persistente.
3. Migrar scanner de Binance a backend.
4. Crear ranking Top-N.
5. Implementar paper trading persistente.
6. Telegram.
7. Binance testnet.
8. Binance real.
9. MT5 demo bridge.
10. MT5 real.
