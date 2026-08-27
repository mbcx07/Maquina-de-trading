import { BinanceMarketDataClient } from './binanceMarket.js';
import { TradingDatabase } from './database.js';
import { auditV335Symbol, defaultAuditRules, type SymbolAuditResult } from './universeAuditCore.js';

const DAY = 24 * 60 * 60_000;
const ERROR_BACKOFF_MS = 15 * 60_000;
const AUDIT_MODEL = 'V33.5_STRUCTURAL_PRICE_LEVELS';

export interface UniverseAuditState {
  status: 'IDLE' | 'RUNNING' | 'COMPLETED' | 'ERROR';
  startedAt?: number;
  completedAt?: number;
  total?: number;
  completed?: number;
  current?: string;
  qualifiedSymbols?: string[];
  results?: Array<{
    symbol: string;
    qualified: boolean;
    reasons: string[];
    metrics: SymbolAuditResult['metrics'];
    outOfSample: SymbolAuditResult['outOfSample'];
  }>;
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
    return this.getState().qualifiedSymbols ?? [];
  }

  shouldRefresh(maxAgeDays = 7): boolean {
    if (this.running) return false;
    const state = this.getState();
    const modelMismatch = String(state.rules?.exitModel ?? '') !== AUDIT_MODEL;
    if (modelMismatch) return true;
    if (state.status === 'COMPLETED' && state.completedAt) {
      return Date.now() - state.completedAt > maxAgeDays * DAY;
    }
    if (state.status === 'ERROR' && state.completedAt) {
      return Date.now() - state.completedAt >= ERROR_BACKOFF_MS;
    }
    return true;
  }

  runInBackground(days = 14): void {
    if (this.running) return;
    void this.run(days).catch(() => undefined);
  }

  async run(days = 14): Promise<UniverseAuditState> {
    if (this.running) return this.getState();
    this.running = true;
    const endTime = Date.now() - 60_000;
    const startTime = endTime - Math.max(3, Math.min(31, days)) * DAY;
    const rules = defaultAuditRules(startTime, endTime);
    const results: SymbolAuditResult[] = [];
    const errors: Array<{ symbol: string; error: string }> = [];
    const startedAt = Date.now();

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
        qualifiedSymbols: [], results: [], errors: [], rules: { ...rules, days },
      });

      // Serialized historical retrieval protects Binance request-weight headroom.
      for (let i = 0; i < symbols.length; i++) {
        const symbol = symbols[i];
        try {
          const { ltf, htf } = await this.market.getDualHistoricalRange(symbol, startTime, endTime);
          results.push(auditV335Symbol(symbol, ltf, htf, rules));
        } catch (error) {
          errors.push({ symbol, error: error instanceof Error ? error.message : String(error) });
        }

        const compact = compactResults(results);
        this.save({
          status: 'RUNNING', startedAt, total: symbols.length, completed: i + 1,
          current: symbol, qualifiedSymbols: compact.filter((r) => r.qualified).map((r) => r.symbol),
          results: compact, errors: errors.slice(-100), rules: { ...rules, days },
        });
      }

      const compact = compactResults(results);
      const state: UniverseAuditState = {
        status: 'COMPLETED', startedAt, completedAt: Date.now(), total: symbols.length, completed: symbols.length,
        qualifiedSymbols: compact.filter((r) => r.qualified).map((r) => r.symbol),
        results: compact, errors: errors.slice(-100), rules: { ...rules, days },
      };
      this.save(state);
      return state;
    } catch (error) {
      const previous = this.getState();
      const state: UniverseAuditState = {
        status: 'ERROR', startedAt, completedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
        qualifiedSymbols: previous.qualifiedSymbols ?? [],
        results: previous.results ?? [],
        errors: previous.errors ?? [],
        rules: previous.rules ?? { exitModel: AUDIT_MODEL },
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

function compactResults(results: SymbolAuditResult[]) {
  return [...results]
    .map((result) => ({
      symbol: result.symbol,
      qualified: result.qualified,
      reasons: result.reasons,
      metrics: result.metrics,
      outOfSample: result.outOfSample,
    }))
    .sort((a, b) => Number(b.qualified) - Number(a.qualified) || b.outOfSample.netReturnPct - a.outOfSample.netReturnPct || b.metrics.netReturnPct - a.metrics.netReturnPct);
}
