import crypto from 'node:crypto';
import { BinanceMarketDataClient } from './binanceMarket.js';
import { assessCryptoReversal } from './cryptoReversal.js';
import { getCryptoReversalBlock } from './cryptoReversalStore.js';
import { TradingDatabase } from './database.js';
import { latestPendingSetupR11, signalFromPendingR11 } from './highWinrateR11.js';
import { OpportunityOrchestrator } from './orchestrator.js';
import { UniverseQualificationService } from './universeQualification.js';
import type { EngineSettings, Opportunity, TradeSide } from './types.js';

const STRATEGY_LABEL = 'R11_CALIBRATED_SWEEP_RETEST_M5_M15';
const EXIT_MODEL = 'R11_PENDING_RETEST_STRUCTURAL';
const SCAN_CHUNK_SIZE = 8;
const LOOP_DELAY_MS = 10_000;

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
    this.qualification = new UniverseQualificationService(database, market);
  }

  start(): void {
    this.stopped = false;
    this.sanitizeSettings();
    if (this.getSettings().cryptoEnabled && this.qualification.shouldRefresh(3)) this.qualification.runInBackground(28);
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async runCycle(): Promise<void> {
    if (this.running) return;
    this.sanitizeSettings();
    const settings = this.getSettings();
    if (!settings.engineEnabled) {
      this.saveState({ status: 'PAUSED', strategy: STRATEGY_LABEL, timeframe: '5m/15m', ...this.slotState(settings), updatedAt: Date.now() });
      return;
    }
    if (!settings.cryptoEnabled) {
      this.saveState({ status: 'DISABLED', strategy: STRATEGY_LABEL, timeframe: '5m/15m', ...this.slotState(settings), updatedAt: Date.now() });
      return;
    }

    if (this.qualification.shouldRefresh(3)) this.qualification.runInBackground(28);
    const audit = this.qualification.getState();
    const qualified = new Set(this.qualification.getQualifiedSymbols().map((symbol) => symbol.toUpperCase()));

    if (qualified.size === 0) {
      const completedR11 = audit.status === 'COMPLETED' && String(audit.rules?.exitModel ?? '').startsWith('R11_');
      this.saveState(completedR11 ? {
        status: 'NO_QUALIFIED_SYMBOLS', strategy: STRATEGY_LABEL, timeframe: '5m/15m',
        qualification: 'CALIBRATED_EXTERNAL_ONLY', auditCompletedAt: audit.completedAt,
        auditProgress: { completed: audit.completed ?? 0, total: audit.total ?? 0 },
        qualifiedUniverse: 0, completedAt: Date.now(), ...this.slotState(settings),
        message: 'Ningún símbolo R11 supera todavía calibración, holdout externo, costos, WR, PF y expectancy. No se abre ninguna operación.',
      } : {
        status: 'WAITING_UNIVERSE_AUDIT', strategy: STRATEGY_LABEL, timeframe: '5m/15m',
        auditStatus: audit.status, startedAt: audit.startedAt, completedAt: audit.completedAt,
        total: audit.total ?? 0, scanned: audit.completed ?? 0, current: audit.current ?? null,
        qualifiedUniverse: 0, auditError: audit.error, ...this.slotState(settings),
        message: 'Calibrando R11 por símbolo en workers: M5/M15 + retest + validación externa. Se habilitan símbolos parcialmente conforme van aprobando.',
      });
      return;
    }

    const qualificationMode = audit.status === 'COMPLETED'
      ? 'CALIBRATED_EXTERNAL_ONLY'
      : audit.status === 'RUNNING'
        ? 'CALIBRATED_EXTERNAL_PARTIAL'
        : 'CALIBRATED_EXTERNAL_LAST_KNOWN';

    this.running = true;
    const startedAt = Date.now();
    let scanned = 0;
    let errors = 0;
    let selected = 0;
    let executed = 0;
    const opportunities: Opportunity[] = [];
    const executionErrors: string[] = [];

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
        status: 'SCANNING', strategy: STRATEGY_LABEL, timeframe: '5m/15m', qualification: qualificationMode,
        startedAt, total: symbols.length, universeTotal: allSymbols.length, liquidUniverse: liquidSymbols.length,
        qualifiedUniverse: qualified.size, qualifiedSymbols: [...qualified], minQuoteVolume24h: 2_000_000,
        auditProgress: { status: audit.status, completed: audit.completed ?? 0, total: audit.total ?? 0, current: audit.current },
        scanned: 0, opportunities: 0, selected: 0, executed: 0, errors: 0,
        concurrency: { scanChunkSize: SCAN_CHUNK_SIZE, execution: 'PARALLEL_ATOMIC_SLOTS', loopDelayMs: LOOP_DELAY_MS },
        ...this.slotState(settings),
        reversalProtection: 'ADVISORY_DYNAMIC_ALL_OPEN_STRUCTURAL_SL_FAILSAFE',
        exitModel: EXIT_MODEL,
      });

      // Fast-lane behavior: each micro-batch is scanned concurrently and valid retests
      // are sent immediately to the orchestrator instead of waiting for the whole universe.
      // This is the key fix for opportunities that used to go stale while another order
      // was still being prepared/executed.
      for (let i = 0; i < symbols.length; i += SCAN_CHUNK_SIZE) {
        const chunk = symbols.slice(i, i + SCAN_CHUNK_SIZE);
        const results = await Promise.allSettled(chunk.map((symbol) => this.scanSymbol(symbol, liquidity.get(symbol) ?? 0)));
        const batchOpportunities: Opportunity[] = [];
        for (const result of results) {
          scanned++;
          if (result.status === 'fulfilled' && result.value) {
            opportunities.push(result.value);
            batchOpportunities.push(result.value);
          }
          if (result.status === 'rejected') errors++;
        }

        if (batchOpportunities.length) {
          const rankedBatch = [...batchOpportunities].sort((a, b) => b.score - a.score || b.confidence - a.confidence);
          const result = await this.orchestrator.process(rankedBatch, true);
          selected += result.selected.crypto.length;
          executed += result.executionResults.filter((item) => item.broker === 'BINANCE' && item.ok === true).length;
          executionErrors.push(...result.executionResults
            .filter((item) => item.broker === 'BINANCE' && item.ok !== true)
            .map((item) => String(item.error ?? 'UNKNOWN_EXECUTION_ERROR')));
        }

        this.saveState({
          status: 'SCANNING', strategy: STRATEGY_LABEL, timeframe: '5m/15m', qualification: qualificationMode,
          startedAt, total: symbols.length, universeTotal: allSymbols.length, liquidUniverse: liquidSymbols.length,
          qualifiedUniverse: qualified.size, qualifiedSymbols: [...qualified], scanned,
          current: chunk.at(-1) ?? null, opportunities: opportunities.length, selected, executed, errors,
          lastExecutionErrors: executionErrors.slice(-8),
          auditProgress: { status: audit.status, completed: audit.completed ?? 0, total: audit.total ?? 0, current: audit.current },
          concurrency: { scanChunkSize: SCAN_CHUNK_SIZE, execution: 'PARALLEL_ATOMIC_SLOTS', loopDelayMs: LOOP_DELAY_MS },
          ...this.slotState(settings),
          reversalProtection: 'ADVISORY_DYNAMIC_ALL_OPEN_STRUCTURAL_SL_FAILSAFE',
          exitModel: EXIT_MODEL,
        });
      }

      this.saveState({
        status: 'IDLE', strategy: STRATEGY_LABEL, timeframe: '5m/15m', qualification: qualificationMode,
        startedAt, completedAt: Date.now(), total: symbols.length, universeTotal: allSymbols.length,
        liquidUniverse: liquidSymbols.length, qualifiedUniverse: qualified.size, qualifiedSymbols: [...qualified],
        auditProgress: { status: audit.status, completed: audit.completed ?? 0, total: audit.total ?? 0, current: audit.current },
        scanned, opportunities: opportunities.length, selected, executed, errors,
        lastExecutionErrors: executionErrors.slice(-8),
        diagnostic: opportunities.length === 0
          ? 'NO_R11_RETEST_TOUCH_NOW'
          : selected === 0
            ? 'NO_FREE_SLOT_OR_SELECTION_FILTER'
            : executed === 0 && executionErrors.length
              ? 'EXECUTION_REJECTED_OR_STALE'
              : undefined,
        concurrency: { scanChunkSize: SCAN_CHUNK_SIZE, execution: 'PARALLEL_ATOMIC_SLOTS', loopDelayMs: LOOP_DELAY_MS },
        ...this.slotState(settings),
        reversalProtection: 'ADVISORY_DYNAMIC_ALL_OPEN_STRUCTURAL_SL_FAILSAFE',
        exitModel: EXIT_MODEL,
      });
    } catch (error) {
      this.saveState({
        status: 'ERROR', strategy: STRATEGY_LABEL, timeframe: '5m/15m', startedAt, completedAt: Date.now(),
        scanned, opportunities: opportunities.length, selected, executed, errors: errors + 1,
        ...this.slotState(settings),
        error: error instanceof Error ? error.message : String(error), exitModel: EXIT_MODEL,
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
      this.timer = setTimeout(() => void this.loop(), LOOP_DELAY_MS);
      this.timer.unref();
    }
  }

  private async scanSymbol(symbol: string, liquidityScore: number): Promise<Opportunity | null> {
    const settings = this.getSettings();
    const activeBlock = getCryptoReversalBlock(this.database, settings.appMode, symbol);
    if (activeBlock) return null;

    const approved = this.qualification.getModel(symbol);
    if (!approved?.model?.config) return null;

    const { ltf, htf } = await this.market.getDualKlines(symbol);
    if (ltf.length < 100 || htf.length < 210) return null;
    const setup = latestPendingSetupR11(ltf, htf, approved.model.config, approved.model.config.pendingBars);
    if (!setup) return null;

    const markPrice = await this.market.getMarkPrice(symbol);
    const signal = signalFromPendingR11(setup, markPrice);
    if (!signal) return null;

    const reversal = assessCryptoReversal(ltf, htf, signal.side);
    const rollingWinRate = approved.external.winRate;
    if (rollingWinRate < settings.cryptoMinRollingWinRate || signal.confidence < settings.cryptoMinSignalConfidence) return null;

    const pfBonus = Math.min(10, Math.max(0, approved.external.profitFactor - 1) * 5);
    const expectancyBonus = Math.min(10, Math.max(0, approved.external.expectancyPct) * 20);
    const score = Math.max(0, Math.min(100,
      rollingWinRate * 0.65 + signal.confidence * 0.25 + pfBonus + expectancyBonus +
      Math.max(0, Math.min(100, liquidityScore)) * 0.001,
    ));
    const fingerprint = sha256([
      'BINANCE-R11-RETEST', symbol, signal.side, String(setup.signalTime),
      roundKey(setup.entry), roundKey(signal.stopLoss), roundKey(signal.takeProfit),
    ].join('|'));
    const exitDisplay = exitDisplayProfile(
      signal.side, signal.entry, signal.stopLoss, signal.takeProfit, signal.tp2, signal.tp3,
      settings.cryptoRequestedLeverage,
    );

    return {
      id: `OP-BN-${fingerprint.slice(0, 24)}`,
      signalId: `SIG-BN-${fingerprint.slice(0, 24)}`,
      signalFingerprint: fingerprint,
      broker: 'BINANCE', symbol, side: signal.side, timeframe: '5m/15m', strategy: signal.strategy,
      confidence: signal.confidence,
      rollingWinRate,
      expectancy: approved.external.expectancyPct,
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
        liquidityScore,
        strategyCompatibility: 'R11_CALIBRATED_SWEEP_RECLAIM_MSS_PENDING_RETEST_M5_M15',
        qualification: 'CALIBRATION_PLUS_EXTERNAL_HOLDOUT_AFTER_COSTS',
        modelStatus: approved.modelStatus,
        modelFallback: approved.fallback,
        modelConfig: approved.model.config,
        modelValidation: approved.model.validation,
        modelHoldout: approved.model.holdout,
        external: approved.external,
        plannedRetestEntry: setup.entry,
        touchedAtMarkPrice: markPrice,
        signalTime: setup.signalTime,
        sweepExtreme: setup.sweepExtreme,
        liquidityLevel: setup.liquidity,
        reversalScoreAtEntry: reversal.score,
        reversalLevelAtEntry: reversal.level,
        reversalReasonsAtEntry: reversal.reasons,
        reversalComponentsAtEntry: reversal.components,
        reversalRule: 'OBSERVATIONAL_ONLY_NO_ENTRY_VETO_FROM_SCORE',
        exitModel: EXIT_MODEL,
        targetProfile: `TP1_${approved.model.config.rr.toFixed(2)}R_TP2_1.00R_TP3_1.50R`,
        exitDisplay,
      },
    };
  }

  private sanitizeSettings(): void {
    const settings = this.getSettings();
    const next: EngineSettings = {
      ...settings,
      // User explicitly requested multiple simultaneous Crypto trades. Migrate the
      // common legacy single-slot value to the intended 10-slot engine once.
      maxConcurrentCryptoTrades: settings.maxConcurrentCryptoTrades <= 1 ? 10 : Math.min(10, settings.maxConcurrentCryptoTrades),
      cryptoMinRollingWinRate: settings.cryptoMinRollingWinRate === 75 ? 64 : settings.cryptoMinRollingWinRate,
      cryptoMinSignalConfidence: settings.cryptoMinSignalConfidence === 75 ? 70 : settings.cryptoMinSignalConfidence,
    };
    if (JSON.stringify(next) !== JSON.stringify(settings)) this.database.saveSettings(next);
  }

  private slotState(settings: EngineSettings): Record<string, number> {
    const active = this.database.getActiveTrades('BINANCE')
      .filter((trade) => (trade.executionMode ?? 'REAL') === settings.appMode).length;
    const maxSlots = Math.min(10, settings.maxConcurrentCryptoTrades);
    return { activeSlots: active, maxSlots, freeSlots: Math.max(0, maxSlots - active) };
  }

  private saveState(value: Record<string, unknown>): void {
    this.database.db.prepare(`
      INSERT INTO engine_state(key, value, updated_at) VALUES('cryptoScanner', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(JSON.stringify(value), Date.now());
  }
}

function exitDisplayProfile(
  side: TradeSide,
  entry: number,
  stopLoss: number,
  takeProfit: number,
  tp2: number | undefined,
  tp3: number | undefined,
  leverage: number,
) {
  const distancePct = (level: number | undefined, kind: 'STOP' | 'TP'): number => {
    if (!(entry > 0) || !(Number(level) > 0)) return 0;
    const value = Number(level);
    const directional = side === 'BUY'
      ? (kind === 'STOP' ? entry - value : value - entry)
      : (kind === 'STOP' ? value - entry : entry - value);
    return Math.max(0, directional / entry * 100);
  };
  const slPricePct = distancePct(stopLoss, 'STOP');
  const tp1PricePct = distancePct(takeProfit, 'TP');
  const tp2PricePct = distancePct(tp2, 'TP');
  const tp3PricePct = distancePct(tp3, 'TP');
  const lev = Math.max(1, Number(leverage || 1));
  return {
    slPricePct, tp1PricePct, tp2PricePct, tp3PricePct,
    slMarginRoePct: slPricePct * lev,
    tp1MarginRoePct: tp1PricePct * lev,
    tp2MarginRoePct: tp2PricePct * lev,
    tp3MarginRoePct: tp3PricePct * lev,
    leverage: lev,
    note: 'R11 structural retest distance; leverage only amplifies margin ROE/PnL.',
  };
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
