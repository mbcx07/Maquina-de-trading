import cors from 'cors';
import express from 'express';
import { z } from 'zod';
import { AsterV3Client } from './aster.js';
import { BinanceUsdmClient } from './binance.js';
import { defaultSettings, env } from './config.js';
import { TradingDatabase } from './database.js';
import { ExchangeCommodityScalperR14 } from './exchangeCommodityScalperR14.js';
import { createIntegrationRouter } from './integrationRoutes.js';
import { IntegrationVault, normalizeWorkspaceId } from './integrationVault.js';
import { Mt5BridgeClient } from './mt5.js';
import { Mt5CommodityScalperService } from './mt5CommodityScalper.js';
import { TelegramService } from './telegram.js';
import type { AppMode, EngineSettings } from './types.js';

const RELEASE = 'R14';
const EDITION = 'XAU_CRUDE_DUAL_EXCHANGE_MT5';
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const database = new TradingDatabase(env.DB_PATH);
const persisted = { ...defaultSettings(), ...(database.getSettings() ?? {}) } as EngineSettings;
database.saveSettings({
  ...persisted,
  cryptoEnabled: false,
  forexEnabled: true,
  forexExecutionMode: 'SIGNAL_ONLY',
  maxConcurrentForexTrades: 2,
  forexMaxEntriesPerSymbol: 1,
  forexRiskMode: 'MARGIN_PERCENT',
  forexPctPerTrade: env.COMMODITY_MARGIN_PCT,
});

const getSettings = (): EngineSettings => ({
  ...defaultSettings(),
  ...(database.getSettings() ?? {}),
  cryptoEnabled: false,
  forexEnabled: true,
  forexExecutionMode: 'SIGNAL_ONLY',
  maxConcurrentForexTrades: 2,
  forexMaxEntriesPerSymbol: 1,
  forexRiskMode: 'MARGIN_PERCENT',
  forexPctPerTrade: env.COMMODITY_MARGIN_PCT,
});

const workspaceId = normalizeWorkspaceId(env.DEFAULT_WORKSPACE_ID);
const vault = new IntegrationVault(database);
const telegram = new TelegramService(() => vault.getTelegram(workspaceId));
const binance = new BinanceUsdmClient(getSettings, () => vault.getBinance(workspaceId));
const aster = new AsterV3Client();
const mt5 = new Mt5BridgeClient(getSettings, () => vault.getMt5(workspaceId));
const exchange = new ExchangeCommodityScalperR14(database, binance, aster, telegram, () => getSettings().appMode);
const forex = new Mt5CommodityScalperService(database, mt5, telegram, () => getSettings().appMode);
exchange.setEnabled(getSettings().engineEnabled);
forex.setEnabled(getSettings().engineEnabled);

app.use('/api/integrations', createIntegrationRouter(vault, getSettings, () => workspaceId));

const settingsSchema = z.object({
  appMode: z.enum(['PAPER', 'REAL']).optional(),
  engineEnabled: z.boolean().optional(),
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'Quantum Commodities Dual R14',
    release: RELEASE,
    edition: EDITION,
    mode: getSettings().appMode,
    engineEnabled: getSettings().engineEnabled,
    markets: ['XAUUSD', 'CRUDE OIL'],
    venues: ['EXCHANGE', 'MT5'],
    updater: '/updater/status',
  });
});

app.get('/api/state', async (_req, res) => {
  try {
    const settings = getSettings();
    const integrations = vault.getStatus(workspaceId);
    const mt5Status = integrations.find((row) => row.provider === 'MT5');
    const binanceStatus = integrations.find((row) => row.provider === 'BINANCE');
    const exchangeState = exchange.getState();
    const mt5State = forex.getState();
    const allTrades = database.db.prepare(`SELECT * FROM commodity_trades ORDER BY created_at DESC LIMIT 2000`).all() as Record<string, unknown>[];

    res.json({
      ok: true,
      release: RELEASE,
      edition: EDITION,
      workspaceId,
      mode: settings.appMode,
      engineEnabled: settings.engineEnabled,
      policy: {
        onlyMarkets: ['XAUUSD', 'CRUDE OIL'],
        strategy: '30s microstructure + 1m EMA9/EMA21 RSI ATR',
        marginPctPerTrade: env.COMMODITY_MARGIN_PCT,
        minEdgeMultipleVsCosts: env.COMMODITY_MIN_EDGE_MULTIPLE,
        crudeBuyOnly: true,
        exchange: {
          xau: { symbol: 'XAUUSDT', venue: 'Binance USD-M', leverage: 'MAX_ALLOWED_BY_CONTRACT' },
          crude: { symbol: 'CLUSDT', venue: 'Aster / Binance Wallet', leverage: 'MAX_ALLOWED_BY_CONTRACT' },
        },
        forex: {
          symbolDetection: 'AUTO_FROM_MT5_BROKER',
          spread: 'LIVE_BID_ASK_FROM_BROKER',
          leverage: 'BROKER_ACCOUNT_LEVERAGE',
        },
      },
      integrations: {
        binance: {
          configured: binance.hasCredentials(),
          connected: binanceStatus?.lastTestOk === true,
          masked: binanceStatus?.maskedPrimary,
          lastError: binanceStatus?.lastError,
        },
        aster: {
          configured: aster.hasCredentials(),
          label: 'Aster / Binance Wallet for CLUSDT',
        },
        mt5: {
          configured: Boolean(vault.getMt5(workspaceId)?.bridgeUrl || env.MT5_BRIDGE_URL),
          connected: mt5Status?.lastTestOk === true,
          masked: mt5Status?.maskedPrimary,
          lastError: mt5Status?.lastError,
        },
      },
      exchange: exchangeState,
      forex: mt5State,
      comparison: buildComparison(allTrades),
      recentTrades: allTrades.slice(0, 300).map(mapDbTrade),
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: message(error) });
  }
});

app.get('/api/chart/:kind/:venue', async (req, res) => {
  try {
    const kind = String(req.params.kind).toUpperCase();
    const venue = String(req.params.venue).toUpperCase();
    if (kind !== 'XAU' && kind !== 'CRUDE') return res.status(400).json({ ok: false, error: 'INVALID_MARKET' });
    if (venue === 'EXCHANGE') return res.json(await exchange.chart(kind));
    if (venue === 'MT5') return res.json(await forex.chart(kind));
    return res.status(400).json({ ok: false, error: 'INVALID_VENUE' });
  } catch (error) {
    res.status(500).json({ ok: false, error: message(error) });
  }
});

app.patch('/api/settings', (req, res) => {
  try {
    const patch = settingsSchema.parse(req.body);
    const current = getSettings();
    const next: EngineSettings = {
      ...current,
      appMode: patch.appMode ?? current.appMode,
      engineEnabled: patch.engineEnabled ?? current.engineEnabled,
      cryptoEnabled: false,
      forexEnabled: true,
      forexExecutionMode: 'SIGNAL_ONLY',
    };
    database.saveSettings(next);
    exchange.setEnabled(next.engineEnabled);
    forex.setEnabled(next.engineEnabled);
    res.json({ ok: true, settings: next });
  } catch (error) {
    res.status(400).json({ ok: false, error: message(error) });
  }
});

app.post('/api/start', async (_req, res) => {
  const current = getSettings();
  database.saveSettings({ ...current, engineEnabled: true, cryptoEnabled: false, forexEnabled: true, forexExecutionMode: 'SIGNAL_ONLY' });
  exchange.setEnabled(true);
  forex.setEnabled(true);
  const settled = await Promise.allSettled([exchange.runOnce(), forex.runOnce()]);
  res.json({
    ok: true,
    engineEnabled: true,
    results: settled.map((row) => row.status === 'fulfilled' ? { ok: true } : { ok: false, error: message(row.reason) }),
  });
});

app.post('/api/pause', (_req, res) => {
  const current = getSettings();
  database.saveSettings({ ...current, engineEnabled: false, cryptoEnabled: false, forexEnabled: true, forexExecutionMode: 'SIGNAL_ONLY' });
  exchange.setEnabled(false);
  forex.setEnabled(false);
  res.json({ ok: true, engineEnabled: false });
});

app.post('/api/run', async (_req, res) => {
  const settled = await Promise.allSettled([exchange.runOnce(), forex.runOnce()]);
  res.json({ ok: settled.every((row) => row.status === 'fulfilled'), results: settled.map((row) => row.status === 'fulfilled' ? { ok: true } : { ok: false, error: message(row.reason) }) });
});

app.get('/api/trades', (req, res) => {
  const limit = Math.max(1, Math.min(500, Number(req.query.limit ?? 200)));
  const rows = database.db.prepare(`SELECT * FROM commodity_trades ORDER BY created_at DESC LIMIT ?`).all(limit) as Record<string, unknown>[];
  res.json({ ok: true, trades: rows.map(mapDbTrade), exchangePaper: exchange.paperSummary(), forexPaper: forex.paperSummary() });
});

app.get('/api/mt5/test', async (_req, res) => {
  try {
    const health = await mt5.health();
    const symbols = await mt5.symbols();
    res.json({ ok: true, account: health.account, symbolCount: symbols.length });
  } catch (error) {
    res.status(400).json({ ok: false, error: message(error) });
  }
});

app.get('/api/aster/test-public', async (_req, res) => {
  try { res.json(await aster.testPublic()); }
  catch (error) { res.status(500).json({ ok: false, error: message(error) }); }
});

app.listen(env.PORT, '0.0.0.0', () => {
  console.log(`[R14-DUAL] listening on 0.0.0.0:${env.PORT}`);
  console.log(`[R14-DUAL] mode=${getSettings().appMode} engine=${getSettings().engineEnabled ? 'ON' : 'OFF'}`);
  console.log('[R14-DUAL] XAU: Binance USD-M vs MT5 · CRUDE: Aster/Binance Wallet vs MT5 · 30s/1m');
  exchange.start();
  forex.start();
});

function buildComparison(rows: Record<string, unknown>[]) {
  const trades = rows.map(mapDbTrade);
  const groups = [
    { key: 'XAU_EXCHANGE', display: 'XAUUSD', source: 'EXCHANGE', rows: trades.filter((row) => row.symbol === 'XAUUSDT' && row.venue === 'BINANCE') },
    { key: 'XAU_FOREX', display: 'XAUUSD', source: 'MT5', rows: trades.filter((row) => row.displaySymbol === 'XAUUSD' && row.venue === 'MT5') },
    { key: 'CRUDE_EXCHANGE', display: 'CRUDE OIL', source: 'EXCHANGE', rows: trades.filter((row) => row.symbol === 'CLUSDT' && row.venue === 'ASTER') },
    { key: 'CRUDE_FOREX', display: 'CRUDE OIL', source: 'MT5', rows: trades.filter((row) => row.displaySymbol === 'CRUDE OIL' && row.venue === 'MT5') },
  ];
  return groups.map((group) => {
    const closed = group.rows.filter((row) => row.state === 'CLOSED');
    const wins = closed.filter((row) => row.realizedPnl > 0).length;
    return {
      key: group.key,
      display: group.display,
      source: group.source,
      trades: closed.length,
      wins,
      losses: closed.length - wins,
      winRate: closed.length ? wins / closed.length * 100 : 0,
      netPnl: closed.reduce((sum, row) => sum + row.realizedPnl, 0),
      avgSpreadPct: closed.length ? closed.reduce((sum, row) => sum + row.entrySpreadPct, 0) / closed.length : 0,
      avgLeverage: closed.length ? closed.reduce((sum, row) => sum + row.leverage, 0) / closed.length : 0,
      avgHoldSeconds: closed.length ? closed.reduce((sum, row) => sum + Math.max(0, (Number(row.closeTime ?? row.openTime) - row.openTime) / 1000), 0) / closed.length : 0,
      open: group.rows.filter((row) => row.state === 'OPEN').length,
    };
  });
}

function mapDbTrade(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    venue: String(row.venue),
    mode: String(row.mode) as AppMode,
    symbol: String(row.symbol),
    displaySymbol: String(row.display_symbol),
    side: String(row.side),
    state: String(row.state),
    entryPrice: Number(row.entry_price),
    exitPrice: row.exit_price == null ? undefined : Number(row.exit_price),
    stopLoss: Number(row.stop_loss),
    takeProfit: Number(row.take_profit),
    quantity: Number(row.quantity),
    leverage: Number(row.leverage),
    marginUsed: Number(row.margin_used),
    entrySpreadPct: Number(row.entry_spread_pct),
    estimatedRoundTripCostPct: Number(row.estimated_round_trip_cost_pct),
    realizedPnl: Number(row.realized_pnl ?? 0),
    unrealizedPnl: Number(row.unrealized_pnl ?? 0),
    openTime: Number(row.open_time),
    closeTime: row.close_time == null ? undefined : Number(row.close_time),
    closeReason: row.close_reason == null ? undefined : String(row.close_reason),
    metadata: row.metadata ? JSON.parse(String(row.metadata)) : undefined,
  };
}

function message(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  return error instanceof Error ? error.message : String(error);
}
