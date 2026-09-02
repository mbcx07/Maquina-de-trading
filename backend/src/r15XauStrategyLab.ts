import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Candle } from './analysis.js';

const DAY = 86_400_000;
const FIVE = 5 * 60_000;
const FIFTEEN = 15 * 60_000;
const VISION = 'https://data.binance.vision/data/futures/um/daily/klines';
const LOOKBACK_DAYS = 240;
const INITIAL = 50;
const LEVERAGE = 10;
const MARGIN_PCT = 1;
const FEE_PCT = 0.05;
const SPREAD_PCT = 0.025;
const SLIPPAGE_PCT = 0.01;
const SIDE_COST_PCT = SPREAD_PCT / 2 + SLIPPAGE_PCT + FEE_PCT;

type Side = 1 | -1;
type Family = 'TREND_PULLBACK' | 'DONCHIAN' | 'MEAN_REVERSION' | 'SWEEP_MSS' | 'ORB';
interface Params {
  family: Family;
  a: number;
  b: number;
  c: number;
  d: number;
  session: 'ALL' | 'LIQUID';
}
interface BarFeature extends Candle {
  atr: number;
  atrPct: number;
  ema9: number;
  ema20: number;
  ema50: number;
  ema200: number;
  rsi: number;
  volAvg20: number;
  bbMid: number;
  bbUpper: number;
  bbLower: number;
  htfEma20: number;
  htfEma50: number;
  htfEma200: number;
  htfAtr: number;
  htfSlope20: number;
}
interface Metrics {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  profitFactor: number;
  returnPct: number;
  maxDdPct: number;
  finalBalance: number;
  expectancy: number;
  avgBars: number;
}
interface ResultRow { params: Params; train: Metrics; validation: Metrics; test?: Metrics; trainScore: number; }

async function main() {
  const endDay = Math.floor((Date.now() - DAY) / DAY) * DAY;
  const endTime = endDay + DAY - 1;
  const startTime = endTime - LOOKBACK_DAYS * DAY;
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'r15-xau-lab-'));
  const m1 = await fetchVision('XAUUSDT', startTime, endTime, tmp);
  if (m1.length < 60 * 1440) throw new Error(`XAU_HISTORY_TOO_SHORT:${m1.length}`);

  const m5 = aggregate(m1, FIVE);
  const m15 = aggregate(m1, FIFTEEN);
  const features = buildFeatures(m5, m15);
  const first = features[0].time;
  const last = features.at(-1)!.time;
  const span = last - first;
  const split1 = first + span * 0.50;
  const split2 = first + span * 0.75;
  const i1 = features.findIndex((b) => b.time >= split1);
  const i2 = features.findIndex((b) => b.time >= split2);
  const trainStart = Math.min(features.length - 1, 220);
  const end = features.length - 2;

  const params = buildGrid();
  const trained: ResultRow[] = [];
  for (const p of params) {
    const train = simulate(features, trainStart, i1 - 1, p);
    if (train.trades < 15 || train.returnPct <= 0 || train.profitFactor < 1.03 || train.maxDdPct > 20) continue;
    const trainScore = train.returnPct - train.maxDdPct * 0.8 + Math.min(train.profitFactor, 2) * 3 + Math.min(train.trades, 200) * 0.005;
    const validation = simulate(features, i1, i2 - 1, p);
    trained.push({ params: p, train, validation, trainScore });
  }
  trained.sort((x, y) => y.trainScore - x.trainScore);

  const validated = trained
    .filter((r) => r.validation.trades >= 6 && r.validation.returnPct >= 0 && r.validation.profitFactor >= 1.0 && r.validation.maxDdPct <= 15)
    .slice(0, 40)
    .map((r) => ({ ...r, test: simulate(features, i2, end, r.params) }));

  const survivors = validated
    .filter((r) => r.test && r.test.trades >= 6 && r.test.returnPct > 0 && r.test.profitFactor >= 1.05 && r.test.maxDdPct <= 15)
    .sort((x, y) => survivalScore(y) - survivalScore(x));

  console.log('R15_LAB_META', JSON.stringify({
    m1: m1.length,
    m5: m5.length,
    from: new Date(first).toISOString(),
    to: new Date(last).toISOString(),
    days: Number((span / DAY).toFixed(2)),
    train: [new Date(first).toISOString(), new Date(split1).toISOString()],
    validation: [new Date(split1).toISOString(), new Date(split2).toISOString()],
    test: [new Date(split2).toISOString(), new Date(last).toISOString()],
    cost: { feePct: FEE_PCT, spreadPct: SPREAD_PCT, slippagePct: SLIPPAGE_PCT, leverage: LEVERAGE, marginPct: MARGIN_PCT },
    grid: params.length,
    positiveTrain: trained.length,
    validationPass: validated.length,
    survivors: survivors.length,
  }));

  for (const [idx, row] of trained.slice(0, 12).entries()) {
    console.log('R15_LAB_TRAIN_TOP', JSON.stringify({ rank: idx + 1, params: row.params, train: compact(row.train), validation: compact(row.validation) }));
  }
  for (const [idx, row] of survivors.slice(0, 12).entries()) {
    console.log('R15_LAB_SURVIVOR', JSON.stringify({ rank: idx + 1, params: row.params, train: compact(row.train), validation: compact(row.validation), test: compact(row.test!) }));
  }
  if (!survivors.length) console.log('R15_LAB_NO_SURVIVOR');
}

function buildGrid(): Params[] {
  const out: Params[] = [];
  for (const session of ['ALL', 'LIQUID'] as const) {
    for (const stopAtr of [1.0, 1.5, 2.0]) for (const rr of [1.5, 2.0, 2.5, 3.0]) for (const pullAtr of [0.15, 0.30, 0.50]) {
      out.push({ family: 'TREND_PULLBACK', a: stopAtr, b: rr, c: pullAtr, d: 24, session });
    }
    for (const lookback of [12, 24, 36, 60]) for (const stopAtr of [1.0, 1.5, 2.0]) for (const rr of [1.5, 2.0, 3.0]) for (const volMult of [0.8, 1.0, 1.2]) {
      out.push({ family: 'DONCHIAN', a: lookback, b: stopAtr, c: rr, d: volMult, session });
    }
    for (const bb of [1.5, 2.0, 2.5]) for (const rsiEdge of [25, 30, 35]) for (const stopAtr of [1.0, 1.5, 2.0]) for (const flatSep of [0.25, 0.5, 0.8]) {
      out.push({ family: 'MEAN_REVERSION', a: bb, b: rsiEdge, c: stopAtr, d: flatSep, session });
    }
    for (const sweep of [12, 20, 30]) for (const stopAtr of [0.8, 1.2, 1.6]) for (const rr of [1.2, 1.8, 2.4]) for (const bodyAtr of [0.25, 0.4, 0.6]) {
      out.push({ family: 'SWEEP_MSS', a: sweep, b: stopAtr, c: rr, d: bodyAtr, session });
    }
    for (const rangeBars of [3, 6, 9]) for (const stopAtr of [1.0, 1.5, 2.0]) for (const rr of [1.5, 2.0, 3.0]) for (const bufferAtr of [0, 0.1, 0.2]) {
      out.push({ family: 'ORB', a: rangeBars, b: stopAtr, c: rr, d: bufferAtr, session });
    }
  }
  return out;
}

function simulate(f: BarFeature[], start: number, end: number, p: Params): Metrics {
  let balance = INITIAL, peak = INITIAL, maxDd = 0, wins = 0, losses = 0, gp = 0, gl = 0, trades = 0, barsHeld = 0;
  let i = Math.max(start, 220);
  while (i < end - 2 && balance > 1) {
    const s = signalAt(f, i, p);
    if (!s) { i++; continue; }
    if (p.session === 'LIQUID' && !isLiquid(f[i].time)) { i++; continue; }
    const entryIndex = i + 1;
    const entryBar = f[entryIndex];
    const entry = entryBar.open * (1 + s.side * (SPREAD_PCT / 2 + SLIPPAGE_PCT) / 100);
    const stopDistance = Math.max(entry * 0.0006, s.stopDistance);
    const tpDistance = Math.max(entry * (2 * SIDE_COST_PCT) / 100 * 1.15, stopDistance * s.rr);
    const sl = entry - s.side * stopDistance;
    const tp = entry + s.side * tpDistance;
    const margin = balance * MARGIN_PCT / 100;
    const notional = margin * LEVERAGE;
    const qty = notional / entry;
    const entryFee = notional * FEE_PCT / 100;
    let exitIndex = Math.min(end, entryIndex + s.maxHoldBars);
    let exit = f[exitIndex].close;
    for (let j = entryIndex; j <= exitIndex; j++) {
      const b = f[j];
      const hitSl = s.side === 1 ? b.low <= sl : b.high >= sl;
      const hitTp = s.side === 1 ? b.high >= tp : b.low <= tp;
      if (hitSl) { exit = sl; exitIndex = j; break; }
      if (hitTp) { exit = tp; exitIndex = j; break; }
    }
    exit *= 1 - s.side * (SPREAD_PCT / 2 + SLIPPAGE_PCT) / 100;
    const gross = s.side === 1 ? (exit - entry) * qty : (entry - exit) * qty;
    const exitFee = qty * exit * FEE_PCT / 100;
    const pnl = gross - entryFee - exitFee;
    balance += pnl;
    trades++;
    barsHeld += Math.max(1, exitIndex - entryIndex + 1);
    if (pnl > 0) { wins++; gp += pnl; } else { losses++; gl += Math.abs(pnl); }
    peak = Math.max(peak, balance);
    maxDd = Math.max(maxDd, peak > 0 ? (peak - balance) / peak * 100 : 100);
    i = Math.max(i + 1, exitIndex + 1);
  }
  return {
    trades, wins, losses,
    winRate: trades ? wins / trades * 100 : 0,
    profitFactor: gl > 0 ? gp / gl : gp > 0 ? 99 : 0,
    returnPct: (balance - INITIAL) / INITIAL * 100,
    maxDdPct: maxDd,
    finalBalance: balance,
    expectancy: trades ? (balance - INITIAL) / trades : 0,
    avgBars: trades ? barsHeld / trades : 0,
  };
}

function signalAt(f: BarFeature[], i: number, p: Params): { side: Side; stopDistance: number; rr: number; maxHoldBars: number } | null {
  const b = f[i];
  if (!(b.atr > 0) || b.atrPct < 0.015) return null;
  switch (p.family) {
    case 'TREND_PULLBACK': {
      const trendLong = b.htfEma20 > b.htfEma50 && b.htfEma50 > b.htfEma200 && b.htfSlope20 > 0;
      const trendShort = b.htfEma20 < b.htfEma50 && b.htfEma50 < b.htfEma200 && b.htfSlope20 < 0;
      const prev = f[i - 1];
      const long = trendLong && b.ema20 > b.ema50 && prev.low <= b.ema20 + b.atr * p.c && b.close > b.ema20 && b.close > b.open && b.rsi >= 48 && b.rsi <= 72;
      const short = trendShort && b.ema20 < b.ema50 && prev.high >= b.ema20 - b.atr * p.c && b.close < b.ema20 && b.close < b.open && b.rsi <= 52 && b.rsi >= 28;
      if (!long && !short) return null;
      return { side: long ? 1 : -1, stopDistance: b.atr * p.a, rr: p.b, maxHoldBars: Math.floor(p.d) };
    }
    case 'DONCHIAN': {
      const n = Math.floor(p.a);
      const prior = f.slice(i - n, i);
      if (prior.length < n) return null;
      const hi = Math.max(...prior.map((x) => x.high));
      const lo = Math.min(...prior.map((x) => x.low));
      const trendLong = b.htfEma20 > b.htfEma50 && b.htfSlope20 >= 0;
      const trendShort = b.htfEma20 < b.htfEma50 && b.htfSlope20 <= 0;
      const volOk = b.volAvg20 <= 0 || b.volume >= b.volAvg20 * p.d;
      const long = trendLong && volOk && b.close > hi && b.close > b.open;
      const short = trendShort && volOk && b.close < lo && b.close < b.open;
      if (!long && !short) return null;
      return { side: long ? 1 : -1, stopDistance: b.atr * p.b, rr: p.c, maxHoldBars: 36 };
    }
    case 'MEAN_REVERSION': {
      const sep = b.htfAtr > 0 ? Math.abs(b.htfEma20 - b.htfEma50) / b.htfAtr : 99;
      if (sep > p.d || Math.abs(b.htfSlope20) > b.htfAtr * 0.08) return null;
      const long = b.close < b.bbLower && b.rsi <= p.b;
      const short = b.close > b.bbUpper && b.rsi >= 100 - p.b;
      if (!long && !short) return null;
      const targetDistance = Math.abs(b.bbMid - b.close);
      const stop = b.atr * p.c;
      if (targetDistance <= stop * 0.8) return null;
      return { side: long ? 1 : -1, stopDistance: stop, rr: Math.max(1, targetDistance / stop), maxHoldBars: 18 };
    }
    case 'SWEEP_MSS': {
      const n = Math.floor(p.a);
      const prior = f.slice(i - n, i - 1);
      if (prior.length < n - 1) return null;
      const prev = f[i - 1];
      const oldLow = Math.min(...prior.map((x) => x.low));
      const oldHigh = Math.max(...prior.map((x) => x.high));
      const bodyAtr = Math.abs(b.close - b.open) / b.atr;
      const longBias = b.htfEma20 > b.htfEma50 && b.htfSlope20 >= 0;
      const shortBias = b.htfEma20 < b.htfEma50 && b.htfSlope20 <= 0;
      const long = longBias && prev.low < oldLow && prev.close >= oldLow && b.close > prev.high && b.close > b.open && bodyAtr >= p.d;
      const short = shortBias && prev.high > oldHigh && prev.close <= oldHigh && b.close < prev.low && b.close < b.open && bodyAtr >= p.d;
      if (!long && !short) return null;
      return { side: long ? 1 : -1, stopDistance: b.atr * p.b, rr: p.c, maxHoldBars: 24 };
    }
    case 'ORB': {
      const d = new Date(b.time);
      const hour = d.getUTCHours();
      const minute = d.getUTCMinutes();
      const sessionStart = hour === 7 ? 7 : hour === 13 ? 13 : -1;
      if (sessionStart < 0) return null;
      const minutesFrom = (hour - sessionStart) * 60 + minute;
      const rangeBars = Math.floor(p.a);
      if (minutesFrom < rangeBars * 5 || minutesFrom > rangeBars * 5 + 90) return null;
      const startTime = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), sessionStart, 0, 0, 0);
      const range = f.filter((x, idx) => idx <= i && x.time >= startTime && x.time < startTime + rangeBars * FIVE);
      if (range.length < rangeBars) return null;
      const hi = Math.max(...range.map((x) => x.high));
      const lo = Math.min(...range.map((x) => x.low));
      const long = b.close > hi + b.atr * p.d && b.close > b.open;
      const short = b.close < lo - b.atr * p.d && b.close < b.open;
      if (!long && !short) return null;
      return { side: long ? 1 : -1, stopDistance: b.atr * p.b, rr: p.c, maxHoldBars: 24 };
    }
  }
}

function buildFeatures(m5: Candle[], m15: Candle[]): BarFeature[] {
  const c = m5.map((x) => x.close);
  const e9 = emaSeries(c, 9), e20 = emaSeries(c, 20), e50 = emaSeries(c, 50), e200 = emaSeries(c, 200);
  const atr5 = atrSeries(m5, 14), r = rsiSeries(c, 14);
  const h = m15.map((x) => x.close);
  const h20 = emaSeries(h, 20), h50 = emaSeries(h, 50), h200 = emaSeries(h, 200), hAtr = atrSeries(m15, 14);
  const out: BarFeature[] = [];
  let hi = 0;
  for (let i = 0; i < m5.length; i++) {
    const closeTime = m5[i].time + FIVE;
    while (hi + 1 < m15.length && m15[hi + 1].time + FIFTEEN <= closeTime) hi++;
    const vols = m5.slice(Math.max(0, i - 19), i + 1).map((x) => x.volume);
    const volAvg20 = mean(vols);
    const window = c.slice(Math.max(0, i - 19), i + 1);
    const bbMid = mean(window);
    const sd = stdev(window, bbMid);
    const width = 2;
    out.push({
      ...m5[i], atr: atr5[i], atrPct: m5[i].close > 0 ? atr5[i] / m5[i].close * 100 : 0,
      ema9: e9[i], ema20: e20[i], ema50: e50[i], ema200: e200[i], rsi: r[i], volAvg20,
      bbMid, bbUpper: bbMid + sd * width, bbLower: bbMid - sd * width,
      htfEma20: h20[hi] ?? 0, htfEma50: h50[hi] ?? 0, htfEma200: h200[hi] ?? 0, htfAtr: hAtr[hi] ?? 0,
      htfSlope20: hi >= 2 ? (h20[hi] ?? 0) - (h20[hi - 2] ?? 0) : 0,
    });
  }
  return out;
}

function compact(m: Metrics) {
  return {
    trades: m.trades,
    winRate: Number(m.winRate.toFixed(2)),
    pf: Number(m.profitFactor.toFixed(3)),
    returnPct: Number(m.returnPct.toFixed(3)),
    maxDdPct: Number(m.maxDdPct.toFixed(3)),
    finalBalance: Number(m.finalBalance.toFixed(4)),
    expectancy: Number(m.expectancy.toFixed(5)),
    avgBars: Number(m.avgBars.toFixed(2)),
  };
}
function survivalScore(r: ResultRow): number {
  const t = r.test!;
  return t.returnPct - t.maxDdPct * 0.7 + Math.min(t.profitFactor, 3) * 3 + Math.min(t.trades, 100) * 0.01;
}
function isLiquid(time: number): boolean { const h = new Date(time).getUTCHours(); return h >= 6 && h < 21; }
function aggregate(rows: Candle[], bucketMs: number): Candle[] {
  const map = new Map<number, Candle>();
  for (const x of rows) {
    const t = Math.floor(x.time / bucketMs) * bucketMs;
    const b = map.get(t);
    if (!b) map.set(t, { ...x, time: t });
    else { b.high = Math.max(b.high, x.high); b.low = Math.min(b.low, x.low); b.close = x.close; b.volume += x.volume; }
  }
  return [...map.values()].sort((a, b) => a.time - b.time);
}
function emaSeries(values: number[], p: number): number[] { const out = new Array(values.length).fill(0); if (!values.length) return out; const k = 2 / (p + 1); out[0] = values[0]; for (let i = 1; i < values.length; i++) out[i] = values[i] * k + out[i - 1] * (1 - k); return out; }
function atrSeries(rows: Candle[], p: number): number[] { const out = new Array(rows.length).fill(0); if (!rows.length) return out; out[0] = rows[0].high - rows[0].low; for (let i = 1; i < rows.length; i++) { const tr = Math.max(rows[i].high - rows[i].low, Math.abs(rows[i].high - rows[i - 1].close), Math.abs(rows[i].low - rows[i - 1].close)); out[i] = i < p ? (out[i - 1] * i + tr) / (i + 1) : (out[i - 1] * (p - 1) + tr) / p; } return out; }
function rsiSeries(values: number[], p: number): number[] { const out = new Array(values.length).fill(50); let g = 0, l = 0; for (let i = 1; i < values.length; i++) { const d = values[i] - values[i - 1]; if (i <= p) { if (d >= 0) g += d; else l -= d; if (i === p) { g /= p; l /= p; } } else { g = (g * (p - 1) + Math.max(d, 0)) / p; l = (l * (p - 1) + Math.max(-d, 0)) / p; } if (i >= p) out[i] = l <= 1e-12 ? (g > 0 ? 100 : 50) : 100 - 100 / (1 + g / l); } return out; }
function mean(v: number[]): number { return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; }
function stdev(v: number[], m = mean(v)): number { return v.length ? Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length) : 0; }

async function fetchVision(symbol: string, startTime: number, endTime: number, dir: string): Promise<Candle[]> {
  const output: Candle[] = [];
  const startDay = Math.floor(startTime / DAY) * DAY;
  const endDay = Math.floor(endTime / DAY) * DAY;
  for (let cursor = startDay; cursor <= endDay; cursor += DAY) {
    const day = new Date(cursor).toISOString().slice(0, 10);
    const fn = `${symbol}-1m-${day}.zip`;
    const response = await fetch(`${VISION}/${symbol}/1m/${fn}`);
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(`VISION_${response.status}:${fn}`);
    const file = path.join(dir, fn);
    await writeFile(file, Buffer.from(await response.arrayBuffer()));
    const csv = execFileSync('unzip', ['-p', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    for (const line of csv.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const a = line.split(',');
      const raw = Number(a[0]);
      if (!Number.isFinite(raw)) continue;
      const time = normalizeEpoch(raw);
      const row: Candle = { time, open: Number(a[1]), high: Number(a[2]), low: Number(a[3]), close: Number(a[4]), volume: Number(a[5] ?? 0) };
      if ([row.time, row.open, row.high, row.low, row.close].every(Number.isFinite) && row.time >= startTime && row.time <= endTime) output.push(row);
    }
  }
  const map = new Map<number, Candle>();
  for (const row of output) map.set(row.time, row);
  return [...map.values()].sort((a, b) => a.time - b.time);
}
function normalizeEpoch(v: number): number { if (v > 1e17) return Math.floor(v / 1_000_000); if (v > 1e14) return Math.floor(v / 1000); return v; }

main().catch((error) => { console.error('R15_LAB_ERROR', error instanceof Error ? error.message : String(error)); process.exit(1); });
