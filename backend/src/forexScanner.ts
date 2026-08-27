import crypto from 'node:crypto';
import { analyzeStructureStrategy, opportunityScore, runRollingBacktest } from './analysis.js';
import { TradingDatabase } from './database.js';
import { ForexDataClient } from './forexData.js';
import { TradingRepository } from './repositories.js';
import { TelegramService } from './telegram.js';
import type { EngineSettings, Opportunity } from './types.js';

export class ForexMarketScanner {
  private running = false;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private signalZoneActive = new Map<string, boolean>();
  private retestCount = new Map<string, number>();

  constructor(
    private readonly database: TradingDatabase,
    private readonly market: ForexDataClient,
    private readonly repository: TradingRepository,
    private readonly telegram: TelegramService,
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
    if (!settings.forexEnabled) {
      this.saveState({ status: 'DISABLED', completedAt: Date.now(), mode: 'SIGNAL_ONLY' });
      return;
    }
    if (!this.market.hasCredentials()) {
      this.saveState({ status: 'WAITING_FOREX_DATA_KEY', completedAt: Date.now(), mode: 'SIGNAL_ONLY' });
      return;
    }

    this.running = true;
    const symbols = [...new Set(settings.forexSymbols.map((symbol) => normalizeDisplaySymbol(symbol)).filter(Boolean))];
    const freshSignals: Opportunity[] = [];
    let errors = 0;
    const startedAt = Date.now();

    try {
      this.saveState({
        status: 'SCANNING', mode: 'SIGNAL_ONLY', provider: 'TWELVE_DATA',
        startedAt, total: symbols.length, scanned: 0, signals: 0, errors: 0,
      });

      for (let index = 0; index < symbols.length; index++) {
        const symbol = symbols[index];
        try {
          const signal = await this.scanSymbol(symbol);
          if (signal) freshSignals.push(signal);
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
          status: 'SCANNING', mode: 'SIGNAL_ONLY', provider: 'TWELVE_DATA',
          startedAt, total: symbols.length, scanned: index + 1, current: symbol,
          signals: freshSignals.length, errors, usage: this.market.getUsage(),
        });
      }

      const qualified = freshSignals
        .filter((signal) =>
          signal.confidence >= settings.forexMinSignalConfidence &&
          signal.rollingWinRate >= settings.forexMinRollingWinRate,
        )
        .sort((a, b) => b.score - a.score)
        .slice(0, settings.forexSignalsPerCycle);

      let sent = 0;
      for (const signal of qualified) {
        this.repository.saveSignal(signal);
        // Signal-only opportunities are intentionally never auto-executed.
        this.repository.rejectOpportunity(signal.id, 'FOREX_SIGNAL_ONLY_MANUAL_EXECUTION');
        if (this.wasSent(signal.signalFingerprint)) continue;

        const retest = (this.retestCount.get(signal.symbol) ?? 0) + 1;
        this.retestCount.set(signal.symbol, retest);
        try {
          await this.telegram.forexSignal(signal, retest);
          this.recordTelegramSignal(signal, 'SENT');
          sent++;
        } catch (error) {
          this.recordTelegramSignal(signal, 'ERROR', error instanceof Error ? error.message : String(error));
        }
      }

      this.saveState({
        status: 'IDLE', mode: 'SIGNAL_ONLY', provider: 'TWELVE_DATA',
        startedAt, completedAt: Date.now(), total: symbols.length, scanned: symbols.length,
        signals: freshSignals.length, qualified: qualified.length, sent, errors,
        usage: this.market.getUsage(),
        nextScanMinutes: settings.forexSignalScanIntervalMinutes,
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
      this.saveState({
        status: 'ERROR', mode: 'SIGNAL_ONLY', provider: 'TWELVE_DATA',
        error: error instanceof Error ? error.message : String(error), at: Date.now(),
      });
      console.error('[V34] forex signal scanner:', error instanceof Error ? error.message : error);
    }

    if (!this.stopped) {
      const delay = Math.max(1, this.getSettings().forexSignalScanIntervalMinutes) * 60_000;
      this.timer = setTimeout(() => void this.loop(), delay);
      this.timer.unref();
    }
  }

  private async scanSymbol(symbol: string): Promise<Opportunity | null> {
    const { ltf, htf } = await this.market.dualRates(symbol);
    if (ltf.length < 80 || htf.length < 200) return null;

    const signal = analyzeStructureStrategy(ltf, htf, symbol);
    if (!signal) {
      this.signalZoneActive.set(symbol, false);
      return null;
    }

    // A new Telegram signal is generated only when the pair leaves a valid setup
    // and later enters a valid setup again. This is the manual-Forex retest rule.
    if (this.signalZoneActive.get(symbol) === true) return null;
    this.signalZoneActive.set(symbol, true);

    const backtest = runRollingBacktest(symbol, ltf, htf);
    const rollingWinRate = backtest.tradesEvaluated >= 3 ? backtest.winRate : signal.confidence;
    const score = opportunityScore(signal, backtest, 60);
    const candleTime = ltf.at(-1)?.time ?? Date.now();
    const fingerprint = sha256([
      'FOREX-SIGNAL', symbol, signal.side, signal.strategy, String(candleTime),
      roundKey(signal.stopLoss), roundKey(signal.takeProfit),
    ].join('|'));

    return {
      id: `OP-FX-${fingerprint.slice(0, 24)}`,
      signalId: `SIG-FX-${fingerprint.slice(0, 24)}`,
      signalFingerprint: fingerprint,
      // Legacy DB schema names Forex as MT5. metadata.executionMode is authoritative.
      broker: 'MT5',
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
        executionMode: 'SIGNAL_ONLY',
        dataProvider: 'TWELVE_DATA',
        reason: signal.reason,
        atr: signal.atr,
        backtest,
        rollingWinRateSource: backtest.tradesEvaluated >= 3 ? 'ROLLING_BACKTEST' : 'SIGNAL_CONFIDENCE_FALLBACK',
        candleTime,
      },
    };
  }

  private wasSent(fingerprint: string): boolean {
    const row = this.database.db.prepare(`
      SELECT 1 FROM telegram_events
      WHERE event_type = 'FOREX_SIGNAL' AND status = 'SENT' AND payload LIKE ?
      LIMIT 1
    `).get(`%${fingerprint}%`);
    return Boolean(row);
  }

  private recordTelegramSignal(signal: Opportunity, status: 'SENT' | 'ERROR', error?: string): void {
    this.database.db.prepare(`
      INSERT INTO telegram_events(trade_id, event_type, status, payload, error, created_at)
      VALUES(NULL, 'FOREX_SIGNAL', ?, ?, ?, ?)
    `).run(
      status,
      JSON.stringify({ fingerprint: signal.signalFingerprint, signalId: signal.signalId, symbol: signal.symbol }),
      error ?? null,
      Date.now(),
    );
  }

  private saveState(value: Record<string, unknown>): void {
    this.database.db.prepare(`
      INSERT INTO engine_state(key, value, updated_at)
      VALUES('forexScanner', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(JSON.stringify(value), Date.now());
  }
}

function normalizeDisplaySymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace('/', '');
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function roundKey(value: number): string {
  return Number(value.toPrecision(10)).toString();
}
