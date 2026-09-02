import cors from 'cors';
import express from 'express';
import { z } from 'zod';
import { AsterV3Client } from './aster.js';
import { BinanceUsdmClient } from './binance.js';
import { CommodityBacktestR15 } from './commodityBacktestR15.js';
import type { CommodityKindR15, CrudeSideModeR15 } from './commodityStrategyR15.js';
import { defaultSettings, env } from './config.js';
import { TradingDatabase } from './database.js';
import { ExchangeCommodityScalperR15 } from './exchangeCommodityScalperR15.js';
import { createIntegrationRouter } from './integrationRoutes.js';
import { IntegrationVault, normalizeWorkspaceId } from './integrationVault.js';
import { Mt5BridgeClient } from './mt5.js';
import { Mt5CommodityScalperR15 } from './mt5CommodityScalperR15.js';
import { TelegramService } from './telegram.js';
import type { EngineSettings } from './types.js';

const RELEASE = 'R15';
const EDITION = 'XAU_CRUDE_DUAL_REALTIME_BACKTEST';
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

function getCrudeSideMode(): CrudeSideModeR15 {
  const row = database.db.prepare(`SELECT value FROM engine_state WHERE key='r15CrudeSideMode'`).get() as { value: string } | undefined;
  const value = String(row?.value ?? 'BUY').toUpperCase();
  return value === 'SELL' || value === 'BOTH' ? value : 'BUY';
}
function setCrudeSideMode(value: CrudeSideModeR15): void {
  database.db.prepare(`INSERT INTO engine_state(key,value,updated_at) VALUES('r15CrudeSideMode',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
    .run(value, Date.now());
}

const exchange = new ExchangeCommodityScalperR15(database, binance, aster, telegram, () => getSettings().appMode, getCrudeSideMode);
const forex = new Mt5CommodityScalperR15(database, mt5, telegram, () => getSettings().appMode, getCrudeSideMode);
const backtest = new CommodityBacktestR15(aster);
exchange.setEnabled(getSettings().engineEnabled);
forex.setEnabled(getSettings().engineEnabled);

app.use('/api/integrations', createIntegrationRouter(vault, getSettings, () => workspaceId));

const settingsSchema = z.object({
  appMode: z.enum(['PAPER', 'REAL']).optional(),
  engineEnabled: z.boolean().optional(),
  crudeSideMode: z.enum(['BUY', 'SELL', 'BOTH']).optional(),
});
const backtestSchema = z.object({
  kind: z.enum(['XAU', 'CRUDE']),
  days: z.union([z.number().int().min(7).max(env.COMMODITY_BACKTEST_MAX_DAYS), z.literal('MAX')]).default(30),
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'Quantum Commodities Dual R15',
    release: RELEASE,
    edition: EDITION,
    mode: getSettings().appMode,
    engineEnabled: getSettings().engineEnabled,
    scoreThreshold: env.COMMODITY_SIGNAL_SCORE_MIN,
    paperInitialBalancePerVenue: env.COMMODITY_PAPER_INITIAL_BALANCE,
    crudeSideMode: getCrudeSideMode(),
    streamIntervalMs: env.COMMODITY_STREAM_MS,
    markets: ['XAUUSD', 'CRUDE OIL'],
    venues: ['EXCHANGE', 'MT5'],
  });
});

app.get('/api/state', (_req, res) => {
  try {
    const settings = getSettings();
    const integrations = vault.getStatus(workspaceId);
    const mt5Status = integrations.find((row) => row.provider === 'MT5');
    const binanceStatus = integrations.find((row) => row.provider === 'BINANCE');
    const exchangeState = exchange.getState();
    const mt5State = forex.getState();
    const exchangeStart = Number((exchange.paperSummary() as any).sessionStart ?? 0);
    const mt5Start = Number((forex.paperSummary() as any).sessionStart ?? 0);
    const sessionStart = Math.min(...[exchangeStart, mt5Start].filter((value) => value > 0));
    const allTrades = database.db.prepare(`SELECT * FROM commodity_trades WHERE created_at>=? ORDER BY created_at DESC LIMIT 3000`).all(Number.isFinite(sessionStart) ? sessionStart : 0) as Record<string, unknown>[];

    res.json({
      ok: true,
      release: RELEASE,
      edition: EDITION,
      workspaceId,
      mode: settings.appMode,
      engineEnabled: settings.engineEnabled,
      crudeSideMode: getCrudeSideMode(),
      policy: {
        onlyMarkets: ['XAUUSD', 'CRUDE OIL'],
        strategy: 'R15 score-based 30s microstructure + 1m EMA9/EMA21 RSI ATR',
        scoreThreshold: env.COMMODITY_SIGNAL_SCORE_MIN,
        paperInitialBalancePerVenue: env.COMMODITY_PAPER_INITIAL_BALANCE,
        marginPctPerTrade: env.COMMODITY_MARGIN_PCT,
        minEdgeMultipleVsCosts: env.COMMODITY_MIN_EDGE_MULTIPLE,
        crudeSideMode: getCrudeSideMode(),
        backtest: {
          maxDays: env.COMMODITY_BACKTEST_MAX_DAYS,
          model: 'HISTORICAL_1M_APPROXIMATION',
          forwardModel: 'LIVE_30S_1M_EXACT',
        },
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
        binance: { configured: binance.hasCredentials(), connected: binanceStatus?.lastTestOk === true, masked: binanceStatus?.maskedPrimary, lastError: binanceStatus?.lastError },
        aster: { configured: aster.hasCredentials(), label: 'Aster / Binance Wallet for CLUSDT' },
        mt5: { configured: Boolean(vault.getMt5(workspaceId)?.bridgeUrl || env.MT5_BRIDGE_URL), connected: mt5Status?.lastTestOk === true, masked: mt5Status?.maskedPrimary, lastError: mt5Status?.lastError },
      },
      exchange: exchangeState,
      forex: mt5State,
      backtest: { XAU: backtest.getState('XAU'), CRUDE: backtest.getState('CRUDE') },
      comparison: buildComparison(allTrades),
      recentTrades: allTrades.slice(0, 400).map(mapDbTrade),
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: message(error) });
  }
});

app.get('/api/chart/:kind/:venue', async (req, res) => {
  try {
    const kind = parseKind(req.params.kind);
    const venue = String(req.params.venue).toUpperCase();
    if (!kind) return res.status(400).json({ ok: false, error: 'INVALID_MARKET' });
    if (venue === 'EXCHANGE') return res.json(await exchange.chart(kind));
    if (venue === 'MT5') return res.json(await forex.chart(kind));
    return res.status(400).json({ ok: false, error: 'INVALID_VENUE' });
  } catch (error) {
    res.status(500).json({ ok: false, error: message(error) });
  }
});

app.get('/api/stream/:kind/:venue', (req, res) => {
  const kind = parseKind(req.params.kind);
  const venue = String(req.params.venue).toUpperCase();
  if (!kind || (venue !== 'EXCHANGE' && venue !== 'MT5')) return res.status(400).json({ ok: false, error: 'INVALID_STREAM' });
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  let closed = false;
  let busy = false;
  const send = async () => {
    if (closed || busy) return;
    busy = true;
    try {
      const payload = venue === 'EXCHANGE' ? await exchange.liveTick(kind) : await forex.liveTick(kind);
      res.write(`event: tick\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch (error) {
      res.write(`event: stream_error\ndata: ${JSON.stringify({ error: message(error), at: Date.now() })}\n\n`);
    } finally {
      busy = false;
    }
  };
  void send();
  const timer = setInterval(() => void send(), env.COMMODITY_STREAM_MS);
  req.on('close', () => { closed = true; clearInterval(timer); });
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
    if (patch.crudeSideMode) setCrudeSideMode(patch.crudeSideMode);
    exchange.setEnabled(next.engineEnabled);
    forex.setEnabled(next.engineEnabled);
    res.json({ ok: true, settings: next, crudeSideMode: getCrudeSideMode() });
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
  res.json({ ok: true, engineEnabled: true, results: settled.map((row) => row.status === 'fulfilled' ? { ok: true } : { ok: false, error: message(row.reason) }) });
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

app.post('/api/backtest/start', (req, res) => {
  try {
    const input = backtestSchema.parse(req.body);
    const kind = input.kind as CommodityKindR15;
    const state = exchange.getState() as any;
    const instrument = Array.isArray(state.instruments) ? state.instruments.find((row: any) => row.kind === kind) : undefined;
    const spread = Math.max(0, Number(instrument?.spreadPct ?? (kind === 'XAU' ? env.COMMODITY_MAX_SPREAD_PCT_XAU * 0.5 : env.COMMODITY_MAX_SPREAD_PCT_CL * 0.5)));
    const leverage = Math.max(1, Number(instrument?.maxLeverage ?? (kind === 'XAU' ? 10 : 20)));
    const started = backtest.run({ kind, days: input.days, crudeSideMode: getCrudeSideMode(), assumedSpreadPct: spread, leverage });
    res.status(202).json({ ok: true, backtest: started });
  } catch (error) {
    res.status(400).json({ ok: false, error: message(error) });
  }
});

app.get('/api/backtest/:kind', (req, res) => {
  const kind = parseKind(req.params.kind);
  if (!kind) return res.status(400).json({ ok: false, error: 'INVALID_MARKET' });
  res.json({ ok: true, backtest: backtest.getState(kind) });
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
  console.log(`[R15-DUAL] listening on 0.0.0.0:${env.PORT}`);
  console.log(`[R15-DUAL] mode=${getSettings().appMode} engine=${getSettings().engineEnabled ? 'ON' : 'OFF'} crude=${getCrudeSideMode()}`);
  console.log(`[R15-DUAL] score>=${env.COMMODITY_SIGNAL_SCORE_MIN} stream=${env.COMMODITY_STREAM_MS}ms paper=$${env.COMMODITY_PAPER_INITIAL_BALANCE}/venue`);
  exchange.start();
  forex.start();
});

function parseKind(value: unknown): CommodityKindR15 | null {
  const upper = String(value ?? '').toUpperCase();
  return upper === 'XAU' || upper === 'CRUDE' ? upper : null;
}

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
    const grossWin = closed.filter((row) => row.realizedPnl > 0).reduce((sum, row) => sum + row.realizedPnl, 0);
    const grossLoss = Math.abs(closed.filter((row) => row.realizedPnl < 0).reduce((sum, row) => sum + row.realizedPnl, 0));
    return {
      key: group.key,
      display: group.display,
      source: group.source,
      trades: closed.length,
      wins,
      losses: closed.length - wins,
      winRate: closed.length ? wins / closed.length * 100 : 0,
      netPnl: closed.reduce((sum, row) => sum + row.realizedPnl, 0),
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? null : 0,
      avgSpreadPct: closed.length ? closed.reduce((sum, row) => sum + row.entrySpreadPct, 0) / closed.length : 0,
      avgLeverage: closed.length ? closed.reduce((sum, row) => sum + row.leverage, 0) / closed.length : 0,
      avgHoldSeconds: closed.length ? closed.reduce((sum, row) => sum + Math.max(0, (Number(row.closeTime ?? row.openTime) - row.openTime) / 1000), 0) / closed.length : 0,
      open: group.rows.filter((row) => row.state === 'OPEN').length,
    };
  });
}

function mapDbTrade(row: Record<string, unknown>) {
  let metadata: any;
  try { metadata = row.metadata ? JSON.parse(String(row.metadata)) : undefined; } catch {}
  return {
    id:String(row.id),venue:String(row.venue),mode:String(row.mode),symbol:String(row.symbol),displaySymbol:String(row.display_symbol),side:String(row.side),state:String(row.state),
    entryPrice:Number(row.entry_price),exitPrice:row.exit_price==null?undefined:Number(row.exit_price),stopLoss:Number(row.stop_loss),takeProfit:Number(row.take_profit),quantity:Number(row.quantity),leverage:Number(row.leverage),
    marginUsed:Number(row.margin_used),entrySpreadPct:Number(row.entry_spread_pct),estimatedRoundTripCostPct:Number(row.estimated_round_trip_cost_pct),realizedPnl:Number(row.realized_pnl),unrealizedPnl:Number(row.unrealized_pnl),
    openTime:Number(row.open_time),closeTime:row.close_time==null?undefined:Number(row.close_time),closeReason:row.close_reason==null?undefined:String(row.close_reason),metadata,
  };
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
