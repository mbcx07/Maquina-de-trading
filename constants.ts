
import { MarketType, Asset } from './types';

export const INITIAL_CAPITAL = 50.00;
export const LEVERAGE = 20; 

export const FEE_TAKER = 0.00045; 
export const FEE_MAKER = 0.0002; 

// Risk Management v18.5
export const MAX_CONCURRENT_POSITIONS = 5; 
export const NOTIONAL_PCT_OF_BALANCE = 0.11; // 11% del balance como nocional solicitado
export const MAX_RISK_PER_TRADE_PCT = 0.015; // 1.5% del balance máximo riesgo real en SL
export const MIN_NOTIONAL = 6.0; 

// Win Rate Target & Thresholds (Sniper 80% Winrate)
export const TARGET_WINRATE = 80.0; // 80% Win Rate Target
export const MIN_BACKTEST_WINRATE = 75.0; // Mínimo winrate requerido en rastreo para disparar entrada
export const MIN_CONFLUENCE_CONFIDENCE = 80; // Score mínimo de confluencia (0-100) 

// Fibonacci Targets
export const FIB_TP1 = 0.236;
export const FIB_TP2 = 0.382;
export const FIB_TP3 = 0.618;

export const MOCK_ASSETS: Asset[] = [
  { symbol: 'BTCUSDT', name: 'Bitcoin', basePrice: 65000, volatility: 0.001, volume24h: 1000000000, isEligible: true, market: MarketType.FUTURES },
];
