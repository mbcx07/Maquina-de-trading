# Quantum Dual V34 — Setup actual

La edición activa de prueba individual es ahora:

- **Linux** como plataforma objetivo.
- **Binance USD-M Futures:** ejecución automática.
- **Forex:** señales a Telegram para ejecución manual.
- **Sin MT5 y sin Wine en esta etapa.**
- **SQLite + bóveda cifrada** persistentes.

La guía completa y vigente está en:

## [`LINUX_SETUP.md`](./LINUX_SETUP.md)

Instalación resumida:

```bash
git clone https://github.com/mbcx07/Maquina-de-trading.git
cd Maquina-de-trading
git checkout feature/v34-dual-market-engine

docker compose -f docker-compose.linux.yml build
docker compose -f docker-compose.linux.yml up -d
```

Abrir:

```text
http://IP_DEL_SERVIDOR:8080
```

Después configurar desde la propia aplicación:

1. Binance API Key + Secret.
2. Telegram Bot Token + Chat ID.
3. Twelve Data API Key para las velas Forex.

No agregar secretos a archivos del frontend ni al repositorio.

## Secuencia de validación

1. PAPER.
2. Backtests Binance en varias ventanas.
3. Confirmar señales Forex correctas por Telegram.
4. Binance Testnet.
5. Acumular historial suficiente y evaluar profit neto, Profit Factor, expectancy y drawdown.
6. REAL solo después de validar ejecución, SL/TP, reconciliación y riesgo.

Las membresías continúan pospuestas hasta demostrar estabilidad y resultados consistentes en la instalación individual.
