import crypto from 'node:crypto';
import { BinanceUsdmClient } from './binance.js';
import { TradingDatabase } from './database.js';
import { calculateMetrics } from './metrics.js';
import { TradingRepository } from './repositories.js';
import { calculateCryptoSizing, normalizeBinanceOrderSize } from './risk.js';
import { TelegramService } from './telegram.js';
import type { EngineSettings, Opportunity, TradeRecord, TradeSide } from './types.js';

export class CryptoExecutionService {
  constructor(
    private readonly database: TradingDatabase,
    private readonly repository: TradingRepository,
    private readonly binance: BinanceUsdmClient,
    private readonly telegram: TelegramService,
    private readonly getSettings: () => EngineSettings,
  ) {}

  async execute(opportunity: Opportunity): Promise<TradeRecord> {
    if (opportunity.broker !== 'BINANCE') throw new Error('NOT_A_BINANCE_OPPORTUNITY');

    const settings = this.getSettings();
    if (!settings.engineEnabled) throw new Error('ENGINE_DISABLED');
    if (!settings.cryptoEnabled) throw new Error('CRYPTO_ENGINE_DISABLED');
    if (opportunity.confidence < settings.cryptoMinSignalConfidence) throw new Error('CRYPTO_CONFIDENCE_FILTER');
    if (opportunity.rollingWinRate < settings.cryptoMinRollingWinRate) throw new Error('CRYPTO_WINRATE_FILTER');

    this.repository.saveSignal(opportunity);

    const activeLocal = this.database.getActiveTrades('BINANCE')
      .filter((trade) => (trade.executionMode ?? 'REAL') === settings.appMode);
    const activeSymbols = new Set(activeLocal.map((trade) => trade.symbol.toUpperCase()));
    if (activeSymbols.size >= Math.min(10, settings.maxConcurrentCryptoTrades)) {
      this.repository.rejectOpportunity(opportunity.id, 'CRYPTO_MAX_SLOTS_REACHED');
      throw new Error('CRYPTO_MAX_SLOTS_REACHED');
    }
    if (activeSymbols.has(opportunity.symbol.toUpperCase())) {
      this.repository.rejectOpportunity(opportunity.id, 'CRYPTO_SYMBOL_ALREADY_ACTIVE_LOCAL');
      throw new Error('CRYPTO_SYMBOL_ALREADY_ACTIVE_LOCAL');
    }

    if (settings.appMode !== 'PAPER') {
      await this.assertOneWayMode();
      await this.binance.assertSymbolNotOpen(opportunity.symbol);
    }

    await this.binance.refreshExchangeInfo();
    const symbolMeta = this.binance.getSymbolMeta(opportunity.symbol);

    const futuresBalance = settings.appMode === 'PAPER'
      ? this.paperBalance()
      : await this.binance.getFuturesBalance();

    const maxAllowedLeverage = settings.appMode === 'PAPER'
      ? settings.cryptoRequestedLeverage
      : await this.binance.getMaxAllowedLeverage(opportunity.symbol);

    // The stop price is the V33.5 structural invalidation level. Leverage affects
    // notional/margin PnL only; it never divides or multiplies the trigger price.
    const sizing = calculateCryptoSizing({
      futuresBalance,
      marginPctPerTrade: settings.cryptoMarginPctPerTrade,
      requestedLeverage: settings.cryptoRequestedLeverage,
      maxAllowedLeverage,
      entryPrice: opportunity.entry,
      stopLoss: opportunity.stopLoss,
      maxLossPctPerTrade: settings.cryptoMaxLossPctPerTrade,
    });

    const normalized = normalizeBinanceOrderSize(
      sizing.targetNotional,
      opportunity.entry,
      symbolMeta.filters,
    );
    const marginRequired = normalized.notional / sizing.effectiveLeverage;
    const activeAllocatedMargin = activeLocal.reduce((sum, trade) => {
      if (trade.marginUsed != null) return sum + Math.max(0, trade.marginUsed);
      if (trade.notional != null && trade.leverage) return sum + Math.max(0, trade.notional / trade.leverage);
      return sum;
    }, 0);
    const maxAllocatedMargin = futuresBalance * (settings.cryptoMaxAccountExposurePct / 100);

    if (activeAllocatedMargin + marginRequired > maxAllocatedMargin + 1e-9) {
      this.repository.rejectOpportunity(opportunity.id, 'CRYPTO_ACCOUNT_EXPOSURE_LIMIT');
      throw new Error(
        `CRYPTO_ACCOUNT_EXPOSURE_LIMIT: allocated=${activeAllocatedMargin.toFixed(4)} new=${marginRequired.toFixed(4)} max=${maxAllocatedMargin.toFixed(4)}`,
      );
    }

    const id = `BN-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const now = Date.now();
    const reserved: TradeRecord = {
      id,
      broker: 'BINANCE',
      executionMode: settings.appMode,
      symbol: opportunity.symbol.toUpperCase(),
      side: opportunity.side,
      strategy: opportunity.strategy,
      timeframe: opportunity.timeframe,
      confidence: opportunity.confidence,
      rollingWinRate: opportunity.rollingWinRate,
      entryPrice: opportunity.entry,
      stopLoss: opportunity.stopLoss,
      takeProfit: opportunity.takeProfit,
      tp2: opportunity.tp2,
      tp3: opportunity.tp3,
      leverage: sizing.effectiveLeverage,
      marginUsed: marginRequired,
      notional: normalized.notional,
      commission: 0,
      fundingOrSwap: 0,
      unrealizedPnl: 0,
      realizedPnl: 0,
      state: 'OPENING',
      signalId: opportunity.signalId,
      signalFingerprint: opportunity.signalFingerprint,
      createdAt: now,
      updatedAt: now,
      metadata: {
        opportunityId: opportunity.id,
        score: opportunity.score,
        executionMode: settings.appMode,
        risk: sizing,
        exitModel: 'V33.5_STRUCTURAL_PRICE_LEVELS',
        exitDisplayAtSignal: exitDisplay(opportunity.side, opportunity.entry, opportunity.stopLoss, opportunity.takeProfit, sizing.effectiveLeverage),
        exposure: {
          activeAllocatedMargin,
          marginRequired,
          maxAllocatedMargin,
        },
      },
    };

    this.repository.createTradeAtomically(reserved);

    let entryPlaced = false;
    try {
      const leverage = settings.appMode === 'PAPER'
        ? sizing.effectiveLeverage
        : await this.binance.setLeverage(opportunity.symbol, settings.cryptoRequestedLeverage);

      const quantity = normalized.quantity;
      const order = await this.binance.createMarketOrder(opportunity.symbol, opportunity.side, quantity);
      entryPlaced = true;
      const orderId = String(order.orderId ?? order.clientOrderId ?? order.paper ?? `ORDER-${Date.now()}`);
      const fillPrice = Number(order.avgPrice || order.price || opportunity.entry) || opportunity.entry;

      // Preserve the exact structural levels produced by the freshly revalidated signal.
      // Rewriting them after fill changes the strategy. The display below recalculates
      // the actual price distance/ROE from the fill so the UI remains truthful.
      this.repository.patchTrade(id, {
        brokerOrderId: orderId,
        leverage,
        entryPrice: fillPrice,
        openTime: Date.now(),
      });
      this.database.addTradeEvent(id, 'ENTRY_FILLED', {
        brokerOrderId: orderId,
        quantity,
        leverage,
        fillPrice,
        executionMode: settings.appMode,
        exitModel: 'V33.5_STRUCTURAL_PRICE_LEVELS',
        exitDisplayAtFill: exitDisplay(opportunity.side, fillPrice, opportunity.stopLoss, opportunity.takeProfit, leverage),
      });

      const exitSide: TradeSide = opportunity.side === 'BUY' ? 'SELL' : 'BUY';
      const stopClientId = clientAlgoId('SL', id);
      const tpClientId = clientAlgoId('TP', id);

      const protections = await Promise.allSettled([
        this.binance.createCloseAllConditional(
          opportunity.symbol,
          exitSide,
          'STOP_MARKET',
          opportunity.stopLoss,
          stopClientId,
        ),
        this.binance.createCloseAllConditional(
          opportunity.symbol,
          exitSide,
          'TAKE_PROFIT_MARKET',
          opportunity.takeProfit,
          tpClientId,
        ),
      ]);

      if (protections.some((result) => result.status === 'rejected')) {
        const protectionErrors = protections
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
        this.database.addTradeEvent(id, 'PROTECTION_FAILED', { errors: protectionErrors });
        await this.telegram.alert(
          'CRYPTO SIN PROTECCIÓN - CIERRE DE EMERGENCIA',
          `${opportunity.symbol}: falló SL/TP. Se ordenará cierre reduce-only inmediato.`,
        ).catch(() => undefined);
        await this.emergencyCloseSymbol(opportunity.symbol).catch((closeError) => {
          this.database.addTradeEvent(id, 'EMERGENCY_CLOSE_FAILED', {
            error: closeError instanceof Error ? closeError.message : String(closeError),
          });
        });
        this.repository.patchTrade(id, { state: 'SYNC_REQUIRED', closeReason: 'ERROR' });
        throw new Error(`CRYPTO_PROTECTION_FAILED:${protectionErrors.join('|')}`);
      }

      const openTime = Date.now();
      this.repository.patchTrade(id, {
        state: 'OPEN',
        leverage,
        entryPrice: fillPrice,
        brokerOrderId: orderId,
        openTime,
      });
      this.database.addTradeEvent(id, 'TRADE_OPENED', {
        brokerOrderId: orderId,
        quantity,
        leverage,
        stopClientId,
        tpClientId,
        executionMode: settings.appMode,
        stopLoss: opportunity.stopLoss,
        takeProfit: opportunity.takeProfit,
      });

      const opened = this.database.getActiveTrades('BINANCE').find((trade) => trade.id === id);
      if (!opened) throw new Error('OPENED_TRADE_NOT_FOUND');

      const usedSlots = this.database.getActiveTrades('BINANCE')
        .filter((trade) => (trade.executionMode ?? 'REAL') === settings.appMode).length;
      await this.telegram.tradeOpened(opened, `${settings.appMode} Crypto ${usedSlots}/${settings.maxConcurrentCryptoTrades}`)
        .catch(() => undefined);

      return opened;
    } catch (error) {
      const current = this.database.getActiveTrades('BINANCE').find((trade) => trade.id === id);
      if (!entryPlaced) {
        this.repository.patchTrade(id, {
          state: 'REJECTED',
          closeReason: 'ERROR',
          closeTime: Date.now(),
        });
      } else if (current?.state !== 'SYNC_REQUIRED') {
        this.repository.patchTrade(id, { state: 'SYNC_REQUIRED', closeReason: 'ERROR' });
      }
      this.database.addTradeEvent(id, 'TRADE_OPEN_FAILED', {
        entryPlaced,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async assertOneWayMode(): Promise<void> {
    const mode = await this.binance.signedRequest<{ dualSidePosition: boolean }>('/fapi/v1/positionSide/dual', 'GET');
    if (Boolean(mode.dualSidePosition)) {
      throw new Error('BINANCE_HEDGE_MODE_NOT_SUPPORTED_V34_USE_ONE_WAY_MODE');
    }
  }

  private async emergencyCloseSymbol(symbol: string): Promise<void> {
    if (this.getSettings().appMode === 'PAPER') return;
    const positions = await this.binance.getPositions();
    const position = positions.find((item) => item.symbol.toUpperCase() === symbol.toUpperCase());
    if (!position) return;

    const quantity = Math.abs(position.positionAmt);
    if (quantity <= 0) return;
    const closeSide: TradeSide = position.positionAmt > 0 ? 'SELL' : 'BUY';
    await this.binance.signedRequest('/fapi/v1/order', 'POST', {
      symbol: symbol.toUpperCase(),
      side: closeSide,
      type: 'MARKET',
      quantity,
      reduceOnly: true,
      newOrderRespType: 'RESULT',
    });
  }

  private paperBalance(): number {
    const settings = this.getSettings();
    const paperTrades = this.database.getRecentTrades(50_000)
      .filter((trade) => trade.broker === 'BINANCE' && trade.executionMode === 'PAPER');
    const metrics = calculateMetrics(paperTrades, 'BINANCE');
    return Math.max(0, settings.paperInitialBalance + metrics.netProfit);
  }
}

function clientAlgoId(prefix: string, tradeId: string): string {
  const clean = tradeId.replace(/[^A-Za-z0-9_-]/g, '').slice(-20);
  return `V34-${prefix}-${clean}-${Date.now().toString().slice(-6)}`.slice(0, 36);
}

function exitDisplay(side: TradeSide, entry: number, stopLoss: number, takeProfit: number, leverage: number) {
  const lev = Math.max(1, Number(leverage || 1));
  const slPricePct = entry > 0
    ? Math.max(0, (side === 'BUY' ? entry - stopLoss : stopLoss - entry) / entry * 100)
    : 0;
  const tpPricePct = entry > 0
    ? Math.max(0, (side === 'BUY' ? takeProfit - entry : entry - takeProfit) / entry * 100)
    : 0;
  return {
    slPricePct,
    tpPricePct,
    slMarginRoePct: slPricePct * lev,
    tpMarginRoePct: tpPricePct * lev,
    leverage: lev,
  };
}
