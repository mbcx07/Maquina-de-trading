import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { auditV335Symbol, defaultAuditRules } from './universeAuditCore.js';
import type { Candle } from './analysis.js';

const BASE = 'https://data.binance.vision/data/futures/um/daily/klines';
const DAY = 24 * 60 * 60_000;
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];
const DAYS = 14;

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function normalizeEpoch(value: number): number {
  if (value > 1e17) return Math.floor(value / 1_000_000);
  if (value > 1e14) return Math.floor(value / 1000);
  return value;
}

async function fetchDailyZip(symbol: string, interval: '5m'|'15m', day: string, dir: string): Promise<Candle[]> {
  const filename = `${symbol}-${interval}-${day}.zip`;
  const url = `${BASE}/${symbol}/${interval}/${filename}`;
  const response = await fetch(url);
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`VISION_${response.status}:${symbol}:${interval}:${day}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const file = path.join(dir, filename);
  await writeFile(file, bytes);
  const csv = execFileSync('unzip', ['-p', file], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const rows: Candle[] = [];
  for (const line of csv.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cols = line.split(',');
    const rawTime = Number(cols[0]);
    if (!Number.isFinite(rawTime)) continue;
    const time = normalizeEpoch(rawTime);
    const open = Number(cols[1]), high = Number(cols[2]), low = Number(cols[3]), close = Number(cols[4]), volume = Number(cols[5] ?? 0);
    if (![time, open, high, low, close].every(Number.isFinite)) continue;
    rows.push({ time, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 });
  }
  return rows;
}

async function fetchVisionRange(symbol: string, interval: '5m'|'15m', startTime: number, endTime: number, dir: string): Promise<Candle[]> {
  const startDay = Math.floor(startTime / DAY) * DAY;
  const endDay = Math.floor(endTime / DAY) * DAY;
  const out: Candle[] = [];
  for (let cursor = startDay; cursor <= endDay; cursor += DAY) {
    const rows = await fetchDailyZip(symbol, interval, utcDay(cursor), dir);
    out.push(...rows.filter((row) => row.time >= startTime && row.time <= endTime));
  }
  const map = new Map(out.map((candle) => [candle.time, candle]));
  return [...map.values()].sort((a, b) => a.time - b.time);
}

async function main() {
  // Data Vision daily archives are safest when ending two UTC days back.
  const endDay = Math.floor((Date.now() - 2 * DAY) / DAY) * DAY;
  const endTime = endDay + DAY - 1;
  const startTime = endTime - DAYS * DAY;
  const warmup = startTime - 220 * 15 * 60_000;
  const rules = defaultAuditRules(startTime, endTime);
  const results: any[] = [];
  const dir = await mkdtemp(path.join(os.tmpdir(), 'r10-bench-'));

  for (const symbol of SYMBOLS) {
    const [m5, m15] = await Promise.all([
      fetchVisionRange(symbol, '5m', warmup, endTime, dir),
      fetchVisionRange(symbol, '15m', warmup, endTime, dir),
    ]);
    if (m5.length < 1000 || m15.length < 300) throw new Error(`VISION_INSUFFICIENT:${symbol}:m5=${m5.length}:m15=${m15.length}`);
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

  const withTrades = results.filter((row) => row.trades > 0);
  const totalTrades = withTrades.reduce((sum, row) => sum + row.trades, 0);
  const aggregate = {
    symbols: results.length,
    qualified: results.filter((row) => row.qualified).length,
    totalTrades,
    weightedWinRate: totalTrades
      ? Number((withTrades.reduce((sum, row) => sum + row.winRate * row.trades, 0) / totalTrades).toFixed(2))
      : 0,
    minWinRate: withTrades.length ? Math.min(...withTrades.map((row) => row.winRate)) : 0,
    maxWinRate: withTrades.length ? Math.max(...withTrades.map((row) => row.winRate)) : 0,
  };
  console.log('R10_BENCH_SUMMARY', JSON.stringify(aggregate));
}

main().catch((error) => {
  console.error('R10_BENCH_ERROR', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
