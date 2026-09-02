import { env } from './config.js';
import type { Candle } from './analysis.js';
import type { Mt5BridgeCredentials } from './integrationVault.js';
import type { EngineSettings, TradeSide } from './types.js';

export interface Mt5Account {
  login: number;
  server: string;
  currency: string;
  tradeMode: number;
  tradeAllowed: boolean;
  tradeExpert: boolean;
  leverage: number;
  marginMode: number;
  hedging: boolean;
  balance: number;
  equity: number;
  profit: number;
  margin: number;
  marginFree: number;
  marginLevel: number;
}

export interface Mt5Position {
  ticket: number;
  symbol: string;
  side: TradeSide;
  volume: number;
  priceOpen: number;
  sl: number;
  tp: number;
  priceCurrent: number;
  swap: number;
  profit: number;
  magic: number;
  comment: string;
  time: number;
  timeMsc: number;
}

export interface Mt5MarketSnapshot {
  symbol: string;
  bid: number;
  ask: number;
  point: number;
  digits: number;
  spreadPoints: number;
  spreadPrice: number;
  timeMsc: number;
}

export interface Mt5SymbolInfo {
  name: string;
  path: string;
  visible: boolean;
  tradeMode: number;
  currencyBase?: string;
  currencyProfit?: string;
  volumeMin: number;
  volumeMax: number;
  volumeStep: number;
}

export interface Mt5Tick {
  timeMsc: number;
  bid: number;
  ask: number;
  last: number;
  price: number;
  volume: number;
  flags: number;
}

export interface Mt5Deal {
  ticket: number;
  order: number;
  time: number;
  timeMsc: number;
  type: number;
  entry: number;
  magic: number;
  positionId: number;
  reason: number;
  volume: number;
  price: number;
  commission: number;
  swap: number;
  profit: number;
  fee: number;
  symbol: string;
  comment: string;
}

export interface Mt5PositionHistory {
  ticket: number;
  deals: Mt5Deal[];
  summary: {
    exitPrice: number | null;
    closeTime: number | null;
    profit: number;
    commission: number;
    swap: number;
    fee: number;
    closeReason: string;
  };
}

export interface Mt5SizeResult {
  symbol: string;
  mode: 'RISK_TO_SL' | 'MARGIN_PERCENT';
  percent: number;
  balance: number;
  capitalTarget: number;
  rawVolume: number;
  volume: number;
  volumeMin: number;
  volumeMax: number;
  volumeStep: number;
  basisPerLot: number;
  hedging: boolean;
}

export class Mt5BridgeClient {
  constructor(
    private readonly getSettings: () => EngineSettings,
    private readonly credentialProvider?: () => Mt5BridgeCredentials | null,
  ) {}

  private connection(): Mt5BridgeCredentials {
    const configured = this.credentialProvider?.();
    const bridgeUrl = String(configured?.bridgeUrl || env.MT5_BRIDGE_URL || '').trim().replace(/\/$/, '');
    const bridgeToken = String(configured?.bridgeToken || env.MT5_BRIDGE_TOKEN || '').trim();
    if (!bridgeUrl) throw new Error('MT5_BRIDGE_NOT_CONFIGURED');
    return { bridgeUrl, bridgeToken };
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const { bridgeUrl, bridgeToken } = this.connection();
    const response = await fetch(`${bridgeUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(bridgeToken ? { 'X-Bridge-Token': bridgeToken } : {}),
        ...(init?.headers ?? {}),
      },
    });

    const text = await response.text();
    let data: unknown;
    try { data = JSON.parse(text); } catch { data = text; }
    if (!response.ok) throw new Error(`MT5_BRIDGE_${response.status}:${JSON.stringify(data).slice(0, 260)}`);
    return data as T;
  }

  health(): Promise<{ ok: boolean; account: Mt5Account }> {
    return this.request('/health');
  }

  account(): Promise<Mt5Account> {
    return this.request('/account');
  }

  positions(symbol?: string): Promise<Mt5Position[]> {
    return this.request(`/positions${symbol ? `?symbol=${encodeURIComponent(symbol)}` : ''}`);
  }

  symbols(): Promise<Mt5SymbolInfo[]> {
    return this.request('/market/symbols');
  }

  marketSnapshot(symbol: string): Promise<Mt5MarketSnapshot> {
    return this.request(`/market/snapshot/${encodeURIComponent(symbol)}`);
  }

  ticks(symbol: string, seconds = 300, limit = 5000): Promise<Mt5Tick[]> {
    return this.request(
      `/market/ticks/${encodeURIComponent(symbol)}?seconds=${Math.max(30, Math.min(1800, seconds))}&limit=${Math.max(50, Math.min(20000, limit))}`,
    );
  }

  calculateProfit(input: { symbol: string; side: TradeSide; volume: number; entry: number; exit: number }): Promise<number> {
    return this.request<{ profit: number }>('/market/calc-profit', {
      method: 'POST',
      body: JSON.stringify(input),
    }).then((row) => Number(row.profit ?? 0));
  }

  history(positionTicket: number): Promise<Mt5PositionHistory> {
    return this.request(`/history/${encodeURIComponent(String(positionTicket))}`);
  }

  rates(symbol: string, timeframe: 'M1' | 'M5' | 'M15' | 'H1', count: number): Promise<Candle[]> {
    return this.request(
      `/market/rates/${encodeURIComponent(symbol)}?timeframe=${encodeURIComponent(timeframe)}&count=${Math.max(50, Math.min(5000, count))}`,
    );
  }

  ratesRange(
    symbol: string,
    timeframe: 'M1' | 'M5' | 'M15' | 'H1',
    startTime: number,
    endTime: number,
  ): Promise<Candle[]> {
    return this.request(
      `/market/rates-range/${encodeURIComponent(symbol)}?timeframe=${encodeURIComponent(timeframe)}&start_ms=${Math.floor(startTime)}&end_ms=${Math.floor(endTime)}`,
    );
  }

  async dualRates(symbol: string): Promise<{ ltf: Candle[]; htf: Candle[] }> {
    const [ltf, htf] = await Promise.all([
      this.rates(symbol, 'M1', 220),
      this.rates(symbol, 'M15', 260),
    ]);
    return { ltf, htf };
  }

  async dualHistoricalRange(
    symbol: string,
    startTime: number,
    endTime: number,
  ): Promise<{ ltf: Candle[]; htf: Candle[] }> {
    const warmupStart = startTime - 15 * 60_000 * 260;
    const [ltf, htf] = await Promise.all([
      this.ratesRange(symbol, 'M1', warmupStart, endTime),
      this.ratesRange(symbol, 'M15', warmupStart, endTime),
    ]);
    return { ltf, htf };
  }

  calculateSize(input: {
    symbol: string;
    side: TradeSide;
    entry: number;
    sl: number;
    percent?: number;
    mode?: 'RISK_TO_SL' | 'MARGIN_PERCENT';
  }): Promise<Mt5SizeResult> {
    const settings = this.getSettings();
    return this.request('/size', {
      method: 'POST',
      body: JSON.stringify({
        symbol: input.symbol,
        side: input.side,
        entry: input.entry,
        sl: input.sl,
        percent: input.percent ?? settings.forexPctPerTrade,
        mode: input.mode ?? settings.forexRiskMode,
      }),
    });
  }

  openOrder(input: {
    symbol: string;
    side: TradeSide;
    volume: number;
    sl: number;
    tp: number;
    comment: string;
  }): Promise<{ ok: boolean; ticket: number; order: number; deal: number; price: number; volume: number; hedging: boolean }> {
    const settings = this.getSettings();
    return this.request('/order', {
      method: 'POST',
      body: JSON.stringify({
        symbol: input.symbol,
        side: input.side,
        volume: input.volume,
        sl: input.sl,
        tp: input.tp,
        magic: settings.forexMagicNumber,
        deviation: settings.forexMaxDeviationPoints,
        comment: input.comment.slice(0, 31),
      }),
    });
  }

  closePosition(ticket: number): Promise<{ ok: boolean; ticket: number; deal: number; price: number }> {
    return this.request('/close', {
      method: 'POST',
      body: JSON.stringify({
        ticket,
        deviation: this.getSettings().forexMaxDeviationPoints,
      }),
    });
  }
}
