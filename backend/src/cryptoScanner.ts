import crypto from 'node:crypto';
import { analyzeStructureStrategy, opportunityScore, runRollingBacktest } from './analysis.js';
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

    this.running = true;
    const startedAt = Date.now();
    let scanned = 0;
    let errors = 0;
    const opportunities: Opportunity[] = [];

    try {
      const [symbols, tickers] = await Promise.all([
        this.market.getTradableUsdtPerpetualSymbols(),
        this.market.getTicker24h(),
      ]);

      const tickerMap = new Map(tickers.map((ticker) => [ticker.symbol, ticker]));
      const liquidity = liquidityPercentiles(symbols, tickerMap);

      this.saveState({
        status: 'SCANNING',
        startedAt,
        total: symbols.length,
        scanned: 0,
        opportunities: 0,
        errors: 0,
      });

      // Deliberately throttled: monitoring every symbol is useful only if we do not
      // consume the entire REST rate limit and starve execution/reconciliation calls.
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
          status: 'SCANNING',
          startedAt,
          total: symbols.length,
          scanned,
          current: chunk.at(-1) ?? null,
          opportunities: opportunities.length,
          errors,
        });

        if (i + chunkSize < symbols.length) await sleep(850);
      }

      const result = await this.orchestrator.process(opportunities, true);
      this.saveState({
        status: 'IDLE',
        startedAt,
        completedAt: Date.now(),
        total: symbols.length,
        scanned,
        opportunities: opportunities.length,
        selected: result.selected.crypto.length,
        executed: result.executionResults.filter((item) => item.broker === 'BINANCE' && item.ok === true).length,
        errors,
      });
    } catch (error) {
      this.saveState({
        status: 'ERROR',
        startedAt,
        completedAt: Date.now(),
        scanned,
        opportunities: opportunities.length,
        errors: errors + 1,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      this.running = false;
    }
  }

  private async loop(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.runCycle();
    } catch (error) {
      console.error('[V34] crypto scanner:', error instanceof Error ? error.message : error);
    }

    if (!this.stopped) {
      this.timer = setTimeout(() => void this.loop(), 15_000);
      this.timer.unref();
    }
  }

  private async scanSymbol(symbol: string, liquidityScore: number): Promise<Opportunity | null> {
    const { ltf, htf } = await this.market.getDualKlines(symbol);
    if (ltf.length < 80 || htf.length < 200) return null;

    const signal = analyzeStructureStrategy(ltf, htf, symbol);
    if (!signal) return null;

    const backtest = runRollingBacktest(symbol, ltf, htf);
    const rollingWinRate = backtest.tradesEvaluated >= 3
      ? backtest.winRate
      : signal.confidence;
    const score = opportunityScore(signal, backtest, liquidityScore);
    const candleTime = ltf.at(-1)?.time ?? Date.now();
    const fingerprint = sha256([
      'BINANCE', symbol, signal.side, signal.strategy, String(candleTime),
      roundKey(signal.stopLoss), roundKey(signal.takeProfit),
    ].join('|'));

    return {
      id: `OP-BN-${fingerprint.slice(0, 24)}`,
      signalId: `SIG-BN-${fingerprint.slice(0, 24)}`,
      signalFingerprint: fingerprint,
      broker: 'BINANCE',
      symbol,
      side: signal.side,
      timeframe: '1m/15m',
      strategy: signal.strategy,
      confidence: signal.confidence,
      rollingWinRate,
      expectancy: backtest.expectancyPct,
      score,
      entry: signal.entry,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      tp2: signal.tp2,
      tp3: signal.tp3,
      createdAt: Date.now(),
      metadata: {
        reason: signal.reason,
        atr: signal.atr,
        backtest,
        liquidityScore,
        rollingWinRateSource: backtest.tradesEvaluated >= 3 ? 'ROLLING_BACKTEST' : 'SIGNAL_CONFIDENCE_FALLBACK',
        candleTime,
      },
    };
  }

  private saveState(value: Record<string, unknown>): void {
    this.database.db.prepare(`
      INSERT INTO engine_state(key, value, updated_at)
      VALUES('cryptoScanner', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(JSON.stringify(value), Date.now());
  }
}

function liquidityPercentiles(
  symbols: string[],
  tickerMap: Map<string, { quoteVolume: number }>,
): Map<string, number> {
  const sorted = symbols
    .map((symbol) => ({ symbol, volume: Math.max(0, tickerMap.get(symbol)?.quoteVolume ?? 0) }))
    .sort((a, b) => a.volume - b.volume);

  const result = new Map<string, number>();
  const denominator = Math.max(1, sorted.length - 1);
  sorted.forEach((item, index) => result.set(item.symbol, index / denominator * 100));
  return result;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function roundKey(value: number): string {
  return Number(value.toPrecision(10)).toString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
