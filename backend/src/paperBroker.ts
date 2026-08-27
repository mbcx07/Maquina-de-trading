import { BinanceMarketDataClient } from './binanceMarket.js';
import { TradingDatabase } from './database.js';
import { calculateMetrics, metricsBySymbol, type TradingMetrics } from './metrics.js';
import { TradingRepository } from './repositories.js';
import { TelegramService } from './telegram.js';
import type { CloseReason, EngineSettings, TradeRecord } from './types.js';

export interface PaperEquityPoint {
  time: number;
  balance: number;
  equity: number;
  realizedPnl: number;
  unrealizedPnl: number;
}

export interface PaperAccountSummary {
  initialBalance: number;
  balance: number;
  equity: number;
  realizedNetPnl: number;
  unrealizedPnl: number;
  returnPct: number;
  maxDrawdownPct: number;
  roundTripCostPct: number;
  metrics: TradingMetrics;
  bySymbol: Record<string, TradingMetrics>;
  equityCurve: PaperEquityPoint[];
  activeTrades: TradeRecord[];
  recentTrades: TradeRecord[];
  lastUpdatedAt: number;
}

export class PaperBrokerService {
  private running = false;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private lastSnapshotAt = 0;
  private lastSnapshotEquity: number | null = null;

  constructor(
    private readonly database: TradingDatabase,
    private readonly repository: TradingRepository,
    private readonly market: BinanceMarketDataClient,
    private readonly telegram: TelegramService,
    private readonly getSettings: () => EngineSettings,
  ) {
    this.ensureSchema();
  }

  start(): void {
    this.stopped = false;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<void> {
    if (this.getSettings().appMode !== 'PAPER') {
      this.saveEngineState('paperBroker', { status: 'PAUSED_MODE', updatedAt: Date.now() });
      return;
    }
    if (this.running) return;
    this.running = true;
    try {
      const active = this.database.getActiveTrades('BINANCE')
        .filter((trade) => trade.executionMode === 'PAPER' && trade.state === 'OPEN');

      for (const trade of active) {
        try {
          await this.updateTrade(trade);
        } catch (error) {
          this.saveEngineState(`paperBrokerError:${trade.id}`, {
            tradeId: trade.id,
            symbol: trade.symbol,
            error: error instanceof Error ? error.message : String(error),
            at: Date.now(),
          });
        }
      }

      this.recordSnapshotIfNeeded();
      const summary = this.getSummary();
      this.saveEngineState('paperBroker', {
        status: 'RUNNING',
        activeTrades: summary.activeTrades.length,
        closedTrades: summary.metrics.trades,
        balance: summary.balance,
        equity: summary.equity,
        netProfit: summary.metrics.netProfit,
        winRate: summary.metrics.winRate,
        updatedAt: Date.now(),
      });
    } finally {
      this.running = false;
    }
  }

  async closeTradeManually(tradeId: string): Promise<TradeRecord> {
    if (this.getSettings().appMode !== 'PAPER') throw new Error('SWITCH_TO_PAPER_TO_CLOSE_PAPER_TRADE');
    const trade = this.database.getRecentTrades(50_000).find((item) => item.id === tradeId);
    if (!trade || trade.executionMode !== 'PAPER' || trade.broker !== 'BINANCE') throw new Error('PAPER_TRADE_NOT_FOUND');
    if (trade.state !== 'OPEN') throw new Error('PAPER_TRADE_NOT_OPEN');

    const mark = await this.market.getMarkPrice(trade.symbol);
    await this.finalizeTrade(trade, mark, 'MANUAL', Date.now());
    this.recordSnapshotIfNeeded(true);
    const closed = this.database.getRecentTrades(50_000).find((item) => item.id === tradeId);
    if (!closed) throw new Error('PAPER_CLOSED_TRADE_NOT_FOUND');
    return closed;
  }

  getSummary(): PaperAccountSummary {
    const settings = this.getSettings();
    const paperTrades = this.database.getRecentTrades(50_000)
      .filter((trade) => trade.broker === 'BINANCE' && trade.executionMode === 'PAPER');
    const metrics = calculateMetrics(paperTrades, 'BINANCE');
    const activeTrades = paperTrades.filter((trade) => ['PENDING', 'OPENING', 'OPEN', 'CLOSING', 'SYNC_REQUIRED'].includes(trade.state));
    const initialBalance = Number(settings.paperInitialBalance || 100);
    const balance = initialBalance + metrics.netProfit;
    const equity = balance + metrics.unrealizedPnl;
    const curve = this.loadEquityCurve(400);
    const maxDrawdownPct = calculateCurveDrawdown(curve.length ? curve.map((point) => point.equity) : [initialBalance, equity]);

    return {
      initialBalance,
      balance,
      equity,
      realizedNetPnl: metrics.netProfit,
      unrealizedPnl: metrics.unrealizedPnl,
      returnPct: initialBalance > 0 ? (equity - initialBalance) / initialBalance * 100 : 0,
      maxDrawdownPct,
      roundTripCostPct: settings.paperRoundTripCostPct,
      metrics,
      bySymbol: metricsBySymbol(paperTrades, 'BINANCE'),
      equityCurve: curve,
      activeTrades,
      recentTrades: paperTrades.slice(0, 250),
      lastUpdatedAt: Date.now(),
    };
  }

  private async updateTrade(trade: TradeRecord): Promise<void> {
    const now = Date.now();
    const openTime = trade.openTime ?? trade.createdAt;

    // Current mark is safe because it is observed after the trade exists.
    const mark = await this.market.getMarkPrice(trade.symbol);
    if (crossedStop(trade, mark)) {
      await this.finalizeTrade(trade, trade.stopLoss, 'SL', now);
      return;
    }
    if (crossedTakeProfit(trade, mark)) {
      await this.finalizeTrade(trade, trade.takeProfit, 'TP', now);
      return;
    }

    // Never inspect the OHLC high/low of the entry minute: part of that candle happened
    // before the simulated order existed and caused the old false "micro-closes".
    const firstSafeCandle = Math.floor(openTime / 60_000) * 60_000 + 60_000;
    const cursor = this.loadCursor(trade.id);
    const start = Math.max(firstSafeCandle, cursor == null ? firstSafeCandle : cursor + 60_000);

    if (start <= now) {
      const candles = await this.market.getMarkPriceKlinesRange(trade.symbol, '1m', start, now);
      const relevant = candles.filter((candle) => candle.time >= firstSafeCandle).sort((a, b) => a.time - b.time);

      for (const candle of relevant) {
        const slTouched = trade.side === 'BUY' ? candle.low <= trade.stopLoss : candle.high >= trade.stopLoss;
        const tpTouched = trade.side === 'BUY' ? candle.high >= trade.takeProfit : candle.low <= trade.takeProfit;
        if (slTouched) {
          await this.finalizeTrade(trade, trade.stopLoss, 'SL', candle.time);
          return;
        }
        if (tpTouched) {
          await this.finalizeTrade(trade, trade.takeProfit, 'TP', candle.time);
          return;
        }
      }
      if (relevant.length) this.saveCursor(trade.id, relevant.at(-1)!.time);
    }

    const unrealizedPnl = pricePnl(trade, mark);
    this.repository.patchTrade(trade.id, { unrealizedPnl });
    this.database.addTradeEvent(trade.id, 'PAPER_MARK', { mark, unrealizedPnl, observedAt: now });
  }

  private async finalizeTrade(trade: TradeRecord, exitPrice: number, closeReason: CloseReason, closeTime: number): Promise<void> {
    const grossPnl = pricePnl(trade, exitPrice);
    const notional = Math.max(0, Number(trade.notional ?? 0));
    const commission = notional * Math.max(0, this.getSettings().paperRoundTripCostPct) / 100;

    this.repository.patchTrade(trade.id, {
      state: 'CLOSED',
      exitPrice,
      unrealizedPnl: 0,
      realizedPnl: grossPnl,
      commission,
      fundingOrSwap: 0,
      closeReason,
      closeTime,
    });
    this.database.addTradeEvent(trade.id, 'PAPER_TRADE_CLOSED', {
      exitPrice,
      grossPnl,
      commission,
      netPnl: grossPnl - commission,
      closeReason,
      closeTime,
      priceSource: 'BINANCE_MARK_PRICE',
    });
    this.database.db.prepare(`DELETE FROM paper_trade_cursor WHERE trade_id = ?`).run(trade.id);

    const closed = this.database.getRecentTrades(50_000).find((item) => item.id === trade.id);
    if (closed) {
      const metrics = this.getSummary().metrics;
      await this.telegram.tradeClosed(closed, metrics.netProfit, metrics.winRate).catch(() => undefined);
    }
  }

  private recordSnapshotIfNeeded(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastSnapshotAt < 30_000) return;
    const settings = this.getSettings();
    const paperTrades = this.database.getRecentTrades(50_000)
      .filter((trade) => trade.broker === 'BINANCE' && trade.executionMode === 'PAPER');
    const metrics = calculateMetrics(paperTrades, 'BINANCE');
    const balance = settings.paperInitialBalance + metrics.netProfit;
    const equity = balance + metrics.unrealizedPnl;
    if (!force && this.lastSnapshotEquity != null && Math.abs(equity - this.lastSnapshotEquity) < 1e-9 && now - this.lastSnapshotAt < 60_000) return;

    this.database.db.prepare(`
      INSERT INTO paper_equity_snapshots(balance, equity, realized_pnl, unrealized_pnl, created_at)
      VALUES(?, ?, ?, ?, ?)
    `).run(balance, equity, metrics.netProfit, metrics.unrealizedPnl, now);
    this.lastSnapshotAt = now;
    this.lastSnapshotEquity = equity;
  }

  private loadEquityCurve(limit: number): PaperEquityPoint[] {
    const rows = this.database.db.prepare(`
      SELECT balance, equity, realized_pnl, unrealized_pnl, created_at
      FROM paper_equity_snapshots ORDER BY created_at ASC
    `).all() as Array<Record<string, unknown>>;
    if (!rows.length) return [];
    const step = Math.max(1, Math.ceil(rows.length / Math.max(2, limit)));
    return rows.filter((_, index) => index % step === 0 || index === rows.length - 1).map((row) => ({
      time: Number(row.created_at),
      balance: Number(row.balance),
      equity: Number(row.equity),
      realizedPnl: Number(row.realized_pnl),
      unrealizedPnl: Number(row.unrealized_pnl),
    }));
  }

  private loadCursor(tradeId: string): number | null {
    const row = this.database.db.prepare(`SELECT last_candle_time FROM paper_trade_cursor WHERE trade_id = ?`).get(tradeId) as { last_candle_time: number } | undefined;
    return row ? Number(row.last_candle_time) : null;
  }

  private saveCursor(tradeId: string, candleTime: number): void {
    this.database.db.prepare(`
      INSERT INTO paper_trade_cursor(trade_id, last_candle_time, updated_at)
      VALUES(?, ?, ?)
      ON CONFLICT(trade_id) DO UPDATE SET last_candle_time=excluded.last_candle_time, updated_at=excluded.updated_at
    `).run(tradeId, candleTime, Date.now());
  }

  private saveEngineState(key: string, value: Record<string, unknown>): void {
    this.database.db.prepare(`
      INSERT INTO engine_state(key, value, updated_at) VALUES(?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(key, JSON.stringify(value), Date.now());
  }

  private async loop(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.runOnce();
    } catch (error) {
      this.saveEngineState('paperBroker', { status: 'ERROR', error: error instanceof Error ? error.message : String(error), updatedAt: Date.now() });
      console.error('[V34] paper broker:', error instanceof Error ? error.message : error);
    }
    if (!this.stopped) {
      this.timer = setTimeout(() => void this.loop(), 5_000);
      this.timer.unref();
    }
  }

  private ensureSchema(): void {
    this.database.db.exec(`
      CREATE TABLE IF NOT EXISTS paper_trade_cursor (
        trade_id TEXT PRIMARY KEY,
        last_candle_time INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(trade_id) REFERENCES trades(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS paper_equity_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        balance REAL NOT NULL,
        equity REAL NOT NULL,
        realized_pnl REAL NOT NULL DEFAULT 0,
        unrealized_pnl REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_paper_equity_time ON paper_equity_snapshots(created_at ASC);
    `);
  }
}

function crossedStop(trade: TradeRecord, price: number): boolean {
  return trade.side === 'BUY' ? price <= trade.stopLoss : price >= trade.stopLoss;
}

function crossedTakeProfit(trade: TradeRecord, price: number): boolean {
  return trade.side === 'BUY' ? price >= trade.takeProfit : price <= trade.takeProfit;
}

function pricePnl(trade: TradeRecord, price: number): number {
  if (!Number.isFinite(price) || price <= 0 || trade.entryPrice <= 0) return 0;
  const notional = Math.max(0, Number(trade.notional ?? 0));
  const directionalReturn = trade.side === 'BUY'
    ? (price - trade.entryPrice) / trade.entryPrice
    : (trade.entryPrice - price) / trade.entryPrice;
  return notional * directionalReturn;
}

function calculateCurveDrawdown(values: number[]): number {
  let peak = values[0] ?? 0;
  let maxDrawdown = 0;
  for (const value of values) {
    peak = Math.max(peak, value);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - value) / peak * 100);
  }
  return maxDrawdown;
}
