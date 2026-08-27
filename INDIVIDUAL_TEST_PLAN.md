# Quantum Dual V34 — Individual Profitability Test Plan

This phase is intentionally single-user. Memberships remain out of scope until the engine demonstrates acceptable behavior in historical tests and Demo/Testnet.

## Phase 0 — Installation

1. Run `setup-v34-windows.bat`.
2. Open MetaTrader 5 on Windows and log in to a Demo account.
3. Enable algorithmic/Expert trading in MT5.
4. Set a long random `MT5_BRIDGE_TOKEN` in `mt5-bridge/.env`.
5. Run `start-v34-windows.bat`.
6. Open V34 -> Configuración.
7. Connect MT5 Bridge with `http://127.0.0.1:8790` and the bridge token.
8. Connect Telegram.
9. Connect Binance only with fresh Testnet credentials during the test phase.

## Phase 1 — Historical backtests

Use the Backtest tab before enabling automated execution.

Recommended initial protocol:

- Run separate Crypto and Forex tests.
- Use several non-overlapping windows rather than optimizing one window repeatedly.
- Start with 7-day windows, then 14 and 30-day windows.
- Compare different market regimes (trend, range, high volatility, low volatility).
- Keep the last 30% of each run as out-of-sample (OOS).
- Include a realistic round-trip cost assumption.

Metrics to review:

- Net Profit after modeled costs
- Return %
- Win Rate
- Profit Factor
- Expectancy per trade
- Maximum Drawdown
- Average Win / Average Loss
- Costs
- Per-symbol results
- OOS Net Profit / Profit Factor / Expectancy

Do not promote the strategy based only on Win Rate.

## Phase 2 — PAPER observation

Keep execution in PAPER and inspect:

- number of setups generated;
- which symbols are selected;
- Binance never exceeds ten active unique symbols;
- Forex retests appear only after the setup leaves and re-enters a valid zone;
- no repeated identical signal fingerprints;
- Telegram alerts are correct;
- history persists after browser/backend restart.

## Phase 3 — Binance Testnet + MT5 Demo

Use `TESTNET / DEMO`.

Crypto validation:

- one active position per Binance symbol;
- leverage is confirmed by Binance and capped to symbol maximum;
- margin allocation matches the selected account percentage;
- SL/TP protection exists after entry;
- if protection fails, V34 attempts fail-safe closure;
- fills, fees and funding reconcile into SQLite;
- closed trades update Telegram and statistics.

Forex validation:

- MT5 account reports `tradeAllowed=true` and `tradeExpert=true`;
- account is HEDGING if multiple retests per symbol are enabled;
- live spread is checked immediately before order execution;
- orders exceeding `forexMaxSpreadPoints` are rejected;
- each retest receives an independent ticket;
- SL/TP, commission, swap and PnL reconcile from MT5 history.

## Phase 4 — Operational resilience

Explicitly test:

- close browser while positions are open;
- restart frontend only;
- restart backend;
- temporarily disconnect internet;
- close a position manually in Binance/MT5;
- let TP execute at broker;
- let SL execute at broker;
- Telegram unavailable;
- MT5 bridge unavailable;
- Binance request failure;
- partial entry/protection failure;
- risk kill-switch;
- Emergency Stop `PAUSE_ONLY`;
- Emergency Stop `CLOSE_TRACKED`.

`CLOSE_TRACKED` is designed to close only positions tracked by V34, not unrelated manual trades.

## Phase 5 — Minimum evidence before REAL

A practical first checkpoint is at least:

- 100 closed Crypto trades; and
- 100 closed Forex trades.

A stronger checkpoint is 200–300 trades per engine across multiple market regimes.

Before REAL, require at minimum:

- positive Net Profit after costs;
- positive Expectancy;
- Profit Factor greater than 1;
- acceptable Maximum Drawdown;
- positive/acceptable OOS behavior;
- no unresolved reconciliation or unprotected-position incidents.

These thresholds are validation gates, not a guarantee of future profitability.

## Current safety controls

- Binance: maximum ten simultaneous unique symbols.
- Crypto account margin exposure cap.
- Crypto loss-at-SL cap.
- Forex maximum spread filter (`0` disables it).
- Daily loss kill-switch.
- Maximum drawdown kill-switch.
- Emergency Stop mode:
  - `PAUSE_ONLY`
  - `CLOSE_TRACKED`
- Persistent SQLite history.
- Encrypted integration credentials.
- Telegram operational alerts.
