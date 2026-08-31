import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Candle } from './analysis.js';
import { assessCryptoReversal } from './cryptoReversal.js';
import { calibrateR11, evaluateConfigExternalR11, type R11Trade } from './highWinrateR11.js';

const BASE = 'https://data.binance.vision/data/futures/um/daily/klines';
const DAY = 24 * 60 * 60_000;
const SYMBOLS = ['XRPUSDT', 'LINKUSDT', 'UNIUSDT', 'AAVEUSDT', 'ARBUSDT'];
const CALIBRATION_DAYS = 21;
const EXTERNAL_DAYS = 7;
const ROUND_TRIP_COST_PCT = 0.12;
const ENTRY_VETO_THRESHOLDS = [30, 40, 50, 60, 70, 80];

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
    const open = Number(cols[1]);
    const high = Number(cols[2]);
    const low = Number(cols[3]);
    const close = Number(cols[4]);
    const volume = Number(cols[5] ?? 0);
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

function assessmentAt(time: number, trade: R11Trade, m5: Candle[], m15: Candle[]) {
  const m5Window = m5.filter((row) => row.time <= time).slice(-100);
  const m15Window = m15.filter((row) => row.time <= time).slice(-220);
  if (m5Window.length < 60 || m15Window.length < 210) return null;
  return assessCryptoReversal(m5Window, m15Window, trade.direction > 0 ? 'BUY' : 'SELL');
}

function entryVetoMetrics(baseTrades: R11Trade[], m5: Candle[], m15: Candle[]) {
  const scored = baseTrades.map((trade) => ({
    trade,
    score: assessmentAt(trade.fillTime, trade, m5, m15)?.score ?? 0,
  }));
  return Object.fromEntries(ENTRY_VETO_THRESHOLDS.map((threshold) => {
    const kept = scored.filter((row) => row.score < threshold).map((row) => row.trade);
    const blocked = scored.filter((row) => row.score >= threshold);
    return [String(threshold), {
      kept: kept.length,
      blocked: blocked.length,
      blockedWins: blocked.filter((row) => netTradePct(row.trade) > 0).length,
      blockedLosses: blocked.filter((row) => netTradePct(row.trade) <= 0).length,
      metrics: roundMetrics(metrics(kept)),
    }];
  }));
}

function directionalPriceReturnPct(direction: 1|-1, entry: number, exit: number): number {
  const raw = (exit - entry) / entry * 100;
  return direction > 0 ? raw : -raw;
}

function netTradePct(trade: R11Trade): number {
  return directionalPriceReturnPct(trade.direction, trade.entry, trade.exit) - ROUND_TRIP_COST_PCT;
}

function metrics(trades: R11Trade[]) {
  let wins = 0;
  let losses = 0;
  let grossProfitPct = 0;
  let grossLossPct = 0;
  let netSumPct = 0;
  let equity = 100;
  let peak = 100;
  let maxDrawdownPct = 0;
  for (const trade of trades) {
    const netPct = netTradePct(trade);
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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'r11-reversal-veto-bench-'));
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
      console.log('R11_REVERSAL_VETO', JSON.stringify(row));
      continue;
    }

    const baseTrades = evaluateConfigExternalR11(m5, m15, model.config, externalStart, externalEnd).trades;
    const row = {
      symbol,
      modelReady: true,
      modelStatus: model.status,
      config: model.config,
      base: roundMetrics(metrics(baseTrades)),
      entryVeto: entryVetoMetrics(baseTrades, m5, m15),
    };
    rows.push(row);
    console.log('R11_REVERSAL_VETO', JSON.stringify(row));
  }

  const comparable = rows.filter((row) => row.modelReady && row.base?.trades > 0);
  const vetoSummary = Object.fromEntries(ENTRY_VETO_THRESHOLDS.map((threshold) => {
    let kept = 0;
    let blocked = 0;
    let blockedWins = 0;
    let blockedLosses = 0;
    let improvedSymbols = 0;
    let worsenedSymbols = 0;
    for (const row of comparable) {
      const v = row.entryVeto[String(threshold)];
      kept += v.kept;
      blocked += v.blocked;
      blockedWins += v.blockedWins;
      blockedLosses += v.blockedLosses;
      const delta = Number(v.metrics.netReturnPct) - Number(row.base.netReturnPct);
      if (delta > 0.0001) improvedSymbols++;
      else if (delta < -0.0001) worsenedSymbols++;
    }
    return [String(threshold), { kept, blocked, blockedWins, blockedLosses, improvedSymbols, worsenedSymbols }];
  }));
  console.log('R11_REVERSAL_VETO_SUMMARY', JSON.stringify({
    symbols: rows.length,
    comparable: comparable.length,
    vetoSummary,
  }));
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
  console.error('R11_REVERSAL_VETO_ERROR', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
