
import CryptoJS from 'crypto-js';

export interface BinanceResponse {
  success: boolean;
  data?: any;
  error?: any;
}

export class BinanceService {
  public restBase = 'https://fapi.binance.com';
  private apiKey = "iZi4935R3BaYaV9nWYRgdF7PFGTv8wVB2EwwoIQD4Bm0XGirFNhVTbxv7YTbiyRN";
  private apiSecret = "xWhQuqLClorGXFY8BcEbwAs8owbLfO3BEoXuKnE1zl1IRtQMP7WcO6UHSgqIq0yU";
  
  public isReady: boolean = false;
  public lastNetworkError: string = "";
  public activeProxyName: string = "APEX_INIT";
  private timeOffset: number = 0;
  private symbolInfo: Map<string, any> = new Map();
  private lastSyncTime = 0;

  constructor() {
    this.init();
  }

  private async init() {
    try {
      await this.syncTime();
      await this.fetchExchangeInfo();
      setInterval(() => {
        if (!this.isReady || Date.now() - this.lastSyncTime > 25000) {
          this.syncTime().catch(() => {});
        }
      }, 15000);
    } catch(e: any) {
      this.lastNetworkError = e.message;
    }
  }

  public async robustFetch(url: string, options: RequestInit = {}): Promise<any> {
    const isMutation = options.method === 'POST' || options.method === 'DELETE';
    
    const tunnels = [
      { name: 'NEXUS-V33', fn: (u: string) => `https://corsproxy.io/?${encodeURIComponent(u)}`, weight: 10 },
      { name: 'HYPER-NODE', fn: (u: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`, weight: 8 },
      { name: 'DIRECT-BRIDGE', fn: (u: string) => u, weight: 5 }
    ];

    let lastError = "";

    for (const tunnel of tunnels) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), isMutation ? 20000 : 10000);

        const res = await fetch(tunnel.fn(url), {
          ...options,
          signal: controller.signal,
          headers: { 
            'X-MBX-APIKEY': this.apiKey,
            ...(isMutation ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {})
          }
        });

        clearTimeout(timeout);
        const text = await res.text();

        if (res.ok) {
          let data;
          try { data = JSON.parse(text); } catch { data = text; }
          
          if (data && data.code && data.code < 0) {
            if (data.code === -1021) { await this.syncTime(); continue; }
            throw new Error(`[BNC ${data.code}] ${data.msg}`);
          }

          this.activeProxyName = tunnel.name;
          this.isReady = true;
          return data;
        }
        lastError = `${tunnel.name}: ${res.status} ${text.substring(0, 50)}`;
      } catch (e: any) {
        lastError = `${tunnel.name}: ${e.message}`;
      }
    }
    throw new Error(lastError);
  }

  public async syncTime() {
    try {
      const data = await this.robustFetch(`${this.restBase}/fapi/v1/time`);
      if (data?.serverTime) { 
        this.timeOffset = data.serverTime - Date.now(); 
        this.isReady = true; 
        this.lastSyncTime = Date.now();
      }
    } catch (e: any) {}
  }

  public async fetchExchangeInfo() {
    try {
      const data = await this.robustFetch(`${this.restBase}/fapi/v1/exchangeInfo`);
      if (data?.symbols) {
        this.symbolInfo.clear();
        data.symbols.forEach((s: any) => {
          if (s.contractType === 'PERPETUAL' && s.status === 'TRADING' && s.quoteAsset === 'USDT') {
            this.symbolInfo.set(s.symbol, s);
          }
        });
      }
    } catch (e) {}
  }

  public async getLeverageBrackets(symbol: string): Promise<number> {
    const res = await this.signedRequest('/fapi/v1/leverageBracket', 'GET', { symbol });
    if (res.success && Array.isArray(res.data)) {
        const brackets = res.data[0]?.brackets || [];
        return Math.max(...brackets.map((b: any) => b.initialLeverage));
    }
    return 20; // Fallback seguro
  }

  public async setLeverage(symbol: string, leverage: number): Promise<number> {
    try {
      // Intentar primero cambiar a CROSSED (Isolated suele dar más problemas de límites)
      await this.signedRequest('/fapi/v1/marginType', 'POST', { symbol, marginType: 'CROSSED' });
    } catch(e) {}

    // Obtener el máximo permitido real por Binance para este par
    const maxAllowed = await this.getLeverageBrackets(symbol);
    const finalLeverage = Math.min(leverage, maxAllowed);

    const res = await this.signedRequest('/fapi/v1/leverage', 'POST', { 
      symbol, 
      leverage: finalLeverage.toString() 
    });

    if (res.success && res.data?.leverage) {
        return parseInt(res.data.leverage);
    }
    return finalLeverage;
  }

  public async getOpenPositions(): Promise<any[]> {
    const res = await this.signedRequest('/fapi/v2/positionRisk', 'GET');
    return (res.success && Array.isArray(res.data)) 
        ? res.data.filter((p: any) => Math.abs(parseFloat(p.positionAmt)) > 0) 
        : [];
  }

  public async getAvailableBalance(): Promise<number> {
    const res = await this.signedRequest('/fapi/v2/account', 'GET');
    if (res.success && res.data) {
      const usdt = res.data.assets?.find((a: any) => a.asset === 'USDT');
      return parseFloat(usdt?.availableBalance || "0");
    }
    return 0;
  }

  public async getAllPrices(): Promise<Map<string, number>> {
    const pricesMap = new Map<string, number>();
    try {
      const data = await this.robustFetch(`${this.restBase}/fapi/v1/ticker/price`);
      if (Array.isArray(data)) {
        data.forEach((item: any) => {
          if (item.symbol.endsWith('USDT')) pricesMap.set(item.symbol, parseFloat(item.price));
        });
      }
    } catch (e) {}
    return pricesMap;
  }

  public async getTicker24h(): Promise<any[]> {
    try {
      const data = await this.robustFetch(`${this.restBase}/fapi/v1/ticker/24hr`);
      return Array.isArray(data) ? data : [];
    } catch (e) { return []; }
  }

  public async closePosition(symbol: string, side: 'BUY' | 'SELL', amount: string): Promise<BinanceResponse> {
    const closeSide = side === 'BUY' ? 'SELL' : 'BUY';
    await this.signedRequest('/fapi/v1/allOpenOrders', 'DELETE', { symbol });
    return this.signedRequest('/fapi/v1/order', 'POST', {
      symbol, side: closeSide, type: 'MARKET', quantity: Math.abs(parseFloat(amount)).toString(), reduceOnly: 'true'
    });
  }

  public async createOrder(symbol: string, side: 'BUY' | 'SELL', quantity: string): Promise<BinanceResponse> {
    return this.signedRequest('/fapi/v1/order', 'POST', { 
      symbol, side, type: 'MARKET', quantity, newOrderRespType: 'RESULT' 
    });
  }

  public async setNativeExit(symbol: string, side: 'BUY' | 'SELL', price: number, type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET'): Promise<BinanceResponse> {
    return this.signedRequest('/fapi/v1/order', 'POST', {
      symbol, side, type, stopPrice: this.formatPrice(symbol, price),
      closePosition: 'true', workingType: 'MARK_PRICE', timeInForce: 'GTC'
    });
  }

  public formatQuantity(symbol: string, quantity: number): string {
    const info = this.symbolInfo.get(symbol);
    if (!info) return quantity.toFixed(3);
    const stepSize = parseFloat(info.filters?.find((f: any) => f.filterType === 'LOT_SIZE')?.stepSize || "0.001");
    const precision = Math.max(0, Math.round(-Math.log10(stepSize)));
    return (Math.floor(quantity / stepSize) * stepSize).toFixed(precision);
  }

  public formatPrice(symbol: string, price: number): string {
    const info = this.symbolInfo.get(symbol);
    if (!info) return price.toFixed(4);
    const tickSize = parseFloat(info.filters?.find((f: any) => f.filterType === 'PRICE_FILTER')?.tickSize || "0.0001");
    const precision = Math.max(0, Math.round(-Math.log10(tickSize)));
    return (Math.round(price / tickSize) * tickSize).toFixed(precision);
  }

  public async getUserTrades(symbol: string): Promise<any[]> {
    const res = await this.signedRequest('/fapi/v1/userTrades', 'GET', { symbol, limit: '5' });
    return res.success && Array.isArray(res.data) ? res.data : [];
  }

  public async signedRequest(endpoint: string, method: 'GET' | 'POST' | 'DELETE', params: any = {}): Promise<BinanceResponse> {
    try {
      const timestamp = Date.now() + this.timeOffset;
      const queryObj: any = { ...params, timestamp: timestamp.toString(), recvWindow: '60000' };
      const queryString = Object.keys(queryObj).sort().map(k => `${k}=${encodeURIComponent(queryObj[k])}`).join('&');
      const signature = CryptoJS.HmacSHA256(queryString, this.apiSecret).toString(CryptoJS.enc.Hex);
      
      const url = `${this.restBase}${endpoint}`;
      const ghostQuery = `${queryString}&signature=${signature}`;

      const res = await this.robustFetch(method === 'GET' ? `${url}?${ghostQuery}` : url, {
        method,
        body: method === 'GET' ? null : ghostQuery
      });
      return { success: true, data: res };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }
}

export const binanceService = new BinanceService();
