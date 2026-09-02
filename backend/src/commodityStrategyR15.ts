import { env } from './config.js';
import type { TradeSide } from './types.js';

export type CommodityKindR15 = 'XAU' | 'CRUDE';
export type CrudeSideModeR15 = 'BUY' | 'SELL' | 'BOTH';

export interface CommodityBookR15 {
  bid: number;
  ask: number;
  bidQty?: number;
  askQty?: number;
  time: number;
}

export interface CommodityCandleR15 {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CommodityMicroBarR15 extends CommodityCandleR15 {
  buyVolume: number;
  sellVolume: number;
}

export interface CommodityStrategyConfigR15 {
  kind: CommodityKindR15;
  allowLong: boolean;
  allowShort: boolean;
  maxSpreadPct: number;
  feePct: number;
  slippagePct: number;
  scoreMin?: number;
  minEdgeMultiple?: number;
}

export interface CommoditySignalR15 {
  side: TradeSide;
  score: number;
  reason: string;
  spreadPct: number;
  costPct: number;
  targetPct: number;
  stopPct: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  rsi: number;
  flow: number;
  atrPct: number;
  components: string[];
}

export interface CommodityDiagnosticR15 {
  action: 'BUY' | 'SELL' | 'WAIT';
  reason: string;
  score: number;
  longScore: number;
  shortScore: number;
  threshold: number;
  spreadPct: number;
  costPct: number;
  targetPct: number;
  stopPct: number;
  rsi: number;
  takerBuyRatio: number;
  atrPct: number;
  componentsLong: string[];
  componentsShort: string[];
  blockedBy?: string;
  signal?: CommoditySignalR15;
}

export interface HistoricalBacktestTradeR15 {
  side: TradeSide;
  signalTime: number;
  openTime: number;
  closeTime: number;
  entry: number;
  exit: number;
  stopLoss: number;
  takeProfit: number;
  score: number;
  closeReason: 'TP' | 'SL' | 'TIME';
  pnl: number;
  returnOnAccountPct: number;
  balanceAfter: number;
}

export interface HistoricalBacktestResultR15 {
  model: 'HISTORICAL_1M_APPROXIMATION';
  note: string;
  candles: number;
  from: number;
  to: number;
  daysCovered: number;
  initialBalance: number;
  finalBalance: number;
  netPnl: number;
  returnPct: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  profitFactor: number | null;
  expectancy: number;
  maxDrawdownPct: number;
  avgHoldSeconds: number;
  assumedSpreadPct: number;
  feePct: number;
  slippagePct: number;
  leverage: number;
  marginPctPerTrade: number;
  sideMode: 'BUY' | 'SELL' | 'BOTH';
  equityCurve: Array<{ time: number; equity: number }>;
  recentTrades: HistoricalBacktestTradeR15[];
}

export function effectiveSides(kind: CommodityKindR15, crudeMode: CrudeSideModeR15): { allowLong: boolean; allowShort: boolean } {
  if (kind !== 'CRUDE') return { allowLong: true, allowShort: true };
  return {
    allowLong: crudeMode === 'BUY' || crudeMode === 'BOTH',
    allowShort: crudeMode === 'SELL' || crudeMode === 'BOTH',
  };
}

export function evaluateCommodityLiveR15(
  config: CommodityStrategyConfigR15,
  book: CommodityBookR15,
  candles: CommodityCandleR15[],
  micro: CommodityMicroBarR15[],
): CommodityDiagnosticR15 {
  const threshold = Number(config.scoreMin ?? env.COMMODITY_SIGNAL_SCORE_MIN);
  const spread = spreadPct(book);
  const empty: CommodityDiagnosticR15 = {
    action: 'WAIT', reason: 'CALIBRATING', score: 0, longScore: 0, shortScore: 0, threshold,
    spreadPct: spread, costPct: 0, targetPct: 0, stopPct: 0, rsi: 50, takerBuyRatio: 0.5, atrPct: 0,
    componentsLong: [], componentsShort: [],
  };
  if (candles.length < 40 || micro.length < 2) return { ...empty, reason: 'INSUFFICIENT_30S_1M_HISTORY' };
  if (!(book.bid > 0) || !(book.ask > book.bid)) return { ...empty, reason: 'INVALID_BID_ASK', blockedBy: 'BOOK' };
  if (spread > config.maxSpreadPct) return { ...empty, reason: 'SPREAD_TOO_WIDE', blockedBy: 'SPREAD' };

  const closes = candles.map((row) => row.close);
  const e9s = emaSeries(closes, 9);
  const e21s = emaSeries(closes, 21);
  const e9 = e9s.at(-1) ?? 0;
  const e21 = e21s.at(-1) ?? 0;
  const e9Prev = e9s.at(-4) ?? e9;
  const rsiValue = rsi(closes, 14);
  const atrValue = atr(candles, 14);
  const mid = (book.bid + book.ask) / 2;
  if (!(atrValue > 0) || !(mid > 0)) return { ...empty, reason: 'ATR_NOT_READY' };

  const atrPct = atrValue / mid * 100;
  const costPct = spread + config.feePct * 2 + config.slippagePct * 2;
  const targetPct = Math.max(costPct * Number(config.minEdgeMultiple ?? env.COMMODITY_MIN_EDGE_MULTIPLE), atrPct * 0.58);
  const stopPct = Math.max(costPct * 1.15, atrPct * 0.38);
  if (!(targetPct > costPct)) return { ...empty, reason: 'EDGE_DOES_NOT_COVER_COST', costPct, targetPct, stopPct, atrPct, blockedBy: 'COST' };
  if (targetPct > Math.max(1.5, atrPct * 8)) return { ...empty, reason: 'TARGET_OUTLIER', costPct, targetPct, stopPct, atrPct, blockedBy: 'VOLATILITY' };

  const latest = micro.at(-1)!;
  const previous = micro.at(-2)!;
  const totalFlow = latest.buyVolume + latest.sellVolume;
  const flow = totalFlow > 0 ? latest.buyVolume / totalFlow : 0.5;
  const body = Math.abs(latest.close - latest.open);
  const displacementRatio = atrValue > 0 ? body / atrValue : 0;

  const longComponents: string[] = [];
  const shortComponents: string[] = [];
  let longScore = 0;
  let shortScore = 0;

  if (e9 > e21) { longScore += 18; longComponents.push('EMA9>EMA21 +18'); }
  else if (e9 < e21) { shortScore += 18; shortComponents.push('EMA9<EMA21 +18'); }
  if (e9 > e9Prev) { longScore += 9; longComponents.push('EMA9 slope up +9'); }
  if (e9 < e9Prev) { shortScore += 9; shortComponents.push('EMA9 slope down +9'); }

  if (rsiValue >= 50 && rsiValue <= 78) { longScore += 14; longComponents.push('RSI long zone +14'); }
  else if (rsiValue >= 47 && rsiValue < 50) { longScore += 6; longComponents.push('RSI near long +6'); }
  if (rsiValue >= 22 && rsiValue <= 50) { shortScore += 14; shortComponents.push('RSI short zone +14'); }
  else if (rsiValue > 50 && rsiValue <= 53) { shortScore += 6; shortComponents.push('RSI near short +6'); }

  if (previous.low <= e9 + atrValue * 0.30) { longScore += 8; longComponents.push('M1 pullback +8'); }
  if (previous.high >= e9 - atrValue * 0.30) { shortScore += 8; shortComponents.push('M1 pullback +8'); }

  if (latest.close > latest.open) { longScore += 7; longComponents.push('30s bullish body +7'); }
  if (latest.close < latest.open) { shortScore += 7; shortComponents.push('30s bearish body +7'); }
  if (latest.close > previous.high) { longScore += 13; longComponents.push('30s breakout +13'); }
  else if (latest.close > previous.close) { longScore += 5; longComponents.push('30s momentum +5'); }
  if (latest.close < previous.low) { shortScore += 13; shortComponents.push('30s breakdown +13'); }
  else if (latest.close < previous.close) { shortScore += 5; shortComponents.push('30s momentum +5'); }

  if (displacementRatio >= 0.05) {
    if (latest.close >= latest.open) { longScore += 8; longComponents.push('displacement +8'); }
    else { shortScore += 8; shortComponents.push('displacement +8'); }
  }

  if (flow >= 0.56) { longScore += 13; longComponents.push('taker buy flow +13'); }
  else if (flow >= 0.52) { longScore += 8; longComponents.push('taker buy flow +8'); }
  else if (flow >= 0.50) { longScore += 3; longComponents.push('taker buy neutral +3'); }
  if (flow <= 0.44) { shortScore += 13; shortComponents.push('taker sell flow +13'); }
  else if (flow <= 0.48) { shortScore += 8; shortComponents.push('taker sell flow +8'); }
  else if (flow <= 0.50) { shortScore += 3; shortComponents.push('taker sell neutral +3'); }

  const longAllowed = config.allowLong && longScore >= threshold;
  const shortAllowed = config.allowShort && shortScore >= threshold;
  let side: TradeSide | null = null;
  let score = Math.max(longScore, shortScore);
  if (longAllowed && shortAllowed) side = longScore >= shortScore ? 'BUY' : 'SELL';
  else if (longAllowed) side = 'BUY';
  else if (shortAllowed) side = 'SELL';

  const base: CommodityDiagnosticR15 = {
    action: side ?? 'WAIT',
    reason: side ? 'R15_SCORE_THRESHOLD_MET' : 'SCORE_BELOW_THRESHOLD',
    score,
    longScore,
    shortScore,
    threshold,
    spreadPct: spread,
    costPct,
    targetPct,
    stopPct,
    rsi: rsiValue,
    takerBuyRatio: flow,
    atrPct,
    componentsLong: longComponents,
    componentsShort: shortComponents,
  };
  if (!side) return base;

  const entry = side === 'BUY'
    ? book.ask * (1 + config.slippagePct / 100)
    : book.bid * (1 - config.slippagePct / 100);
  const stopLoss = side === 'BUY' ? entry * (1 - stopPct / 100) : entry * (1 + stopPct / 100);
  const takeProfit = side === 'BUY' ? entry * (1 + targetPct / 100) : entry * (1 - targetPct / 100);
  const signal: CommoditySignalR15 = {
    side,
    score,
    reason: side === 'BUY' ? 'R15_SCORE_LONG_30S_1M' : 'R15_SCORE_SHORT_30S_1M',
    spreadPct: spread,
    costPct,
    targetPct,
    stopPct,
    entry,
    stopLoss,
    takeProfit,
    rsi: rsiValue,
    flow,
    atrPct,
    components: side === 'BUY' ? longComponents : shortComponents,
  };
  return { ...base, signal, reason: signal.reason };
}

export function runHistoricalBacktestR15(input: {
  kind: CommodityKindR15;
  candles: CommodityCandleR15[];
  sideMode: CrudeSideModeR15;
  assumedSpreadPct: number;
  feePct: number;
  slippagePct: number;
  leverage: number;
  initialBalance?: number;
  marginPctPerTrade?: number;
  maxHoldSeconds?: number;
}): HistoricalBacktestResultR15 {
  const candles = [...input.candles].sort((a, b) => a.time - b.time);
  const initial = Number(input.initialBalance ?? env.COMMODITY_PAPER_INITIAL_BALANCE);
  const marginPct = Number(input.marginPctPerTrade ?? env.COMMODITY_MARGIN_PCT);
  const leverage = Math.max(1, Number(input.leverage || 1));
  const maxHoldBars = Math.max(1, Math.ceil(Number(input.maxHoldSeconds ?? env.COMMODITY_MAX_HOLD_SECONDS) / 60));
  const sides = effectiveSides(input.kind, input.sideMode);
  let balance = initial;
  let peak = initial;
  let maxDrawdownPct = 0;
  let grossWins = 0;
  let grossLosses = 0;
  const trades: HistoricalBacktestTradeR15[] = [];
  const equityCurve: Array<{ time: number; equity: number }> = [{ time: candles[0]?.time ?? Date.now(), equity: initial }];

  let i = 55;
  while (i < candles.length - 2) {
    const setup = evaluateHistoricalMinute(candles, i, {
      kind: input.kind,
      allowLong: sides.allowLong,
      allowShort: sides.allowShort,
      spreadPct: input.assumedSpreadPct,
      feePct: input.feePct,
      slippagePct: input.slippagePct,
    });
    if (!setup) { i++; continue; }

    const next = candles[i + 1];
    let entry = next.open;
    entry = setup.side === 'BUY'
      ? entry * (1 + (input.assumedSpreadPct / 2 + input.slippagePct) / 100)
      : entry * (1 - (input.assumedSpreadPct / 2 + input.slippagePct) / 100);
    const stopLoss = setup.side === 'BUY' ? entry * (1 - setup.stopPct / 100) : entry * (1 + setup.stopPct / 100);
    const takeProfit = setup.side === 'BUY' ? entry * (1 + setup.targetPct / 100) : entry * (1 - setup.targetPct / 100);
    const margin = Math.max(0, balance * marginPct / 100);
    const notional = margin * leverage;
    const quantity = entry > 0 ? notional / entry : 0;
    if (!(quantity > 0)) { i++; continue; }
    const entryFee = notional * input.feePct / 100;

    let exit = entry;
    let closeReason: 'TP' | 'SL' | 'TIME' = 'TIME';
    let exitIndex = Math.min(candles.length - 1, i + 1 + maxHoldBars);
    for (let j = i + 1; j <= exitIndex; j++) {
      const bar = candles[j];
      const hitSl = setup.side === 'BUY' ? bar.low <= stopLoss : bar.high >= stopLoss;
      const hitTp = setup.side === 'BUY' ? bar.high >= takeProfit : bar.low <= takeProfit;
      if (hitSl) { exit = stopLoss; closeReason = 'SL'; exitIndex = j; break; }
      if (hitTp) { exit = takeProfit; closeReason = 'TP'; exitIndex = j; break; }
      if (j === exitIndex) exit = bar.close;
    }
    exit = setup.side === 'BUY'
      ? exit * (1 - (input.assumedSpreadPct / 2 + input.slippagePct) / 100)
      : exit * (1 + (input.assumedSpreadPct / 2 + input.slippagePct) / 100);
    const gross = setup.side === 'BUY' ? (exit - entry) * quantity : (entry - exit) * quantity;
    const exitFee = quantity * exit * input.feePct / 100;
    const pnl = gross - entryFee - exitFee;
    balance += pnl;
    if (pnl > 0) grossWins += pnl; else grossLosses += Math.abs(pnl);
    peak = Math.max(peak, balance);
    maxDrawdownPct = Math.max(maxDrawdownPct, peak > 0 ? (peak - balance) / peak * 100 : 0);
    const row: HistoricalBacktestTradeR15 = {
      side: setup.side,
      signalTime: candles[i].time,
      openTime: next.time,
      closeTime: candles[exitIndex].time,
      entry,
      exit,
      stopLoss,
      takeProfit,
      score: setup.score,
      closeReason,
      pnl,
      returnOnAccountPct: balance - pnl > 0 ? pnl / (balance - pnl) * 100 : 0,
      balanceAfter: balance,
    };
    trades.push(row);
    equityCurve.push({ time: row.closeTime, equity: balance });
    i = Math.max(i + 1, exitIndex + 1);
  }

  const wins = trades.filter((row) => row.pnl > 0).length;
  const losses = trades.length - wins;
  const from = candles[0]?.time ?? 0;
  const to = candles.at(-1)?.time ?? 0;
  return {
    model: 'HISTORICAL_1M_APPROXIMATION',
    note: 'Historical Binance/Aster backtest uses closed 1m candles. Standard historical 30s candles/taker-flow are unavailable, so live 30s order-flow is approximated with 1m momentum/volume. Forward PAPER remains the exact comparison.',
    candles: candles.length,
    from,
    to,
    daysCovered: from && to ? (to - from) / 86_400_000 : 0,
    initialBalance: initial,
    finalBalance: balance,
    netPnl: balance - initial,
    returnPct: initial > 0 ? (balance - initial) / initial * 100 : 0,
    trades: trades.length,
    wins,
    losses,
    winRate: trades.length ? wins / trades.length * 100 : 0,
    profitFactor: grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? null : 0,
    expectancy: trades.length ? (balance - initial) / trades.length : 0,
    maxDrawdownPct,
    avgHoldSeconds: trades.length ? trades.reduce((sum, row) => sum + (row.closeTime - row.openTime) / 1000, 0) / trades.length : 0,
    assumedSpreadPct: input.assumedSpreadPct,
    feePct: input.feePct,
    slippagePct: input.slippagePct,
    leverage,
    marginPctPerTrade: marginPct,
    sideMode: input.kind === 'CRUDE' ? input.sideMode : 'BOTH',
    equityCurve,
    recentTrades: trades.slice(-100).reverse(),
  };
}

function evaluateHistoricalMinute(
  candles: CommodityCandleR15[],
  i: number,
  config: { kind: CommodityKindR15; allowLong: boolean; allowShort: boolean; spreadPct: number; feePct: number; slippagePct: number },
): { side: TradeSide; score: number; targetPct: number; stopPct: number } | null {
  if (i < 40) return null;
  const window = candles.slice(Math.max(0, i - 80), i + 1);
  const closes = window.map((row) => row.close);
  const e9s = emaSeries(closes, 9);
  const e21s = emaSeries(closes, 21);
  const e9 = e9s.at(-1) ?? 0;
  const e21 = e21s.at(-1) ?? 0;
  const e9Prev = e9s.at(-4) ?? e9;
  const rsiValue = rsi(closes, 14);
  const atrValue = atr(window, 14);
  const current = window.at(-1)!;
  const previous = window.at(-2)!;
  if (!(atrValue > 0) || !(current.close > 0)) return null;
  const atrPct = atrValue / current.close * 100;
  const costPct = config.spreadPct + config.feePct * 2 + config.slippagePct * 2;
  const targetPct = Math.max(costPct * env.COMMODITY_MIN_EDGE_MULTIPLE, atrPct * 0.58);
  const stopPct = Math.max(costPct * 1.15, atrPct * 0.38);
  if (!(targetPct > costPct) || targetPct > Math.max(1.5, atrPct * 8)) return null;

  let longScore = 0;
  let shortScore = 0;
  if (e9 > e21) longScore += 18; else if (e9 < e21) shortScore += 18;
  if (e9 > e9Prev) longScore += 9; if (e9 < e9Prev) shortScore += 9;
  if (rsiValue >= 50 && rsiValue <= 78) longScore += 14;
  if (rsiValue >= 22 && rsiValue <= 50) shortScore += 14;
  if (previous.low <= e9 + atrValue * 0.30) longScore += 8;
  if (previous.high >= e9 - atrValue * 0.30) shortScore += 8;
  if (current.close > current.open) longScore += 7; else if (current.close < current.open) shortScore += 7;
  if (current.close > previous.high) longScore += 13; else if (current.close > previous.close) longScore += 5;
  if (current.close < previous.low) shortScore += 13; else if (current.close < previous.close) shortScore += 5;
  const body = Math.abs(current.close - current.open);
  if (body / atrValue >= 0.08) {
    if (current.close > current.open) longScore += 8; else shortScore += 8;
  }
  const avgVol = sma(window.slice(-20).map((row) => row.volume));
  if (avgVol > 0 && current.volume >= avgVol * 1.15) {
    if (current.close > current.open) longScore += 8; else if (current.close < current.open) shortScore += 8;
  }

  // Historical data has no exact 30s taker-flow component, so use a slightly lower
  // admission threshold and explicitly label the result as an approximation.
  const historicalThreshold = Math.max(45, env.COMMODITY_SIGNAL_SCORE_MIN - 8);
  const long = config.allowLong && longScore >= historicalThreshold;
  const short = config.allowShort && shortScore >= historicalThreshold;
  if (!long && !short) return null;
  if (long && short) return longScore >= shortScore
    ? { side: 'BUY', score: longScore, targetPct, stopPct }
    : { side: 'SELL', score: shortScore, targetPct, stopPct };
  return long
    ? { side: 'BUY', score: longScore, targetPct, stopPct }
    : { side: 'SELL', score: shortScore, targetPct, stopPct };
}

export function spreadPct(book: CommodityBookR15): number {
  const mid = (book.bid + book.ask) / 2;
  return mid > 0 ? (book.ask - book.bid) / mid * 100 : 999;
}

function emaSeries(values: number[], period: number): number[] {
  if (!values.length) return [];
  const out = new Array<number>(values.length);
  const k = 2 / (period + 1);
  out[0] = values[0];
  for (let i = 1; i < values.length; i++) out[i] = values[i] * k + out[i - 1] * (1 - k);
  return out;
}

function rsi(values: number[], period: number): number {
  if (values.length <= period) return 50;
  let gains = 0;
  let losses = 0;
  const start = values.length - period;
  for (let i = start; i < values.length; i++) {
    const delta = values[i] - values[i - 1];
    if (delta >= 0) gains += delta; else losses -= delta;
  }
  if (losses <= 1e-12) return gains > 0 ? 100 : 50;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function atr(candles: CommodityCandleR15[], period: number): number {
  if (candles.length < 2) return 0;
  const values: number[] = [];
  for (let i = Math.max(1, candles.length - period); i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];
    values.push(Math.max(current.high - current.low, Math.abs(current.high - previous.close), Math.abs(current.low - previous.close)));
  }
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function sma(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}