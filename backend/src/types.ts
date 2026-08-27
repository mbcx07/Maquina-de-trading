export type Broker = 'BINANCE' | 'MT5';
export type TradeSide = 'BUY' | 'SELL';
export type AppMode = 'PAPER' | 'TESTNET' | 'REAL';
export type TradeState =
  | 'PENDING'
  | 'OPENING'
  | 'OPEN'
  | 'CLOSING'
  | 'CLOSED'
  | 'REJECTED'
  | 'ORPHANED'
  | 'SYNC_REQUIRED';

export type CloseReason =
  | 'TP'
  | 'SL'
  | 'MANUAL'
  | 'LIQUIDATION'
  | 'EXTERNAL'
  | 'ERROR'
  | 'UNKNOWN';

export interface Opportunity {
  id: string;
  signalId: string;
  signalFingerprint: string;
  broker: Broker;
  symbol: string;
  side: TradeSide;
  timeframe: string;
  strategy: string;
  confidence: number;
  rollingWinRate: number;
  profitFactor?: number;
  expectancy?: number;
  score: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  tp2?: number;
  tp3?: number;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

export interface TradeRecord {
  id: string;
  broker: Broker;
  executionMode?: AppMode;
  symbol: string;
  side: TradeSide;
  strategy: string;
  timeframe: string;
  confidence: number;
  rollingWinRate: number;
  entryPrice: number;
  exitPrice?: number;
  stopLoss: number;
  takeProfit: number;
  tp2?: number;
  tp3?: number;
  leverage?: number;
  lotSize?: number;
  marginUsed?: number;
  notional?: number;
  commission?: number;
  fundingOrSwap?: number;
  unrealizedPnl: number;
  realizedPnl: number;
  state: TradeState;
  closeReason?: CloseReason;
  brokerOrderId?: string;
  signalId: string;
  signalFingerprint: string;
  openTime?: number;
  closeTime?: number;
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, unknown>;
}

export interface EngineSettings {
  appMode: AppMode;
  engineEnabled: boolean;

  riskKillSwitchEnabled: boolean;
  dailyLossLimitPct: number;
  maxDrawdownPct: number;
  emergencyStopMode: 'PAUSE_ONLY' | 'CLOSE_TRACKED';

  cryptoEnabled: boolean;
  maxConcurrentCryptoTrades: number;
  cryptoMarginPctPerTrade: number;
  cryptoRequestedLeverage: number;
  cryptoMaxAccountExposurePct: number;
  cryptoMaxLossPctPerTrade: number;
  // Minimum movement of the UNDERLYING price. Leverage affects margin ROI, not these trigger prices.
  cryptoMinStopPricePct: number;
  cryptoMinTakeProfitPricePct: number;
  cryptoMinSignalConfidence: number;
  cryptoMinRollingWinRate: number;

  // PAPER uses the same live market feed but keeps its own simulated account.
  paperInitialBalance: number;
  paperRoundTripCostPct: number;

  // Forex is signal-only in the Linux individual edition. The legacy MT5 sizing
  // fields remain for DB/backward compatibility but are not used for execution.
  forexEnabled: boolean;
  forexExecutionMode: 'SIGNAL_ONLY';
  forexSymbols: string[];
  forexSignalScanIntervalMinutes: number;
  forexSignalsPerCycle: number;
  forexMinSignalConfidence: number;
  forexMinRollingWinRate: number;

  maxConcurrentForexTrades: number;
  forexMaxEntriesPerSymbol: number;
  forexRiskMode: 'MARGIN_PERCENT' | 'RISK_TO_SL';
  forexPctPerTrade: number;
  forexMagicNumber: number;
  forexMaxDeviationPoints: number;
  forexMaxSpreadPoints: number;
}

export interface CryptoSizingInput {
  futuresBalance: number;
  marginPctPerTrade: number;
  requestedLeverage: number;
  maxAllowedLeverage: number;
  entryPrice: number;
  stopLoss: number;
  maxLossPctPerTrade: number;
}

export interface CryptoSizingResult {
  marginTarget: number;
  effectiveLeverage: number;
  targetNotional: number;
  lossAtStop: number;
  maxAllowedLoss: number;
  adjustedForStopRisk: boolean;
}

export interface SelectorContext {
  maxCryptoTrades: number;
  maxForexTrades: number;
  forexMaxEntriesPerSymbol: number;
  activeTrades: TradeRecord[];
}
