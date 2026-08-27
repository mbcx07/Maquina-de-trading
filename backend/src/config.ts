import 'dotenv/config';
import { z } from 'zod';
import type { EngineSettings } from './types.js';

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  APP_MODE: z.enum(['PAPER', 'TESTNET', 'REAL']).default('PAPER'),
  DB_PATH: z.string().default('./data/trading-v34.sqlite'),

  BINANCE_API_KEY: z.string().default(''),
  BINANCE_API_SECRET: z.string().default(''),
  BINANCE_BASE_URL: z.string().url().default('https://fapi.binance.com'),
  BINANCE_TESTNET_BASE_URL: z.string().url().default('https://testnet.binancefuture.com'),

  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_CHAT_ID: z.string().default(''),

  MT5_BRIDGE_URL: z.string().url().default('http://127.0.0.1:8790'),
  MT5_BRIDGE_TOKEN: z.string().default(''),

  CRYPTO_MAX_TRADES: z.coerce.number().int().min(1).max(50).default(10),
  CRYPTO_MARGIN_PCT: z.coerce.number().positive().max(100).default(1),
  CRYPTO_REQUESTED_LEVERAGE: z.coerce.number().int().min(1).max(125).default(20),
  CRYPTO_MIN_CONFIDENCE: z.coerce.number().min(0).max(100).default(75),
  CRYPTO_MIN_WINRATE: z.coerce.number().min(0).max(100).default(75),
  FOREX_MAX_TRADES: z.coerce.number().int().min(1).max(200).default(20),
  FOREX_MAX_ENTRIES_PER_SYMBOL: z.coerce.number().int().min(0).max(50).default(0),
});

export const env = envSchema.parse(process.env);

export function defaultSettings(): EngineSettings {
  return {
    appMode: env.APP_MODE,
    engineEnabled: false,

    cryptoEnabled: true,
    maxConcurrentCryptoTrades: env.CRYPTO_MAX_TRADES,
    cryptoMarginPctPerTrade: env.CRYPTO_MARGIN_PCT,
    cryptoRequestedLeverage: env.CRYPTO_REQUESTED_LEVERAGE,
    cryptoMaxAccountExposurePct: 50,
    cryptoMaxLossPctPerTrade: 1,
    cryptoMinSignalConfidence: env.CRYPTO_MIN_CONFIDENCE,
    cryptoMinRollingWinRate: env.CRYPTO_MIN_WINRATE,

    forexEnabled: true,
    maxConcurrentForexTrades: env.FOREX_MAX_TRADES,
    forexMaxEntriesPerSymbol: env.FOREX_MAX_ENTRIES_PER_SYMBOL,
    forexRiskMode: 'RISK_TO_SL',
    forexPctPerTrade: 1,
    forexMagicNumber: 340034,
    forexMaxDeviationPoints: 20,
  };
}
