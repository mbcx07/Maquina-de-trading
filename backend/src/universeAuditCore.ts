import { analyzeStructureStrategyV335, runRollingBacktestV335 } from './analysisV335.js';
import type { Candle } from './analysis.js';
import type { TradeSide } from './types.js';

export interface AuditTrade {
  entryTime: number;
  exitTime: number;
  side: TradeSide;
  entry: number;
  exit: number;
  stopLoss: number;
  takeProfit: number;
  grossReturnPct: number;
  netReturnPct: number;
  reason: 'TP' | 'SL' | 'END';
  rollingWinRate: number;
  confidence: number;
}

export interface AuditMetrics {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  netReturnPct: number;
  grossProfitPct: number;
  grossLossPct: number;
  profitFactor: number | null;
  expectancyPct: number;
  maxDrawdownPct: number;
}

export interface SymbolAuditResult {
  symbol: string;
  qualified: boolean;
  reasons: string[];
  metrics: AuditMetrics;
  outOfSample: AuditMetrics;
  splitTime: number;
  trades: AuditTrade[];
}

export interface AuditRules {
  startTime: number;
  endTime: number;
  scanStepMinutes: number;
  roundTripCostPct: number;
  minRollingWinRate: number;
  minSignalConfidence: number;
  minTrades: number;
  minProfitFactor: number;
  minOosTrades: number;
}

export const defaultAuditRules = (startTime: number, endTime: number): AuditRules => ({
  startTime,
  endTime,
  scanStepMinutes: 5,
  roundTripCostPct: 0.12,
  minRollingWinRate: 75,
  minSignalConfidence: 75,
  minTrades: 5,
  minProfitFactor: 1.10,
  minOosTrades: 2,
});

export function auditV335Symbol(symbol: string, ltf: Candle[], htf: Candle[], rules: AuditRules): SymbolAuditResult {
  const l = [...ltf].sort((a, b) => a.time - b.time);
  const h = [...htf].sort((a, b) => a.time - b.time);
  const trades: AuditTrade[] = [];
  const step = Math.max(1, Math.round(rules.scanStepMinutes));
  let busyUntil = 0;

  for (let i = 99; i < l.length - 1; i += step) {
    const current = l[i];
    if (current.time < rules.startTime || current.time > rules.endTime) continue;
    if (current.time < busyUntil) continue;

    const htfEnd = upperBoundTime(h, current.time);
    if (htfEnd < 210) continue;

    // These are the exact live windows used by QuantumSniper v33.5.
    const ltfWindow = l.slice(i - 99, i + 1);
    const htfWindow = h.slice(htfEnd - 210, htfEnd);
    if (ltfWindow.length !== 100 || htfWindow.length !== 210) continue;

    const signal = analyzeStructureStrategyV335(ltfWindow, htfWindow, symbol);
    if (!signal) continue;

    const rolling = runRollingBacktestV335(symbol, ltfWindow, htfWindow);
    const passes = rolling.tradesEvaluated === 0
      ? signal.confidence >= Math.max(80, rules.minSignalConfidence)
      : rolling.winRate >= rules.minRollingWinRate && signal.confidence >= rules.minSignalConfidence;
    if (!passes) continue;

    const resolved = resolve(signal.side, signal.entry, signal.stopLoss, signal.takeProfit, l, i);
    if (!resolved) continue;
    busyUntil = resolved.exitTime;

    const grossReturnPct = directionalReturnPct(signal.side, signal.entry, resolved.exit);
    const netReturnPct = grossReturnPct - Math.max(0, rules.roundTripCostPct);
    trades.push({
      entryTime: current.time,
      exitTime: resolved.exitTime,
      side: signal.side,
      entry: signal.entry,
      exit: resolved.exit,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      grossReturnPct,
      netReturnPct,
      reason: resolved.reason,
      rollingWinRate: rolling.tradesEvaluated === 0 ? signal.confidence : rolling.winRate,
      confidence: signal.confidence,
    });
  }

  const splitTime = rules.startTime + (rules.endTime - rules.startTime) * 0.70;
  const metrics = metricsFor(trades);
  const outOfSample = metricsFor(trades.filter((trade) => trade.entryTime >= splitTime));
  const reasons: string[] = [];
  if (metrics.trades < rules.minTrades) reasons.push(`TRADES_LT_${rules.minTrades}`);
  if (!(metrics.netReturnPct > 0)) reasons.push('NET_RETURN_NOT_POSITIVE');
  if (!(metrics.expectancyPct > 0)) reasons.push('EXPECTANCY_NOT_POSITIVE');
  if ((metrics.profitFactor ?? 0) < rules.minProfitFactor) reasons.push(`PF_LT_${rules.minProfitFactor}`);
  if (outOfSample.trades < rules.minOosTrades) reasons.push(`OOS_TRADES_LT_${rules.minOosTrades}`);
  if (!(outOfSample.netReturnPct >= 0)) reasons.push('OOS_NET_NEGATIVE');
  if (outOfSample.trades > 0 && (outOfSample.profitFactor ?? 0) < 1) reasons.push('OOS_PF_LT_1');

  return { symbol, qualified: reasons.length === 0, reasons, metrics, outOfSample, splitTime, trades };
}

function resolve(
  side: TradeSide,
  entry: number,
  stopLoss: number,
  takeProfit: number,
  candles: Candle[],
  entryIndex: number,
): { exit: number; exitTime: number; reason: 'TP' | 'SL' | 'END' } | null {
  for (let i = entryIndex + 1; i < candles.length; i++) {
    const candle = candles[i];
    if (side === 'BUY') {
      const sl = candle.low <= stopLoss;
      const tp = candle.high >= takeProfit;
      if (sl) return { exit: stopLoss, exitTime: candle.time, reason: 'SL' };
      if (tp) return { exit: takeProfit, exitTime: candle.time, reason: 'TP' };
    } else {
      const sl = candle.high >= stopLoss;
      const tp = candle.low <= takeProfit;
      if (sl) return { exit: stopLoss, exitTime: candle.time, reason: 'SL' };
      if (tp) return { exit: takeProfit, exitTime: candle.time, reason: 'TP' };
    }
  }
  const last = candles.at(-1);
  return last ? { exit: last.close, exitTime: last.time, reason: 'END' } : null;
}

function metricsFor(trades: AuditTrade[]): AuditMetrics {
  const wins = trades.filter((t) => t.netReturnPct > 0);
  const losses = trades.filter((t) => t.netReturnPct < 0);
  const grossProfitPct = wins.reduce((sum, t) => sum + t.netReturnPct, 0);
  const grossLossAbs = Math.abs(losses.reduce((sum, t) => sum + t.netReturnPct, 0));
  let equity = 100;
  let peak = equity;
  let maxDrawdownPct = 0;
  for (const trade of trades) {
    equity *= 1 + trade.netReturnPct / 100;
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, peak > 0 ? (peak - equity) / peak * 100 : 0);
  }
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? wins.length / trades.length * 100 : 0,
    netReturnPct: equity - 100,
    grossProfitPct,
    grossLossPct: -grossLossAbs,
    profitFactor: grossLossAbs > 0 ? grossProfitPct / grossLossAbs : grossProfitPct > 0 ? null : 0,
    expectancyPct: trades.length ? trades.reduce((sum, t) => sum + t.netReturnPct, 0) / trades.length : 0,
    maxDrawdownPct,
  };
}

function directionalReturnPct(side: TradeSide, entry: number, exit: number): number {
  return side === 'BUY' ? (exit - entry) / entry * 100 : (entry - exit) / entry * 100;
}

function upperBoundTime(candles: Candle[], time: number): number {
  let low = 0;
  let high = candles.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (candles[mid].time <= time) low = mid + 1;
    else high = mid;
  }
  return low;
}
