import crypto from 'node:crypto';
import { opportunityScore } from './analysis.js';
import { analyzeStructureStrategyV335, runRollingBacktestV335 } from './analysisV335.js';
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
    if (!settings.engineEnabled) {
      this.saveState({ status: 'PAUSED', completedAt: Date.now(), mode: 'SIGNAL_ONLY' });
      return;
    }
    if (!settings.forexEnabled) {
      this.saveState({ status: 'DISABLED', completedAt: Date.now(), mode: 'SIGNAL_ONLY' });
      return;
    }
    if (!this.market.hasCredentials()) {
      this.saveState({ status: 'WAITING_FOREX_DATA_KEY', completedAt: Date.now(), mode: 'SIGNAL_ONLY' });
      return;
    }
    if (!this.telegram.isConfigured()) {
      this.saveState({ status: 'WAITING_TELEGRAM', completedAt: Date.now(), mode: 'SIGNAL_ONLY' });
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
          this.clearSymbolError(symbol);
          if (signal) freshSignals.push(signal);
        } catch (error) {
          errors++;
          this.saveSymbolError(symbol, error);
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
        status: errors === symbols.length && symbols.length > 0 ? 'DATA_ERROR' : 'IDLE',
        mode: 'SIGNAL_ONLY', provider: 'TWELVE_DATA',
        startedAt, completedAt: Date.now(), total: symbols.length, scanned: symbols.length,
        signals: freshSignals.length, qualified: qualified.length, sent, errors,
        diagnostic: freshSignals.length === 0 && errors === 0 ? 'NO_VALID_SETUP_NOW' : undefined,
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
    if (ltf.length < 80 || htf.length < 200) throw new Error(`FOREX_INSUFFICIENT_CANDLES:${symbol}:ltf=${ltf.length}:htf=${htf.length}`);

    const signal = analyzeStructureStrategyV335(ltf, htf, symbol);
    if (!signal) {
      this.signalZoneActive.set(symbol, false);
      return null;
    }

    if (this.signalZoneActive.get(symbol) === true) return null;
    this.signalZoneActive.set(symbol, true);

    const backtest = runRollingBacktestV335(symbol, ltf, htf);
    const rollingWinRate = backtest.tradesEvaluated === 0 ? signal.confidence : backtest.winRate;
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
        rollingWinRateSource: backtest.tradesEvaluated === 0 ? 'SIGNAL_CONFIDENCE_NO_BACKTEST_TRADES' : 'ROLLING_BACKTEST',
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

  private saveSymbolError(symbol: string, error: unknown): void {
    this.database.db.prepare(`
      INSERT INTO engine_state(key, value, updated_at)
      VALUES(?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(
      `forexScannerError:${symbol}`,
      JSON.stringify({ symbol, error: error instanceof Error ? error.message : String(error), at: Date.now() }),
      Date.now(),
    );
  }

  private clearSymbolError(symbol: string): void {
    this.database.db.prepare(`DELETE FROM engine_state WHERE key = ?`).run(`forexScannerError:${symbol}`);
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
