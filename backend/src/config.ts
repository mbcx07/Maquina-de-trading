import 'dotenv/config';
import { z } from 'zod';
import type { EngineSettings } from './types.js';

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  COMMODITY_PORT: z.coerce.number().int().min(1).max(65535).default(8788),
  APP_MODE: z.enum(['PAPER', 'TESTNET', 'REAL']).default('PAPER'),
  DB_PATH: z.string().default('./data/trading-v34.sqlite'),

  DEFAULT_WORKSPACE_ID: z.string().min(1).max(128).default('default'),
  INTEGRATION_MASTER_KEY: z.string().default(''),
  LOCAL_VAULT_KEY_PATH: z.string().default('./data/.integration-vault-key'),

  BINANCE_API_KEY: z.string().default(''),
  BINANCE_API_SECRET: z.string().default(''),
  BINANCE_BASE_URL: z.string().url().default('https://fapi.binance.com'),
  BINANCE_TESTNET_BASE_URL: z.string().url().default('https://testnet.binancefuture.com'),

  ASTER_USER: z.string().default(''),
  ASTER_SIGNER: z.string().default(''),
  ASTER_PRIVATE_KEY: z.string().default(''),
  ASTER_BASE_URL: z.string().url().default('https://fapi3.asterdex.com'),

  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_CHAT_ID: z.string().default(''),

  MT5_BRIDGE_URL: z.string().url().default('http://127.0.0.1:8790'),
  MT5_BRIDGE_TOKEN: z.string().default(''),

  CRYPTO_MAX_TRADES: z.coerce.number().int().min(1).max(10).default(10),
  CRYPTO_MARGIN_PCT: z.coerce.number().positive().max(100).default(1),
  CRYPTO_REQUESTED_LEVERAGE: z.coerce.number().int().min(1).max(125).default(20),
  CRYPTO_MIN_STOP_PRICE_PCT: z.coerce.number().positive().max(25).default(1),
  CRYPTO_MIN_TAKE_PROFIT_PRICE_PCT: z.coerce.number().positive().max(50).default(1.5),
  CRYPTO_MIN_CONFIDENCE: z.coerce.number().min(0).max(100).default(70),
  CRYPTO_MIN_WINRATE: z.coerce.number().min(0).max(100).default(64),
  PAPER_INITIAL_BALANCE: z.coerce.number().positive().default(100),
  PAPER_ROUND_TRIP_COST_PCT: z.coerce.number().min(0).max(10).default(0.12),

  // R15 dual commodities engine.
  COMMODITY_PAPER_INITIAL_BALANCE: z.coerce.number().positive().default(50),
  COMMODITY_MARGIN_PCT: z.coerce.number().positive().max(10).default(1),
  COMMODITY_REQUESTED_LEVERAGE: z.coerce.number().int().min(1).max(125).default(125),
  COMMODITY_LOOP_MS: z.coerce.number().int().min(500).max(60_000).default(1000),
  COMMODITY_MARKET_REFRESH_MS: z.coerce.number().int().min(500).max(30_000).default(2000),
  // Compatibility alias used only by the retired R12 commodity module so the full TS project still compiles.
  COMMODITY_REFRESH_MS: z.coerce.number().int().min(1000).max(120_000).default(30_000),
  COMMODITY_STREAM_MS: z.coerce.number().int().min(250).max(5000).default(500),
  COMMODITY_MAX_HOLD_SECONDS: z.coerce.number().int().min(30).max(900).default(180),
  COMMODITY_SIGNAL_SCORE_MIN: z.coerce.number().min(35).max(90).default(58),
  COMMODITY_MIN_EDGE_MULTIPLE: z.coerce.number().min(1).max(10).default(2.2),
  COMMODITY_MAX_SPREAD_PCT_XAU: z.coerce.number().positive().max(2).default(0.05),
  COMMODITY_MAX_SPREAD_PCT_CL: z.coerce.number().positive().max(2).default(0.08),
  COMMODITY_TAKER_FEE_PCT_BINANCE: z.coerce.number().min(0).max(1).default(0.05),
  COMMODITY_TAKER_FEE_PCT_ASTER: z.coerce.number().min(0).max(1).default(0.05),
  COMMODITY_SLIPPAGE_PCT: z.coerce.number().min(0).max(1).default(0.01),
  COMMODITY_BACKTEST_MAX_DAYS: z.coerce.number().int().min(7).max(730).default(365),
  COMMODITY_ALLOW_REAL: z.string().default('false').transform((value) => value.trim().toLowerCase() === 'true'),

  // MT5 comparison leg. Spread is always read live from the broker.
  MT5_COMMODITY_MAX_SPREAD_PCT_XAU: z.coerce.number().positive().max(2).default(0.08),
  MT5_COMMODITY_MAX_SPREAD_PCT_CL: z.coerce.number().positive().max(2).default(0.12),
  MT5_COMMODITY_COMMISSION_PCT: z.coerce.number().min(0).max(1).default(0),
  MT5_COMMODITY_SLIPPAGE_PCT: z.coerce.number().min(0).max(1).default(0.005),

  FOREX_SYMBOLS: z.string().default('XAUUSD'),
  FOREX_SIGNAL_SCAN_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(5),
  FOREX_SIGNALS_PER_CYCLE: z.coerce.number().int().min(1).max(20).default(6),
  FOREX_MIN_CONFIDENCE: z.coerce.number().min(0).max(100).default(70),
  FOREX_MIN_WINRATE: z.coerce.number().min(0).max(100).default(64),

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

    cryptoEnabled: false,
    maxConcurrentCryptoTrades: env.CRYPTO_MAX_TRADES,
    cryptoMarginPctPerTrade: env.CRYPTO_MARGIN_PCT,
    cryptoRequestedLeverage: env.CRYPTO_REQUESTED_LEVERAGE,
    cryptoMaxAccountExposurePct: 50,
    cryptoMaxLossPctPerTrade: 1,
    cryptoMinStopPricePct: env.CRYPTO_MIN_STOP_PRICE_PCT,
    cryptoMinTakeProfitPricePct: env.CRYPTO_MIN_TAKE_PROFIT_PRICE_PCT,
    cryptoMinSignalConfidence: env.CRYPTO_MIN_CONFIDENCE,
    cryptoMinRollingWinRate: env.CRYPTO_MIN_WINRATE,
    paperInitialBalance: env.PAPER_INITIAL_BALANCE,
    paperRoundTripCostPct: env.PAPER_ROUND_TRIP_COST_PCT,

    forexEnabled: true,
    forexExecutionMode: 'SIGNAL_ONLY',
    forexSymbols: env.FOREX_SYMBOLS.split(',').map((symbol) => symbol.trim()).filter(Boolean),
    forexSignalScanIntervalMinutes: env.FOREX_SIGNAL_SCAN_INTERVAL_MINUTES,
    forexSignalsPerCycle: env.FOREX_SIGNALS_PER_CYCLE,
    forexMinSignalConfidence: env.FOREX_MIN_CONFIDENCE,
    forexMinRollingWinRate: env.FOREX_MIN_WINRATE,

    maxConcurrentForexTrades: 2,
    forexMaxEntriesPerSymbol: 1,
    forexRiskMode: 'MARGIN_PERCENT',
    forexPctPerTrade: 1,
    forexMagicNumber: 340015,
    forexMaxDeviationPoints: 20,
    forexMaxSpreadPoints: 0,
  };
}