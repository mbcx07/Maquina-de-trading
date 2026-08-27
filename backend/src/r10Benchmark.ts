import { auditV335Symbol, defaultAuditRules } from './universeAuditCore.js';
import type { Candle } from './analysis.js';

const BASE = 'https://fapi.binance.com';
const DAY = 24 * 60 * 60_000;
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];
const DAYS = 14;

async function fetchRange(symbol: string, interval: '5m'|'15m', startTime: number, endTime: number): Promise<Candle[]> {
  const step = interval === '5m' ? 5 * 60_000 : 15 * 60_000;
  const out: Candle[] = [];
  let cursor = startTime;
  while (cursor <= endTime) {
    const url = `${BASE}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&endTime=${endTime}&limit=1000`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`BINANCE_${response.status}:${symbol}:${interval}`);
    const rows = await response.json() as any[];
    if (!rows.length) break;
    for (const row of rows) {
      if (Number(row[6]) > Date.now()) continue;
      out.push({
        time: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]),
        close: Number(row[4]), volume: Number(row[5] ?? 0),
      });
    }
    const next = Number(rows.at(-1)?.[0] ?? cursor) + step;
    if (next <= cursor || rows.length < 1000) break;
    cursor = next;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  const map = new Map(out.map((c) => [c.time, c]));
  return [...map.values()].sort((a, b) => a.time - b.time);
}

async function main() {
  const endTime = Date.now() - 15 * 60_000;
  const startTime = endTime - DAYS * DAY;
  const warmup = startTime - 220 * 15 * 60_000;
  const rules = defaultAuditRules(startTime, endTime);
  const results: any[] = [];

  for (const symbol of SYMBOLS) {
    const [m5, m15] = await Promise.all([
      fetchRange(symbol, '5m', warmup, endTime),
      fetchRange(symbol, '15m', warmup, endTime),
    ]);
    const result = auditV335Symbol(symbol, m5, m15, rules);
    const row = {
      symbol,
      qualified: result.qualified,
      trades: result.metrics.trades,
      winRate: Number(result.metrics.winRate.toFixed(2)),
      profitFactor: result.metrics.profitFactor == null ? null : Number(result.metrics.profitFactor.toFixed(2)),
      expectancyPct: Number(result.metrics.expectancyPct.toFixed(4)),
      netReturnPct: Number(result.metrics.netReturnPct.toFixed(2)),
      maxDrawdownPct: Number(result.metrics.maxDrawdownPct.toFixed(2)),
      oosTrades: result.outOfSample.trades,
      oosWinRate: Number(result.outOfSample.winRate.toFixed(2)),
      oosProfitFactor: result.outOfSample.profitFactor == null ? null : Number(result.outOfSample.profitFactor.toFixed(2)),
      oosNetReturnPct: Number(result.outOfSample.netReturnPct.toFixed(2)),
      reasons: result.reasons,
    };
    results.push(row);
    console.log('R10_BENCH', JSON.stringify(row));
  }

  const withTrades = results.filter((r) => r.trades > 0);
  const aggregate = {
    symbols: results.length,
    qualified: results.filter((r) => r.qualified).length,
    totalTrades: withTrades.reduce((sum, r) => sum + r.trades, 0),
    weightedWinRate: withTrades.length
      ? Number((withTrades.reduce((sum, r) => sum + r.winRate * r.trades, 0) / withTrades.reduce((sum, r) => sum + r.trades, 0)).toFixed(2))
      : 0,
    minWinRate: withTrades.length ? Math.min(...withTrades.map((r) => r.winRate)) : 0,
    maxWinRate: withTrades.length ? Math.max(...withTrades.map((r) => r.winRate)) : 0,
  };
  console.log('R10_BENCH_SUMMARY', JSON.stringify(aggregate));
}

main().catch((error) => {
  console.error('R10_BENCH_ERROR', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
