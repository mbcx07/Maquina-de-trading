import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { Broker, EngineSettings, TradeRecord } from './types.js';

export class TradingDatabase {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    const resolved = path.resolve(dbPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    this.db = new Database(resolved);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        payload TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS signals (
        id TEXT PRIMARY KEY,
        broker TEXT NOT NULL CHECK (broker IN ('BINANCE','MT5')),
        symbol TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_signals_fingerprint ON signals(fingerprint);
      CREATE INDEX IF NOT EXISTS idx_signals_symbol_created ON signals(symbol, created_at DESC);

      CREATE TABLE IF NOT EXISTS opportunities (
        id TEXT PRIMARY KEY,
        signal_id TEXT NOT NULL,
        broker TEXT NOT NULL CHECK (broker IN ('BINANCE','MT5')),
        symbol TEXT NOT NULL,
        score REAL NOT NULL,
        executable INTEGER NOT NULL DEFAULT 1,
        rejection_reason TEXT,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(signal_id) REFERENCES signals(id)
      );

      CREATE INDEX IF NOT EXISTS idx_opportunities_rank
        ON opportunities(broker, executable, score DESC, created_at DESC);

      CREATE TABLE IF NOT EXISTS trades (
        id TEXT PRIMARY KEY,
        broker TEXT NOT NULL CHECK (broker IN ('BINANCE','MT5')),
        execution_mode TEXT NOT NULL DEFAULT 'REAL',
        symbol TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
        strategy TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        confidence REAL NOT NULL,
        rolling_win_rate REAL NOT NULL,
        entry_price REAL NOT NULL,
        exit_price REAL,
        stop_loss REAL NOT NULL,
        take_profit REAL NOT NULL,
        tp2 REAL,
        tp3 REAL,
        leverage REAL,
        lot_size REAL,
        margin_used REAL,
        notional REAL,
        commission REAL NOT NULL DEFAULT 0,
        funding_or_swap REAL NOT NULL DEFAULT 0,
        unrealized_pnl REAL NOT NULL DEFAULT 0,
        realized_pnl REAL NOT NULL DEFAULT 0,
        state TEXT NOT NULL,
        close_reason TEXT,
        broker_order_id TEXT,
        signal_id TEXT NOT NULL,
        signal_fingerprint TEXT NOT NULL,
        open_time INTEGER,
        close_time INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        metadata TEXT,
        FOREIGN KEY(signal_id) REFERENCES signals(id)
      );

      CREATE INDEX IF NOT EXISTS idx_trades_broker_state ON trades(broker, state);
      CREATE INDEX IF NOT EXISTS idx_trades_symbol_state ON trades(symbol, state);
      CREATE INDEX IF NOT EXISTS idx_trades_close_time ON trades(close_time DESC);

      -- Critical invariant: Binance may have only one active local trade per symbol.
      -- This protects against simultaneous async signals racing each other.
      CREATE UNIQUE INDEX IF NOT EXISTS ux_binance_active_symbol
        ON trades(symbol)
        WHERE broker = 'BINANCE'
          AND state IN ('PENDING','OPENING','OPEN','CLOSING','SYNC_REQUIRED');

      -- Forex deliberately has NO unique(symbol) constraint. Multiple MT5 tickets
      -- for the same pair are allowed when they represent different signals/retests.
      CREATE UNIQUE INDEX IF NOT EXISTS ux_mt5_active_signal_fingerprint
        ON trades(signal_fingerprint)
        WHERE broker = 'MT5'
          AND state IN ('PENDING','OPENING','OPEN','CLOSING','SYNC_REQUIRED');

      CREATE TABLE IF NOT EXISTS trade_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trade_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(trade_id) REFERENCES trades(id)
      );

      CREATE INDEX IF NOT EXISTS idx_trade_events_trade ON trade_events(trade_id, created_at);

      CREATE TABLE IF NOT EXISTS equity_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        broker TEXT NOT NULL CHECK (broker IN ('BINANCE','MT5','GLOBAL')),
        balance REAL NOT NULL,
        equity REAL NOT NULL,
        realized_pnl REAL NOT NULL DEFAULT 0,
        unrealized_pnl REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_equity_broker_time ON equity_snapshots(broker, created_at DESC);

      CREATE TABLE IF NOT EXISTS telegram_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trade_id TEXT,
        event_type TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT,
        error TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS engine_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    // Existing V34 databases predate execution_mode. Add it without destroying any
    // history, then identify legacy PAPER rows by their synthetic broker order id.
    const columns = this.db.pragma('table_info(trades)') as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'execution_mode')) {
      this.db.exec(`ALTER TABLE trades ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'REAL'`);
      this.db.prepare(`
        UPDATE trades SET execution_mode='PAPER'
        WHERE broker='BINANCE' AND broker_order_id LIKE 'PAPER-%'
      `).run();
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_trades_execution_mode ON trades(execution_mode, created_at DESC)`);
  }

  getSettings(): EngineSettings | null {
    const row = this.db.prepare('SELECT payload FROM settings WHERE id = 1').get() as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as EngineSettings : null;
  }

  saveSettings(settings: EngineSettings): void {
    this.db.prepare(`
      INSERT INTO settings(id, payload, updated_at)
      VALUES(1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at
    `).run(JSON.stringify(settings), Date.now());
  }

  getActiveTrades(broker?: Broker): TradeRecord[] {
    const active = `('PENDING','OPENING','OPEN','CLOSING','SYNC_REQUIRED')`;
    const rows = broker
      ? this.db.prepare(`SELECT * FROM trades WHERE broker = ? AND state IN ${active} ORDER BY created_at DESC`).all(broker)
      : this.db.prepare(`SELECT * FROM trades WHERE state IN ${active} ORDER BY created_at DESC`).all();
    return (rows as Record<string, unknown>[]).map(mapTradeRow);
  }

  getRecentTrades(limit = 250): TradeRecord[] {
    const rows = this.db.prepare('SELECT * FROM trades ORDER BY created_at DESC LIMIT ?').all(limit);
    return (rows as Record<string, unknown>[]).map(mapTradeRow);
  }

  createTrade(trade: TradeRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO trades(
        id, broker, execution_mode, symbol, side, strategy, timeframe, confidence, rolling_win_rate,
        entry_price, exit_price, stop_loss, take_profit, tp2, tp3, leverage, lot_size,
        margin_used, notional, commission, funding_or_swap, unrealized_pnl, realized_pnl,
        state, close_reason, broker_order_id, signal_id, signal_fingerprint, open_time,
        close_time, created_at, updated_at, metadata
      ) VALUES (
        @id, @broker, @executionMode, @symbol, @side, @strategy, @timeframe, @confidence, @rollingWinRate,
        @entryPrice, @exitPrice, @stopLoss, @takeProfit, @tp2, @tp3, @leverage, @lotSize,
        @marginUsed, @notional, @commission, @fundingOrSwap, @unrealizedPnl, @realizedPnl,
        @state, @closeReason, @brokerOrderId, @signalId, @signalFingerprint, @openTime,
        @closeTime, @createdAt, @updatedAt, @metadataJson
      )
    `);

    stmt.run({
      ...trade,
      executionMode: trade.executionMode ?? 'REAL',
      exitPrice: trade.exitPrice ?? null,
      tp2: trade.tp2 ?? null,
      tp3: trade.tp3 ?? null,
      leverage: trade.leverage ?? null,
      lotSize: trade.lotSize ?? null,
      marginUsed: trade.marginUsed ?? null,
      notional: trade.notional ?? null,
      commission: trade.commission ?? 0,
      fundingOrSwap: trade.fundingOrSwap ?? 0,
      closeReason: trade.closeReason ?? null,
      brokerOrderId: trade.brokerOrderId ?? null,
      openTime: trade.openTime ?? null,
      closeTime: trade.closeTime ?? null,
      metadataJson: trade.metadata ? JSON.stringify(trade.metadata) : null,
    });
  }

  addTradeEvent(tradeId: string, eventType: string, payload?: unknown): void {
    this.db.prepare(`
      INSERT INTO trade_events(trade_id, event_type, payload, created_at)
      VALUES(?, ?, ?, ?)
    `).run(tradeId, eventType, payload == null ? null : JSON.stringify(payload), Date.now());
  }
}

function mapTradeRow(row: Record<string, unknown>): TradeRecord {
  return {
    id: String(row.id),
    broker: row.broker as Broker,
    executionMode: String(row.execution_mode ?? 'REAL') as TradeRecord['executionMode'],
    symbol: String(row.symbol),
    side: row.side as TradeRecord['side'],
    strategy: String(row.strategy),
    timeframe: String(row.timeframe),
    confidence: Number(row.confidence),
    rollingWinRate: Number(row.rolling_win_rate),
    entryPrice: Number(row.entry_price),
    exitPrice: row.exit_price == null ? undefined : Number(row.exit_price),
    stopLoss: Number(row.stop_loss),
    takeProfit: Number(row.take_profit),
    tp2: row.tp2 == null ? undefined : Number(row.tp2),
    tp3: row.tp3 == null ? undefined : Number(row.tp3),
    leverage: row.leverage == null ? undefined : Number(row.leverage),
    lotSize: row.lot_size == null ? undefined : Number(row.lot_size),
    marginUsed: row.margin_used == null ? undefined : Number(row.margin_used),
    notional: row.notional == null ? undefined : Number(row.notional),
    commission: Number(row.commission ?? 0),
    fundingOrSwap: Number(row.funding_or_swap ?? 0),
    unrealizedPnl: Number(row.unrealized_pnl ?? 0),
    realizedPnl: Number(row.realized_pnl ?? 0),
    state: row.state as TradeRecord['state'],
    closeReason: row.close_reason == null ? undefined : row.close_reason as TradeRecord['closeReason'],
    brokerOrderId: row.broker_order_id == null ? undefined : String(row.broker_order_id),
    signalId: String(row.signal_id),
    signalFingerprint: String(row.signal_fingerprint),
    openTime: row.open_time == null ? undefined : Number(row.open_time),
    closeTime: row.close_time == null ? undefined : Number(row.close_time),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    metadata: row.metadata ? JSON.parse(String(row.metadata)) : undefined,
  };
}
