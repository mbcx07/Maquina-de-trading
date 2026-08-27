import type { CryptoSizingInput, CryptoSizingResult } from './types.js';

export function calculateCryptoSizing(input: CryptoSizingInput): CryptoSizingResult {
  const {
    futuresBalance,
    marginPctPerTrade,
    requestedLeverage,
    maxAllowedLeverage,
    entryPrice,
    stopLoss,
    maxLossPctPerTrade,
  } = input;

  if (futuresBalance <= 0) throw new Error('INVALID_FUTURES_BALANCE');
  if (marginPctPerTrade <= 0 || marginPctPerTrade > 100) throw new Error('INVALID_MARGIN_PCT');
  if (requestedLeverage < 1 || maxAllowedLeverage < 1) throw new Error('INVALID_LEVERAGE');
  if (entryPrice <= 0 || stopLoss <= 0) throw new Error('INVALID_PRICE');
  if (maxLossPctPerTrade <= 0 || maxLossPctPerTrade > 100) throw new Error('INVALID_MAX_LOSS_PCT');

  const marginTarget = futuresBalance * (marginPctPerTrade / 100);
  const effectiveLeverage = Math.max(1, Math.min(requestedLeverage, maxAllowedLeverage));
  const rawNotional = marginTarget * effectiveLeverage;

  const stopDistancePct = Math.abs(entryPrice - stopLoss) / entryPrice;
  const maxAllowedLoss = futuresBalance * (maxLossPctPerTrade / 100);
  const rawLossAtStop = rawNotional * stopDistancePct;

  let targetNotional = rawNotional;
  let adjustedForStopRisk = false;

  if (stopDistancePct > 0 && rawLossAtStop > maxAllowedLoss) {
    targetNotional = maxAllowedLoss / stopDistancePct;
    adjustedForStopRisk = true;
  }

  // Important: reducing notional is permitted, increasing configured margin is not.
  targetNotional = Math.min(targetNotional, rawNotional);
  const lossAtStop = targetNotional * stopDistancePct;

  return {
    marginTarget,
    effectiveLeverage,
    targetNotional,
    lossAtStop,
    maxAllowedLoss,
    adjustedForStopRisk,
  };
}

export interface BinanceSymbolFilters {
  minQty: number;
  stepSize: number;
  minNotional: number;
}

export interface NormalizedOrderSize {
  quantity: number;
  notional: number;
}

export function normalizeBinanceOrderSize(
  targetNotional: number,
  entryPrice: number,
  filters: BinanceSymbolFilters,
): NormalizedOrderSize {
  if (targetNotional <= 0 || entryPrice <= 0) throw new Error('INVALID_ORDER_SIZE_INPUT');
  if (filters.stepSize <= 0 || filters.minQty <= 0) throw new Error('INVALID_SYMBOL_FILTERS');

  const rawQuantity = targetNotional / entryPrice;
  const quantity = Math.floor(rawQuantity / filters.stepSize) * filters.stepSize;
  const notional = quantity * entryPrice;

  if (quantity < filters.minQty) throw new Error('BINANCE_MIN_QTY_NOT_MET');
  if (notional < filters.minNotional) throw new Error('BINANCE_MIN_NOTIONAL_NOT_MET');

  return { quantity, notional };
}
