import { BinanceUsdmClient, type BinancePosition } from './binance.js';
import { BinanceMarketDataClient } from './binanceMarket.js';
import { assessCryptoReversal, type CryptoReversalAssessment } from './cryptoReversal.js';
import { listCryptoReversalBlocks, setCryptoReversalBlock } from './cryptoReversalStore.js';
import { TradingDatabase } from './database.js';
import { calculateMetrics } from './metrics.js';
import { TradingRepository } from './repositories.js';
import { TelegramService } from './telegram.js';
import type { CloseReason, EngineSettings, TradeRecord, TradeSide } from './types.js';

const FOUR_HOURS = 4 * 60 * 60_000;
const LOOP_MS = 30_000;
const WARNING_COOLDOWN_MS = 30 * 60_000;

export interface CryptoReversalGuardState {
  status: 'ARMED' | 'RUNNING' | 'ERROR';
  executionMode: EngineSettings['appMode'];
  monitored: number;
  evaluated: number;
  warnings: number;
  closeRequested: number;
  policy: 'ADVISORY_REVERSAL_STRUCTURAL_SL_FAILSAFE';
  blockedSymbols: Array<{ symbol: string; blockedUntil: number; reason: string; score: number }>;
  positions: Array<{
    tradeId: string;
    symbol: string;
    side: TradeSide;
    roePct: number;
    reversalScore: number;
    level: string;
    action: 'NONE' | 'WARNING' | 'CLOSE_EMERGENCY';
    reasons: string[];
  }>;
  errors: Array<{ symbol: string; error: string }>;
  updatedAt: number;
}

export class CryptoReversalGuard {
  private running = false;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private warningAt = new Map<string, number>();

  constructor(
    private readonly database: TradingDatabase,
    private readonly repository: TradingRepository,
    private readonly binance: BinanceUsdmClient,
    private readonly market: BinanceMarketDataClient,
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

  load(): CryptoReversalGuardState | null {
    const row = this.database.db.prepare(`SELECT value FROM engine_state WHERE key='cryptoReversalGuard'`).get() as { value: string } | undefined;
    if (!row) return null;
    try { return JSON.parse(row.value) as CryptoReversalGuardState; } catch { return null; }
  }

  async runOnce(): Promise<CryptoReversalGuardState> {
    if (this.running) return this.load() ?? this.emptyState('RUNNING');
    this.running = true;
    const settings = this.getSettings();
    const active = this.database.getActiveTrades('BINANCE')
      .filter((trade) => (trade.executionMode ?? 'REAL') === settings.appMode && trade.state === 'OPEN');
    const positions: CryptoReversalGuardState['positions'] = [];
    const errors: CryptoReversalGuardState['errors'] = [];
    let warnings = 0;
    let closeRequested = 0;

    try {
      let liveMap = new Map<string, BinancePosition>();
      if (settings.appMode !== 'PAPER' && active.length && this.binance.hasCredentials()) {
        const live = await this.binance.getPositions();
        liveMap = new Map(live.map((position) => [position.symbol.toUpperCase(), position]));
      }

      for (const trade of active) {
        try {
          // The only automatic guard exit is a redundancy layer for the already
          // validated R11 structural stop. If the position is still OPEN after Mark
          // Price has crossed that SL, the protective order did not remove it and
          // the guard issues an emergency reduce-only close.
          const mark = await this.market.getMarkPrice(trade.symbol);
          const grossPnl = pricePnl(trade, mark);
          const roePct = tradeRoePct(trade, mark, grossPnl);
          this.repository.patchTrade(trade.id, { unrealizedPnl: grossPnl });

          if (structuralStopBreached(trade, mark)) {
            const reasons = ['R11_STRUCTURAL_SL_BREACHED_POSITION_STILL_OPEN'];
            positions.push({
              tradeId: trade.id,
              symbol: trade.symbol,
              side: trade.side,
              roePct,
              reversalScore: 0,
              level: 'FAILSAFE',
              action: 'CLOSE_EMERGENCY',
              reasons,
            });
            this.database.addTradeEvent(trade.id, 'REVERSAL_GUARD_CHECK', {
              policy: 'STRUCTURAL_SL_FAILSAFE',
              mark,
              stopLoss: trade.stopLoss,
              roePct,
              reversalScore: 0,
              level: 'FAILSAFE',
              action: 'CLOSE_EMERGENCY',
              reasons,
            });
            const block = setCryptoReversalBlock(
              this.database,
              settings.appMode,
              trade.symbol,
              FOUR_HOURS,
              'EMERGENCY_RISK',
              0,
            );
            const closed = await this.closeTrade(trade, mark, grossPnl, 'EMERGENCY_RISK', liveMap);
            if (closed) closeRequested++;
            await this.notifyCloseDecision(trade, roePct, reasons, block.blockedUntil, closed);
            continue;
          }

          let assessment: CryptoReversalAssessment;
          try {
            const { ltf, htf } = await this.market.getDualKlines(trade.symbol);
            assessment = assessCryptoReversal(ltf, htf, trade.side);
          } catch (error) {
            errors.push({ symbol: trade.symbol, error: `REVERSAL_DATA:${message(error)}` });
            positions.push({
              tradeId: trade.id,
              symbol: trade.symbol,
              side: trade.side,
              roePct,
              reversalScore: 0,
              level: 'DATA_ERROR',
              action: 'NONE',
              reasons: ['REVERSAL_DATA_UNAVAILABLE'],
            });
            this.database.addTradeEvent(trade.id, 'REVERSAL_GUARD_DATA_ERROR', { mark, roePct, error: message(error) });
            continue;
          }

          const action = decideAdvisoryAction(assessment);
          positions.push({
            tradeId: trade.id,
            symbol: trade.symbol,
            side: trade.side,
            roePct,
            reversalScore: assessment.score,
            level: assessment.level,
            action,
            reasons: assessment.reasons,
          });

          this.database.addTradeEvent(trade.id, 'REVERSAL_GUARD_CHECK', {
            policy: 'ADVISORY_ONLY_UNLESS_STRUCTURAL_SL_FAILSAFE',
            mark,
            stopLoss: trade.stopLoss,
            roePct,
            reversalScore: assessment.score,
            level: assessment.level,
            action,
            reasons: assessment.reasons,
            components: assessment.components,
          });

          if (action === 'WARNING' && this.shouldWarn(settings.appMode, trade.symbol)) {
            warnings++;
            await this.telegram.alert(
              assessment.score >= 50 ? 'REVERSAL GUARD · ADVERTENCIA FUERTE' : 'REVERSAL GUARD · ADVERTENCIA',
              [
                `${trade.symbol} ${trade.side}`,
                `Score reversión: ${assessment.score}/100`,
                `ROE actual: ${roePct.toFixed(2)}%`,
                `SL estructural R11: ${trade.stopLoss}`,
                'Acción: observación; NO cierra antes del SL estructural.',
                assessment.reasons.length ? `Confluencias: ${assessment.reasons.join(' · ')}` : '',
              ].filter(Boolean).join('\n'),
            ).catch(() => undefined);
          }
        } catch (error) {
          const detail = message(error);
          errors.push({ symbol: trade.symbol, error: detail });
          await this.telegram.alert(
            'REVERSAL GUARD · ERROR',
            `${trade.symbol}: ${detail}`,
          ).catch(() => undefined);
        }
      }

      const state: CryptoReversalGuardState = {
        status: 'ARMED',
        executionMode: settings.appMode,
        monitored: active.length,
        evaluated: positions.length,
        warnings,
        closeRequested,
        policy: 'ADVISORY_REVERSAL_STRUCTURAL_SL_FAILSAFE',
        blockedSymbols: listCryptoReversalBlocks(this.database, settings.appMode).map((block) => ({
          symbol: block.symbol,
          blockedUntil: block.blockedUntil,
          reason: block.reason,
          score: block.score,
        })),
        positions,
        errors: errors.slice(-20),
        updatedAt: Date.now(),
      };
      this.save(state);
      return state;
    } catch (error) {
      const state: CryptoReversalGuardState = {
        ...this.emptyState('ERROR'),
        monitored: active.length,
        errors: [{ symbol: '*', error: message(error) }, ...errors].slice(-20),
        updatedAt: Date.now(),
      };
      this.save(state);
      return state;
    } finally {
      this.running = false;
    }
  }

  private async closeTrade(
    trade: TradeRecord,
    mark: number,
    grossPnl: number,
    closeReason: Extract<CloseReason, 'EMERGENCY_RISK'>,
    liveMap: Map<string, BinancePosition>,
  ): Promise<boolean> {
    const settings = this.getSettings();
    const now = Date.now();

    if (settings.appMode === 'PAPER') {
      const notional = Math.max(0, Number(trade.notional ?? 0));
      const commission = notional * Math.max(0, settings.paperRoundTripCostPct) / 100;
      this.repository.patchTrade(trade.id, {
        state: 'CLOSED',
        exitPrice: mark,
        unrealizedPnl: 0,
        realizedPnl: grossPnl,
        commission,
        fundingOrSwap: 0,
        closeReason,
        closeTime: now,
      });
      try { this.database.db.prepare(`DELETE FROM paper_trade_cursor WHERE trade_id=?`).run(trade.id); }
      catch { /* Paper schema may still be initializing during process bootstrap. */ }
      this.database.addTradeEvent(trade.id, 'REVERSAL_PAPER_FAILSAFE_CLOSE', {
        exitPrice: mark,
        structuralStopLoss: trade.stopLoss,
        grossPnl,
        commission,
        netPnl: grossPnl - commission,
        closeReason,
        closeTime: now,
      });
      const closed = this.database.getRecentTrades(50_000).find((row) => row.id === trade.id);
      if (closed) {
        const paperTrades = this.database.getRecentTrades(50_000)
          .filter((row) => row.broker === 'BINANCE' && row.executionMode === 'PAPER');
        const metrics = calculateMetrics(paperTrades, 'BINANCE');
        await this.telegram.tradeClosed(closed, metrics.netProfit, metrics.winRate).catch(() => undefined);
      }
      return true;
    }

    const live = liveMap.get(trade.symbol.toUpperCase());
    if (!live || Math.abs(live.positionAmt) <= 0) {
      this.repository.patchTrade(trade.id, { state: 'SYNC_REQUIRED', closeReason });
      this.database.addTradeEvent(trade.id, 'REVERSAL_FAILSAFE_NO_LIVE_POSITION', { closeReason, mark, structuralStopLoss: trade.stopLoss });
      return false;
    }

    this.repository.patchTrade(trade.id, { state: 'CLOSING', closeReason });
    await this.binance.cancelAllAlgoOpenOrders(trade.symbol).catch(() => undefined);
    const closeSide: TradeSide = live.positionAmt > 0 ? 'SELL' : 'BUY';
    await this.binance.signedRequest('/fapi/v1/order', 'POST', {
      symbol: trade.symbol.toUpperCase(),
      side: closeSide,
      type: 'MARKET',
      quantity: Math.abs(live.positionAmt),
      reduceOnly: true,
      newOrderRespType: 'RESULT',
    });
    this.database.addTradeEvent(trade.id, 'REVERSAL_FAILSAFE_CLOSE_REQUESTED', {
      closeReason,
      mark,
      structuralStopLoss: trade.stopLoss,
      quantity: Math.abs(live.positionAmt),
      side: closeSide,
    });
    return true;
  }

  private async notifyCloseDecision(
    trade: TradeRecord,
    roePct: number,
    reasons: string[],
    blockedUntil: number,
    closeConfirmedOrRequested: boolean,
  ): Promise<void> {
    await this.telegram.alert(
      closeConfirmedOrRequested ? 'R11 FAILSAFE · CIERRE DE EMERGENCIA' : 'R11 FAILSAFE · CIERRE NO CONFIRMADO',
      [
        `${trade.symbol} ${trade.side}`,
        `ROE: ${roePct.toFixed(2)}%`,
        `SL estructural: ${trade.stopLoss}`,
        'Motivo: la posición seguía abierta después de cruzar el SL R11.',
        closeConfirmedOrRequested ? 'Cierre PAPER confirmado / orden REAL reduce-only solicitada.' : 'No se encontró posición live; requiere reconciliación.',
        `Reentrada bloqueada hasta: ${new Date(blockedUntil).toLocaleString('es-MX')}`,
        reasons.length ? `Detalle: ${reasons.join(' · ')}` : '',
      ].filter(Boolean).join('\n'),
    ).catch(() => undefined);
  }

  private shouldWarn(mode: EngineSettings['appMode'], symbol: string): boolean {
    const key = `${mode}:${symbol.toUpperCase()}`;
    const now = Date.now();
    const previous = this.warningAt.get(key) ?? 0;
    if (now - previous < WARNING_COOLDOWN_MS) return false;
    this.warningAt.set(key, now);
    return true;
  }

  private emptyState(status: CryptoReversalGuardState['status']): CryptoReversalGuardState {
    const settings = this.getSettings();
    return {
      status,
      executionMode: settings.appMode,
      monitored: 0,
      evaluated: 0,
      warnings: 0,
      closeRequested: 0,
      policy: 'ADVISORY_REVERSAL_STRUCTURAL_SL_FAILSAFE',
      blockedSymbols: listCryptoReversalBlocks(this.database, settings.appMode).map((block) => ({
        symbol: block.symbol,
        blockedUntil: block.blockedUntil,
        reason: block.reason,
        score: block.score,
      })),
      positions: [],
      errors: [],
      updatedAt: Date.now(),
    };
  }

  private save(state: CryptoReversalGuardState): void {
    this.database.db.prepare(`
      INSERT INTO engine_state(key, value, updated_at) VALUES('cryptoReversalGuard', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(JSON.stringify(state), state.updatedAt);
  }

  private async loop(): Promise<void> {
    if (this.stopped) return;
    try { await this.runOnce(); }
    catch (error) { console.error('[V34] crypto reversal guard:', message(error)); }
    if (!this.stopped) {
      this.timer = setTimeout(() => void this.loop(), LOOP_MS);
      this.timer.unref();
    }
  }
}

export function decideAdvisoryAction(
  assessment: Pick<CryptoReversalAssessment, 'score'>,
): 'NONE' | 'WARNING' {
  return assessment.score >= 30 ? 'WARNING' : 'NONE';
}

export function structuralStopBreached(
  trade: Pick<TradeRecord, 'side' | 'stopLoss'>,
  markPrice: number,
): boolean {
  if (!(markPrice > 0) || !(trade.stopLoss > 0)) return false;
  return trade.side === 'BUY' ? markPrice <= trade.stopLoss : markPrice >= trade.stopLoss;
}

function pricePnl(trade: TradeRecord, mark: number): number {
  if (!(trade.entryPrice > 0) || !(mark > 0)) return 0;
  const notional = Math.max(0, Number(trade.notional ?? 0));
  const raw = trade.side === 'BUY'
    ? (mark - trade.entryPrice) / trade.entryPrice
    : (trade.entryPrice - mark) / trade.entryPrice;
  return notional * raw;
}

function tradeRoePct(trade: TradeRecord, mark: number, grossPnl: number): number {
  const margin = Number(trade.marginUsed ?? 0);
  if (margin > 0) return grossPnl / margin * 100;
  if (!(trade.entryPrice > 0)) return 0;
  const pricePct = (trade.side === 'BUY' ? mark - trade.entryPrice : trade.entryPrice - mark) / trade.entryPrice * 100;
  return pricePct * Math.max(1, Number(trade.leverage ?? 1));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
