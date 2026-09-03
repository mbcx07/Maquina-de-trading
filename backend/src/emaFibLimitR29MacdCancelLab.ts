import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import readline from "node:readline";
import { mkdir, writeFile } from "node:fs/promises";

type Side = "BUY" | "SELL";
type Bar = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  buyVolume: number;
  sellVolume: number;
};
type Cfg = {
  holdMin: number;
  minVotes: number;
  minFamilies: number;
  lead: number;
  mom16Threshold: number;
};
type Stats = {
  trades: number;
  winRate: number;
  pf: number;
  returnPct: number;
  ddPct: number;
  tradesPerDay: number;
  final50: number;
};
type Snap = {
  buy: number;
  sell: number;
  buyFamilies: number;
  sellFamilies: number;
  atr: number;
  mom16: number;
};
type ConsensusCfg = { minVotes: number; minFamilies: number; lead: number };
type Candidate = { i: number; side: Side };
type R23Cfg = ConsensusCfg & {
  mom16Threshold: number;
  holdMin: number;
  targetPct: number;
  stopPct: number;
  reverse: boolean;
};

const SYMBOL = "XAUUSDT",
  DAY = 86400000,
  DAYS = Number(process.env.R29_DAYS || 56),
  COST = 0.145,
  EXPOSURE = 0.1,
  ENTRY_MIN = 0.5,
  ENTRY_MS = ENTRY_MIN * 60000,
  BARS_16H = (16 * 60) / ENTRY_MIN;
const BASE = `https://data.binance.vision/data/futures/um/daily/aggTrades/${SYMBOL}`;
const DOWNLOAD_CONCURRENCY = Math.max(
  1,
  Math.min(12, Number(process.env.R29_CONCURRENCY || 6)),
);

function norm(v: number) {
  if (v > 1e17) return Math.floor(v / 1e6);
  if (v > 1e14) return Math.floor(v / 1e3);
  return v;
}
async function fetchDayOnce(d: string, attempt: number): Promise<Bar[]> {
  const fn = `${SYMBOL}-aggTrades-${d}.zip`,
    r = await fetch(`${BASE}/${fn}?r29_retry=${attempt}`);
  if (r.status === 404) return [];
  if (!r.ok || !r.body) throw new Error(`VISION_${r.status}:${d}`);
  const unzip = spawn("funzip", [], { stdio: ["pipe", "pipe", "inherit"] }),
    closed = new Promise<number | null>((resolve, reject) => {
      unzip.once("error", reject);
      unzip.once("close", resolve);
    });
  // funzip can reject a truncated CDN response before fetch finishes piping it.
  // Consume EPIPE here; the non-zero close code below turns it into a retry.
  unzip.stdin.on("error", () => {});
  Readable.fromWeb(r.body as never).pipe(unzip.stdin);
  const lines = readline.createInterface({
    input: unzip.stdout,
    crlfDelay: Infinity,
  });
  const m = new Map<number, Bar>();
  for await (const line of lines) {
    if (!line) continue;
    const c = line.split(","),
      p = Number(c[1]),
      q = Number(c[2]),
      t = norm(Number(c[5]));
    if (!Number.isFinite(p) || !Number.isFinite(q) || !Number.isFinite(t))
      continue;
    const k = Math.floor(t / ENTRY_MS) * ENTRY_MS;
    let b = m.get(k);
    if (!b) {
      b = {
        time: k,
        open: p,
        high: p,
        low: p,
        close: p,
        volume: 0,
        buyVolume: 0,
        sellVolume: 0,
      };
      m.set(k, b);
    }
    b.high = Math.max(b.high, p);
    b.low = Math.min(b.low, p);
    b.close = p;
    b.volume += q;
    if (String(c[6]).trim().toLowerCase() === "true") b.sellVolume += q;
    else b.buyVolume += q;
  }
  const code = await closed;
  if (code !== 0) throw new Error(`UNZIP_${code}:${d}`);
  return [...m.values()].sort((a, b) => a.time - b.time);
}
async function fetchDay(d: string): Promise<Bar[]> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await fetchDayOnce(d, attempt);
    } catch (error) {
      lastError = error;
      console.warn("DAY_RETRY", d, attempt, String(error));
    }
  }
  throw lastError;
}
async function mapLimit<T, R>(
  xs: T[],
  limit: number,
  fn: (x: T, i: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(xs.length);
  let cursor = 0;
  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= xs.length) return;
      out[i] = await fn(xs[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, xs.length) }, worker));
  return out;
}
function buildSnapshots(b: Bar[]): Snap[] {
  const n = b.length,
    out = new Array<Snap>(n),
    sumC = new Float64Array(n + 1),
    sumC2 = new Float64Array(n + 1),
    sumV = new Float64Array(n + 1),
    sumBV = new Float64Array(n + 1),
    sumSV = new Float64Array(n + 1),
    sumPV = new Float64Array(n + 1),
    sumTR = new Float64Array(n + 1);
  const periods = [
      ...new Set([
        ...Array.from({ length: 10 }, (_, i) => 3 + i),
        ...Array.from({ length: 10 }, (_, i) => 10 + i * 2),
        20,
        50,
      ]),
    ],
    es = new Map<number, number>();
  const rangeSum = (a: Float64Array, l: number, r: number) => a[r + 1] - a[l];
  for (let i = 0; i < n; i++) {
    const x = b[i],
      c = x.close,
      v = Math.max(x.volume, 1e-9),
      tr = i
        ? Math.max(
            x.high - x.low,
            Math.abs(x.high - b[i - 1].close),
            Math.abs(x.low - b[i - 1].close),
          )
        : x.high - x.low;
    sumC[i + 1] = sumC[i] + c;
    sumC2[i + 1] = sumC2[i] + c * c;
    sumV[i + 1] = sumV[i] + x.volume;
    sumBV[i + 1] = sumBV[i] + x.buyVolume;
    sumSV[i + 1] = sumSV[i] + x.sellVolume;
    sumPV[i + 1] = sumPV[i] + c * v;
    sumTR[i + 1] = sumTR[i] + tr;
    for (const p of periods) {
      const prev = es.get(p) ?? c;
      es.set(p, c * (2 / (p + 1)) + prev * (1 - 2 / (p + 1)));
    }
    if (i < 200) {
      out[i] = {
        buy: 0,
        sell: 0,
        buyFamilies: 0,
        sellFamilies: 0,
        atr: 0,
        mom16: 0,
      };
      continue;
    }
    let buy = 0,
      sell = 0,
      bf = 0,
      sf = 0;
    const add = (bit: number, side: Side | null) => {
      if (side === "BUY") {
        buy++;
        bf |= bit;
      } else if (side === "SELL") {
        sell++;
        sf |= bit;
      }
    };
    for (let z = 0; z < 10; z++) {
      const ef = es.get(3 + z)!,
        slow = es.get(10 + z * 2)!;
      add(1 << 0, ef > slow ? "BUY" : ef < slow ? "SELL" : null);
    }
    for (let z = 0; z < 10; z++) {
      const p = 2 + z,
        roc = (c / b[i - p].close - 1) * 100,
        t = 0.008 + z * 0.004;
      add(1 << 1, roc > t ? "BUY" : roc < -t ? "SELL" : null);
    }
    for (let z = 0; z < 10; z++) {
      const q = 4 + z;
      let h = -Infinity,
        l = Infinity;
      for (let j = i - q; j < i; j++) {
        h = Math.max(h, b[j].high);
        l = Math.min(l, b[j].low);
      }
      add(1 << 2, c > h ? "BUY" : c < l ? "SELL" : null);
    }
    for (let z = 0; z < 10; z++) {
      const p = 6 + z;
      let g = 0,
        l = 0;
      for (let j = i - p + 1; j <= i; j++) {
        const d = b[j].close - b[j - 1].close;
        if (d > 0) g += d;
        else l -= d;
      }
      const rv = l ? 100 - 100 / (1 + g / l) : 100,
        u = 53 + z * 0.8,
        dn = 47 - z * 0.8;
      add(1 << 3, rv >= u ? "BUY" : rv <= dn ? "SELL" : null);
    }
    for (let z = 0; z < 10; z++) {
      const q = 10 + z,
        l = i - q + 1,
        s = rangeSum(sumC, l, i),
        s2 = rangeSum(sumC2, l, i),
        m = s / q,
        dev = Math.sqrt(Math.max(0, s2 / q - m * m)),
        zz = dev ? (c - m) / dev : 0,
        t = 0.55 + z * 0.1;
      add(1 << 4, zz >= t ? "BUY" : zz <= -t ? "SELL" : null);
    }
    for (let z = 0; z < 10; z++) {
      const q = 2 + z,
        l = i - q + 1,
        bv = rangeSum(sumBV, l, i),
        sv = rangeSum(sumSV, l, i),
        tot = bv + sv,
        f = tot ? (bv - sv) / tot : 0,
        t = 0.05 + z * 0.016;
      add(1 << 5, f >= t ? "BUY" : f <= -t ? "SELL" : null);
    }
    for (let z = 0; z < 10; z++) {
      const q = 5 + z,
        av = rangeSum(sumV, i - q, i - 1) / q,
        r = av ? x.volume / av : 0,
        t = 1.05 + z * 0.1;
      add(
        1 << 6,
        r >= t ? (c > x.open ? "BUY" : c < x.open ? "SELL" : null) : null,
      );
    }
    const candleRange = Math.max(1e-9, x.high - x.low),
      body = Math.abs(c - x.open) / candleRange;
    for (let z = 0; z < 10; z++) {
      const t = 0.35 + z * 0.04;
      add(
        1 << 7,
        body >= t && c > b[i - 1].close
          ? "BUY"
          : body >= t && c < b[i - 1].close
            ? "SELL"
            : null,
      );
    }
    const atr14 = rangeSum(sumTR, i - 13, i) / 14,
      e20 = es.get(20)!,
      e50 = es.get(50)!;
    for (let z = 0; z < 10; z++) {
      const tol = atr14 * (0.15 + z * 0.03);
      add(
        1 << 8,
        Math.abs(c - e20) <= tol
          ? e20 > e50
            ? "BUY"
            : e20 < e50
              ? "SELL"
              : null
          : null,
      );
    }
    for (let z = 0; z < 10; z++) {
      const q = 10 + z * 2,
        l = i - q + 1,
        den = rangeSum(sumV, l, i),
        vw = den ? rangeSum(sumPV, l, i) / den : c,
        pc = (c / vw - 1) * 100,
        t = 0.006 + z * 0.003;
      add(1 << 9, pc >= t ? "BUY" : pc <= -t ? "SELL" : null);
    }
    const j = i - BARS_16H,
      mom16 = j >= 0 && b[j].close ? (c / b[j].close - 1) * 100 : 0;
    out[i] = {
      buy,
      sell,
      buyFamilies: popcount(bf),
      sellFamilies: popcount(sf),
      atr: atr14,
      mom16,
    };
    if (i % 20000 === 0) console.log("SNAP", i, "/", n);
  }
  return out;
}
function popcount(x: number) {
  let n = 0;
  while (x) {
    x &= x - 1;
    n++;
  }
  return n;
}

function consensusCandidates(
  snaps: Snap[],
  c: ConsensusCfg,
  start: number,
  end: number,
  useTsmom: boolean,
  momThreshold: number,
): Candidate[] {
  const out: Candidate[] = [];
  for (let i = Math.max(start, 2000); i < end; i++) {
    const s = snaps[i];
    let side: Side | null = null,
      cand = 0,
      opp = 0,
      fams = 0;
    if (useTsmom) {
      if (s.mom16 >= momThreshold) {
        side = "BUY";
        cand = s.buy;
        opp = s.sell;
        fams = s.buyFamilies;
      } else if (s.mom16 <= -momThreshold) {
        side = "SELL";
        cand = s.sell;
        opp = s.buy;
        fams = s.sellFamilies;
      } else continue;
    } else {
      if (s.buy > s.sell) {
        side = "BUY";
        cand = s.buy;
        opp = s.sell;
        fams = s.buyFamilies;
      } else if (s.sell > s.buy) {
        side = "SELL";
        cand = s.sell;
        opp = s.buy;
        fams = s.sellFamilies;
      } else continue;
    }
    if (cand >= c.minVotes && fams >= c.minFamilies && cand >= opp * c.lead)
      out.push({ i, side });
  }
  return out;
}

function simulate(
  b30: Bar[],
  snaps: Snap[],
  cands: Candidate[],
  holdMin: number,
  start: number,
  end: number,
): Stats {
  let eq = 100,
    pk = 100,
    dd = 0,
    gp = 0,
    gl = 0,
    n = 0,
    w = 0,
    next = start;
  const holdBars = Math.max(1, Math.round(holdMin / ENTRY_MIN));
  for (const z of cands) {
    const i = z.i;
    if (i < start || i >= end - holdBars - 2 || i < next) continue;
    const side = z.side,
      entry = b30[i + 1].open,
      a = snaps[i].atr;
    if (!(a > 0)) continue;
    const target = Math.max(COST * 2.8, (a / entry) * 100 * 8),
      stop = Math.max(COST * 1.25, target * 0.55),
      tp =
        side === "BUY"
          ? entry * (1 + target / 100)
          : entry * (1 - target / 100),
      sl = side === "BUY" ? entry * (1 - stop / 100) : entry * (1 + stop / 100);
    let exit = b30[i + holdBars].close,
      xi = i + holdBars;
    for (let j = i + 1; j <= i + holdBars; j++) {
      const y = b30[j],
        hs = side === "BUY" ? y.low <= sl : y.high >= sl,
        ht = side === "BUY" ? y.high >= tp : y.low <= tp;
      if (hs) {
        exit = sl;
        xi = j;
        break;
      }
      if (ht) {
        exit = tp;
        xi = j;
        break;
      }
    }
    const gross = (side === "BUY" ? exit / entry - 1 : entry / exit - 1) * 100,
      net = gross - COST,
      ar = net * EXPOSURE;
    eq *= 1 + ar / 100;
    pk = Math.max(pk, eq);
    dd = Math.max(dd, ((pk - eq) / pk) * 100);
    n++;
    if (ar > 0) {
      w++;
      gp += ar;
    } else gl += Math.abs(ar);
    next = xi + 2;
  }
  const days = Math.max(
    1,
    (b30[Math.min(end - 1, b30.length - 1)].time -
      b30[Math.max(start, 0)].time) /
      DAY,
  );
  return {
    trades: n,
    winRate: n ? (w / n) * 100 : 0,
    pf: gl ? gp / gl : gp ? 99 : 0,
    returnPct: eq - 100,
    ddPct: dd,
    tradesPerDay: n / days,
    final50: eq / 2,
  };
}
function score(s: Stats) {
  if (s.trades < 12) return -999;
  return (
    s.returnPct -
    s.ddPct * 0.35 +
    (s.pf - 1) * 2 +
    Math.min(2, s.tradesPerDay * 0.035)
  );
}

async function main() {
  const end = Math.floor((Date.now() - 2 * DAY) / DAY) * DAY,
    start = end - DAYS * DAY,
    dates: string[] = [];
  for (let t = start; t < end; t += DAY)
    dates.push(new Date(t).toISOString().slice(0, 10));
  const daily = await mapLimit(dates, DOWNLOAD_CONCURRENCY, async (d) => {
      const bars = await fetchDay(d);
      console.log("DAY", d, bars.length);
      return bars;
    }),
    b30 = daily.flat().sort((a, b) => a.time - b.time),
    N = b30.length;
  if (N < 2500) throw new Error(`INSUFFICIENT_BARS:${N}`);
  const t1 = Math.floor(N * 0.5),
    t2 = Math.floor(N * 0.75);
  console.log("PRECOMPUTE_START", N);
  const snaps = buildSnapshots(b30);
  console.log("PRECOMPUTE_DONE");
  const consensusCfgs: ConsensusCfg[] = [];
  for (const minVotes of [5, 10, 15, 20, 25])
    for (const minFamilies of [2, 3, 4, 5])
      for (const lead of [1.0, 1.1, 1.2, 1.35])
        consensusCfgs.push({ minVotes, minFamilies, lead });
  const holds = [15, 30, 60, 120],
    moms = [0.3, 0.5, 0.6, 0.8, 1.0, 1.2];
  let rows: Array<{ c: Cfg; tr: Stats; va: Stats; s: number }> = [];
  for (const cc of consensusCfgs) {
    for (const mt of moms) {
      const allT = consensusCandidates(snaps, cc, 0, N, true, mt);
      for (const holdMin of holds) {
        const c: Cfg = { ...cc, holdMin, mom16Threshold: mt },
          tr = simulate(b30, snaps, allT, holdMin, 0, t1),
          va = simulate(b30, snaps, allT, holdMin, t1, t2);
        rows.push({ c, tr, va, s: score(tr) + score(va) * 1.5 });
      }
    }
  }
  rows.sort((a, b) => b.s - a.s);
  console.log("R23_TOP10", JSON.stringify(rows.slice(0, 10)));
  const best = rows[0],
    bestCC = {
      minVotes: best.c.minVotes,
      minFamilies: best.c.minFamilies,
      lead: best.c.lead,
    },
    bestT = consensusCandidates(
      snaps,
      bestCC,
      0,
      N,
      true,
      best.c.mom16Threshold,
    ),
    test = simulate(b30, snaps, bestT, best.c.holdMin, t2, N),
    pureC = consensusCandidates(snaps, bestCC, 0, N, false, 0),
    pureTrain = simulate(b30, snaps, pureC, best.c.holdMin, 0, t1),
    pureVal = simulate(b30, snaps, pureC, best.c.holdMin, t1, t2),
    pureTest = simulate(b30, snaps, pureC, best.c.holdMin, t2, N);
  console.log(
    "R23_RESULT",
    JSON.stringify({
      symbol: SYMBOL,
      days: DAYS,
      bars: N,
      entryTimeframe: "30s",
      costPct: COST,
      risk: { initial: 50, marginPct: 1, leverage: 10 },
      architecture: "R23_30S_WINRATE_LAB",
      config: best.c,
      withTsmom: {
        train: best.tr,
        validation: best.va,
        test,
        survived:
          best.tr.returnPct > 0 &&
          best.va.returnPct > 0 &&
          test.returnPct > 0 &&
          best.va.pf > 1 &&
          test.pf > 1,
      },
      pureScalperSameConfig: {
        train: pureTrain,
        validation: pureVal,
        test: pureTest,
      },
    }),
  );
}
function simulateR23(
  b: Bar[],
  cands: Candidate[],
  cfg: R23Cfg,
  start: number,
  end: number,
): Stats {
  let eq = 100,
    pk = 100,
    dd = 0,
    gp = 0,
    gl = 0,
    n = 0,
    w = 0,
    next = start;
  const holdBars = Math.round(cfg.holdMin / ENTRY_MIN);
  for (const z of cands) {
    const i = z.i;
    if (i < start || i >= end - holdBars - 2 || i < next) continue;
    const side: Side = cfg.reverse
        ? z.side === "BUY"
          ? "SELL"
          : "BUY"
        : z.side,
      entry = b[i + 1].open,
      tp =
        side === "BUY"
          ? entry * (1 + cfg.targetPct / 100)
          : entry * (1 - cfg.targetPct / 100),
      sl =
        side === "BUY"
          ? entry * (1 - cfg.stopPct / 100)
          : entry * (1 + cfg.stopPct / 100);
    let exit = b[i + holdBars].close,
      xi = i + holdBars;
    for (let j = i + 1; j <= i + holdBars; j++) {
      const y = b[j],
        hitStop = side === "BUY" ? y.low <= sl : y.high >= sl,
        hitTarget = side === "BUY" ? y.high >= tp : y.low <= tp;
      if (hitStop) {
        exit = sl;
        xi = j;
        break;
      }
      if (hitTarget) {
        exit = tp;
        xi = j;
        break;
      }
    }
    const net =
        (side === "BUY" ? exit / entry - 1 : entry / exit - 1) * 100 - COST,
      ar = net * EXPOSURE;
    eq *= 1 + ar / 100;
    pk = Math.max(pk, eq);
    dd = Math.max(dd, ((pk - eq) / pk) * 100);
    n++;
    if (ar > 0) {
      w++;
      gp += ar;
    } else gl += Math.abs(ar);
    next = xi + 2;
  }
  const days = Math.max(
    1,
    (b[Math.min(end - 1, b.length - 1)].time - b[Math.max(start, 0)].time) /
      DAY,
  );
  return {
    trades: n,
    winRate: n ? (w / n) * 100 : 0,
    pf: gl ? gp / gl : gp ? 99 : 0,
    returnPct: eq - 100,
    ddPct: dd,
    tradesPerDay: n / days,
    final50: eq / 2,
  };
}
function passesR23(s: Stats) {
  return (
    s.winRate >= 65 &&
    s.tradesPerDay >= 10 &&
    s.pf >= 1.2 &&
    s.returnPct > 0 &&
    s.trades >= 150
  );
}
function r23Score(s: Stats) {
  return (
    s.returnPct * 3 +
    s.pf * 4 +
    s.winRate * 0.08 +
    s.tradesPerDay * 0.08 -
    s.ddPct * 2 -
    Math.max(0, 65 - s.winRate) * 1.5 -
    Math.max(0, 10 - s.tradesPerDay) * 2
  );
}

async function mainR23() {
  const end = Math.floor((Date.now() - 2 * DAY) / DAY) * DAY,
    start = end - DAYS * DAY,
    dates: string[] = [];
  for (let t = start; t < end; t += DAY)
    dates.push(new Date(t).toISOString().slice(0, 10));
  const daily = await mapLimit(dates, DOWNLOAD_CONCURRENCY, async (d) => {
      const bars = await fetchDay(d);
      console.log("DAY", d, bars.length);
      return bars;
    }),
    bars = daily.flat().sort((a, b) => a.time - b.time),
    N = bars.length;
  if (N < 4000) throw new Error(`INSUFFICIENT_BARS:${N}`);
  const t1 = Math.floor(N * 0.5),
    t2 = Math.floor(N * 0.75),
    snaps = buildSnapshots(bars);
  console.log("R23_SEARCH_START", N);
  const rows: Array<{
    cfg: R23Cfg;
    train: Stats;
    validation: Stats;
    score: number;
    qualified: boolean;
  }> = [];
  for (const minVotes of [10, 20, 30])
    for (const minFamilies of [2, 4])
      for (const mom16Threshold of [0.15, 0.3, 0.6, 1]) {
        const base = { minVotes, minFamilies, lead: 1.15 },
          cands = consensusCandidates(snaps, base, 0, N, true, mom16Threshold);
        for (const holdMin of [2, 5, 10])
          for (const targetPct of [0.24, 0.32, 0.42, 0.55])
            for (const stopPct of [0.15, 0.2, 0.28, 0.38])
              for (const reverse of [false, true]) {
                const cfg: R23Cfg = {
                    ...base,
                    mom16Threshold,
                    holdMin,
                    targetPct,
                    stopPct,
                    reverse,
                  },
                  train = simulateR23(bars, cands, cfg, 0, t1),
                  validation = simulateR23(bars, cands, cfg, t1, t2),
                  qualified = passesR23(train) && passesR23(validation),
                  score =
                    r23Score(train) +
                    r23Score(validation) * 1.5 +
                    (qualified ? 10000 : 0);
                rows.push({ cfg, train, validation, score, qualified });
              }
      }
  rows.sort((a, b) => b.score - a.score);
  console.log("R23_TOP10", JSON.stringify(rows.slice(0, 10)));
  const best = rows[0],
    bestCands = consensusCandidates(
      snaps,
      best.cfg,
      0,
      N,
      true,
      best.cfg.mom16Threshold,
    ),
    test = simulateR23(bars, bestCands, best.cfg, t2, N),
    survived = best.qualified && passesR23(test);
  console.log(
    "R23_RESULT",
    JSON.stringify({
      symbol: SYMBOL,
      days: DAYS,
      bars: N,
      entryTimeframe: "30s",
      costPct: COST,
      selection: "TRAIN_AND_VALIDATION_ONLY_BLIND_TEST",
      requirements: {
        winRateMin: 65,
        tradesPerDayMin: 10,
        pfMin: 1.2,
        testTradesMin: 150,
        positiveReturn: true,
      },
      config: best.cfg,
      train: best.train,
      validation: best.validation,
      test,
      survived,
      qualifiedTrainValidation: best.qualified,
      qualifiedConfigurations: rows.filter((x) => x.qualified).length,
    }),
  );
}
// R23 entrypoint disabled in the structural laboratory.

type PivotKind = "SUPPORT" | "RESISTANCE";
type PivotEvent = {
  knownAt: number;
  price: number;
  kind: PivotKind;
  tf: string;
};
type Structure = {
  support: number;
  resistance: number;
  supportTf: string;
  resistanceTf: string;
};
type StructuralCfg = ConsensusCfg & {
  mom16Threshold: number;
  holdMin: number;
  minNetRr: number;
  maxRiskPct: number;
  atrBuffer: number;
};
type TradeAudit = {
  signalTime: string;
  entryTime: string;
  side: Side;
  entry: number;
  support: number;
  resistance: number;
  supportTf: string;
  resistanceTf: string;
  sl: number;
  tp: number;
  riskPct: number;
  rewardPct: number;
  netRr: number;
  exitTime: string;
  exit: number;
  netPct: number;
  outcome: "WIN" | "LOSS";
};

function reaggregate(input: Bar[], ms: number) {
  const out: Bar[] = [];
  let current: Bar | undefined;
  for (const x of input) {
    const time = Math.floor(x.time / ms) * ms;
    if (!current || current.time !== time) {
      current = { ...x, time };
      out.push(current);
    } else {
      current.high = Math.max(current.high, x.high);
      current.low = Math.min(current.low, x.low);
      current.close = x.close;
      current.volume += x.volume;
      current.buyVolume += x.buyVolume;
      current.sellVolume += x.sellVolume;
    }
  }
  return out;
}
function pivotEvents(bars: Bar[], ms: number, tf: string) {
  const h = reaggregate(bars, ms),
    events: PivotEvent[] = [];
  for (let i = 2; i < h.length - 2; i++) {
    const knownAt = h[i + 2].time + ms,
      p = h[i];
    if (
      p.low < h[i - 2].low &&
      p.low <= h[i - 1].low &&
      p.low < h[i + 1].low &&
      p.low <= h[i + 2].low
    )
      events.push({ knownAt, price: p.low, kind: "SUPPORT", tf });
    if (
      p.high > h[i - 2].high &&
      p.high >= h[i - 1].high &&
      p.high > h[i + 1].high &&
      p.high >= h[i + 2].high
    )
      events.push({ knownAt, price: p.high, kind: "RESISTANCE", tf });
  }
  return events;
}
function buildStructures(bars: Bar[]) {
  const events = [
      ...pivotEvents(bars, 60000, "1m"),
      ...pivotEvents(bars, 300000, "5m"),
      ...pivotEvents(bars, 900000, "15m"),
      ...pivotEvents(bars, 3600000, "1h"),
    ].sort((a, b) => a.knownAt - b.knownAt),
    out = new Array<Structure>(bars.length),
    active: Record<string, { s: PivotEvent[]; r: PivotEvent[] }> = {
      "1m": { s: [], r: [] },
      "5m": { s: [], r: [] },
      "15m": { s: [], r: [] },
      "1h": { s: [], r: [] },
    };
  let e = 0;
  for (let i = 0; i < bars.length; i++) {
    while (e < events.length && events[e].knownAt <= bars[i].time) {
      const x = events[e++],
        a = active[x.tf],
        list = x.kind === "SUPPORT" ? a.s : a.r;
      list.push(x);
      if (list.length > 24) list.shift();
    }
    const price = bars[i].close;
    let support = 0,
      resistance = Infinity,
      supportTf = "",
      resistanceTf = "";
    for (const tf of ["1m", "5m", "15m", "1h"]) {
      for (const x of active[tf].s)
        if (x.price < price && x.price > support) {
          support = x.price;
          supportTf = tf;
        }
      for (const x of active[tf].r)
        if (x.price > price && x.price < resistance) {
          resistance = x.price;
          resistanceTf = tf;
        }
    }
    out[i] = {
      support,
      resistance: Number.isFinite(resistance) ? resistance : 0,
      supportTf,
      resistanceTf,
    };
  }
  return out;
}
function structuralSim(
  bars: Bar[],
  snaps: Snap[],
  structures: Structure[],
  cands: Candidate[],
  cfg: StructuralCfg,
  start: number,
  end: number,
  audit = false,
) {
  let eq = 100,
    pk = 100,
    dd = 0,
    gp = 0,
    gl = 0,
    n = 0,
    w = 0,
    next = start,
    rejectedNoLevels = 0,
    rejectedSpace = 0;
  const trades: TradeAudit[] = [],
    holdBars = Math.round(cfg.holdMin / ENTRY_MIN);
  for (const z of cands) {
    const i = z.i;
    if (i < start || i >= end - holdBars - 2 || i < next) continue;
    const side = z.side,
      entry = bars[i + 1].open,
      a = snaps[i].atr,
      s = structures[i];
    if (!(a > 0 && s.support > 0 && s.resistance > 0)) {
      rejectedNoLevels++;
      continue;
    }
    const buffer = a * cfg.atrBuffer,
      sl = side === "BUY" ? s.support - buffer : s.resistance + buffer,
      tp = side === "BUY" ? s.resistance - buffer : s.support + buffer;
    if (
      (side === "BUY" && !(sl < entry && tp > entry)) ||
      (side === "SELL" && !(sl > entry && tp < entry))
    ) {
      rejectedSpace++;
      continue;
    }
    const riskPct = (Math.abs(entry - sl) / entry) * 100,
      rewardPct = (Math.abs(tp - entry) / entry) * 100,
      netRr = (rewardPct - COST) / (riskPct + COST);
    if (
      rewardPct <= COST * 1.25 ||
      riskPct > cfg.maxRiskPct ||
      netRr < cfg.minNetRr
    ) {
      rejectedSpace++;
      continue;
    }
    let exit = bars[i + holdBars].close,
      xi = i + holdBars;
    for (let j = i + 1; j <= i + holdBars; j++) {
      const y = bars[j],
        hitStop = side === "BUY" ? y.low <= sl : y.high >= sl,
        hitTarget = side === "BUY" ? y.high >= tp : y.low <= tp;
      if (hitStop) {
        exit = sl;
        xi = j;
        break;
      }
      if (hitTarget) {
        exit = tp;
        xi = j;
        break;
      }
    }
    const net =
        (side === "BUY" ? exit / entry - 1 : entry / exit - 1) * 100 - COST,
      ar = net * EXPOSURE;
    eq *= 1 + ar / 100;
    pk = Math.max(pk, eq);
    dd = Math.max(dd, ((pk - eq) / pk) * 100);
    n++;
    if (ar > 0) {
      w++;
      gp += ar;
    } else gl += Math.abs(ar);
    if (audit)
      trades.push({
        signalTime: new Date(bars[i].time).toISOString(),
        entryTime: new Date(bars[i + 1].time).toISOString(),
        side,
        entry,
        support: s.support,
        resistance: s.resistance,
        supportTf: s.supportTf,
        resistanceTf: s.resistanceTf,
        sl,
        tp,
        riskPct,
        rewardPct,
        netRr,
        exitTime: new Date(bars[xi].time).toISOString(),
        exit,
        netPct: net,
        outcome: net > 0 ? "WIN" : "LOSS",
      });
    next = xi + 2;
  }
  const days = Math.max(
      1,
      (bars[Math.min(end - 1, bars.length - 1)].time -
        bars[Math.max(start, 0)].time) /
        DAY,
    ),
    stats: Stats = {
      trades: n,
      winRate: n ? (w / n) * 100 : 0,
      pf: gl ? gp / gl : gp ? 99 : 0,
      returnPct: eq - 100,
      ddPct: dd,
      tradesPerDay: n / days,
      final50: eq / 2,
    };
  return { stats, trades, rejectedNoLevels, rejectedSpace };
}
function structuralPass(s: Stats) {
  return (
    s.winRate >= 65 &&
    s.tradesPerDay >= 10 &&
    s.pf >= 1.2 &&
    s.returnPct > 0 &&
    s.trades >= 150
  );
}
function structuralScore(s: Stats) {
  return (
    s.returnPct * 4 +
    s.pf * 5 +
    s.winRate * 0.12 +
    s.tradesPerDay * 0.12 -
    s.ddPct * 2 -
    Math.max(0, 65 - s.winRate) * 1.6 -
    Math.max(0, 10 - s.tradesPerDay) * 2.5
  );
}

async function mainR24() {
  const end = Math.floor((Date.now() - 2 * DAY) / DAY) * DAY,
    start = end - DAYS * DAY,
    dates: string[] = [];
  for (let t = start; t < end; t += DAY)
    dates.push(new Date(t).toISOString().slice(0, 10));
  const daily = await mapLimit(dates, DOWNLOAD_CONCURRENCY, async (d) => {
      const x = await fetchDay(d);
      console.log("DAY", d, x.length);
      return x;
    }),
    bars = daily.flat().sort((a, b) => a.time - b.time),
    N = bars.length,
    t1 = Math.floor(N * 0.5),
    t2 = Math.floor(N * 0.75);
  if (N < 4000) throw new Error(`INSUFFICIENT_BARS:${N}`);
  console.log("R24_PRECOMPUTE", N);
  const snaps = buildSnapshots(bars),
    structures = buildStructures(bars),
    rows: Array<{
      cfg: StructuralCfg;
      train: Stats;
      validation: Stats;
      score: number;
      qualified: boolean;
    }> = [];
  for (const minVotes of [10, 20, 30])
    for (const minFamilies of [2, 4])
      for (const mom16Threshold of [0.3, 0.6, 1]) {
        const base = { minVotes, minFamilies, lead: 1.15 },
          cands = consensusCandidates(snaps, base, 0, N, true, mom16Threshold);
        for (const holdMin of [15, 30, 60])
          for (const minNetRr of [0.8, 1, 1.25])
            for (const maxRiskPct of [0.25, 0.4, 0.65])
              for (const atrBuffer of [0.1, 0.2]) {
                const cfg = {
                    ...base,
                    mom16Threshold,
                    holdMin,
                    minNetRr,
                    maxRiskPct,
                    atrBuffer,
                  },
                  train = structuralSim(
                    bars,
                    snaps,
                    structures,
                    cands,
                    cfg,
                    0,
                    t1,
                  ).stats,
                  validation = structuralSim(
                    bars,
                    snaps,
                    structures,
                    cands,
                    cfg,
                    t1,
                    t2,
                  ).stats,
                  qualified =
                    structuralPass(train) && structuralPass(validation),
                  score =
                    r25Score(train) +
                    r25Score(validation) * 1.5 +
                    (qualified ? 10000 : 0);
                rows.push({ cfg, train, validation, score, qualified });
              }
      }
  rows.sort((a, b) => b.score - a.score);
  const best = rows[0],
    cands = consensusCandidates(
      snaps,
      best.cfg,
      0,
      N,
      true,
      best.cfg.mom16Threshold,
    ),
    blind = structuralSim(
      bars,
      snaps,
      structures,
      cands,
      best.cfg,
      t2,
      N,
      true,
    ),
    survived = best.qualified && structuralPass(blind.stats);
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    "artifacts/r24-trades.json",
    JSON.stringify(
      { config: best.cfg, summary: blind.stats, trades: blind.trades },
      null,
      2,
    ),
  );
  console.log("R24_TOP10", JSON.stringify(rows.slice(0, 10)));
  console.log(
    "R24_RESULT",
    JSON.stringify({
      symbol: SYMBOL,
      days: DAYS,
      bars: N,
      entryTimeframe: "30s",
      structureTimeframes: ["1m", "5m", "15m", "1h"],
      lookaheadFree: "pivots confirmed after two closed candles",
      costPct: COST,
      requirements: {
        winRateMin: 65,
        tradesPerDayMin: 10,
        pfMin: 1.2,
        testTradesMin: 150,
      },
      config: best.cfg,
      train: best.train,
      validation: best.validation,
      test: blind.stats,
      rejected: {
        noLevels: blind.rejectedNoLevels,
        insufficientSpaceOrRisk: blind.rejectedSpace,
      },
      qualifiedConfigurations: rows.filter((x) => x.qualified).length,
      survived,
      auditFile: "artifacts/r24-trades.json",
    }),
  );
}
// R24 entrypoint disabled in the structure-entry laboratory.

type R25Cfg = StructuralCfg & {
  proximityAtr: number;
  voteLead: number;
  flowLead: number;
};
function r25Score(s: Stats) {
  return (
    s.returnPct * 4 +
    Math.min(s.pf, 3) * 5 +
    s.winRate * 0.12 +
    s.tradesPerDay * 0.12 -
    s.ddPct * 2 -
    Math.max(0, 65 - s.winRate) * 1.6 -
    Math.max(0, 10 - s.tradesPerDay) * 2.5 -
    Math.max(0, 100 - s.trades) * 0.6
  );
}
function structureEntryCandidates(
  bars: Bar[],
  snaps: Snap[],
  structures: Structure[],
  cfg: R25Cfg,
) {
  const out: Candidate[] = [];
  for (let i = 2000; i < bars.length - 2; i++) {
    const x = bars[i],
      s = structures[i],
      a = snaps[i].atr;
    if (!(a > 0 && s.support > 0 && s.resistance > 0)) continue;
    const nearSupport =
        x.low <= s.support + a * cfg.proximityAtr && x.close > s.support,
      nearResistance =
        x.high >= s.resistance - a * cfg.proximityAtr && x.close < s.resistance,
      bullReject =
        x.close > x.open &&
        x.close >= (x.low + x.high) / 2 &&
        x.buyVolume >= x.sellVolume * cfg.flowLead,
      bearReject =
        x.close < x.open &&
        x.close <= (x.low + x.high) / 2 &&
        x.sellVolume >= x.buyVolume * cfg.flowLead,
      buyVotes = snaps[i].buy >= Math.max(5, snaps[i].sell * cfg.voteLead),
      sellVotes = snaps[i].sell >= Math.max(5, snaps[i].buy * cfg.voteLead),
      trendBuy = snaps[i].mom16 >= cfg.mom16Threshold,
      trendSell = snaps[i].mom16 <= -cfg.mom16Threshold;
    const continuationBuy = trendBuy && nearSupport && bullReject && buyVotes,
      continuationSell = trendSell && nearResistance && bearReject && sellVotes,
      rangeBuy =
        Math.abs(snaps[i].mom16) < cfg.mom16Threshold &&
        nearSupport &&
        bullReject,
      rangeSell =
        Math.abs(snaps[i].mom16) < cfg.mom16Threshold &&
        nearResistance &&
        bearReject;
    if (continuationBuy || rangeBuy) out.push({ i, side: "BUY" });
    else if (continuationSell || rangeSell) out.push({ i, side: "SELL" });
  }
  return out;
}

async function mainR25() {
  const end = Math.floor((Date.now() - 2 * DAY) / DAY) * DAY,
    start = end - DAYS * DAY,
    dates: string[] = [];
  for (let t = start; t < end; t += DAY)
    dates.push(new Date(t).toISOString().slice(0, 10));
  const daily = await mapLimit(dates, DOWNLOAD_CONCURRENCY, async (d) => {
      const x = await fetchDay(d);
      console.log("DAY", d, x.length);
      return x;
    }),
    bars = daily.flat().sort((a, b) => a.time - b.time),
    N = bars.length,
    t1 = Math.floor(N * 0.5),
    t2 = Math.floor(N * 0.75);
  if (N < 4000) throw new Error(`INSUFFICIENT_BARS:${N}`);
  console.log("R25_PRECOMPUTE", N);
  const snaps = buildSnapshots(bars),
    structures = buildStructures(bars),
    rows: Array<{
      cfg: R25Cfg;
      train: Stats;
      validation: Stats;
      score: number;
      qualified: boolean;
      candidates: number;
    }> = [];
  for (const mom16Threshold of [0.3, 0.6, 1])
    for (const proximityAtr of [0.25, 0.5, 1, 1.5])
      for (const voteLead of [1, 1.15])
        for (const flowLead of [1, 1.1]) {
          const seed: R25Cfg = {
              minVotes: 0,
              minFamilies: 0,
              lead: 0,
              mom16Threshold,
              proximityAtr,
              voteLead,
              flowLead,
              holdMin: 15,
              minNetRr: 0.8,
              maxRiskPct: 0.5,
              atrBuffer: 0.1,
            },
            cands = structureEntryCandidates(bars, snaps, structures, seed);
          for (const holdMin of [5, 15, 30])
            for (const minNetRr of [0.5, 0.8, 1.1])
              for (const maxRiskPct of [0.25, 0.5, 0.8])
                for (const atrBuffer of [0.05, 0.15]) {
                  const cfg = {
                      ...seed,
                      holdMin,
                      minNetRr,
                      maxRiskPct,
                      atrBuffer,
                    },
                    train = structuralSim(
                      bars,
                      snaps,
                      structures,
                      cands,
                      cfg,
                      0,
                      t1,
                    ).stats,
                    validation = structuralSim(
                      bars,
                      snaps,
                      structures,
                      cands,
                      cfg,
                      t1,
                      t2,
                    ).stats,
                    qualified =
                      structuralPass(train) && structuralPass(validation),
                    score =
                      r25Score(train) +
                      r25Score(validation) * 1.5 +
                      (qualified ? 10000 : 0);
                  rows.push({
                    cfg,
                    train,
                    validation,
                    score,
                    qualified,
                    candidates: cands.length,
                  });
                }
        }
  rows.sort((a, b) => b.score - a.score);
  const best = rows[0],
    cands = structureEntryCandidates(bars, snaps, structures, best.cfg),
    blind = structuralSim(
      bars,
      snaps,
      structures,
      cands,
      best.cfg,
      t2,
      N,
      true,
    ),
    survived = best.qualified && structuralPass(blind.stats);
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    "artifacts/r25-trades.json",
    JSON.stringify(
      { config: best.cfg, summary: blind.stats, trades: blind.trades },
      null,
      2,
    ),
  );
  console.log("R25_TOP10", JSON.stringify(rows.slice(0, 10)));
  console.log(
    "R25_RESULT",
    JSON.stringify({
      symbol: SYMBOL,
      days: DAYS,
      bars: N,
      entryTimeframe: "30s",
      entryEngines: ["TREND_PULLBACK_REJECTION", "RANGE_LEVEL_REJECTION"],
      structureTimeframes: ["1m", "5m", "15m", "1h"],
      lookaheadFree: true,
      costPct: COST,
      requirements: {
        winRateMin: 65,
        tradesPerDayMin: 10,
        pfMin: 1.2,
        testTradesMin: 150,
      },
      config: best.cfg,
      candidates: best.candidates,
      train: best.train,
      validation: best.validation,
      test: blind.stats,
      rejected: {
        noLevels: blind.rejectedNoLevels,
        insufficientSpaceOrRisk: blind.rejectedSpace,
      },
      qualifiedConfigurations: rows.filter((x) => x.qualified).length,
      survived,
      auditFile: "artifacts/r25-trades.json",
    }),
  );
}
// R25 entrypoint disabled in the split-structure laboratory.

function buildSelectedStructures(
  bars: Bar[],
  selected: Array<{ ms: number; tf: string }>,
) {
  const events = selected
      .flatMap((x) => pivotEvents(bars, x.ms, x.tf))
      .sort((a, b) => a.knownAt - b.knownAt),
    out = new Array<Structure>(bars.length),
    active = new Map<string, { s: PivotEvent[]; r: PivotEvent[] }>();
  for (const x of selected) active.set(x.tf, { s: [], r: [] });
  let e = 0;
  for (let i = 0; i < bars.length; i++) {
    while (e < events.length && events[e].knownAt <= bars[i].time) {
      const x = events[e++],
        a = active.get(x.tf)!,
        list = x.kind === "SUPPORT" ? a.s : a.r;
      list.push(x);
      if (list.length > 30) list.shift();
    }
    const price = bars[i].close;
    let support = 0,
      resistance = Infinity,
      supportTf = "",
      resistanceTf = "";
    for (const { tf } of selected) {
      const a = active.get(tf)!;
      for (const x of a.s)
        if (x.price < price && x.price > support) {
          support = x.price;
          supportTf = tf;
        }
      for (const x of a.r)
        if (x.price > price && x.price < resistance) {
          resistance = x.price;
          resistanceTf = tf;
        }
    }
    out[i] = {
      support,
      resistance: Number.isFinite(resistance) ? resistance : 0,
      supportTf,
      resistanceTf,
    };
  }
  return out;
}
function splitStructureSim(
  bars: Bar[],
  snaps: Snap[],
  entryStructure: Structure[],
  targetStructure: Structure[],
  cands: Candidate[],
  cfg: R25Cfg,
  start: number,
  end: number,
  audit = false,
) {
  let eq = 100,
    pk = 100,
    dd = 0,
    gp = 0,
    gl = 0,
    n = 0,
    w = 0,
    next = start,
    rejectedNoLevels = 0,
    rejectedSpace = 0;
  const trades: TradeAudit[] = [],
    holdBars = Math.round(cfg.holdMin / ENTRY_MIN);
  for (const z of cands) {
    const i = z.i;
    if (i < start || i >= end - holdBars - 2 || i < next) continue;
    const side = z.side,
      entry = bars[i + 1].open,
      a = snaps[i].atr,
      local = entryStructure[i],
      macro = targetStructure[i];
    if (!(
      a > 0 &&
      local.support > 0 &&
      local.resistance > 0 &&
      macro.support > 0 &&
      macro.resistance > 0
    )) {
      rejectedNoLevels++;
      continue;
    }
    const buffer = a * cfg.atrBuffer,
      sl = side === "BUY" ? local.support - buffer : local.resistance + buffer,
      tp = side === "BUY" ? macro.resistance - buffer : macro.support + buffer;
    if (
      (side === "BUY" && !(sl < entry && tp > entry)) ||
      (side === "SELL" && !(sl > entry && tp < entry))
    ) {
      rejectedSpace++;
      continue;
    }
    const riskPct = (Math.abs(entry - sl) / entry) * 100,
      rewardPct = (Math.abs(tp - entry) / entry) * 100,
      netRr = (rewardPct - COST) / (riskPct + COST);
    if (
      rewardPct <= COST * 1.25 ||
      riskPct > cfg.maxRiskPct ||
      netRr < cfg.minNetRr
    ) {
      rejectedSpace++;
      continue;
    }
    let exit = bars[i + holdBars].close,
      xi = i + holdBars;
    for (let j = i + 1; j <= i + holdBars; j++) {
      const y = bars[j],
        hitStop = side === "BUY" ? y.low <= sl : y.high >= sl,
        hitTarget = side === "BUY" ? y.high >= tp : y.low <= tp;
      if (hitStop) {
        exit = sl;
        xi = j;
        break;
      }
      if (hitTarget) {
        exit = tp;
        xi = j;
        break;
      }
    }
    const net =
        (side === "BUY" ? exit / entry - 1 : entry / exit - 1) * 100 - COST,
      ar = net * EXPOSURE;
    eq *= 1 + ar / 100;
    pk = Math.max(pk, eq);
    dd = Math.max(dd, ((pk - eq) / pk) * 100);
    n++;
    if (ar > 0) {
      w++;
      gp += ar;
    } else gl += Math.abs(ar);
    if (audit)
      trades.push({
        signalTime: new Date(bars[i].time).toISOString(),
        entryTime: new Date(bars[i + 1].time).toISOString(),
        side,
        entry,
        support: local.support,
        resistance: macro.resistance,
        supportTf: local.supportTf,
        resistanceTf: macro.resistanceTf,
        sl,
        tp,
        riskPct,
        rewardPct,
        netRr,
        exitTime: new Date(bars[xi].time).toISOString(),
        exit,
        netPct: net,
        outcome: net > 0 ? "WIN" : "LOSS",
      });
    next = xi + 2;
  }
  const days = Math.max(
      1,
      (bars[Math.min(end - 1, bars.length - 1)].time -
        bars[Math.max(start, 0)].time) /
        DAY,
    ),
    stats: Stats = {
      trades: n,
      winRate: n ? (w / n) * 100 : 0,
      pf: gl ? gp / gl : gp ? 99 : 0,
      returnPct: eq - 100,
      ddPct: dd,
      tradesPerDay: n / days,
      final50: eq / 2,
    };
  return { stats, trades, rejectedNoLevels, rejectedSpace };
}

async function mainR26() {
  const end = Math.floor((Date.now() - 2 * DAY) / DAY) * DAY,
    start = end - DAYS * DAY,
    dates: string[] = [];
  for (let t = start; t < end; t += DAY)
    dates.push(new Date(t).toISOString().slice(0, 10));
  const daily = await mapLimit(dates, DOWNLOAD_CONCURRENCY, async (d) => {
      const x = await fetchDay(d);
      console.log("DAY", d, x.length);
      return x;
    }),
    bars = daily.flat().sort((a, b) => a.time - b.time),
    N = bars.length,
    t1 = Math.floor(N * 0.5),
    t2 = Math.floor(N * 0.75);
  if (N < 4000) throw new Error(`INSUFFICIENT_BARS:${N}`);
  console.log("R26_PRECOMPUTE", N);
  const snaps = buildSnapshots(bars),
    entryStructure = buildSelectedStructures(bars, [
      { ms: 60000, tf: "1m" },
      { ms: 300000, tf: "5m" },
    ]),
    targetStructure = buildSelectedStructures(bars, [
      { ms: 300000, tf: "5m" },
      { ms: 900000, tf: "15m" },
      { ms: 3600000, tf: "1h" },
    ]),
    rows: Array<{
      cfg: R25Cfg;
      train: Stats;
      validation: Stats;
      score: number;
      qualified: boolean;
      candidates: number;
    }> = [];
  for (const mom16Threshold of [0.3, 0.6, 1])
    for (const proximityAtr of [0.25, 0.5, 1, 1.5])
      for (const voteLead of [1, 1.15])
        for (const flowLead of [1, 1.1]) {
          const seed: R25Cfg = {
              minVotes: 0,
              minFamilies: 0,
              lead: 0,
              mom16Threshold,
              proximityAtr,
              voteLead,
              flowLead,
              holdMin: 30,
              minNetRr: 0.8,
              maxRiskPct: 0.5,
              atrBuffer: 0.1,
            },
            cands = structureEntryCandidates(bars, snaps, entryStructure, seed);
          for (const holdMin of [15, 30, 60, 120])
            for (const minNetRr of [0.5, 0.8, 1.1])
              for (const maxRiskPct of [0.25, 0.5, 0.8, 1.2])
                for (const atrBuffer of [0.05, 0.15]) {
                  const cfg = {
                      ...seed,
                      holdMin,
                      minNetRr,
                      maxRiskPct,
                      atrBuffer,
                    },
                    train = splitStructureSim(
                      bars,
                      snaps,
                      entryStructure,
                      targetStructure,
                      cands,
                      cfg,
                      0,
                      t1,
                    ).stats,
                    validation = splitStructureSim(
                      bars,
                      snaps,
                      entryStructure,
                      targetStructure,
                      cands,
                      cfg,
                      t1,
                      t2,
                    ).stats,
                    qualified =
                      structuralPass(train) && structuralPass(validation),
                    score =
                      r25Score(train) +
                      r25Score(validation) * 1.5 +
                      (qualified ? 10000 : 0);
                  rows.push({
                    cfg,
                    train,
                    validation,
                    score,
                    qualified,
                    candidates: cands.length,
                  });
                }
        }
  rows.sort((a, b) => b.score - a.score);
  const best = rows[0],
    cands = structureEntryCandidates(bars, snaps, entryStructure, best.cfg),
    blind = splitStructureSim(
      bars,
      snaps,
      entryStructure,
      targetStructure,
      cands,
      best.cfg,
      t2,
      N,
      true,
    ),
    survived = best.qualified && structuralPass(blind.stats);
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    "artifacts/r26-trades.json",
    JSON.stringify(
      { config: best.cfg, summary: blind.stats, trades: blind.trades },
      null,
      2,
    ),
  );
  console.log("R26_TOP10", JSON.stringify(rows.slice(0, 10)));
  console.log(
    "R26_RESULT",
    JSON.stringify({
      symbol: SYMBOL,
      days: DAYS,
      bars: N,
      entryTimeframe: "30s",
      entryAndStopStructure: ["1m", "5m"],
      targetStructure: ["5m", "15m", "1h"],
      lookaheadFree: true,
      costPct: COST,
      requirements: {
        winRateMin: 65,
        tradesPerDayMin: 10,
        pfMin: 1.2,
        testTradesMin: 150,
      },
      config: best.cfg,
      candidates: best.candidates,
      train: best.train,
      validation: best.validation,
      test: blind.stats,
      rejected: {
        noLevels: blind.rejectedNoLevels,
        insufficientSpaceOrRisk: blind.rejectedSpace,
      },
      qualifiedConfigurations: rows.filter((x) => x.qualified).length,
      survived,
      auditFile: "artifacts/r26-trades.json",
    }),
  );
}
// R26 entrypoint disabled in EMA-Fibonacci laboratory.

type R27Cfg = {
  entryMin: number;
  trendMin: number;
  fib: number;
  volumeMult: number;
  swingLookback: number;
  expiryBars: number;
  extension: number;
  atrBuffer: number;
  minNetRr: number;
};
type Prepared = {
  bars: Bar[];
  ema8: Float64Array;
  ema14: Float64Array;
  ema150: Float64Array;
  macd: Float64Array;
  macdSignal: Float64Array;
  atr: Float64Array;
  avgVolume: Float64Array;
  filterVolume: Float64Array;
  trend: Array<Side | null>;
};
type R27Trade = {
  signalTime: string;
  fillTime: string;
  exitTime: string;
  side: Side;
  fib: number;
  entry: number;
  swingLow: number;
  swingHigh: number;
  sl: number;
  tp: number;
  exit: number;
  reason: string;
  netPct: number;
};
function emaSeries(values: number[], period: number) {
  const out = new Float64Array(values.length),
    k = 2 / (period + 1);
  let e = values[0] ?? 0;
  for (let i = 0; i < values.length; i++) {
    e = i ? values[i] * k + e * (1 - k) : values[i];
    out[i] = e;
  }
  return out;
}
function prepareR27(base: Bar[], entryMin: number, trendMin: number): Prepared {
  const bars = reaggregate(base, entryMin * 60000),
    close = bars.map((x) => x.close),
    ema8 = emaSeries(close, 8),
    ema14 = emaSeries(close, 14),
    ema150 = emaSeries(close, 150),
    macdBars = reaggregate(base, 5 * 60000),
    macdClose = macdBars.map((x) => x.close),
    macd12 = emaSeries(macdClose, 12),
    macd26 = emaSeries(macdClose, 26),
    macd5m = Float64Array.from(
      macdClose,
      (_, i) => macd12[i] - macd26[i],
    ),
    macdSignal5m = emaSeries(Array.from(macd5m), 9),
    macd = new Float64Array(bars.length),
    macdSignal = new Float64Array(bars.length),
    atrOut = new Float64Array(bars.length),
    avgVolume = new Float64Array(bars.length),
    filterVolume = Float64Array.from(bars, (x) => x.volume);
  let trSum = 0,
    volSum = 0;
  const trs = new Float64Array(bars.length);
  for (let i = 0; i < bars.length; i++) {
    trs[i] = i
      ? Math.max(
          bars[i].high - bars[i].low,
          Math.abs(bars[i].high - bars[i - 1].close),
          Math.abs(bars[i].low - bars[i - 1].close),
        )
      : bars[i].high - bars[i].low;
    trSum += trs[i];
    if (i >= 14) trSum -= trs[i - 14];
    atrOut[i] = trSum / Math.min(i + 1, 14);
    avgVolume[i] = i ? volSum / Math.min(i, 20) : 0;
    volSum += bars[i].volume;
    if (i >= 20) volSum -= bars[i - 20].volume;
  }
  const higher = reaggregate(base, trendMin * 60000),
    h8 = emaSeries(
      higher.map((x) => x.close),
      8,
    ),
    h14 = emaSeries(
      higher.map((x) => x.close),
      14,
    ),
    trend = new Array<Side | null>(bars.length).fill(null);
  let h = -1,
    m = -1;
  for (let i = 0; i < bars.length; i++) {
    const signalClose = bars[i].time + entryMin * 60000;
    while (
      m + 1 < macdBars.length &&
      macdBars[m + 1].time + 5 * 60000 <= signalClose
    )
      m++;
    if (m >= 0) {
      macd[i] = macd5m[m];
      macdSignal[i] = macdSignal5m[m];
    }
    while (
      h + 1 < higher.length &&
      higher[h + 1].time + trendMin * 60000 <= signalClose
    )
      h++;
    if (h >= 14)
      trend[i] = h8[h] > h14[h] ? "BUY" : h8[h] < h14[h] ? "SELL" : null;
  }
  return {
    bars,
    ema8,
    ema14,
    ema150,
    macd,
    macdSignal,
    atr: atrOut,
    avgVolume,
    filterVolume,
    trend,
  };
}
function runR27(
  p: Prepared,
  cfg: R27Cfg,
  start: number,
  end: number,
  audit = false,
) {
  const b = p.bars;
  let eq = 100,
    pk = 100,
    dd = 0,
    gp = 0,
    gl = 0,
    n = 0,
    w = 0,
    pending: null | {
      side: Side;
      limit: number;
      sl: number;
      tp: number;
      placed: number;
      low: number;
      high: number;
    } = null,
    pos: null | {
      side: Side;
      entry: number;
      sl: number;
      tp: number;
      fill: number;
      low: number;
      high: number;
    } = null;
  const trades: R27Trade[] = [];
  const closeTrade = (i: number, exit: number, reason: string) => {
    if (!pos) return;
    const net =
        (pos.side === "BUY" ? exit / pos.entry - 1 : pos.entry / exit - 1) *
          100 -
        COST,
      ar = net * EXPOSURE;
    eq *= 1 + ar / 100;
    pk = Math.max(pk, eq);
    dd = Math.max(dd, ((pk - eq) / pk) * 100);
    n++;
    if (ar > 0) {
      w++;
      gp += ar;
    } else gl += Math.abs(ar);
    if (audit)
      trades.push({
        signalTime: new Date(
          b[Math.max(start, pos.fill - 1)].time,
        ).toISOString(),
        fillTime: new Date(b[pos.fill].time).toISOString(),
        exitTime: new Date(b[i].time).toISOString(),
        side: pos.side,
        fib: cfg.fib,
        entry: pos.entry,
        swingLow: pos.low,
        swingHigh: pos.high,
        sl: pos.sl,
        tp: pos.tp,
        exit,
        reason,
        netPct: net,
      });
    pos = null;
  };
  for (let i = Math.max(start, 50); i < Math.min(end, b.length); i++) {
    const crossUp = p.ema8[i] > p.ema14[i] && p.ema8[i - 1] <= p.ema14[i - 1],
      crossDown = p.ema8[i] < p.ema14[i] && p.ema8[i - 1] >= p.ema14[i - 1],
      bias = p.trend[i];
    if (pos) {
      const hitStop =
          pos.side === "BUY" ? b[i].low <= pos.sl : b[i].high >= pos.sl,
        hitTp = pos.side === "BUY" ? b[i].high >= pos.tp : b[i].low <= pos.tp;
      if (hitStop) {
        closeTrade(i, pos.sl, "SL");
        continue;
      }
      if (hitTp) {
        closeTrade(i, pos.tp, "FIB_EXTENSION");
        continue;
      }
      if (
        (pos.side === "BUY" && (crossDown || bias === "SELL")) ||
        (pos.side === "SELL" && (crossUp || bias === "BUY"))
      ) {
        closeTrade(
          i,
          b[i].close,
          bias && bias !== pos.side ? "HIGHER_TF_CHANGE" : "EMA_8_14_REVERSE",
        );
        continue;
      }
    }
    if (
      !pos &&
      !pending &&
      i < end - 1 &&
      p.avgVolume[i] > 0 &&
      p.filterVolume[i] >= p.avgVolume[i] * cfg.volumeMult
    ) {
      let side: Side | null = null;
      if (crossUp && bias === "BUY" && b[i].close > p.ema150[i]) side = "BUY";
      else if (crossDown && bias === "SELL" && b[i].close < p.ema150[i])
        side = "SELL";
      if (side) {
        let low = Infinity,
          high = -Infinity;
        for (let j = Math.max(0, i - cfg.swingLookback + 1); j <= i; j++) {
          low = Math.min(low, b[j].low);
          high = Math.max(high, b[j].high);
        }
        const range = high - low,
          a = p.atr[i];
        if (range > a * 0.5) {
          const sl =
              side === "BUY"
                ? low - a * cfg.atrBuffer
                : high + a * cfg.atrBuffer,
            tp = side === "BUY" ? Infinity : 0;
          pos = {
            side,
            entry: b[i + 1].open,
            sl,
            tp,
            fill: i + 1,
            low,
            high,
          };
        }
      }
    }
  }
  if (pos)
    closeTrade(
      Math.min(end - 1, b.length - 1),
      b[Math.min(end - 1, b.length - 1)].close,
      "PERIOD_END",
    );
  const days = Math.max(
      1,
      (b[Math.min(end - 1, b.length - 1)].time - b[Math.max(start, 0)].time) /
        DAY,
    ),
    stats: Stats = {
      trades: n,
      winRate: n ? (w / n) * 100 : 0,
      pf: gl ? gp / gl : gp ? 99 : 0,
      returnPct: eq - 100,
      ddPct: dd,
      tradesPerDay: n / days,
      final50: eq / 2,
    };
  return { stats, trades };
}
function passR27(s: Stats) {
  return (
    s.winRate >= 65 &&
    s.tradesPerDay >= 10 &&
    s.pf >= 1.2 &&
    s.returnPct > 0 &&
    s.trades >= 120
  );
}
function scoreR27(s: Stats) {
  return (
    s.returnPct * 5 +
    Math.min(s.pf, 3) * 5 +
    s.winRate * 0.15 +
    s.tradesPerDay * 0.15 -
    s.ddPct * 2 -
    Math.max(0, 65 - s.winRate) * 1.8 -
    Math.max(0, 10 - s.tradesPerDay) * 2.5 -
    Math.max(0, 80 - s.trades) * 0.5
  );
}

async function mainR27() {
  const end = Math.floor((Date.now() - 2 * DAY) / DAY) * DAY,
    start = end - DAYS * DAY,
    dates: string[] = [];
  for (let t = start; t < end; t += DAY)
    dates.push(new Date(t).toISOString().slice(0, 10));
  const daily = await mapLimit(dates, DOWNLOAD_CONCURRENCY, async (d) => {
      const x = await fetchDay(d);
      console.log("DAY", d, x.length);
      return x;
    }),
    base = daily.flat().sort((a, b) => a.time - b.time),
    rows: Array<{
      cfg: R27Cfg;
      train: Stats;
      validation: Stats;
      score: number;
      qualified: boolean;
    }> = [];
  for (const entryMin of [1, 3])
    for (const trendMin of [5, 15]) {
      const p = prepareR27(base, entryMin, trendMin),
        t1 = Math.floor(p.bars.length * 0.5),
        t2 = Math.floor(p.bars.length * 0.75);
      for (const fib of [0.382, 0.5, 0.618])
        for (const volumeMult of [1, 1.2, 1.5])
          for (const swingLookback of [20, 40])
            for (const expiryBars of [10, 20])
              for (const extension of [0])
                for (const atrBuffer of [0.1, 0.25])
                  for (const minNetRr of [0]) {
                    const cfg = {
                        entryMin,
                        trendMin,
                        fib,
                        volumeMult,
                        swingLookback,
                        expiryBars,
                        extension,
                        atrBuffer,
                        minNetRr,
                      },
                      train = runR27(p, cfg, 0, t1).stats,
                      validation = runR27(p, cfg, t1, t2).stats,
                      qualified = passR27(train) && passR27(validation),
                      score =
                        scoreR27(train) +
                        scoreR27(validation) * 1.5 +
                        (qualified ? 10000 : 0);
                    rows.push({ cfg, train, validation, score, qualified });
                  }
    }
  rows.sort((a, b) => b.score - a.score);
  const best = rows[0],
    p = prepareR27(base, best.cfg.entryMin, best.cfg.trendMin),
    t2 = Math.floor(p.bars.length * 0.75),
    blind = runR27(p, best.cfg, t2, p.bars.length, true),
    survived = best.qualified && passR27(blind.stats);
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    "artifacts/r27-trades.json",
    JSON.stringify(
      { config: best.cfg, summary: blind.stats, trades: blind.trades },
      null,
      2,
    ),
  );
  console.log("R27_TOP10", JSON.stringify(rows.slice(0, 10)));
  console.log(
    "R27_RESULT",
    JSON.stringify({
      symbol: SYMBOL,
      days: DAYS,
      architecture: "EMA_8_14_CROSS_FIB_LIMIT_HIGHER_TF_TREND_VOLUME",
      costPct: COST,
      requirements: {
        winRateMin: 65,
        tradesPerDayMin: 10,
        pfMin: 1.2,
        testTradesMin: 120,
      },
      config: best.cfg,
      train: best.train,
      validation: best.validation,
      test: blind.stats,
      qualifiedConfigurations: rows.filter((x) => x.qualified).length,
      survived,
      auditFile: "artifacts/r27-trades.json",
    }),
  );
}
// R27 entrypoint disabled in corrected 30-second-cross laboratory.

type R28Cfg = R27Cfg & { structureMin: number; structureBars: number };
async function mainR28() {
  const end = Math.floor((Date.now() - 2 * DAY) / DAY) * DAY,
    start = end - DAYS * DAY,
    dates: string[] = [];
  for (let t = start; t < end; t += DAY)
    dates.push(new Date(t).toISOString().slice(0, 10));
  const daily = await mapLimit(dates, DOWNLOAD_CONCURRENCY, async (d) => {
      const x = await fetchDay(d);
      console.log("DAY", d, x.length);
      return x;
    }),
    base = daily.flat().sort((a, b) => a.time - b.time),
    rows: Array<{
      cfg: R28Cfg;
      train: Stats;
      validation: Stats;
      score: number;
      qualified: boolean;
    }> = [];
  for (const trendMin of [5, 15, 60]) {
    const p = prepareR27(base, 0.5, trendMin),
      t1 = Math.floor(p.bars.length * 0.5),
      t2 = Math.floor(p.bars.length * 0.75);
    for (const structureMin of [1, 3, 5])
      for (const structureBars of [10, 20])
        for (const fib of [0.382, 0.5, 0.618])
          for (const volumeMult of [1, 1.2])
            for (const expiryBars of [20, 40])
              for (const atrBuffer of [0.1, 0.25]) {
                const swingLookback = Math.round(
                    (structureMin / 0.5) * structureBars,
                  ),
                  cfg: R28Cfg = {
                    entryMin: 0.5,
                    trendMin,
                    structureMin,
                    structureBars,
                    fib,
                    volumeMult,
                    swingLookback,
                    expiryBars,
                    extension: 0,
                    atrBuffer,
                    minNetRr: 0,
                  },
                  train = runR27(p, cfg, 0, t1).stats,
                  validation = runR27(p, cfg, t1, t2).stats,
                  qualified = passR27(train) && passR27(validation),
                  score =
                    scoreR27(train) +
                    scoreR27(validation) * 1.5 +
                    (qualified ? 10000 : 0);
                rows.push({ cfg, train, validation, score, qualified });
              }
  }
  rows.sort((a, b) => b.score - a.score);
  const best = rows[0],
    p = prepareR27(base, 0.5, best.cfg.trendMin),
    t2 = Math.floor(p.bars.length * 0.75),
    blind = runR27(p, best.cfg, t2, p.bars.length, true),
    survived = best.qualified && passR27(blind.stats);
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    "artifacts/r28-trades.json",
    JSON.stringify(
      { config: best.cfg, summary: blind.stats, trades: blind.trades },
      null,
      2,
    ),
  );
  console.log("R28_TOP10", JSON.stringify(rows.slice(0, 10)));
  console.log(
    "R28_RESULT",
    JSON.stringify({
      symbol: SYMBOL,
      days: DAYS,
      architecture:
        "EMA_8_14_CROSS_30S_THEN_FIB_LIMIT_STRUCTURE_AND_HIGHER_TREND",
      emaCrossTimeframe: "30s",
      structureTimeframesTested: ["1m", "3m", "5m"],
      trendTimeframesTested: ["5m", "15m", "1h"],
      volumeTimeframe: "30s",
      costPct: COST,
      requirements: {
        winRateMin: 65,
        tradesPerDayMin: 10,
        pfMin: 1.2,
        testTradesMin: 120,
      },
      config: best.cfg,
      train: best.train,
      validation: best.validation,
      test: blind.stats,
      qualifiedConfigurations: rows.filter((x) => x.qualified).length,
      survived,
      auditFile: "artifacts/r28-trades.json",
    }),
  );
}
// R28 entrypoint disabled in MACD-cancellation laboratory.

async function mainR29() {
  const end = Math.floor((Date.now() - 2 * DAY) / DAY) * DAY,
    start = end - DAYS * DAY,
    dates: string[] = [];
  for (let t = start; t < end; t += DAY)
    dates.push(new Date(t).toISOString().slice(0, 10));
  const daily = await mapLimit(dates, DOWNLOAD_CONCURRENCY, async (d) => {
      const x = await fetchDay(d);
      console.log("DAY", d, x.length);
      return x;
    }),
    base = daily.flat().sort((a, b) => a.time - b.time),
    rows: Array<{
      cfg: R28Cfg;
      train: Stats;
      validation: Stats;
      score: number;
      qualified: boolean;
    }> = [];
  for (const trendMin of [5, 15, 60]) {
    const p = prepareR27(base, 0.5, trendMin),
      t1 = Math.floor(p.bars.length * 0.5),
      t2 = Math.floor(p.bars.length * 0.75);
    for (const structureMin of [1, 3, 5])
      for (const structureBars of [10, 20])
        for (const fib of [0.382, 0.5, 0.618])
          for (const volumeMult of [1, 1.2])
            for (const expiryBars of [20, 40])
              for (const atrBuffer of [0.1, 0.25]) {
                const swingLookback = Math.round(
                    (structureMin / 0.5) * structureBars,
                  ),
                  cfg: R28Cfg = {
                    entryMin: 0.5,
                    trendMin,
                    structureMin,
                    structureBars,
                    fib,
                    volumeMult,
                    swingLookback,
                    expiryBars,
                    extension: 0,
                    atrBuffer,
                    minNetRr: 0,
                  },
                  train = runR27(p, cfg, 0, t1).stats,
                  validation = runR27(p, cfg, t1, t2).stats,
                  qualified = passR27(train) && passR27(validation),
                  score =
                    scoreR27(train) +
                    scoreR27(validation) * 1.5 +
                    (qualified ? 10000 : 0);
                rows.push({ cfg, train, validation, score, qualified });
              }
  }
  rows.sort((a, b) => b.score - a.score);
  const best = rows[0],
    p = prepareR27(base, 0.5, best.cfg.trendMin),
    t2 = Math.floor(p.bars.length * 0.75),
    blind = runR27(p, best.cfg, t2, p.bars.length, true),
    survived = best.qualified && passR27(blind.stats);
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    "artifacts/r29-trades.json",
    JSON.stringify(
      { config: best.cfg, summary: blind.stats, trades: blind.trades },
      null,
      2,
    ),
  );
  console.log("R29_TOP10", JSON.stringify(rows.slice(0, 10)));
  console.log(
    "R29_RESULT",
    JSON.stringify({
      symbol: SYMBOL,
      days: DAYS,
      architecture:
        "EMA_8_14_CROSS_30S_MARKET_ENTRY_EMA150_HIGHER_TF_TREND_VOLUME",
      entryExecution: "MARKET_AT_NEXT_30S_OPEN",
      emaCrossTimeframe: "30s",
      ema150Filter: {
        timeframe: "30s",
        buy: "CLOSE_ABOVE_EMA150",
        sell: "CLOSE_BELOW_EMA150",
      },
      positionExit: [
        "SL",
        "OPPOSITE_EMA_8_14_CROSS",
        "HIGHER_TF_TREND_CHANGE",
        "PERIOD_END",
      ],
      macd: "NOT_USED_WITH_MARKET_ENTRY",
      structureTimeframesTested: ["1m", "3m", "5m"],
      trendTimeframesTested: ["5m", "15m", "1h"],
      volumeTimeframe: "30s",
      costPct: COST,
      requirements: {
        winRateMin: 65,
        tradesPerDayMin: 10,
        pfMin: 1.2,
        testTradesMin: 120,
      },
      config: best.cfg,
      train: best.train,
      validation: best.validation,
      test: blind.stats,
      qualifiedConfigurations: rows.filter((x) => x.qualified).length,
      survived,
      auditFile: "artifacts/r29-trades.json",
    }),
  );
}

type R30Cfg = R28Cfg & { ema150Min: number; volumeMin: number };

function mapClosedSeries(
  signalBars: Bar[],
  signalMin: number,
  sourceBars: Bar[],
  sourceMin: number,
  values: Float64Array,
) {
  const out = new Float64Array(signalBars.length);
  let j = -1;
  for (let i = 0; i < signalBars.length; i++) {
    const knownAt = signalBars[i].time + signalMin * 60000;
    while (
      j + 1 < sourceBars.length &&
      sourceBars[j + 1].time + sourceMin * 60000 <= knownAt
    )
      j++;
    if (j >= 0) out[i] = values[j];
  }
  return out;
}

function prepareR30(
  base: Bar[],
  entryMin: number,
  trendMin: number,
  ema150Min: number,
  volumeMin: number,
) {
  const p = prepareR27(base, entryMin, trendMin);
  const emaBars = reaggregate(base, ema150Min * 60000);
  const emaValues = emaSeries(
    emaBars.map((x) => x.close),
    150,
  );
  p.ema150 = mapClosedSeries(
    p.bars,
    entryMin,
    emaBars,
    ema150Min,
    emaValues,
  );

  const volumeBars = reaggregate(base, volumeMin * 60000);
  const currentVolume = Float64Array.from(volumeBars, (x) => x.volume);
  const averageVolume = new Float64Array(volumeBars.length);
  let sum = 0;
  for (let i = 0; i < volumeBars.length; i++) {
    averageVolume[i] = i ? sum / Math.min(i, 20) : 0;
    sum += volumeBars[i].volume;
    if (i >= 20) sum -= volumeBars[i - 20].volume;
  }
  p.filterVolume = mapClosedSeries(
    p.bars,
    entryMin,
    volumeBars,
    volumeMin,
    currentVolume,
  );
  p.avgVolume = mapClosedSeries(
    p.bars,
    entryMin,
    volumeBars,
    volumeMin,
    averageVolume,
  );
  return p;
}

async function mainR30() {
  const end = Math.floor((Date.now() - 2 * DAY) / DAY) * DAY;
  const start = end - DAYS * DAY;
  const dates: string[] = [];
  for (let t = start; t < end; t += DAY)
    dates.push(new Date(t).toISOString().slice(0, 10));
  const daily = await mapLimit(dates, DOWNLOAD_CONCURRENCY, async (d) => {
    const x = await fetchDay(d);
    console.log("DAY", d, x.length);
    return x;
  });
  const base = daily.flat().sort((a, b) => a.time - b.time);
  const entryFrames = [0.5, 1, 3, 5];
  const ema150Frames = [0.5, 1, 3, 5, 15];
  const volumeFrames = [0.5, 1, 3, 5, 15];
  const structureFrames = [1, 3, 5, 15];
  const trendFrames = [5, 15, 60, 240];
  const rows: Array<{
    cfg: R30Cfg;
    train: Stats;
    validation: Stats;
    score: number;
    qualified: boolean;
  }> = [];
  let prepared = 0;
  for (const entryMin of entryFrames)
    for (const trendMin of trendFrames) {
      if (trendMin <= entryMin) continue;
      for (const ema150Min of ema150Frames)
        for (const volumeMin of volumeFrames) {
          const p = prepareR30(
            base,
            entryMin,
            trendMin,
            ema150Min,
            volumeMin,
          );
          const t1 = Math.floor(p.bars.length * 0.5);
          const t2 = Math.floor(p.bars.length * 0.75);
          for (const structureMin of structureFrames) {
            const structureBars = 10;
            const cfg: R30Cfg = {
              entryMin,
              trendMin,
              ema150Min,
              volumeMin,
              structureMin,
              structureBars,
              fib: 0,
              volumeMult: 1.2,
              swingLookback: Math.max(
                2,
                Math.round((structureMin / entryMin) * structureBars),
              ),
              expiryBars: 0,
              extension: 0,
              atrBuffer: 0.1,
              minNetRr: 0,
            };
            const train = runR27(p, cfg, 0, t1).stats;
            const validation = runR27(p, cfg, t1, t2).stats;
            const qualified = passR27(train) && passR27(validation);
            rows.push({
              cfg,
              train,
              validation,
              qualified,
              score:
                scoreR27(train) +
                scoreR27(validation) * 1.5 +
                (qualified ? 10000 : 0),
            });
          }
          prepared++;
          if (prepared % 25 === 0)
            console.log("R30_PROGRESS", prepared, rows.length);
        }
    }
  rows.sort((a, b) => b.score - a.score);
  const frequencyEligible = rows.filter(
    (x) => x.train.tradesPerDay >= 10 && x.validation.tradesPerDay >= 10,
  );
  const best = frequencyEligible[0] ?? rows[0];
  const p = prepareR30(
    base,
    best.cfg.entryMin,
    best.cfg.trendMin,
    best.cfg.ema150Min,
    best.cfg.volumeMin,
  );
  const t2 = Math.floor(p.bars.length * 0.75);
  const blind = runR27(p, best.cfg, t2, p.bars.length, true);
  const survived = best.qualified && passR27(blind.stats);
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    "artifacts/r30-timeframe-combinations.json",
    JSON.stringify(
      {
        testedConfigurations: rows.length,
        config: best.cfg,
        summary: blind.stats,
        trades: blind.trades,
        top20: rows.slice(0, 20),
      },
      null,
      2,
    ),
  );
  console.log("R30_TOP10", JSON.stringify(rows.slice(0, 10)));
  console.log(
    "R30_RESULT",
    JSON.stringify({
      symbol: SYMBOL,
      days: DAYS,
      selection: "TRAIN_AND_VALIDATION_ONLY_BLIND_TEST",
      entryExecution: "MARKET_AT_NEXT_SIGNAL_BAR_OPEN",
      framesTested: {
        emaCross: entryFrames,
        ema150: ema150Frames,
        volume: volumeFrames,
        structure: structureFrames,
        higherTrend: trendFrames,
      },
      fixed: { volumeMultiplier: 1.2, structureBars: 10, atrBuffer: 0.1 },
      testedConfigurations: rows.length,
      frequencyEligibleConfigurations: frequencyEligible.length,
      requirements: {
        winRateMin: 65,
        tradesPerDayMin: 10,
        pfMin: 1.2,
        testTradesMin: 120,
      },
      config: best.cfg,
      train: best.train,
      validation: best.validation,
      test: blind.stats,
      qualifiedConfigurations: rows.filter((x) => x.qualified).length,
      survived,
      auditFile: "artifacts/r30-timeframe-combinations.json",
    }),
  );
}

mainR30().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
