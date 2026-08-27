export interface BinanceResponse {
  success: boolean;
  data?: any;
  error?: any;
}

/**
 * V34 SECURITY BOUNDARY
 * ---------------------
 * This legacy frontend service is retained only so old analysis modules can
 * compile while the scanner is migrated to the backend. It contains NO API
 * key/secret and MUST NOT execute authenticated account or trade operations.
 *
 * All signed Binance activity belongs in backend/src/binance.ts.
 */
export class BinanceService {
  public restBase = 'https://fapi.binance.com';
  public isReady = false;
  public lastNetworkError = '';
  public activeProxyName = 'PUBLIC-MARKET-DATA';
  private symbolInfo: Map<string, any> = new Map();

  constructor() {
    void this.fetchExchangeInfo();
  }

  public async robustFetch(url: string, options: RequestInit = {}): Promise<any> {
    const method = String(options.method || 'GET').toUpperCase();
    if (method !== 'GET') {
      throw new Error('V34_FRONTEND_MUTATIONS_DISABLED');
    }

    const parsed = new URL(url);
    if (parsed.origin !== 'https://fapi.binance.com') {
      throw new Error('V34_FRONTEND_ONLY_BINANCE_PUBLIC_DATA');
    }

    const response = await fetch(url, { method: 'GET' });
    if (!response.ok) throw new Error(`BINANCE_PUBLIC_HTTP_${response.status}`);
    const data = await response.json();
    this.isReady = true;
    return data;
  }

  public async syncTime(): Promise<void> {
    await this.robustFetch(`${this.restBase}/fapi/v1/time`);
  }

  public async fetchExchangeInfo(): Promise<void> {
    try {
      const data = await this.robustFetch(`${this.restBase}/fapi/v1/exchangeInfo`);
      this.symbolInfo.clear();
      for (const symbol of data?.symbols || []) {
        if (symbol.contractType === 'PERPETUAL' && symbol.status === 'TRADING' && symbol.quoteAsset === 'USDT') {
          this.symbolInfo.set(symbol.symbol, symbol);
        }
      }
    } catch (error: any) {
      this.lastNetworkError = error?.message || String(error);
    }
  }

  public async getAllPrices(): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    const data = await this.robustFetch(`${this.restBase}/fapi/v1/ticker/price`);
    if (Array.isArray(data)) {
      for (const item of data) {
        if (item.symbol?.endsWith('USDT')) map.set(item.symbol, Number(item.price));
      }
    }
    return map;
  }

  public async getTicker24h(): Promise<any[]> {
    const data = await this.robustFetch(`${this.restBase}/fapi/v1/ticker/24hr`);
    return Array.isArray(data) ? data : [];
  }

  public formatQuantity(symbol: string, quantity: number): string {
    const info = this.symbolInfo.get(symbol);
    if (!info) return quantity.toFixed(3);
    const filter = info.filters?.find((f: any) => f.filterType === 'MARKET_LOT_SIZE')
      ?? info.filters?.find((f: any) => f.filterType === 'LOT_SIZE');
    const step = Number(filter?.stepSize || 0.001);
    const precision = Math.max(0, Math.round(-Math.log10(step)));
    return (Math.floor(quantity / step) * step).toFixed(precision);
  }

  public formatPrice(symbol: string, price: number): string {
    const info = this.symbolInfo.get(symbol);
    if (!info) return price.toFixed(4);
    const filter = info.filters?.find((f: any) => f.filterType === 'PRICE_FILTER');
    const tick = Number(filter?.tickSize || 0.0001);
    const precision = Math.max(0, Math.round(-Math.log10(tick)));
    return (Math.round(price / tick) * tick).toFixed(precision);
  }

  private disabled(): never {
    throw new Error('V34_FRONTEND_EXECUTION_DISABLED_USE_BACKEND');
  }

  public async getLeverageBrackets(_symbol: string): Promise<number> { return this.disabled(); }
  public async setLeverage(_symbol: string, _leverage: number): Promise<number> { return this.disabled(); }
  public async getOpenPositions(): Promise<any[]> { return this.disabled(); }
  public async getAvailableBalance(): Promise<number> { return this.disabled(); }
  public async getUserTrades(_symbol: string): Promise<any[]> { return this.disabled(); }
  public async closePosition(_symbol: string, _side: 'BUY' | 'SELL', _amount: string): Promise<BinanceResponse> { return this.disabled(); }
  public async createOrder(_symbol: string, _side: 'BUY' | 'SELL', _quantity: string): Promise<BinanceResponse> { return this.disabled(); }
  public async setNativeExit(_symbol: string, _side: 'BUY' | 'SELL', _price: number, _type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET'): Promise<BinanceResponse> { return this.disabled(); }
  public async signedRequest(_endpoint: string, _method: 'GET' | 'POST' | 'DELETE', _params: any = {}): Promise<BinanceResponse> { return this.disabled(); }
}

export const binanceService = new BinanceService();
