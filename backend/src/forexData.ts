import type { Candle } from './analysis.js';
import type { TwelveDataCredentials } from './integrationVault.js';

interface TwelveDataValue {
  datetime: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume?: string;
}

interface TwelveDataResponse {
  status?: string;
  code?: number;
  message?: string;
  meta?: Record<string, unknown>;
  values?: TwelveDataValue[];
}

export interface ForexDataUsage {
  creditsUsed?: number;
  creditsLeft?: number;
}

export class ForexDataClient {
  private readonly baseUrl = 'https://api.twelvedata.com';
  private usage: ForexDataUsage = {};

  constructor(private readonly credentialProvider?: () => TwelveDataCredentials | null) {}

  hasCredentials(): boolean {
    return Boolean(this.credentialProvider?.()?.apiKey);
  }

  getUsage(): ForexDataUsage {
    return { ...this.usage };
  }

  async testConnection(): Promise<{ ok: true; provider: 'TWELVE_DATA'; symbol: string; lastPrice: number; usage: ForexDataUsage }> {
    const candles = await this.getRates('EURUSD', '1min', 2);
    const last = candles.at(-1);
    if (!last) throw new Error('TWELVE_DATA_NO_FOREX_DATA');
    return {
      ok: true,
      provider: 'TWELVE_DATA',
      symbol: 'EUR/USD',
      lastPrice: last.close,
      usage: this.getUsage(),
    };
  }

  async dualRates(symbol: string): Promise<{ ltf: Candle[]; htf: Candle[] }> {
    const [ltf, htf] = await Promise.all([
      this.getRates(symbol, '1min', 220),
      this.getRates(symbol, '15min', 260),
    ]);
    return { ltf, htf };
  }

  async getRates(symbol: string, interval: '1min' | '5min' | '15min' | '1h', outputsize: number): Promise<Candle[]> {
    const credentials = this.credentialProvider?.();
    if (!credentials?.apiKey) throw new Error('TWELVE_DATA_API_KEY_NOT_CONFIGURED');

    const params = new URLSearchParams({
      symbol: toTwelveDataSymbol(symbol),
      interval,
      outputsize: String(Math.max(1, Math.min(5000, outputsize))),
      timezone: 'UTC',
      apikey: credentials.apiKey,
    });

    const response = await fetch(`${this.baseUrl}/time_series?${params.toString()}`);
    this.captureUsage(response);
    const text = await response.text();
    let data: TwelveDataResponse;
    try {
      data = JSON.parse(text) as TwelveDataResponse;
    } catch {
      throw new Error(`TWELVE_DATA_INVALID_JSON:${text.slice(0, 160)}`);
    }

    if (!response.ok || data.status === 'error' || !Array.isArray(data.values)) {
      throw new Error(`TWELVE_DATA_${data.code ?? response.status}:${data.message ?? 'NO_VALUES'}`);
    }

    return data.values
      .map((row) => ({
        time: parseUtc(row.datetime),
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        // Spot-FX responses may not contain meaningful volume. Use a neutral constant
        // so the strategy cannot falsely award a volume-spike confirmation from 0 >= 0.
        volume: row.volume == null ? 1 : Math.max(1, Number(row.volume) || 1),
      }))
      .filter((row) =>
        Number.isFinite(row.time) && Number.isFinite(row.open) && Number.isFinite(row.high) &&
        Number.isFinite(row.low) && Number.isFinite(row.close) && row.close > 0,
      )
      .sort((a, b) => a.time - b.time);
  }

  private captureUsage(response: Response): void {
    const used = response.headers.get('api-credits-used');
    const left = response.headers.get('api-credits-left');
    this.usage = {
      creditsUsed: used == null ? this.usage.creditsUsed : Number(used),
      creditsLeft: left == null ? this.usage.creditsLeft : Number(left),
    };
  }
}

export function toTwelveDataSymbol(symbol: string): string {
  const clean = symbol.trim().toUpperCase().replace(/\s+/g, '');
  if (/^[A-Z]{3}\/[A-Z]{3}$/.test(clean)) return clean;
  if (/^[A-Z]{6}$/.test(clean)) return `${clean.slice(0, 3)}/${clean.slice(3)}`;
  throw new Error(`FOREX_SYMBOL_FORMAT_INVALID:${symbol}`);
}

function parseUtc(value: string): number {
  if (!value) return NaN;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    return Date.parse(`${value.replace(' ', 'T')}Z`);
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}
