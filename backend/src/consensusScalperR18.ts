import crypto from 'node:crypto';
import { env } from './config.js';
import { evaluateConsensus100R18, type ConsensusDiagnosticR18 } from './consensus100R18.js';
import { effectiveSides, type CommodityBookR15, type CommodityCandleR15, type CommodityKindR15, type CommodityMicroBarR15, type CrudeSideModeR15 } from './commodityStrategyR15.js';
import { TradingDatabase } from './database.js';
import type { ExchangeCommodityScalperR15 } from './exchangeCommodityScalperR15.js';
import type { Mt5CommodityScalperR15 } from './mt5CommodityScalperR15.js';
import { TelegramService } from './telegram.js';
import type { TradeSide } from './types.js';

interface ChartSourceR18 { chart(kind: CommodityKindR15): Promise<Record<string, unknown>>; }
type VenueR18 = 'EXCHANGE' | 'MT5';

interface LegR18 {
  venue: VenueR18;
  kind: CommodityKindR15;
  symbol: string;
  leverage: number;
  feePct: number;
  slippagePct: number;
  maxSpreadPct: number;
}

export interface ConsensusTradeR18 {
  id: string;
  venue: VenueR18;
  kind: CommodityKindR15;
  symbol: string;
  side: TradeSide;
  state: 'OPEN' | 'CLOSED';
  entry: number;
  exit?: number;
  stopLoss: number;
  takeProfit: number;
  leverage: number;
  marginUsed: number;
  quantity: number;
  spreadPct: number;
  costPct: number;
  buyVotes: number;
  sellVotes: number;
  familyCount: number;
  realizedPnl: number;
  unrealizedPnl: number;
  openTime: number;
  closeTime?: number;
  closeReason?: string;
  metadata?: Record<string, unknown>;
}

export class ConsensusScalperR18 {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private enabled = false;
  private readonly lastBuckets = new Map<string, number>();
  private readonly diagnostics = new Map<string, ConsensusDiagnosticR18 & Record<string, unknown>>();
  private readonly paperStartExchange: number;
  private readonly paperStartMt5: number;

  constructor(
    private readonly database: TradingDatabase,
    private readonly exchange: ExchangeCommodityScalperR15,
    private readonly forex: Mt5CommodityScalperR15,
    private readonly telegram: TelegramService,
    private readonly getCrudeSideMode: () => CrudeSideModeR15,
  ) {
    this.ensureSchema();
    this.paperStartExchange = this.ensurePaperStart('EXCHANGE');
    this.paperStartMt5 = this.ensurePaperStart('MT5');
  }

  start(): void {
    this.enabled = true;
    if (this.timer) return;
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), Math.max(1000, Math.min(5000, env.COMMODITY_LOOP_MS)));
    this.timer.unref();
  }
  stop(): void { this.enabled = false; if (this.timer) clearInterval(this.timer); this.timer = null; }
  isEnabled(): boolean { return this.enabled; }

  async runOnce(): Promise<void> {
    if (this.running || !this.enabled) return;
    this.running = true;
    const startedAt = Date.now();
    try {
      const legs: Array<{ source: ChartSourceR18; leg: LegR18 }> = [
        { source: this.exchange, leg: { venue:'EXCHANGE',kind:'XAU',symbol:'XAUUSDT',leverage:10,feePct:env.COMMODITY_TAKER_FEE_PCT_BINANCE,slippagePct:env.COMMODITY_SLIPPAGE_PCT,maxSpreadPct:env.COMMODITY_MAX_SPREAD_PCT_XAU } },
        { source: this.exchange, leg: { venue:'EXCHANGE',kind:'CRUDE',symbol:'CLUSDT',leverage:10,feePct:env.COMMODITY_TAKER_FEE_PCT_ASTER,slippagePct:env.COMMODITY_SLIPPAGE_PCT,maxSpreadPct:env.COMMODITY_MAX_SPREAD_PCT_CL } },
        { source: this.forex, leg: { venue:'MT5',kind:'XAU',symbol:'XAUUSD',leverage:10,feePct:env.MT5_COMMODITY_COMMISSION_PCT,slippagePct:env.MT5_COMMODITY_SLIPPAGE_PCT,maxSpreadPct:env.MT5_COMMODITY_MAX_SPREAD_PCT_XAU } },
        { source: this.forex, leg: { venue:'MT5',kind:'CRUDE',symbol:'CRUDE',leverage:10,feePct:env.MT5_COMMODITY_COMMISSION_PCT,slippagePct:env.MT5_COMMODITY_SLIPPAGE_PCT,maxSpreadPct:env.MT5_COMMODITY_MAX_SPREAD_PCT_CL } },
      ];
      const settled = await Promise.allSettled(legs.map(x => this.process(x.source, x.leg)));
      const results = settled.map((r,i) => r.status === 'fulfilled' ? r.value : { venue:legs[i].leg.venue,kind:legs[i].leg.kind,error:message(r.reason) });
      this.saveState({ status:'RUNNING',enabled:true,startedAt,completedAt:Date.now(),policy:{strategies:100,timeframe:'30s',minVotes:5,minFamilies:3,minVoteLead:2,mode:'PAPER_ONLY',marginPct:1},results,summary:this.summary() });
    } finally { this.running = false; }
  }

  getState(): Record<string, unknown> {
    const row=this.database.db.prepare(`SELECT value,updated_at FROM engine_state WHERE key='consensusScalperR18'`).get() as {value:string;updated_at:number}|undefined;
    if(!row)return{status:'STARTING',enabled:this.enabled,summary:this.summary()};
    try{return{...JSON.parse(row.value),updatedAt:row.updated_at,enabled:this.enabled,summary:this.summary(),recent:this.recent(120)}}catch{return{status:'STATE_ERROR',enabled:this.enabled,summary:this.summary()}}
  }

  summary(): Record<string, unknown> {
    return { EXCHANGE:this.venueSummary('EXCHANGE',this.paperStartExchange), MT5:this.venueSummary('MT5',this.paperStartMt5) };
  }
  recent(limit=100): ConsensusTradeR18[] {
    const rows=this.database.db.prepare(`SELECT * FROM consensus_trades_r18 ORDER BY open_time DESC LIMIT ?`).all(Math.max(1,Math.min(500,limit))) as Record<string,unknown>[];
    return rows.map(mapTrade);
  }

  private async process(source: ChartSourceR18, leg: LegR18): Promise<Record<string, unknown>> {
    const chart=await source.chart(leg.kind);
    if(chart.ok===false)throw new Error(String(chart.error??'CHART_ERROR'));
    const m1=(chart.m1??[]) as CommodityCandleR15[];
    const micro=(chart.micro30s??[]) as CommodityMicroBarR15[];
    const bid=Number(chart.bid??0),ask=Number(chart.ask??0);
    const book:CommodityBookR15={bid,ask,time:Number(chart.updatedAt??Date.now())};
    const actualSymbol=String(chart.symbol??leg.symbol);
    const effectiveLeg={...leg,symbol:actualSymbol};
    await this.monitor(effectiveLeg,book);
    const sides=effectiveSides(leg.kind,this.getCrudeSideMode());
    const diagnostic=evaluateConsensus100R18({kind:leg.kind,allowLong:sides.allowLong,allowShort:sides.allowShort,maxSpreadPct:leg.maxSpreadPct,feePct:leg.feePct,slippagePct:leg.slippagePct,minVotes:5,minFamilies:3,minVoteLead:2},book,m1,micro);
    const key=`${leg.venue}:${leg.kind}`;
    this.diagnostics.set(key,{...diagnostic,symbol:actualSymbol,venue:leg.venue});
    const latest=micro.at(-1);
    const bucket=latest?.time??Math.floor(Date.now()/30000)*30000;
    if(diagnostic.signal&&!this.getOpen(leg.venue,leg.kind)&&this.lastBuckets.get(key)!==bucket){
      await this.open(effectiveLeg,diagnostic);
      this.lastBuckets.set(key,bucket);
    }
    return {venue:leg.venue,kind:leg.kind,symbol:actualSymbol,bid,ask,action:diagnostic.action,buyVotes:diagnostic.buyVotes,sellVotes:diagnostic.sellVotes,buyFamilies:diagnostic.buyFamilies,sellFamilies:diagnostic.sellFamilies,reason:diagnostic.reason,spreadPct:diagnostic.spreadPct,costPct:diagnostic.costPct};
  }

  private async open(leg: LegR18, diagnostic: ConsensusDiagnosticR18): Promise<void> {
    const signal=diagnostic.signal;if(!signal)return;
    const summary=this.venueSummary(leg.venue,leg.venue==='EXCHANGE'?this.paperStartExchange:this.paperStartMt5);
    const balance=Number(summary.balance??50);
    const margin=balance*0.01;
    const notional=margin*leg.leverage;
    const quantity=notional/Math.max(signal.entry,1e-9);
    const trade:ConsensusTradeR18={id:`R18-${crypto.randomUUID()}`,venue:leg.venue,kind:leg.kind,symbol:leg.symbol,side:signal.side,state:'OPEN',entry:signal.entry,stopLoss:signal.stopLoss,takeProfit:signal.takeProfit,leverage:leg.leverage,marginUsed:margin,quantity,spreadPct:signal.spreadPct,costPct:signal.costPct,buyVotes:diagnostic.buyVotes,sellVotes:diagnostic.sellVotes,familyCount:diagnostic.winningFamilies.length,realizedPnl:0,unrealizedPnl:0,openTime:Date.now(),metadata:{strategy:'R18_CONSENSUS_100_30S',votes:diagnostic.votes,winningFamilies:diagnostic.winningFamilies,targetPct:signal.targetPct,stopPct:signal.stopPct}};
    this.database.db.prepare(`INSERT INTO consensus_trades_r18(id,venue,kind,symbol,side,state,entry,exit,stop_loss,take_profit,leverage,margin_used,quantity,spread_pct,cost_pct,buy_votes,sell_votes,family_count,realized_pnl,unrealized_pnl,open_time,close_time,close_reason,metadata) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(trade.id,trade.venue,trade.kind,trade.symbol,trade.side,trade.state,trade.entry,null,trade.stopLoss,trade.takeProfit,trade.leverage,trade.marginUsed,trade.quantity,trade.spreadPct,trade.costPct,trade.buyVotes,trade.sellVotes,trade.familyCount,0,0,trade.openTime,null,null,JSON.stringify(trade.metadata));
    await this.telegram.alert(`R18 ${leg.venue} ${leg.kind} ${signal.side}`,`Consenso: ${Math.max(diagnostic.buyVotes,diagnostic.sellVotes)}/100\nFamilias: ${diagnostic.winningFamilies.length}\nEntrada: ${signal.entry}\nSL: ${signal.stopLoss}\nTP: ${signal.takeProfit}\nSpread: ${signal.spreadPct.toFixed(4)}%`).catch(()=>undefined);
  }

  private async monitor(leg: LegR18,book:CommodityBookR15):Promise<void>{
    const trade=this.getOpen(leg.venue,leg.kind);if(!trade)return;
    const exit=trade.side==='BUY'?book.bid:book.ask;
    const hitSl=trade.side==='BUY'?exit<=trade.stopLoss:exit>=trade.stopLoss;
    const hitTp=trade.side==='BUY'?exit>=trade.takeProfit:exit<=trade.takeProfit;
    const expired=Date.now()-trade.openTime>=10*60_000;
    const priceReturn=trade.side==='BUY'?(exit/trade.entry-1):(trade.entry/exit-1);
    const gross=trade.marginUsed*trade.leverage*priceReturn;
    const estimatedCost=trade.marginUsed*trade.leverage*(trade.costPct/100);
    const net=gross-estimatedCost;
    if(!hitSl&&!hitTp&&!expired){this.database.db.prepare(`UPDATE consensus_trades_r18 SET unrealized_pnl=? WHERE id=?`).run(net,trade.id);return;}
    this.database.db.prepare(`UPDATE consensus_trades_r18 SET state='CLOSED',exit=?,realized_pnl=?,unrealized_pnl=0,close_time=?,close_reason=? WHERE id=?`).run(exit,net,Date.now(),hitSl?'SL':hitTp?'TP':'TIME',trade.id);
  }

  private getOpen(venue:VenueR18,kind:CommodityKindR15):ConsensusTradeR18|null{
    const row=this.database.db.prepare(`SELECT * FROM consensus_trades_r18 WHERE venue=? AND kind=? AND state='OPEN' ORDER BY open_time DESC LIMIT 1`).get(venue,kind) as Record<string,unknown>|undefined;
    return row?mapTrade(row):null;
  }
  private venueSummary(venue:VenueR18,start:number):Record<string,unknown>{
    const rows=this.database.db.prepare(`SELECT * FROM consensus_trades_r18 WHERE venue=? AND open_time>=? ORDER BY open_time`).all(venue,start) as Record<string,unknown>[];
    const t=rows.map(mapTrade),closed=t.filter(x=>x.state==='CLOSED'),open=t.filter(x=>x.state==='OPEN');const realized=closed.reduce((s,x)=>s+x.realizedPnl,0),floating=open.reduce((s,x)=>s+x.unrealizedPnl,0),wins=closed.filter(x=>x.realizedPnl>0).length;
    return{initialBalance:50,balance:50+realized,equity:50+realized+floating,realizedPnl:realized,floatingPnl:floating,openPositions:open.length,closedTrades:closed.length,wins,losses:closed.length-wins,winRate:closed.length?wins/closed.length*100:0};
  }
  private ensurePaperStart(venue:VenueR18):number{const key=`r18PaperStart:${venue}`;const row=this.database.db.prepare(`SELECT value FROM engine_state WHERE key=?`).get(key) as {value:string}|undefined;if(row&&Number(row.value)>0)return Number(row.value);const now=Date.now();this.database.db.prepare(`INSERT INTO engine_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(key,String(now),now);return now;}
  private ensureSchema():void{this.database.db.exec(`CREATE TABLE IF NOT EXISTS consensus_trades_r18(id TEXT PRIMARY KEY,venue TEXT NOT NULL,kind TEXT NOT NULL,symbol TEXT NOT NULL,side TEXT NOT NULL,state TEXT NOT NULL,entry REAL NOT NULL,exit REAL,stop_loss REAL NOT NULL,take_profit REAL NOT NULL,leverage REAL NOT NULL,margin_used REAL NOT NULL,quantity REAL NOT NULL,spread_pct REAL NOT NULL,cost_pct REAL NOT NULL,buy_votes INTEGER NOT NULL,sell_votes INTEGER NOT NULL,family_count INTEGER NOT NULL,realized_pnl REAL NOT NULL DEFAULT 0,unrealized_pnl REAL NOT NULL DEFAULT 0,open_time INTEGER NOT NULL,close_time INTEGER,close_reason TEXT,metadata TEXT);CREATE UNIQUE INDEX IF NOT EXISTS ux_consensus_r18_open ON consensus_trades_r18(venue,kind) WHERE state='OPEN';CREATE INDEX IF NOT EXISTS idx_consensus_r18_time ON consensus_trades_r18(open_time DESC);`)}
  private saveState(value:Record<string,unknown>):void{this.database.db.prepare(`INSERT INTO engine_state(key,value,updated_at) VALUES('consensusScalperR18',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(JSON.stringify(value),Date.now())}
}

function mapTrade(r:Record<string,unknown>):ConsensusTradeR18{let metadata:Record<string,unknown>|undefined;try{metadata=r.metadata?JSON.parse(String(r.metadata)):undefined}catch{}return{id:String(r.id),venue:String(r.venue) as VenueR18,kind:String(r.kind) as CommodityKindR15,symbol:String(r.symbol),side:String(r.side) as TradeSide,state:String(r.state) as 'OPEN'|'CLOSED',entry:Number(r.entry),exit:r.exit==null?undefined:Number(r.exit),stopLoss:Number(r.stop_loss),takeProfit:Number(r.take_profit),leverage:Number(r.leverage),marginUsed:Number(r.margin_used),quantity:Number(r.quantity),spreadPct:Number(r.spread_pct),costPct:Number(r.cost_pct),buyVotes:Number(r.buy_votes),sellVotes:Number(r.sell_votes),familyCount:Number(r.family_count),realizedPnl:Number(r.realized_pnl),unrealizedPnl:Number(r.unrealized_pnl),openTime:Number(r.open_time),closeTime:r.close_time==null?undefined:Number(r.close_time),closeReason:r.close_reason==null?undefined:String(r.close_reason),metadata}}
function message(error:unknown):string{return error instanceof Error?error.message:String(error)}
