import type { Candle, AnalysisSignal, RollingBacktestResult } from './analysis.js';

const sma = (values: number[], period: number): number =>
  values.slice(-period).reduce((a, b) => a + b, 0) / period;

const ema = (values: number[], period: number): number => {
  if (values.length < period) return values[values.length - 1] ?? 0;
  const k = 2 / (period + 1);
  let value = sma(values.slice(0, period), period);
  for (let i = period; i < values.length; i++) value = values[i] * k + value * (1 - k);
  return value;
};

const rsi = (closes: number[], period = 14): number => {
  if (closes.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - 100 / (1 + rs);
};

// Intentionally matches the v33.5 ATR implementation used by the original app.
const atr = (candles: Candle[], period = 14): number => {
  const values = candles.slice(-period).map((candle, index, slice) => {
    if (index === 0) return candle.high - candle.low;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - slice[index - 1].close),
      Math.abs(candle.low - slice[index - 1].close),
    );
  });
  return values.reduce((a, b) => a + b, 0) / values.length;
};

const swings = (candles: Candle[], lookback = 10): { high: number; low: number } => {
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  let high = highs[highs.length - 2];
  let low = lows[lows.length - 2];

  for (let i = highs.length - 3; i > highs.length - lookback; i--) {
    if (highs[i] > highs[i - 1] && highs[i] > highs[i - 2] && highs[i] > highs[i + 1] && highs[i] > highs[i + 2]) {
      high = highs[i];
      break;
    }
  }
  for (let i = lows.length - 3; i > lows.length - lookback; i--) {
    if (lows[i] < lows[i - 1] && lows[i] < lows[i - 2] && lows[i] < lows[i + 1] && lows[i] < lows[i + 2]) {
      low = lows[i];
      break;
    }
  }
  return { high, low };
};

/**
 * Direct backend port of the original QuantumSniper v33.5 strategy.
 * Entry logic is deliberately kept separate from V34 ranking/execution plumbing.
 */
export function analyzeStructureStrategyV335(
  ltfCandles: Candle[],
  htfCandles: Candle[],
  symbol: string,
): AnalysisSignal | null {
  if (ltfCandles.length < 50 || htfCandles.length < 50) return null;

  const currentPrice = ltfCandles[ltfCandles.length - 1].close;
  const htfCloses = htfCandles.map((c) => c.close);
  const ema20Htf = ema(htfCloses, 20);
  const ema50Htf = ema(htfCloses, 50);
  const ema200Htf = ema(htfCloses, 200);
  const previousEma50Htf = ema(htfCloses.slice(0, -5), 50);

  const uptrend = ema20Htf > ema50Htf && ema50Htf > ema200Htf && ema50Htf > previousEma50Htf;
  const downtrend = ema20Htf < ema50Htf && ema50Htf < ema200Htf && ema50Htf < previousEma50Htf;
  if (!uptrend && !downtrend) return null;
  const trend: 'LONG' | 'SHORT' = uptrend ? 'LONG' : 'SHORT';

  // Exact v33.5 anti-chop rule.
  let crossFound = false;
  for (let i = htfCloses.length - 12; i < htfCloses.length - 1; i++) {
    const prior20 = ema(htfCloses.slice(0, i), 20);
    const prior50 = ema(htfCloses.slice(0, i), 50);
    if ((prior20 > prior50 && ema20Htf < ema50Htf) || (prior20 < prior50 && ema20Htf > ema50Htf)) {
      crossFound = true;
      break;
    }
  }
  if (crossFound) return null;

  const closes = ltfCandles.map((c) => c.close);
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const ema50 = ema(closes, 50);
  const currentAtr = atr(ltfCandles, 14);
  const currentRsi = rsi(closes, 14);
  const previousRsi = rsi(closes.slice(0, -1), 14);

  if (currentAtr / currentPrice < 0.0006) return null;
  if (trend === 'LONG' && (currentRsi < 36 || currentRsi > 58 || currentRsi <= previousRsi)) return null;
  if (trend === 'SHORT' && (currentRsi > 64 || currentRsi < 42 || currentRsi >= previousRsi)) return null;

  const inPullback = trend === 'LONG'
    ? currentPrice <= ema21 + currentAtr * 0.8 && currentPrice >= ema50 - currentAtr * 0.5
    : currentPrice >= ema21 - currentAtr * 0.8 && currentPrice <= ema50 + currentAtr * 0.5;
  if (!inPullback) return null;

  let confluence = 0;
  const last = ltfCandles[ltfCandles.length - 1];
  const previous = ltfCandles[ltfCandles.length - 2];
  const volumeAverage = sma(ltfCandles.map((c) => c.volume), 20);
  const structure = swings(ltfCandles, 15);

  const bullishEngulfing = last.close > previous.open && last.close > previous.close && last.open <= previous.close;
  const hammer = Math.min(last.open, last.close) - last.low > Math.abs(last.close - last.open) * 1.6;
  const bearishEngulfing = last.close < previous.open && last.close < previous.close && last.open >= previous.close;
  const shootingStar = last.high - Math.max(last.open, last.close) > Math.abs(last.close - last.open) * 1.6;

  if (trend === 'LONG' && (bullishEngulfing || hammer || last.close > previous.high)) confluence += 25;
  else if (trend === 'SHORT' && (bearishEngulfing || shootingStar || last.close < previous.low)) confluence += 25;

  if (last.volume >= volumeAverage * 1.3 || last.volume > previous.volume * 1.25) confluence += 20;
  if (trend === 'LONG' && currentPrice > structure.low && last.low > structure.low) confluence += 20;
  else if (trend === 'SHORT' && currentPrice < structure.high && last.high < structure.high) confluence += 20;
  if (trend === 'LONG' && ema9 >= ema21 && last.close > ema9) confluence += 20;
  else if (trend === 'SHORT' && ema9 <= ema21 && last.close < ema9) confluence += 20;
  if ((trend === 'LONG' && currentRsi - previousRsi > 1.5) || (trend === 'SHORT' && previousRsi - currentRsi > 1.5)) confluence += 15;

  if (confluence < 75) return null;

  const slBuffer = currentAtr * 0.65;
  const stopLoss = trend === 'LONG'
    ? Math.min(structure.low, last.low) - slBuffer
    : Math.max(structure.high, last.high) + slBuffer;
  const risk = Math.abs(currentPrice - stopLoss);
  if (risk <= 0) return null;

  const takeProfit = trend === 'LONG' ? currentPrice + risk * 1.35 : currentPrice - risk * 1.35;
  const tp2 = trend === 'LONG' ? currentPrice + risk * 2.2 : currentPrice - risk * 2.2;
  const tp3 = trend === 'LONG' ? currentPrice + risk * 3.5 : currentPrice - risk * 3.5;
  const confidence = Math.min(95, 75 + Math.round((confluence - 70) * 0.8));

  return {
    side: trend === 'LONG' ? 'BUY' : 'SELL',
    entry: currentPrice,
    stopLoss,
    takeProfit,
    tp2,
    tp3,
    reason: `SNIPER_WR80_CONF${confluence}`,
    confidence,
    atr: currentAtr,
    strategy: 'EXPERT_CONFLUENCE_V335',
  };
}

/**
 * v33.5 rolling window and admission semantics.
 * Safety improvement: when TP and SL occur inside the same 1m candle, SL wins because
 * candle OHLC cannot prove that TP happened first. This avoids the optimistic bias in
 * the browser-era backtester while preserving all other v33.5 rules.
 */
export function runRollingBacktestV335(
  symbol: string,
  allCandles: Candle[],
  htfCandles?: Candle[],
): RollingBacktestResult {
  let wins = 0;
  let totalTrades = 0;
  let totalProfitPct = 0;
  let maxDrawdown = 0;
  let peakEquity = 100;
  let equity = 100;

  const length = allCandles.length;
  if (length < 60) {
    return { symbol, profitPct: 0, winRate: 0, drawdownPct: 0, score: 0, tradesEvaluated: 0, expectancyPct: 0, status: 'CALIBRATING' };
  }

  const lookback = Math.min(length - 52, 160);
  for (let i = length - 10; i > length - lookback; i -= 2) {
    const ltfSlice = allCandles.slice(0, i + 1);
    let htfSlice: Candle[];
    if (htfCandles && htfCandles.length >= 50) {
      const currentTime = allCandles[i].time;
      htfSlice = htfCandles.filter((c) => c.time <= currentTime);
      if (htfSlice.length < 50) htfSlice = ltfSlice;
    } else {
      htfSlice = ltfSlice;
    }

    const signal = analyzeStructureStrategyV335(ltfSlice, htfSlice, symbol);
    if (!signal) continue;

    totalTrades++;
    let pnlPct = 0;
    for (let j = i + 1; j < Math.min(i + 45, length); j++) {
      const next = allCandles[j];
      if (signal.side === 'BUY') {
        const hitTp = next.high >= signal.takeProfit;
        const hitSl = next.low <= signal.stopLoss;
        if (hitSl) {
          pnlPct = -Math.abs(signal.entry - signal.stopLoss) / signal.entry;
          break;
        }
        if (hitTp) {
          wins++;
          pnlPct = Math.abs(signal.takeProfit - signal.entry) / signal.entry;
          break;
        }
      } else {
        const hitTp = next.low <= signal.takeProfit;
        const hitSl = next.high >= signal.stopLoss;
        if (hitSl) {
          pnlPct = -Math.abs(signal.stopLoss - signal.entry) / signal.entry;
          break;
        }
        if (hitTp) {
          wins++;
          pnlPct = Math.abs(signal.entry - signal.takeProfit) / signal.entry;
          break;
        }
      }
    }

    equity += equity * pnlPct;
    peakEquity = Math.max(peakEquity, equity);
    maxDrawdown = Math.max(maxDrawdown, (peakEquity - equity) / peakEquity * 100);
    totalProfitPct += pnlPct * 100;
  }

  const winRate = totalTrades > 0 ? wins / totalTrades * 100 : 0;
  const score = totalTrades >= 3 ? winRate : winRate * 0.7;
  let status = 'BAJA_FIABILIDAD';
  if (winRate >= 80 && totalTrades >= 2) status = 'ALPHA_80%_CONFIRMED';
  else if (winRate >= 70 && totalTrades >= 2) status = 'PROBABLE_ALPHA';
  else if (totalTrades === 0) status = 'SIN_SEÑAL';

  return {
    symbol,
    profitPct: totalProfitPct,
    winRate,
    drawdownPct: maxDrawdown,
    score,
    tradesEvaluated: totalTrades,
    expectancyPct: totalTrades > 0 ? totalProfitPct / totalTrades : 0,
    status,
  };
}
