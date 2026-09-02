import cors from 'cors';
import express from 'express';
import { AsterV3Client } from './aster.js';
import { BinanceUsdmClient } from './binance.js';
import { CommodityScalperService } from './commodityScalper.js';
import { defaultSettings, env } from './config.js';
import { TradingDatabase } from './database.js';
import { IntegrationVault, normalizeWorkspaceId } from './integrationVault.js';
import { TelegramService } from './telegram.js';
import type { EngineSettings } from './types.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const database = new TradingDatabase(env.DB_PATH);
const legacy = { ...defaultSettings(), ...(database.getSettings() ?? {}) } as EngineSettings;
// R12 is deliberately isolated: the old Crypto and Twelve Data Forex scanners must
// never start in this runtime. We retain the settings only for Binance client mode.
database.saveSettings({
  ...legacy,
  engineEnabled: false,
  cryptoEnabled: false,
  forexEnabled: false,
  forexExecutionMode: 'SIGNAL_ONLY',
});
const getSettings = (): EngineSettings => ({
  ...defaultSettings(),
  ...(database.getSettings() ?? {}),
  engineEnabled: false,
  cryptoEnabled: false,
  forexEnabled: false,
  forexExecutionMode: 'SIGNAL_ONLY',
});

const workspaceId = normalizeWorkspaceId(env.DEFAULT_WORKSPACE_ID);
const vault = new IntegrationVault(database);
const telegram = new TelegramService(() => vault.getTelegram(workspaceId));
const binance = new BinanceUsdmClient(getSettings, () => vault.getBinance(workspaceId));
const aster = new AsterV3Client();
const scalper = new CommodityScalperService(database, binance, aster, telegram, () => getSettings().appMode);

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'Quantum Commodities R12',
    edition: 'XAUUSDT_BINANCE_CLUSDT_ASTER',
    mode: getSettings().appMode,
    scalperEnabled: scalper.isEnabled(),
    realExecutionLocked: !env.COMMODITY_ALLOW_REAL,
  });
});

app.get('/api/state', async (_req, res) => {
  try {
    const mode = getSettings().appMode;
    const integrations = vault.getStatus(workspaceId);
    const binanceStatus = integrations.find((item) => item.provider === 'BINANCE');
    const telegramStatus = integrations.find((item) => item.provider === 'TELEGRAM');
    const publicAster = await aster.testPublic().catch((error) => ({ ok: false as const, error: message(error) }));

    res.json({
      ok: true,
      release: 'R12',
      workspaceId,
      mode,
      realExecutionLocked: !env.COMMODITY_ALLOW_REAL,
      policy: {
        onlyMarkets: ['XAUUSD', 'CRUDE OIL'],
        xau: { venue: 'BINANCE', venueSymbol: 'XAUUSDT', directions: ['BUY', 'SELL'] },
        crude: { venue: 'ASTER', venueSymbol: 'CLUSDT', directions: ['BUY'], sellHardDisabled: true },
        trigger: '30s synthetic aggTrades',
        context: '1m',
        marginPctPerTrade: env.COMMODITY_MARGIN_PCT,
        leverageRequested: env.COMMODITY_REQUESTED_LEVERAGE,
        minEdgeMultipleVsCosts: env.COMMODITY_MIN_EDGE_MULTIPLE,
        maxHoldSeconds: env.COMMODITY_MAX_HOLD_SECONDS,
      },
      brokers: {
        binance: {
          configured: binance.hasCredentials(),
          connected: binanceStatus?.lastTestOk === true,
          masked: binanceStatus?.maskedPrimary,
          lastError: binanceStatus?.lastError,
          requiredForRealXau: true,
        },
        aster: {
          public: publicAster,
          privateConfigured: aster.hasCredentials(),
          requiredForRealCrude: true,
        },
        telegram: {
          configured: telegram.isConfigured(),
          connected: telegramStatus?.lastTestOk === true,
        },
      },
      scalper: scalper.getState(),
    });
  } catch (error) {
    res.status(500).json({ error: message(error) });
  }
});

app.post('/api/start', async (_req, res) => {
  try {
    scalper.setEnabled(true);
    await scalper.runOnce();
    res.json({ ok: true, scalper: scalper.getState() });
  } catch (error) {
    res.status(500).json({ error: message(error) });
  }
});

app.post('/api/pause', (_req, res) => {
  scalper.setEnabled(false);
  res.json({ ok: true, scalper: scalper.getState() });
});

app.post('/api/run', async (_req, res) => {
  try {
    await scalper.runOnce();
    res.json({ ok: true, scalper: scalper.getState() });
  } catch (error) {
    res.status(500).json({ error: message(error) });
  }
});

app.get('/api/trades', (req, res) => {
  const limit = Math.max(1, Math.min(500, Number(req.query.limit ?? 100)));
  res.json({ ok: true, trades: scalper.recentTrades(limit), paper: scalper.paperSummary() });
});

app.get('/api/aster/test-public', async (_req, res) => {
  try { res.json(await aster.testPublic()); }
  catch (error) { res.status(500).json({ ok: false, error: message(error) }); }
});

app.get('/api/aster/test-private', async (_req, res) => {
  try { res.json(await aster.testPrivate()); }
  catch (error) { res.status(400).json({ ok: false, error: message(error) }); }
});

app.get('/api/binance/test-public-xau', async (_req, res) => {
  try {
    const response = await fetch(`${env.BINANCE_BASE_URL.replace(/\/$/, '')}/fapi/v1/ticker/bookTicker?symbol=XAUUSDT`);
    const data = await response.json();
    res.status(response.ok ? 200 : 500).json({ ok: response.ok, data });
  } catch (error) {
    res.status(500).json({ ok: false, error: message(error) });
  }
});

app.listen(env.PORT, '0.0.0.0', () => {
  console.log(`[R12-COMMODITIES] listening on 0.0.0.0:${env.PORT}`);
  console.log(`[R12-COMMODITIES] mode=${getSettings().appMode} realLocked=${!env.COMMODITY_ALLOW_REAL}`);
  console.log('[R12-COMMODITIES] XAUUSDT=BINANCE BUY/SELL · CLUSDT=ASTER BUY-ONLY · trigger=30s context=1m');
  scalper.start();
});

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
