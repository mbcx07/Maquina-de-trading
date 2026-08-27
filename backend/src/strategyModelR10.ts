import type { Candle, AnalysisSignal } from './analysis.js';

const LOOKBACK = 12;
const SWEEP_AGE = 5;
const SWEEP_MIN_ATR = 0.04;
const SWEEP_MAX_ATR = 0.85;
const DISPLACEMENT_MIN_ATR = 0.35;
const MSS_LOOKBACK = 5;
const MSS_BREAK_BUFFER_ATR = 0.01;
const CLOSE_LOCATION_MIN = 0.60;
const SL_BUFFER_ATR = 0.05;
const TARGET_R = 0.60;
const MIN_BIAS_SEPARATION_ATR = 0.03;

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const sma = (values: number[], period: number): number => {
  if (!values.length) return 0;
  const slice = values.slice(-Math.min(period, values.length));
  return slice.reduce((sum, value) => sum + value, 0) / slice.length;
};
const ema = (values: number[], period: number): number => {
  if (!values.length) return 0;
  if (values.length < period) return sma(values, values.length);
  const k = 2 / (period + 1);
  let value = sma(values.slice(0, period), period);
  for (let i = period; i < values.length; i++) value = values[i] * k + value * (1 - k);
  return value;
};
const atr = (candles: Candle[], period = 14): number => {
  if (candles.length < 2) return 0;
  const start = Math.max(1, candles.length - period);
  const values: number[] = [];
  for (let i = start; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];
    values.push(Math.max(current.high - current.low, Math.abs(current.high - previous.close), Math.abs(current.low - previous.close)));
  }
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
};

function priorLow(candles: Candle[], sweepIndex: number): number {
  let value = Number.POSITIVE_INFINITY;
  for (let i = Math.max(0, sweepIndex - LOOKBACK); i < sweepIndex; i++) value = Math.min(value, candles[i].low);
  return Number.isFinite(value) ? value : 0;
}
function priorHigh(candles: Candle[], sweepIndex: number): number {
  let value = Number.NEGATIVE_INFINITY;
  for (let i = Math.max(0, sweepIndex - LOOKBACK); i < sweepIndex; i++) value = Math.max(value, candles[i].high);
  return Number.isFinite(value) ? value : 0;
}
function microHigh(candles: Candle[], sweepIndex: number): number {
  let value = Number.NEGATIVE_INFINITY;
  for (let i = Math.max(0, sweepIndex - MSS_LOOKBACK); i < sweepIndex; i++) value = Math.max(value, candles[i].high);
  return Number.isFinite(value) ? value : 0;
}
function microLow(candles: Candle[], sweepIndex: number): number {
  let value = Number.POSITIVE_INFINITY;
  for (let i = Math.max(0, sweepIndex - MSS_LOOKBACK); i < sweepIndex; i++) value = Math.min(value, candles[i].low);
  return Number.isFinite(value) ? value : 0;
}

function bias(ltf: Candle[], htf: Candle[]): { side: 'LONG' | 'SHORT'; strength: number } | null {
  if (ltf.length < 55 || htf.length < 55) return null;
  const lc = ltf.map((c) => c.close);
  const hc = htf.map((c) => c.close);
  const la = atr(ltf, 14);
  const ha = atr(htf, 14);
  if (!(la > 0) || !(ha > 0)) return null;
  const hf = ema(hc, 20), hs = ema(hc, 50), hp = ema(hc.slice(0, -2), 20);
  const mf = ema(lc, 20), ms = ema(lc, 50), mp = ema(lc.slice(0, -2), 20);
  const sep = Math.abs(hf - hs) / ha;
  if (sep < MIN_BIAS_SEPARATION_ATR) return null;
  const hclose = hc.at(-1) ?? 0, mclose = lc.at(-1) ?? 0;
  const long = hf > hs && hf >= hp && hclose >= hf && mf >= ms && mf >= mp && mclose >= mf - la * 0.12;
  const short = hf < hs && hf <= hp && hclose <= hf && mf <= ms && mf <= mp && mclose <= mf + la * 0.12;
  if (!long && !short) return null;
  return { side: long ? 'LONG' : 'SHORT', strength: clamp(45 + sep * 35 + Math.abs(mf - ms) / la * 12, 45, 95) };
}

export function analyzeHighWinrateM5M15(ltf: Candle[], htf: Candle[]): AnalysisSignal | null {
  if (ltf.length < 80 || htf.length < 60) return null;
  const i = ltf.length - 1;
  const current = ltf[i];
  const A = atr(ltf, 14);
  if (!(A > 0) || !(current.close > 0)) return null;
  const b = bias(ltf, htf);
  if (!b) return null;
  const body = Math.abs(current.close - current.open);
  const range = Math.max(1e-12, current.high - current.low);
  if (body < DISPLACEMENT_MIN_ATR * A) return null;

  if (b.side === 'LONG') {
    const clv = (current.close - current.low) / range;
    if (clv < CLOSE_LOCATION_MIN || current.close <= current.open) return null;
    for (let sw = i - 1; sw >= Math.max(60, i - SWEEP_AGE); sw--) {
      const liq = priorLow(ltf, sw);
      const depth = liq - ltf[sw].low;
      if (!(liq > 0) || depth < SWEEP_MIN_ATR * A || depth > SWEEP_MAX_ATR * A) continue;
      let reclaimed = ltf[sw].close >= liq;
      for (let k = sw + 1; !reclaimed && k < i; k++) reclaimed = ltf[k].close >= liq;
      if (!reclaimed || current.close <= microHigh(ltf, sw) + MSS_BREAK_BUFFER_ATR * A) continue;
      const sl = ltf[sw].low - SL_BUFFER_ATR * A;
      const risk = current.close - sl;
      if (!(risk > A * 0.15) || risk > A * 3.2) continue;
      const confidence = Math.round(clamp(68 + b.strength * 0.12 + clamp(depth / A, 0, 1) * 9 + clamp(body / A, 0, 1.5) * 8 + clv * 5, 74, 96));
      return { side: 'BUY', entry: current.close, stopLoss: sl, takeProfit: current.close + risk * TARGET_R, tp2: current.close + risk, tp3: current.close + risk * 1.5, reason: `HIGH_WR_SWEEP_RECLAIM_MSS_LONG_Q${confidence}`, confidence, atr: A, strategy: 'HIGH_WINRATE_SWEEP_M5_M15_R10' };
    }
  } else {
    const clv = (current.high - current.close) / range;
    if (clv < CLOSE_LOCATION_MIN || current.close >= current.open) return null;
    for (let sw = i - 1; sw >= Math.max(60, i - SWEEP_AGE); sw--) {
      const liq = priorHigh(ltf, sw);
      const depth = ltf[sw].high - liq;
      if (!(liq > 0) || depth < SWEEP_MIN_ATR * A || depth > SWEEP_MAX_ATR * A) continue;
      let reclaimed = ltf[sw].close <= liq;
      for (let k = sw + 1; !reclaimed && k < i; k++) reclaimed = ltf[k].close <= liq;
      if (!reclaimed || current.close >= microLow(ltf, sw) - MSS_BREAK_BUFFER_ATR * A) continue;
      const sl = ltf[sw].high + SL_BUFFER_ATR * A;
      const risk = sl - current.close;
      if (!(risk > A * 0.15) || risk > A * 3.2) continue;
      const confidence = Math.round(clamp(68 + b.strength * 0.12 + clamp(depth / A, 0, 1) * 9 + clamp(body / A, 0, 1.5) * 8 + clv * 5, 74, 96));
      return { side: 'SELL', entry: current.close, stopLoss: sl, takeProfit: current.close - risk * TARGET_R, tp2: current.close - risk, tp3: current.close - risk * 1.5, reason: `HIGH_WR_SWEEP_RECLAIM_MSS_SHORT_Q${confidence}`, confidence, atr: A, strategy: 'HIGH_WINRATE_SWEEP_M5_M15_R10' };
    }
  }
  return null;
}
