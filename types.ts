
export enum StrategyType {
  PRICE_ACTION_REVERSAL = 'PA_REVERSAL',
  SWING_MULTI_FILTER = 'SWING_CONF',
  BREAKOUT_VOLUME = 'VOL_BREAKOUT',
  FIB_RETRACEMENT = 'FIB_PULLBACK',
  KILL_ZONE_LIQUIDITY = 'KILL_ZONE',
  RANGE_BOLLINGER_RSI = 'RANGE_BB_RSI',
  MULTITEMPORAL_CONF = 'MTF_VALIDATION',
  ADAPTIVE_GRID_QUANT = 'DYNAMIC_GRID',
  ALGO_QUANT_RULES = 'QUANT_BOT_V1',
  VOLATILITY_SCALPING = 'VOL_SCALPER',
  MEAN_REVERSION_ATR = 'MEAN_REV_ATR',
  HARMONIC_PATTERN = 'HARMONIC_SIMPLE',
  OPTIONS_WHEEL_SIM = 'THETA_CASH_FLOW',
  CARRY_TREND_PERSIST = 'TREND_CARRY',
  EXPERT_CONFLUENCE = 'EXPERT_VAL_METHOD'
}

export enum Timeframe {
  S15 = '15s',
  M1 = '1m',
  M3 = '3m',
  M5 = '5m',
  M15 = '15m',
  H1 = '1h'
}

export enum MarketType {
  SPOT = 'SPOT',
  FUTURES = 'FUTURES'
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Asset {
  symbol: string;
  name: string;
  basePrice: number;
  volatility: number;
  volume24h: number;
  isEligible: boolean;
  market: MarketType;
}

export interface StrategyResult {
  strategy: StrategyType;
  timeframe: Timeframe;
  symbol: string;
  profit: number;
  winRate: number;
  drawdown: number;
  score: number; 
  tradesEvaluated: number;
  status?: string;
  expectancy?: number;
}

export interface Trade {
  id: string;
  symbol: string;
  strategy: StrategyType;
  timeframe: Timeframe;
  market: MarketType;
  entryPrice: number;
  exitPrice?: number;
  takeProfit?: number;
  tp2?: number;
  tp3?: number;
  stopLoss?: number;
  trailingStopLoss?: number;
  amount: number;
  leverage: number;
  entryTime: number;
  exitTime?: number;
  status: 'OPEN' | 'CLOSED';
  pnl: number;
  side: 'BUY' | 'SELL';
  isReal?: boolean;
}

export interface Portfolio {
  futuresBalance: number;
  initialBalance: number;
  equity: number;
  totalPnl: number;
  trades: Trade[];
}

export interface LogEntry {
  timestamp: number;
  level: 'INFO' | 'SUCCESS' | 'WARNING' | 'ERROR';
  message: string;
  category: 'MARKET' | 'ANALYSIS' | 'EXECUTION' | 'RISK';
}
