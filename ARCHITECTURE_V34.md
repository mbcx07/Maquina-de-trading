# V34 Dual-Market Trading Platform

## Objetivo

Convertir la aplicación actual en una plataforma persistente de trading automático con dos motores independientes:

- **Crypto Engine**: Binance USDⓈ-M Futures.
- **Forex Engine**: MetaTrader 5.

La interfaz web será únicamente panel de control, monitorización, configuración y reportes. Las API keys, firmas y ejecución de órdenes vivirán en backend.

## Regla fundamental de simultaneidad

### Binance Futures

- Máximo configurable de posiciones simultáneas, default `10`.
- **Nunca se permite repetir símbolo mientras exista una posición abierta en ese símbolo.**
- Si `BTCUSDT` está abierto, cualquier nueva oportunidad, retest o señal adicional de `BTCUSDT` se registra, pero NO se ejecuta hasta que la posición anterior quede cerrada y reconciliada.
- Con `maxConcurrentCryptoTrades = 10`, las diez posiciones deben corresponder a diez símbolos diferentes.
- La unicidad se valida contra la base de datos y contra las posiciones reales de Binance antes de enviar una orden.

### Forex / MT5

- Sí se permiten múltiples operaciones del mismo símbolo.
- Cada retest/reentrada se considera un trade independiente con su propio ticket, entry, SL, TP, lotaje, estrategia y señal origen.
- Ejemplo válido: tres posiciones EURUSD abiertas a distintos precios por tres retests válidos.
- El límite se aplica al número total de tickets abiertos, no al número de símbolos únicos.
- La posibilidad real de mantener posiciones independientes del mismo símbolo depende del modo de cuenta MT5; para esta plataforma se recomienda/valida cuenta **hedging**. En netting, el broker puede consolidar posiciones por símbolo y el reconciliador debe detectarlo.

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

El margen se interpreta como asignación de capital:

`marginTarget = futuresBalance * (marginPctPerTrade / 100)`

`notionalTarget = marginTarget * effectiveLeverage`

Debe existir además un límite de pérdida calculada al SL. Si el SL implicara una pérdida superior a `maxLossPctPerTrade`, el motor reduce el nocional sin aumentar el margen configurado. Si la reducción vuelve inválido el mínimo del símbolo, se rechaza el trade.

### Forex

Parámetros configurables:

- `forexEnabled`
- `maxConcurrentForexTrades`
- `riskMode`: `MARGIN_PERCENT` o `RISK_TO_SL`
- porcentaje por operación
- lotaje mínimo/máximo permitido
- `maxEntriesPerSymbol` opcional; `0` significa sin límite específico, sujeto al máximo global
- símbolos habilitados
- magic number del sistema
- desviación/slippage máxima

Cada nueva reentrada debe pasar de nuevo el análisis y generar un `signalId` distinto; no se duplica una orden por el simple hecho de que exista la tendencia previa.

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

### Selector Crypto

Antes de elegir Top-N:

- excluir símbolos ya abiertos en Binance;
- excluir símbolos marcados `OPENING`, `OPEN`, `CLOSING` o `SYNC_REQUIRED` localmente;
- deduplicar oportunidades por símbolo y conservar únicamente la de mayor score;
- tomar las mejores oportunidades hasta llenar los slots disponibles.

Por tanto, `Top 10 ejecutables` significa **10 monedas distintas**.

### Selector Forex

- no deduplicar por símbolo;
- deduplicar únicamente por `signalFingerprint` para evitar ejecutar dos veces exactamente la misma señal;
- permitir varios tickets de un mismo par cuando correspondan a retests/reentradas distintas;
- aplicar `maxEntriesPerSymbol` solo si el usuario lo configura.

La UI debe mostrar Top 10 Crypto y una cola Forex independiente.

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
- brokerOrderId / MT5 ticket
- `signalId`
- `signalFingerprint`
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

Restricciones de datos:

- Crypto: índice/validación lógica que impida más de un trade activo por símbolo.
- Forex: NO crear restricción única por símbolo; el ticket de MT5 es la identidad operativa.

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
- win rate por símbolo
- win rate por estrategia
- win rate por timeframe

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
- slot utilizado (`Crypto 4/10`, por ejemplo)
- para Forex: número de entrada del mismo símbolo cuando aplique

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
- `opportunity-selector`
- `risk-engine`
- `crypto-execution-service`
- `mt5-bridge`
- `position-reconciler`
- `telegram-service`
- `metrics-service`
- `database`

La web NO debe firmar órdenes ni conocer API secrets.

## 8. Binance V34

- USDⓈ-M Futures.
- Scanner de contratos `PERPETUAL`, `TRADING`, quote `USDT`.
- Validar filtros de `exchangeInfo`, incluidos precio, cantidad y notional.
- Cambiar leverage por símbolo antes de ejecutar y aceptar el leverage efectivo confirmado por Binance.
- Abrir orden principal a mercado o con el tipo que defina posteriormente la estrategia.
- SL/TP condicionales deben implementarse con el mecanismo vigente de Binance; no copiar el antiguo flujo frontend sin validarlo contra la API actual.
- Reconciliar posiciones y órdenes del exchange después de cada apertura/cierre y periódicamente.
- Si Binance muestra una posición en un símbolo, ese símbolo queda bloqueado para nuevas entradas Crypto.

## 9. MT5 V34

El bridge debe poder:

- consultar `account_info`;
- obtener símbolos/ticks/barras;
- validar lotaje y margen;
- ejecutar con `order_check` + `order_send`;
- incluir `sl`, `tp`, `magic`, `comment` y desviación;
- consultar `positions_get`;
- consultar historial de órdenes/deals;
- reconciliar por ticket.

En Forex se aceptan varios tickets del mismo símbolo cuando el entorno MT5 esté en hedging.

## 10. Seguridad

Las credenciales actualmente embebidas en `services/binance.ts` deben revocarse y rotarse inmediatamente.

Nueva política:

- claves solo en variables de entorno/secrets del servidor
- nunca en React/Vite
- nunca en Git
- permiso de retiro deshabilitado
- API restringida al trading necesario
- IP whitelist si la infraestructura lo permite
- claves independientes para testnet y producción
- Telegram token solo en backend
- credenciales MT5 solo en el bridge/host seguro

## 11. UI V34

Dashboard de dos columnas funcionales:

### Crypto

- balance Binance Futures
- slots usados / máximos
- indicador `10 símbolos únicos`
- Top 10 oportunidades únicas
- posiciones abiertas
- historial
- métricas

### Forex

- balance/equity MT5
- tickets usados / máximos
- mejores setups
- agrupación visual opcional por par, conservando cada ticket individual
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

## 12. Reglas de seguridad operativa

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
11. Nunca repetir símbolo Crypto mientras esté abierto.
12. Nunca duplicar el mismo `signalFingerprint` en Forex, aunque sí se permitan retests distintos del mismo par.

## 13. Prioridad de implementación

1. Eliminar ejecución y secretos del frontend.
2. Crear backend + DB persistente.
3. Implementar reglas de selección Crypto/Forex.
4. Migrar scanner de Binance a backend.
5. Crear ranking Top-N.
6. Implementar paper trading persistente.
7. Telegram.
8. Binance testnet.
9. Binance real.
10. MT5 demo bridge.
11. MT5 real.
