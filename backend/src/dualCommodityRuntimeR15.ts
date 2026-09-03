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

const RELEASE = 'R15.1';
const EDITION = 'XAU_TSMOM_ROBUST_PAPER_PLUS_R18_CONSENSUS_LAB';
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const database = new TradingDatabase(env.DB_PATH);
const persisted = { ...defaultSettings(), ...(database.getSettings() ?? {}) } as EngineSettings;
database.saveSettings({ ...persisted, appMode:'PAPER', cryptoEnabled:false, forexEnabled:true, forexExecutionMode:'SIGNAL_ONLY', maxConcurrentForexTrades:2, forexMaxEntriesPerSymbol:1, forexRiskMode:'MARGIN_PERCENT', forexPctPerTrade:env.COMMODITY_MARGIN_PCT });
const getSettings=():EngineSettings=>({ ...defaultSettings(), ...(database.getSettings()??{}), appMode:'PAPER', cryptoEnabled:false, forexEnabled:true, forexExecutionMode:'SIGNAL_ONLY', maxConcurrentForexTrades:2, forexMaxEntriesPerSymbol:1, forexRiskMode:'MARGIN_PERCENT', forexPctPerTrade:env.COMMODITY_MARGIN_PCT });

const workspaceId=normalizeWorkspaceId(env.DEFAULT_WORKSPACE_ID),vault=new IntegrationVault(database),telegram=new TelegramService(()=>vault.getTelegram(workspaceId)),binance=new BinanceUsdmClient(getSettings,()=>vault.getBinance(workspaceId)),aster=new AsterV3Client(),mt5=new Mt5BridgeClient(getSettings,()=>vault.getMt5(workspaceId));
function getCrudeSideMode():CrudeSideModeR15{const row=database.db.prepare(`SELECT value FROM engine_state WHERE key='r15CrudeSideMode'`).get() as {value:string}|undefined;const value=String(row?.value??'BUY').toUpperCase();return value==='SELL'||value==='BOTH'?value:'BUY';}
function setCrudeSideMode(value:CrudeSideModeR15):void{database.db.prepare(`INSERT INTO engine_state(key,value,updated_at) VALUES('r15CrudeSideMode',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(value,Date.now());}

const exchange=new ExchangeCommodityScalperR15(database,binance,aster,telegram,()=>getSettings().appMode,getCrudeSideMode),forex=new Mt5CommodityScalperR15(database,mt5,telegram,()=>getSettings().appMode,getCrudeSideMode);exchange.setEnabled(false);forex.setEnabled(false);
const xauTsmom=new XauTsmomPaperService(database);
const consensus=new ConsensusScalperR18(database,exchange,forex,telegram,getCrudeSideMode);consensus.stop();
const backtest=new CommodityBacktestR15(aster);
if(getSettings().engineEnabled)xauTsmom.start();
app.use('/api/integrations',createIntegrationRouter(vault,getSettings,()=>workspaceId));

const settingsSchema=z.object({engineEnabled:z.boolean().optional(),crudeSideMode:z.enum(['BUY','SELL','BOTH']).optional()});
const backtestSchema=z.object({kind:z.enum(['XAU','CRUDE']),days:z.union([z.number().int().min(7).max(env.COMMODITY_BACKTEST_MAX_DAYS),z.literal('MAX')]).default(30)});

app.get('/health',(_req,res)=>res.json({ok:true,service:'Quantum Commodities Dual R15.1',release:RELEASE,edition:EDITION,mode:'PAPER',engineEnabled:getSettings().engineEnabled,validatedAutomaticModel:'XAU_TSMOM_16H_ROBUST_R15',experimentalRejectedModel:'R18_CONSENSUS_100_30S',experimentalBacktestStatus:'FAILED_TRAIN_VALIDATION_TEST',paperInitialBalance:50,crudeSideMode:getCrudeSideMode(),streamIntervalMs:env.COMMODITY_STREAM_MS}));
app.get('/api/state',(_req,res)=>{try{const settings=getSettings(),integrations=vault.getStatus(workspaceId),mt5Status=integrations.find(r=>r.provider==='MT5'),binanceStatus=integrations.find(r=>r.provider==='BINANCE');res.json({ok:true,release:RELEASE,edition:EDITION,workspaceId,mode:'PAPER',engineEnabled:settings.engineEnabled,crudeSideMode:getCrudeSideMode(),validation:{status:'ROBUST_PASS',model:'XAU_TSMOM_16H_ROBUST_R15',historicalTrades:94,historicalWinRate:54.26,historicalProfitFactor:1.336,historicalReturnPct:1.584,historicalMaxDrawdownPct:.867,blindTestTrades:19,blindTestProfitFactor:1.173,blindTestReturnPct:.154},experimentalConsensus:{status:'REJECTED_BACKTEST_PAPER_LAB_ONLY',model:'R18_CONSENSUS_100_30S',strategies:100,minVotes:5,minFamilies:3,backtestDays:14,trainReturnPct:-15.606,validationReturnPct:-8.284,testReturnPct:-8.246,trainTrades:998,validationTrades:503,testTrades:509,sweepSurvivors:0,service:consensus.getState()},integrations:{binance:{configured:binance.hasCredentials(),connected:binanceStatus?.lastTestOk===true,masked:binanceStatus?.maskedPrimary,lastError:binanceStatus?.lastError},aster:{configured:aster.hasCredentials(),label:'Aster / Binance Wallet for CLUSDT'},mt5:{configured:Boolean(vault.getMt5(workspaceId)?.bridgeUrl||env.MT5_BRIDGE_URL),connected:mt5Status?.lastTestOk===true,masked:mt5Status?.maskedPrimary,lastError:mt5Status?.lastError}},xauTsmom:xauTsmom.getState(),observation:{exchange:exchange.getState(),forex:forex.getState()},backtest:{XAU:backtest.getState('XAU'),CRUDE:backtest.getState('CRUDE')}});}catch(error){res.status(500).json({ok:false,error:message(error)});}});

app.get('/api/chart/:kind/:venue',async(req,res)=>{try{const kind=parseKind(req.params.kind),venue=String(req.params.venue).toUpperCase();if(!kind)return res.status(400).json({ok:false,error:'INVALID_MARKET'});if(venue==='EXCHANGE')return res.json(await exchange.chart(kind));if(venue==='MT5')return res.json(await forex.chart(kind));return res.status(400).json({ok:false,error:'INVALID_VENUE'});}catch(error){res.status(500).json({ok:false,error:message(error)});}});
app.get('/api/stream/:kind/:venue',(req,res)=>{const kind=parseKind(req.params.kind),venue=String(req.params.venue).toUpperCase();if(!kind||(venue!=='EXCHANGE'&&venue!=='MT5'))return res.status(400).json({ok:false,error:'INVALID_STREAM'});res.setHeader('Content-Type','text/event-stream');res.setHeader('Cache-Control','no-cache, no-transform');res.setHeader('Connection','keep-alive');res.setHeader('X-Accel-Buffering','no');res.flushHeaders?.();let closed=false,busy=false;const send=async()=>{if(closed||busy)return;busy=true;try{const payload=venue==='EXCHANGE'?await exchange.liveTick(kind):await forex.liveTick(kind);res.write(`event: tick\ndata: ${JSON.stringify(payload)}\n\n`);}catch(error){res.write(`event: stream_error\ndata: ${JSON.stringify({error:message(error),at:Date.now()})}\n\n`);}finally{busy=false;}};void send();const timer=setInterval(()=>void send(),env.COMMODITY_STREAM_MS);req.on('close',()=>{closed=true;clearInterval(timer);});});

app.patch('/api/settings',(req,res)=>{try{const patch=settingsSchema.parse(req.body),current=getSettings(),next:EngineSettings={...current,appMode:'PAPER',engineEnabled:patch.engineEnabled??current.engineEnabled,cryptoEnabled:false,forexEnabled:true,forexExecutionMode:'SIGNAL_ONLY'};database.saveSettings(next);if(patch.crudeSideMode)setCrudeSideMode(patch.crudeSideMode);if(next.engineEnabled)xauTsmom.start();else xauTsmom.stop();consensus.stop();exchange.setEnabled(false);forex.setEnabled(false);res.json({ok:true,settings:next,crudeSideMode:getCrudeSideMode()});}catch(error){res.status(400).json({ok:false,error:message(error)});}});
app.post('/api/start',async(_req,res)=>{const current=getSettings();database.saveSettings({...current,appMode:'PAPER',engineEnabled:true,cryptoEnabled:false,forexEnabled:true,forexExecutionMode:'SIGNAL_ONLY'});consensus.stop();exchange.setEnabled(false);forex.setEnabled(false);xauTsmom.start();await xauTsmom.runOnce();res.json({ok:true,engineEnabled:true,model:'XAU_TSMOM_16H_ROBUST_R15',state:xauTsmom.getState()});});
app.post('/api/pause',(_req,res)=>{const current=getSettings();database.saveSettings({...current,appMode:'PAPER',engineEnabled:false,cryptoEnabled:false,forexEnabled:true,forexExecutionMode:'SIGNAL_ONLY'});xauTsmom.stop();consensus.stop();exchange.setEnabled(false);forex.setEnabled(false);res.json({ok:true,engineEnabled:false});});
app.post('/api/run',async(_req,res)=>{await xauTsmom.runOnce();res.json({ok:true,model:'XAU_TSMOM_16H_ROBUST_R15',state:xauTsmom.getState()});});

// Explicit experimental PAPER lab. Never starts automatically and never enables REAL execution.
app.post('/api/experimental/consensus/start',async(_req,res)=>{consensus.start();await consensus.runOnce();res.json({ok:true,warning:'REJECTED_BACKTEST_PAPER_ONLY',state:consensus.getState()});});
app.post('/api/experimental/consensus/pause',(_req,res)=>{consensus.stop();res.json({ok:true,state:consensus.getState()});});
app.post('/api/experimental/consensus/run',async(_req,res)=>{if(!consensus.isEnabled())consensus.start();await consensus.runOnce();res.json({ok:true,warning:'REJECTED_BACKTEST_PAPER_ONLY',state:consensus.getState()});});
app.get('/api/experimental/consensus/trades',(_req,res)=>res.json({ok:true,summary:consensus.summary(),recent:consensus.recent(300)}));

app.post('/api/backtest/start',(req,res)=>{try{const input=backtestSchema.parse(req.body),kind=input.kind as CommodityKindR15,started=backtest.run({kind,days:input.days,crudeSideMode:getCrudeSideMode(),assumedSpreadPct:kind==='XAU'?.025:env.COMMODITY_MAX_SPREAD_PCT_CL*.5,leverage:10});res.status(202).json({ok:true,backtest:started});}catch(error){res.status(400).json({ok:false,error:message(error)});}});
app.get('/api/backtest/:kind',(req,res)=>{const kind=parseKind(req.params.kind);if(!kind)return res.status(400).json({ok:false,error:'INVALID_MARKET'});res.json({ok:true,backtest:backtest.getState(kind)});});
app.get('/api/trades',(_req,res)=>res.json({ok:true,xauTsmom:xauTsmom.getState(),paper:xauTsmom.summary(),recent:xauTsmom.recent(200)}));
app.get('/api/mt5/test',async(_req,res)=>{try{const health=await mt5.health(),symbols=await mt5.symbols();res.json({ok:true,account:health.account,symbolCount:symbols.length});}catch(error){res.status(400).json({ok:false,error:message(error)});}});
app.get('/api/aster/test-public',async(_req,res)=>{try{res.json(await aster.testPublic());}catch(error){res.status(500).json({ok:false,error:message(error)});}});
app.listen(env.PORT,'0.0.0.0',()=>{console.log(`[R15.1+R18LAB] listening on 0.0.0.0:${env.PORT}`);console.log('[AUTO] XAU TSMOM validated PAPER. [LAB] R18 100-strategy 30s consensus disabled by default after failed backtest.');if(getSettings().engineEnabled)xauTsmom.start();});
function parseKind(value:unknown):CommodityKindR15|null{const upper=String(value??'').toUpperCase();return upper==='XAU'||upper==='CRUDE'?upper:null;}
function message(error:unknown):string{return error instanceof Error?error.message:String(error);}
