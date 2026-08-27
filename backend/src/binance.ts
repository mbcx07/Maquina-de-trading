import crypto from 'node:crypto';
import { env } from './config.js';
import type { BinanceCredentials } from './integrationVault.js';
import type { EngineSettings, TradeSide } from './types.js';
import type { BinanceSymbolFilters } from './risk.js';

export interface BinancePosition {
  symbol: string;
  positionAmt: number;
  entryPrice: number;
  markPrice: number;
  unrealizedProfit: number;
  leverage: number;
}

export interface BinanceAccountTrade {
  symbol: string;
  id: number;
  orderId: number;
  side: TradeSide;
  price: number;
  qty: number;
  realizedPnl: number;
  commission: number;
  commissionAsset: string;
  time: number;
  buyer: boolean;
  maker: boolean;
}

export interface BinanceIncome {
  symbol: string;
  incomeType: string;
  income: number;
  asset: string;
  time: number;
  tranId?: number;
}

export interface BinanceSymbolMeta {
  symbol: string;
  filters: BinanceSymbolFilters;
  priceTick: number;
  quantityPrecision: number;
  pricePrecision: number;
}

export class BinanceUsdmClient {
  private timeOffset = 0;
  private symbolMeta = new Map<string, BinanceSymbolMeta>();

  constructor(
    private readonly getSettings: () => EngineSettings,
    private readonly getCredentials?: () => BinanceCredentials | null,
  ) {}

  private baseUrl(): string {
    const mode = this.getSettings().appMode;
    return mode === 'TESTNET' ? env.BINANCE_TESTNET_BASE_URL : env.BINANCE_BASE_URL;
  }

  private credentials(): BinanceCredentials {
    const fromVault = this.getCredentials?.();
    if (fromVault?.apiKey && fromVault?.apiSecret) return fromVault;

    // Legacy fallback to help migrate an existing single-user installation.
    if (env.BINANCE_API_KEY && env.BINANCE_API_SECRET) {
      return { apiKey: env.BINANCE_API_KEY, apiSecret: env.BINANCE_API_SECRET };
    }
    throw new Error('BINANCE_CREDENTIALS_NOT_CONFIGURED');
  }

  hasCredentials(): boolean {
    try {
      this.credentials();
      return true;
    } catch {
      return false;
    }
  }

  async syncTime(): Promise<void> {
    const response = await fetch(`${this.baseUrl()}/fapi/v1/time`);
    if (!response.ok) throw new Error(`BINANCE_TIME_HTTP_${response.status}`);
    const data = await response.json() as { serverTime: number };
    this.timeOffset = data.serverTime - Date.now();
  }

  async signedRequest<T>(
    endpoint: string,
    method: 'GET' | 'POST' | 'DELETE',
    params: Record<string, string | number | boolean | undefined> = {},
  ): Promise<T> {
    const credentials = this.credentials();

    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) query.set(key, String(value));
    }
    query.set('timestamp', String(Date.now() + this.timeOffset));
    query.set('recvWindow', '5000');

    const signature = crypto
      .createHmac('sha256', credentials.apiSecret)
      .update(query.toString())
      .digest('hex');
    query.set('signature', signature);

    const isGet = method === 'GET';
    const url = `${this.baseUrl()}${endpoint}${isGet ? `?${query.toString()}` : ''}`;
    const response = await fetch(url, {
      method,
      headers: {
        'X-MBX-APIKEY': credentials.apiKey,
        ...(isGet ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }),
      },
      body: isGet ? undefined : query.toString(),
    });

    const text = await response.text();
    let data: unknown;
    try { data = JSON.parse(text); } catch { data = text; }

    if (!response.ok) {
      const payload = data as { code?: number; msg?: string };
      if (payload?.code === -1021) {
        await this.syncTime();
        throw new Error('BINANCE_TIMESTAMP_RESYNC_REQUIRED');
      }
      throw new Error(`BINANCE_${payload?.code ?? response.status}:${payload?.msg ?? text.slice(0, 160)}`);
    }

    return data as T;
  }

  async testConnection(): Promise<{ ok: true; balance: number; availableBalance: number; openPositions: number }> {
    await this.syncTime();
    const [balance, availableBalance, positions] = await Promise.all([
      this.getFuturesBalance(),
      this.getAvailableBalance(),
      this.getPositions(),
    ]);
    return { ok: true, balance, availableBalance, openPositions: positions.length };
  }

  async refreshExchangeInfo(): Promise<void> {
    const response = await fetch(`${this.baseUrl()}/fapi/v1/exchangeInfo`);
    if (!response.ok) throw new Error(`BINANCE_EXCHANGE_INFO_HTTP_${response.status}`);
    const data = await response.json() as { symbols: any[] };

    this.symbolMeta.clear();
    for (const symbol of data.symbols ?? []) {
      if (symbol.contractType !== 'PERPETUAL' || symbol.status !== 'TRADING' || symbol.quoteAsset !== 'USDT') continue;

      const lot = symbol.filters?.find((f: any) => f.filterType === 'MARKET_LOT_SIZE')
        ?? symbol.filters?.find((f: any) => f.filterType === 'LOT_SIZE');
      const minNotional = symbol.filters?.find((f: any) => f.filterType === 'MIN_NOTIONAL');
      const priceFilter = symbol.filters?.find((f: any) => f.filterType === 'PRICE_FILTER');

      this.symbolMeta.set(symbol.symbol, {
        symbol: symbol.symbol,
        filters: {
          minQty: Number(lot?.minQty ?? 0),
          stepSize: Number(lot?.stepSize ?? 0),
          minNotional: Number(minNotional?.notional ?? 0),
        },
        priceTick: Number(priceFilter?.tickSize ?? 0),
        quantityPrecision: Number(symbol.quantityPrecision ?? 8),
        pricePrecision: Number(symbol.pricePrecision ?? 8),
      });
    }
  }

  getSymbolMeta(symbol: string): BinanceSymbolMeta {
    const meta = this.symbolMeta.get(symbol.toUpperCase());
    if (!meta) throw new Error(`BINANCE_SYMBOL_NOT_LOADED:${symbol}`);
    return meta;
  }

  async getFuturesBalance(asset = 'USDT'): Promise<number> {
    const rows = await this.signedRequest<any[]>('/fapi/v3/balance', 'GET');
    const row = rows.find((item) => item.asset === asset);
    return Number(row?.balance ?? 0);
  }

  async getAvailableBalance(asset = 'USDT'): Promise<number> {
    const rows = await this.signedRequest<any[]>('/fapi/v3/balance', 'GET');
    const row = rows.find((item) => item.asset === asset);
    return Number(row?.availableBalance ?? 0);
  }

  async getPositions(): Promise<BinancePosition[]> {
    const rows = await this.signedRequest<any[]>('/fapi/v3/positionRisk', 'GET');
    return rows
      .map((row) => ({
        symbol: String(row.symbol),
        positionAmt: Number(row.positionAmt ?? 0),
        entryPrice: Number(row.entryPrice ?? 0),
        markPrice: Number(row.markPrice ?? 0),
        unrealizedProfit: Number(row.unRealizedProfit ?? row.unrealizedProfit ?? 0),
        leverage: Number(row.leverage ?? 1),
      }))
      .filter((row) => Math.abs(row.positionAmt) > 0);
  }

  async assertSymbolNotOpen(symbol: string): Promise<void> {
    const normalized = symbol.toUpperCase();
    const positions = await this.getPositions();
    if (positions.some((position) => position.symbol === normalized)) {
      throw new Error(`BINANCE_SYMBOL_ALREADY_OPEN:${normalized}`);
    }
  }

  async getMaxAllowedLeverage(symbol: string): Promise<number> {
    const rows = await this.signedRequest<any[]>('/fapi/v1/leverageBracket', 'GET', { symbol: symbol.toUpperCase() });
    const brackets = rows?.[0]?.brackets ?? [];
    const values = brackets.map((bracket: any) => Number(bracket.initialLeverage)).filter((v: number) => Number.isFinite(v));
    if (!values.length) throw new Error(`BINANCE_LEVERAGE_BRACKET_MISSING:${symbol}`);
    return Math.max(...values);
  }

  async setLeverage(symbol: string, requested: number): Promise<number> {
    const maxAllowed = await this.getMaxAllowedLeverage(symbol);
    const leverage = Math.max(1, Math.min(requested, maxAllowed));
    const result = await this.signedRequest<{ leverage: number }>('/fapi/v1/leverage', 'POST', {
      symbol: symbol.toUpperCase(),
      leverage,
    });
    return Number(result.leverage ?? leverage);
  }

  async createMarketOrder(symbol: string, side: TradeSide, quantity: number): Promise<any> {
    if (this.getSettings().appMode === 'PAPER') {
      return { paper: true, orderId: `PAPER-${Date.now()}`, symbol, side, quantity };
    }

    return this.signedRequest('/fapi/v1/order', 'POST', {
      symbol: symbol.toUpperCase(),
      side,
      type: 'MARKET',
      quantity,
      newOrderRespType: 'RESULT',
    });
  }

  async createCloseAllConditional(
    symbol: string,
    exitSide: TradeSide,
    type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET',
    triggerPrice: number,
    clientAlgoId: string,
  ): Promise<any> {
    if (this.getSettings().appMode === 'PAPER') {
      return { paper: true, algoId: `PAPER-${type}-${Date.now()}` };
    }

    return this.signedRequest('/fapi/v1/algoOrder', 'POST', {
      algoType: 'CONDITIONAL',
      symbol: symbol.toUpperCase(),
      side: exitSide,
      type,
      triggerPrice,
      closePosition: true,
      workingType: 'MARK_PRICE',
      clientAlgoId,
      newOrderRespType: 'RESULT',
    });
  }

  async getAccountTrades(symbol: string, startTime?: number): Promise<BinanceAccountTrade[]> {
    const rows = await this.signedRequest<any[]>('/fapi/v1/userTrades', 'GET', {
      symbol: symbol.toUpperCase(),
      startTime,
      limit: 1000,
    });

    return rows.map((row) => ({
      symbol: String(row.symbol),
      id: Number(row.id),
      orderId: Number(row.orderId),
      side: String(row.side) as TradeSide,
      price: Number(row.price ?? 0),
      qty: Number(row.qty ?? 0),
      realizedPnl: Number(row.realizedPnl ?? 0),
      commission: Number(row.commission ?? 0),
      commissionAsset: String(row.commissionAsset ?? ''),
      time: Number(row.time ?? 0),
      buyer: Boolean(row.buyer),
      maker: Boolean(row.maker),
    }));
  }

  async getIncomeHistory(
    symbol: string,
    startTime?: number,
    incomeType?: 'FUNDING_FEE' | 'REALIZED_PNL' | 'COMMISSION',
  ): Promise<BinanceIncome[]> {
    const rows = await this.signedRequest<any[]>('/fapi/v1/income', 'GET', {
      symbol: symbol.toUpperCase(),
      startTime,
      incomeType,
      limit: 1000,
    });

    return rows.map((row) => ({
      symbol: String(row.symbol ?? ''),
      incomeType: String(row.incomeType ?? ''),
      income: Number(row.income ?? 0),
      asset: String(row.asset ?? ''),
      time: Number(row.time ?? 0),
      tranId: row.tranId == null ? undefined : Number(row.tranId),
    }));
  }

  async cancelAllAlgoOpenOrders(symbol: string): Promise<void> {
    if (this.getSettings().appMode === 'PAPER') return;
    await this.signedRequest('/fapi/v1/algoOpenOrders', 'DELETE', {
      symbol: symbol.toUpperCase(),
    });
  }
}
