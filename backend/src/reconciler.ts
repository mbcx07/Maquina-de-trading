import { BinanceUsdmClient } from './binance.js';
import { TradingDatabase } from './database.js';
import { calculateMetrics } from './metrics.js';
import { TradingRepository } from './repositories.js';
import { TelegramService } from './telegram.js';
import type { CloseReason, EngineSettings, TradeRecord } from './types.js';

export class PositionReconciler {
  private running = false;

  constructor(
    private readonly database: TradingDatabase,
    private readonly repository: TradingRepository,
    private readonly binance: BinanceUsdmClient,
    private readonly telegram: TelegramService,
    private readonly getSettings: () => EngineSettings,
  ) {}

  async runOnce(): Promise<void> {
    if (this.running) return;
    if (this.getSettings().appMode === 'PAPER') return;
    if (!this.getSettings().cryptoEnabled || !this.binance.hasCredentials()) return;

    this.running = true;
    try {
      await this.reconcileBinance();
    } finally {
      this.running = false;
    }
  }

  private async reconcileBinance(): Promise<void> {
    const [positions, balance] = await Promise.all([
      this.binance.getPositions(),
      this.binance.getFuturesBalance(),
    ]);

    const exchangeBySymbol = new Map(positions.map((position) => [position.symbol.toUpperCase(), position]));
    const activeLocal = this.database.getActiveTrades('BINANCE');

    for (const trade of activeLocal) {
      if (trade.state === 'PENDING' || trade.state === 'OPENING') continue;
      const live = exchangeBySymbol.get(trade.symbol.toUpperCase());

      if (live) {
        this.repository.patchTrade(trade.id, {
          state: 'OPEN',
          entryPrice: live.entryPrice || trade.entryPrice,
          leverage: live.leverage || trade.leverage,
          unrealizedPnl: live.unrealizedProfit,
        });
        continue;
      }

      await this.finalizeBinanceTrade(trade);
    }

    const refreshed = this.database.getActiveTrades('BINANCE');
    const unrealized = refreshed.reduce((sum, trade) => sum + Number(trade.unrealizedPnl || 0), 0);
    this.repository.recordEquitySnapshot('BINANCE', balance, balance + unrealized, 0, unrealized);
  }

  private async finalizeBinanceTrade(trade: TradeRecord): Promise<void> {
    const startTime = Math.max(0, (trade.openTime ?? trade.createdAt) - 10_000);
    const [fills, fundingRows] = await Promise.all([
      this.binance.getAccountTrades(trade.symbol, startTime),
      this.binance.getIncomeHistory(trade.symbol, startTime, 'FUNDING_FEE').catch(() => []),
    ]);

    const openingOrderId = trade.brokerOrderId == null ? null : String(trade.brokerOrderId);
    const afterOpen = fills.filter((fill) => fill.time >= startTime);
    let closingFills = afterOpen.filter((fill) => openingOrderId == null || String(fill.orderId) !== openingOrderId);

    if (!closingFills.length && afterOpen.length) {
      closingFills = afterOpen.filter((fill) => fill.realizedPnl !== 0);
    }

    const realizedPnl = afterOpen.reduce((sum, fill) => sum + fill.realizedPnl, 0);
    const commission = afterOpen.reduce((sum, fill) => sum + Math.abs(fill.commission), 0);
    const funding = fundingRows.reduce((sum, row) => sum + row.income, 0);
    const exitPrice = weightedAverageExit(closingFills) ?? afterOpen.at(-1)?.price ?? trade.entryPrice;
    const closeTime = closingFills.length
      ? Math.max(...closingFills.map((fill) => fill.time))
      : afterOpen.at(-1)?.time ?? Date.now();
    const closeReason = inferPriceCloseReason(exitPrice, trade);

    this.repository.patchTrade(trade.id, {
      state: 'CLOSED',
      exitPrice,
      unrealizedPnl: 0,
      realizedPnl,
      commission,
      fundingOrSwap: funding,
      closeReason,
      closeTime,
    });
    this.database.addTradeEvent(trade.id, 'TRADE_CLOSED_RECONCILED', {
      source: 'BINANCE',
      exitPrice,
      realizedPnl,
      commission,
      funding,
      closeReason,
      fills: closingFills.map((fill) => ({ id: fill.id, orderId: fill.orderId, price: fill.price, qty: fill.qty, pnl: fill.realizedPnl })),
    });

    await this.binance.cancelAllAlgoOpenOrders(trade.symbol).catch(() => undefined);
    await this.notifyClosed(trade.id);
  }

  private async notifyClosed(tradeId: string): Promise<void> {
    const closed = this.database.getRecentTrades(2000).find((trade) => trade.id === tradeId);
    if (!closed) return;

    const metrics = calculateMetrics(this.database.getRecentTrades(5000), 'BINANCE');
    await this.telegram.tradeClosed(closed, metrics.netProfit, metrics.winRate).catch((error) => {
      this.database.db.prepare(`
        INSERT INTO telegram_events(trade_id, event_type, status, error, created_at)
        VALUES(?, 'TRADE_CLOSED', 'ERROR', ?, ?)
      `).run(tradeId, error instanceof Error ? error.message : String(error), Date.now());
    });
  }
}

function weightedAverageExit(fills: Array<{ price: number; qty: number }>): number | null {
  const totalQty = fills.reduce((sum, fill) => sum + Math.abs(fill.qty), 0);
  if (totalQty <= 0) return null;
  return fills.reduce((sum, fill) => sum + fill.price * Math.abs(fill.qty), 0) / totalQty;
}

function inferPriceCloseReason(exitPrice: number, trade: TradeRecord): CloseReason {
  const tolerance = Math.max(Math.abs(exitPrice) * 0.0015, Number.EPSILON);
  if (Math.abs(exitPrice - trade.stopLoss) <= tolerance) return 'SL';
  if (Math.abs(exitPrice - trade.takeProfit) <= tolerance) return 'TP';
  return 'EXTERNAL';
}
