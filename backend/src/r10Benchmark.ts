import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { calibrateR11, evaluateConfigExternalR11, type R11Trade } from './highWinrateR11.js';
import type { Candle } from './analysis.js';

const BASE = 'https://data.binance.vision/data/futures/um/daily/klines';
const DAY = 24 * 60 * 60_000;
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];
const CALIBRATION_DAYS = 21;
const EXTERNAL_DAYS = 7;
const ROUND_TRIP_COST_PCT = 0.12;

function utcDay(ms: number): string { return new Date(ms).toISOString().slice(0, 10); }
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

function externalMetrics(trades: R11Trade[]) {
  let wins = 0;
  let losses = 0;
  let grossProfitPct = 0;
  let grossLossPct = 0;
  let netSumPct = 0;
  let equity = 100;
  let peak = 100;
  let maxDrawdownPct = 0;

  for (const trade of trades) {
    const rawPct = trade.direction > 0
      ? (trade.exit - trade.entry) / trade.entry * 100
      : (trade.entry - trade.exit) / trade.entry * 100;
    const netPct = rawPct - ROUND_TRIP_COST_PCT;
    netSumPct += netPct;
    if (netPct > 0) { wins++; grossProfitPct += netPct; }
    else { losses++; grossLossPct += netPct; }
    equity *= 1 + netPct / 100;
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, peak > 0 ? (peak - equity) / peak * 100 : 0);
  }

  const lossAbs = Math.abs(grossLossPct);
  return {
    trades: trades.length,
    wins,
    losses,
    winRate: trades.length ? wins / trades.length * 100 : 0,
    netReturnPct: equity - 100,
    expectancyPct: trades.length ? netSumPct / trades.length : 0,
    profitFactor: lossAbs > 0 ? grossProfitPct / lossAbs : grossProfitPct > 0 ? 99 : 0,
    maxDrawdownPct,
  };
}

async function main() {
  const externalEndDay = Math.floor((Date.now() - 2 * DAY) / DAY) * DAY;
  const externalEnd = externalEndDay + DAY - 1;
  const externalStart = externalEnd - EXTERNAL_DAYS * DAY;
  const calibrationEnd = externalStart - 1;
  const calibrationStart = calibrationEnd - CALIBRATION_DAYS * DAY;
  const warmupStart = calibrationStart - 220 * 15 * 60_000;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'r11-bench-'));
  const results: any[] = [];

  for (const symbol of SYMBOLS) {
    const [m5, m15] = await Promise.all([
      fetchVisionRange(symbol, '5m', warmupStart, externalEnd, dir),
      fetchVisionRange(symbol, '15m', warmupStart, externalEnd, dir),
    ]);
    const calibrationM5 = m5.filter((c) => c.time >= calibrationStart && c.time <= calibrationEnd);
    const calibrationM15 = m15.filter((c) => c.time >= calibrationStart - 220 * 15 * 60_000 && c.time <= calibrationEnd);
    if (calibrationM5.length < 3000 || calibrationM15.length < 500) throw new Error(`VISION_INSUFFICIENT:${symbol}:m5=${calibrationM5.length}:m15=${calibrationM15.length}`);

    const model = calibrateR11(calibrationM5, calibrationM15);
    let external = { trades: 0, wins: 0, losses: 0, winRate: 0, netReturnPct: 0, expectancyPct: 0, profitFactor: 0, maxDrawdownPct: 0 };
    if (model.ready) {
      const evaluation = evaluateConfigExternalR11(m5, m15, model.config, externalStart, externalEnd);
      external = externalMetrics(evaluation.trades);
    }

    const row = {
      symbol,
      modelReady: model.ready,
      modelStatus: model.status,
      fallback: model.fallback,
      config: model.config,
      train: summarize(model.train),
      validation: summarize(model.validation),
      holdout: summarize(model.holdout),
      external: summarizeExternal(external),
      externalPass: model.ready && external.trades >= 3 && external.winRate >= 64 && external.expectancyPct > 0 && external.profitFactor >= 1.02,
    };
    results.push(row);
    console.log('R11_BENCH', JSON.stringify(row));
  }

  const ready = results.filter((row) => row.modelReady);
  const extTrades = ready.reduce((sum, row) => sum + row.external.trades, 0);
  const weightedExternalWR = extTrades
    ? ready.reduce((sum, row) => sum + row.external.winRate * row.external.trades, 0) / extTrades
    : 0;
  const summary = {
    symbols: results.length,
    modelsReady: ready.length,
    externalPass: results.filter((row) => row.externalPass).length,
    externalTrades: extTrades,
    weightedExternalWinRate: Number(weightedExternalWR.toFixed(2)),
    positiveExternalExpectancy: ready.filter((row) => row.external.expectancyPct > 0).length,
  };
  console.log('R11_BENCH_SUMMARY', JSON.stringify(summary));
}

function summarize(stats: any) {
  return {
    trades: stats.trades,
    winRate: Number(stats.winRate.toFixed(2)),
    profitFactor: Number(stats.profitFactor.toFixed(2)),
    expectancyR: Number(stats.expectancyR.toFixed(3)),
    maxDDR: Number(stats.maxDDR.toFixed(2)),
  };
}
function summarizeExternal(stats: any) {
  return {
    trades: stats.trades,
    wins: stats.wins,
    losses: stats.losses,
    winRate: Number(stats.winRate.toFixed(2)),
    netReturnPct: Number(stats.netReturnPct.toFixed(3)),
    expectancyPct: Number(stats.expectancyPct.toFixed(4)),
    profitFactor: Number(stats.profitFactor.toFixed(2)),
    maxDrawdownPct: Number(stats.maxDrawdownPct.toFixed(3)),
  };
}

main().catch((error) => {
  console.error('R11_BENCH_ERROR', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
