import crypto from 'node:crypto';
import { analyzeStructureStrategyV335, runRollingBacktestV335 } from './analysisV335.js';
import { BinanceMarketDataClient } from './binanceMarket.js';
import { TradingDatabase } from './database.js';
import { OpportunityOrchestrator } from './orchestrator.js';
import type { EngineSettings, Opportunity } from './types.js';

export class CryptoMarketScanner {
  private running = false;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly database: TradingDatabase,
    private readonly market: BinanceMarketDataClient,
    private readonly orchestrator: OpportunityOrchestrator,
    private readonly getSettings: () => EngineSettings,
  ) {}

  start(): void {
    this.stopped = false;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async runCycle(): Promise<void> {
    if (this.running) return;
    if (!this.getSettings().cryptoEnabled) return;

    const audit = this.loadUniverseAudit();
    if (!audit || audit.status !== 'COMPLETED') {
      this.saveState({
        status: 'WAITING_UNIVERSE_AUDIT',
        strategy: 'V33.5_ORIGINAL_COMPAT',
        auditStatus: audit?.status ?? 'NOT_RUN',
        completedAt: Date.now(),
      });
      return;
    }

    const qualified = new Set((audit.qualifiedSymbols ?? []).map((symbol: string) => symbol.toUpperCase()));
    if (qualified.size === 0) {
      this.saveState({
        status: 'NO_QUALIFIED_SYMBOLS',
        strategy: 'V33.5_ORIGINAL_COMPAT',
        auditCompletedAt: audit.completedAt,
        completedAt: Date.now(),
      });
      return;
    }

    this.running = true;
    const startedAt = Date.now();
    let scanned = 0;
    let errors = 0;
    const opportunities: Opportunity[] = [];

    try {
      const [allSymbols, tickers] = await Promise.all([
        this.market.getTradableUsdtPerpetualSymbols(),
        this.market.getTicker24h(),
      ]);
      const tickerMap = new Map(tickers.map((ticker) => [ticker.symbol, ticker]));
      const liquidSymbols = allSymbols
        .filter((symbol) => (tickerMap.get(symbol)?.quoteVolume ?? 0) > 2_000_000)
        .sort((a, b) => (tickerMap.get(b)?.quoteVolume ?? 0) - (tickerMap.get(a)?.quoteVolume ?? 0));
      const symbols = liquidSymbols.filter((symbol) => qualified.has(symbol));
      const liquidity = liquidityPercentiles(symbols, tickerMap);

      this.saveState({
        status: 'SCANNING', strategy: 'V33.5_ORIGINAL_COMPAT', qualification: 'PROFITABLE_ONLY',
        startedAt, total: symbols.length, universeTotal: allSymbols.length, liquidUniverse: liquidSymbols.length,
        qualifiedUniverse: qualified.size, minQuoteVolume24h: 2_000_000, scanned: 0, opportunities: 0, errors: 0,
      });

      const chunkSize = 4;
      for (let i = 0; i < symbols.length; i += chunkSize) {
        const chunk = symbols.slice(i, i + chunkSize);
        const results = await Promise.allSettled(chunk.map((symbol) => this.scanSymbol(symbol, liquidity.get(symbol) ?? 0)));
        for (const result of results) {
          scanned++;
          if (result.status === 'fulfilled' && result.value) opportunities.push(result.value);
          if (result.status === 'rejected') errors++;
        }
        this.saveState({
          status: 'SCANNING', strategy: 'V33.5_ORIGINAL_COMPAT', qualification: 'PROFITABLE_ONLY',
          startedAt, total: symbols.length, universeTotal: allSymbols.length, liquidUniverse: liquidSymbols.length,
          qualifiedUniverse: qualified.size, scanned, current: chunk.at(-1) ?? null,
          opportunities: opportunities.length, errors,
        });
        if (i + chunkSize < symbols.length) await sleep(850);
      }

      const result = await this.orchestrator.process(opportunities, true);
      this.saveState({
        status: 'IDLE', strategy: 'V33.5_ORIGINAL_COMPAT', qualification: 'PROFITABLE_ONLY',
        startedAt, completedAt: Date.now(), total: symbols.length, universeTotal: allSymbols.length,
        liquidUniverse: liquidSymbols.length, qualifiedUniverse: qualified.size, scanned,
        opportunities: opportunities.length, selected: result.selected.crypto.length,
        executed: result.executionResults.filter((item) => item.broker === 'BINANCE' && item.ok === true).length,
        errors,
      });
    } catch (error) {
      this.saveState({
        status: 'ERROR', strategy: 'V33.5_ORIGINAL_COMPAT', startedAt, completedAt: Date.now(),
        scanned, opportunities: opportunities.length, errors: errors + 1,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      this.running = false;
    }
  }

  private async loop(): Promise<void> {
    if (this.stopped) return;
    try { await this.runCycle(); }
    catch (error) { console.error('[V34] crypto scanner:', error instanceof Error ? error.message : error); }
    if (!this.stopped) {
      this.timer = setTimeout(() => void this.loop(), 15_000);
      this.timer.unref();
    }
  }

  private async scanSymbol(symbol: string, liquidityScore: number): Promise<Opportunity | null> {
    // Individual trend: every symbol receives its own exact 100xM1 + 210xM15 history.
    const { ltf, htf } = await this.market.getDualKlines(symbol);
    if (ltf.length < 100 || htf.length < 210) return null;

    const signal = analyzeStructureStrategyV335(ltf, htf, symbol);
    if (!signal) return null;

    const settings = this.getSettings();
    const backtest = runRollingBacktestV335(symbol, ltf, htf);
    const passesOriginalFilter = backtest.tradesEvaluated === 0
      ? signal.confidence >= Math.max(80, settings.cryptoMinSignalConfidence)
      : backtest.winRate >= settings.cryptoMinRollingWinRate && signal.confidence >= settings.cryptoMinSignalConfidence;
    if (!passesOriginalFilter) return null;

    const rollingWinRate = backtest.tradesEvaluated === 0 ? signal.confidence : backtest.winRate;
    const score = backtest.tradesEvaluated === 0
      ? signal.confidence
      : backtest.score + Math.max(0, Math.min(100, liquidityScore)) * 0.001;
    const candleTime = ltf.at(-1)?.time ?? Date.now();
    const fingerprint = sha256([
      'BINANCE', symbol, signal.side, signal.strategy, String(candleTime),
      roundKey(signal.stopLoss), roundKey(signal.takeProfit),
    ].join('|'));

    return {
      id: `OP-BN-${fingerprint.slice(0, 24)}`,
      signalId: `SIG-BN-${fingerprint.slice(0, 24)}`,
      signalFingerprint: fingerprint,
      broker: 'BINANCE', symbol, side: signal.side, timeframe: '1m/15m', strategy: signal.strategy,
      confidence: signal.confidence, rollingWinRate, expectancy: backtest.expectancyPct, score,
      entry: signal.entry, stopLoss: signal.stopLoss, takeProfit: signal.takeProfit, tp2: signal.tp2, tp3: signal.tp3,
      createdAt: Date.now(),
      metadata: {
        reason: signal.reason, atr: signal.atr, backtest, liquidityScore,
        rollingWinRateSource: backtest.tradesEvaluated === 0 ? 'SIGNAL_CONFIDENCE_NO_HISTORY' : 'ROLLING_BACKTEST_V335',
        strategyCompatibility: 'V33.5_ORIGINAL', trendSource: `${symbol}:M15_EMA20_50_200`,
        decisionWindows: { m1: 100, m15: 210 }, candleTime,
      },
    };
  }

  private loadUniverseAudit(): any | null {
    const row = this.database.db.prepare(`SELECT value FROM engine_state WHERE key='cryptoUniverseAudit'`).get() as { value: string } | undefined;
    if (!row) return null;
    try { return JSON.parse(row.value); } catch { return null; }
  }

  private saveState(value: Record<string, unknown>): void {
    this.database.db.prepare(`
      INSERT INTO engine_state(key, value, updated_at) VALUES('cryptoScanner', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(JSON.stringify(value), Date.now());
  }
}

function liquidityPercentiles(symbols: string[], tickerMap: Map<string, { quoteVolume: number }>): Map<string, number> {
  const sorted = symbols.map((symbol) => ({ symbol, volume: Math.max(0, tickerMap.get(symbol)?.quoteVolume ?? 0) })).sort((a, b) => a.volume - b.volume);
  const result = new Map<string, number>();
  const denominator = Math.max(1, sorted.length - 1);
  sorted.forEach((item, index) => result.set(item.symbol, index / denominator * 100));
  return result;
}
function sha256(value: string): string { return crypto.createHash('sha256').update(value).digest('hex'); }
function roundKey(value: number): string { return Number(value.toPrecision(10)).toString(); }
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
