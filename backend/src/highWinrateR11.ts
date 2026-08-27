import type { Candle, AnalysisSignal } from './analysis.js';

const M5_MS = 5 * 60_000;
const M15_MS = 15 * 60_000;
const MIN_BIAS_SEPARATION_ATR = 0.03;
const MSS_LOOKBACK = 5;
const MSS_BREAK_BUFFER_ATR = 0.01;
const CLOSE_LOCATION_MIN = 0.62;
const SL_BUFFER_ATR = 0.05;

export interface R11Config {
  lookback: number;
  sweepAge: number;
  sweepMinATR: number;
  sweepMaxATR: number;
  dispATR: number;
  entryATR: number;
  rr: number;
  pendingBars: number;
  holdBars: number;
}

export interface R11Stats {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  sumR: number;
  expectancyR: number;
  grossWinR: number;
  grossLossR: number;
  profitFactor: number;
  maxDDR: number;
  tradesPerDay: number;
  days: number;
}

export interface R11Setup {
  direction: 1 | -1;
  signalTime: number;
  signalIndex: number;
  sweepIndex: number;
  liquidity: number;
  sweepExtreme: number;
  entry: number;
  sl: number;
  tp: number;
  atr: number;
  quality: number;
}

export interface R11Trade {
  direction: 1 | -1;
  signalTime: number;
  fillTime: number;
  exitTime: number;
  entry: number;
  sl: number;
  tp: number;
  exit: number;
  resultR: number;
  reason: 'TP' | 'SL' | 'TIMEOUT';
}

export interface R11Model {
  ready: boolean;
  fallback: boolean;
  status: string;
  config: R11Config;
  score: number;
  train: R11Stats;
  validation: R11Stats;
  holdout: R11Stats;
  calibrationBars: number;
}

interface Prepared {
  m5: Candle[];
  m15: Candle[];
  atr5: number[];
  ema5Fast: number[];
  ema5Slow: number[];
  atr15: number[];
  ema15Fast: number[];
  ema15Slow: number[];
}

export const DEFAULT_R11_CONFIG: R11Config = {
  lookback: 12,
  sweepAge: 4,
  sweepMinATR: 0.06,
  sweepMaxATR: 0.85,
  dispATR: 0.45,
  entryATR: 0.12,
  rr: 0.60,
  pendingBars: 3,
  holdBars: 8,
};

export function prepareR11(m5Input: Candle[], m15Input: Candle[]): Prepared {
  const m5 = dedupe(m5Input);
  const m15 = dedupe(m15Input);
  return {
    m5,
    m15,
    atr5: buildAtr(m5, 14),
    ema5Fast: buildEma(m5, 20),
    ema5Slow: buildEma(m5, 50),
    atr15: buildAtr(m15, 14),
    ema15Fast: buildEma(m15, 20),
    ema15Slow: buildEma(m15, 50),
  };
}

/** Exact V14-style bias adapted to the user's M5/M15-only requirement. */
export function biasAtR11(data: Prepared, m5Index: number): 1 | -1 | 0 {
  if (m5Index < 5 || m5Index >= data.m5.length) return 0;
  const signalClose = data.m5[m5Index].time + M5_MS;
  const m15Index = upperBoundTime(data.m15, signalClose - M15_MS) - 1;
  const b15 = biasOne(data.m15, data.ema15Fast, data.ema15Slow, data.atr15, m15Index);
  const b5 = biasOne(data.m5, data.ema5Fast, data.ema5Slow, data.atr5, m5Index);
  if (b15 === 1 && b5 === 1) return 1;
  if (b15 === -1 && b5 === -1) return -1;
  return 0;
}

export function buildSetupR11(data: Prepared, config: R11Config, i: number, bias: 1 | -1 | 0): R11Setup | null {
  const r = data.m5;
  if (i < 80 || i >= r.length || bias === 0) return null;
  const A = data.atr5[i];
  if (!(A > 0)) return null;
  const body = Math.abs(r[i].close - r[i].open);
  const range = Math.max(1e-12, r[i].high - r[i].low);
  if (body < config.dispATR * A) return null;

  if (bias > 0) {
    const clv = (r[i].close - r[i].low) / range;
    if (clv < CLOSE_LOCATION_MIN) return null;
    for (let sw = i - 1; sw >= Math.max(60, i - config.sweepAge); sw--) {
      const liq = priorLow(r, sw, config.lookback);
      if (!(liq > 0)) continue;
      const depth = liq - r[sw].low;
      if (depth < config.sweepMinATR * A || depth > config.sweepMaxATR * A) continue;
      let reclaimed = r[sw].close >= liq;
      for (let k = sw + 1; !reclaimed && k < i; k++) reclaimed = r[k].close >= liq;
      if (!reclaimed) continue;
      const mss = microHigh(r, sw);
      if (!(mss > 0) || r[i].close <= mss + MSS_BREAK_BUFFER_ATR * A) continue;
      const entry = r[i].close - config.entryATR * A;
      const sl = r[sw].low - SL_BUFFER_ATR * A;
      if (!(entry > sl)) continue;
      const risk = entry - sl;
      const tp = entry + config.rr * risk;
      return {
        direction: 1,
        signalTime: r[i].time,
        signalIndex: i,
        sweepIndex: sw,
        liquidity: liq,
        sweepExtreme: r[sw].low,
        entry,
        sl,
        tp,
        atr: A,
        quality: clamp(50 + 20 * (depth / A) + 20 * (body / A) + 10 * clv, 0, 100),
      };
    }
  } else {
    const clv = (r[i].high - r[i].close) / range;
    if (clv < CLOSE_LOCATION_MIN) return null;
    for (let sw = i - 1; sw >= Math.max(60, i - config.sweepAge); sw--) {
      const liq = priorHigh(r, sw, config.lookback);
      if (!(liq > 0)) continue;
      const depth = r[sw].high - liq;
      if (depth < config.sweepMinATR * A || depth > config.sweepMaxATR * A) continue;
      let reclaimed = r[sw].close <= liq;
      for (let k = sw + 1; !reclaimed && k < i; k++) reclaimed = r[k].close <= liq;
      if (!reclaimed) continue;
      const mss = microLow(r, sw);
      if (!(mss > 0) || r[i].close >= mss - MSS_BREAK_BUFFER_ATR * A) continue;
      const entry = r[i].close + config.entryATR * A;
      const sl = r[sw].high + SL_BUFFER_ATR * A;
      if (!(entry < sl)) continue;
      const risk = sl - entry;
      const tp = entry - config.rr * risk;
      return {
        direction: -1,
        signalTime: r[i].time,
        signalIndex: i,
        sweepIndex: sw,
        liquidity: liq,
        sweepExtreme: r[sw].high,
        entry,
        sl,
        tp,
        atr: A,
        quality: clamp(50 + 20 * (depth / A) + 20 * (body / A) + 10 * clv, 0, 100),
      };
    }
  }
  return null;
}

export function simulateR11(
  data: Prepared,
  config: R11Config,
  startIndex: number,
  endIndex: number,
): { stats: R11Stats; trades: R11Trade[] } {
  const r = data.m5;
  const start = Math.max(100, startIndex);
  const end = Math.min(endIndex, r.length - 2);
  const trades: R11Trade[] = [];
  if (end <= start) return { stats: emptyStats(), trades };

  let i = start;
  while (i < end - 1) {
    const bias = biasAtR11(data, i);
    if (bias === 0) { i++; continue; }
    const setup = buildSetupR11(data, config, i, bias);
    if (!setup) { i++; continue; }

    let fill = -1;
    const pendingEnd = Math.min(end - 1, i + Math.max(1, config.pendingBars));
    for (let j = i + 1; j <= pendingEnd; j++) {
      if (pendingFilled(setup, r[j])) { fill = j; break; }
    }
    if (fill < 0) { i++; continue; }

    let resultR = 0;
    let exitIndex = fill;
    let exitPrice = setup.entry;
    let reason: R11Trade['reason'] = 'TIMEOUT';
    let exited = false;
    const holdEnd = Math.min(end - 1, fill + Math.max(1, config.holdBars));
    for (let j = fill; j <= holdEnd; j++) {
      const resolved = exitBar(setup, r[j]);
      if (!resolved) continue;
      resultR = resolved.resultR;
      exitPrice = resolved.exit;
      reason = resolved.reason;
      exitIndex = j;
      exited = true;
      break;
    }
    if (!exited) {
      exitIndex = holdEnd;
      exitPrice = r[exitIndex].close;
      resultR = setup.direction > 0
        ? (exitPrice - setup.entry) / (setup.entry - setup.sl)
        : (setup.entry - exitPrice) / (setup.sl - setup.entry);
      resultR = clamp(resultR, -1, config.rr);
    }

    trades.push({
      direction: setup.direction,
      signalTime: setup.signalTime,
      fillTime: r[fill].time,
      exitTime: r[exitIndex].time,
      entry: setup.entry,
      sl: setup.sl,
      tp: setup.tp,
      exit: exitPrice,
      resultR,
      reason,
    });
    i = Math.max(i + 1, exitIndex + 1);
  }

  return { stats: statsFromTrades(trades, countDays(r, start, end)), trades };
}

export function calibrateR11(m5Input: Candle[], m15Input: Candle[]): R11Model {
  const data = prepareR11(m5Input, m15Input);
  const n = data.m5.length;
  const blank: R11Model = {
    ready: false,
    fallback: false,
    status: 'INSUFFICIENT_M5_HISTORY',
    config: { ...DEFAULT_R11_CONFIG },
    score: Number.NEGATIVE_INFINITY,
    train: emptyStats(), validation: emptyStats(), holdout: emptyStats(), calibrationBars: n,
  };
  if (n < 3000 || data.m15.length < 500) return blank;

  // Match V14's 60/20/20 shape, using the most recent window available.
  const usable = n - 150;
  const trN = Math.floor(usable * 0.60);
  let vN = Math.floor(usable * 0.20);
  if (trN + vN > usable - 500) vN = Math.max(300, usable - trN - 500);
  const tr0 = 100;
  const tr1 = Math.min(n - 2, tr0 + trN);
  const v0 = tr1;
  const v1 = Math.min(n - 2, v0 + vN);
  const h0 = v1;
  const hEnd = n - 2;
  if (hEnd - h0 < 250) return { ...blank, status: 'HOLDOUT_TOO_SMALL' };

  let bestStrict: R11Model | null = null;
  let bestFallback: R11Model | null = null;
  const looks = [8, 12, 20];
  const ages = [3, 5];
  const sweeps = [0.04, 0.08, 0.12];
  const disps = [0.35, 0.50, 0.65];
  const entries = [0.06, 0.12, 0.20];
  const rrs = [0.45, 0.55, 0.65, 0.75];

  for (const lookback of looks)
    for (const sweepAge of ages)
      for (const sweepMinATR of sweeps)
        for (const dispATR of disps)
          for (const entryATR of entries)
            for (const rr of rrs) {
              const config: R11Config = {
                lookback, sweepAge, sweepMinATR, sweepMaxATR: 0.85,
                dispATR, entryATR, rr, pendingBars: 3, holdBars: 8,
              };
              const train = simulateR11(data, config, tr0, tr1).stats;
              // Preserve the original V14 training gate, but allow fewer M5 trades than M1.
              if (train.trades < 12 || train.winRate < 60 || train.profitFactor < 1 || train.expectancyR <= 0) continue;
              const validation = simulateR11(data, config, v0, v1).stats;
              const holdout = simulateR11(data, config, h0, hEnd).stats;
              const score = modelScore(train, validation, holdout);
              const candidate: R11Model = {
                ready: true,
                fallback: false,
                status: 'STRICT_HIGH_WINRATE_OOS',
                config,
                score,
                train,
                validation,
                holdout,
                calibrationBars: n,
              };
              if (strictPass(validation, holdout) && (!bestStrict || score > bestStrict.score)) bestStrict = candidate;
              if (positiveFallbackPass(validation, holdout) && (!bestFallback || score > bestFallback.score)) {
                bestFallback = { ...candidate, fallback: true, status: 'POSITIVE_OOS_FALLBACK' };
              }
            }

  if (bestStrict) return bestStrict;
  if (bestFallback) return bestFallback;
  return { ...blank, status: 'NO_POSITIVE_HIGH_WINRATE_MODEL' };
}

/** Find a still-pending retest setup from the most recent closed M5 bars. */
export function latestPendingSetupR11(
  m5Input: Candle[],
  m15Input: Candle[],
  config: R11Config,
  maxAgeBars = 3,
): R11Setup | null {
  const data = prepareR11(m5Input, m15Input);
  const last = data.m5.length - 1;
  for (let i = last; i >= Math.max(100, last - maxAgeBars); i--) {
    const setup = buildSetupR11(data, config, i, biasAtR11(data, i));
    if (!setup) continue;
    // If a completed bar after the signal already touched the pending price, the
    // opportunity has already been consumed. Live polling should not chase it late.
    let consumed = false;
    for (let j = i + 1; j <= last; j++) {
      if (pendingFilled(setup, data.m5[j])) { consumed = true; break; }
    }
    if (!consumed) return setup;
  }
  return null;
}

export function signalFromPendingR11(setup: R11Setup, currentPrice: number): AnalysisSignal | null {
  if (!(currentPrice > 0)) return null;
  // Trigger only once the live mark price has actually reached the calibrated retest entry.
  if (setup.direction > 0 && currentPrice > setup.entry) return null;
  if (setup.direction < 0 && currentPrice < setup.entry) return null;
  const entry = currentPrice;
  const risk = setup.direction > 0 ? entry - setup.sl : setup.sl - entry;
  if (!(risk > 0)) return null;
  const rr = (Math.abs(setup.tp - setup.entry) / Math.abs(setup.entry - setup.sl));
  const direction = setup.direction > 0 ? 1 : -1;
  return {
    side: setup.direction > 0 ? 'BUY' : 'SELL',
    entry,
    stopLoss: setup.sl,
    takeProfit: entry + direction * risk * rr,
    tp2: entry + direction * risk,
    tp3: entry + direction * risk * 1.5,
    reason: `R11_CALIBRATED_SWEEP_RETEST_Q${Math.round(setup.quality)}`,
    confidence: Math.round(clamp(setup.quality, 70, 96)),
    atr: setup.atr,
    strategy: 'CALIBRATED_SWEEP_RETEST_M5_M15_R11',
  };
}

export function evaluateConfigExternalR11(m5: Candle[], m15: Candle[], config: R11Config, startTime: number, endTime: number) {
  const data = prepareR11(m5, m15);
  const start = lowerBoundTime(data.m5, startTime);
  const end = upperBoundTime(data.m5, endTime);
  return simulateR11(data, config, start, end);
}

function biasOne(r: Candle[], ef: number[], es: number[], atr: number[], i: number): 1 | -1 | 0 {
  if (i < 5 || i >= r.length || !(atr[i] > 0)) return 0;
  const sep = Math.abs(ef[i] - es[i]) / atr[i];
  if (sep < MIN_BIAS_SEPARATION_ATR) return 0;
  if (ef[i] > es[i] && ef[i] >= ef[i - 2] && r[i].close >= ef[i]) return 1;
  if (ef[i] < es[i] && ef[i] <= ef[i - 2] && r[i].close <= ef[i]) return -1;
  return 0;
}

function pendingFilled(setup: R11Setup, bar: Candle): boolean {
  return setup.direction > 0 ? bar.low <= setup.entry : bar.high >= setup.entry;
}

function exitBar(setup: R11Setup, bar: Candle): { resultR: number; exit: number; reason: 'TP' | 'SL' } | null {
  if (setup.direction > 0) {
    const hitSL = bar.low <= setup.sl;
    const hitTP = bar.high >= setup.tp;
    if (hitSL) return { resultR: -1, exit: setup.sl, reason: 'SL' };
    if (hitTP) return { resultR: (setup.tp - setup.entry) / (setup.entry - setup.sl), exit: setup.tp, reason: 'TP' };
  } else {
    const hitSL = bar.high >= setup.sl;
    const hitTP = bar.low <= setup.tp;
    if (hitSL) return { resultR: -1, exit: setup.sl, reason: 'SL' };
    if (hitTP) return { resultR: (setup.entry - setup.tp) / (setup.sl - setup.entry), exit: setup.tp, reason: 'TP' };
  }
  return null;
}

function statsFromTrades(trades: R11Trade[], days: number): R11Stats {
  const wins = trades.filter((trade) => trade.resultR > 0);
  const losses = trades.filter((trade) => trade.resultR <= 0);
  const grossWinR = wins.reduce((sum, trade) => sum + trade.resultR, 0);
  const grossLossR = losses.reduce((sum, trade) => sum + trade.resultR, 0);
  let eqR = 0;
  let peakR = 0;
  let maxDDR = 0;
  for (const trade of trades) {
    eqR += trade.resultR;
    peakR = Math.max(peakR, eqR);
    maxDDR = Math.max(maxDDR, peakR - eqR);
  }
  const sumR = grossWinR + grossLossR;
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? wins.length / trades.length * 100 : 0,
    sumR,
    expectancyR: trades.length ? sumR / trades.length : 0,
    grossWinR,
    grossLossR,
    profitFactor: grossLossR < 0 ? grossWinR / Math.abs(grossLossR) : grossWinR > 0 ? 99 : 0,
    maxDDR,
    tradesPerDay: trades.length / Math.max(1, days),
    days: Math.max(1, days),
  };
}

function modelScore(train: R11Stats, validation: R11Stats, holdout: R11Stats): number {
  const wr = Math.min(validation.winRate, holdout.winRate);
  const pf = Math.min(validation.profitFactor, holdout.profitFactor);
  const ex = Math.min(validation.expectancyR, holdout.expectancyR);
  const dd = Math.max(validation.maxDDR, holdout.maxDDR);
  const freq = Math.min(20, Math.min(validation.tradesPerDay, holdout.tradesPerDay));
  return 0.055 * wr + 0.35 * Math.min(3, pf) + 1.8 * ex + 0.015 * freq - 0.035 * dd - 0.01 * Math.abs(validation.winRate - holdout.winRate) + 0.15 * train.expectancyR;
}

function strictPass(validation: R11Stats, holdout: R11Stats): boolean {
  return validation.trades >= 6 && holdout.trades >= 6 &&
    validation.winRate >= 70 && holdout.winRate >= 70 &&
    validation.profitFactor >= 1.10 && holdout.profitFactor >= 1.10 &&
    validation.expectancyR >= 0.01 && holdout.expectancyR >= 0.01 &&
    Math.max(validation.maxDDR, holdout.maxDDR) <= 10;
}

function positiveFallbackPass(validation: R11Stats, holdout: R11Stats): boolean {
  const n = validation.trades + holdout.trades;
  if (n < 12) return false;
  const wins = validation.wins + holdout.wins;
  const wr = wins / n * 100;
  const grossWinR = validation.grossWinR + holdout.grossWinR;
  const grossLossR = validation.grossLossR + holdout.grossLossR;
  const pf = grossLossR < 0 ? grossWinR / Math.abs(grossLossR) : grossWinR > 0 ? 99 : 0;
  const expectancy = (validation.sumR + holdout.sumR) / n;
  return wr >= 64 && pf >= 1.02 && expectancy > 0 && Math.max(validation.maxDDR, holdout.maxDDR) <= 12.5;
}

function buildEma(candles: Candle[], period: number): number[] {
  const out = new Array<number>(candles.length).fill(0);
  if (!candles.length) return out;
  const a = 2 / (period + 1);
  out[0] = candles[0].close;
  for (let i = 1; i < candles.length; i++) out[i] = a * candles[i].close + (1 - a) * out[i - 1];
  return out;
}

function buildAtr(candles: Candle[], period: number): number[] {
  const out = new Array<number>(candles.length).fill(0);
  if (!candles.length) return out;
  out[0] = Math.max(candles[0].high - candles[0].low, 1e-12);
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    );
    out[i] = i < period ? (out[i - 1] * i + tr) / (i + 1) : (out[i - 1] * (period - 1) + tr) / period;
  }
  return out;
}

function priorLow(candles: Candle[], s: number, lookback: number): number {
  let value = Number.POSITIVE_INFINITY;
  for (let i = Math.max(0, s - lookback); i < s; i++) value = Math.min(value, candles[i].low);
  return Number.isFinite(value) ? value : 0;
}

function priorHigh(candles: Candle[], s: number, lookback: number): number {
  let value = Number.NEGATIVE_INFINITY;
  for (let i = Math.max(0, s - lookback); i < s; i++) value = Math.max(value, candles[i].high);
  return Number.isFinite(value) ? value : 0;
}

function microHigh(candles: Candle[], s: number): number {
  let value = Number.NEGATIVE_INFINITY;
  for (let i = Math.max(0, s - Math.max(2, MSS_LOOKBACK)); i < s; i++) value = Math.max(value, candles[i].high);
  return Number.isFinite(value) ? value : 0;
}

function microLow(candles: Candle[], s: number): number {
  let value = Number.POSITIVE_INFINITY;
  for (let i = Math.max(0, s - Math.max(2, MSS_LOOKBACK)); i < s; i++) value = Math.min(value, candles[i].low);
  return Number.isFinite(value) ? value : 0;
}

function countDays(candles: Candle[], start: number, end: number): number {
  const days = new Set<string>();
  for (let i = start; i < end; i++) days.add(new Date(candles[i].time).toISOString().slice(0, 10));
  return Math.max(1, days.size);
}

function dedupe(candles: Candle[]): Candle[] {
  const map = new Map<number, Candle>();
  for (const candle of candles) if (Number.isFinite(candle.time)) map.set(candle.time, candle);
  return [...map.values()].sort((a, b) => a.time - b.time);
}

function upperBoundTime(candles: Candle[], time: number): number {
  let low = 0, high = candles.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (candles[mid].time <= time) low = mid + 1;
    else high = mid;
  }
  return low;
}

function lowerBoundTime(candles: Candle[], time: number): number {
  let low = 0, high = candles.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (candles[mid].time < time) low = mid + 1;
    else high = mid;
  }
  return low;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function emptyStats(): R11Stats {
  return { trades: 0, wins: 0, losses: 0, winRate: 0, sumR: 0, expectancyR: 0, grossWinR: 0, grossLossR: 0, profitFactor: 0, maxDDR: 0, tradesPerDay: 0, days: 1 };
}
