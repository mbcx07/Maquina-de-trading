import crypto from 'node:crypto';
import { analyzeStructureStrategy, type Candle } from './analysis.js';
import { BinanceMarketDataClient } from './binanceMarket.js';
import { TradingDatabase } from './database.js';
import { Mt5BridgeClient } from './mt5.js';
import type { Broker, EngineSettings, TradeSide } from './types.js';

export interface HistoricalBacktestRequest {
  broker: Broker;
  symbols: string[];
  startTime: number;
  endTime: number;
  initialBalance: number;
  allocationPct: number;
  leverage: number;
  roundTripCostPct: number;
  scanStepMinutes: number;
  maxHoldMinutes: number;
  sizingMode: 'MARGIN_PERCENT' | 'RISK_TO_SL';
}

export interface HistoricalCandidate {
  id: string;
  broker: Broker;
  symbol: string;
  side: TradeSide;
  strategy: string;
  confidence: number;
  entryTime: number;
  exitTime: number;
  entry: number;
  exit: number;
  stopLoss: number;
  takeProfit: number;
  grossPriceReturnPct: number;
  outcome: 'WIN' | 'LOSS' | 'TIMEOUT';
  exitReason: 'TP' | 'SL' | 'TIMEOUT';
}

export interface HistoricalExecutedTrade extends HistoricalCandidate {
  equityAtEntry: number;
  marginOrRiskCapital: number;
  notional: number;
  grossPnl: number;
  costs: number;
  netPnl: number;
  equityAfterExit: number;
}

export interface HistoricalMetrics {
  trades: number;
  wins: number;
  losses: number;
  timeouts: number;
  winRate: number;
  netProfit: number;
  returnPct: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number | null;
  expectancy: number;
  averageWin: number;
  averageLoss: number;
  maxDrawdownPct: number;
  costs: number;
}

export interface HistoricalBacktestResult {
  runId: string;
  broker: Broker;
  request: HistoricalBacktestRequest;
  startedAt: number;
  completedAt: number;
  candidates: number;
  executedTrades: HistoricalExecutedTrade[];
  skipped: {
    slots: number;
    duplicateCryptoSymbol: number;
    forexSymbolLimit: number;
  };
  metrics: HistoricalMetrics;
  inSample: HistoricalMetrics;
  outOfSample: HistoricalMetrics;
  splitTime: number;
  equityCurve: Array<{ time: number; equity: number; drawdownPct: number }>;
  bySymbol: Array<{ symbol: string; metrics: HistoricalMetrics }>;
}

export class HistoricalBacktestService {
  constructor(
    private readonly database: TradingDatabase,
    private readonly binanceMarket: BinanceMarketDataClient,
    private readonly mt5: Mt5BridgeClient,
    private readonly getSettings: () => EngineSettings,
  ) {
    this.ensureSchema();
    this.markInterruptedRuns();
  }

  create(request: HistoricalBacktestRequest): string {
    validateRequest(request);
    const id = `BT-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const now = Date.now();
    this.database.db.prepare(`
      INSERT INTO backtest_runs(id, broker, status, request_json, progress_json, created_at, updated_at)
      VALUES(?, ?, 'QUEUED', ?, ?, ?, ?)
    `).run(id, request.broker, JSON.stringify(request), JSON.stringify({ stage: 'QUEUED', completed: 0, total: request.symbols.length }), now, now);

    void this.execute(id, request).catch((error) => {
      this.fail(id, error instanceof Error ? error.message : String(error));
    });
    return id;
  }

  get(id: string): Record<string, unknown> | null {
    const row = this.database.db.prepare(`SELECT * FROM backtest_runs WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? mapRun(row) : null;
  }

  list(limit = 20): Record<string, unknown>[] {
    const rows = this.database.db.prepare(`
      SELECT * FROM backtest_runs ORDER BY created_at DESC LIMIT ?
    `).all(Math.max(1, Math.min(100, limit))) as Record<string, unknown>[];
    return rows.map(mapRun);
  }

  private async execute(id: string, request: HistoricalBacktestRequest): Promise<void> {
    const startedAt = Date.now();
    this.updateRun(id, 'RUNNING', { stage: 'LOADING_HISTORY', completed: 0, total: request.symbols.length }, startedAt);

    const candidates: HistoricalCandidate[] = [];
    for (let index = 0; index < request.symbols.length; index++) {
      const symbol = request.symbols[index].trim();
      this.updateRun(id, 'RUNNING', {
        stage: 'ANALYZING_SYMBOLS',
        symbol,
        completed: index,
        total: request.symbols.length,
        candidates: candidates.length,
      });

      const { ltf, htf } = request.broker === 'BINANCE'
        ? await this.binanceMarket.getDualHistoricalRange(symbol, request.startTime, request.endTime)
        : await this.mt5.dualHistoricalRange(symbol, request.startTime, request.endTime);

      candidates.push(...generateCandidates(request, symbol, ltf, htf));
      this.updateRun(id, 'RUNNING', {
        stage: 'ANALYZING_SYMBOLS',
        symbol,
        completed: index + 1,
        total: request.symbols.length,
        candidates: candidates.length,
      });
    }

    this.updateRun(id, 'RUNNING', { stage: 'PORTFOLIO_SIMULATION', completed: request.symbols.length, total: request.symbols.length, candidates: candidates.length });
    const result = simulatePortfolio(id, request, candidates, this.getSettings());
    const completedAt = Date.now();
    result.startedAt = startedAt;
    result.completedAt = completedAt;

    this.database.db.prepare(`
      UPDATE backtest_runs
      SET status='COMPLETED', result_json=?, progress_json=?, started_at=?, completed_at=?, updated_at=?
      WHERE id=?
    `).run(
      JSON.stringify(result),
      JSON.stringify({ stage: 'COMPLETED', completed: request.symbols.length, total: request.symbols.length, candidates: candidates.length, trades: result.executedTrades.length }),
      startedAt,
      completedAt,
      completedAt,
      id,
    );
  }

  private updateRun(id: string, status: string, progress: Record<string, unknown>, startedAt?: number): void {
    this.database.db.prepare(`
      UPDATE backtest_runs
      SET status=?, progress_json=?, started_at=COALESCE(started_at, ?), updated_at=?
      WHERE id=?
    `).run(status, JSON.stringify(progress), startedAt ?? null, Date.now(), id);
  }

  private fail(id: string, error: string): void {
    this.database.db.prepare(`
      UPDATE backtest_runs
      SET status='FAILED', error=?, completed_at=?, updated_at=?
      WHERE id=?
    `).run(error.slice(0, 4000), Date.now(), Date.now(), id);
  }

  private ensureSchema(): void {
    this.database.db.exec(`
      CREATE TABLE IF NOT EXISTS backtest_runs (
        id TEXT PRIMARY KEY,
        broker TEXT NOT NULL CHECK (broker IN ('BINANCE','MT5')),
        status TEXT NOT NULL,
        request_json TEXT NOT NULL,
        progress_json TEXT,
        result_json TEXT,
        error TEXT,
        started_at INTEGER,
        completed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_backtest_runs_created ON backtest_runs(created_at DESC);
    `);
  }

  private markInterruptedRuns(): void {
    this.database.db.prepare(`
      UPDATE backtest_runs SET status='INTERRUPTED', error='Backend restarted during backtest', updated_at=?
      WHERE status IN ('QUEUED','RUNNING')
    `).run(Date.now());
  }
}

function generateCandidates(
  request: HistoricalBacktestRequest,
  symbol: string,
  ltf: Candle[],
  htf: Candle[],
): HistoricalCandidate[] {
  const sortedLtf = [...ltf].sort((a, b) => a.time - b.time);
  const sortedHtf = [...htf].sort((a, b) => a.time - b.time);
  const output: HistoricalCandidate[] = [];
  const stepBars = Math.max(1, Math.round(request.scanStepMinutes));
  const maxHoldBars = Math.max(1, Math.round(request.maxHoldMinutes));
  let zoneActive = false;
  let cryptoBusyUntil = 0;

  for (let i = 60; i < sortedLtf.length - 2; i += stepBars) {
    const current = sortedLtf[i];
    if (current.time < request.startTime || current.time > request.endTime) continue;
    if (request.broker === 'BINANCE' && current.time < cryptoBusyUntil) continue;

    const htfEnd = upperBoundTime(sortedHtf, current.time);
    if (htfEnd < 200) continue;
    const ltfWindow = sortedLtf.slice(Math.max(0, i - 259), i + 1);
    const htfWindow = sortedHtf.slice(Math.max(0, htfEnd - 260), htfEnd);
    const signal = analyzeStructureStrategy(ltfWindow, htfWindow, symbol);

    if (!signal) {
      zoneActive = false;
      continue;
    }

    if (request.broker === 'MT5' && zoneActive) continue;
    zoneActive = true;

    const resolved = resolveSignal(signal.side, signal.entry, signal.stopLoss, signal.takeProfit, sortedLtf, i, maxHoldBars);
    if (!resolved) continue;
    if (request.broker === 'BINANCE') cryptoBusyUntil = resolved.exitTime;

    output.push({
      id: `${request.broker}-${symbol}-${current.time}-${signal.side}`,
      broker: request.broker,
      symbol,
      side: signal.side,
      strategy: signal.strategy,
      confidence: signal.confidence,
      entryTime: current.time,
      exitTime: resolved.exitTime,
      entry: signal.entry,
      exit: resolved.exit,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      grossPriceReturnPct: directionalReturnPct(signal.side, signal.entry, resolved.exit),
      outcome: resolved.reason === 'TP' ? 'WIN' : resolved.reason === 'SL' ? 'LOSS' : resolved.exit === signal.entry ? 'TIMEOUT' : directionalReturnPct(signal.side, signal.entry, resolved.exit) >= 0 ? 'WIN' : 'LOSS',
      exitReason: resolved.reason,
    });
  }

  return output;
}

function resolveSignal(
  side: TradeSide,
  entry: number,
  stopLoss: number,
  takeProfit: number,
  candles: Candle[],
  entryIndex: number,
  maxHoldBars: number,
): { exit: number; exitTime: number; reason: 'TP' | 'SL' | 'TIMEOUT' } | null {
  const lastIndex = Math.min(candles.length - 1, entryIndex + maxHoldBars);
  for (let i = entryIndex + 1; i <= lastIndex; i++) {
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
  const final = candles[lastIndex];
  if (!final) return null;
  return { exit: final.close, exitTime: final.time, reason: 'TIMEOUT' };
}

function simulatePortfolio(
  runId: string,
  request: HistoricalBacktestRequest,
  candidates: HistoricalCandidate[],
  settings: EngineSettings,
): HistoricalBacktestResult {
  const ordered = [...candidates].sort((a, b) => a.entryTime - b.entryTime || b.confidence - a.confidence);
  let equity = request.initialBalance;
  let peak = equity;
  const executed: HistoricalExecutedTrade[] = [];
  const curve: Array<{ time: number; equity: number; drawdownPct: number }> = [{ time: request.startTime, equity, drawdownPct: 0 }];
  const active: Array<{ candidate: HistoricalCandidate; trade: HistoricalExecutedTrade }> = [];
  const skipped = { slots: 0, duplicateCryptoSymbol: 0, forexSymbolLimit: 0 };

  const settleUntil = (time: number) => {
    const due = active.filter((item) => item.candidate.exitTime <= time).sort((a, b) => a.candidate.exitTime - b.candidate.exitTime);
    for (const item of due) {
      equity += item.trade.netPnl;
      item.trade.equityAfterExit = equity;
      peak = Math.max(peak, equity);
      const dd = peak > 0 ? Math.max(0, (peak - equity) / peak * 100) : 0;
      curve.push({ time: item.candidate.exitTime, equity, drawdownPct: dd });
      const idx = active.indexOf(item);
      if (idx >= 0) active.splice(idx, 1);
    }
  };

  for (const candidate of ordered) {
    settleUntil(candidate.entryTime);
    const maxSlots = candidate.broker === 'BINANCE'
      ? Math.min(10, settings.maxConcurrentCryptoTrades)
      : settings.maxConcurrentForexTrades;
    if (active.length >= maxSlots) {
      skipped.slots++;
      continue;
    }

    if (candidate.broker === 'BINANCE' && active.some((item) => item.candidate.symbol === candidate.symbol)) {
      skipped.duplicateCryptoSymbol++;
      continue;
    }

    if (candidate.broker === 'MT5' && settings.forexMaxEntriesPerSymbol > 0) {
      const same = active.filter((item) => item.candidate.symbol === candidate.symbol).length;
      if (same >= settings.forexMaxEntriesPerSymbol) {
        skipped.forexSymbolLimit++;
        continue;
      }
    }

    const capital = Math.max(0, equity * request.allocationPct / 100);
    if (capital <= 0) break;
    const riskDistance = Math.max(Math.abs(candidate.entry - candidate.stopLoss) / candidate.entry, 1e-9);
    const notional = request.sizingMode === 'RISK_TO_SL'
      ? capital / riskDistance
      : capital * Math.max(1, request.leverage);
    const grossPnl = notional * candidate.grossPriceReturnPct / 100;
    const costs = notional * Math.max(0, request.roundTripCostPct) / 100;
    const netPnl = grossPnl - costs;

    const trade: HistoricalExecutedTrade = {
      ...candidate,
      equityAtEntry: equity,
      marginOrRiskCapital: capital,
      notional,
      grossPnl,
      costs,
      netPnl,
      equityAfterExit: equity,
    };
    active.push({ candidate, trade });
    executed.push(trade);
  }

  settleUntil(Number.MAX_SAFE_INTEGER);
  const splitTime = request.startTime + (request.endTime - request.startTime) * 0.70;
  const metrics = calculateHistoricalMetrics(executed, request.initialBalance, curve);
  const inSampleTrades = executed.filter((trade) => trade.entryTime < splitTime);
  const outSampleTrades = executed.filter((trade) => trade.entryTime >= splitTime);
  const inSample = calculateHistoricalMetrics(inSampleTrades, request.initialBalance);
  const oosStart = inSampleTrades.length ? inSampleTrades.at(-1)!.equityAfterExit : request.initialBalance;
  const outOfSample = calculateHistoricalMetrics(outSampleTrades, oosStart);
  const bySymbol = [...new Set(executed.map((trade) => trade.symbol))]
    .map((symbol) => ({ symbol, metrics: calculateHistoricalMetrics(executed.filter((trade) => trade.symbol === symbol), request.initialBalance) }))
    .sort((a, b) => b.metrics.netProfit - a.metrics.netProfit);

  return {
    runId,
    broker: request.broker,
    request,
    startedAt: 0,
    completedAt: 0,
    candidates: candidates.length,
    executedTrades: executed,
    skipped,
    metrics,
    inSample,
    outOfSample,
    splitTime,
    equityCurve: downsampleCurve(curve, 400),
    bySymbol,
  };
}

function calculateHistoricalMetrics(
  trades: HistoricalExecutedTrade[],
  initialBalance: number,
  suppliedCurve?: Array<{ time: number; equity: number; drawdownPct: number }>,
): HistoricalMetrics {
  const wins = trades.filter((trade) => trade.netPnl > 0);
  const losses = trades.filter((trade) => trade.netPnl < 0);
  const timeouts = trades.filter((trade) => trade.exitReason === 'TIMEOUT').length;
  const grossProfit = wins.reduce((sum, trade) => sum + trade.netPnl, 0);
  const grossLossAbs = Math.abs(losses.reduce((sum, trade) => sum + trade.netPnl, 0));
  const netProfit = trades.reduce((sum, trade) => sum + trade.netPnl, 0);
  const costs = trades.reduce((sum, trade) => sum + trade.costs, 0);
  const maxDrawdownPct = suppliedCurve?.length
    ? Math.max(...suppliedCurve.map((point) => point.drawdownPct))
    : estimateTradeDrawdown(trades, initialBalance);

  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    timeouts,
    winRate: trades.length ? wins.length / trades.length * 100 : 0,
    netProfit,
    returnPct: initialBalance > 0 ? netProfit / initialBalance * 100 : 0,
    grossProfit,
    grossLoss: grossLossAbs,
    profitFactor: grossLossAbs > 0 ? grossProfit / grossLossAbs : grossProfit > 0 ? null : 0,
    expectancy: trades.length ? netProfit / trades.length : 0,
    averageWin: wins.length ? grossProfit / wins.length : 0,
    averageLoss: losses.length ? grossLossAbs / losses.length : 0,
    maxDrawdownPct,
    costs,
  };
}

function estimateTradeDrawdown(trades: HistoricalExecutedTrade[], initialBalance: number): number {
  let equity = initialBalance;
  let peak = equity;
  let maxDd = 0;
  for (const trade of [...trades].sort((a, b) => a.exitTime - b.exitTime)) {
    equity += trade.netPnl;
    peak = Math.max(peak, equity);
    if (peak > 0) maxDd = Math.max(maxDd, (peak - equity) / peak * 100);
  }
  return maxDd;
}

function directionalReturnPct(side: TradeSide, entry: number, exit: number): number {
  const raw = (exit - entry) / entry * 100;
  return side === 'BUY' ? raw : -raw;
}

function upperBoundTime(candles: Candle[], time: number): number {
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (candles[mid].time <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function downsampleCurve(
  curve: Array<{ time: number; equity: number; drawdownPct: number }>,
  maxPoints: number,
): Array<{ time: number; equity: number; drawdownPct: number }> {
  if (curve.length <= maxPoints) return curve;
  const step = (curve.length - 1) / (maxPoints - 1);
  const out = [];
  for (let i = 0; i < maxPoints; i++) out.push(curve[Math.round(i * step)]);
  return out;
}

function validateRequest(request: HistoricalBacktestRequest): void {
  if (!['BINANCE', 'MT5'].includes(request.broker)) throw new Error('BACKTEST_BROKER_INVALID');
  request.symbols = [...new Set(request.symbols.map((symbol) => symbol.trim()).filter(Boolean))];
  if (!request.symbols.length || request.symbols.length > 25) throw new Error('BACKTEST_SYMBOL_COUNT_1_TO_25');
  if (!(request.initialBalance > 0)) throw new Error('BACKTEST_INITIAL_BALANCE_INVALID');
  if (!(request.allocationPct > 0 && request.allocationPct <= 100)) throw new Error('BACKTEST_ALLOCATION_PCT_INVALID');
  if (!(request.leverage >= 1 && request.leverage <= 125)) throw new Error('BACKTEST_LEVERAGE_INVALID');
  if (!(request.roundTripCostPct >= 0 && request.roundTripCostPct <= 10)) throw new Error('BACKTEST_COST_INVALID');
  if (!(request.scanStepMinutes >= 1 && request.scanStepMinutes <= 60)) throw new Error('BACKTEST_SCAN_STEP_INVALID');
  if (!(request.maxHoldMinutes >= 1 && request.maxHoldMinutes <= 1440)) throw new Error('BACKTEST_MAX_HOLD_INVALID');
  if (request.endTime <= request.startTime) throw new Error('BACKTEST_RANGE_INVALID');
  if (request.endTime - request.startTime > 31 * 24 * 60 * 60 * 1000) throw new Error('BACKTEST_MAX_RANGE_31_DAYS');
}

function mapRun(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(row.id),
    broker: String(row.broker),
    status: String(row.status),
    request: parseJson(row.request_json),
    progress: parseJson(row.progress_json),
    result: parseJson(row.result_json),
    error: row.error == null ? null : String(row.error),
    startedAt: row.started_at == null ? null : Number(row.started_at),
    completedAt: row.completed_at == null ? null : Number(row.completed_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function parseJson(value: unknown): unknown {
  if (value == null) return null;
  try { return JSON.parse(String(value)); } catch { return value; }
}
