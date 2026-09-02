import cors from 'cors';
import express from 'express';
import { z } from 'zod';
import { AsterV3Client } from './aster.js';
import { BinanceUsdmClient } from './binance.js';
import { BinanceMarketDataClient } from './binanceMarket.js';
import { CommodityScalperService } from './commodityScalper.js';
import { defaultSettings, env } from './config.js';
import { CryptoExecutionService } from './cryptoExecution.js';
import { CryptoMarketScanner } from './cryptoScanner.js';
import { TradingDatabase } from './database.js';
import { EmergencyStopService } from './emergencyStop.js';
import { createIntegrationRouter } from './integrationRoutes.js';
import { IntegrationVault, normalizeWorkspaceId } from './integrationVault.js';
import { calculateMetrics, metricsByStrategy, metricsBySymbol } from './metrics.js';
import { OpportunityOrchestrator } from './orchestrator.js';
import { PaperBrokerService } from './paperBroker.js';
import { PositionReconciler } from './reconciler.js';
import { TradingRepository } from './repositories.js';
import { PortfolioRiskGuard } from './riskGuard.js';
import { TelegramService } from './telegram.js';
import type { EngineSettings, Opportunity } from './types.js';

const RELEASE = 'R13';
const EDITION = 'CRYPTO_R11_FAST_PLUS_XAUUSDT_CLUSDT';
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const database = new TradingDatabase(env.DB_PATH);
const persisted = { ...defaultSettings(), ...(database.getSettings() ?? {}) } as EngineSettings;
const normalizedInitialSettings: EngineSettings = {
  ...persisted,
  cryptoEnabled: true,
  maxConcurrentCryptoTrades: persisted.maxConcurrentCryptoTrades <= 1 ? 10 : Math.min(10, persisted.maxConcurrentCryptoTrades),
  forexEnabled: false,
  forexExecutionMode: 'SIGNAL_ONLY',
};
database.saveSettings(normalizedInitialSettings);

const getSettings = (): EngineSettings => {
  const current = { ...defaultSettings(), ...(database.getSettings() ?? {}) } as EngineSettings;
  return {
    ...current,
    cryptoEnabled: true,
    maxConcurrentCryptoTrades: current.maxConcurrentCryptoTrades <= 1 ? 10 : Math.min(10, current.maxConcurrentCryptoTrades),
    forexEnabled: false,
    forexExecutionMode: 'SIGNAL_ONLY',
  };
};

const workspaceId = normalizeWorkspaceId(env.DEFAULT_WORKSPACE_ID);
const vault = new IntegrationVault(database);
const repository = new TradingRepository(database);
const telegram = new TelegramService(() => vault.getTelegram(workspaceId));
const binance = new BinanceUsdmClient(getSettings, () => vault.getBinance(workspaceId));
const binanceMarket = new BinanceMarketDataClient(getSettings);
const aster = new AsterV3Client();
const cryptoExecution = new CryptoExecutionService(database, repository, binance, telegram, getSettings);
const orchestrator = new OpportunityOrchestrator(database, repository, cryptoExecution, getSettings);
const reconciler = new PositionReconciler(database, repository, binance, telegram, getSettings);
const riskGuard = new PortfolioRiskGuard(database, telegram, getSettings);
const emergencyStop = new EmergencyStopService(database, repository, binance, telegram, getSettings);
const cryptoScanner = new CryptoMarketScanner(database, binanceMarket, orchestrator, getSettings);
const paperBroker = new PaperBrokerService(database, repository, binanceMarket, telegram, getSettings);
const commodities = new CommodityScalperService(database, binance, aster, telegram, () => getSettings().appMode);
commodities.setEnabled(getSettings().engineEnabled);

app.use('/api/integrations', createIntegrationRouter(vault, getSettings, () => workspaceId));

const settingsPatchSchema = z.object({
  appMode: z.enum(['PAPER', 'TESTNET', 'REAL']).optional(),
  maxConcurrentCryptoTrades: z.number().int().min(1).max(10).optional(),
  cryptoMarginPctPerTrade: z.number().positive().max(100).optional(),
  cryptoRequestedLeverage: z.number().int().min(1).max(125).optional(),
  cryptoMaxAccountExposurePct: z.number().positive().max(100).optional(),
  cryptoMaxLossPctPerTrade: z.number().positive().max(100).optional(),
  cryptoMinSignalConfidence: z.number().min(0).max(100).optional(),
  cryptoMinRollingWinRate: z.number().min(0).max(100).optional(),
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'Quantum Hybrid R13',
    edition: EDITION,
    release: RELEASE,
    mode: getSettings().appMode,
    engineEnabled: getSettings().engineEnabled,
    cryptoMaxSlots: getSettings().maxConcurrentCryptoTrades,
    commodityRealExecutionLocked: !env.COMMODITY_ALLOW_REAL,
  });
});

app.get('/api/state', async (_req, res) => {
  try {
    const settings = getSettings();
    const recentBinance = database.getRecentTrades(5000).filter((trade) =>
      trade.broker === 'BINANCE' && (trade.executionMode ?? 'REAL') === settings.appMode,
    );
    const activeCrypto = database.getActiveTrades('BINANCE').filter((trade) =>
      (trade.executionMode ?? 'REAL') === settings.appMode,
    );
    const paper = paperBroker.getSummary();
    const integrations = vault.getStatus(workspaceId);
    const binanceStatus = integrations.find((item) => item.provider === 'BINANCE');
    const telegramStatus = integrations.find((item) => item.provider === 'TELEGRAM');
    const cryptoState = loadEngineState('cryptoScanner');
    const auditState = loadEngineState('cryptoUniverseAudit');

    let binanceBroker: Record<string, unknown> = {
      configured: binance.hasCredentials(),
      connected: binanceStatus?.lastTestOk === true,
      masked: binanceStatus?.maskedPrimary,
      lastError: binanceStatus?.lastError,
    };
    if (settings.appMode === 'PAPER') {
      const allocatedMargin = paper.activeTrades.reduce((sum, trade) => sum + Math.max(0, Number(trade.marginUsed ?? 0)), 0);
      binanceBroker = {
        configured: true,
        connected: true,
        paper: true,
        asset: 'USDT',
        balance: paper.balance,
        availableBalance: Math.max(0, paper.balance - allocatedMargin),
        equity: paper.equity,
        openPositions: paper.activeTrades.length,
      };
    }

    res.json({
      ok: true,
      release: RELEASE,
      edition: EDITION,
      workspaceId,
      mode: settings.appMode,
      engineEnabled: settings.engineEnabled,
      settings: {
        maxConcurrentCryptoTrades: settings.maxConcurrentCryptoTrades,
        cryptoMarginPctPerTrade: settings.cryptoMarginPctPerTrade,
        cryptoRequestedLeverage: settings.cryptoRequestedLeverage,
        cryptoMaxAccountExposurePct: settings.cryptoMaxAccountExposurePct,
        cryptoMinSignalConfidence: settings.cryptoMinSignalConfidence,
        cryptoMinRollingWinRate: settings.cryptoMinRollingWinRate,
      },
      brokers: {
        binance: binanceBroker,
        aster: {
          privateConfigured: aster.hasCredentials(),
          requiredOnlyForRealCrude: true,
        },
        telegram: {
          configured: telegram.isConfigured(),
          connected: telegramStatus?.lastTestOk === true,
        },
      },
      crypto: {
        scanner: cryptoState,
        audit: auditState,
        active: activeCrypto,
        activeSymbols: [...new Set(activeCrypto.map((trade) => trade.symbol))],
        slots: {
          used: activeCrypto.length,
          max: settings.maxConcurrentCryptoTrades,
          free: Math.max(0, settings.maxConcurrentCryptoTrades - activeCrypto.length),
        },
        opportunities: loadTopCryptoOpportunities(30),
        recentTrades: recentBinance.slice(0, 250),
        metrics: {
          global: calculateMetrics(recentBinance, 'BINANCE'),
          bySymbol: metricsBySymbol(recentBinance, 'BINANCE'),
          byStrategy: metricsByStrategy(recentBinance, 'BINANCE'),
        },
        paper,
        reversalGuard: cryptoExecution.getReversalGuardState(),
      },
      commodities: {
        realExecutionLocked: !env.COMMODITY_ALLOW_REAL,
        policy: {
          xau: { display: 'XAUUSD', venue: 'BINANCE', venueSymbol: 'XAUUSDT', directions: ['BUY', 'SELL'] },
          crude: { display: 'CRUDE OIL', venue: 'ASTER', venueSymbol: 'CLUSDT', directions: ['BUY'], sellHardDisabled: true },
          trigger: '30s synthetic aggTrades',
          context: '1m',
          minEdgeMultipleVsCosts: env.COMMODITY_MIN_EDGE_MULTIPLE,
        },
        scalper: commodities.getState(),
      },
      riskGuard: riskGuard.load(),
      emergencyStop: loadEngineState('emergencyStop'),
    });
  } catch (error) {
    res.status(500).json({ error: message(error) });
  }
});

app.patch('/api/settings', (req, res) => {
  try {
    const patch = settingsPatchSchema.parse(req.body);
    const current = getSettings();
    const next: EngineSettings = {
      ...current,
      ...patch,
      cryptoEnabled: true,
      maxConcurrentCryptoTrades: patch.maxConcurrentCryptoTrades ?? current.maxConcurrentCryptoTrades,
      forexEnabled: false,
      forexExecutionMode: 'SIGNAL_ONLY',
    };
    database.saveSettings(next);
    res.json({ ok: true, settings: next });
  } catch (error) {
    res.status(400).json({ error: message(error) });
  }
});

app.post('/api/start', async (_req, res) => {
  try {
    const settings = getSettings();
    const risk = await riskGuard.evaluate();
    if (risk.status === 'TRIPPED') return res.status(409).json({ error: 'RISK_KILL_SWITCH_TRIPPED', riskGuard: risk });

    if (settings.appMode !== 'PAPER') {
      if (!binance.hasCredentials()) return res.status(409).json({ error: 'BINANCE_CREDENTIALS_REQUIRED_FOR_CRYPTO' });
      try { await binance.testConnection(); }
      catch (error) { return res.status(409).json({ error: 'BINANCE_CONNECTION_REQUIRED_FOR_CRYPTO', detail: message(error) }); }
    }

    const next = { ...settings, engineEnabled: true, cryptoEnabled: true, forexEnabled: false, forexExecutionMode: 'SIGNAL_ONLY' as const };
    database.saveSettings(next);
    commodities.setEnabled(true);
    await Promise.allSettled([cryptoScanner.runCycle(), commodities.runOnce()]);
    res.json({ ok: true, engineEnabled: true, cryptoMaxSlots: next.maxConcurrentCryptoTrades, commodityRealExecutionLocked: !env.COMMODITY_ALLOW_REAL });
  } catch (error) {
    res.status(500).json({ error: message(error) });
  }
});

app.post('/api/pause', (_req, res) => {
  const settings = getSettings();
  database.saveSettings({ ...settings, engineEnabled: false, cryptoEnabled: true, forexEnabled: false, forexExecutionMode: 'SIGNAL_ONLY' });
  commodities.setEnabled(false);
  res.json({ ok: true, engineEnabled: false });
});

app.post('/api/run', async (_req, res) => {
  try {
    const settled = await Promise.allSettled([cryptoScanner.runCycle(), commodities.runOnce()]);
    res.json({
      ok: settled.every((item) => item.status === 'fulfilled'),
      results: settled.map((item) => item.status === 'fulfilled' ? { ok: true } : { ok: false, error: message(item.reason) }),
      crypto: loadEngineState('cryptoScanner'),
      commodities: commodities.getState(),
    });
  } catch (error) {
    res.status(500).json({ error: message(error) });
  }
});

app.post('/api/reconcile', async (_req, res) => {
  try {
    await reconciler.runOnce();
    await paperBroker.runOnce();
    await riskGuard.evaluate();
    await commodities.runOnce();
    res.json({ ok: true, reconciledAt: Date.now() });
  } catch (error) {
    res.status(500).json({ error: message(error) });
  }
});

app.post('/api/emergency-stop', async (_req, res) => {
  try {
    commodities.setEnabled(false);
    const result = await emergencyStop.trigger();
    res.json({ ok: result.failed === 0, ...result });
  } catch (error) {
    res.status(500).json({ error: message(error) });
  }
});

app.post('/api/paper/trades/:id/close', async (req, res) => {
  try {
    const trade = await paperBroker.closeTradeManually(String(req.params.id));
    res.json({ ok: true, trade, paper: paperBroker.getSummary() });
  } catch (error) {
    res.status(400).json({ error: message(error) });
  }
});

app.get('/api/trades', (req, res) => {
  const limit = Math.max(1, Math.min(500, Number(req.query.limit ?? 100)));
  res.json({
    ok: true,
    crypto: database.getRecentTrades(limit).filter((trade) => trade.broker === 'BINANCE' && (trade.executionMode ?? 'REAL') === getSettings().appMode),
    commodities: commodities.recentTrades(limit),
    commodityPaper: commodities.paperSummary(),
  });
});

app.get('/api/aster/test-public', async (_req, res) => {
  try { res.json(await aster.testPublic()); }
  catch (error) { res.status(500).json({ ok: false, error: message(error) }); }
});

function loadTopCryptoOpportunities(limit: number): Opportunity[] {
  const rows = database.db.prepare(`
    SELECT payload FROM opportunities
    WHERE broker='BINANCE' AND executable=1 AND created_at >= ?
    ORDER BY score DESC, created_at DESC LIMIT ?
  `).all(Date.now() - 45_000, Math.max(1, Math.min(300, limit))) as Array<{ payload: string }>;
  const active = new Set(database.getActiveTrades('BINANCE')
    .filter((trade) => (trade.executionMode ?? 'REAL') === getSettings().appMode)
    .map((trade) => trade.symbol.toUpperCase()));
  const best = new Map<string, Opportunity>();
  for (const row of rows) {
    const opportunity = JSON.parse(row.payload) as Opportunity;
    if (active.has(opportunity.symbol.toUpperCase())) continue;
    const previous = best.get(opportunity.symbol);
    if (!previous || opportunity.score > previous.score) best.set(opportunity.symbol, opportunity);
  }
  return [...best.values()].sort((a, b) => b.score - a.score || b.confidence - a.confidence).slice(0, limit);
}

function loadEngineState(key: string): any {
  const row = database.db.prepare('SELECT value, updated_at FROM engine_state WHERE key=?').get(key) as { value: string; updated_at: number } | undefined;
  if (!row) return null;
  try { return { ...JSON.parse(row.value), updatedAt: row.updated_at }; }
  catch { return { value: row.value, updatedAt: row.updated_at }; }
}

const monitorTimer = setInterval(() => {
  void (async () => {
    try {
      await reconciler.runOnce();
      await paperBroker.runOnce();
      await riskGuard.evaluate();
    } catch (error) {
      console.error('[R13] monitor:', message(error));
    }
  })();
}, 10_000);
monitorTimer.unref();

app.listen(env.PORT, '0.0.0.0', () => {
  console.log(`[R13-HYBRID] listening on 0.0.0.0:${env.PORT}`);
  console.log(`[R13-HYBRID] mode=${getSettings().appMode} engine=${getSettings().engineEnabled ? 'ON' : 'OFF'} cryptoSlots=${getSettings().maxConcurrentCryptoTrades}`);
  console.log('[R13-HYBRID] Crypto=R11 FAST PARALLEL · XAUUSDT=30s/1m · CLUSDT=30s/1m BUY-ONLY · Forex=OFF');
  void reconciler.runOnce().then(() => paperBroker.runOnce()).then(() => riskGuard.evaluate()).catch((error) => console.error('[R13] initial monitor:', message(error)));
  paperBroker.start();
  cryptoScanner.start();
  commodities.start();
});

function message(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  return error instanceof Error ? error.message : String(error);
}
