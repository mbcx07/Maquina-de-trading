import crypto from 'node:crypto';
import { analyzeStructureStrategy, opportunityScore, runRollingBacktest } from './analysis.js';
import { TradingDatabase } from './database.js';
import { Mt5BridgeClient } from './mt5.js';
import { OpportunityOrchestrator } from './orchestrator.js';
import type { EngineSettings, Opportunity } from './types.js';

export class ForexMarketScanner {
  private running = false;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private signalZoneActive = new Map<string, boolean>();
  private initializedSymbols = new Set<string>();

  constructor(
    private readonly database: TradingDatabase,
    private readonly mt5: Mt5BridgeClient,
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
    const settings = this.getSettings();
    if (!settings.forexEnabled) return;

    this.running = true;
    const symbols = [...new Set(settings.forexSymbols.map((symbol) => symbol.trim()).filter(Boolean))];
    const opportunities: Opportunity[] = [];
    let errors = 0;
    const startedAt = Date.now();

    try {
      this.saveState({ status: 'SCANNING', startedAt, total: symbols.length, scanned: 0, opportunities: 0, errors: 0 });

      for (let index = 0; index < symbols.length; index++) {
        const symbol = symbols[index];
        try {
          const opportunity = await this.scanSymbol(symbol);
          if (opportunity) opportunities.push(opportunity);
        } catch (error) {
          errors++;
          this.database.db.prepare(`
            INSERT INTO engine_state(key, value, updated_at)
            VALUES(?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
          `).run(
            `forexScannerError:${symbol}`,
            JSON.stringify({ error: error instanceof Error ? error.message : String(error), at: Date.now() }),
            Date.now(),
          );
        }

        this.saveState({
          status: 'SCANNING',
          startedAt,
          total: symbols.length,
          scanned: index + 1,
          current: symbol,
          opportunities: opportunities.length,
          errors,
        });
      }

      const result = await this.orchestrator.process(opportunities, true);
      this.saveState({
        status: 'IDLE',
        startedAt,
        completedAt: Date.now(),
        total: symbols.length,
        scanned: symbols.length,
        opportunities: opportunities.length,
        selected: result.selected.forex.length,
        executed: result.executionResults.filter((item) => item.broker === 'MT5' && item.ok === true).length,
        errors,
      });
    } finally {
      this.running = false;
    }
  }

  private async loop(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.runCycle();
    } catch (error) {
      this.saveState({ status: 'ERROR', error: error instanceof Error ? error.message : String(error), at: Date.now() });
      console.error('[V34] forex scanner:', error instanceof Error ? error.message : error);
    }

    if (!this.stopped) {
      this.timer = setTimeout(() => void this.loop(), 10_000);
      this.timer.unref();
    }
  }

  private async scanSymbol(symbol: string): Promise<Opportunity | null> {
    const { ltf, htf } = await this.mt5.dualRates(symbol);
    if (ltf.length < 80 || htf.length < 200) return null;

    const signal = analyzeStructureStrategy(ltf, htf, symbol);
    const activeForSymbol = this.database.getActiveTrades('MT5')
      .filter((trade) => trade.symbol.toUpperCase() === symbol.toUpperCase());

    // On backend restart, if the pair already has an open ticket and is still in the
    // same valid setup zone, do not treat the restart itself as a new retest.
    if (!this.initializedSymbols.has(symbol)) {
      this.initializedSymbols.add(symbol);
      if (activeForSymbol.length > 0 && signal) {
        this.signalZoneActive.set(symbol, true);
        return null;
      }
    }

    if (!signal) {
      this.signalZoneActive.set(symbol, false);
      return null;
    }

    // A Forex reentry is emitted only on a new transition into a valid setup zone.
    // Consecutive candles in the same setup do not create repeated tickets.
    if (this.signalZoneActive.get(symbol) === true) return null;
    this.signalZoneActive.set(symbol, true);

    const backtest = runRollingBacktest(symbol, ltf, htf);
    const rollingWinRate = backtest.tradesEvaluated >= 3 ? backtest.winRate : signal.confidence;
    const score = opportunityScore(signal, backtest, 60);
    const candleTime = ltf.at(-1)?.time ?? Date.now();
    const fingerprint = sha256([
      'MT5', symbol, signal.side, signal.strategy, String(candleTime),
      roundKey(signal.stopLoss), roundKey(signal.takeProfit),
    ].join('|'));

    return {
      id: `OP-FX-${fingerprint.slice(0, 24)}`,
      signalId: `SIG-FX-${fingerprint.slice(0, 24)}`,
      signalFingerprint: fingerprint,
      broker: 'MT5',
      symbol,
      side: signal.side,
      timeframe: 'M1/M15',
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
        reentry: activeForSymbol.length > 0,
        existingTickets: activeForSymbol.map((trade) => trade.brokerOrderId).filter(Boolean),
        rollingWinRateSource: backtest.tradesEvaluated >= 3 ? 'ROLLING_BACKTEST' : 'SIGNAL_CONFIDENCE_FALLBACK',
        candleTime,
      },
    };
  }

  private saveState(value: Record<string, unknown>): void {
    this.database.db.prepare(`
      INSERT INTO engine_state(key, value, updated_at)
      VALUES('forexScanner', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(JSON.stringify(value), Date.now());
  }
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function roundKey(value: number): string {
  return Number(value.toPrecision(10)).toString();
}
