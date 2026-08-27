import crypto from 'node:crypto';
import { opportunityScore } from './analysis.js';
import { analyzeStructureStrategyV335, runRollingBacktestV335 } from './analysisV335.js';
import { TradingDatabase } from './database.js';
import { ForexDataClient } from './forexData.js';
import { ForexSignalTracker } from './forexSignalTracker.js';
import { TradingRepository } from './repositories.js';
import { TelegramService } from './telegram.js';
import type { EngineSettings, Opportunity } from './types.js';

const LEGACY_DEFAULTS = ['EURUSD', 'GBPUSD', 'USDJPY', 'EURJPY'];
const EXPANDED_DEFAULTS = [
  'EURUSD', 'GBPUSD', 'USDJPY', 'EURJPY',
  'AUDUSD', 'USDCAD', 'USDCHF', 'NZDUSD',
  'GBPJPY', 'AUDJPY', 'EURGBP', 'EURAUD',
  'XAUUSD', 'NAS100',
];
const BASIC_DAILY_BUDGET_TARGET = 720; // keep headroom under the 800/day Basic cap

export class ForexMarketScanner {
  private running = false;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private signalZoneActive = new Map<string, boolean>();
  private retestCount = new Map<string, number>();
  private readonly tracker: ForexSignalTracker;

  constructor(
    private readonly database: TradingDatabase,
    private readonly market: ForexDataClient,
    private readonly repository: TradingRepository,
    private readonly telegram: TelegramService,
    private readonly getSettings: () => EngineSettings,
  ) {
    this.tracker = new ForexSignalTracker(database);
  }

  start(): void {
    this.stopped = false;
    this.ensureExpandedDefaults();
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async runCycle(forceManual = false): Promise<void> {
    if (this.running) return;
    this.ensureExpandedDefaults();
    const settings = this.getSettings();
    if (!settings.engineEnabled && !forceManual) {
      this.saveState({ status: 'PAUSED', completedAt: Date.now(), mode: 'SIGNAL_ONLY', performance: this.tracker.summary(20) });
      return;
    }
    if (!settings.forexEnabled) {
      this.saveState({ status: 'DISABLED', completedAt: Date.now(), mode: 'SIGNAL_ONLY', performance: this.tracker.summary(20) });
      return;
    }
    if (!this.market.hasCredentials()) {
      this.saveState({ status: 'WAITING_FOREX_DATA_KEY', completedAt: Date.now(), mode: 'SIGNAL_ONLY', performance: this.tracker.summary(20) });
      return;
    }

    const telegramConfigured = this.telegram.isConfigured();
    this.running = true;
    const symbols = [...new Set(settings.forexSymbols.map((symbol) => normalizeDisplaySymbol(symbol)).filter(Boolean))];
    const freshSignals: Opportunity[] = [];
    let errors = 0;
    let scanned = 0;
    let rateLimited = false;
    const startedAt = Date.now();
    const effectiveIntervalMinutes = this.effectiveIntervalMinutes(settings, symbols.length);

    try {
      this.saveState({
        status: 'SCANNING', mode: 'SIGNAL_ONLY', provider: 'TWELVE_DATA',
        trigger: forceManual ? 'MANUAL' : 'SCHEDULED',
        telegramDelivery: telegramConfigured ? 'ENABLED' : 'DISABLED_NOT_CONFIGURED',
        startedAt, total: symbols.length, scanned: 0, signals: 0, errors: 0,
        configuredIntervalMinutes: settings.forexSignalScanIntervalMinutes,
        effectiveIntervalMinutes,
        estimatedDailyCredits: estimateDailyCredits(symbols.length, effectiveIntervalMinutes),
        symbols,
        performance: this.tracker.summary(20),
      });

      for (let index = 0; index < symbols.length; index++) {
        const symbol = symbols[index];
        try {
          const signal = await this.scanSymbol(symbol);
          this.clearSymbolError(symbol);
          if (signal) freshSignals.push(signal);
          scanned++;
        } catch (error) {
          errors++;
          scanned++;
          this.saveSymbolError(symbol, error);
          if (isRateLimitError(error)) {
            rateLimited = true;
            break;
          }
        }

        this.saveState({
          status: 'SCANNING', mode: 'SIGNAL_ONLY', provider: 'TWELVE_DATA',
          trigger: forceManual ? 'MANUAL' : 'SCHEDULED',
          telegramDelivery: telegramConfigured ? 'ENABLED' : 'DISABLED_NOT_CONFIGURED',
          startedAt, total: symbols.length, scanned, current: symbol,
          signals: freshSignals.length, errors, usage: this.market.getUsage(), symbols,
          configuredIntervalMinutes: settings.forexSignalScanIntervalMinutes,
          effectiveIntervalMinutes,
          estimatedDailyCredits: estimateDailyCredits(symbols.length, effectiveIntervalMinutes),
          performance: this.tracker.summary(20),
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
      let deliveryErrors = 0;
      for (const signal of qualified) {
        this.repository.saveSignal(signal);
        this.repository.rejectOpportunity(signal.id, 'FOREX_SIGNAL_ONLY_MANUAL_EXECUTION');
        this.tracker.register(signal);

        if (!telegramConfigured || this.wasSent(signal.signalFingerprint)) continue;

        const retest = (this.retestCount.get(signal.symbol) ?? 0) + 1;
        this.retestCount.set(signal.symbol, retest);
        try {
          await this.telegram.forexSignal(signal, retest);
          this.recordTelegramSignal(signal, 'SENT');
          sent++;
        } catch (error) {
          deliveryErrors++;
          this.recordTelegramSignal(signal, 'ERROR', error instanceof Error ? error.message : String(error));
        }
      }

      const status = rateLimited
        ? 'DATA_LIMIT'
        : scanned > 0 && errors === scanned
          ? 'DATA_ERROR'
          : errors > 0
            ? 'IDLE_WITH_ERRORS'
            : 'IDLE';
      const diagnostic = rateLimited
        ? 'TWELVE_DATA_RATE_LIMIT_OR_DAILY_QUOTA'
        : freshSignals.length === 0 && errors === 0
          ? 'NO_VALID_SETUP_NOW'
          : undefined;

      this.saveState({
        status,
        mode: 'SIGNAL_ONLY', provider: 'TWELVE_DATA',
        trigger: forceManual ? 'MANUAL' : 'SCHEDULED',
        telegramDelivery: telegramConfigured ? 'ENABLED' : 'DISABLED_NOT_CONFIGURED',
        startedAt, completedAt: Date.now(), total: symbols.length, scanned,
        signals: freshSignals.length, qualified: qualified.length, sent, errors, deliveryErrors,
        diagnostic,
        usage: this.market.getUsage(),
        configuredIntervalMinutes: settings.forexSignalScanIntervalMinutes,
        effectiveIntervalMinutes,
        estimatedDailyCredits: estimateDailyCredits(symbols.length, effectiveIntervalMinutes),
        nextScanMinutes: effectiveIntervalMinutes,
        symbols,
        performance: this.tracker.summary(40),
      });
    } finally {
      this.running = false;
    }
  }

  private async loop(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.runCycle(false);
    } catch (error) {
      this.saveState({
        status: 'ERROR', mode: 'SIGNAL_ONLY', provider: 'TWELVE_DATA',
        error: error instanceof Error ? error.message : String(error), at: Date.now(),
        performance: this.tracker.summary(20),
      });
      console.error('[V34] forex signal scanner:', error instanceof Error ? error.message : error);
    }

    if (!this.stopped) {
      const settings = this.getSettings();
      const delayMinutes = this.effectiveIntervalMinutes(settings, settings.forexSymbols.length);
      this.timer = setTimeout(() => void this.loop(), delayMinutes * 60_000);
      this.timer.unref();
    }
  }

  private async scanSymbol(symbol: string): Promise<Opportunity | null> {
    const { ltf, htf, dataSymbol } = await this.market.dualRates(symbol);
    if (ltf.length < 100 || htf.length < 210) {
      throw new Error(`FOREX_INSUFFICIENT_CANDLES:${symbol}:${dataSymbol}:ltf=${ltf.length}:htf=${htf.length}`);
    }

    // Resolve previous virtual Forex signals from these same candles. No extra API
    // request is needed, so performance statistics do not consume additional credits.
    this.tracker.updateFromCandles(symbol, ltf);

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
      'FOREX-SIGNAL', symbol, dataSymbol, signal.side, signal.strategy, String(candleTime),
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
        dataSymbol,
        reason: signal.reason,
        atr: signal.atr,
        backtest,
        rollingWinRateSource: backtest.tradesEvaluated === 0 ? 'SIGNAL_CONFIDENCE_NO_BACKTEST_TRADES' : 'ROLLING_BACKTEST',
        candleTime,
        decisionWindows: { m1: 100, m15: 210 },
      },
    };
  }

  private ensureExpandedDefaults(): void {
    const settings = this.getSettings();
    const current = settings.forexSymbols.map(normalizeDisplaySymbol);
    if (!sameSet(current, LEGACY_DEFAULTS)) return;

    this.database.saveSettings({
      ...settings,
      forexSymbols: EXPANDED_DEFAULTS,
      // 14 instruments × 2 timeframes × 24 hourly cycles = 672 credits/day.
      forexSignalScanIntervalMinutes: Math.max(60, settings.forexSignalScanIntervalMinutes),
      forexSignalsPerCycle: Math.max(6, settings.forexSignalsPerCycle),
      forexExecutionMode: 'SIGNAL_ONLY',
    });
  }

  private effectiveIntervalMinutes(settings: EngineSettings, symbolCount: number): number {
    const configured = Math.max(1, Number(settings.forexSignalScanIntervalMinutes || 60));
    const minimumForDailyBudget = Math.ceil(Math.max(1, symbolCount) * 2 * 1440 / BASIC_DAILY_BUDGET_TARGET);
    return Math.max(configured, minimumForDailyBudget);
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
  return symbol.trim().toUpperCase().replace(/\//g, '').replace(/\s+/g, '');
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const aa = [...a].sort();
  const bb = [...b].sort();
  return aa.every((value, index) => value === bb[index]);
}

function estimateDailyCredits(symbolCount: number, intervalMinutes: number): number {
  return Math.ceil(Math.max(1, symbolCount) * 2 * (1440 / Math.max(1, intervalMinutes)));
}

function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('TWELVE_DATA_RATE_LIMIT_OR_DAILY_QUOTA') || message.includes('TWELVE_DATA_429');
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function roundKey(value: number): string {
  return Number(value.toPrecision(10)).toString();
}
