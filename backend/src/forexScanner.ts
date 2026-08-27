import crypto from 'node:crypto';
import { opportunityScore } from './analysis.js';
import { analyzeStructureStrategyV335, runRollingBacktestV335 } from './analysisV335.js';
import { TradingDatabase } from './database.js';
import { ForexDataClient } from './forexData.js';
import { ForexSignalTracker } from './forexSignalTracker.js';
import { TradingRepository } from './repositories.js';
import { TelegramService } from './telegram.js';
import type { EngineSettings, Opportunity } from './types.js';
import type { Candle, AnalysisSignal } from './analysis.js';

const LEGACY_DEFAULTS = ['EURUSD', 'GBPUSD', 'USDJPY', 'EURJPY'];
const EXPANDED_DEFAULTS = [
  'EURUSD', 'GBPUSD', 'USDJPY', 'EURJPY',
  'AUDUSD', 'USDCAD', 'USDCHF', 'NZDUSD',
  'GBPJPY', 'AUDJPY', 'EURGBP', 'EURAUD',
  'XAUUSD',
];
const BASIC_DAILY_BUDGET_TARGET = 720;
const ENTRY_TIMEFRAME_MINUTES = 5;
const RECENT_SETUP_LOOKBACK_MINUTES = 60;

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
    this.sanitizeSettings();
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async runCycle(forceManual = false): Promise<void> {
    if (this.running) return;
    this.sanitizeSettings();
    const settings = this.getSettings();
    if (!settings.engineEnabled && !forceManual) {
      this.saveState({ status: 'PAUSED', completedAt: Date.now(), mode: 'SIGNAL_ONLY', automatic: true, timeframe: '5m/15m', strategy: 'R10_HIGH_WR_SWEEP', performance: this.tracker.summary(2000) });
      return;
    }
    if (!settings.forexEnabled) {
      this.saveState({ status: 'DISABLED', completedAt: Date.now(), mode: 'SIGNAL_ONLY', automatic: true, timeframe: '5m/15m', strategy: 'R10_HIGH_WR_SWEEP', performance: this.tracker.summary(2000) });
      return;
    }
    if (!this.market.hasCredentials()) {
      this.saveState({ status: 'WAITING_FOREX_DATA_KEY', completedAt: Date.now(), mode: 'SIGNAL_ONLY', automatic: true, timeframe: '5m/15m', strategy: 'R10_HIGH_WR_SWEEP', performance: this.tracker.summary(2000) });
      return;
    }

    const telegramConfigured = this.telegram.isConfigured();
    this.running = true;
    const symbols = [...new Set(settings.forexSymbols
      .map((symbol) => normalizeDisplaySymbol(symbol))
      .filter((symbol) => Boolean(symbol) && symbol !== 'NAS100'))];
    const freshSignals: Opportunity[] = [];
    let errors = 0;
    let scanned = 0;
    let rateLimited = false;
    const startedAt = Date.now();
    const effectiveIntervalMinutes = this.effectiveIntervalMinutes(settings, symbols.length);

    try {
      this.saveState({
        status: 'SCANNING', mode: 'SIGNAL_ONLY', provider: 'TWELVE_DATA', automatic: true,
        timeframe: '5m/15m', strategy: 'R10_HIGH_WR_SWEEP',
        trigger: forceManual ? 'API_FORCE' : 'AUTOMATIC',
        telegramDelivery: telegramConfigured ? 'ENABLED' : 'DISABLED_NOT_CONFIGURED',
        startedAt, total: symbols.length, scanned: 0, signals: 0, errors: 0,
        configuredIntervalMinutes: settings.forexSignalScanIntervalMinutes,
        effectiveIntervalMinutes,
        estimatedDailyCredits: estimateDailyCredits(symbols.length, effectiveIntervalMinutes),
        requestModel: 'ONE_M5_REQUEST_DERIVE_M15',
        recentSetupLookbackMinutes: RECENT_SETUP_LOOKBACK_MINUTES,
        symbols,
        performance: this.tracker.summary(2000),
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
          timeframe: '5m/15m', strategy: 'R10_HIGH_WR_SWEEP',
          trigger: forceManual ? 'API_FORCE' : 'AUTOMATIC',
          telegramDelivery: telegramConfigured ? 'ENABLED' : 'DISABLED_NOT_CONFIGURED',
          startedAt, total: symbols.length, scanned, current: symbol,
          signals: freshSignals.length, errors, usage: this.market.getUsage(), symbols,
          configuredIntervalMinutes: settings.forexSignalScanIntervalMinutes,
          effectiveIntervalMinutes,
          estimatedDailyCredits: estimateDailyCredits(symbols.length, effectiveIntervalMinutes),
          requestModel: 'ONE_M5_REQUEST_DERIVE_M15',
          recentSetupLookbackMinutes: RECENT_SETUP_LOOKBACK_MINUTES,
          performance: this.tracker.summary(2000),
        });
      }

      const qualified = freshSignals
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
          ? 'NO_ACTIONABLE_R10_M5_M15_SETUP_IN_RECENT_WINDOW'
          : undefined;

      this.saveState({
        status, mode: 'SIGNAL_ONLY', provider: 'TWELVE_DATA', automatic: true,
        timeframe: '5m/15m', strategy: 'R10_HIGH_WR_SWEEP',
        trigger: forceManual ? 'API_FORCE' : 'AUTOMATIC',
        telegramDelivery: telegramConfigured ? 'ENABLED' : 'DISABLED_NOT_CONFIGURED',
        startedAt, completedAt: Date.now(), total: symbols.length, scanned,
        signals: freshSignals.length, qualified: qualified.length, sent, errors, deliveryErrors,
        diagnostic, usage: this.market.getUsage(),
        configuredIntervalMinutes: settings.forexSignalScanIntervalMinutes,
        effectiveIntervalMinutes,
        estimatedDailyCredits: estimateDailyCredits(symbols.length, effectiveIntervalMinutes),
        nextScanMinutes: effectiveIntervalMinutes,
        requestModel: 'ONE_M5_REQUEST_DERIVE_M15',
        recentSetupLookbackMinutes: RECENT_SETUP_LOOKBACK_MINUTES,
        symbols,
        performance: this.tracker.summary(2000),
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
        timeframe: '5m/15m', strategy: 'R10_HIGH_WR_SWEEP',
        error: error instanceof Error ? error.message : String(error), at: Date.now(),
        performance: this.tracker.summary(2000),
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
      throw new Error(`FOREX_INSUFFICIENT_CANDLES:${symbol}:${dataSymbol}:m5=${ltf.length}:m15=${htf.length}`);
    }

    this.tracker.updateFromCandles(symbol, ltf);
    const triggered = findLatestActionableSignal(ltf, htf, symbol, RECENT_SETUP_LOOKBACK_MINUTES);
    if (!triggered) {
      this.signalZoneActive.set(symbol, false);
      return null;
    }
    if (this.signalZoneActive.get(symbol) === true) return null;

    const currentPrice = ltf.at(-1)!.close;
    const rebased = rebaseSignalAtCurrentPrice(triggered.signal, currentPrice);
    if (!rebased) return null;

    // Validate with the deeper M5/M15 series, not only the 100-bar trigger window.
    const backtest = runRollingBacktestV335(symbol, ltf, htf);
    const rollingWinRate = backtest.tradesEvaluated < 3
      ? Math.max(rebased.confidence, backtest.winRate)
      : backtest.winRate;
    const settings = this.getSettings();
    if (rebased.confidence < settings.forexMinSignalConfidence || rollingWinRate < settings.forexMinRollingWinRate) {
      // Do not arm the dedupe zone for a setup that was not admitted; the next closed
      // M5 candle may improve the rolling evidence enough to become actionable.
      this.signalZoneActive.set(symbol, false);
      return null;
    }
    this.signalZoneActive.set(symbol, true);

    const score = opportunityScore(rebased, backtest, 60);
    const fingerprint = sha256([
      'FOREX-R10-M5-M15', symbol, dataSymbol, rebased.side, rebased.strategy, String(triggered.candleTime),
      roundKey(rebased.stopLoss), roundKey(rebased.takeProfit),
    ].join('|'));

    return {
      id: `OP-FX-${fingerprint.slice(0, 24)}`,
      signalId: `SIG-FX-${fingerprint.slice(0, 24)}`,
      signalFingerprint: fingerprint,
      broker: 'MT5', symbol, side: rebased.side, timeframe: '5m/15m', strategy: rebased.strategy,
      confidence: rebased.confidence, rollingWinRate, expectancy: backtest.expectancyPct, score,
      entry: rebased.entry, stopLoss: rebased.stopLoss, takeProfit: rebased.takeProfit,
      tp2: rebased.tp2, tp3: rebased.tp3, createdAt: Date.now(),
      metadata: {
        executionMode: 'SIGNAL_ONLY', dataProvider: 'TWELVE_DATA', dataSymbol,
        reason: rebased.reason, atr: rebased.atr, backtest,
        rollingWinRateSource: backtest.tradesEvaluated < 3 ? 'CALIBRATING_CONFIDENCE_FLOOR' : 'ROLLING_BACKTEST_R10',
        candleTime: triggered.candleTime, triggerLagMinutes: triggered.triggerLagMinutes,
        reanchoredAtCurrentPrice: triggered.triggerLagMinutes > 0,
        decisionWindows: { m5: 100, m15: 210, rollingM5: ltf.length },
        targetProfile: 'TP1_0.60R_TP2_1.00R_TP3_1.50R',
      },
    };
  }

  private sanitizeSettings(): void {
    const settings = this.getSettings();
    const normalized = settings.forexSymbols
      .map(normalizeDisplaySymbol)
      .filter((symbol) => Boolean(symbol) && symbol !== 'NAS100');
    const symbols = sameSet(normalized, LEGACY_DEFAULTS) ? EXPANDED_DEFAULTS : [...new Set(normalized)];
    const next: EngineSettings = {
      ...settings,
      forexSymbols: symbols.length ? symbols : EXPANDED_DEFAULTS,
      forexMinRollingWinRate: settings.forexMinRollingWinRate === 70 ? 64 : settings.forexMinRollingWinRate,
      forexMinSignalConfidence: settings.forexMinSignalConfidence === 75 ? 74 : settings.forexMinSignalConfidence,
      forexSignalScanIntervalMinutes: settings.forexSignalScanIntervalMinutes === 60 ? 30 : settings.forexSignalScanIntervalMinutes,
      forexSignalsPerCycle: Math.max(6, settings.forexSignalsPerCycle),
      forexExecutionMode: 'SIGNAL_ONLY',
    };
    const changed = JSON.stringify(next) !== JSON.stringify(settings);
    if (changed) this.database.saveSettings(next);
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
    `).run(status, JSON.stringify({ fingerprint: signal.signalFingerprint, signalId: signal.signalId, symbol: signal.symbol }), error ?? null, Date.now());
  }

  private saveSymbolError(symbol: string, error: unknown): void {
    this.database.db.prepare(`
      INSERT INTO engine_state(key, value, updated_at) VALUES(?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(`forexScannerError:${symbol}`, JSON.stringify({ symbol, error: error instanceof Error ? error.message : String(error), at: Date.now() }), Date.now());
  }

  private clearSymbolError(symbol: string): void {
    this.database.db.prepare(`DELETE FROM engine_state WHERE key = ?`).run(`forexScannerError:${symbol}`);
  }

  private saveState(value: Record<string, unknown>): void {
    this.database.db.prepare(`
      INSERT INTO engine_state(key, value, updated_at) VALUES('forexScanner', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(JSON.stringify(value), Date.now());
  }
}

function findLatestActionableSignal(ltf: Candle[], htf: Candle[], symbol: string, lookbackMinutes: number): TriggeredSignal | null {
  const lastIndex = ltf.length - 1;
  const lookbackBars = Math.max(1, Math.ceil(lookbackMinutes / ENTRY_TIMEFRAME_MINUTES));
  const firstIndex = Math.max(99, lastIndex - lookbackBars);
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
      signal, ltfWindow, htfWindow: eligibleHtf, candleTime,
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
  const originalRisk = Math.abs(signal.entry - signal.stopLoss);
  const newRisk = signal.side === 'BUY' ? currentPrice - signal.stopLoss : signal.stopLoss - currentPrice;
  if (!(originalRisk > 0) || !(newRisk > 0)) return null;

  const tp1R = Math.abs(signal.takeProfit - signal.entry) / originalRisk;
  const tp2R = Math.abs(signal.tp2 - signal.entry) / originalRisk;
  const tp3R = Math.abs(signal.tp3 - signal.entry) / originalRisk;
  const direction = signal.side === 'BUY' ? 1 : -1;
  return {
    ...signal,
    entry: currentPrice,
    takeProfit: currentPrice + direction * newRisk * tp1R,
    tp2: currentPrice + direction * newRisk * tp2R,
    tp3: currentPrice + direction * newRisk * tp3R,
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
function sha256(value: string): string { return crypto.createHash('sha256').update(value).digest('hex'); }
function roundKey(value: number): string { return Number(value.toPrecision(10)).toString(); }
