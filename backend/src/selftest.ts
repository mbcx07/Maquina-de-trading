import assert from 'node:assert/strict';
import type { Candle } from './analysis.js';
import { assessCryptoReversal } from './cryptoReversal.js';
import { decideAdvisoryAction, structuralStopBreached } from './cryptoReversalGuard.js';
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

// Dynamic reversal scoring is diagnostic: strong adverse structure warns but does
// not override R11's calibrated structural exit.
{
  const bearishM5 = syntheticTrend(90, 130, -0.18, 5 * 60_000, true);
  const bearishM15 = syntheticTrend(230, 180, -0.12, 15 * 60_000, false);
  const adverse = assessCryptoReversal(bearishM5, bearishM15, 'BUY');
  assert.ok(adverse.score >= 50, `expected strong BUY reversal score, got ${adverse.score}`);
  assert.equal(adverse.level, 'STRONG');
  assert.equal(decideAdvisoryAction(adverse), 'WARNING');

  const bullishM5 = syntheticTrend(90, 90, 0.18, 5 * 60_000, false);
  const bullishM15 = syntheticTrend(230, 90, 0.12, 15 * 60_000, false);
  const healthy = assessCryptoReversal(bullishM5, bullishM15, 'BUY');
  assert.ok(healthy.score < 30, `expected healthy BUY score below warning, got ${healthy.score}`);
  assert.equal(decideAdvisoryAction(healthy), 'NONE');
}

// The only automatic Reversal Guard exit is a fail-safe after the validated
// structural stop has already been crossed while the position remains open.
{
  assert.equal(structuralStopBreached({ side: 'BUY', stopLoss: 99 }, 99), true);
  assert.equal(structuralStopBreached({ side: 'BUY', stopLoss: 99 }, 99.01), false);
  assert.equal(structuralStopBreached({ side: 'SELL', stopLoss: 101 }, 101), true);
  assert.equal(structuralStopBreached({ side: 'SELL', stopLoss: 101 }, 100.99), false);
  assert.equal(decideAdvisoryAction({ score: 50 }), 'WARNING');
  assert.equal(decideAdvisoryAction({ score: 35 }), 'WARNING');
  assert.equal(decideAdvisoryAction({ score: 29 }), 'NONE');
}

{
  const model = await calibrateR11Async([], []);
  assert.equal(model.ready, false);
  assert.equal(model.status, 'INSUFFICIENT_M5_HISTORY');
}

console.log('V34 R11 + Safe Dynamic Reversal Guard selftest: OK');

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
