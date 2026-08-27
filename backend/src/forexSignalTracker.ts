import type { Candle } from './analysis.js';
import { TradingDatabase } from './database.js';
import type { Opportunity, TradeSide } from './types.js';

export type ForexOutcomeStatus = 'OPEN' | 'WIN' | 'LOSS' | 'EXPIRED';

export interface ForexOutcomeRow {
  signalId: string;
  symbol: string;
  dataSymbol?: string;
  side: TradeSide;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  status: ForexOutcomeStatus;
  exitPrice?: number;
  returnPct?: number;
  createdAt: number;
  resolvedAt?: number;
  lastCheckedTime?: number;
}

export interface ForexPerformanceSummary {
  tracked: number;
  open: number;
  resolved: number;
  wins: number;
  losses: number;
  expired: number;
  winRate: number;
  netReturnPct: number;
  grossProfitPct: number;
  grossLossPct: number;
  profitFactor: number | null;
  expectancyPct: number;
  bySymbol: Array<{
    symbol: string;
    tracked: number;
    resolved: number;
    wins: number;
    losses: number;
    winRate: number;
    netReturnPct: number;
    profitFactor: number | null;
    expectancyPct: number;
  }>;
  recent: ForexOutcomeRow[];
}

const MAX_SIGNAL_AGE_MS = 24 * 60 * 60_000;

export class ForexSignalTracker {
  constructor(private readonly database: TradingDatabase) {
    this.ensureSchema();
  }

  register(signal: Opportunity): void {
    const dataSymbol = typeof signal.metadata?.dataSymbol === 'string' ? signal.metadata.dataSymbol : undefined;
    this.database.db.prepare(`
      INSERT INTO forex_signal_outcomes(
        signal_id, symbol, data_symbol, side, entry_price, stop_loss, take_profit,
        status, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?)
      ON CONFLICT(signal_id) DO NOTHING
    `).run(
      signal.signalId,
      signal.symbol.toUpperCase(),
      dataSymbol ?? null,
      signal.side,
      signal.entry,
      signal.stopLoss,
      signal.takeProfit,
      signal.createdAt,
      Date.now(),
    );
  }

  updateFromCandles(symbol: string, candles: Candle[]): void {
    if (!candles.length) return;
    const normalized = symbol.toUpperCase();
    const rows = this.database.db.prepare(`
      SELECT * FROM forex_signal_outcomes
      WHERE symbol = ? AND status = 'OPEN'
      ORDER BY created_at ASC
    `).all(normalized) as Array<Record<string, unknown>>;
    if (!rows.length) return;

    const sorted = [...candles].sort((a, b) => a.time - b.time);
    const latest = sorted.at(-1)!;

    for (const raw of rows) {
      const row = mapRow(raw);
      const firstSafeCandle = Math.floor(row.createdAt / 60_000) * 60_000 + 60_000;
      const from = Math.max(firstSafeCandle, (row.lastCheckedTime ?? 0) + 60_000);
      const relevant = sorted.filter((candle) => candle.time >= from);

      let resolved = false;
      for (const candle of relevant) {
        const slTouched = row.side === 'BUY' ? candle.low <= row.stopLoss : candle.high >= row.stopLoss;
        const tpTouched = row.side === 'BUY' ? candle.high >= row.takeProfit : candle.low <= row.takeProfit;

        // Conservative same-candle handling: if OHLC cannot prove order, count SL first.
        if (slTouched) {
          this.resolve(row, 'LOSS', row.stopLoss, candle.time);
          resolved = true;
          break;
        }
        if (tpTouched) {
          this.resolve(row, 'WIN', row.takeProfit, candle.time);
          resolved = true;
          break;
        }
      }
      if (resolved) continue;

      if (Date.now() - row.createdAt >= MAX_SIGNAL_AGE_MS) {
        this.resolve(row, 'EXPIRED', latest.close, latest.time);
        continue;
      }

      if (relevant.length) {
        this.database.db.prepare(`
          UPDATE forex_signal_outcomes
          SET last_checked_time = ?, updated_at = ?
          WHERE signal_id = ?
        `).run(relevant.at(-1)!.time, Date.now(), row.signalId);
      }
    }
  }

  summary(limitRecent = 40): ForexPerformanceSummary {
    const rows = this.database.db.prepare(`
      SELECT * FROM forex_signal_outcomes ORDER BY created_at DESC
    `).all() as Array<Record<string, unknown>>;
    const all = rows.map(mapRow);
    const resolved = all.filter((row) => row.status === 'WIN' || row.status === 'LOSS');
    const wins = resolved.filter((row) => row.status === 'WIN');
    const losses = resolved.filter((row) => row.status === 'LOSS');
    const expired = all.filter((row) => row.status === 'EXPIRED').length;
    const grossProfitPct = wins.reduce((sum, row) => sum + Math.max(0, row.returnPct ?? 0), 0);
    const grossLossAbs = Math.abs(losses.reduce((sum, row) => sum + Math.min(0, row.returnPct ?? 0), 0));
    const netReturnPct = resolved.reduce((sum, row) => sum + (row.returnPct ?? 0), 0);

    const symbols = [...new Set(all.map((row) => row.symbol))];
    const bySymbol = symbols.map((symbol) => {
      const symbolRows = all.filter((row) => row.symbol === symbol);
      const symbolResolved = symbolRows.filter((row) => row.status === 'WIN' || row.status === 'LOSS');
      const symbolWins = symbolResolved.filter((row) => row.status === 'WIN');
      const symbolLosses = symbolResolved.filter((row) => row.status === 'LOSS');
      const gp = symbolWins.reduce((sum, row) => sum + Math.max(0, row.returnPct ?? 0), 0);
      const gl = Math.abs(symbolLosses.reduce((sum, row) => sum + Math.min(0, row.returnPct ?? 0), 0));
      const net = symbolResolved.reduce((sum, row) => sum + (row.returnPct ?? 0), 0);
      return {
        symbol,
        tracked: symbolRows.length,
        resolved: symbolResolved.length,
        wins: symbolWins.length,
        losses: symbolLosses.length,
        winRate: symbolResolved.length ? symbolWins.length / symbolResolved.length * 100 : 0,
        netReturnPct: net,
        profitFactor: gl > 0 ? gp / gl : gp > 0 ? null : 0,
        expectancyPct: symbolResolved.length ? net / symbolResolved.length : 0,
      };
    }).sort((a, b) => b.netReturnPct - a.netReturnPct || b.winRate - a.winRate);

    return {
      tracked: all.length,
      open: all.filter((row) => row.status === 'OPEN').length,
      resolved: resolved.length,
      wins: wins.length,
      losses: losses.length,
      expired,
      winRate: resolved.length ? wins.length / resolved.length * 100 : 0,
      netReturnPct,
      grossProfitPct,
      grossLossPct: -grossLossAbs,
      profitFactor: grossLossAbs > 0 ? grossProfitPct / grossLossAbs : grossProfitPct > 0 ? null : 0,
      expectancyPct: resolved.length ? netReturnPct / resolved.length : 0,
      bySymbol,
      recent: all.slice(0, Math.max(1, limitRecent)),
    };
  }

  private resolve(row: ForexOutcomeRow, status: 'WIN' | 'LOSS' | 'EXPIRED', exitPrice: number, resolvedAt: number): void {
    const returnPct = directionalReturnPct(row.side, row.entry, exitPrice);
    this.database.db.prepare(`
      UPDATE forex_signal_outcomes
      SET status = ?, exit_price = ?, return_pct = ?, resolved_at = ?, last_checked_time = ?, updated_at = ?
      WHERE signal_id = ? AND status = 'OPEN'
    `).run(status, exitPrice, returnPct, resolvedAt, resolvedAt, Date.now(), row.signalId);
  }

  private ensureSchema(): void {
    this.database.db.exec(`
      CREATE TABLE IF NOT EXISTS forex_signal_outcomes (
        signal_id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        data_symbol TEXT,
        side TEXT NOT NULL CHECK(side IN ('BUY','SELL')),
        entry_price REAL NOT NULL,
        stop_loss REAL NOT NULL,
        take_profit REAL NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('OPEN','WIN','LOSS','EXPIRED')),
        exit_price REAL,
        return_pct REAL,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER,
        last_checked_time INTEGER,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_forex_outcomes_symbol_status
        ON forex_signal_outcomes(symbol, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_forex_outcomes_created
        ON forex_signal_outcomes(created_at DESC);
    `);
  }
}

function mapRow(row: Record<string, unknown>): ForexOutcomeRow {
  return {
    signalId: String(row.signal_id),
    symbol: String(row.symbol),
    dataSymbol: row.data_symbol == null ? undefined : String(row.data_symbol),
    side: String(row.side) as TradeSide,
    entry: Number(row.entry_price),
    stopLoss: Number(row.stop_loss),
    takeProfit: Number(row.take_profit),
    status: String(row.status) as ForexOutcomeStatus,
    exitPrice: row.exit_price == null ? undefined : Number(row.exit_price),
    returnPct: row.return_pct == null ? undefined : Number(row.return_pct),
    createdAt: Number(row.created_at),
    resolvedAt: row.resolved_at == null ? undefined : Number(row.resolved_at),
    lastCheckedTime: row.last_checked_time == null ? undefined : Number(row.last_checked_time),
  };
}

function directionalReturnPct(side: TradeSide, entry: number, exit: number): number {
  if (!(entry > 0) || !(exit > 0)) return 0;
  return side === 'BUY' ? (exit - entry) / entry * 100 : (entry - exit) / entry * 100;
}
