import crypto from 'node:crypto';
import { opportunityScore } from './analysis.js';
import { analyzeStructureStrategyV335, runRollingBacktestV335 } from './analysisV335.js';
import { TradingDatabase } from './database.js';
import { ForexDataClient } from './forexData.js';
import { ForexSignalTracker } from './forexSignalTracker.js';
import { TradingRepository } from './repositories.js';
import { TelegramService } from './telegram.js';
import type { EngineSettings, Opportunity, TradeSide } from './types.js';
import type { Candle, AnalysisSignal } from './analysis.js';

const LEGACY_DEFAULTS = ['EURUSD', 'GBPUSD', 'USDJPY', 'EURJPY'];
const EXPANDED_DEFAULTS = [
  'EURUSD', 'GBPUSD', 'USDJPY', 'EURJPY',
  'AUDUSD', 'USDCAD', 'USDCHF', 'NZDUSD',
  'GBPJPY', 'AUDJPY', 'EURGBP', 'EURAUD',
  'XAUUSD', 'NAS100',
];
const BASIC_DAILY_BUDGET_TARGET = 720;
const RECENT_SETUP_LOOKBACK_MINUTES = 30;

interface TriggeredSignal {
  signal: AnalysisSignal;
  ltfWindow: Candle[];
  htfWindow: Candle[];
  candleTime: number;
  triggerLagMinutes: number;
}

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
      this.saveState({ status: 'PAUSED', completedAt: Date.now(), mode: 'SIGNAL_ONLY', automatic: true, performance: this.tracker.summary(20) });
      return;
    }
    if (!settings.forexEnabled) {
      this.saveState({ status: 'DISABLED', completedAt: Date.now(), mode: 'SIGNAL_ONLY', automatic: true, performance: this.tracker.summary(20) });
      return;
    }
    if (!this.market.hasCredentials()) {
      this.saveState({ status: 'WAITING_FOREX_DATA_KEY', completedAt: Date.now(), mode: 'SIGNAL_ONLY', automatic: true, performance: this.tracker.summary(20) });
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
        status: 'SCANNING', mode: 'SIGNAL_ONLY', provider: 'TWELVE_DATA', automatic: true,
        trigger: forceManual ? 'API_FORCE' : 'AUTOMATIC',
        telegramDelivery: telegramConfigured ? 'ENABLED' : 'DISABLED_NOT_CONFIGURED',
        startedAt, total: symbols.length, scanned: 0, signals: 0, errors: 0,
        configuredIntervalMinutes: settings.forexSignalScanIntervalMinutes,
        effectiveIntervalMinutes,
        estimatedDailyCredits: estimateDailyCredits(symbols.length, effectiveIntervalMinutes),
        requestModel: 'ONE_M1_REQUEST_DERIVE_M15',
        recentSetupLookbackMinutes: RECENT_SETUP_LOOKBACK_MINUTES,
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
          status: 'SCANNING', mode: 'SIGNAL_ONLY', provider: 'TWELVE_DATA', automatic: true,
          trigger: forceManual ? 'API_FORCE' : 'AUTOMATIC',
          telegramDelivery: telegramConfigured ? 'ENABLED' : 'DISABLED_NOT_CONFIGURED',
          startedAt, total: symbols.length, scanned, current: symbol,
          signals: freshSignals.length, errors, usage: this.market.getUsage(), symbols,
          configuredIntervalMinutes: settings.forexSignalScanIntervalMinutes,
          effectiveIntervalMinutes,
          estimatedDailyCredits: estimateDailyCredits(symbols.length, effectiveIntervalMinutes),
          requestModel: 'ONE_M1_REQUEST_DERIVE_M15',
          recentSetupLookbackMinutes: RECENT_SETUP_LOOKBACK_MINUTES,
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
          ? 'NO_ACTIONABLE_SETUP_IN_RECENT_WINDOW'
          : undefined;

      this.saveState({
        status,
        mode: 'SIGNAL_ONLY', provider: 'TWELVE_DATA', automatic: true,
        trigger: forceManual ? 'API_FORCE' : 'AUTOMATIC',
        telegramDelivery: telegramConfigured ? 'ENABLED' : 'DISABLED_NOT_CONFIGURED',
        startedAt, completedAt: Date.now(), total: symbols.length, scanned,
        signals: freshSignals.length, qualified: qualified.length, sent, errors, deliveryErrors,
        diagnostic,
        usage: this.market.getUsage(),
        configuredIntervalMinutes: settings.forexSignalScanIntervalMinutes,
        effectiveIntervalMinutes,
        estimatedDailyCredits: estimateDailyCredits(symbols.length, effectiveIntervalMinutes),
        nextScanMinutes: effectiveIntervalMinutes,
        requestModel: 'ONE_M1_REQUEST_DERIVE_M15',
        recentSetupLookbackMinutes: RECENT_SETUP_LOOKBACK_MINUTES,
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
        status: 'ERROR', mode: 'SIGNAL_ONLY', provider: 'TWELVE_DATA', automatic: true,
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

    this.tracker.updateFromCandles(symbol, ltf);

    const triggered = findLatestActionableSignal(ltf, htf, symbol, RECENT_SETUP_LOOKBACK_MINUTES);
    if (!triggered) {
      this.signalZoneActive.set(symbol, false);
      return null;
    }

    if (this.signalZoneActive.get(symbol) === true) return null;
    this.signalZoneActive.set(symbol, true);

    const currentPrice = ltf.at(-1)!.close;
    const rebased = rebaseSignalAtCurrentPrice(triggered.signal, currentPrice);
    if (!rebased) return null;

    const backtest = runRollingBacktestV335(symbol, triggered.ltfWindow, triggered.htfWindow);
    const rollingWinRate = backtest.tradesEvaluated === 0 ? rebased.confidence : backtest.winRate;
    const score = opportunityScore(rebased, backtest, 60);
    const fingerprint = sha256([
      'FOREX-SIGNAL-R9', symbol, dataSymbol, rebased.side, rebased.strategy, String(triggered.candleTime),
      roundKey(rebased.stopLoss), roundKey(rebased.takeProfit),
    ].join('|'));

    return {
      id: `OP-FX-${fingerprint.slice(0, 24)}`,
      signalId: `SIG-FX-${fingerprint.slice(0, 24)}`,
      signalFingerprint: fingerprint,
      broker: 'MT5',
      symbol,
      side: rebased.side,
      timeframe: '1m/15m',
      strategy: rebased.strategy,
      confidence: rebased.confidence,
      rollingWinRate,
      expectancy: backtest.expectancyPct,
      score,
      entry: rebased.entry,
      stopLoss: rebased.stopLoss,
      takeProfit: rebased.takeProfit,
      tp2: rebased.tp2,
      tp3: rebased.tp3,
      createdAt: Date.now(),
      metadata: {
        executionMode: 'SIGNAL_ONLY',
        dataProvider: 'TWELVE_DATA',
        dataSymbol,
        reason: rebased.reason,
        atr: rebased.atr,
        backtest,
        rollingWinRateSource: backtest.tradesEvaluated === 0 ? 'SIGNAL_CONFIDENCE_NO_BACKTEST_TRADES' : 'ROLLING_BACKTEST',
        candleTime: triggered.candleTime,
        triggerLagMinutes: triggered.triggerLagMinutes,
        reanchoredAtCurrentPrice: triggered.triggerLagMinutes > 0,
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
      // 14 instruments × 1 request × 48 cycles/day (30 min) = 672 credits/day.
      forexSignalScanIntervalMinutes: Math.max(30, settings.forexSignalScanIntervalMinutes),
      forexSignalsPerCycle: Math.max(6, settings.forexSignalsPerCycle),
      forexExecutionMode: 'SIGNAL_ONLY',
    });
  }

  private effectiveIntervalMinutes(settings: EngineSettings, symbolCount: number): number {
    const configured = Math.max(1, Number(settings.forexSignalScanIntervalMinutes || 30));
    const minimumForDailyBudget = Math.ceil(Math.max(1, symbolCount) * 1440 / BASIC_DAILY_BUDGET_TARGET);
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

function findLatestActionableSignal(
  ltf: Candle[],
  htf: Candle[],
  symbol: string,
  lookbackMinutes: number,
): TriggeredSignal | null {
  const lastIndex = ltf.length - 1;
  const firstIndex = Math.max(99, lastIndex - Math.max(0, lookbackMinutes));
  const currentPrice = ltf[lastIndex]?.close ?? 0;

  for (let i = lastIndex; i >= firstIndex; i--) {
    const ltfWindow = ltf.slice(i - 99, i + 1);
    if (ltfWindow.length !== 100) continue;
    const candleTime = ltf[i].time;
    const eligibleHtf = htf.filter((candle) => candle.time <= candleTime).slice(-210);
    if (eligibleHtf.length !== 210) continue;

    const signal = analyzeStructureStrategyV335(ltfWindow, eligibleHtf, symbol);
    if (!signal || !isStillActionable(signal, currentPrice)) continue;

    return {
      signal,
      ltfWindow,
      htfWindow: eligibleHtf,
      candleTime,
      triggerLagMinutes: Math.max(0, Math.round((ltf[lastIndex].time - candleTime) / 60_000)),
    };
  }
  return null;
}

function isStillActionable(signal: AnalysisSignal, currentPrice: number): boolean {
  if (!(currentPrice > 0)) return false;
  const risk = Math.abs(signal.entry - signal.stopLoss);
  if (!(risk > 0)) return false;

  if (signal.side === 'BUY') {
    if (currentPrice <= signal.stopLoss || currentPrice >= signal.takeProfit) return false;
    const progress = currentPrice - signal.entry;
    return progress <= risk * 0.45 && progress >= -risk * 0.35;
  }

  if (currentPrice >= signal.stopLoss || currentPrice <= signal.takeProfit) return false;
  const progress = signal.entry - currentPrice;
  return progress <= risk * 0.45 && progress >= -risk * 0.35;
}

function rebaseSignalAtCurrentPrice(signal: AnalysisSignal, currentPrice: number): AnalysisSignal | null {
  if (!(currentPrice > 0)) return null;
  const risk = signal.side === 'BUY'
    ? currentPrice - signal.stopLoss
    : signal.stopLoss - currentPrice;
  if (!(risk > 0)) return null;

  const takeProfit = signal.side === 'BUY' ? currentPrice + risk * 1.35 : currentPrice - risk * 1.35;
  const tp2 = signal.side === 'BUY' ? currentPrice + risk * 2.2 : currentPrice - risk * 2.2;
  const tp3 = signal.side === 'BUY' ? currentPrice + risk * 3.5 : currentPrice - risk * 3.5;
  return {
    ...signal,
    entry: currentPrice,
    takeProfit,
    tp2,
    tp3,
    reason: `${signal.reason}_RECENT_ACTIONABLE`,
  };
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
  return Math.ceil(Math.max(1, symbolCount) * (1440 / Math.max(1, intervalMinutes)));
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
