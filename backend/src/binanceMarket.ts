import { env } from './config.js';
import type { Candle } from './analysis.js';
import type { EngineSettings } from './types.js';

export interface BinanceTicker24h {
  symbol: string;
  lastPrice: number;
  quoteVolume: number;
  priceChangePercent: number;
}

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

  async getKlines(symbol: string, interval: '1m' | '15m', limit: number): Promise<Candle[]> {
    const rows = await this.getJson<any[]>(
      `/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`,
    );

    return (Array.isArray(rows) ? rows : []).map((row) => ({
      time: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
    }));
  }

  async getDualKlines(symbol: string): Promise<{ ltf: Candle[]; htf: Candle[] }> {
    const [ltf, htf] = await Promise.all([
      this.getKlines(symbol, '1m', 220),
      this.getKlines(symbol, '15m', 260),
    ]);
    return { ltf, htf };
  }
}
