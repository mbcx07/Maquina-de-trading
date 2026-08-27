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

interface SymbolSearchItem {
  symbol?: string;
  instrument_name?: string;
  exchange?: string;
  instrument_type?: string;
  country?: string;
}

interface SymbolSearchResponse {
  status?: string;
  code?: number;
  message?: string;
  data?: SymbolSearchItem[];
  values?: SymbolSearchItem[];
}

export interface ForexDataUsage {
  creditsUsed?: number;
  creditsLeft?: number;
  lastHttpStatus?: number;
  lastRequestAt?: number;
  quotaMessage?: string;
}

export interface DualRatesResult {
  ltf: Candle[];
  htf: Candle[];
  dataSymbol: string;
}

const SYMBOL_ALIASES: Record<string, string> = {
  NAS100: 'NASDAQ 100',
  US100: 'NASDAQ 100',
  SPX500: 'S&P 500',
  US500: 'S&P 500',
  US30: 'Dow Jones Industrial Average',
  DAX40: 'DAX 40',
};

export class ForexDataClient {
  private readonly baseUrl = 'https://api.twelvedata.com';
  private usage: ForexDataUsage = {};
  private readonly resolvedSymbols = new Map<string, string>();

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

  async dualRates(symbol: string): Promise<DualRatesResult> {
    const dataSymbol = await this.resolveDataSymbol(symbol);
    await this.waitForCreditCapacity(2);

    // Match the original v33.5 decision windows exactly so EMA state, trend and
    // structural levels are calculated from the same amount of history.
    const [ltf, htf] = await Promise.all([
      this.getRatesResolved(dataSymbol, '1min', 100),
      this.getRatesResolved(dataSymbol, '15min', 210),
    ]);
    return { ltf, htf, dataSymbol };
  }

  async getRates(symbol: string, interval: '1min' | '5min' | '15min' | '1h', outputsize: number): Promise<Candle[]> {
    const dataSymbol = await this.resolveDataSymbol(symbol);
    await this.waitForCreditCapacity(1);
    return this.getRatesResolved(dataSymbol, interval, outputsize);
  }

  async resolveDataSymbol(symbol: string): Promise<string> {
    const clean = normalizeInputSymbol(symbol);
    const cached = this.resolvedSymbols.get(clean);
    if (cached) return cached;

    // Physical FX and spot metals use slash notation in Twelve Data.
    if (/^[A-Z]{3}\/[A-Z]{3}$/.test(clean)) {
      this.resolvedSymbols.set(clean, clean);
      return clean;
    }
    if (/^[A-Z]{6}$/.test(clean)) {
      const slash = `${clean.slice(0, 3)}/${clean.slice(3)}`;
      this.resolvedSymbols.set(clean, slash);
      return slash;
    }

    // Common broker aliases (NAS100, US500, US30...) are not guaranteed to be the
    // provider ticker. Resolve them through Twelve Data reference search once and cache.
    const searchTerm = SYMBOL_ALIASES[clean];
    if (searchTerm) {
      const resolved = await this.searchProviderSymbol(searchTerm, clean);
      this.resolvedSymbols.set(clean, resolved);
      return resolved;
    }

    // Allow explicit provider tickers such as QQQ/NDX without pretending they are FX pairs.
    if (/^[A-Z0-9.^:_-]{1,24}$/.test(clean)) {
      this.resolvedSymbols.set(clean, clean);
      return clean;
    }

    throw new Error(`TWELVE_DATA_SYMBOL_FORMAT_INVALID:${symbol}`);
  }

  async waitForCreditCapacity(required: number): Promise<void> {
    const left = this.usage.creditsLeft;
    if (left == null || !Number.isFinite(left) || left >= required) return;

    // Basic plan has a minute quota. Respect the server-reported credits instead of
    // hammering the endpoint into repeated 429 DATA_ERROR cycles.
    const now = new Date();
    const msToNextMinute = (60 - now.getUTCSeconds()) * 1000 - now.getUTCMilliseconds() + 1200;
    await sleep(Math.max(1200, Math.min(61_500, msToNextMinute)));
    this.usage = { ...this.usage, creditsUsed: undefined, creditsLeft: undefined };
  }

  private async searchProviderSymbol(query: string, alias: string): Promise<string> {
    const credentials = this.credentials();
    const params = new URLSearchParams({
      symbol: query,
      outputsize: '20',
      apikey: credentials.apiKey,
    });
    const response = await fetch(`${this.baseUrl}/symbol_search?${params.toString()}`);
    this.captureUsage(response);
    const text = await response.text();
    let data: SymbolSearchResponse;
    try { data = JSON.parse(text) as SymbolSearchResponse; }
    catch { throw new Error(`TWELVE_DATA_SYMBOL_SEARCH_INVALID_JSON:${alias}:${text.slice(0, 120)}`); }

    if (!response.ok || data.status === 'error') {
      throw this.apiError(response.status, data.code, data.message, `SYMBOL_SEARCH:${alias}`);
    }

    const items = Array.isArray(data.data) ? data.data : Array.isArray(data.values) ? data.values : [];
    const ranked = items
      .filter((item) => Boolean(item.symbol))
      .sort((a, b) => symbolSearchScore(b, query) - symbolSearchScore(a, query));
    const best = ranked[0]?.symbol?.trim();
    if (!best) throw new Error(`TWELVE_DATA_SYMBOL_NOT_FOUND:${alias}`);
    return best;
  }

  private async getRatesResolved(dataSymbol: string, interval: '1min' | '5min' | '15min' | '1h', outputsize: number): Promise<Candle[]> {
    const credentials = this.credentials();
    const params = new URLSearchParams({
      symbol: dataSymbol,
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
      throw new Error(`TWELVE_DATA_INVALID_JSON:${dataSymbol}:${text.slice(0, 160)}`);
    }

    if (!response.ok || data.status === 'error' || !Array.isArray(data.values)) {
      throw this.apiError(response.status, data.code, data.message ?? 'NO_VALUES', `${dataSymbol}:${interval}`);
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

  private apiError(httpStatus: number, code?: number, message?: string, context?: string): Error {
    const effective = Number(code ?? httpStatus);
    const detail = String(message ?? 'UNKNOWN_ERROR').replace(/\s+/g, ' ').slice(0, 220);
    if (httpStatus === 429 || effective === 429) {
      this.usage = { ...this.usage, quotaMessage: detail };
      return new Error(`TWELVE_DATA_RATE_LIMIT_OR_DAILY_QUOTA:${context ?? ''}:${detail}`);
    }
    if (httpStatus === 401 || httpStatus === 403) {
      return new Error(`TWELVE_DATA_PLAN_OR_AUTH:${context ?? ''}:${detail}`);
    }
    return new Error(`TWELVE_DATA_${effective}:${context ?? ''}:${detail}`);
  }

  private captureUsage(response: Response): void {
    const used = response.headers.get('api-credits-used');
    const left = response.headers.get('api-credits-left');
    this.usage = {
      ...this.usage,
      creditsUsed: used == null ? this.usage.creditsUsed : Number(used),
      creditsLeft: left == null ? this.usage.creditsLeft : Number(left),
      lastHttpStatus: response.status,
      lastRequestAt: Date.now(),
    };
  }

  private credentials(): TwelveDataCredentials {
    const credentials = this.credentialProvider?.();
    if (!credentials?.apiKey) throw new Error('TWELVE_DATA_API_KEY_NOT_CONFIGURED');
    return credentials;
  }
}

export function toTwelveDataSymbol(symbol: string): string {
  const clean = normalizeInputSymbol(symbol);
  if (/^[A-Z]{3}\/[A-Z]{3}$/.test(clean)) return clean;
  if (/^[A-Z]{6}$/.test(clean)) return `${clean.slice(0, 3)}/${clean.slice(3)}`;
  if (/^[A-Z0-9.^:_-]{1,24}$/.test(clean)) return clean;
  throw new Error(`TWELVE_DATA_SYMBOL_FORMAT_INVALID:${symbol}`);
}

function normalizeInputSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/\s+/g, '');
}

function symbolSearchScore(item: SymbolSearchItem, query: string): number {
  const name = String(item.instrument_name ?? '').toUpperCase();
  const type = String(item.instrument_type ?? '').toUpperCase();
  const symbol = String(item.symbol ?? '').toUpperCase();
  const q = query.toUpperCase();
  let score = 0;
  if (name === q) score += 100;
  if (name.includes(q)) score += 50;
  if (symbol.includes('NDX') && q.includes('NASDAQ')) score += 45;
  if (type.includes('INDEX')) score += 30;
  if (type.includes('ETF')) score -= 10;
  return score;
}

function parseUtc(value: string): number {
  if (!value) return NaN;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    return Date.parse(`${value.replace(' ', 'T')}Z`);
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
