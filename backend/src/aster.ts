import { Wallet, getAddress } from 'ethers';
import { env } from './config.js';
import type { TradeSide } from './types.js';

export interface AsterCredentials {
  user: string;
  signer: string;
  privateKey: string;
}

export interface AsterBookTicker {
  symbol: string;
  bidPrice: number;
  bidQty: number;
  askPrice: number;
  askQty: number;
  time: number;
}

export interface AsterCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface AsterAggTrade {
  id: number;
  price: number;
  qty: number;
  time: number;
  buyerIsMaker: boolean;
}

export interface AsterSymbolMeta {
  symbol: string;
  minQty: number;
  stepSize: number;
  minNotional: number;
  tickSize: number;
  quantityPrecision: number;
  pricePrecision: number;
}

export interface AsterPosition {
  symbol: string;
  positionAmt: number;
  entryPrice: number;
  markPrice: number;
  unrealizedProfit: number;
  leverage: number;
}

export class AsterV3Client {
  private timeOffsetMs = 0;
  private nonceBaseMs = 0;
  private nonceCounter = 0;
  private meta = new Map<string, AsterSymbolMeta>();

  private baseUrl(): string {
    return env.ASTER_BASE_URL.replace(/\/$/, '');
  }

  credentials(): AsterCredentials {
    const user = env.ASTER_USER.trim();
    const signer = env.ASTER_SIGNER.trim();
    const privateKey = env.ASTER_PRIVATE_KEY.trim();
    if (!user || !signer || !privateKey) throw new Error('ASTER_PRO_API_NOT_CONFIGURED');
    const wallet = new Wallet(privateKey);
    if (getAddress(wallet.address) !== getAddress(signer)) throw new Error('ASTER_SIGNER_PRIVATE_KEY_MISMATCH');
    return { user: getAddress(user), signer: getAddress(signer), privateKey };
  }

  hasCredentials(): boolean {
    try { this.credentials(); return true; } catch { return false; }
  }

  async publicRequest<T>(endpoint: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined) query.set(key, String(value));
    const response = await fetch(`${this.baseUrl()}${endpoint}${query.size ? `?${query.toString()}` : ''}`);
    const text = await response.text();
    let data: any;
    try { data = JSON.parse(text); } catch { data = text; }
    if (!response.ok) throw new Error(`ASTER_PUBLIC_${response.status}:${typeof data === 'object' ? data?.msg ?? text.slice(0, 180) : text.slice(0, 180)}`);
    return data as T;
  }

  async signedRequest<T>(endpoint: string, method: 'GET' | 'POST' | 'DELETE', params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    const credentials = this.credentials();
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined) body.set(key, String(value));
    body.set('nonce', this.nextNonce());
    body.set('user', credentials.user);
    body.set('signer', credentials.signer);

    const message = body.toString();
    const wallet = new Wallet(credentials.privateKey);
    const signature = await wallet.signTypedData(
      { name: 'AsterSignTransaction', version: '1', chainId: 1666, verifyingContract: '0x0000000000000000000000000000000000000000' },
      { Message: [{ name: 'msg', type: 'string' }] },
      { msg: message },
    );
    body.set('signature', signature);

    const isGet = method === 'GET';
    const response = await fetch(`${this.baseUrl()}${endpoint}${isGet ? `?${body.toString()}` : ''}`, {
      method,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Quantum-Dual-R12/1.0' },
      body: isGet ? undefined : body.toString(),
    });
    const text = await response.text();
    let data: any;
    try { data = JSON.parse(text); } catch { data = text; }
    if (!response.ok || (data && typeof data === 'object' && Number(data.code) < 0)) {
      const code = typeof data === 'object' ? data?.code : response.status;
      const msg = typeof data === 'object' ? data?.msg : text.slice(0, 180);
      throw new Error(`ASTER_${code ?? response.status}:${msg ?? 'UNKNOWN'}`);
    }
    return data as T;
  }

  private nextNonce(): string {
    const adjustedMs = Date.now() + this.timeOffsetMs;
    if (adjustedMs === this.nonceBaseMs) this.nonceCounter += 1;
    else { this.nonceBaseMs = adjustedMs; this.nonceCounter = 0; }
    return (BigInt(adjustedMs) * 1000n + BigInt(this.nonceCounter)).toString();
  }

  async syncTime(): Promise<void> {
    const data = await this.publicRequest<{ serverTime: number }>('/fapi/v3/time');
    if (Number.isFinite(Number(data.serverTime))) this.timeOffsetMs = Number(data.serverTime) - Date.now();
  }

  async testPublic(): Promise<{ ok: true; symbol: string; bid: number; ask: number; spreadPct: number }> {
    const book = await this.getBookTicker('CLUSDT');
    const mid = (book.bidPrice + book.askPrice) / 2;
    return { ok: true, symbol: 'CLUSDT', bid: book.bidPrice, ask: book.askPrice, spreadPct: mid > 0 ? (book.askPrice - book.bidPrice) / mid * 100 : 0 };
  }

  async testPrivate(): Promise<{ ok: true; balance: number; availableBalance: number; openPositions: number }> {
    await this.syncTime();
    const [balance, positions] = await Promise.all([this.getBalance(), this.getPositions()]);
    return { ok: true, balance: balance.balance, availableBalance: balance.availableBalance, openPositions: positions.length };
  }

  async getBookTicker(symbol: string): Promise<AsterBookTicker> {
    const row = await this.publicRequest<any>('/fapi/v3/ticker/bookTicker', { symbol: symbol.toUpperCase() });
    return {
      symbol: String(row.symbol ?? symbol).toUpperCase(),
      bidPrice: Number(row.bidPrice ?? row.b ?? 0),
      bidQty: Number(row.bidQty ?? row.B ?? 0),
      askPrice: Number(row.askPrice ?? row.a ?? 0),
      askQty: Number(row.askQty ?? row.A ?? 0),
      time: Number(row.time ?? row.E ?? Date.now()),
    };
  }

  async getKlines(symbol: string, interval: '1m' | '5m' | '15m', limit = 200): Promise<AsterCandle[]> {
    const rows = await this.publicRequest<any[]>('/fapi/v3/klines', { symbol: symbol.toUpperCase(), interval, limit: Math.min(1500, Math.max(1, limit)) });
    const now = Date.now();
    return (Array.isArray(rows) ? rows : [])
      .filter((row) => Number(row[6] ?? 0) <= now)
      .map((row) => ({ time: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5] ?? 0) }))
      .filter((row) => Number.isFinite(row.time) && row.close > 0);
  }

  async getAggTrades(symbol: string, startTime?: number, endTime?: number): Promise<AsterAggTrade[]> {
    const params: Record<string, string | number | undefined> = { symbol: symbol.toUpperCase(), limit: 1000 };
    if (startTime !== undefined) params.startTime = Math.floor(startTime);
    if (endTime !== undefined) params.endTime = Math.floor(endTime);
    const rows = await this.publicRequest<any[]>('/fapi/v3/aggTrades', params);
    return (Array.isArray(rows) ? rows : []).map((row) => ({
      id: Number(row.a ?? 0), price: Number(row.p ?? 0), qty: Number(row.q ?? 0), time: Number(row.T ?? row.time ?? 0), buyerIsMaker: Boolean(row.m),
    })).filter((row) => row.time > 0 && row.price > 0 && row.qty > 0);
  }

  async refreshExchangeInfo(): Promise<void> {
    const data = await this.publicRequest<{ symbols: any[] }>('/fapi/v3/exchangeInfo');
    this.meta.clear();
    for (const symbol of data.symbols ?? []) {
      if (String(symbol.symbol).toUpperCase() !== 'CLUSDT') continue;
      if (symbol.status !== 'TRADING' || symbol.contractType !== 'PERPETUAL') continue;
      const lot = symbol.filters?.find((f: any) => f.filterType === 'MARKET_LOT_SIZE') ?? symbol.filters?.find((f: any) => f.filterType === 'LOT_SIZE');
      const minNotional = symbol.filters?.find((f: any) => f.filterType === 'MIN_NOTIONAL');
      const priceFilter = symbol.filters?.find((f: any) => f.filterType === 'PRICE_FILTER');
      this.meta.set('CLUSDT', {
        symbol: 'CLUSDT', minQty: Number(lot?.minQty ?? 0), stepSize: Number(lot?.stepSize ?? 0),
        minNotional: Number(minNotional?.notional ?? 0), tickSize: Number(priceFilter?.tickSize ?? 0),
        quantityPrecision: Number(symbol.quantityPrecision ?? 4), pricePrecision: Number(symbol.pricePrecision ?? 2),
      });
    }
    if (!this.meta.has('CLUSDT')) throw new Error('ASTER_CLUSDT_NOT_TRADING');
  }

  getSymbolMeta(symbol = 'CLUSDT'): AsterSymbolMeta {
    const meta = this.meta.get(symbol.toUpperCase());
    if (!meta) throw new Error(`ASTER_SYMBOL_META_NOT_LOADED:${symbol}`);
    return meta;
  }

  async getBalance(asset = 'USDT'): Promise<{ balance: number; availableBalance: number }> {
    const rows = await this.signedRequest<any[]>('/fapi/v3/balance', 'GET');
    const row = rows.find((item) => String(item.asset) === asset);
    return { balance: Number(row?.balance ?? 0), availableBalance: Number(row?.availableBalance ?? 0) };
  }

  async getPositions(symbol?: string): Promise<AsterPosition[]> {
    const rows = await this.signedRequest<any[]>('/fapi/v3/positionRisk', 'GET', symbol ? { symbol: symbol.toUpperCase() } : {});
    return (Array.isArray(rows) ? rows : []).map((row) => ({
      symbol: String(row.symbol), positionAmt: Number(row.positionAmt ?? 0), entryPrice: Number(row.entryPrice ?? 0),
      markPrice: Number(row.markPrice ?? 0), unrealizedProfit: Number(row.unRealizedProfit ?? row.unrealizedProfit ?? 0), leverage: Number(row.leverage ?? 1),
    })).filter((row) => Math.abs(row.positionAmt) > 0);
  }

  async setLeverage(symbol: string, leverage: number): Promise<number> {
    const row = await this.signedRequest<{ leverage?: number }>('/fapi/v3/leverage', 'POST', { symbol: symbol.toUpperCase(), leverage: Math.max(1, Math.min(20, Math.floor(leverage))) });
    return Number(row.leverage ?? leverage);
  }

  async createMarketOrder(symbol: string, side: TradeSide, quantity: number, reduceOnly = false): Promise<any> {
    return this.signedRequest('/fapi/v3/order', 'POST', {
      symbol: symbol.toUpperCase(), side, type: 'MARKET', quantity, reduceOnly: reduceOnly ? 'true' : undefined, newOrderRespType: 'RESULT',
    });
  }

  async createCloseAllConditional(symbol: string, exitSide: TradeSide, type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET', stopPrice: number): Promise<any> {
    return this.signedRequest('/fapi/v3/order', 'POST', {
      symbol: symbol.toUpperCase(), side: exitSide, type, stopPrice, closePosition: 'true', workingType: 'MARK_PRICE', priceProtect: 'TRUE', newOrderRespType: 'RESULT',
    });
  }

  async cancelAllOpenOrders(symbol: string): Promise<void> {
    await this.signedRequest('/fapi/v3/allOpenOrders', 'DELETE', { symbol: symbol.toUpperCase() });
  }
}
