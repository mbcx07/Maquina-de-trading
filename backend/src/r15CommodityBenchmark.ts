import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AsterV3Client } from './aster.js';
import { env } from './config.js';
import { runHistoricalBacktestR15, type CommodityCandleR15 } from './commodityStrategyR15.js';

const DAY = 86_400_000;
const MINUTE = 60_000;
const LOOKBACK_DAYS = 90;
const VISION = 'https://data.binance.vision/data/futures/um/daily/klines';

async function main() {
  const endDay = Math.floor((Date.now() - DAY) / DAY) * DAY;
  const endTime = endDay + DAY - 1;
  const startTime = endTime - LOOKBACK_DAYS * DAY;
  const temp = await mkdtemp(path.join(os.tmpdir(), 'r15-commodities-'));
  const aster = new AsterV3Client();

  const xau = await fetchVision('XAUUSDT', startTime, endTime, temp);
  const crude = await fetchAster(aster, 'CLUSDT', startTime, endTime);

  const xauResult = xau.length >= 120
    ? runHistoricalBacktestR15({
        kind: 'XAU', candles: xau, sideMode: 'BOTH', assumedSpreadPct: env.COMMODITY_MAX_SPREAD_PCT_XAU * 0.5,
        feePct: env.COMMODITY_TAKER_FEE_PCT_BINANCE, slippagePct: env.COMMODITY_SLIPPAGE_PCT,
        leverage: 10, initialBalance: 50, marginPctPerTrade: env.COMMODITY_MARGIN_PCT,
      })
    : null;
  const crudeResult = crude.length >= 120
    ? runHistoricalBacktestR15({
        kind: 'CRUDE', candles: crude, sideMode: 'BUY', assumedSpreadPct: env.COMMODITY_MAX_SPREAD_PCT_CL * 0.5,
        feePct: env.COMMODITY_TAKER_FEE_PCT_ASTER, slippagePct: env.COMMODITY_SLIPPAGE_PCT,
        leverage: 20, initialBalance: 50, marginPctPerTrade: env.COMMODITY_MARGIN_PCT,
      })
    : null;

  console.log('R15_BENCH_XAU', JSON.stringify(compact('XAUUSDT', xau, xauResult)));
  console.log('R15_BENCH_CRUDE', JSON.stringify(compact('CLUSDT', crude, crudeResult)));
}

function compact(symbol: string, candles: CommodityCandleR15[], result: ReturnType<typeof runHistoricalBacktestR15> | null) {
  return {
    symbol,
    candles: candles.length,
    from: candles[0]?.time ? new Date(candles[0].time).toISOString() : null,
    to: candles.at(-1)?.time ? new Date(candles.at(-1)!.time).toISOString() : null,
    daysCovered: result ? Number(result.daysCovered.toFixed(2)) : 0,
    trades: result?.trades ?? 0,
    winRate: result ? Number(result.winRate.toFixed(2)) : 0,
    profitFactor: result?.profitFactor == null ? result?.profitFactor ?? 0 : Number(result.profitFactor.toFixed(3)),
    netPnl: result ? Number(result.netPnl.toFixed(4)) : 0,
    returnPct: result ? Number(result.returnPct.toFixed(3)) : 0,
    finalBalance: result ? Number(result.finalBalance.toFixed(4)) : 50,
    maxDrawdownPct: result ? Number(result.maxDrawdownPct.toFixed(3)) : 0,
    model: result?.model ?? 'NO_HISTORY',
  };
}

async function fetchVision(symbol: string, startTime: number, endTime: number, dir: string): Promise<CommodityCandleR15[]> {
  const output: CommodityCandleR15[] = [];
  const startDay = Math.floor(startTime / DAY) * DAY;
  const endDay = Math.floor(endTime / DAY) * DAY;
  for (let cursor = startDay; cursor <= endDay; cursor += DAY) {
    const day = new Date(cursor).toISOString().slice(0, 10);
    const filename = `${symbol}-1m-${day}.zip`;
    const response = await fetch(`${VISION}/${symbol}/1m/${filename}`);
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(`VISION_${response.status}:${filename}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const file = path.join(dir, filename);
    await writeFile(file, bytes);
    const csv = execFileSync('unzip', ['-p', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    for (const line of csv.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const cols = line.split(',');
      const rawTime = Number(cols[0]);
      if (!Number.isFinite(rawTime)) continue;
      const time = normalizeEpoch(rawTime);
      const row = { time, open:Number(cols[1]), high:Number(cols[2]), low:Number(cols[3]), close:Number(cols[4]), volume:Number(cols[5] ?? 0) };
      if ([row.time,row.open,row.high,row.low,row.close].every(Number.isFinite) && row.time >= startTime && row.time <= endTime) output.push(row);
    }
  }
  return dedupe(output);
}

async function fetchAster(aster: AsterV3Client, symbol: string, startTime: number, endTime: number): Promise<CommodityCandleR15[]> {
  const output: CommodityCandleR15[] = [];
  let cursor = startTime;
  let guard = 0;
  while (cursor < endTime) {
    const rows = await aster.publicRequest<any[]>('/fapi/v3/klines', { symbol, interval:'1m', startTime:Math.floor(cursor), endTime:Math.floor(endTime), limit:1500 });
    if (!Array.isArray(rows) || !rows.length) break;
    const batch = rows.map((row)=>({time:Number(row[0]),open:Number(row[1]),high:Number(row[2]),low:Number(row[3]),close:Number(row[4]),volume:Number(row[5]??0)}))
      .filter((row)=>Number.isFinite(row.time)&&row.close>0&&row.time>=startTime&&row.time<=endTime);
    output.push(...batch);
    const last = batch.at(-1)?.time;
    if (!last || last < cursor) break;
    cursor = last + MINUTE;
    if (rows.length < 1500) break;
    if (++guard > 120) throw new Error('ASTER_BENCH_PAGINATION_GUARD');
    await sleep(140);
  }
  return dedupe(output);
}

function normalizeEpoch(value:number):number{if(value>1e17)return Math.floor(value/1_000_000);if(value>1e14)return Math.floor(value/1000);return value;}
function dedupe(rows:CommodityCandleR15[]){const map=new Map<number,CommodityCandleR15>();for(const row of rows)map.set(row.time,row);return [...map.values()].sort((a,b)=>a.time-b.time);}
function sleep(ms:number){return new Promise(resolve=>setTimeout(resolve,ms));}

main().catch((error)=>{console.error('R15_BENCH_ERROR',error instanceof Error?error.message:String(error));process.exit(1);});
