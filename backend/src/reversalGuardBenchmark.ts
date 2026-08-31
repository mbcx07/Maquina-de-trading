import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Candle } from './analysis.js';
import { assessCryptoReversal } from './cryptoReversal.js';
import { decideGuardAction } from './cryptoReversalGuard.js';
import { calibrateR11, evaluateConfigExternalR11, type R11Trade } from './highWinrateR11.js';

const BASE = 'https://data.binance.vision/data/futures/um/daily/klines';
const DAY = 24 * 60 * 60_000;
const SYMBOLS = ['XRPUSDT', 'LINKUSDT', 'UNIUSDT', 'AAVEUSDT', 'ARBUSDT'];
const CALIBRATION_DAYS = 21;
const EXTERNAL_DAYS = 7;
const ROUND_TRIP_COST_PCT = 0.12;
const LEVERAGE = 20;

type GuardExitReason = R11Trade['reason'] | 'GUARD_EMERGENCY' | 'GUARD_REVERSAL' | 'GUARD_PREVENTIVE';
interface GuardedTrade extends R11Trade {
  guardReason: GuardExitReason;
  guardScore?: number;
  guardRoePct?: number;
}

function utcDay(ms: number): string { return new Date(ms).toISOString().slice(0, 10); }
function normalizeEpoch(value: number): number {
  if (value > 1e17) return Math.floor(value / 1_000_000);
  if (value > 1e14) return Math.floor(value / 1000);
  return value;
}

async function fetchDailyZip(symbol: string, interval: '5m'|'15m', day: string, dir: string): Promise<Candle[]> {
  const filename = `${symbol}-${interval}-${day}.zip`;
  const response = await fetch(`${BASE}/${symbol}/${interval}/${filename}`);
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
  const out: Candle[] = [];
  for (let cursor = Math.floor(startTime / DAY) * DAY; cursor <= Math.floor(endTime / DAY) * DAY; cursor += DAY) {
    const rows = await fetchDailyZip(symbol, interval, utcDay(cursor), dir);
    out.push(...rows.filter((row) => row.time >= startTime && row.time <= endTime));
  }
  const map = new Map(out.map((candle) => [candle.time, candle]));
  return [...map.values()].sort((a, b) => a.time - b.time);
}

function applyGuard(trade: R11Trade, m5: Candle[], m15: Candle[]): GuardedTrade {
  const side = trade.direction > 0 ? 'BUY' as const : 'SELL' as const;
  const emergencyMove = 0.05 / LEVERAGE;
  const emergencyPrice = trade.direction > 0
    ? trade.entry * (1 - emergencyMove)
    : trade.entry * (1 + emergencyMove);

  // Conservative overlay: only let the guard replace the base exit on an earlier
  // completed M5 bar. If TP/SL occurs in the same bar, preserve the base result.
  for (const candle of m5) {
    if (candle.time < trade.fillTime || candle.time >= trade.exitTime) continue;

    const emergencyTouched = trade.direction > 0
      ? candle.low <= emergencyPrice
      : candle.high >= emergencyPrice;
    if (emergencyTouched) {
      return {
        ...trade,
        exitTime: candle.time,
        exit: emergencyPrice,
        resultR: directionalR(trade, emergencyPrice),
        reason: 'TIMEOUT',
        guardReason: 'GUARD_EMERGENCY',
        guardRoePct: -5,
      };
    }

    const m5Window = m5.filter((row) => row.time <= candle.time).slice(-100);
    const m15Window = m15.filter((row) => row.time <= candle.time).slice(-220);
    if (m5Window.length < 60 || m15Window.length < 210) continue;
    const assessment = assessCryptoReversal(m5Window, m15Window, side);
    const roePct = directionalPriceReturnPct(trade.direction, trade.entry, candle.close) * LEVERAGE;
    const decision = decideGuardAction({ score: assessment.score }, roePct);
    if (decision.action === 'CLOSE_REVERSAL' || decision.action === 'CLOSE_PREVENTIVE' || decision.action === 'CLOSE_EMERGENCY') {
      return {
        ...trade,
        exitTime: candle.time,
        exit: candle.close,
        resultR: directionalR(trade, candle.close),
        reason: 'TIMEOUT',
        guardReason: decision.action === 'CLOSE_PREVENTIVE' ? 'GUARD_PREVENTIVE' : decision.action === 'CLOSE_EMERGENCY' ? 'GUARD_EMERGENCY' : 'GUARD_REVERSAL',
        guardScore: assessment.score,
        guardRoePct: roePct,
      };
    }
  }

  return { ...trade, guardReason: trade.reason };
}

function directionalR(trade: R11Trade, exit: number): number {
  const risk = Math.abs(trade.entry - trade.sl);
  if (!(risk > 0)) return 0;
  return trade.direction > 0 ? (exit - trade.entry) / risk : (trade.entry - exit) / risk;
}

function directionalPriceReturnPct(direction: 1|-1, entry: number, exit: number): number {
  const raw = (exit - entry) / entry * 100;
  return direction > 0 ? raw : -raw;
}

function metrics(trades: Array<R11Trade | GuardedTrade>) {
  let wins = 0, losses = 0, grossProfitPct = 0, grossLossPct = 0, netSumPct = 0;
  let equity = 100, peak = 100, maxDrawdownPct = 0;
  for (const trade of trades) {
    const rawPct = directionalPriceReturnPct(trade.direction, trade.entry, trade.exit);
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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'r11-guard-bench-'));
  const rows: any[] = [];

  for (const symbol of SYMBOLS) {
    const [m5, m15] = await Promise.all([
      fetchVisionRange(symbol, '5m', warmupStart, externalEnd, dir),
      fetchVisionRange(symbol, '15m', warmupStart, externalEnd, dir),
    ]);
    const calibrationM5 = m5.filter((c) => c.time >= calibrationStart && c.time <= calibrationEnd);
    const calibrationM15 = m15.filter((c) => c.time >= calibrationStart - 220 * 15 * 60_000 && c.time <= calibrationEnd);
    const model = calibrateR11(calibrationM5, calibrationM15);
    if (!model.ready) {
      const row = { symbol, modelReady: false, status: model.status };
      rows.push(row);
      console.log('R11_GUARD_BENCH', JSON.stringify(row));
      continue;
    }

    const baseTrades = evaluateConfigExternalR11(m5, m15, model.config, externalStart, externalEnd).trades;
    const guardedTrades = baseTrades.map((trade) => applyGuard(trade, m5, m15));
    const base = metrics(baseTrades);
    const guarded = metrics(guardedTrades);
    const guardCounts = guardedTrades.reduce<Record<string, number>>((acc, trade) => {
      acc[trade.guardReason] = (acc[trade.guardReason] ?? 0) + 1;
      return acc;
    }, {});
    const row = {
      symbol,
      modelReady: true,
      modelStatus: model.status,
      config: model.config,
      base: roundMetrics(base),
      guarded: roundMetrics(guarded),
      deltaNetPct: Number((guarded.netReturnPct - base.netReturnPct).toFixed(3)),
      deltaWinRate: Number((guarded.winRate - base.winRate).toFixed(2)),
      deltaMaxDD: Number((guarded.maxDrawdownPct - base.maxDrawdownPct).toFixed(3)),
      guardCounts,
    };
    rows.push(row);
    console.log('R11_GUARD_BENCH', JSON.stringify(row));
  }

  const comparable = rows.filter((row) => row.modelReady && row.base?.trades > 0);
  const summary = {
    symbols: rows.length,
    comparable: comparable.length,
    improvedNet: comparable.filter((row) => row.deltaNetPct > 0).map((row) => row.symbol),
    worsenedNet: comparable.filter((row) => row.deltaNetPct < 0).map((row) => row.symbol),
    averageDeltaNetPct: comparable.length ? Number((comparable.reduce((s, row) => s + row.deltaNetPct, 0) / comparable.length).toFixed(3)) : 0,
    averageDeltaWinRate: comparable.length ? Number((comparable.reduce((s, row) => s + row.deltaWinRate, 0) / comparable.length).toFixed(2)) : 0,
    averageDeltaMaxDD: comparable.length ? Number((comparable.reduce((s, row) => s + row.deltaMaxDD, 0) / comparable.length).toFixed(3)) : 0,
  };
  console.log('R11_GUARD_BENCH_SUMMARY', JSON.stringify(summary));
}

function roundMetrics(value: ReturnType<typeof metrics>) {
  return {
    trades: value.trades,
    wins: value.wins,
    losses: value.losses,
    winRate: Number(value.winRate.toFixed(2)),
    netReturnPct: Number(value.netReturnPct.toFixed(3)),
    expectancyPct: Number(value.expectancyPct.toFixed(4)),
    profitFactor: Number(value.profitFactor.toFixed(2)),
    maxDrawdownPct: Number(value.maxDrawdownPct.toFixed(3)),
  };
}

main().catch((error) => {
  console.error('R11_GUARD_BENCH_ERROR', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
