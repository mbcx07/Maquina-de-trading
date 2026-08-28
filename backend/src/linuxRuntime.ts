import express from 'express';
import cors from 'cors';
import { z } from 'zod';
import { env, defaultSettings } from './config.js';
import { TradingDatabase } from './database.js';
import { BinanceFuturesClient } from './binance.js';
import { BinanceMarketDataClient } from './binanceMarket.js';
import { CryptoExecutionService } from './cryptoExecution.js';
import { TelegramService } from './telegram.js';
import { TradingRepository } from './repositories.js';
import { OpportunityOrchestrator } from './orchestrator.js';
import { ReconciliationService } from './reconciler.js';
import { RiskGuard } from './riskGuard.js';
import { EmergencyStopService } from './emergencyStop.js';
import { CryptoMarketScanner } from './cryptoScanner.js';
import { ForexMarketScanner } from './forexScanner.js';
import { ForexDataClient } from './forexData.js';
import { MetricsService } from './metrics.js';
import { PaperBrokerService } from './paperBroker.js';
import { HistoricalBacktestService } from './historicalBacktest.js';
import {
  IntegrationVault,
  type BinanceCredentials,
  type TelegramCredentials,
  type TwelveDataCredentials,
} from './integrationVault.js';
import { registerIntegrationRoutes } from './integrationRoutes.js';
import type { EngineSettings, Opportunity } from './types.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const database = new TradingDatabase(env.DB_PATH);
const vault = new IntegrationVault(database, env.DEFAULT_WORKSPACE_ID, env.INTEGRATION_MASTER_KEY, env.LOCAL_VAULT_KEY_PATH);
vault.migrateEnvCredentials({
  binance: env.BINANCE_API_KEY && env.BINANCE_API_SECRET ? { apiKey: env.BINANCE_API_KEY, apiSecret: env.BINANCE_API_SECRET } : null,
  telegram: env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID ? { botToken: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID } : null,
});

const getSettings = (): EngineSettings => {
  const settings = database.getSettings() ?? defaultSettings();
  if (settings.forexExecutionMode !== 'SIGNAL_ONLY') {
    const next = { ...settings, forexExecutionMode: 'SIGNAL_ONLY' as const };
    database.saveSettings(next);
    return next;
  }
  return settings;
};
const saveSettings = (settings: EngineSettings): void => database.saveSettings({ ...settings, forexExecutionMode: 'SIGNAL_ONLY' });

const binance = new BinanceFuturesClient(getSettings, () => vault.get<BinanceCredentials>('BINANCE'));
const binanceMarket = new BinanceMarketDataClient(getSettings);
const telegram = new TelegramService(() => vault.get<TelegramCredentials>('TELEGRAM'));
const forexData = new ForexDataClient(() => vault.get<TwelveDataCredentials>('TWELVE_DATA'));
const repository = new TradingRepository(database);
const metrics = new MetricsService(database);
const cryptoExecution = new CryptoExecutionService(database, binance, repository, telegram, getSettings);
const orchestrator = new OpportunityOrchestrator(database, repository, cryptoExecution, getSettings);
const reconciler = new ReconciliationService(database, binance, repository, telegram, getSettings);
const paperBroker = new PaperBrokerService(database, binanceMarket, repository, telegram, metrics, getSettings);
const riskGuard = new RiskGuard(database, metrics, getSettings);
const emergencyStop = new EmergencyStopService(database, binance, telegram, getSettings, saveSettings);
const cryptoScanner = new CryptoMarketScanner(database, binanceMarket, orchestrator, getSettings);
const forexScanner = new ForexMarketScanner(database, forexData, repository, telegram, getSettings);
const historicalBacktest = new HistoricalBacktestService(database, binanceMarket);

const settingsPatchSchema = z.object({
  appMode: z.enum(['PAPER', 'TESTNET', 'REAL']).optional(),
  engineEnabled: z.boolean().optional(),
  riskKillSwitchEnabled: z.boolean().optional(),
  dailyLossLimitPct: z.number().positive().max(100).optional(),
  maxDrawdownPct: z.number().positive().max(100).optional(),
  emergencyStopMode: z.enum(['PAUSE_ONLY', 'CLOSE_ALL']).optional(),
  cryptoEnabled: z.boolean().optional(),
  maxConcurrentCryptoTrades: z.number().int().min(1).max(10).optional(),
  cryptoMarginPctPerTrade: z.number().positive().max(100).optional(),
  cryptoRequestedLeverage: z.number().int().min(1).max(125).optional(),
  cryptoMaxAccountExposurePct: z.number().positive().max(100).optional(),
  cryptoMaxLossPctPerTrade: z.number().positive().max(100).optional(),
  cryptoMinStopPricePct: z.number().positive().max(25).optional(),
  cryptoMinTakeProfitPricePct: z.number().positive().max(50).optional(),
  cryptoMinSignalConfidence: z.number().min(0).max(100).optional(),
  cryptoMinRollingWinRate: z.number().min(0).max(100).optional(),
  paperInitialBalance: z.number().positive().optional(),
  paperRoundTripCostPct: z.number().min(0).max(10).optional(),
  forexEnabled: z.boolean().optional(),
  forexExecutionMode: z.literal('SIGNAL_ONLY').optional(),
  forexSymbols: z.array(z.string().min(3).max(32)).min(1).max(100).optional(),
  forexSignalScanIntervalMinutes: z.number().int().min(1).max(1440).optional(),
  forexSignalsPerCycle: z.number().int().min(1).max(20).optional(),
  forexMinSignalConfidence: z.number().min(0).max(100).optional(),
  forexMinRollingWinRate: z.number().min(0).max(100).optional(),
  maxConcurrentForexTrades: z.number().int().min(1).max(100).optional(),
  forexMaxEntriesPerSymbol: z.number().int().min(0).max(20).optional(),
  forexRiskMode: z.enum(['RISK_TO_SL', 'FIXED_LOT']).optional(),
  forexPctPerTrade: z.number().positive().max(100).optional(),
  forexMagicNumber: z.number().int().optional(),
  forexMaxDeviationPoints: z.number().int().min(0).optional(),
  forexMaxSpreadPoints: z.number().min(0).optional(),
});

const opportunitySchema = z.object({
  id: z.string(), signalId: z.string(), signalFingerprint: z.string(), broker: z.enum(['BINANCE', 'MT5']), symbol: z.string(),
  side: z.enum(['BUY', 'SELL']), timeframe: z.string(), strategy: z.string(), confidence: z.number(), rollingWinRate: z.number(),
  expectancy: z.number(), score: z.number(), entry: z.number().positive(), stopLoss: z.number().positive(), takeProfit: z.number().positive(),
  tp2: z.number().positive().optional(), tp3: z.number().positive().optional(), createdAt: z.number(), metadata: z.record(z.unknown()).optional(),
});

const backtestSchema = z.object({
  broker: z.literal('BINANCE'),
  symbols: z.array(z.string().min(3).max(32)).min(1).max(25),
  startTime: z.number().int().positive(),
  endTime: z.number().int().positive(),
  initialBalance: z.number().positive().default(1000),
  allocationPct: z.number().positive().max(100).default(1),
  leverage: z.number().positive().max(125).default(20),
  roundTripCostPct: z.number().min(0).max(10).default(0.12),
  scanStepMinutes: z.number().int().min(1).max(1440).default(5),
  maxHoldMinutes: z.number().int().min(1).max(10080).default(45),
  sizingMode: z.enum(['MARGIN_PERCENT', 'RISK_TO_SL']).default('MARGIN_PERCENT'),
});

app.get('/health', (_req, res) => res.json({
  ok: true,
  version: '0.3.0',
  edition: 'BINANCE_AUTO_FOREX_SIGNAL_ONLY',
  platform: 'linux',
  forexExecution: 'SIGNAL_ONLY',
  mt5: 'NOT_REQUIRED',
  at: Date.now(),
}));

app.get('/api/state', async (_req, res) => {
  const settings = getSettings();
  const allTrades = database.getAllTrades();
  const modeCryptoTrades = allTrades.filter((trade) => trade.broker === 'BINANCE' && (trade.executionMode ?? 'REAL') === settings.appMode);
  const activeCrypto = modeCryptoTrades.filter((trade) => ['PENDING', 'OPENING', 'OPEN', 'CLOSING', 'SYNC_REQUIRED'].includes(trade.state));
  const cryptoHistory = modeCryptoTrades.filter((trade) => ['CLOSED', 'REJECTED', 'ERROR'].includes(trade.state)).slice(0, 500);
  const paper = paperBroker.getSummary();

  let binanceState: Record<string, unknown> = { configured: false, connected: false, mode: settings.appMode };
  if (settings.appMode === 'PAPER') {
    const activeMargin = paper.activeTrades.reduce((sum, trade) => sum + Math.max(0, Number(trade.marginUsed || 0)), 0);
    binanceState = {
      configured: true, connected: true, mode: 'PAPER', paper: true, asset: 'USDT',
      balance: paper.balance, availableBalance: Math.max(0, paper.balance - activeMargin), equity: paper.equity,
      openPositions: paper.activeTrades.length,
    };
  } else if (binance.isConfigured()) {
    try {
      const [account, positionMode] = await Promise.all([binance.getAccount(), binance.getPositionMode()]);
      const usdt = account.assets?.find((asset) => asset.asset === 'USDT');
      binanceState = {
        configured: true, connected: true, mode: settings.appMode, asset: 'USDT',
        balance: Number(usdt?.walletBalance ?? 0), availableBalance: Number(usdt?.availableBalance ?? account.availableBalance ?? 0),
        totalWalletBalance: account.totalWalletBalance, totalMarginBalance: account.totalMarginBalance,
        totalUnrealizedProfit: account.totalUnrealizedProfit, dualSidePosition: Boolean(positionMode.dualSidePosition),
      };
    } catch (error) {
      binanceState = { configured: true, connected: false, mode: settings.appMode, error: errorMessage(error) };
    }
  }

  const forexCredential = vault.getState('TWELVE_DATA');
  const telegramCredential = vault.getState('TELEGRAM');
  const forexDataState = {
    provider: 'TWELVE_DATA',
    configured: forexCredential.configured,
    connected: forexCredential.lastTestOk === true,
    optional: true,
    status: !forexCredential.configured ? 'PENDING' : forexCredential.lastTestOk === true ? 'CONNECTED' : forexCredential.lastTestOk === false ? 'ERROR' : 'CONFIGURED_UNTESTED',
    masked: forexCredential.masked,
    usage: forexData.getUsage(),
    lastTestAt: forexCredential.lastTestAt,
    lastError: forexCredential.lastError,
  };

  res.json({
    ok: true,
    settings,
    brokerStatus: {
      binance: binanceState,
      forexData: forexDataState,
      telegram: {
        configured: telegramCredential.configured,
        connected: telegramCredential.lastTestOk === true,
        optional: true,
        masked: telegramCredential.masked,
        lastTestAt: telegramCredential.lastTestAt,
        lastError: telegramCredential.lastError,
      },
    },
    scanners: {
      crypto: loadEngineState('cryptoScanner'),
      forex: loadEngineState('forexScanner'),
      paper: loadEngineState('paperBroker'),
    },
    paper,
    crypto: {
      active: activeCrypto,
      history: cryptoHistory,
      metrics: metrics.fromTrades(modeCryptoTrades),
      topOpportunities: loadTopCryptoOpportunities(10),
    },
    forex: {
      signals: loadForexSignals(50),
      stats: loadForexSignalStats(),
      performance: loadEngineState('forexSignalPerformance'),
    },
    forexDiagnostics: loadForexDiagnostics(),
    risk: await riskGuard.evaluate(),
    integrations: vault.listStates(),
    at: Date.now(),
  });
});

app.patch('/api/settings', (req, res) => {
  try {
    const patch = settingsPatchSchema.parse(req.body);
    const current = getSettings();
    const next = { ...current, ...patch, forexExecutionMode: 'SIGNAL_ONLY' as const };
    saveSettings(next);
    res.json({ ok: true, settings: next });
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
  }
});

app.post('/api/engine/start', async (_req, res) => {
  try {
    const settings = getSettings();
    if (!settings.cryptoEnabled && !settings.forexEnabled) return res.status(400).json({ error: 'NO_DESK_ENABLED' });
    if (settings.cryptoEnabled && settings.appMode !== 'PAPER') {
      if (!binance.isConfigured()) return res.status(400).json({ error: 'BINANCE_REQUIRED_FOR_CRYPTO_MODE' });
      const test = await binance.testConnection();
      if (!test.ok) return res.status(400).json({ error: 'BINANCE_CONNECTION_FAILED' });
    }
    if (settings.appMode === 'REAL' && !settings.riskKillSwitchEnabled) return res.status(400).json({ error: 'REAL_MODE_REQUIRES_RISK_KILL_SWITCH' });
    saveSettings({ ...settings, engineEnabled: true, forexExecutionMode: 'SIGNAL_ONLY' });
    res.json({ ok: true, settings: getSettings() });
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
  }
});

app.post('/api/engine/stop', (_req, res) => {
  const settings = getSettings();
  saveSettings({ ...settings, engineEnabled: false, forexExecutionMode: 'SIGNAL_ONLY' });
  res.json({ ok: true, settings: getSettings() });
});

app.post('/api/emergency-stop', async (_req, res) => {
  try {
    res.json({ ok: true, ...(await emergencyStop.trigger('API_REQUEST')) });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

registerIntegrationRoutes(app, {
  vault,
  binance,
  telegram,
  forexData,
  onForexReady: async () => {
    if (getSettings().engineEnabled) await forexScanner.runCycle();
  },
});

app.post('/api/reconcile', async (_req, res) => {
  try {
    await reconciler.runOnce();
    await paperBroker.runOnce();
    res.json({ ok: true, reconciledAt: Date.now(), riskGuard: await riskGuard.evaluate(), paper: paperBroker.getSummary() });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.post('/api/paper/trades/:id/close', async (req, res) => {
  try {
    const trade = await paperBroker.closeTradeManually(String(req.params.id));
    res.json({ ok: true, trade, paper: paperBroker.getSummary() });
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
  }
});

app.post('/api/scanners/crypto/run', async (_req, res) => {
  try {
    await cryptoScanner.runCycle();
    res.json({ ok: true, scanner: loadEngineState('cryptoScanner') });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.post('/api/scanners/forex/run', async (_req, res) => {
  try {
    // Explicit diagnostic/manual scan is allowed with Engine OFF. It still remains
    // SIGNAL_ONLY and never sends an order to MT5/Forex.
    await forexScanner.runCycle(true);
    res.json({ ok: true, scanner: loadEngineState('forexScanner'), diagnostics: loadForexDiagnostics() });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.get('/api/backtests', (req, res) => {
  const limit = Number(req.query.limit ?? 20);
  const runs = historicalBacktest.list(limit).filter((run: any) => run.broker === 'BINANCE').map((run: any) => ({
    ...run,
    result: run.result
      ? {
          metrics: run.result.metrics,
          inSample: run.result.inSample,
          outOfSample: run.result.outOfSample,
          candidates: run.result.candidates,
          completedAt: run.result.completedAt,
        }
      : null,
  }));
  res.json({ ok: true, runs });
});

app.get('/api/backtests/:id', (req, res) => {
  const run = historicalBacktest.get(String(req.params.id));
  if (!run || run.broker !== 'BINANCE') return res.status(404).json({ error: 'BACKTEST_NOT_FOUND' });
  res.json({ ok: true, run });
});

app.post('/api/backtests', (req, res) => {
  try {
    const body = backtestSchema.parse(req.body);
    const id = historicalBacktest.create(body);
    res.status(202).json({ ok: true, id, run: historicalBacktest.get(id) });
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
  }
});

app.post('/api/opportunities/ingest', async (req, res) => {
  try {
    const body = z.object({
      opportunities: z.array(opportunitySchema).min(1).max(1000),
      autoExecute: z.boolean().default(true),
    }).parse(req.body);
    res.json({ ok: true, ...(await orchestrator.process(body.opportunities as Opportunity[], body.autoExecute)) });
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
  }
});

function loadTopCryptoOpportunities(limit: number): Opportunity[] {
  const rows = database.db.prepare(`
    SELECT payload FROM opportunities
    WHERE broker = 'BINANCE' AND executable = 1 AND created_at >= ?
    ORDER BY score DESC, created_at DESC LIMIT ?
  `).all(Date.now() - 15 * 60_000, Math.max(limit * 25, 100)) as Array<{ payload: string }>;

  const mode = getSettings().appMode;
  const activeSymbols = new Set(database.getActiveTrades('BINANCE')
    .filter((trade) => (trade.executionMode ?? 'REAL') === mode)
    .map((trade) => trade.symbol));
  const best = new Map<string, Opportunity>();
  for (const row of rows) {
    const opportunity = JSON.parse(row.payload) as Opportunity;
    if (activeSymbols.has(opportunity.symbol)) continue;
    const current = best.get(opportunity.symbol);
    if (!current || opportunity.score > current.score) best.set(opportunity.symbol, opportunity);
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, Math.min(10, limit));
}

function loadForexSignals(limit: number): Opportunity[] {
  const rows = database.db.prepare(`
    SELECT payload FROM opportunities
    WHERE broker = 'MT5' AND rejection_reason = 'FOREX_SIGNAL_ONLY_MANUAL_EXECUTION'
    ORDER BY created_at DESC LIMIT ?
  `).all(Math.max(1, Math.min(200, limit))) as Array<{ payload: string }>;
  return rows.map((row) => JSON.parse(row.payload) as Opportunity);
}

function loadForexSignalStats(): Record<string, number> {
  const dayAgo = Date.now() - 24 * 60 * 60_000;
  const weekAgo = Date.now() - 7 * 24 * 60_000;
  const sent24h = Number((database.db.prepare(`
    SELECT COUNT(*) AS n FROM telegram_events
    WHERE event_type='FOREX_SIGNAL' AND status='SENT' AND created_at >= ?
  `).get(dayAgo) as { n: number }).n);
  const sent7d = Number((database.db.prepare(`
    SELECT COUNT(*) AS n FROM telegram_events
    WHERE event_type='FOREX_SIGNAL' AND status='SENT' AND created_at >= ?
  `).get(weekAgo) as { n: number }).n);
  return { sent24h, sent7d };
}

function loadForexDiagnostics(): Array<Record<string, unknown>> {
  const rows = database.db.prepare(`
    SELECT key, value, updated_at FROM engine_state
    WHERE key LIKE 'forexScannerError:%'
    ORDER BY updated_at DESC LIMIT 20
  `).all() as Array<{ key: string; value: string; updated_at: number }>;
  return rows.map((row) => {
    try { return { key: row.key, ...JSON.parse(row.value), updatedAt: row.updated_at }; }
    catch { return { key: row.key, error: row.value, updatedAt: row.updated_at }; }
  });
}

function loadEngineState(key: string): any {
  const row = database.db.prepare(`SELECT value FROM engine_state WHERE key=?`).get(key) as { value: string } | undefined;
  if (!row) return {};
  try { return JSON.parse(row.value); }
  catch { return { status: 'INVALID_STATE', raw: row.value }; }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

cryptoScanner.start();
forexScanner.start();

const monitor = setInterval(async () => {
  try { await reconciler.runOnce(); } catch (error) { console.error('[V34] reconcile:', errorMessage(error)); }
  try { await paperBroker.runOnce(); } catch (error) { console.error('[V34] paper:', errorMessage(error)); }
  try {
    const risk = await riskGuard.evaluate();
    if (risk.triggered && getSettings().riskKillSwitchEnabled) {
      saveSettings({ ...getSettings(), engineEnabled: false, forexExecutionMode: 'SIGNAL_ONLY' });
      await telegram.systemAlert(`Risk guard triggered: ${risk.reason}`);
    }
  } catch (error) { console.error('[V34] risk guard:', errorMessage(error)); }
}, 10_000);
monitor.unref();

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

function shutdown(signal: string): void {
  console.log(`[V34] ${signal}; closing services.`);
  clearInterval(monitor);
  cryptoScanner.stop();
  forexScanner.stop();
  database.close();
  process.exit(0);
}

app.listen(env.PORT, () => console.log(`[V34] Linux runtime listening on :${env.PORT} | Binance AUTO + Forex SIGNAL_ONLY`));
