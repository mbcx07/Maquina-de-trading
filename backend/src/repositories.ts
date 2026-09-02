import type { Opportunity, TradeRecord, TradeState } from './types.js';
import { TradingDatabase } from './database.js';

const ACTIVE_TRADE_STATES = "('PENDING','OPENING','OPEN','CLOSING','SYNC_REQUIRED')";

export class TradingRepository {
  constructor(private readonly database: TradingDatabase) {}

  saveSignal(opportunity: Opportunity): void {
    const now = Date.now();
    const payload = JSON.stringify(opportunity);

    this.database.db.prepare(`
      INSERT INTO signals(id, broker, symbol, fingerprint, payload, created_at)
      VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload=excluded.payload
    `).run(
      opportunity.signalId,
      opportunity.broker,
      opportunity.symbol.toUpperCase(),
      opportunity.signalFingerprint,
      payload,
      now,
    );

    this.database.db.prepare(`
      INSERT INTO opportunities(id, signal_id, broker, symbol, score, executable, payload, created_at)
      VALUES(?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET score=excluded.score, executable=1, rejection_reason=NULL, payload=excluded.payload
    `).run(
      opportunity.id,
      opportunity.signalId,
      opportunity.broker,
      opportunity.symbol.toUpperCase(),
      opportunity.score,
      payload,
      opportunity.createdAt,
    );
  }

  rejectOpportunity(id: string, reason: string): void {
    this.database.db.prepare(`
      UPDATE opportunities SET executable = 0, rejection_reason = ? WHERE id = ?
    `).run(reason, id);
  }

  createTradeAtomically(trade: TradeRecord): void {
    const insert = this.database.db.transaction(() => {
      // The SQLite partial unique index is the final concurrency guard per symbol.
      this.database.createTrade(trade);
      this.database.addTradeEvent(trade.id, 'TRADE_RESERVED', {
        broker: trade.broker,
        symbol: trade.symbol,
        signalId: trade.signalId,
      });
    });
    insert();
  }

  /**
   * Final Crypto concurrency guard.
   *
   * Several opportunities can now execute in parallel. Selection-side slot checks are
   * intentionally not trusted as the final authority because two promises can observe
   * the same free slot before either has inserted its OPENING row. SQLite serializes this
   * transaction, so max slots + max allocated margin + one-position-per-symbol remain
   * deterministic even under concurrent execution.
   */
  reserveCryptoTradeAtomically(
    trade: TradeRecord,
    maxSlots: number,
    maxAllocatedMargin: number,
  ): { activeBefore: number; allocatedMarginBefore: number } {
    if (trade.broker !== 'BINANCE') throw new Error('CRYPTO_RESERVATION_REQUIRES_BINANCE_TRADE');
    const mode = trade.executionMode ?? 'REAL';
    const normalizedMaxSlots = Math.max(1, Math.min(10, Math.floor(maxSlots)));
    const marginRequired = Math.max(0, Number(trade.marginUsed ?? 0));

    const reserve = this.database.db.transaction(() => {
      const countRow = this.database.db.prepare(`
        SELECT COUNT(*) AS n
        FROM trades
        WHERE broker='BINANCE' AND execution_mode=? AND state IN ${ACTIVE_TRADE_STATES}
      `).get(mode) as { n: number };
      const activeBefore = Number(countRow?.n ?? 0);
      if (activeBefore >= normalizedMaxSlots) throw new Error('CRYPTO_MAX_SLOTS_REACHED_ATOMIC');

      const marginRow = this.database.db.prepare(`
        SELECT COALESCE(SUM(
          CASE
            WHEN margin_used IS NOT NULL AND margin_used > 0 THEN margin_used
            WHEN notional IS NOT NULL AND leverage IS NOT NULL AND leverage > 0 THEN notional / leverage
            ELSE 0
          END
        ), 0) AS allocated
        FROM trades
        WHERE broker='BINANCE' AND execution_mode=? AND state IN ${ACTIVE_TRADE_STATES}
      `).get(mode) as { allocated: number };
      const allocatedMarginBefore = Math.max(0, Number(marginRow?.allocated ?? 0));
      if (allocatedMarginBefore + marginRequired > Math.max(0, maxAllocatedMargin) + 1e-9) {
        throw new Error(
          `CRYPTO_ACCOUNT_EXPOSURE_LIMIT_ATOMIC:allocated=${allocatedMarginBefore.toFixed(4)}:new=${marginRequired.toFixed(4)}:max=${Math.max(0, maxAllocatedMargin).toFixed(4)}`,
        );
      }

      // ux_binance_active_mode_symbol remains the final duplicate-symbol guard.
      this.database.createTrade(trade);
      this.database.addTradeEvent(trade.id, 'TRADE_RESERVED', {
        broker: trade.broker,
        symbol: trade.symbol,
        signalId: trade.signalId,
        executionMode: mode,
        concurrentReservation: true,
        activeBefore,
        allocatedMarginBefore,
        marginRequired,
        maxSlots: normalizedMaxSlots,
        maxAllocatedMargin,
      });
      return { activeBefore, allocatedMarginBefore };
    });

    return reserve();
  }

  getTrade(id: string): TradeRecord | null {
    const row = this.database.db.prepare('SELECT id FROM trades WHERE id = ?').get(id) as { id: string } | undefined;
    if (!row) return null;
    return this.database.getRecentTrades(10000).find((trade) => trade.id === id) ?? null;
  }

  patchTrade(id: string, patch: Partial<TradeRecord>): void {
    const allowed = new Map<keyof TradeRecord, string>([
      ['state', 'state'],
      ['entryPrice', 'entry_price'],
      ['exitPrice', 'exit_price'],
      ['stopLoss', 'stop_loss'],
      ['takeProfit', 'take_profit'],
      ['tp2', 'tp2'],
      ['tp3', 'tp3'],
      ['leverage', 'leverage'],
      ['lotSize', 'lot_size'],
      ['marginUsed', 'margin_used'],
      ['notional', 'notional'],
      ['commission', 'commission'],
      ['fundingOrSwap', 'funding_or_swap'],
      ['unrealizedPnl', 'unrealized_pnl'],
      ['realizedPnl', 'realized_pnl'],
      ['closeReason', 'close_reason'],
      ['brokerOrderId', 'broker_order_id'],
      ['openTime', 'open_time'],
      ['closeTime', 'close_time'],
    ]);

    const assignments: string[] = [];
    const values: unknown[] = [];

    for (const [key, column] of allowed) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        assignments.push(`${column} = ?`);
        values.push(patch[key] ?? null);
      }
    }

    if (!assignments.length) return;
    assignments.push('updated_at = ?');
    values.push(Date.now(), id);

    this.database.db.prepare(`UPDATE trades SET ${assignments.join(', ')} WHERE id = ?`).run(...values);
  }

  setTradeState(id: string, state: TradeState, eventType: string, payload?: unknown): void {
    const tx = this.database.db.transaction(() => {
      this.patchTrade(id, { state });
      this.database.addTradeEvent(id, eventType, payload);
    });
    tx();
  }

  recordEquitySnapshot(
    broker: 'BINANCE' | 'MT5' | 'GLOBAL',
    balance: number,
    equity: number,
    realizedPnl = 0,
    unrealizedPnl = 0,
  ): void {
    this.database.db.prepare(`
      INSERT INTO equity_snapshots(broker, balance, equity, realized_pnl, unrealized_pnl, created_at)
      VALUES(?, ?, ?, ?, ?, ?)
    `).run(broker, balance, equity, realizedPnl, unrealizedPnl, Date.now());
  }
}
