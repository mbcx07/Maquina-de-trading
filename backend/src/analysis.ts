export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface AnalysisSignal {
  side: 'BUY' | 'SELL';
  entry: number;
  stopLoss: number;
  takeProfit: number;
  tp2: number;
  tp3: number;
  reason: string;
  confidence: number;
  atr: number;
  strategy: string;
}

export interface RollingBacktestResult {
  symbol: string;
  profitPct: number;
  winRate: number;
  drawdownPct: number;
  score: number;
  tradesEvaluated: number;
  expectancyPct: number;
  status: string;
}

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

const atr = (candles: Candle[], period = 14): number => {
  if (candles.length < 2) return 0;
  const start = Math.max(1, candles.length - period);
  const values: number[] = [];
  for (let i = start; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];
    values.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close),
    ));
  }
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
};

const swings = (candles: Candle[], lookback = 15): { high: number; low: number } => {
  const from = Math.max(2, candles.length - lookback);
  let high = candles[Math.max(0, candles.length - 2)]?.high ?? candles.at(-1)?.high ?? 0;
  let low = candles[Math.max(0, candles.length - 2)]?.low ?? candles.at(-1)?.low ?? 0;

  for (let i = candles.length - 3; i >= from; i--) {
    if (
      candles[i].high > candles[i - 1].high &&
      candles[i].high > candles[i - 2].high &&
      candles[i].high > candles[i + 1].high &&
      candles[i].high > candles[i + 2].high
    ) {
      high = candles[i].high;
      break;
    }
  }

  for (let i = candles.length - 3; i >= from; i--) {
    if (
      candles[i].low < candles[i - 1].low &&
      candles[i].low < candles[i - 2].low &&
      candles[i].low < candles[i + 1].low &&
      candles[i].low < candles[i + 2].low
    ) {
      low = candles[i].low;
      break;
    }
  }

  return { high, low };
};

export function analyzeStructureStrategy(
  ltfCandles: Candle[],
  htfCandles: Candle[],
  symbol: string,
): AnalysisSignal | null {
  if (ltfCandles.length < 60 || htfCandles.length < 200) return null;

  const currentPrice = ltfCandles.at(-1)?.close ?? 0;
  if (currentPrice <= 0) return null;

  const htfCloses = htfCandles.map((candle) => candle.close);
  const ema20Htf = ema(htfCloses, 20);
  const ema50Htf = ema(htfCloses, 50);
  const ema200Htf = ema(htfCloses, 200);
  const previousEma50Htf = ema(htfCloses.slice(0, -5), 50);

  const uptrend = ema20Htf > ema50Htf && ema50Htf > ema200Htf && ema50Htf > previousEma50Htf;
  const downtrend = ema20Htf < ema50Htf && ema50Htf < ema200Htf && ema50Htf < previousEma50Htf;
  if (!uptrend && !downtrend) return null;
  const trend: 'LONG' | 'SHORT' = uptrend ? 'LONG' : 'SHORT';

  // Anti-chop: if the EMA20/EMA50 relationship changed repeatedly near the end, reject the setup.
  let previousRelation: number | null = null;
  let relationChanges = 0;
  for (let offset = 12; offset >= 1; offset--) {
    const slice = htfCloses.slice(0, -offset);
    if (slice.length < 55) continue;
    const relation = ema(slice, 20) >= ema(slice, 50) ? 1 : -1;
    if (previousRelation != null && relation !== previousRelation) relationChanges++;
    previousRelation = relation;
  }
  if (relationChanges >= 2) return null;

  const ltfCloses = ltfCandles.map((candle) => candle.close);
  const ema9Ltf = ema(ltfCloses, 9);
  const ema21Ltf = ema(ltfCloses, 21);
  const ema50Ltf = ema(ltfCloses, 50);
  const currentAtr = atr(ltfCandles, 14);
  const currentRsi = rsi(ltfCloses, 14);
  const previousRsi = rsi(ltfCloses.slice(0, -1), 14);

  if (currentAtr <= 0 || currentAtr / currentPrice < 0.0006) return null;
  if (trend === 'LONG' && (currentRsi < 36 || currentRsi > 58 || currentRsi <= previousRsi)) return null;
  if (trend === 'SHORT' && (currentRsi > 64 || currentRsi < 42 || currentRsi >= previousRsi)) return null;

  const inPullback = trend === 'LONG'
    ? currentPrice <= ema21Ltf + currentAtr * 0.8 && currentPrice >= ema50Ltf - currentAtr * 0.5
    : currentPrice >= ema21Ltf - currentAtr * 0.8 && currentPrice <= ema50Ltf + currentAtr * 0.5;
  if (!inPullback) return null;

  const last = ltfCandles.at(-1)!;
  const previous = ltfCandles.at(-2)!;
  const volumeAverage = sma(ltfCandles.map((candle) => candle.volume), 20);
  const structure = swings(ltfCandles, 15);
  let confluence = 0;

  const bullishEngulfing = last.close > previous.open && last.close > previous.close && last.open <= previous.close;
  const hammer = Math.min(last.open, last.close) - last.low > Math.max(Math.abs(last.close - last.open), currentAtr * 0.05) * 1.6;
  const bearishEngulfing = last.close < previous.open && last.close < previous.close && last.open >= previous.close;
  const shootingStar = last.high - Math.max(last.open, last.close) > Math.max(Math.abs(last.close - last.open), currentAtr * 0.05) * 1.6;

  if (trend === 'LONG' && (bullishEngulfing || hammer || last.close > previous.high)) confluence += 25;
  if (trend === 'SHORT' && (bearishEngulfing || shootingStar || last.close < previous.low)) confluence += 25;

  if (last.volume >= volumeAverage * 1.3 || last.volume > previous.volume * 1.25) confluence += 20;
  if (trend === 'LONG' && currentPrice > structure.low && last.low > structure.low) confluence += 20;
  if (trend === 'SHORT' && currentPrice < structure.high && last.high < structure.high) confluence += 20;
  if (trend === 'LONG' && ema9Ltf >= ema21Ltf && last.close > ema9Ltf) confluence += 20;
  if (trend === 'SHORT' && ema9Ltf <= ema21Ltf && last.close < ema9Ltf) confluence += 20;
  if (trend === 'LONG' && currentRsi - previousRsi > 1.5) confluence += 15;
  if (trend === 'SHORT' && previousRsi - currentRsi > 1.5) confluence += 15;

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
    reason: `STRUCTURE_PULLBACK_CONF_${confluence}`,
    confidence,
    atr: currentAtr,
    strategy: 'EXPERT_CONFLUENCE_V34',
  };
}

export function runRollingBacktest(
  symbol: string,
  allCandles: Candle[],
  htfCandles: Candle[],
): RollingBacktestResult {
  if (allCandles.length < 80 || htfCandles.length < 200) {
    return {
      symbol,
      profitPct: 0,
      winRate: 0,
      drawdownPct: 0,
      score: 0,
      tradesEvaluated: 0,
      expectancyPct: 0,
      status: 'CALIBRATING',
    };
  }

  let wins = 0;
  let totalTrades = 0;
  let totalProfitPct = 0;
  let maxDrawdown = 0;
  let peakEquity = 100;
  let equity = 100;
  const lookback = Math.min(allCandles.length - 65, 180);

  for (let i = allCandles.length - 10; i > allCandles.length - lookback; i -= 3) {
    const ltfSlice = allCandles.slice(0, i + 1);
    const currentTime = allCandles[i].time;
    const htfSlice = htfCandles.filter((candle) => candle.time <= currentTime);
    if (htfSlice.length < 200) continue;

    const signal = analyzeStructureStrategy(ltfSlice, htfSlice, symbol);
    if (!signal) continue;

    totalTrades++;
    let pnlPct = 0;
    let resolved = false;

    for (let j = i + 1; j < Math.min(i + 45, allCandles.length); j++) {
      const candle = allCandles[j];
      if (signal.side === 'BUY') {
        const hitTp = candle.high >= signal.takeProfit;
        const hitSl = candle.low <= signal.stopLoss;
        // Conservative when both are touched in the same candle: count SL first.
        if (hitSl) {
          pnlPct = -Math.abs(signal.entry - signal.stopLoss) / signal.entry;
          resolved = true;
          break;
        }
        if (hitTp) {
          wins++;
          pnlPct = Math.abs(signal.takeProfit - signal.entry) / signal.entry;
          resolved = true;
          break;
        }
      } else {
        const hitTp = candle.low <= signal.takeProfit;
        const hitSl = candle.high >= signal.stopLoss;
        if (hitSl) {
          pnlPct = -Math.abs(signal.stopLoss - signal.entry) / signal.entry;
          resolved = true;
          break;
        }
        if (hitTp) {
          wins++;
          pnlPct = Math.abs(signal.entry - signal.takeProfit) / signal.entry;
          resolved = true;
          break;
        }
      }
    }

    if (!resolved) continue;
    equity += equity * pnlPct;
    peakEquity = Math.max(peakEquity, equity);
    maxDrawdown = Math.max(maxDrawdown, ((peakEquity - equity) / peakEquity) * 100);
    totalProfitPct += pnlPct * 100;
  }

  const winRate = totalTrades > 0 ? wins / totalTrades * 100 : 0;
  const reliability = Math.min(1, totalTrades / 8);
  const score = winRate * reliability;

  return {
    symbol,
    profitPct: totalProfitPct,
    winRate,
    drawdownPct: maxDrawdown,
    score,
    tradesEvaluated: totalTrades,
    expectancyPct: totalTrades ? totalProfitPct / totalTrades : 0,
    status: totalTrades === 0 ? 'SIN_SEÑAL' : winRate >= 80 && totalTrades >= 3 ? 'ALPHA_CONFIRMED' : winRate >= 70 ? 'PROBABLE_ALPHA' : 'LOW_CONFIDENCE',
  };
}

export function opportunityScore(
  signal: AnalysisSignal,
  backtest: RollingBacktestResult,
  liquidityScore = 50,
): number {
  const validatedWr = backtest.tradesEvaluated >= 3 ? backtest.winRate : signal.confidence * 0.75;
  const reliability = Math.min(100, backtest.tradesEvaluated * 12.5);
  const expectancyScore = Math.max(0, Math.min(100, 50 + backtest.expectancyPct * 100));
  const drawdownScore = Math.max(0, 100 - backtest.drawdownPct * 5);

  return (
    signal.confidence * 0.35 +
    validatedWr * 0.30 +
    reliability * 0.10 +
    expectancyScore * 0.10 +
    drawdownScore * 0.05 +
    Math.max(0, Math.min(100, liquidityScore)) * 0.10
  );
}
