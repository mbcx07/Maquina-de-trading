import type { Candle } from './analysis.js';
import type { TradeSide } from './types.js';

export interface CryptoReversalAssessment {
  score: number;
  level: 'NONE' | 'WARNING' | 'STRONG';
  reasons: string[];
  components: {
    htfTrend: number;
    ltfTrend: number;
    rsi: number;
    macd: number;
    volumeCandle: number;
    structure: number;
  };
  indicators: {
    rsi: number;
    macd: number;
    macdSignal: number;
    macdHistogram: number;
    volumeRatio: number;
    m5Ema9: number;
    m5Ema21: number;
    m15Ema50: number;
    m15Ema200: number;
  };
}

/**
 * Position-aware reversal score. It does not decide whether a market is tradable;
 * R11 qualification remains the admission model. This score only asks whether
 * current structure is moving materially against an existing/candidate position.
 */
export function assessCryptoReversal(
  m5Input: Candle[],
  m15Input: Candle[],
  positionSide: TradeSide,
): CryptoReversalAssessment {
  const m5 = closedSorted(m5Input);
  const m15 = closedSorted(m15Input);
  if (m5.length < 60 || m15.length < 210) return emptyAssessment();

  const m5Close = m5.map((c) => c.close);
  const m15Close = m15.map((c) => c.close);
  const m5Ema9 = emaSeries(m5Close, 9);
  const m5Ema21 = emaSeries(m5Close, 21);
  const m15Ema50 = emaSeries(m15Close, 50);
  const m15Ema200 = emaSeries(m15Close, 200);
  const rsi = rsiValue(m5Close, 14);
  const macdFast = emaSeries(m5Close, 12);
  const macdSlow = emaSeries(m5Close, 26);
  const macdSeries = m5Close.map((_, i) => macdFast[i] - macdSlow[i]);
  const macdSignalSeries = emaSeries(macdSeries, 9);

  const i5 = m5.length - 1;
  const i15 = m15.length - 1;
  const long = positionSide === 'BUY';
  const components = { htfTrend: 0, ltfTrend: 0, rsi: 0, macd: 0, volumeCandle: 0, structure: 0 };
  const reasons: string[] = [];

  const htfFull = long
    ? m15Ema50[i15] < m15Ema200[i15] && m15[i15].close < m15Ema50[i15]
    : m15Ema50[i15] > m15Ema200[i15] && m15[i15].close > m15Ema50[i15];
  const htfPartial = long
    ? m15[i15].close < m15Ema50[i15] && m15Ema50[i15] < m15Ema50[Math.max(0, i15 - 3)]
    : m15[i15].close > m15Ema50[i15] && m15Ema50[i15] > m15Ema50[Math.max(0, i15 - 3)];
  if (htfFull) { components.htfTrend = 20; reasons.push('HTF_MACRO_ADVERSE'); }
  else if (htfPartial) { components.htfTrend = 10; reasons.push('HTF_WEAKENING_ADVERSE'); }

  const ltfFull = long
    ? m5Ema9[i5] < m5Ema21[i5] && m5Ema9[i5] < m5Ema9[Math.max(0, i5 - 2)]
    : m5Ema9[i5] > m5Ema21[i5] && m5Ema9[i5] > m5Ema9[Math.max(0, i5 - 2)];
  const ltfPartial = long ? m5Ema9[i5] < m5Ema21[i5] : m5Ema9[i5] > m5Ema21[i5];
  if (ltfFull) { components.ltfTrend = 20; reasons.push('LTF_EMA_ADVERSE'); }
  else if (ltfPartial) { components.ltfTrend = 10; reasons.push('LTF_EMA_CROSS_ADVERSE'); }

  if (long) {
    if (rsi < 45) { components.rsi = 15; reasons.push('RSI_BEAR_PRESSURE'); }
    else if (rsi < 50) { components.rsi = 7; reasons.push('RSI_WEAK_FOR_LONG'); }
  } else {
    if (rsi > 55) { components.rsi = 15; reasons.push('RSI_BULL_PRESSURE'); }
    else if (rsi > 50) { components.rsi = 7; reasons.push('RSI_WEAK_FOR_SHORT'); }
  }

  const macd = macdSeries[i5];
  const macdSignal = macdSignalSeries[i5];
  const macdHistogram = macd - macdSignal;
  const macdAdverse = long ? macd < macdSignal && macdHistogram < 0 : macd > macdSignal && macdHistogram > 0;
  const macdMomentumAdverse = long ? macdHistogram < 0 : macdHistogram > 0;
  if (macdAdverse) { components.macd = 15; reasons.push('MACD_ADVERSE'); }
  else if (macdMomentumAdverse) { components.macd = 7; reasons.push('MACD_MOMENTUM_ADVERSE'); }

  const current = m5[i5];
  const avgVolume = average(m5.slice(Math.max(0, i5 - 20), i5).map((c) => c.volume));
  const volumeRatio = avgVolume > 0 ? current.volume / avgVolume : 0;
  const adverseCandle = long ? current.close < current.open : current.close > current.open;
  if (adverseCandle && volumeRatio >= 1.5) { components.volumeCandle = 15; reasons.push('ADVERSE_VOLUME_SPIKE'); }
  else if (adverseCandle && volumeRatio >= 1.2) { components.volumeCandle = 8; reasons.push('ADVERSE_VOLUME_EXPANSION'); }

  const recent = m5.slice(-4);
  if (recent.length === 4) {
    const adverseStructure = long
      ? recent[3].high < recent[2].high && recent[3].low < recent[2].low && recent[2].low < recent[1].low
      : recent[3].high > recent[2].high && recent[3].low > recent[2].low && recent[2].high > recent[1].high;
    const partialStructure = long
      ? recent[3].low < recent[2].low && recent[3].close < recent[2].close
      : recent[3].high > recent[2].high && recent[3].close > recent[2].close;
    if (adverseStructure) { components.structure = 15; reasons.push('MICROSTRUCTURE_REVERSAL'); }
    else if (partialStructure) { components.structure = 8; reasons.push('MICROSTRUCTURE_WARNING'); }
  }

  const score = Math.max(0, Math.min(100, Object.values(components).reduce((sum, value) => sum + value, 0)));
  return {
    score,
    level: score >= 50 ? 'STRONG' : score >= 30 ? 'WARNING' : 'NONE',
    reasons,
    components,
    indicators: {
      rsi,
      macd,
      macdSignal,
      macdHistogram,
      volumeRatio,
      m5Ema9: m5Ema9[i5],
      m5Ema21: m5Ema21[i5],
      m15Ema50: m15Ema50[i15],
      m15Ema200: m15Ema200[i15],
    },
  };
}

function emptyAssessment(): CryptoReversalAssessment {
  return {
    score: 0,
    level: 'NONE',
    reasons: ['INSUFFICIENT_DATA'],
    components: { htfTrend: 0, ltfTrend: 0, rsi: 0, macd: 0, volumeCandle: 0, structure: 0 },
    indicators: { rsi: 50, macd: 0, macdSignal: 0, macdHistogram: 0, volumeRatio: 0, m5Ema9: 0, m5Ema21: 0, m15Ema50: 0, m15Ema200: 0 },
  };
}

function closedSorted(input: Candle[]): Candle[] {
  return [...input]
    .filter((c) => Number.isFinite(c.time) && Number.isFinite(c.open) && Number.isFinite(c.high) && Number.isFinite(c.low) && Number.isFinite(c.close))
    .sort((a, b) => a.time - b.time);
}

function emaSeries(values: number[], period: number): number[] {
  if (!values.length) return [];
  const alpha = 2 / (period + 1);
  const output = new Array<number>(values.length);
  output[0] = values[0];
  for (let i = 1; i < values.length; i++) output[i] = values[i] * alpha + output[i - 1] * (1 - alpha);
  return output;
}

function rsiValue(values: number[], period: number): number {
  if (values.length <= period) return 50;
  let gains = 0;
  let losses = 0;
  const start = values.length - period;
  for (let i = start; i < values.length; i++) {
    const delta = values[i] - values[i - 1];
    if (delta >= 0) gains += delta;
    else losses -= delta;
  }
  if (losses <= 1e-12) return gains > 0 ? 100 : 50;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}
