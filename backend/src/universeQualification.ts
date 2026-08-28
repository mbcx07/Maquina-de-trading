import { BinanceMarketDataClient } from './binanceMarket.js';
import { TradingDatabase } from './database.js';
import { calibrateR11Async } from './r11Calibration.js';
import { evaluateConfigExternalR11, type R11Config, type R11Model, type R11Trade } from './highWinrateR11.js';

const DAY = 24 * 60 * 60_000;
const ERROR_BACKOFF_MS = 15 * 60_000;
const AUDIT_MODEL = 'R11_CALIBRATED_SWEEP_RETEST_M5_M15_EXTERNAL_V1';
const CALIBRATION_DAYS = 21;
const EXTERNAL_DAYS = 7;
const ROUND_TRIP_COST_PCT = 0.12;

export interface ExternalMetricsR11 {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  netReturnPct: number;
  expectancyPct: number;
  profitFactor: number;
  maxDrawdownPct: number;
}

export interface QualifiedModelResult {
  symbol: string;
  qualified: boolean;
  reasons: string[];
  modelStatus: string;
  fallback: boolean;
  model?: {
    config: R11Config;
    score: number;
    calibratedAt: number;
    train: R11Model['train'];
    validation: R11Model['validation'];
    holdout: R11Model['holdout'];
  };
  external: ExternalMetricsR11;
}

export interface UniverseAuditState {
  status: 'IDLE' | 'RUNNING' | 'COMPLETED' | 'ERROR';
  startedAt?: number;
  completedAt?: number;
  total?: number;
  completed?: number;
  current?: string;
  qualifiedSymbols?: string[];
  results?: QualifiedModelResult[];
  errors?: Array<{ symbol: string; error: string }>;
  rules?: Record<string, unknown>;
  error?: string;
}

export class UniverseQualificationService {
  private running = false;

  constructor(
    private readonly database: TradingDatabase,
    private readonly market: BinanceMarketDataClient,
  ) {}

  getState(): UniverseAuditState {
    const row = this.database.db.prepare(`SELECT value FROM engine_state WHERE key='cryptoUniverseAudit'`).get() as { value: string } | undefined;
    if (!row) return { status: 'IDLE' };
    try { return JSON.parse(row.value) as UniverseAuditState; }
    catch { return { status: 'ERROR', error: 'UNIVERSE_AUDIT_STATE_INVALID' }; }
  }

  getQualifiedSymbols(): string[] {
    const state = this.getState();
    return String(state.rules?.exitModel ?? '') === AUDIT_MODEL ? (state.qualifiedSymbols ?? []) : [];
  }

  getModel(symbol: string): QualifiedModelResult | null {
    const state = this.getState();
    if (String(state.rules?.exitModel ?? '') !== AUDIT_MODEL) return null;
    return state.results?.find((row) => row.symbol === symbol && row.qualified && row.model?.config) ?? null;
  }

  shouldRefresh(maxAgeDays = 3): boolean {
    if (this.running) return false;
    const state = this.getState();
    const modelMismatch = String(state.rules?.exitModel ?? '') !== AUDIT_MODEL;
    if (modelMismatch) return true;
    if (state.status === 'COMPLETED' && state.completedAt) return Date.now() - state.completedAt > maxAgeDays * DAY;
    if (state.status === 'ERROR' && state.completedAt) return Date.now() - state.completedAt >= ERROR_BACKOFF_MS;
    if (state.status === 'RUNNING') return false;
    return true;
  }

  runInBackground(days = CALIBRATION_DAYS + EXTERNAL_DAYS): void {
    if (this.running) return;
    void this.run(days).catch(() => undefined);
  }

  async run(days = CALIBRATION_DAYS + EXTERNAL_DAYS): Promise<UniverseAuditState> {
    if (this.running) return this.getState();
    this.running = true;
    const totalDays = Math.max(CALIBRATION_DAYS + EXTERNAL_DAYS, Math.min(45, days));
    const endTime = Date.now() - 5 * 60_000;
    const externalStart = endTime - EXTERNAL_DAYS * DAY;
    const calibrationEnd = externalStart - 1;
    const calibrationStart = calibrationEnd - Math.max(CALIBRATION_DAYS, totalDays - EXTERNAL_DAYS) * DAY;
    const results: QualifiedModelResult[] = [];
    const errors: Array<{ symbol: string; error: string }> = [];
    const startedAt = Date.now();
    const rules = {
      exitModel: AUDIT_MODEL,
      calibrationDays: Math.round((calibrationEnd - calibrationStart) / DAY),
      externalDays: EXTERNAL_DAYS,
      roundTripCostPct: ROUND_TRIP_COST_PCT,
      minExternalTrades: 3,
      minExternalWinRate: 64,
      minExternalProfitFactor: 1.02,
      requirePositiveExternalExpectancy: true,
      requirePositiveExternalNetReturn: true,
      entry: 'M5_PENDING_RETEST',
      bias: 'M5_M15_ALIGNED',
      noM1SignalLogic: true,
    };

    try {
      const [allSymbols, tickers] = await Promise.all([
        this.market.getTradableUsdtPerpetualSymbols(),
        this.market.getTicker24h(),
      ]);
      const tickerMap = new Map(tickers.map((ticker) => [ticker.symbol, ticker]));
      const symbols = allSymbols
        .filter((symbol) => (tickerMap.get(symbol)?.quoteVolume ?? 0) > 2_000_000)
        .sort((a, b) => (tickerMap.get(b)?.quoteVolume ?? 0) - (tickerMap.get(a)?.quoteVolume ?? 0));

      this.save({
        status: 'RUNNING', startedAt, total: symbols.length, completed: 0,
        qualifiedSymbols: [], results: [], errors: [], rules,
      });

      for (let i = 0; i < symbols.length; i++) {
        const symbol = symbols[i];
        try {
          const { ltf, htf } = await this.market.getDualHistoricalRange(symbol, calibrationStart, endTime);
          const calibrationM5 = ltf.filter((candle) => candle.time >= calibrationStart && candle.time <= calibrationEnd);
          const calibrationM15 = htf.filter((candle) => candle.time <= calibrationEnd);
          if (calibrationM5.length < 3000 || calibrationM15.length < 500) {
            throw new Error(`R11_INSUFFICIENT_HISTORY:m5=${calibrationM5.length}:m15=${calibrationM15.length}`);
          }

          const model = await calibrateR11Async(calibrationM5, calibrationM15);
          let external = emptyExternalMetrics();
          if (model.ready) {
            const test = evaluateConfigExternalR11(ltf, htf, model.config, externalStart, endTime);
            external = externalMetrics(test.trades, ROUND_TRIP_COST_PCT);
          }
          const reasons = qualificationReasons(model, external);
          results.push({
            symbol,
            qualified: reasons.length === 0,
            reasons,
            modelStatus: model.status,
            fallback: model.fallback,
            model: model.ready ? {
              config: model.config,
              score: model.score,
              calibratedAt: Date.now(),
              train: model.train,
              validation: model.validation,
              holdout: model.holdout,
            } : undefined,
            external,
          });
        } catch (error) {
          errors.push({ symbol, error: error instanceof Error ? error.message : String(error) });
        }

        const compact = sortResults(results);
        this.save({
          status: 'RUNNING', startedAt, total: symbols.length, completed: i + 1,
          current: symbol,
          qualifiedSymbols: compact.filter((row) => row.qualified).map((row) => row.symbol),
          results: compact,
          errors: errors.slice(-100),
          rules,
        });
      }

      const compact = sortResults(results);
      const state: UniverseAuditState = {
        status: 'COMPLETED', startedAt, completedAt: Date.now(), total: symbols.length, completed: symbols.length,
        qualifiedSymbols: compact.filter((row) => row.qualified).map((row) => row.symbol),
        results: compact,
        errors: errors.slice(-100),
        rules,
      };
      this.save(state);
      return state;
    } catch (error) {
      const previous = this.getState();
      const sameModel = String(previous.rules?.exitModel ?? '') === AUDIT_MODEL;
      const state: UniverseAuditState = {
        status: 'ERROR', startedAt, completedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
        qualifiedSymbols: sameModel ? (previous.qualifiedSymbols ?? []) : [],
        results: sameModel ? (previous.results ?? []) : [],
        errors: previous.errors ?? [],
        rules,
      };
      this.save(state);
      throw error;
    } finally {
      this.running = false;
    }
  }

  private save(state: UniverseAuditState): void {
    this.database.db.prepare(`
      INSERT INTO engine_state(key, value, updated_at) VALUES('cryptoUniverseAudit', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(JSON.stringify(state), Date.now());
  }
}

function qualificationReasons(model: R11Model, external: ExternalMetricsR11): string[] {
  const reasons: string[] = [];
  if (!model.ready) reasons.push(model.status || 'MODEL_NOT_READY');
  if (model.ready && external.trades < 3) reasons.push('EXTERNAL_TRADES_LT_3');
  if (model.ready && external.winRate < 64) reasons.push('EXTERNAL_WR_LT_64');
  if (model.ready && external.expectancyPct <= 0) reasons.push('EXTERNAL_EXPECTANCY_NOT_POSITIVE');
  if (model.ready && external.profitFactor < 1.02) reasons.push('EXTERNAL_PF_LT_1.02');
  if (model.ready && external.netReturnPct <= 0) reasons.push('EXTERNAL_NET_NOT_POSITIVE');
  return reasons;
}

function externalMetrics(trades: R11Trade[], roundTripCostPct: number): ExternalMetricsR11 {
  let wins = 0;
  let losses = 0;
  let grossProfitPct = 0;
  let grossLossPct = 0;
  let netSumPct = 0;
  let equity = 100;
  let peak = 100;
  let maxDrawdownPct = 0;

  for (const trade of trades) {
    const rawPct = trade.direction > 0
      ? (trade.exit - trade.entry) / trade.entry * 100
      : (trade.entry - trade.exit) / trade.entry * 100;
    const netPct = rawPct - Math.max(0, roundTripCostPct);
    netSumPct += netPct;
    if (netPct > 0) { wins++; grossProfitPct += netPct; }
    else { losses++; grossLossPct += netPct; }
    equity *= 1 + netPct / 100;
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, peak > 0 ? (peak - equity) / peak * 100 : 0);
  }

  const lossAbs = Math.abs(grossLossPct);
  return {
    trades: trades.length,
    wins,
    losses,
    winRate: trades.length ? wins / trades.length * 100 : 0,
    netReturnPct: equity - 100,
    expectancyPct: trades.length ? netSumPct / trades.length : 0,
    profitFactor: lossAbs > 0 ? grossProfitPct / lossAbs : grossProfitPct > 0 ? 99 : 0,
    maxDrawdownPct,
  };
}

function emptyExternalMetrics(): ExternalMetricsR11 {
  return { trades: 0, wins: 0, losses: 0, winRate: 0, netReturnPct: 0, expectancyPct: 0, profitFactor: 0, maxDrawdownPct: 0 };
}

function sortResults(results: QualifiedModelResult[]): QualifiedModelResult[] {
  return [...results].sort((a, b) =>
    Number(b.qualified) - Number(a.qualified) ||
    b.external.expectancyPct - a.external.expectancyPct ||
    b.external.winRate - a.external.winRate ||
    b.external.netReturnPct - a.external.netReturnPct,
  );
}
