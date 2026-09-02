import { env } from './config.js';
import type { AsterV3Client } from './aster.js';
import { runHistoricalBacktestR15, type CommodityCandleR15, type CommodityKindR15, type CrudeSideModeR15, type HistoricalBacktestResultR15 } from './commodityStrategyR15.js';

const MINUTE = 60_000;
const DAY = 86_400_000;

export interface CommodityBacktestStateR15 {
  status: 'IDLE' | 'RUNNING' | 'COMPLETED' | 'ERROR';
  kind: CommodityKindR15;
  requestedDays: number | 'MAX';
  startedAt?: number;
  completedAt?: number;
  progress?: { pages: number; candles: number; from?: number; to?: number };
  result?: HistoricalBacktestResultR15;
  error?: string;
}

export class CommodityBacktestR15 {
  private states = new Map<CommodityKindR15, CommodityBacktestStateR15>();
  private running = new Set<CommodityKindR15>();

  constructor(private readonly aster: AsterV3Client) {}

  getState(kind: CommodityKindR15): CommodityBacktestStateR15 {
    return this.states.get(kind) ?? { status: 'IDLE', kind, requestedDays: 30 };
  }

  run(input: {
    kind: CommodityKindR15;
    days: number | 'MAX';
    crudeSideMode: CrudeSideModeR15;
    assumedSpreadPct: number;
    leverage: number;
  }): CommodityBacktestStateR15 {
    if (this.running.has(input.kind)) return this.getState(input.kind);
    const requestedDays = input.days === 'MAX' ? 'MAX' : Math.max(7, Math.min(env.COMMODITY_BACKTEST_MAX_DAYS, Math.floor(input.days)));
    const state: CommodityBacktestStateR15 = { status: 'RUNNING', kind: input.kind, requestedDays, startedAt: Date.now(), progress: { pages: 0, candles: 0 } };
    this.states.set(input.kind, state);
    this.running.add(input.kind);
    void this.execute({ ...input, days: requestedDays }).finally(() => this.running.delete(input.kind));
    return state;
  }

  private async execute(input: {
    kind: CommodityKindR15;
    days: number | 'MAX';
    crudeSideMode: CrudeSideModeR15;
    assumedSpreadPct: number;
    leverage: number;
  }): Promise<void> {
    try {
      const days = input.days === 'MAX' ? env.COMMODITY_BACKTEST_MAX_DAYS : input.days;
      const endTime = Date.now() - MINUTE;
      const startTime = endTime - days * DAY;
      const symbol = input.kind === 'XAU' ? 'XAUUSDT' : 'CLUSDT';
      const candles = input.kind === 'XAU'
        ? await this.fetchBinance(symbol, startTime, endTime, input.kind)
        : await this.fetchAster(symbol, startTime, endTime, input.kind);
      if (candles.length < 120) throw new Error(`BACKTEST_INSUFFICIENT_HISTORY:${symbol}:${candles.length}`);

      const feePct = input.kind === 'XAU' ? env.COMMODITY_TAKER_FEE_PCT_BINANCE : env.COMMODITY_TAKER_FEE_PCT_ASTER;
      const result = runHistoricalBacktestR15({
        kind: input.kind,
        candles,
        sideMode: input.crudeSideMode,
        assumedSpreadPct: Math.max(0, input.assumedSpreadPct),
        feePct,
        slippagePct: env.COMMODITY_SLIPPAGE_PCT,
        leverage: Math.max(1, input.leverage),
        initialBalance: env.COMMODITY_PAPER_INITIAL_BALANCE,
        marginPctPerTrade: env.COMMODITY_MARGIN_PCT,
        maxHoldSeconds: env.COMMODITY_MAX_HOLD_SECONDS,
      });
      this.states.set(input.kind, {
        status: 'COMPLETED',
        kind: input.kind,
        requestedDays: input.days,
        startedAt: this.getState(input.kind).startedAt,
        completedAt: Date.now(),
        progress: { pages: this.getState(input.kind).progress?.pages ?? 0, candles: candles.length, from: candles[0]?.time, to: candles.at(-1)?.time },
        result,
      });
    } catch (error) {
      this.states.set(input.kind, {
        status: 'ERROR',
        kind: input.kind,
        requestedDays: input.days,
        startedAt: this.getState(input.kind).startedAt,
        completedAt: Date.now(),
        progress: this.getState(input.kind).progress,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async fetchBinance(symbol: string, startTime: number, endTime: number, kind: CommodityKindR15): Promise<CommodityCandleR15[]> {
    const output: CommodityCandleR15[] = [];
    let cursor = startTime;
    let pages = 0;
    let cooldownRetries = 0;
    while (cursor < endTime) {
      const response = await fetch(`${env.BINANCE_BASE_URL.replace(/\/$/, '')}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=1m&startTime=${Math.floor(cursor)}&endTime=${Math.floor(endTime)}&limit=1500`);
      if (response.status === 429 || response.status === 418) {
        if (++cooldownRetries > 5) throw new Error(`BINANCE_BACKTEST_RATE_LIMIT_RETRIES_EXHAUSTED:${response.status}:${symbol}`);
        const retryRaw = Number(response.headers.get('retry-after') ?? 0);
        const fallbackSeconds = response.status === 418 ? 900 : 60;
        const retrySeconds = Math.max(fallbackSeconds, Number.isFinite(retryRaw) ? retryRaw : 0);
        await sleep(retrySeconds * 1000);
        continue;
      }
      cooldownRetries = 0;
      if (!response.ok) throw new Error(`BINANCE_BACKTEST_HTTP_${response.status}:${symbol}`);
      const rows = await response.json() as any[];
      if (!Array.isArray(rows) || rows.length === 0) break;
      const batch = mapKlines(rows).filter((row) => row.time >= startTime && row.time <= endTime);
      output.push(...batch);
      const last = batch.at(-1)?.time;
      if (!last || last < cursor) break;
      cursor = last + MINUTE;
      pages++;
      this.updateProgress(kind, pages, output);
      if (rows.length < 1500) break;
      // Large 1m ranges can require hundreds of pages. Keep the backtest below the
      // normal USD-M request-weight envelope so it does not interfere with live scanning.
      await sleep(350);
    }
    return dedupe(output);
  }

  private async fetchAster(symbol: string, startTime: number, endTime: number, kind: CommodityKindR15): Promise<CommodityCandleR15[]> {
    const output: CommodityCandleR15[] = [];
    let cursor = startTime;
    let pages = 0;
    while (cursor < endTime) {
      const rows = await this.aster.publicRequest<any[]>('/fapi/v3/klines', {
        symbol,
        interval: '1m',
        startTime: Math.floor(cursor),
        endTime: Math.floor(endTime),
        limit: 1500,
      });
      if (!Array.isArray(rows) || rows.length === 0) break;
      const batch = mapKlines(rows).filter((row) => row.time >= startTime && row.time <= endTime);
      output.push(...batch);
      const last = batch.at(-1)?.time;
      if (!last || last < cursor) break;
      cursor = last + MINUTE;
      pages++;
      this.updateProgress(kind, pages, output);
      if (rows.length < 1500) break;
      await sleep(250);
    }
    return dedupe(output);
  }

  private updateProgress(kind: CommodityKindR15, pages: number, candles: CommodityCandleR15[]): void {
    const old = this.getState(kind);
    this.states.set(kind, {
      ...old,
      status: 'RUNNING',
      progress: {
        pages,
        candles: candles.length,
        from: candles[0]?.time,
        to: candles.at(-1)?.time,
      },
    });
  }
}

function mapKlines(rows: any[]): CommodityCandleR15[] {
  const now = Date.now();
  return rows
    .filter((row) => Number(row?.[6] ?? 0) <= now)
    .map((row) => ({
      time: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5] ?? 0),
    }))
    .filter((row) => Number.isFinite(row.time) && row.close > 0);
}

function dedupe(rows: CommodityCandleR15[]): CommodityCandleR15[] {
  const map = new Map<number, CommodityCandleR15>();
  for (const row of rows) map.set(row.time, row);
  return [...map.values()].sort((a, b) => a.time - b.time);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
