import cors from 'cors';
import express from 'express';
import { z } from 'zod';
import { AsterV3Client } from './aster.js';
import { BinanceUsdmClient } from './binance.js';
import { CommodityBacktestR15 } from './commodityBacktestR15.js';
import type { CommodityKindR15, CrudeSideModeR15 } from './commodityStrategyR15.js';
import { ConsensusScalperR18 } from './consensusScalperR18.js';
import { defaultSettings, env } from './config.js';
import { TradingDatabase } from './database.js';
import { ExchangeCommodityScalperR15 } from './exchangeCommodityScalperR15.js';
import { createIntegrationRouter } from './integrationRoutes.js';
import { IntegrationVault, normalizeWorkspaceId } from './integrationVault.js';
import { Mt5BridgeClient } from './mt5.js';
import { Mt5CommodityScalperR15 } from './mt5CommodityScalperR15.js';
import { TelegramService } from './telegram.js';
import type { EngineSettings } from './types.js';
import { XauTsmomPaperService } from './xauTsmomPaper.js';

const RELEASE = 'R18';
const EDITION = 'CONSENSUS_100_STRATEGIES_30S_PAPER';
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const database = new TradingDatabase(env.DB_PATH);
const persisted = { ...defaultSettings(), ...(database.getSettings() ?? {}) } as EngineSettings;
database.saveSettings({
  ...persisted,
  appMode: 'PAPER',
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
  appMode: 'PAPER',
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
  database.db.prepare(`INSERT INTO engine_state(key,value,updated_at) VALUES('r15CrudeSideMode',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(value, Date.now());
}

// Data providers only. Their rejected R15 signal engines stay disabled.
const exchange = new ExchangeCommodityScalperR15(database, binance, aster, telegram, () => getSettings().appMode, getCrudeSideMode);
const forex = new Mt5CommodityScalperR15(database, mt5, telegram, () => getSettings().appMode, getCrudeSideMode);
exchange.setEnabled(false);
forex.setEnabled(false);

// Previously validated slow model remains visible for comparison, not automatic in R18.
const xauTsmom = new XauTsmomPaperService(database);
xauTsmom.stop();

const consensus = new ConsensusScalperR18(database, exchange, forex, telegram, getCrudeSideMode);
const backtest = new CommodityBacktestR15(aster);
if (getSettings().engineEnabled) consensus.start();

app.use('/api/integrations', createIntegrationRouter(vault, getSettings, () => workspaceId));

const settingsSchema = z.object({
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
    service: 'Quantum Commodities Consensus R18',
    release: RELEASE,
    edition: EDITION,
    mode: 'PAPER',
    engineEnabled: getSettings().engineEnabled,
    automaticModel: 'R18_CONSENSUS_100_30S',
    strategyCount: 100,
    minAgreement: 5,
    minFamilies: 3,
    paperInitialBalancePerVenue: 50,
    crudeSideMode: getCrudeSideMode(),
    streamIntervalMs: env.COMMODITY_STREAM_MS,
    realExecutionLocked: true,
  });
});

app.get('/api/state', (_req, res) => {
  try {
    const settings = getSettings();
    const integrations = vault.getStatus(workspaceId);
    const mt5Status = integrations.find((row) => row.provider === 'MT5');
    const binanceStatus = integrations.find((row) => row.provider === 'BINANCE');
    res.json({
      ok: true,
      release: RELEASE,
      edition: EDITION,
      workspaceId,
      mode: 'PAPER',
      engineEnabled: settings.engineEnabled,
      crudeSideMode: getCrudeSideMode(),
      consensusPolicy: {
        model: 'R18_CONSENSUS_100_30S',
        strategies: 100,
        families: 10,
        variantsPerFamily: 10,
        minVotesSameDirection: 5,
        minDistinctFamilies: 3,
        minVoteLead: 2,
        timeframe: '30s',
        entry: 'dominant BUY/SELL vote + spread/cost veto',
        paperOnly: true,
        marginPctPerTrade: 1,
        maxOneOpenPerVenueMarket: true,
      },
      strategyFamilies: ['EMA_TREND','MOMENTUM','BREAKOUT','PULLBACK','RSI','BOLLINGER','VWAP','FLOW','VOLUME_EXPANSION','CANDLE_STRUCTURE'],
      referenceModel: {
        status: 'REFERENCE_ONLY',
        model: 'XAU_TSMOM_16H_ROBUST_R15',
        historicalTrades: 94,
        historicalWinRate: 54.26,
        historicalProfitFactor: 1.336,
      },
      integrations: {
        binance: { configured: binance.hasCredentials(), connected: binanceStatus?.lastTestOk === true, masked: binanceStatus?.maskedPrimary, lastError: binanceStatus?.lastError },
        aster: { configured: aster.hasCredentials(), label: 'Aster / Binance Wallet for CLUSDT' },
        mt5: { configured: Boolean(vault.getMt5(workspaceId)?.bridgeUrl || env.MT5_BRIDGE_URL), connected: mt5Status?.lastTestOk === true, masked: mt5Status?.maskedPrimary, lastError: mt5Status?.lastError },
      },
      consensus: consensus.getState(),
      observation: { exchange: exchange.getState(), forex: forex.getState() },
      backtest: { XAU: backtest.getState('XAU'), CRUDE: backtest.getState('CRUDE') },
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
  } catch (error) { res.status(500).json({ ok: false, error: message(error) }); }
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
  let closed = false, busy = false;
  const send = async () => {
    if (closed || busy) return;
    busy = true;
    try {
      const payload = venue === 'EXCHANGE' ? await exchange.liveTick(kind) : await forex.liveTick(kind);
      res.write(`event: tick\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch (error) { res.write(`event: stream_error\ndata: ${JSON.stringify({ error: message(error), at: Date.now() })}\n\n`); }
    finally { busy = false; }
  };
  void send();
  const timer = setInterval(() => void send(), env.COMMODITY_STREAM_MS);
  req.on('close', () => { closed = true; clearInterval(timer); });
});

app.patch('/api/settings', (req, res) => {
  try {
    const patch = settingsSchema.parse(req.body);
    const current = getSettings();
    const next: EngineSettings = { ...current, appMode: 'PAPER', engineEnabled: patch.engineEnabled ?? current.engineEnabled, cryptoEnabled: false, forexEnabled: true, forexExecutionMode: 'SIGNAL_ONLY' };
    database.saveSettings(next);
    if (patch.crudeSideMode) setCrudeSideMode(patch.crudeSideMode);
    if (next.engineEnabled) consensus.start(); else consensus.stop();
    exchange.setEnabled(false); forex.setEnabled(false); xauTsmom.stop();
    res.json({ ok: true, settings: next, crudeSideMode: getCrudeSideMode(), consensus: consensus.getState() });
  } catch (error) { res.status(400).json({ ok: false, error: message(error) }); }
});

app.post('/api/start', async (_req, res) => {
  const current = getSettings();
  database.saveSettings({ ...current, appMode: 'PAPER', engineEnabled: true, cryptoEnabled: false, forexEnabled: true, forexExecutionMode: 'SIGNAL_ONLY' });
  exchange.setEnabled(false); forex.setEnabled(false); xauTsmom.stop(); consensus.start();
  await consensus.runOnce();
  res.json({ ok: true, engineEnabled: true, model: 'R18_CONSENSUS_100_30S', state: consensus.getState() });
});

app.post('/api/pause', (_req, res) => {
  const current = getSettings();
  database.saveSettings({ ...current, appMode: 'PAPER', engineEnabled: false, cryptoEnabled: false, forexEnabled: true, forexExecutionMode: 'SIGNAL_ONLY' });
  consensus.stop(); xauTsmom.stop(); exchange.setEnabled(false); forex.setEnabled(false);
  res.json({ ok: true, engineEnabled: false });
});

app.post('/api/run', async (_req, res) => {
  if (!consensus.isEnabled()) consensus.start();
  await consensus.runOnce();
  res.json({ ok: true, model: 'R18_CONSENSUS_100_30S', state: consensus.getState() });
});

app.get('/api/consensus/trades', (_req, res) => res.json({ ok:true, summary:consensus.summary(), recent:consensus.recent(300) }));

app.post('/api/backtest/start', (req, res) => {
  try {
    const input = backtestSchema.parse(req.body);
    const kind = input.kind as CommodityKindR15;
    const started = backtest.run({ kind, days: input.days, crudeSideMode: getCrudeSideMode(), assumedSpreadPct: kind === 'XAU' ? 0.025 : env.COMMODITY_MAX_SPREAD_PCT_CL * 0.5, leverage: kind === 'XAU' ? 10 : 10 });
    res.status(202).json({ ok: true, backtest: started, note:'Legacy R15 approximation. R18 consensus uses dedicated historical lab.' });
  } catch (error) { res.status(400).json({ ok: false, error: message(error) }); }
});
app.get('/api/backtest/:kind', (req, res) => {
  const kind = parseKind(req.params.kind);
  if (!kind) return res.status(400).json({ ok: false, error: 'INVALID_MARKET' });
  res.json({ ok: true, backtest: backtest.getState(kind) });
});

app.get('/api/trades', (_req, res) => {
  res.json({ ok: true, model:'R18_CONSENSUS_100_30S', consensus:consensus.getState(), paper:consensus.summary(), recent:consensus.recent(300) });
});

app.get('/api/mt5/test', async (_req, res) => {
  try { const health = await mt5.health(); const symbols = await mt5.symbols(); res.json({ ok: true, account: health.account, symbolCount: symbols.length }); }
  catch (error) { res.status(400).json({ ok: false, error: message(error) }); }
});
app.get('/api/aster/test-public', async (_req, res) => {
  try { res.json(await aster.testPublic()); } catch (error) { res.status(500).json({ ok: false, error: message(error) }); }
});

app.listen(env.PORT, '0.0.0.0', () => {
  console.log(`[R18] listening on 0.0.0.0:${env.PORT}`);
  console.log('[R18] PAPER 100 strategies @30s; entry requires >=5 same-side votes from >=3 families');
  if (getSettings().engineEnabled) consensus.start();
});

function parseKind(value: unknown): CommodityKindR15 | null {
  const upper = String(value ?? '').toUpperCase();
  return upper === 'XAU' || upper === 'CRUDE' ? upper : null;
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
