import type { Candle, AnalysisSignal, RollingBacktestResult } from './analysis.js';
import { analyzeHighWinrateM5M15 } from './strategyModelR10.js';

const ENTRY_TIMEFRAME_MINUTES = 5;
const ROLLING_HOLD_MINUTES = 45;
const ROLLING_MAX_HOLD_BARS = Math.max(1, Math.ceil(ROLLING_HOLD_MINUTES / ENTRY_TIMEFRAME_MINUTES));
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

/**
 * Compatibility export used by scanners/audits. R10 restores the supplied
 * high-winrate Sweep/Reclaim/MSS idea, adapted to M5 entry + M15 bias only.
 */
export function analyzeStructureStrategyV335(
  ltfCandles: Candle[],
  htfCandles: Candle[],
  symbol: string,
): AnalysisSignal | null {
  void symbol;
  return analyzeHighWinrateM5M15(ltfCandles, htfCandles);
}

/**
 * Sequential rolling evaluation that mirrors live execution.
 * Positive terminal PnL at the 45-minute horizon counts as a win; the old R9
 * evaluator incorrectly counted all non-TP outcomes as non-wins, depressing WR.
 */
export function runRollingBacktestV335(
  symbol: string,
  allCandles: Candle[],
  htfCandles?: Candle[],
): RollingBacktestResult {
  const candles = [...allCandles].sort((a, b) => a.time - b.time);
  const htf = htfCandles ? [...htfCandles].sort((a, b) => a.time - b.time) : [];
  const length = candles.length;
  if (length < 90) {
    return { symbol, profitPct: 0, winRate: 0, drawdownPct: 0, score: 0, tradesEvaluated: 0, expectancyPct: 0, status: 'CALIBRATING' };
  }

  let wins = 0;
  let losses = 0;
  let totalTrades = 0;
  let totalProfitPct = 0;
  let maxDrawdown = 0;
  let peakEquity = 100;
  let equity = 100;

  let i = Math.max(80, length - 260);
  while (i < length - 1) {
    const currentTime = candles[i].time;
    const ltfSlice = candles.slice(Math.max(0, i - 179), i + 1);
    const htfSlice = htf.length ? htf.filter((c) => c.time <= currentTime).slice(-180) : [];
    if (htf.length && htfSlice.length < 60) { i++; continue; }

    const signal = analyzeStructureStrategyV335(ltfSlice, htfSlice.length ? htfSlice : ltfSlice, symbol);
    if (!signal) { i++; continue; }

    totalTrades++;
    const lastIndex = Math.min(length - 1, i + ROLLING_MAX_HOLD_BARS);
    let exitIndex = lastIndex;
    let exitPrice = candles[lastIndex].close;

    for (let j = i + 1; j <= lastIndex; j++) {
      const next = candles[j];
      if (signal.side === 'BUY') {
        const hitSl = next.low <= signal.stopLoss;
        const hitTp = next.high >= signal.takeProfit;
        if (hitSl) { exitIndex = j; exitPrice = signal.stopLoss; break; }
        if (hitTp) { exitIndex = j; exitPrice = signal.takeProfit; break; }
      } else {
        const hitSl = next.high >= signal.stopLoss;
        const hitTp = next.low <= signal.takeProfit;
        if (hitSl) { exitIndex = j; exitPrice = signal.stopLoss; break; }
        if (hitTp) { exitIndex = j; exitPrice = signal.takeProfit; break; }
      }
    }

    const rawReturn = signal.side === 'BUY'
      ? (exitPrice - signal.entry) / signal.entry
      : (signal.entry - exitPrice) / signal.entry;
    const pnlPct = rawReturn * 100;
    if (pnlPct > 0) wins++;
    else losses++;

    totalProfitPct += pnlPct;
    equity *= 1 + rawReturn;
    peakEquity = Math.max(peakEquity, equity);
    maxDrawdown = Math.max(maxDrawdown, peakEquity > 0 ? (peakEquity - equity) / peakEquity * 100 : 0);
    i = Math.max(i + 1, exitIndex + 1);
  }

  const winRate = totalTrades > 0 ? wins / totalTrades * 100 : 0;
  const expectancyPct = totalTrades > 0 ? totalProfitPct / totalTrades : 0;
  const score = totalTrades >= 3
    ? clamp(winRate + expectancyPct * 4 - maxDrawdown * 0.25, 0, 100)
    : winRate * 0.70;

  let status = 'BAJA_FIABILIDAD';
  if (winRate >= 80 && totalTrades >= 4) status = 'ALPHA_80%_CONFIRMED';
  else if (winRate >= 64 && totalTrades >= 3 && expectancyPct > 0) status = 'HIGH_WR_OOS_RANGE';
  else if (totalTrades === 0) status = 'SIN_SEÑAL';

  return {
    symbol,
    profitPct: totalProfitPct,
    winRate,
    drawdownPct: maxDrawdown,
    score,
    tradesEvaluated: totalTrades,
    expectancyPct,
    status: `${status}:W${wins}:L${losses}`,
  };
}
