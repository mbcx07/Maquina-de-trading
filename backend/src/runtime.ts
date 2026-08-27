import cors from 'cors';
import express from 'express';
import { z } from 'zod';
import { BinanceUsdmClient } from './binance.js';
import { BinanceMarketDataClient } from './binanceMarket.js';
import { defaultSettings, env } from './config.js';
import { CryptoExecutionService } from './cryptoExecution.js';
import { CryptoMarketScanner } from './cryptoScanner.js';
import { TradingDatabase } from './database.js';
import { ForexExecutionService } from './forexExecution.js';
import { ForexMarketScanner } from './forexScanner.js';
import { HistoricalBacktestService } from './historicalBacktest.js';
import { createIntegrationRouter } from './integrationRoutes.js';
import { IntegrationVault, normalizeWorkspaceId } from './integrationVault.js';
import { calculateMetrics, metricsByStrategy, metricsBySymbol } from './metrics.js';
import { Mt5BridgeClient } from './mt5.js';
import { OpportunityOrchestrator } from './orchestrator.js';
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
};
database.saveSettings(normalizedInitialSettings);

const getSettings = (): EngineSettings => ({
  ...defaultSettings(),
  ...(database.getSettings() ?? {}),
});

const workspaceId = normalizeWorkspaceId(env.DEFAULT_WORKSPACE_ID);
const vault = new IntegrationVault(database);
const repository = new TradingRepository(database);
const telegram = new TelegramService(() => vault.getTelegram(workspaceId));
const binance = new BinanceUsdmClient(getSettings, () => vault.getBinance(workspaceId));
const binanceMarket = new BinanceMarketDataClient(getSettings);
const mt5 = new Mt5BridgeClient(getSettings, () => vault.getMt5(workspaceId));
const cryptoExecution = new CryptoExecutionService(database, repository, binance, telegram, getSettings);
const forexExecution = new ForexExecutionService(database, repository, mt5, telegram, getSettings);
const orchestrator = new OpportunityOrchestrator(database, repository, cryptoExecution, forexExecution, getSettings);
const reconciler = new PositionReconciler(database, repository, binance, mt5, telegram, getSettings);
const riskGuard = new PortfolioRiskGuard(database, telegram, getSettings);
const cryptoScanner = new CryptoMarketScanner(database, binanceMarket, orchestrator, getSettings);
const forexScanner = new ForexMarketScanner(database, mt5, orchestrator, getSettings);
const historicalBacktest = new HistoricalBacktestService(database, binanceMarket, mt5, getSettings);

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
  cryptoEnabled: z.boolean().optional(),
  maxConcurrentCryptoTrades: z.number().int().min(1).max(10).optional(),
  cryptoMarginPctPerTrade: z.number().positive().max(100).optional(),
  cryptoRequestedLeverage: z.number().int().min(1).max(125).optional(),
  cryptoMaxAccountExposurePct: z.number().positive().max(100).optional(),
  cryptoMaxLossPctPerTrade: z.number().positive().max(100).optional(),
  cryptoMinSignalConfidence: z.number().min(0).max(100).optional(),
  cryptoMinRollingWinRate: z.number().min(0).max(100).optional(),
  forexEnabled: z.boolean().optional(),
  forexSymbols: z.array(z.string().min(1)).min(1).max(100).optional(),
  maxConcurrentForexTrades: z.number().int().min(1).max(200).optional(),
  forexMaxEntriesPerSymbol: z.number().int().min(0).max(50).optional(),
  forexRiskMode: z.enum(['MARGIN_PERCENT', 'RISK_TO_SL']).optional(),
  forexPctPerTrade: z.number().positive().max(100).optional(),
  forexMinSignalConfidence: z.number().min(0).max(100).optional(),
  forexMinRollingWinRate: z.number().min(0).max(100).optional(),
  forexMagicNumber: z.number().int().positive().optional(),
  forexMaxDeviationPoints: z.number().int().min(0).max(1000).optional(),
});

const backtestSchema = z.object({
  broker: z.enum(['BINANCE', 'MT5']),
  symbols: z.array(z.string().min(1)).min(1).max(25),
  startTime: z.number().int().positive(),
  endTime: z.number().int().positive(),
  initialBalance: z.number().positive().default(1000),
  allocationPct: z.number().positive().max(100).default(1),
  leverage: z.number().min(1).max(125).default(20),
  roundTripCostPct: z.number().min(0).max(10).default(0.12),
  scanStepMinutes: z.number().int().min(1).max(60).default(3),
  maxHoldMinutes: z.number().int().min(1).max(1440).default(90),
  sizingMode: z.enum(['MARGIN_PERCENT', 'RISK_TO_SL']).default('RISK_TO_SL'),
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'Maquina Trading V34 Runtime', mode: getSettings().appMode, workspaceId });
});

app.get('/api/state', async (_req, res) => {
  try {
    const settings = getSettings();
    const trades = database.getRecentTrades(1000);
    const activeCrypto = database.getActiveTrades('BINANCE');
    const activeForex = database.getActiveTrades('MT5');
    const integrationStatuses = vault.getStatus(workspaceId);
    const binanceIntegration = integrationStatuses.find((item) => item.provider === 'BINANCE');
    const telegramIntegration = integrationStatuses.find((item) => item.provider === 'TELEGRAM');
    const mt5Integration = integrationStatuses.find((item) => item.provider === 'MT5');

    const brokerStatus: Record<string, unknown> = {
      telegram: {
        configured: telegram.isConfigured(),
        connected: telegramIntegration?.lastTestOk === true,
        masked: telegramIntegration?.maskedPrimary,
      },
      binance: {
        configured: binance.hasCredentials(),
        connected: binanceIntegration?.lastTestOk === true,
        masked: binanceIntegration?.maskedPrimary,
      },
      mt5: {
        configured: Boolean(vault.getMt5(workspaceId) || env.MT5_BRIDGE_URL),
        connected: mt5Integration?.lastTestOk === true,
        masked: mt5Integration?.maskedPrimary,
      },
    };

    const checks: PromiseSettledResult<unknown>[] = await Promise.allSettled([
      settings.appMode !== 'PAPER' && settings.cryptoEnabled
        ? (binance.hasCredentials() ? binance.getPositions() : Promise.reject(new Error('BINANCE_NOT_CONFIGURED')))
        : Promise.resolve([]),
      settings.forexEnabled ? mt5.health() : Promise.resolve(null),
    ]);
    const [binanceStatus, mt5Status] = checks;

    if (settings.appMode !== 'PAPER' && settings.cryptoEnabled) {
      brokerStatus.binance = binanceStatus.status === 'fulfilled'
        ? { configured: true, connected: true, openPositions: (binanceStatus.value as any[]).length, masked: binanceIntegration?.maskedPrimary }
        : { configured: binance.hasCredentials(), connected: false, error: String(binanceStatus.reason), masked: binanceIntegration?.maskedPrimary };
    }

    if (settings.forexEnabled) {
      brokerStatus.mt5 = mt5Status.status === 'fulfilled'
        ? { configured: true, connected: true, account: (mt5Status.value as any).account, masked: mt5Integration?.maskedPrimary }
        : {
            configured: Boolean(vault.getMt5(workspaceId) || env.MT5_BRIDGE_URL),
            connected: false,
            error: String(mt5Status.reason),
            masked: mt5Integration?.maskedPrimary,
          };
    }

    res.json({
      workspaceId,
      settings,
      integrations: integrationStatuses,
      brokerStatus,
      riskGuard: riskGuard.load(),
      scanners: { crypto: loadEngineState('cryptoScanner'), forex: loadEngineState('forexScanner') },
      active: {
        crypto: activeCrypto,
        forex: activeForex,
        cryptoUniqueSymbols: [...new Set(activeCrypto.map((trade) => trade.symbol))],
      },
      recentTrades: trades.slice(0, 250),
      backtests: historicalBacktest.list(10),
      metrics: {
        global: calculateMetrics(trades),
        crypto: calculateMetrics(trades, 'BINANCE'),
        forex: calculateMetrics(trades, 'MT5'),
        cryptoBySymbol: metricsBySymbol(trades, 'BINANCE'),
        forexBySymbol: metricsBySymbol(trades, 'MT5'),
        cryptoByStrategy: metricsByStrategy(trades, 'BINANCE'),
        forexByStrategy: metricsByStrategy(trades, 'MT5'),
      },
      opportunities: { crypto: loadTopOpportunities('BINANCE', 10), forex: loadTopOpportunities('MT5', 20) },
    });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.patch('/api/settings', (req, res) => {
  try {
    const patch = settingsPatchSchema.parse(req.body);
    const next: EngineSettings = { ...getSettings(), ...patch };
    next.maxConcurrentCryptoTrades = Math.min(10, next.maxConcurrentCryptoTrades);
    next.forexSymbols = [...new Set(next.forexSymbols.map((symbol) => symbol.trim()).filter(Boolean))];
    database.saveSettings(next);
    res.json({ ok: true, settings: next });
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
  }
});

app.post('/api/engine/start', async (_req, res) => {
  try {
    const settings = getSettings();
    const status = await riskGuard.evaluate();
    if (status.status === 'TRIPPED') return res.status(409).json({ error: 'RISK_KILL_SWITCH_TRIPPED', riskGuard: status });

    if (settings.appMode !== 'PAPER' && settings.cryptoEnabled && !binance.hasCredentials()) {
      return res.status(409).json({ error: 'BINANCE_CREDENTIALS_REQUIRED_FOR_CRYPTO' });
    }

    if (settings.forexEnabled) {
      try {
        const health = await mt5.health();
        if (!health.account.tradeAllowed || !health.account.tradeExpert) {
          return res.status(409).json({ error: 'MT5_AUTOTRADING_NOT_ALLOWED', account: health.account });
        }
        if (settings.forexMaxEntriesPerSymbol !== 1 && !health.account.hedging) {
          return res.status(409).json({ error: 'MT5_HEDGING_REQUIRED_FOR_RETESTS', account: health.account });
        }
      } catch (error) {
        return res.status(409).json({ error: 'MT5_BRIDGE_CONNECTION_REQUIRED', detail: errorMessage(error) });
      }
    }

    database.saveSettings({ ...settings, engineEnabled: true });
    res.json({ ok: true, engineEnabled: true });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.post('/api/engine/pause', (_req, res) => {
  database.saveSettings({ ...getSettings(), engineEnabled: false });
  void telegram.alert('MOTOR PAUSADO', 'Se bloquearon nuevas entradas. Las posiciones existentes continúan con sus SL/TP.').catch(() => undefined);
  res.json({ ok: true, engineEnabled: false });
});

app.post('/api/emergency-stop', (_req, res) => {
  database.saveSettings({ ...getSettings(), engineEnabled: false });
  database.db.prepare(`
    INSERT INTO engine_state(key, value, updated_at) VALUES('emergencyStop', 'true', ?)
    ON CONFLICT(key) DO UPDATE SET value='true', updated_at=excluded.updated_at
  `).run(Date.now());
  void telegram.alert('EMERGENCY STOP', 'Nuevas entradas bloqueadas inmediatamente. Las posiciones existentes conservan SL/TP.').catch(() => undefined);
  res.json({ ok: true, engineEnabled: false, emergencyStop: true });
});

app.post('/api/reconcile', async (_req, res) => {
  try {
    await reconciler.runOnce();
    res.json({ ok: true, reconciledAt: Date.now(), riskGuard: await riskGuard.evaluate() });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
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
    res.json({ ok: true, scanner: loadEngineState('forexScanner') });
  } catch (error) {
    res.status(500).json({ error: errorMessage(error) });
  }
});

app.get('/api/backtests', (req, res) => {
  const limit = Number(req.query.limit ?? 20);
  res.json({ ok: true, runs: historicalBacktest.list(limit) });
});

app.get('/api/backtests/:id', (req, res) => {
  const run = historicalBacktest.get(String(req.params.id));
  if (!run) return res.status(404).json({ error: 'BACKTEST_NOT_FOUND' });
  res.json({ ok: true, run });
});

app.post('/api/backtests', (req, res) => {
  try {
    const body = backtestSchema.parse(req.body);
    if (body.broker === 'MT5' && !vault.getMt5(workspaceId) && !env.MT5_BRIDGE_URL) {
      return res.status(409).json({ error: 'MT5_BRIDGE_REQUIRED_FOR_BACKTEST' });
    }
    const id = historicalBacktest.create(body);
    res.status(202).json({ ok: true, id, run: historicalBacktest.get(id) });
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
  }
});

app.post('/api/opportunities/ingest', async (req, res) => {
  try {
    const body = z.object({ opportunities: z.array(opportunitySchema).min(1).max(1000), autoExecute: z.boolean().default(true) }).parse(req.body);
    res.json({ ok: true, ...(await orchestrator.process(body.opportunities as Opportunity[], body.autoExecute)) });
  } catch (error) {
    res.status(400).json({ error: errorMessage(error) });
  }
});

function loadTopOpportunities(broker: 'BINANCE' | 'MT5', limit: number): Opportunity[] {
  const freshnessMs = broker === 'BINANCE' ? 15 * 60_000 : 90 * 60_000;
  const rows = database.db.prepare(`
    SELECT payload FROM opportunities
    WHERE broker = ? AND executable = 1 AND created_at >= ?
    ORDER BY score DESC, created_at DESC LIMIT ?
  `).all(broker, Date.now() - freshnessMs, Math.max(limit * 25, 100)) as Array<{ payload: string }>;
  const parsed = rows.map((row) => JSON.parse(row.payload) as Opportunity);
  if (broker === 'BINANCE') {
    const activeSymbols = new Set(database.getActiveTrades('BINANCE').map((trade) => trade.symbol));
    const best = new Map<string, Opportunity>();
    for (const opportunity of parsed) {
      if (activeSymbols.has(opportunity.symbol)) continue;
      const current = best.get(opportunity.symbol);
      if (!current || opportunity.score > current.score) best.set(opportunity.symbol, opportunity);
    }
    return [...best.values()].sort((a, b) => b.score - a.score).slice(0, Math.min(10, limit));
  }
  return parsed.slice(0, limit);
}

function loadEngineState(key: string): unknown {
  const row = database.db.prepare('SELECT value, updated_at FROM engine_state WHERE key = ?').get(key) as { value: string; updated_at: number } | undefined;
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
      await riskGuard.evaluate();
    } catch (error) {
      console.error('[V34] monitoring error:', errorMessage(error));
    }
  })();
}, 10_000);
monitoringTimer.unref();

app.listen(env.PORT, () => {
  console.log(`[V34] backend listening on http://127.0.0.1:${env.PORT}`);
  console.log(`[V34] workspace=${workspaceId} mode=${getSettings().appMode} engine=${getSettings().engineEnabled ? 'ON' : 'OFF'}`);
  void reconciler.runOnce().then(() => riskGuard.evaluate()).catch((error) => console.error('[V34] initial monitor error:', errorMessage(error)));
  cryptoScanner.start();
  forexScanner.start();
});
