import crypto from 'node:crypto';
import { TradingDatabase } from './database.js';
import { ForexDataClient } from './forexData.js';
import { ForexSignalTracker } from './forexSignalTracker.js';
import { calibrateR11Async } from './r11Calibration.js';
import { latestPendingSetupR11, type R11Model } from './highWinrateR11.js';
import { TradingRepository } from './repositories.js';
import { TelegramService } from './telegram.js';
import type { EngineSettings, Opportunity } from './types.js';

const LEGACY_DEFAULTS = ['EURUSD', 'GBPUSD', 'USDJPY', 'EURJPY'];
const EXPANDED_DEFAULTS = [
  'EURUSD', 'GBPUSD', 'USDJPY', 'EURJPY',
  'AUDUSD', 'USDCAD', 'USDCHF', 'NZDUSD',
  'GBPJPY', 'AUDJPY', 'EURGBP', 'EURAUD',
  'XAUUSD',
];
const MODEL_TTL_MS = 24 * 60 * 60_000;
const R11_STRATEGY = 'R11_CALIBRATED_SWEEP_RETEST_M5_M15';
const M5_MS = 5 * 60_000;

interface ForexModelCache {
  symbol: string;
  dataSymbol: string;
  calibratedAt: number;
  model: R11Model;
}

interface ScanResult {
  opportunity: Opportunity | null;
  modelReady: boolean;
  modelStatus: string;
  calibratedNow: boolean;
}

export class ForexMarketScanner {
  private running = false;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
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
      this.saveState({ status: 'PAUSED', completedAt: Date.now(), mode: 'SIGNAL_ONLY', automatic: true, timeframe: '5m/15m', strategy: R11_STRATEGY, performance: this.tracker.summary(2000) });
      return;
    }
    if (!settings.forexEnabled) {
      this.saveState({ status: 'DISABLED', completedAt: Date.now(), mode: 'SIGNAL_ONLY', automatic: true, timeframe: '5m/15m', strategy: R11_STRATEGY, performance: this.tracker.summary(2000) });
      return;
    }
    if (!this.market.hasCredentials()) {
      this.saveState({ status: 'WAITING_FOREX_DATA_KEY', completedAt: Date.now(), mode: 'SIGNAL_ONLY', automatic: true, timeframe: '5m/15m', strategy: R11_STRATEGY, performance: this.tracker.summary(2000) });
      return;
    }

    const telegramConfigured = this.telegram.isConfigured();
    this.running = true;
    const symbols = [...new Set(settings.forexSymbols
      .map((symbol) => normalizeDisplaySymbol(symbol))
      .filter((symbol) => Boolean(symbol) && symbol !== 'NAS100'))];
    const freshSignals: Opportunity[] = [];
    const modelStates: Array<{ symbol: string; ready: boolean; status: string; calibratedNow: boolean }> = [];
    let errors = 0;
    let scanned = 0;
    let rateLimited = false;
    const startedAt = Date.now();
    const effectiveIntervalMinutes = Math.max(1, Number(settings.forexSignalScanIntervalMinutes || 5));

    try {
      this.saveState({
        status: 'SCANNING', mode: 'SIGNAL_ONLY', provider: 'TWELVE_DATA', automatic: true,
        timeframe: '5m/15m', strategy: R11_STRATEGY,
        trigger: forceManual ? 'API_FORCE' : 'AUTOMATIC',
        telegramDelivery: telegramConfigured ? 'ENABLED' : 'DISABLED_NOT_CONFIGURED',
        startedAt, total: symbols.length, scanned: 0, signals: 0, errors: 0,
        configuredIntervalMinutes: settings.forexSignalScanIntervalMinutes,
        effectiveIntervalMinutes,
        estimatedDailyCredits: estimateDailyCredits(symbols.length, effectiveIntervalMinutes),
        requestModel: 'M5_LIVE_PLUS_DAILY_R11_CALIBRATION',
        pendingRetestBars: 3,
        symbols,
        performance: this.tracker.summary(2000),
      });

      for (const symbol of symbols) {
        try {
          const result = await this.scanSymbol(symbol);
          modelStates.push({ symbol, ready: result.modelReady, status: result.modelStatus, calibratedNow: result.calibratedNow });
          this.clearSymbolError(symbol);
          if (result.opportunity) freshSignals.push(result.opportunity);
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
          timeframe: '5m/15m', strategy: R11_STRATEGY,
          trigger: forceManual ? 'API_FORCE' : 'AUTOMATIC',
          telegramDelivery: telegramConfigured ? 'ENABLED' : 'DISABLED_NOT_CONFIGURED',
          startedAt, total: symbols.length, scanned, current: symbol,
          signals: freshSignals.length, errors, usage: this.market.getUsage(), symbols,
          configuredIntervalMinutes: settings.forexSignalScanIntervalMinutes,
          effectiveIntervalMinutes,
          estimatedDailyCredits: estimateDailyCredits(symbols.length, effectiveIntervalMinutes),
          requestModel: 'M5_LIVE_PLUS_DAILY_R11_CALIBRATION',
          pendingRetestBars: 3,
          modelsReady: modelStates.filter((row) => row.ready).length,
          modelsRejected: modelStates.filter((row) => !row.ready).length,
          modelStates: modelStates.slice(-20),
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

      const readyModels = modelStates.filter((row) => row.ready).length;
      const status = rateLimited
        ? 'DATA_LIMIT'
        : scanned > 0 && errors === scanned
          ? 'DATA_ERROR'
          : errors > 0
            ? 'IDLE_WITH_ERRORS'
            : 'IDLE';
      const diagnostic = rateLimited
        ? 'TWELVE_DATA_RATE_LIMIT_OR_DAILY_QUOTA'
        : readyModels === 0 && modelStates.length > 0
          ? 'NO_POSITIVE_R11_MODEL_IN_CONFIGURED_FOREX_SYMBOLS'
          : freshSignals.length === 0 && errors === 0
            ? 'R11_MODELS_READY_BUT_NO_PENDING_RETEST_SETUP_NOW'
            : undefined;

      this.saveState({
        status, mode: 'SIGNAL_ONLY', provider: 'TWELVE_DATA', automatic: true,
        timeframe: '5m/15m', strategy: R11_STRATEGY,
        trigger: forceManual ? 'API_FORCE' : 'AUTOMATIC',
        telegramDelivery: telegramConfigured ? 'ENABLED' : 'DISABLED_NOT_CONFIGURED',
        startedAt, completedAt: Date.now(), total: symbols.length, scanned,
        signals: freshSignals.length, qualified: qualified.length, sent, errors, deliveryErrors,
        diagnostic, usage: this.market.getUsage(),
        configuredIntervalMinutes: settings.forexSignalScanIntervalMinutes,
        effectiveIntervalMinutes,
        estimatedDailyCredits: estimateDailyCredits(symbols.length, effectiveIntervalMinutes),
        nextScanMinutes: effectiveIntervalMinutes,
        requestModel: 'M5_LIVE_PLUS_DAILY_R11_CALIBRATION',
        pendingRetestBars: 3,
        modelsReady: readyModels,
        modelsRejected: modelStates.filter((row) => !row.ready).length,
        modelStates,
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
        timeframe: '5m/15m', strategy: R11_STRATEGY,
        error: error instanceof Error ? error.message : String(error), at: Date.now(),
        performance: this.tracker.summary(2000),
      });
      console.error('[V34] forex signal scanner:', error instanceof Error ? error.message : error);
    }

    if (!this.stopped) {
      const settings = this.getSettings();
      const delayMinutes = Math.max(1, Number(settings.forexSignalScanIntervalMinutes || 5));
      this.timer = setTimeout(() => void this.loop(), delayMinutes * 60_000);
      this.timer.unref();
    }
  }

  private async scanSymbol(symbol: string): Promise<ScanResult> {
    const cached = await this.ensureModel(symbol);
    if (!cached.model.ready) {
      return { opportunity: null, modelReady: false, modelStatus: cached.model.status, calibratedNow: cached.calibratedNow };
    }

    const { ltf, htf, dataSymbol } = await this.market.dualRates(symbol);
    this.tracker.updateFromCandles(symbol, ltf);
    const setup = latestPendingSetupR11(ltf, htf, cached.model.config, cached.model.config.pendingBars);
    if (!setup) {
      return { opportunity: null, modelReady: true, modelStatus: cached.model.status, calibratedNow: cached.calibratedNow };
    }

    const risk = setup.direction > 0 ? setup.entry - setup.sl : setup.sl - setup.entry;
    if (!(risk > 0)) return { opportunity: null, modelReady: true, modelStatus: cached.model.status, calibratedNow: cached.calibratedNow };
    const side = setup.direction > 0 ? 'BUY' as const : 'SELL' as const;
    const direction = setup.direction > 0 ? 1 : -1;
    const confidence = Math.round(clamp(setup.quality, 70, 96));
    const oos = combinedOos(cached.model);
    const settings = this.getSettings();
    if (confidence < settings.forexMinSignalConfidence || oos.winRate < settings.forexMinRollingWinRate) {
      return { opportunity: null, modelReady: true, modelStatus: cached.model.status, calibratedNow: cached.calibratedNow };
    }

    const score = clamp(oos.winRate * 0.65 + confidence * 0.25 + Math.min(10, Math.max(0, oos.profitFactor - 1) * 5), 0, 100);
    const expiresAt = setup.signalTime + (cached.model.config.pendingBars + 1) * M5_MS;
    const fingerprint = sha256([
      'FOREX-R11-PENDING-RETEST', symbol, dataSymbol, side, String(setup.signalTime),
      roundKey(setup.entry), roundKey(setup.sl), roundKey(setup.tp),
    ].join('|'));

    const opportunity: Opportunity = {
      id: `OP-FX-${fingerprint.slice(0, 24)}`,
      signalId: `SIG-FX-${fingerprint.slice(0, 24)}`,
      signalFingerprint: fingerprint,
      broker: 'MT5',
      symbol,
      side,
      timeframe: '5m/15m',
      strategy: 'CALIBRATED_SWEEP_RETEST_M5_M15_R11',
      confidence,
      rollingWinRate: oos.winRate,
      expectancy: oos.expectancyR,
      score,
      entry: setup.entry,
      stopLoss: setup.sl,
      takeProfit: setup.tp,
      tp2: setup.entry + direction * risk,
      tp3: setup.entry + direction * risk * 1.5,
      createdAt: Date.now(),
      metadata: {
        executionMode: 'SIGNAL_ONLY',
        dataProvider: 'TWELVE_DATA',
        dataSymbol,
        orderType: setup.direction > 0 ? 'BUY_LIMIT' : 'SELL_LIMIT',
        pendingRetest: true,
        pendingBars: cached.model.config.pendingBars,
        expiresAt,
        signalTime: setup.signalTime,
        sweepExtreme: setup.sweepExtreme,
        liquidityLevel: setup.liquidity,
        reason: `R11 sweep/reclaim + MSS confirmado; esperar retest LIMIT ${roundKey(setup.entry)}`,
        modelStatus: cached.model.status,
        modelFallback: cached.model.fallback,
        modelConfig: cached.model.config,
        modelTrain: cached.model.train,
        modelValidation: cached.model.validation,
        modelHoldout: cached.model.holdout,
        oos,
        targetProfile: `TP1_${cached.model.config.rr.toFixed(2)}R_TP2_1.00R_TP3_1.50R`,
      },
    };

    return { opportunity, modelReady: true, modelStatus: cached.model.status, calibratedNow: cached.calibratedNow };
  }

  private async ensureModel(symbol: string): Promise<ForexModelCache & { calibratedNow: boolean }> {
    const existing = this.loadModel(symbol);
    if (existing && Date.now() - existing.calibratedAt < MODEL_TTL_MS) return { ...existing, calibratedNow: false };

    const deep = await this.market.dualRatesCalibration(symbol);
    const model = await calibrateR11Async(deep.ltf, deep.htf);
    const row: ForexModelCache = {
      symbol,
      dataSymbol: deep.dataSymbol,
      calibratedAt: Date.now(),
      model,
    };
    this.saveModel(row);
    return { ...row, calibratedNow: true };
  }

  private loadModel(symbol: string): ForexModelCache | null {
    const row = this.database.db.prepare(`SELECT value FROM engine_state WHERE key=?`).get(`forexR11Model:${symbol}`) as { value: string } | undefined;
    if (!row) return null;
    try { return JSON.parse(row.value) as ForexModelCache; }
    catch { return null; }
  }

  private saveModel(model: ForexModelCache): void {
    this.database.db.prepare(`
      INSERT INTO engine_state(key, value, updated_at) VALUES(?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(`forexR11Model:${model.symbol}`, JSON.stringify(model), Date.now());
  }

  private sanitizeSettings(): void {
    const settings = this.getSettings();
    const normalized = settings.forexSymbols
      .map(normalizeDisplaySymbol)
      .filter((symbol) => Boolean(symbol) && symbol !== 'NAS100');
    const symbols = sameSet(normalized, LEGACY_DEFAULTS) ? EXPANDED_DEFAULTS : [...new Set(normalized)];
    const migrateInterval = settings.forexSignalScanIntervalMinutes === 60 || settings.forexSignalScanIntervalMinutes === 30;
    const next: EngineSettings = {
      ...settings,
      forexSymbols: symbols.length ? symbols : EXPANDED_DEFAULTS,
      forexMinRollingWinRate: settings.forexMinRollingWinRate === 70 ? 64 : settings.forexMinRollingWinRate,
      forexMinSignalConfidence: settings.forexMinSignalConfidence === 75 || settings.forexMinSignalConfidence === 74 ? 70 : settings.forexMinSignalConfidence,
      forexSignalScanIntervalMinutes: migrateInterval ? 5 : settings.forexSignalScanIntervalMinutes,
      forexSignalsPerCycle: Math.max(6, settings.forexSignalsPerCycle),
      forexExecutionMode: 'SIGNAL_ONLY',
    };
    if (JSON.stringify(next) !== JSON.stringify(settings)) this.database.saveSettings(next);
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

function combinedOos(model: R11Model) {
  const trades = model.validation.trades + model.holdout.trades;
  const wins = model.validation.wins + model.holdout.wins;
  const grossWinR = model.validation.grossWinR + model.holdout.grossWinR;
  const grossLossR = model.validation.grossLossR + model.holdout.grossLossR;
  const sumR = model.validation.sumR + model.holdout.sumR;
  return {
    trades,
    winRate: trades ? wins / trades * 100 : 0,
    expectancyR: trades ? sumR / trades : 0,
    profitFactor: grossLossR < 0 ? grossWinR / Math.abs(grossLossR) : grossWinR > 0 ? 99 : 0,
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
  return Math.ceil(Math.max(1, symbolCount) * (1440 / Math.max(1, intervalMinutes)) + symbolCount);
}
function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('TWELVE_DATA_RATE_LIMIT_OR_DAILY_QUOTA') || message.includes('TWELVE_DATA_429');
}
function sha256(value: string): string { return crypto.createHash('sha256').update(value).digest('hex'); }
function roundKey(value: number): string { return Number(value.toPrecision(10)).toString(); }
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
