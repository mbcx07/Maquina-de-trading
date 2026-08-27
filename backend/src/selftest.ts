import assert from 'node:assert/strict';
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

// Crypto sizing example requested by product: $100 balance, 1% margin, 20x => $1 margin and $20 notional.
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

console.log('V34 selftest: OK');
