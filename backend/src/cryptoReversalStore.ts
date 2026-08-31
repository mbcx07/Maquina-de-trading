import { TradingDatabase } from './database.js';
import type { AppMode } from './types.js';

export interface CryptoReversalBlock {
  executionMode: AppMode;
  symbol: string;
  blockedUntil: number;
  reason: string;
  score: number;
  updatedAt: number;
}

export function ensureCryptoReversalSchema(database: TradingDatabase): void {
  database.db.exec(`
    CREATE TABLE IF NOT EXISTS crypto_reversal_blocks (
      execution_mode TEXT NOT NULL,
      symbol TEXT NOT NULL,
      blocked_until INTEGER NOT NULL,
      reason TEXT NOT NULL,
      score REAL NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(execution_mode, symbol)
    );
    CREATE INDEX IF NOT EXISTS idx_crypto_reversal_blocks_until
      ON crypto_reversal_blocks(execution_mode, blocked_until);
  `);
}

export function setCryptoReversalBlock(
  database: TradingDatabase,
  mode: AppMode,
  symbol: string,
  durationMs: number,
  reason: string,
  score: number,
): CryptoReversalBlock {
  ensureCryptoReversalSchema(database);
  const now = Date.now();
  const block: CryptoReversalBlock = {
    executionMode: mode,
    symbol: symbol.toUpperCase(),
    blockedUntil: now + Math.max(0, durationMs),
    reason,
    score,
    updatedAt: now,
  };
  database.db.prepare(`
    INSERT INTO crypto_reversal_blocks(execution_mode, symbol, blocked_until, reason, score, updated_at)
    VALUES(?, ?, ?, ?, ?, ?)
    ON CONFLICT(execution_mode, symbol) DO UPDATE SET
      blocked_until=MAX(crypto_reversal_blocks.blocked_until, excluded.blocked_until),
      reason=excluded.reason,
      score=excluded.score,
      updated_at=excluded.updated_at
  `).run(block.executionMode, block.symbol, block.blockedUntil, block.reason, block.score, block.updatedAt);
  return getCryptoReversalBlock(database, mode, symbol) ?? block;
}

export function getCryptoReversalBlock(
  database: TradingDatabase,
  mode: AppMode,
  symbol: string,
  now = Date.now(),
): CryptoReversalBlock | null {
  ensureCryptoReversalSchema(database);
  database.db.prepare(`DELETE FROM crypto_reversal_blocks WHERE execution_mode=? AND blocked_until<=?`).run(mode, now);
  const row = database.db.prepare(`
    SELECT execution_mode, symbol, blocked_until, reason, score, updated_at
    FROM crypto_reversal_blocks
    WHERE execution_mode=? AND symbol=? AND blocked_until>?
  `).get(mode, symbol.toUpperCase(), now) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    executionMode: String(row.execution_mode) as AppMode,
    symbol: String(row.symbol),
    blockedUntil: Number(row.blocked_until),
    reason: String(row.reason),
    score: Number(row.score),
    updatedAt: Number(row.updated_at),
  };
}

export function listCryptoReversalBlocks(
  database: TradingDatabase,
  mode: AppMode,
  now = Date.now(),
): CryptoReversalBlock[] {
  ensureCryptoReversalSchema(database);
  database.db.prepare(`DELETE FROM crypto_reversal_blocks WHERE execution_mode=? AND blocked_until<=?`).run(mode, now);
  const rows = database.db.prepare(`
    SELECT execution_mode, symbol, blocked_until, reason, score, updated_at
    FROM crypto_reversal_blocks
    WHERE execution_mode=? AND blocked_until>?
    ORDER BY blocked_until DESC
  `).all(mode, now) as Record<string, unknown>[];
  return rows.map((row) => ({
    executionMode: String(row.execution_mode) as AppMode,
    symbol: String(row.symbol),
    blockedUntil: Number(row.blocked_until),
    reason: String(row.reason),
    score: Number(row.score),
    updatedAt: Number(row.updated_at),
  }));
}
