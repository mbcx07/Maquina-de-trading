import cors from 'cors';
import express from 'express';
import { z } from 'zod';
import { BinanceUsdmClient } from './binance.js';
import { BinanceMarketDataClient } from './binanceMarket.js';
import { defaultSettings, env } from './config.js';
import { CryptoExecutionService } from './cryptoExecution.js';
import { CryptoMarketScanner } from './cryptoScanner.js';
import { TradingDatabase } from './database.js';
import { EmergencyStopService } from './emergencyStop.js';
import { ForexDataClient } from './forexData.js';
import { ForexMarketScanner } from './forexScanner.js';
import { HistoricalBacktestService } from './historicalBacktest.js';
import { createIntegrationRouter } from './integrationRoutes.js';
import { IntegrationVault, normalizeWorkspaceId } from './integrationVault.js';
import { calculateMetrics, metricsByStrategy, metricsBySymbol } from './metrics.js';
import { Mt5BridgeClient } from './mt5.js';
import { OpportunityOrchestrator } from './orchestrator.js';
import { PaperBrokerService } from './paperBroker.js';
import { PositionReconciler } from './reconciler.js';
import { TradingRepository } from './repositories.js';
import { PortfolioRiskGuard } from './riskGuard.js';
import { TelegramService } from './telegram.js';
import type { EngineSettings, Opportunity } from './types.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const database = new TradingDatabase(env.DB_PATH);
const normalizedInitialSettings: EngineSettings = {
  ...defaultSettings(),
  ...(database.getSettings() ?? {}),
  forexExecutionMode: 'SIGNAL_ONLY',
};
database.saveSettings(normalizedInitialSettings);

const getSettings = (): EngineSettings => ({
  ...defaultSettings(),
  ...(database.getSettings() ?? {}),
  forexExecutionMode: 'SIGNAL_ONLY',
});

const workspaceId = normalizeWorkspaceId(env.DEFAULT_WORKSPACE_ID);
const vault = new IntegrationVault(database);
const repository = new TradingRepository(database);
const telegram = new TelegramService(() => vault.getTelegram(workspaceId));
const binance = new BinanceUsdmClient(getSettings, () => vault.getBinance(workspaceId));
const binanceMarket = new BinanceMarketDataClient(getSettings);
const forexData = new ForexDataClient(() => vault.getTwelveData(workspaceId));
const cryptoExecution = new CryptoExecutionService(database, repository, binance, telegram, getSettings);
const orchestrator = new OpportunityOrchestrator(database, repository, cryptoExecution, getSettings);
const reconciler = new PositionReconciler(database, repository, binance, telegram, getSettings);
const riskGuard = new PortfolioRiskGuard(database, telegram, getSettings);
const emergencyStop = new EmergencyStopService(database, repository, binance, telegram, getSettings);
const cryptoScanner = new CryptoMarketScanner(database, binanceMarket, orchestrator, getSettings);
const forexScanner = new ForexMarketScanner(database, forexData, repository, telegram, getSettings);
const paperBroker = new PaperBrokerService(database, repository, binanceMarket, telegram, getSettings);

// Historical V34 currently remains Binance-only in the Linux UI. The legacy HTTP
// MT5 client is passed only to preserve the existing backtest class signature and
// does not connect unless an old MT5 backtest is explicitly invoked.
const legacyMt5 = new Mt5BridgeClient(getSettings);
const historicalBacktest = new HistoricalBacktestService(database, binanceMarket, legacyMt5, getSettings);

app.use('/api/integrations', createIntegrationRouter(vault, getSettings, () => workspaceId));

const opportunitySchema = z.object({
  id: z.string().min(1), signalId: z.string().min(1), signalFingerprint: z.string().min(1),
  broker: z.enum(['BINANCE', 'MT5']), symbol: z.string().min(1), side: z.enum(['BUY', 'SELL']),
  timeframe: z.string().min(1), strategy: z.string().min(1), confidence: z.number().min(0).max(100),
  rollingWinRate: z.number().min(0).max(100), profitFactor: z.number().optional(), expectancy: z.number().optional(),
  score: z.number(), entry: z.number().positive(), stopLoss: z.number().positive(), takeProfit: z.number().positive(),
  tp2: z.number().positive().optional(), tp3: z.number().positive().optional(), createdAt: z.number().int().positive(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const settingsPatchSchema = z.object({
  appMode: z.enum(['PAPER', 'TESTNET', 'REAL']).optional(),
  engineEnabled: z.boolean().optional(),
  riskKillSwitchEnabled: z.boolean().optional(),
  dailyLossLimitPct: z.number().positive().max(100).optional(),
  maxDrawdownPct: z.number().positive().max(100).optional(),
  emergencyStopMode: z.enum(['PAUSE_ONLY', 'CLOSE_TRACKED']).optional(),

  cryptoEnabled: z.boolean().optional(),
  maxConcurrentCryptoTrades: z.number().int().min(1).max(10).optional(),
  cryptoMarginPctPerTrade: z.number().positive().max(100).optional(),
  cryptoRequestedLeverage: z.number().int().min(1).max(125).optional(),
  cryptoMaxAccountExposurePct: z.number().positive().max(100).optional(),
  cryptoMaxLossPctPerTrade: z.number().positive().max(100).optional(),
  cryptoMinSignalConfidence: z.number().min(0).max(100).optional(),
  cryptoMinRollingWinRate: z.number().min(0).max(100).optional(),
  paperInitialBalance: z.number().positive().max(1000000000).optional(),
  paperRoundTripCostPct: z.number().min(0).max(10).optional(),

  forexEnabled: z.boolean().optional(),
  forexSymbols: z.array(z.string().min(1)).min(1).max(50).optional(),
  forexSignalScanIntervalMinutes: z.number().int().min(1).max(1440).optional(),
  forexSignalsPerCycle: z.number().int().min(1).max(20).optional(),
  forexMinSignalConfidence: z.number().min(0).max(100).optional(),
  forexMinRollingWinRate: z.number().min(0).max(100).optional(),
});

const backtestSchema = z.object({
  broker: z.literal('BINANCE'),
  symbols: z.array(z.string().min(1)).min(1).max(25),
  startTime: z.number().int().positive(),
  endTime: z.number().int().positive(),
  initialBalance: z.number().positive().default(1000),
  allocationPct: z.number().positive().max(100).default(1),
  leverage: z.number().min(1).max(125).default(20),
  roundTripCostPct: z.number().min(0).max(10).default(0.12),
  scanStepMinutes: z.number().int().min(1).max(60).default(3),
  maxHoldMinutes: z.number().int().min(1).max(1440).default(90),
  sizingMode: z.enum(['MARGIN_PERCENT', 'RISK_TO_SL']).default('MARGIN_PERCENT'),
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'Quantum Dual V34 Linux',
    edition: 'BINANCE_AUTO_FOREX_SIGNAL_ONLY',
    mode: getSettings().appMode,
    workspaceId,
  });
});

app.get('/api/state', async (_req, res) => {
  try {
    const settings = getSettings();
    const allBinanceTrades = database.getRecentTrades(5000).filter((trade) => trade.broker === 'BINANCE');
    const modeTrades = allBinanceTrades.filter((trade) => (trade.executionMode ?? 'REAL') === settings.appMode);
    const activeCrypto = database.getActiveTrades('BINANCE')
      .filter((trade) => (trade.executionMode ?? 'REAL') === settings.appMode);
    const paper = paperBroker.getSummary();
    const integrationStatuses = vault.getStatus(workspaceId);
    const binanceIntegration = integrationStatuses.find((item) => item.provider === 'BINANCE');
    const telegramIntegration = integrationStatuses.find((item) => item.provider === 'TELEGRAM');
    const forexDataIntegration = integrationStatuses.find((item) => item.provider === 'TWELVE_DATA');

    const brokerStatus: Record<string, unknown> = {
      telegram: {
        configured: telegram.isConfigured(),
        connected: telegramIntegration?.lastTestOk === true,
        masked: telegramIntegration?.maskedPrimary,
        lastError: telegramIntegration?.lastError,
      },
      binance: {
        configured: binance.hasCredentials(),
        connected: binanceIntegration?.lastTestOk === true,
        masked: binanceIntegration?.maskedPrimary,
        lastError: binanceIntegration?.lastError,
      },
      forexData: {
        provider: 'TWELVE_DATA',
        configured: forexData.hasCredentials(),
        connected: forexDataIntegration?.lastTestOk === true,
        optional: true,
        status: !forexData.hasCredentials()
          ? 'PENDING'
          : forexDataIntegration?.lastTestOk === true
            ? 'CONNECTED'
            : forexDataIntegration?.lastTestOk === false
              ? 'ERROR'
              : 'CONFIGURED_UNTESTED',
        masked: forexDataIntegration?.maskedPrimary,
        usage: forexData.getUsage(),
        lastTestAt: forexDataIntegration?.lastTestAt,
        lastError: forexDataIntegration?.lastError,
      },
    };

    if (settings.appMode === 'PAPER') {
      const allocatedMargin = paper.activeTrades.reduce((sum, trade) => sum + Math.max(0, Number(trade.marginUsed ?? 0)), 0);
      brokerStatus.binance = {
        configured: true,
        connected: true,
        paper: true,
        asset: 'USDT',
        balance: paper.balance,
        availableBalance: Math.max(0, paper.balance - allocatedMargin),
        equity: paper.equity,
        openPositions: paper.activeTrades.length,
      };
    } else if (settings.cryptoEnabled && binance.hasCredentials()) {
      try {
        const [positions, balance, availableBalance] = await Promise.all([
          binance.getPositions(),
          binance.getFuturesBalance(),
          binance.getAvailableBalance(),
        ]);
        brokerStatus.binance = {
          configured: true,
          connected: true,
          asset: 'USDT',
          balance,
          availableBalance,
          openPositions: positions.length,
          masked: binanceIntegration?.maskedPrimary,
        };
      } catch (error) {
        brokerStatus.binance = {
          configured: true,
          connected: false,
          error: errorMessage(error),
          masked: binanceIntegration?.maskedPrimary,
        };
      }
    }

    res.json({
      workspaceId,
      edition: 'BINANCE_AUTO_FOREX_SIGNAL_ONLY',
      settings,
      integrations: integrationStatuses.filter((item) => item.provider !== 'MT5'),
      brokerStatus,
      riskGuard: riskGuard.load(),
      emergencyStop: loadEngineState('emergencyStop'),
      scanners: {
        crypto: loadEngineState('cryptoScanner'),
        forex: loadEngineState('forexScanner'),
        paper: loadEngineState('paperBroker'),
      },
      active: {
        crypto: activeCrypto,
        cryptoUniqueSymbols: [...new Set(activeCrypto.map((trade) => trade.symbol))],
      },
      recentTrades: modeTrades.slice(0, 250),
      metrics: {
        global: calculateMetrics(modeTrades, 'BINANCE'),
        crypto: calculateMetrics(modeTrades, 'BINANCE'),
        cryptoBySymbol: metricsBySymbol(modeTrades, 'BINANCE'),
        cryptoByStrategy: metricsByStrategy(modeTrades, 'BINANCE'),
      },
      paper,
      opportunities: {
        crypto: loadTopCryptoOpportunities(10),
      },
      forexSignals: loadForexSignals(50),
      forexSignalStats: loadForexSignalStats(),
      forexDiagnostics: loadForexDiagnostics(),
    });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.patch('/api/settings', (req, res) => {
  try {
    const patch = settingsPatchSchema.parse(req.body);
    const next: EngineSettings = {
      ...getSettings(),
      ...patch,
      forexExecutionMode: 'SIGNAL_ONLY',
    };
    next.maxConcurrentCryptoTrades = Math.min(10, next.maxConcurrentCryptoTrades);
    next.forexSymbols = [...new Set(next.forexSymbols.map((symbol) => symbol.trim().toUpperCase().replace('/', '')).filter(Boolean))];
    database.saveSettings(next);
    res.json({ ok: true, settings: next });
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
  }
});

app.post('/api/engine/start', async (_req, res) => {
  try {
    const settings = getSettings();
    const risk = await riskGuard.evaluate();
    if (risk.status === 'TRIPPED') return res.status(409).json({ error: 'RISK_KILL_SWITCH_TRIPPED', riskGuard: risk });

    if (settings.appMode !== 'PAPER' && settings.cryptoEnabled) {
      if (!binance.hasCredentials()) {
        return res.status(409).json({ error: 'BINANCE_CREDENTIALS_REQUIRED_FOR_CRYPTO' });
      }
      try {
        await binance.testConnection();
      } catch (error) {
        return res.status(409).json({
          error: 'BINANCE_CONNECTION_REQUIRED_FOR_CRYPTO',
          detail: errorMessage(error),
        });
      }
    }

    const warnings: string[] = [];
    if (settings.forexEnabled && !forexData.hasCredentials()) warnings.push('FOREX_DATA_PENDING');
    if (settings.forexEnabled && !telegram.isConfigured()) warnings.push('FOREX_TELEGRAM_PENDING');

    database.saveSettings({ ...settings, engineEnabled: true, forexExecutionMode: 'SIGNAL_ONLY' });
    database.db.prepare(`
      INSERT INTO engine_state(key, value, updated_at)
      VALUES('emergencyStop', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(JSON.stringify({ active: false, clearedAt: Date.now() }), Date.now());
    res.json({
      ok: true,
      engineEnabled: true,
      forexExecutionMode: 'SIGNAL_ONLY',
      forexReady: !settings.forexEnabled || (forexData.hasCredentials() && telegram.isConfigured()),
      warnings,
    });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.post('/api/engine/pause', (_req, res) => {
  database.saveSettings({ ...getSettings(), engineEnabled: false, forexExecutionMode: 'SIGNAL_ONLY' });
  void telegram.alert(
    'MOTOR PAUSADO',
    'Se bloquearon nuevas entradas Binance y nuevas señales Forex. Las posiciones Binance existentes conservan sus SL/TP.',
  ).catch(() => undefined);
  res.json({ ok: true, engineEnabled: false });
});

app.post('/api/emergency-stop', async (_req, res) => {
  try {
    const result = await emergencyStop.trigger();
    res.json({ ok: result.failed === 0, ...result });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
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
    await forexScanner.runCycle();
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
  const weekAgo = Date.now() - 7 * 24 * 60 * 60_000;
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

function loadEngineState(key: string): unknown {
  const row = database.db.prepare('SELECT value, updated_at FROM engine_state WHERE key = ?').get(key) as
    | { value: string; updated_at: number }
    | undefined;
  if (!row) return null;
  try { return { ...JSON.parse(row.value), updatedAt: row.updated_at }; }
  catch { return { value: row.value, updatedAt: row.updated_at }; }
}

function errorMessage(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  return error instanceof Error ? error.message : String(error);
}

const monitoringTimer = setInterval(() => {
  void (async () => {
    try {
      await reconciler.runOnce();
      await paperBroker.runOnce();
      await riskGuard.evaluate();
    } catch (error) {
      console.error('[V34] monitoring error:', errorMessage(error));
    }
  })();
}, 10_000);
monitoringTimer.unref();

app.listen(env.PORT, '0.0.0.0', () => {
  console.log(`[V34-LINUX] backend listening on 0.0.0.0:${env.PORT}`);
  console.log(`[V34-LINUX] workspace=${workspaceId} mode=${getSettings().appMode} engine=${getSettings().engineEnabled ? 'ON' : 'OFF'}`);
  console.log('[V34-LINUX] Crypto=BINANCE_AUTO · Paper=PERSISTENT_SIM_BROKER · Forex=TELEGRAM_SIGNAL_ONLY');
  void reconciler.runOnce().then(() => paperBroker.runOnce()).then(() => riskGuard.evaluate()).catch((error) => console.error('[V34] initial monitor error:', errorMessage(error)));
  paperBroker.start();
  cryptoScanner.start();
  forexScanner.start();
});
