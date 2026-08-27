import 'dotenv/config';
import { z } from 'zod';
import type { EngineSettings } from './types.js';

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  APP_MODE: z.enum(['PAPER', 'TESTNET', 'REAL']).default('PAPER'),
  DB_PATH: z.string().default('./data/trading-v34.sqlite'),

  DEFAULT_WORKSPACE_ID: z.string().min(1).max(128).default('default'),
  INTEGRATION_MASTER_KEY: z.string().default(''),
  LOCAL_VAULT_KEY_PATH: z.string().default('./data/.integration-vault-key'),

  BINANCE_API_KEY: z.string().default(''),
  BINANCE_API_SECRET: z.string().default(''),
  BINANCE_BASE_URL: z.string().url().default('https://fapi.binance.com'),
  BINANCE_TESTNET_BASE_URL: z.string().url().default('https://testnet.binancefuture.com'),

  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_CHAT_ID: z.string().default(''),

  // Legacy MT5 variables remain only for old backtests/migration. Runtime Forex no longer requires them.
  MT5_BRIDGE_URL: z.string().url().default('http://127.0.0.1:8790'),
  MT5_BRIDGE_TOKEN: z.string().default(''),

  CRYPTO_MAX_TRADES: z.coerce.number().int().min(1).max(10).default(10),
  CRYPTO_MARGIN_PCT: z.coerce.number().positive().max(100).default(1),
  CRYPTO_REQUESTED_LEVERAGE: z.coerce.number().int().min(1).max(125).default(20),
  CRYPTO_MIN_CONFIDENCE: z.coerce.number().min(0).max(100).default(75),
  CRYPTO_MIN_WINRATE: z.coerce.number().min(0).max(100).default(75),

  // Four pairs × two time-series requests × 96 cycles/day (15 min) ≈ 768 credits/day,
  // which fits the current Twelve Data Basic 800/day allowance.
  FOREX_SYMBOLS: z.string().default('EURUSD,GBPUSD,USDJPY,EURJPY'),
  FOREX_SIGNAL_SCAN_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  FOREX_SIGNALS_PER_CYCLE: z.coerce.number().int().min(1).max(20).default(4),
  FOREX_MIN_CONFIDENCE: z.coerce.number().min(0).max(100).default(75),
  FOREX_MIN_WINRATE: z.coerce.number().min(0).max(100).default(70),

  DAILY_LOSS_LIMIT_PCT: z.coerce.number().positive().max(100).default(5),
  MAX_DRAWDOWN_PCT: z.coerce.number().positive().max(100).default(15),
});

export const env = envSchema.parse(process.env);

export function defaultSettings(): EngineSettings {
  return {
    appMode: env.APP_MODE,
    engineEnabled: false,

    riskKillSwitchEnabled: true,
    dailyLossLimitPct: env.DAILY_LOSS_LIMIT_PCT,
    maxDrawdownPct: env.MAX_DRAWDOWN_PCT,
    emergencyStopMode: 'PAUSE_ONLY',

    cryptoEnabled: true,
    maxConcurrentCryptoTrades: env.CRYPTO_MAX_TRADES,
    cryptoMarginPctPerTrade: env.CRYPTO_MARGIN_PCT,
    cryptoRequestedLeverage: env.CRYPTO_REQUESTED_LEVERAGE,
    cryptoMaxAccountExposurePct: 50,
    cryptoMaxLossPctPerTrade: 1,
    cryptoMinSignalConfidence: env.CRYPTO_MIN_CONFIDENCE,
    cryptoMinRollingWinRate: env.CRYPTO_MIN_WINRATE,

    forexEnabled: true,
    forexExecutionMode: 'SIGNAL_ONLY',
    forexSymbols: env.FOREX_SYMBOLS.split(',').map((symbol) => symbol.trim()).filter(Boolean),
    forexSignalScanIntervalMinutes: env.FOREX_SIGNAL_SCAN_INTERVAL_MINUTES,
    forexSignalsPerCycle: env.FOREX_SIGNALS_PER_CYCLE,
    forexMinSignalConfidence: env.FOREX_MIN_CONFIDENCE,
    forexMinRollingWinRate: env.FOREX_MIN_WINRATE,

    // Legacy fields retained so existing SQLite settings remain loadable.
    maxConcurrentForexTrades: 20,
    forexMaxEntriesPerSymbol: 0,
    forexRiskMode: 'RISK_TO_SL',
    forexPctPerTrade: 1,
    forexMagicNumber: 340034,
    forexMaxDeviationPoints: 20,
    forexMaxSpreadPoints: 0,
  };
}
