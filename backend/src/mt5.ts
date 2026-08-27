import { env } from './config.js';
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
  constructor(private readonly getSettings: () => EngineSettings) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${env.MT5_BRIDGE_URL}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(env.MT5_BRIDGE_TOKEN ? { 'X-Bridge-Token': env.MT5_BRIDGE_TOKEN } : {}),
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

  history(positionTicket: number): Promise<Mt5PositionHistory> {
    return this.request(`/history/${encodeURIComponent(String(positionTicket))}`);
  }

  calculateSize(input: {
    symbol: string;
    side: TradeSide;
    entry: number;
    sl: number;
  }): Promise<Mt5SizeResult> {
    const settings = this.getSettings();
    return this.request('/size', {
      method: 'POST',
      body: JSON.stringify({
        symbol: input.symbol,
        side: input.side,
        entry: input.entry,
        sl: input.sl,
        percent: settings.forexPctPerTrade,
        mode: settings.forexRiskMode,
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
