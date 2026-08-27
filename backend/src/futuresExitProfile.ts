import type { TradeSide } from './types.js';

export interface FuturesExitProfileInput {
  side: TradeSide;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  tp2?: number;
  tp3?: number;
  minStopPricePct?: number;
  minTakeProfitPricePct?: number;
  leverage?: number;
}

export interface FuturesExitProfileResult {
  stopLoss: number;
  takeProfit: number;
  tp2: number;
  tp3: number;
  stopDistance: number;
  tp1Distance: number;
  stopPricePct: number;
  tp1PricePct: number;
  tp2PricePct: number;
  tp3PricePct: number;
  stopMarginRoiPct?: number;
  tp1MarginRoiPct?: number;
  tp2MarginRoiPct?: number;
  tp3MarginRoiPct?: number;
  minStopPricePct: number;
  minTakeProfitPricePct: number;
}

/**
 * Crypto Futures exit normalization.
 *
 * The v33.5 signal supplies structural ATR/fractal exits in UNDERLYING PRICE space.
 * Futures leverage must never divide those price distances. Leverage only amplifies
 * PnL on the margin. To prevent structurally tiny M1 exits from behaving like
 * micro-scalps, Crypto Futures applies a price-distance floor before execution:
 *   - SL >= 1.0% underlying move by default
 *   - TP1 >= 1.5% underlying move by default
 * while still preserving at least the original 1.35R / 2.20R / 3.50R ladder.
 *
 * Example at 20x (ignoring fees/funding): 1% price ~= 20% margin ROI;
 * 1.5% price ~= 30% margin ROI.
 */
export function normalizeFuturesExitLevels(input: FuturesExitProfileInput): FuturesExitProfileResult {
  const entry = Number(input.entry);
  if (!Number.isFinite(entry) || entry <= 0) throw new Error('FUTURES_EXIT_INVALID_ENTRY');

  const minStopPricePct = clampPositive(input.minStopPricePct ?? 1, 0.01, 25);
  const minTakeProfitPricePct = clampPositive(input.minTakeProfitPricePct ?? 1.5, 0.01, 50);
  const minStopDistance = entry * minStopPricePct / 100;
  const minTpDistance = entry * minTakeProfitPricePct / 100;

  const rawStopDistance = directionalDistance(input.side, entry, input.stopLoss, 'STOP');
  const stopDistance = Math.max(minStopDistance, rawStopDistance);
  const stopLoss = input.side === 'BUY' ? entry - stopDistance : entry + stopDistance;

  const rawTp1Distance = directionalDistance(input.side, entry, input.takeProfit, 'TARGET');
  const rawTp2Distance = input.tp2 == null ? 0 : directionalDistance(input.side, entry, input.tp2, 'TARGET');
  const rawTp3Distance = input.tp3 == null ? 0 : directionalDistance(input.side, entry, input.tp3, 'TARGET');

  const tp1Distance = Math.max(minTpDistance, rawTp1Distance, stopDistance * 1.35);
  const tp2Distance = Math.max(rawTp2Distance, stopDistance * 2.20, tp1Distance);
  const tp3Distance = Math.max(rawTp3Distance, stopDistance * 3.50, tp2Distance);

  const takeProfit = input.side === 'BUY' ? entry + tp1Distance : entry - tp1Distance;
  const tp2 = input.side === 'BUY' ? entry + tp2Distance : entry - tp2Distance;
  const tp3 = input.side === 'BUY' ? entry + tp3Distance : entry - tp3Distance;

  const leverage = Number(input.leverage ?? 0);
  const stopPricePct = stopDistance / entry * 100;
  const tp1PricePct = tp1Distance / entry * 100;
  const tp2PricePct = tp2Distance / entry * 100;
  const tp3PricePct = tp3Distance / entry * 100;

  return {
    stopLoss,
    takeProfit,
    tp2,
    tp3,
    stopDistance,
    tp1Distance,
    stopPricePct,
    tp1PricePct,
    tp2PricePct,
    tp3PricePct,
    stopMarginRoiPct: leverage > 0 ? stopPricePct * leverage : undefined,
    tp1MarginRoiPct: leverage > 0 ? tp1PricePct * leverage : undefined,
    tp2MarginRoiPct: leverage > 0 ? tp2PricePct * leverage : undefined,
    tp3MarginRoiPct: leverage > 0 ? tp3PricePct * leverage : undefined,
    minStopPricePct,
    minTakeProfitPricePct,
  };
}

function directionalDistance(side: TradeSide, entry: number, level: number, kind: 'STOP' | 'TARGET'): number {
  const value = Number(level);
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (side === 'BUY') {
    const distance = kind === 'STOP' ? entry - value : value - entry;
    return Math.max(0, distance);
  }
  const distance = kind === 'STOP' ? value - entry : entry - value;
  return Math.max(0, distance);
}

function clampPositive(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}
