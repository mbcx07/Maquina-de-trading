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
  private cooldownUntil = 0;
  private exchangeInfoCache: { at: number; symbols: string[] } | null = null;
  private tickerCache: { at: number; rows: BinanceTicker24h[] } | null = null;

  constructor(private readonly getSettings: () => EngineSettings) {}

  private baseUrl(): string {
    return this.getSettings().appMode === 'TESTNET'
      ? env.BINANCE_TESTNET_BASE_URL
      : env.BINANCE_BASE_URL;
  }

  private async getJson<T>(path: string): Promise<T> {
    const now = Date.now();
    if (now < this.cooldownUntil) {
      const seconds = Math.ceil((this.cooldownUntil - now) / 1000);
      throw new Error(`BINANCE_RATE_LIMIT_COOLDOWN:${seconds}s`);
    }

    const response = await fetch(`${this.baseUrl()}${path}`);
    if (!response.ok) {
      if (response.status === 418 || response.status === 429) {
        const retryRaw = response.headers.get('retry-after');
        const retrySeconds = Math.max(
          response.status === 418 ? 15 * 60 : 60,
          Number.isFinite(Number(retryRaw)) ? Number(retryRaw) : 0,
        );
        this.cooldownUntil = Date.now() + retrySeconds * 1000;
        throw new Error(`BINANCE_RATE_LIMIT_HTTP_${response.status}:RETRY_AFTER_${retrySeconds}s:${path}`);
      }
      throw new Error(`BINANCE_MARKET_HTTP_${response.status}:${path}`);
    }
    return await response.json() as T;
  }

  async getTradableUsdtPerpetualSymbols(): Promise<string[]> {
    if (this.exchangeInfoCache && Date.now() - this.exchangeInfoCache.at < 10 * 60_000) {
      return [...this.exchangeInfoCache.symbols];
    }
    const data = await this.getJson<{ symbols: any[] }>('/fapi/v1/exchangeInfo');
    const symbols = (data.symbols ?? [])
      .filter((symbol) => symbol.contractType === 'PERPETUAL' && symbol.status === 'TRADING' && symbol.quoteAsset === 'USDT')
      .map((symbol) => String(symbol.symbol))
      .sort();
    this.exchangeInfoCache = { at: Date.now(), symbols };
    return [...symbols];
  }

  async getTicker24h(): Promise<BinanceTicker24h[]> {
    if (this.tickerCache && Date.now() - this.tickerCache.at < 30_000) return [...this.tickerCache.rows];
    const data = await this.getJson<any[]>('/fapi/v1/ticker/24hr');
    const rows = (Array.isArray(data) ? data : []).map((item) => ({
      symbol: String(item.symbol),
      lastPrice: Number(item.lastPrice ?? 0),
      quoteVolume: Number(item.quoteVolume ?? 0),
      priceChangePercent: Number(item.priceChangePercent ?? 0),
    }));
    this.tickerCache = { at: Date.now(), rows };
    return [...rows];
  }

  async getKlines(symbol: string, interval: BinanceInterval, limit: number): Promise<Candle[]> {
    const rows = await this.getJson<any[]>(
      `/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${Math.max(1, Math.min(1000, limit))}`,
    );
    return mapKlines(rows);
  }

  async getMarkPrice(symbol: string): Promise<number> {
    const row = await this.getJson<{ markPrice?: string | number }>(
      `/fapi/v1/premiumIndex?symbol=${encodeURIComponent(symbol)}`,
    );
    const mark = Number(row.markPrice ?? 0);
    if (!Number.isFinite(mark) || mark <= 0) throw new Error(`BINANCE_MARK_PRICE_INVALID:${symbol}`);
    return mark;
  }

  async getMarkPriceKlines(symbol: string, interval: BinanceInterval, limit: number): Promise<Candle[]> {
    const rows = await this.getJson<any[]>(
      `/fapi/v1/markPriceKlines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${Math.max(1, Math.min(1000, limit))}`,
    );
    return mapKlines(rows);
  }

  async getKlinesRange(symbol: string, interval: BinanceInterval, startTime: number, endTime: number): Promise<Candle[]> {
    return this.getRange('/fapi/v1/klines', symbol, interval, startTime, endTime);
  }

  async getMarkPriceKlinesRange(symbol: string, interval: BinanceInterval, startTime: number, endTime: number): Promise<Candle[]> {
    return this.getRange('/fapi/v1/markPriceKlines', symbol, interval, startTime, endTime);
  }

  private async getRange(
    endpoint: '/fapi/v1/klines' | '/fapi/v1/markPriceKlines',
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
    const pageLimit = 1000;

    while (cursor <= endTime) {
      const rows = await this.getJson<any[]>(
        `${endpoint}?symbol=${encodeURIComponent(symbol)}&interval=${interval}&startTime=${Math.floor(cursor)}&endTime=${Math.floor(endTime)}&limit=${pageLimit}`,
      );
      const batch = mapKlines(rows).filter((candle) => candle.time >= startTime && candle.time <= endTime);
      if (!batch.length) break;
      output.push(...batch);
      const next = batch.at(-1)!.time + intervalMs;
      if (next <= cursor) break;
      cursor = next;
      calls++;
      if (calls > 500) throw new Error('BINANCE_HISTORY_PAGINATION_GUARD');
      if (rows.length < pageLimit) break;

      // Historical universe audits are intentionally much slower than live scanning.
      // This leaves substantial request-weight headroom for reconciliation/execution.
      await sleep(550);
    }

    return dedupeCandles(output);
  }

  /**
   * Decision data for the trading strategy.
   * M5 is the entry/structure timeframe; M15 is the independent trend filter.
   * The currently-forming candle is excluded so the signal is based on closed bars.
   */
  async getDualKlines(symbol: string): Promise<{ ltf: Candle[]; htf: Candle[] }> {
    const [ltfRaw, htfRaw] = await Promise.all([
      this.getKlines(symbol, '5m', 101),
      this.getKlines(symbol, '15m', 211),
    ]);
    return {
      ltf: closedCandles(ltfRaw, 5 * 60_000, 100),
      htf: closedCandles(htfRaw, 15 * 60_000, 210),
    };
  }

  async getDualHistoricalRange(symbol: string, startTime: number, endTime: number): Promise<{ ltf: Candle[]; htf: Candle[] }> {
    const warmupStart = startTime - 15 * 60_000 * 210;
    // Sequential on purpose: a full-universe audit must not burst two paginated
    // historical streams from the same IP at the same time.
    const ltf = await this.getKlinesRange(symbol, '5m', Math.max(0, warmupStart), endTime);
    await sleep(750);
    const htf = await this.getKlinesRange(symbol, '15m', Math.max(0, warmupStart), endTime);
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
    volume: Number(row[5] ?? 0),
  })).filter((candle) => Number.isFinite(candle.time) && Number.isFinite(candle.close));
}

function intervalToMs(interval: BinanceInterval): number {
  if (interval === '1m') return 60_000;
  if (interval === '5m') return 5 * 60_000;
  if (interval === '15m') return 15 * 60_000;
  return 60 * 60_000;
}

function closedCandles(candles: Candle[], intervalMs: number, limit: number): Candle[] {
  const now = Date.now();
  return candles
    .filter((candle) => candle.time + intervalMs <= now)
    .slice(-limit);
}

function dedupeCandles(candles: Candle[]): Candle[] {
  const map = new Map<number, Candle>();
  for (const candle of candles) map.set(candle.time, candle);
  return [...map.values()].sort((a, b) => a.time - b.time);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
