import crypto from 'node:crypto';
import { BinanceUsdmClient } from './binance.js';
import { TradingDatabase } from './database.js';
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

    const activeLocal = this.database.getActiveTrades('BINANCE');
    const activeSymbols = new Set(activeLocal.map((trade) => trade.symbol.toUpperCase()));
    if (activeSymbols.size >= settings.maxConcurrentCryptoTrades) {
      this.repository.rejectOpportunity(opportunity.id, 'CRYPTO_MAX_SLOTS_REACHED');
      throw new Error('CRYPTO_MAX_SLOTS_REACHED');
    }
    if (activeSymbols.has(opportunity.symbol.toUpperCase())) {
      this.repository.rejectOpportunity(opportunity.id, 'CRYPTO_SYMBOL_ALREADY_ACTIVE_LOCAL');
      throw new Error('CRYPTO_SYMBOL_ALREADY_ACTIVE_LOCAL');
    }

    if (settings.appMode !== 'PAPER') {
      await this.binance.assertSymbolNotOpen(opportunity.symbol);
    }

    await this.binance.refreshExchangeInfo();
    const symbolMeta = this.binance.getSymbolMeta(opportunity.symbol);

    const futuresBalance = settings.appMode === 'PAPER'
      ? await this.paperBalance()
      : await this.binance.getFuturesBalance();

    const maxAllowedLeverage = settings.appMode === 'PAPER'
      ? settings.cryptoRequestedLeverage
      : await this.binance.getMaxAllowedLeverage(opportunity.symbol);

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

    const id = `BN-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const now = Date.now();
    const reserved: TradeRecord = {
      id,
      broker: 'BINANCE',
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
      marginUsed: normalized.notional / sizing.effectiveLeverage,
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
        risk: sizing,
      },
    };

    // Final concurrency guard. For BINANCE, SQLite refuses a second active row
    // for the same symbol even if two async scans race each other.
    this.repository.createTradeAtomically(reserved);

    try {
      const leverage = settings.appMode === 'PAPER'
        ? sizing.effectiveLeverage
        : await this.binance.setLeverage(opportunity.symbol, settings.cryptoRequestedLeverage);

      const quantity = normalized.quantity;
      const order = await this.binance.createMarketOrder(opportunity.symbol, opportunity.side, quantity);
      const orderId = String(order.orderId ?? order.clientOrderId ?? order.paper ?? `ORDER-${Date.now()}`);
      const fillPrice = Number(order.avgPrice || order.price || opportunity.entry) || opportunity.entry;

      const exitSide: TradeSide = opportunity.side === 'BUY' ? 'SELL' : 'BUY';
      const stopClientId = clientAlgoId('SL', id);
      const tpClientId = clientAlgoId('TP', id);

      await Promise.all([
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
      });

      const opened = this.database.getActiveTrades('BINANCE').find((trade) => trade.id === id);
      if (!opened) throw new Error('OPENED_TRADE_NOT_FOUND');

      const usedSlots = this.database.getActiveTrades('BINANCE').length;
      await this.telegram.tradeOpened(opened, `Crypto ${usedSlots}/${settings.maxConcurrentCryptoTrades}`)
        .catch(() => undefined);

      return opened;
    } catch (error) {
      this.repository.patchTrade(id, {
        state: 'REJECTED',
        closeReason: 'ERROR',
        closeTime: Date.now(),
      });
      this.database.addTradeEvent(id, 'TRADE_OPEN_FAILED', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async paperBalance(): Promise<number> {
    const row = this.database.db.prepare(`
      SELECT balance FROM equity_snapshots
      WHERE broker = 'BINANCE'
      ORDER BY created_at DESC LIMIT 1
    `).get() as { balance: number } | undefined;

    if (row?.balance && row.balance > 0) return Number(row.balance);
    return 100;
  }
}

function clientAlgoId(prefix: string, tradeId: string): string {
  const clean = tradeId.replace(/[^A-Za-z0-9_-]/g, '').slice(-20);
  return `V34-${prefix}-${clean}-${Date.now().toString().slice(-6)}`.slice(0, 36);
}
