import cors from 'cors';
import express from 'express';
import { z } from 'zod';
import { BinanceUsdmClient } from './binance.js';
import { defaultSettings, env } from './config.js';
import { CryptoExecutionService } from './cryptoExecution.js';
import { TradingDatabase } from './database.js';
import { ForexExecutionService } from './forexExecution.js';
import { calculateMetrics, metricsByStrategy, metricsBySymbol } from './metrics.js';
import { Mt5BridgeClient } from './mt5.js';
import { TradingRepository } from './repositories.js';
import { selectCryptoOpportunities, selectForexOpportunities } from './selection.js';
import { TelegramService } from './telegram.js';
import type { EngineSettings, Opportunity } from './types.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const database = new TradingDatabase(env.DB_PATH);
if (!database.getSettings()) database.saveSettings(defaultSettings());

const getSettings = (): EngineSettings => database.getSettings() ?? defaultSettings();
const repository = new TradingRepository(database);
const telegram = new TelegramService();
const binance = new BinanceUsdmClient(getSettings);
const mt5 = new Mt5BridgeClient(getSettings);
const cryptoExecution = new CryptoExecutionService(database, repository, binance, telegram, getSettings);
const forexExecution = new ForexExecutionService(database, repository, mt5, telegram, getSettings);

const opportunitySchema = z.object({
  id: z.string().min(1),
  signalId: z.string().min(1),
  signalFingerprint: z.string().min(1),
  broker: z.enum(['BINANCE', 'MT5']),
  symbol: z.string().min(1),
  side: z.enum(['BUY', 'SELL']),
  timeframe: z.string().min(1),
  strategy: z.string().min(1),
  confidence: z.number().min(0).max(100),
  rollingWinRate: z.number().min(0).max(100),
  profitFactor: z.number().optional(),
  expectancy: z.number().optional(),
  score: z.number(),
  entry: z.number().positive(),
  stopLoss: z.number().positive(),
  takeProfit: z.number().positive(),
  tp2: z.number().positive().optional(),
  tp3: z.number().positive().optional(),
  createdAt: z.number().int().positive(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const settingsPatchSchema = z.object({
  appMode: z.enum(['PAPER', 'TESTNET', 'REAL']).optional(),
  engineEnabled: z.boolean().optional(),
  cryptoEnabled: z.boolean().optional(),
  // Hard cap from the product rule: never more than 10 simultaneous Binance coins.
  maxConcurrentCryptoTrades: z.number().int().min(1).max(10).optional(),
  cryptoMarginPctPerTrade: z.number().positive().max(100).optional(),
  cryptoRequestedLeverage: z.number().int().min(1).max(125).optional(),
  cryptoMaxAccountExposurePct: z.number().positive().max(100).optional(),
  cryptoMaxLossPctPerTrade: z.number().positive().max(100).optional(),
  cryptoMinSignalConfidence: z.number().min(0).max(100).optional(),
  cryptoMinRollingWinRate: z.number().min(0).max(100).optional(),
  forexEnabled: z.boolean().optional(),
  maxConcurrentForexTrades: z.number().int().min(1).max(200).optional(),
  forexMaxEntriesPerSymbol: z.number().int().min(0).max(50).optional(),
  forexRiskMode: z.enum(['MARGIN_PERCENT', 'RISK_TO_SL']).optional(),
  forexPctPerTrade: z.number().positive().max(100).optional(),
  forexMagicNumber: z.number().int().positive().optional(),
  forexMaxDeviationPoints: z.number().int().min(0).max(1000).optional(),
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'Maquina Trading V34 Backend', mode: getSettings().appMode });
});

app.get('/api/state', async (_req, res) => {
  try {
    const settings = getSettings();
    const trades = database.getRecentTrades(1000);
    const activeCrypto = database.getActiveTrades('BINANCE');
    const activeForex = database.getActiveTrades('MT5');

    const brokerStatus: Record<string, unknown> = {
      telegram: { configured: telegram.isConfigured() },
      binance: { configured: Boolean(env.BINANCE_API_KEY && env.BINANCE_API_SECRET) },
      mt5: { configured: Boolean(env.MT5_BRIDGE_URL) },
    };

    if (settings.appMode !== 'PAPER') {
      const [binanceStatus, mt5Status] = await Promise.allSettled([
        binance.getPositions(),
        mt5.health(),
      ]);
      brokerStatus.binance = binanceStatus.status === 'fulfilled'
        ? { configured: true, connected: true, openPositions: binanceStatus.value.length }
        : { configured: true, connected: false, error: String(binanceStatus.reason) };
      brokerStatus.mt5 = mt5Status.status === 'fulfilled'
        ? { configured: true, connected: true, account: mt5Status.value.account }
        : { configured: true, connected: false, error: String(mt5Status.reason) };
    }

    res.json({
      settings,
      brokerStatus,
      active: {
        crypto: activeCrypto,
        forex: activeForex,
        cryptoUniqueSymbols: [...new Set(activeCrypto.map((trade) => trade.symbol))],
      },
      recentTrades: trades.slice(0, 250),
      metrics: {
        global: calculateMetrics(trades),
        crypto: calculateMetrics(trades, 'BINANCE'),
        forex: calculateMetrics(trades, 'MT5'),
        cryptoBySymbol: metricsBySymbol(trades, 'BINANCE'),
        forexBySymbol: metricsBySymbol(trades, 'MT5'),
        cryptoByStrategy: metricsByStrategy(trades, 'BINANCE'),
        forexByStrategy: metricsByStrategy(trades, 'MT5'),
      },
      opportunities: {
        crypto: loadTopOpportunities('BINANCE', 10),
        forex: loadTopOpportunities('MT5', 20),
      },
    });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.patch('/api/settings', (req, res) => {
  try {
    const patch = settingsPatchSchema.parse(req.body);
    const next: EngineSettings = { ...getSettings(), ...patch };
    database.saveSettings(next);
    res.json({ ok: true, settings: next });
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
  }
});

app.post('/api/engine/start', (_req, res) => {
  const settings = { ...getSettings(), engineEnabled: true };
  database.saveSettings(settings);
  res.json({ ok: true, engineEnabled: true });
});

app.post('/api/engine/pause', (_req, res) => {
  const settings = { ...getSettings(), engineEnabled: false };
  database.saveSettings(settings);
  void telegram.alert('MOTOR PAUSADO', 'Se bloquearon nuevas entradas. Las posiciones existentes continúan con sus SL/TP.').catch(() => undefined);
  res.json({ ok: true, engineEnabled: false });
});

app.post('/api/emergency-stop', (_req, res) => {
  const settings = { ...getSettings(), engineEnabled: false };
  database.saveSettings(settings);
  database.db.prepare(`
    INSERT INTO engine_state(key, value, updated_at)
    VALUES('emergencyStop', 'true', ?)
    ON CONFLICT(key) DO UPDATE SET value='true', updated_at=excluded.updated_at
  `).run(Date.now());
  void telegram.alert('EMERGENCY STOP', 'Nuevas entradas bloqueadas inmediatamente. El cierre masivo de posiciones se implementará/validará por broker antes de habilitar REAL.').catch(() => undefined);
  res.json({ ok: true, engineEnabled: false, emergencyStop: true });
});

app.post('/api/opportunities/ingest', async (req, res) => {
  try {
    const body = z.object({
      opportunities: z.array(opportunitySchema).min(1).max(1000),
      autoExecute: z.boolean().default(true),
    }).parse(req.body);

    const opportunities = body.opportunities as Opportunity[];
    for (const opportunity of opportunities) repository.saveSignal(opportunity);

    const settings = getSettings();
    const activeTrades = database.getActiveTrades();
    const ctx = {
      maxCryptoTrades: Math.min(10, settings.maxConcurrentCryptoTrades),
      maxForexTrades: settings.maxConcurrentForexTrades,
      forexMaxEntriesPerSymbol: settings.forexMaxEntriesPerSymbol,
      activeTrades,
    };

    const eligibleCrypto = opportunities.filter((opportunity) =>
      opportunity.broker === 'BINANCE' &&
      opportunity.confidence >= settings.cryptoMinSignalConfidence &&
      opportunity.rollingWinRate >= settings.cryptoMinRollingWinRate
    );
    const eligibleForex = opportunities.filter((opportunity) => opportunity.broker === 'MT5');

    const selectedCrypto = selectCryptoOpportunities(eligibleCrypto, ctx);
    const selectedForex = selectForexOpportunities(eligibleForex, ctx);

    const executionResults: Array<Record<string, unknown>> = [];
    if (body.autoExecute && settings.engineEnabled) {
      for (const opportunity of selectedCrypto) {
        try {
          const trade = await cryptoExecution.execute(opportunity);
          executionResults.push({ opportunityId: opportunity.id, broker: 'BINANCE', ok: true, tradeId: trade.id });
        } catch (error) {
          executionResults.push({ opportunityId: opportunity.id, broker: 'BINANCE', ok: false, error: errorMessage(error) });
        }
      }

      // Forex deliberately stays sequential too. Retests can repeat the pair,
      // while each trade receives its own MT5 ticket and signal fingerprint.
      for (const opportunity of selectedForex) {
        try {
          const trade = await forexExecution.execute(opportunity);
          executionResults.push({ opportunityId: opportunity.id, broker: 'MT5', ok: true, tradeId: trade.id });
        } catch (error) {
          executionResults.push({ opportunityId: opportunity.id, broker: 'MT5', ok: false, error: errorMessage(error) });
        }
      }
    }

    res.json({
      ok: true,
      received: opportunities.length,
      selected: {
        crypto: selectedCrypto,
        forex: selectedForex,
      },
      executionResults,
    });
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
  }
});

function loadTopOpportunities(broker: 'BINANCE' | 'MT5', limit: number): Opportunity[] {
  const rows = database.db.prepare(`
    SELECT payload FROM opportunities
    WHERE broker = ? AND executable = 1
    ORDER BY score DESC, created_at DESC
    LIMIT ?
  `).all(broker, limit) as Array<{ payload: string }>;

  const parsed = rows.map((row) => JSON.parse(row.payload) as Opportunity);
  if (broker === 'BINANCE') {
    const best = new Map<string, Opportunity>();
    for (const opportunity of parsed) {
      const current = best.get(opportunity.symbol);
      if (!current || opportunity.score > current.score) best.set(opportunity.symbol, opportunity);
    }
    return [...best.values()].sort((a, b) => b.score - a.score).slice(0, Math.min(10, limit));
  }
  return parsed;
}

function errorMessage(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  return error instanceof Error ? error.message : String(error);
}

app.listen(env.PORT, () => {
  console.log(`[V34] backend listening on http://127.0.0.1:${env.PORT}`);
  console.log(`[V34] mode=${getSettings().appMode} engine=${getSettings().engineEnabled ? 'ON' : 'OFF'}`);
});
