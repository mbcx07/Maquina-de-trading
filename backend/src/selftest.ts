import assert from 'node:assert/strict';
import type { Candle } from './analysis.js';
import { assessCryptoReversal } from './cryptoReversal.js';
import { decideGuardAction } from './cryptoReversalGuard.js';
import { calibrateR11Async } from './r11Calibration.js';
import { calculateCryptoSizing } from './risk.js';
import { selectCryptoOpportunities, selectForexOpportunities } from './selection.js';
import type { Opportunity, TradeRecord } from './types.js';

const now = Date.now();
const opportunity = (
  broker: 'BINANCE' | 'MT5',
  symbol: string,
  score: number,
  fingerprint = `${broker}-${symbol}-${score}`,
): Opportunity => ({
  id: `O-${broker}-${symbol}-${score}-${fingerprint}`,
  signalId: `S-${fingerprint}`,
  signalFingerprint: fingerprint,
  broker,
  symbol,
  side: 'BUY',
  timeframe: '15m',
  strategy: 'TEST',
  confidence: 85,
  rollingWinRate: 82,
  score,
  entry: 100,
  stopLoss: 99,
  takeProfit: 102,
  createdAt: now,
});

const activeTrade = (broker: 'BINANCE' | 'MT5', symbol: string, fingerprint: string): TradeRecord => ({
  id: `T-${broker}-${symbol}-${fingerprint}`,
  broker,
  symbol,
  side: 'BUY',
  strategy: 'TEST',
  timeframe: '15m',
  confidence: 80,
  rollingWinRate: 80,
  entryPrice: 100,
  stopLoss: 99,
  takeProfit: 102,
  unrealizedPnl: 0,
  realizedPnl: 0,
  state: 'OPEN',
  signalId: `S-${fingerprint}`,
  signalFingerprint: fingerprint,
  createdAt: now,
  updatedAt: now,
});

// Crypto: never repeat a symbol and never select more than ten.
{
  const crypto = Array.from({ length: 11 }, (_, i) => opportunity('BINANCE', `COIN${i}USDT`, 100 - i));
  crypto.push(opportunity('BINANCE', 'COIN1USDT', 999, 'BETTER-COIN1'));

  const selected = selectCryptoOpportunities(crypto, {
    maxCryptoTrades: 10,
    maxForexTrades: 20,
    forexMaxEntriesPerSymbol: 0,
    activeTrades: [],
  });

  assert.equal(selected.length, 10);
  assert.equal(new Set(selected.map((item) => item.symbol)).size, 10);
  assert.equal(selected.find((item) => item.symbol === 'COIN1USDT')?.score, 999);
}

// Crypto: an already-open BTCUSDT cannot be selected again even with a higher score.
{
  const selected = selectCryptoOpportunities(
    [opportunity('BINANCE', 'BTCUSDT', 999), opportunity('BINANCE', 'ETHUSDT', 90)],
    {
      maxCryptoTrades: 10,
      maxForexTrades: 20,
      forexMaxEntriesPerSymbol: 0,
      activeTrades: [activeTrade('BINANCE', 'BTCUSDT', 'BTC-OPEN')],
    },
  );

  assert.deepEqual(selected.map((item) => item.symbol), ['ETHUSDT']);
}

// Forex: same symbol may repeat when each retest has a different fingerprint.
{
  const selected = selectForexOpportunities(
    [
      opportunity('MT5', 'EURUSD', 95, 'EUR-RETEST-1'),
      opportunity('MT5', 'EURUSD', 93, 'EUR-RETEST-2'),
      opportunity('MT5', 'EURUSD', 91, 'EUR-RETEST-3'),
    ],
    {
      maxCryptoTrades: 10,
      maxForexTrades: 20,
      forexMaxEntriesPerSymbol: 0,
      activeTrades: [],
    },
  );

  assert.equal(selected.length, 3);
  assert.equal(selected.every((item) => item.symbol === 'EURUSD'), true);
}

// Forex: exact same signal fingerprint is blocked, while a new retest remains eligible.
{
  const selected = selectForexOpportunities(
    [
      opportunity('MT5', 'EURUSD', 99, 'EUR-RETEST-1'),
      opportunity('MT5', 'EURUSD', 95, 'EUR-RETEST-2'),
    ],
    {
      maxCryptoTrades: 10,
      maxForexTrades: 20,
      forexMaxEntriesPerSymbol: 0,
      activeTrades: [activeTrade('MT5', 'EURUSD', 'EUR-RETEST-1')],
    },
  );

  assert.deepEqual(selected.map((item) => item.signalFingerprint), ['EUR-RETEST-2']);
}

// Crypto sizing example: $100 balance, 1% margin, 20x => $1 margin and $20 notional.
{
  const result = calculateCryptoSizing({
    futuresBalance: 100,
    marginPctPerTrade: 1,
    requestedLeverage: 20,
    maxAllowedLeverage: 50,
    entryPrice: 100,
    stopLoss: 99,
    maxLossPctPerTrade: 10,
  });

  assert.equal(result.marginTarget, 1);
  assert.equal(result.effectiveLeverage, 20);
  assert.equal(result.targetNotional, 20);
}

// If the coin only permits 10x, effective leverage and notional fall automatically.
{
  const result = calculateCryptoSizing({
    futuresBalance: 100,
    marginPctPerTrade: 1,
    requestedLeverage: 20,
    maxAllowedLeverage: 10,
    entryPrice: 100,
    stopLoss: 99,
    maxLossPctPerTrade: 10,
  });

  assert.equal(result.effectiveLeverage, 10);
  assert.equal(result.targetNotional, 10);
}

// Dynamic Reversal Guard: a clear bearish M5/M15 environment must be strongly
// adverse to an existing BUY, while the mirror bullish environment must not be.
{
  const bearishM5 = syntheticTrend(90, 130, -0.18, 5 * 60_000, true);
  const bearishM15 = syntheticTrend(230, 180, -0.12, 15 * 60_000, false);
  const adverse = assessCryptoReversal(bearishM5, bearishM15, 'BUY');
  assert.ok(adverse.score >= 50, `expected strong BUY reversal score, got ${adverse.score}`);
  assert.equal(adverse.level, 'STRONG');

  const bullishM5 = syntheticTrend(90, 90, 0.18, 5 * 60_000, false);
  const bullishM15 = syntheticTrend(230, 90, 0.12, 15 * 60_000, false);
  const healthy = assessCryptoReversal(bullishM5, bullishM15, 'BUY');
  assert.ok(healthy.score < 30, `expected healthy BUY score below warning, got ${healthy.score}`);
}

// Guard action matrix from the production rules.
{
  assert.equal(decideGuardAction({ score: 10 }, -5).action, 'CLOSE_EMERGENCY');
  assert.equal(decideGuardAction({ score: 50 }, 2).action, 'CLOSE_REVERSAL');
  assert.equal(decideGuardAction({ score: 35 }, -3.1).action, 'CLOSE_PREVENTIVE');
  assert.equal(decideGuardAction({ score: 35 }, -2).action, 'WARNING');
  assert.equal(decideGuardAction({ score: 29 }, -4).action, 'NONE');
  assert.equal(decideGuardAction({ score: 10 }, -5).closeReason, 'EMERGENCY_RISK');
  assert.equal(decideGuardAction({ score: 50 }, 2).closeReason, 'REVERSAL');
}

// R11 worker must boot under the same Node/tsx runtime used in Docker. Empty history
// returns immediately and validates worker loading/message plumbing without doing a full calibration.
{
  const model = await calibrateR11Async([], []);
  assert.equal(model.ready, false);
  assert.equal(model.status, 'INSUFFICIENT_M5_HISTORY');
}

console.log('V34 R11 + Dynamic Reversal Guard selftest: OK');

function syntheticTrend(count: number, start: number, step: number, intervalMs: number, spikeLast: boolean): Candle[] {
  const baseTime = now - count * intervalMs;
  return Array.from({ length: count }, (_, i) => {
    const close = Math.max(0.01, start + step * i);
    const previous = Math.max(0.01, start + step * Math.max(0, i - 1));
    const open = i === 0 ? previous : Math.max(0.01, start + step * (i - 0.35));
    const spread = Math.max(0.02, Math.abs(step) * 0.8);
    return {
      time: baseTime + i * intervalMs,
      open,
      high: Math.max(open, close) + spread,
      low: Math.max(0.001, Math.min(open, close) - spread),
      close,
      volume: spikeLast && i === count - 1 ? 3000 : 1000 + (i % 5) * 10,
    };
  });
}
