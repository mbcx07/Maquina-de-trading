import crypto from 'node:crypto';
import { analyzeStructureStrategyV335, runRollingBacktestV335 } from './analysisV335.js';
import { BinanceMarketDataClient } from './binanceMarket.js';
import { TradingDatabase } from './database.js';
import { normalizeFuturesExitLevels } from './futuresExitProfile.js';
import { OpportunityOrchestrator } from './orchestrator.js';
import { UniverseQualificationService } from './universeQualification.js';
import type { EngineSettings, Opportunity } from './types.js';

export class CryptoMarketScanner {
  private running = false;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly qualification: UniverseQualificationService;

  constructor(
    private readonly database: TradingDatabase,
    private readonly market: BinanceMarketDataClient,
    private readonly orchestrator: OpportunityOrchestrator,
    private readonly getSettings: () => EngineSettings,
  ) {
    this.qualification = new UniverseQualificationService(database, market, getSettings);
  }

  start(): void {
    this.stopped = false;
    if (this.getSettings().cryptoEnabled && this.qualification.shouldRefresh(7)) this.qualification.runInBackground(14);
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

    if (this.qualification.shouldRefresh(7)) this.qualification.runInBackground(14);
    const audit = this.qualification.getState();
    if (audit.status !== 'COMPLETED') {
      this.saveState({
        status: 'WAITING_UNIVERSE_AUDIT',
        strategy: 'V33.5_ORIGINAL_COMPAT_FUTURES',
        auditStatus: audit.status,
        startedAt: audit.startedAt,
        completedAt: audit.completedAt,
        total: audit.total ?? 0,
        scanned: audit.completed ?? 0,
        current: audit.current ?? null,
        qualifiedUniverse: audit.qualifiedSymbols?.length ?? 0,
        auditError: audit.error,
        message: 'No Crypto entry is allowed until the profitability audit completes.',
      });
      return;
    }

    const qualified = new Set((audit.qualifiedSymbols ?? []).map((symbol) => symbol.toUpperCase()));
    if (qualified.size === 0) {
      this.saveState({
        status: 'NO_QUALIFIED_SYMBOLS',
        strategy: 'V33.5_ORIGINAL_COMPAT_FUTURES',
        auditCompletedAt: audit.completedAt,
        qualifiedUniverse: 0,
        completedAt: Date.now(),
        message: 'The strategy has no currently qualified Binance symbols. No trades will be opened.',
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
        status: 'SCANNING', strategy: 'V33.5_ORIGINAL_COMPAT_FUTURES', qualification: 'PROFITABLE_ONLY',
        startedAt, total: symbols.length, universeTotal: allSymbols.length, liquidUniverse: liquidSymbols.length,
        qualifiedUniverse: qualified.size, qualifiedSymbols: [...qualified], minQuoteVolume24h: 2_000_000,
        scanned: 0, opportunities: 0, revalidated: 0, errors: 0,
      });

      const chunkSize = 4;
      for (let i = 0; i < symbols.length; i += chunkSize) {
        const chunk = symbols.slice(i, i + chunkSize);
        const results = await Promise.allSettled(chunk.map((symbol) => this.scanSymbol(
          symbol,
          liquidity.get(symbol) ?? 0,
        )));

        for (const result of results) {
          scanned++;
          if (result.status === 'fulfilled' && result.value) opportunities.push(result.value);
          if (result.status === 'rejected') errors++;
        }

        this.saveState({
          status: 'SCANNING', strategy: 'V33.5_ORIGINAL_COMPAT_FUTURES', qualification: 'PROFITABLE_ONLY',
          startedAt, total: symbols.length, universeTotal: allSymbols.length, liquidUniverse: liquidSymbols.length,
          qualifiedUniverse: qualified.size, qualifiedSymbols: [...qualified], scanned,
          current: chunk.at(-1) ?? null, opportunities: opportunities.length, revalidated: 0, errors,
        });

        if (i + chunkSize < symbols.length) await sleep(850);
      }

      // The full-market scan can take long enough for an M1 setup to become stale.
      // Preserve ranking, but re-run the exact v33.5 signal on fresh 100xM1/210xM15
      // immediately before handing a candidate to execution.
      const revalidationPool = [...opportunities]
        .sort((a, b) => b.score - a.score || b.confidence - a.confidence)
        .slice(0, Math.max(20, Math.min(40, this.getSettings().maxConcurrentCryptoTrades * 4)));
      const freshOpportunities: Opportunity[] = [];
      for (const original of revalidationPool) {
        try {
          const fresh = await this.scanSymbol(original.symbol, liquidity.get(original.symbol) ?? 0);
          if (!fresh) continue;
          fresh.metadata = {
            ...(fresh.metadata ?? {}),
            firstDetectedAt: original.createdAt,
            firstDetectedEntry: original.entry,
            revalidatedAt: Date.now(),
            executionRevalidation: true,
          };
          freshOpportunities.push(fresh);
        } catch {
          errors++;
        }
      }

      const result = await this.orchestrator.process(freshOpportunities, true);
      this.saveState({
        status: 'IDLE', strategy: 'V33.5_ORIGINAL_COMPAT_FUTURES', qualification: 'PROFITABLE_ONLY',
        startedAt, completedAt: Date.now(), total: symbols.length, universeTotal: allSymbols.length,
        liquidUniverse: liquidSymbols.length, qualifiedUniverse: qualified.size, qualifiedSymbols: [...qualified],
        scanned, opportunities: opportunities.length, revalidated: freshOpportunities.length,
        staleRejected: Math.max(0, revalidationPool.length - freshOpportunities.length),
        selected: result.selected.crypto.length,
        executed: result.executionResults.filter((item) => item.broker === 'BINANCE' && item.ok === true).length,
        errors,
      });
    } catch (error) {
      this.saveState({
        status: 'ERROR', strategy: 'V33.5_ORIGINAL_COMPAT_FUTURES', startedAt, completedAt: Date.now(),
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

    // V33.5 identifies the setup/structure. Crypto Futures then applies a minimum
    // UNDERLYING price distance so leverage is reflected as margin ROI rather than
    // accidentally turning M1 structure into a micro-scalp.
    const exits = normalizeFuturesExitLevels({
      side: signal.side,
      entry: signal.entry,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      tp2: signal.tp2,
      tp3: signal.tp3,
      minStopPricePct: settings.cryptoMinStopPricePct,
      minTakeProfitPricePct: settings.cryptoMinTakeProfitPricePct,
      leverage: settings.cryptoRequestedLeverage,
    });

    const rollingWinRate = backtest.tradesEvaluated === 0 ? signal.confidence : backtest.winRate;
    const score = backtest.tradesEvaluated === 0
      ? signal.confidence
      : backtest.score + Math.max(0, Math.min(100, liquidityScore)) * 0.001;
    const candleTime = ltf.at(-1)?.time ?? Date.now();
    const fingerprint = sha256([
      'BINANCE-FUTURES', symbol, signal.side, signal.strategy, String(candleTime),
      roundKey(exits.stopLoss), roundKey(exits.takeProfit),
    ].join('|'));

    return {
      id: `OP-BN-${fingerprint.slice(0, 24)}`,
      signalId: `SIG-BN-${fingerprint.slice(0, 24)}`,
      signalFingerprint: fingerprint,
      broker: 'BINANCE', symbol, side: signal.side, timeframe: '1m/15m', strategy: signal.strategy,
      confidence: signal.confidence, rollingWinRate, expectancy: backtest.expectancyPct, score,
      entry: signal.entry, stopLoss: exits.stopLoss, takeProfit: exits.takeProfit, tp2: exits.tp2, tp3: exits.tp3,
      createdAt: Date.now(),
      metadata: {
        reason: signal.reason, atr: signal.atr, backtest, liquidityScore,
        rollingWinRateSource: backtest.tradesEvaluated === 0 ? 'SIGNAL_CONFIDENCE_NO_HISTORY' : 'ROLLING_BACKTEST_V335',
        strategyCompatibility: 'V33.5_ORIGINAL_SETUP_WITH_FUTURES_EXIT_PROFILE', trendSource: `${symbol}:M15_EMA20_50_200`,
        decisionWindows: { m1: 100, m15: 210 }, candleTime,
        futuresExitProfile: exits,
      },
    };
  }

  private saveState(value: Record<string, unknown>): void {
    this.database.db.prepare(`
      INSERT INTO engine_state(key, value, updated_at) VALUES('cryptoScanner', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(JSON.stringify(value), Date.now());
  }
}

function liquidityPercentiles(symbols: string[], tickerMap: Map<string, { quoteVolume: number }>): Map<string, number> {
  const sorted = symbols
    .map((symbol) => ({ symbol, volume: Math.max(0, tickerMap.get(symbol)?.quoteVolume ?? 0) }))
    .sort((a, b) => a.volume - b.volume);
  const result = new Map<string, number>();
  const denominator = Math.max(1, sorted.length - 1);
  sorted.forEach((item, index) => result.set(item.symbol, index / denominator * 100));
  return result;
}

function sha256(value: string): string { return crypto.createHash('sha256').update(value).digest('hex'); }
function roundKey(value: number): string { return Number(value.toPrecision(10)).toString(); }
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
