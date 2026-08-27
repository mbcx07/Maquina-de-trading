import { env } from './config.js';
import type { Candle } from './analysis.js';
import type { EngineSettings } from './types.js';

export interface BinanceTicker24h {
  symbol: string;
  lastPrice: number;
  quoteVolume: number;
  priceChangePercent: number;
}

export type BinanceInterval = '1m' | '5m' | '15m' | '1h';

export class BinanceMarketDataClient {
  constructor(private readonly getSettings: () => EngineSettings) {}

  private baseUrl(): string {
    return this.getSettings().appMode === 'TESTNET'
      ? env.BINANCE_TESTNET_BASE_URL
      : env.BINANCE_BASE_URL;
  }

  private async getJson<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl()}${path}`);
    if (!response.ok) throw new Error(`BINANCE_MARKET_HTTP_${response.status}:${path}`);
    return await response.json() as T;
  }

  async getTradableUsdtPerpetualSymbols(): Promise<string[]> {
    const data = await this.getJson<{ symbols: any[] }>('/fapi/v1/exchangeInfo');
    return (data.symbols ?? [])
      .filter((symbol) =>
        symbol.contractType === 'PERPETUAL' &&
        symbol.status === 'TRADING' &&
        symbol.quoteAsset === 'USDT',
      )
      .map((symbol) => String(symbol.symbol))
      .sort();
  }

  async getTicker24h(): Promise<BinanceTicker24h[]> {
    const data = await this.getJson<any[]>('/fapi/v1/ticker/24hr');
    return (Array.isArray(data) ? data : []).map((item) => ({
      symbol: String(item.symbol),
      lastPrice: Number(item.lastPrice ?? 0),
      quoteVolume: Number(item.quoteVolume ?? 0),
      priceChangePercent: Number(item.priceChangePercent ?? 0),
    }));
  }

  async getKlines(symbol: string, interval: BinanceInterval, limit: number): Promise<Candle[]> {
    const rows = await this.getJson<any[]>(
      `/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${Math.max(1, Math.min(1500, limit))}`,
    );
    return mapKlines(rows);
  }

  async getKlinesRange(
    symbol: string,
    interval: BinanceInterval,
    startTime: number,
    endTime: number,
  ): Promise<Candle[]> {
    if (endTime <= startTime) throw new Error('BINANCE_HISTORY_INVALID_RANGE');
    const intervalMs = intervalToMs(interval);
    const output: Candle[] = [];
    let cursor = startTime;
    let calls = 0;

    while (cursor <= endTime) {
      const rows = await this.getJson<any[]>(
        `/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&startTime=${Math.floor(cursor)}&endTime=${Math.floor(endTime)}&limit=1500`,
      );
      const batch = mapKlines(rows).filter((candle) => candle.time >= startTime && candle.time <= endTime);
      if (!batch.length) break;
      output.push(...batch);
      const lastTime = batch.at(-1)!.time;
      const next = lastTime + intervalMs;
      if (next <= cursor) break;
      cursor = next;
      calls++;
      if (calls > 500) throw new Error('BINANCE_HISTORY_PAGINATION_GUARD');
      if (rows.length < 1500) break;
      await sleep(80);
    }

    return dedupeCandles(output);
  }

  async getDualKlines(symbol: string): Promise<{ ltf: Candle[]; htf: Candle[] }> {
    const [ltf, htf] = await Promise.all([
      this.getKlines(symbol, '1m', 220),
      this.getKlines(symbol, '15m', 260),
    ]);
    return { ltf, htf };
  }

  async getDualHistoricalRange(
    symbol: string,
    startTime: number,
    endTime: number,
  ): Promise<{ ltf: Candle[]; htf: Candle[] }> {
    // Warm-up provides enough prior bars for EMA200 on the 15m structure filter.
    const warmupStart = startTime - 15 * 60_000 * 260;
    const [ltf, htf] = await Promise.all([
      this.getKlinesRange(symbol, '1m', Math.max(0, warmupStart), endTime),
      this.getKlinesRange(symbol, '15m', Math.max(0, warmupStart), endTime),
    ]);
    return { ltf, htf };
  }
}

function mapKlines(rows: any[]): Candle[] {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    time: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
  })).filter((candle) => Number.isFinite(candle.time) && Number.isFinite(candle.close));
}

function intervalToMs(interval: BinanceInterval): number {
  if (interval === '1m') return 60_000;
  if (interval === '5m') return 5 * 60_000;
  if (interval === '15m') return 15 * 60_000;
  return 60 * 60_000;
}

function dedupeCandles(candles: Candle[]): Candle[] {
  const map = new Map<number, Candle>();
  for (const candle of candles) map.set(candle.time, candle);
  return [...map.values()].sort((a, b) => a.time - b.time);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
