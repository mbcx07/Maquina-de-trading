import { TradingDatabase } from './database.js';
import { env } from './config.js';

interface Candle { time:number; open:number; high:number; low:number; close:number; volume:number; }
interface TradeRow { id:string; side:'BUY'|'SELL'; state:'OPEN'|'CLOSED'; entryPrice:number; exitPrice?:number; quantity:number; notional:number; marginUsed:number; leverage:number; openTime:number; closeTime?:number; grossPnl:number; fees:number; funding:number; netPnl:number; closeReason?:string; signalBucket:number; }

const SYMBOL='XAUUSDT';
const LOOKBACK_15M=64;          // 16 hours
const MOMENTUM_THRESHOLD_PCT=1; // absolute move over lookback
const HOLD_BARS_15M=64;         // ~16 hours
const LEVERAGE=10;
const MARGIN_PCT=1;
const INITIAL_BALANCE=50;
const TAKER_FEE_PCT=0.05;
const SLIPPAGE_PCT=0.01;
const FUNDING_8H_PCT=0.005;     // conservative always-against allowance
const FIFTEEN=15*60_000;
const FOUR_HOURS=4*60*60_000;

export class XauTsmomPaperService {
  private timer: NodeJS.Timeout|null=null;
  private running=false;

  constructor(private readonly database:TradingDatabase){ this.ensureSchema(); }

  start(){
    if(this.timer) return;
    void this.runOnce();
    this.timer=setInterval(()=>void this.runOnce(),60_000);
    this.timer.unref();
  }
  stop(){ if(this.timer) clearInterval(this.timer); this.timer=null; }

  async runOnce(){
    if(this.running) return;
    this.running=true;
    try{
      const book=await this.book();
      const open=this.openTrade();
      if(open){
        const heldBars=Math.floor((Date.now()-open.openTime)/FIFTEEN);
        if(heldBars>=HOLD_BARS_15M){ await this.closeTrade(open,book, 'TSMOM_16H_TIME_EXIT'); }
        else this.mark(open,book);
      }

      if(!this.openTrade()){
        const [m15,h4]=await Promise.all([this.klines('15m',220),this.klines('4h',80)]);
        const signal=this.signal(m15,h4);
        if(signal){
          const bucket=Math.floor((m15.at(-1)?.time??Date.now())/FIFTEEN)*FIFTEEN;
          if(!this.wasBucketUsed(bucket)) await this.open(signal,book,bucket);
        }
      }
      this.saveState({status:'RUNNING',strategy:'XAU_TSMOM_16H_ROBUST_R15',updatedAt:Date.now(),paper:this.summary(),diagnostic:await this.diagnostic().catch(()=>null)});
    }catch(error){
      this.saveState({status:'ERROR',strategy:'XAU_TSMOM_16H_ROBUST_R15',error:error instanceof Error?error.message:String(error),updatedAt:Date.now(),paper:this.summary()});
    }finally{ this.running=false; }
  }

  getState(){
    const row=this.database.db.prepare("SELECT value FROM engine_state WHERE key='xauTsmomPaper'").get() as {value:string}|undefined;
    if(!row) return {status:'STARTING',strategy:'XAU_TSMOM_16H_ROBUST_R15',paper:this.summary()};
    try{return {...JSON.parse(row.value),paper:this.summary(),recent:this.recent(50)}}catch{return {status:'STATE_ERROR',paper:this.summary()}}
  }

  summary(){
    const rows=this.rows();
    const closed=rows.filter(r=>r.state==='CLOSED'),open=rows.find(r=>r.state==='OPEN');
    const net=closed.reduce((s,r)=>s+r.netPnl,0),floating=open?this.unrealized(open):0;
    const wins=closed.filter(r=>r.netPnl>0).length;
    const gp=closed.filter(r=>r.netPnl>0).reduce((s,r)=>s+r.netPnl,0),gl=Math.abs(closed.filter(r=>r.netPnl<0).reduce((s,r)=>s+r.netPnl,0));
    return {initialBalance:INITIAL_BALANCE,balance:INITIAL_BALANCE+net,equity:INITIAL_BALANCE+net+floating,realizedPnl:net,floatingPnl:floating,trades:closed.length,wins,losses:closed.length-wins,winRate:closed.length?wins/closed.length*100:0,profitFactor:gl>0?gp/gl:gp>0?99:0,openTrade:open??null};
  }
  recent(limit=50){ return this.rows().slice(-Math.max(1,limit)).reverse(); }

  private signal(m15:Candle[],h4:Candle[]):'BUY'|'SELL'|null{
    if(m15.length<120||h4.length<55) return null;
    const i=m15.length-1, now=m15[i],past=m15[i-LOOKBACK_15M];
    const momentum=(now.close-past.close)/past.close*100;
    if(Math.abs(momentum)<MOMENTUM_THRESHOLD_PCT) return null;
    const atrs=atrSeries(m15,14),currentAtrPct=atrs[i]/now.close*100;
    const avgAtrPct=mean(atrs.slice(Math.max(0,i-100),i).map((v,j)=>v/(m15[Math.max(0,i-100)+j]?.close||now.close)*100));
    if(!(currentAtrPct>=avgAtrPct)) return null;
    const closes=h4.map(x=>x.close),e20=ema(closes,20),e50=ema(closes,50);
    const buy=momentum>0&&e20.at(-1)!>=e50.at(-1)!;
    const sell=momentum<0&&e20.at(-1)!<=e50.at(-1)!;
    return buy?'BUY':sell?'SELL':null;
  }

  private async diagnostic(){
    const [m15,h4]=await Promise.all([this.klines('15m',220),this.klines('4h',80)]);
    const i=m15.length-1,past=m15[i-LOOKBACK_15M],momentum=(m15[i].close-past.close)/past.close*100;
    const c=h4.map(x=>x.close),e20=ema(c,20).at(-1)??0,e50=ema(c,50).at(-1)??0;
    return {timeframe:'15m signal + 4h regime',lookbackHours:16,holdHours:16,momentumPct:momentum,thresholdPct:MOMENTUM_THRESHOLD_PCT,h4Ema20:e20,h4Ema50:e50,signal:this.signal(m15,h4)??'WAIT'};
  }

  private async open(side:'BUY'|'SELL',book:{bid:number;ask:number},bucket:number){
    const balance=Number(this.summary().balance||INITIAL_BALANCE),margin=balance*MARGIN_PCT/100,notional=margin*LEVERAGE;
    const raw=side==='BUY'?book.ask:book.bid,entry=raw*(1+(side==='BUY'?1:-1)*SLIPPAGE_PCT/100),qty=notional/entry,fee=notional*TAKER_FEE_PCT/100;
    this.database.db.prepare(`INSERT INTO xau_tsmom_trades(id,side,state,entry_price,quantity,notional,margin_used,leverage,open_time,gross_pnl,fees,funding,net_pnl,signal_bucket,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(`TSMOM-${Date.now()}`,side,'OPEN',entry,qty,notional,margin,LEVERAGE,Date.now(),0,fee,0,-fee,bucket,Date.now(),Date.now());
  }

  private async closeTrade(t:TradeRow,book:{bid:number;ask:number},reason:string){
    const raw=t.side==='BUY'?book.bid:book.ask,exit=raw*(1+(t.side==='BUY'?-1:1)*SLIPPAGE_PCT/100),gross=t.side==='BUY'?(exit-t.entryPrice)*t.quantity:(t.entryPrice-exit)*t.quantity;
    const exitFee=t.quantity*exit*TAKER_FEE_PCT/100,heldHours=(Date.now()-t.openTime)/3_600_000,funding=t.notional*FUNDING_8H_PCT/100*Math.floor(heldHours/8),fees=t.fees+exitFee,net=gross-fees-funding;
    this.database.db.prepare(`UPDATE xau_tsmom_trades SET state='CLOSED',exit_price=?,close_time=?,gross_pnl=?,fees=?,funding=?,net_pnl=?,close_reason=?,updated_at=? WHERE id=?`).run(exit,Date.now(),gross,fees,funding,net,reason,Date.now(),t.id);
  }

  private mark(t:TradeRow,book:{bid:number;ask:number}){
    const exit=t.side==='BUY'?book.bid:book.ask,gross=t.side==='BUY'?(exit-t.entryPrice)*t.quantity:(t.entryPrice-exit)*t.quantity,heldHours=(Date.now()-t.openTime)/3_600_000,funding=t.notional*FUNDING_8H_PCT/100*Math.floor(heldHours/8),net=gross-t.fees-funding;
    this.database.db.prepare(`UPDATE xau_tsmom_trades SET gross_pnl=?,funding=?,net_pnl=?,updated_at=? WHERE id=?`).run(gross,funding,net,Date.now(),t.id);
  }
  private unrealized(t:TradeRow){return t.state==='OPEN'?t.netPnl:0;}
  private openTrade(){return this.rows().find(r=>r.state==='OPEN')??null;}
  private wasBucketUsed(bucket:number){return Boolean(this.database.db.prepare('SELECT 1 FROM xau_tsmom_trades WHERE signal_bucket=? LIMIT 1').get(bucket));}
  private rows():TradeRow[]{const rows=this.database.db.prepare('SELECT * FROM xau_tsmom_trades ORDER BY open_time ASC').all() as any[];return rows.map(r=>({id:String(r.id),side:r.side,state:r.state,entryPrice:Number(r.entry_price),exitPrice:r.exit_price==null?undefined:Number(r.exit_price),quantity:Number(r.quantity),notional:Number(r.notional),marginUsed:Number(r.margin_used),leverage:Number(r.leverage),openTime:Number(r.open_time),closeTime:r.close_time==null?undefined:Number(r.close_time),grossPnl:Number(r.gross_pnl),fees:Number(r.fees),funding:Number(r.funding),netPnl:Number(r.net_pnl),closeReason:r.close_reason??undefined,signalBucket:Number(r.signal_bucket)}));}

  private async book(){const r=await fetch(`${env.BINANCE_BASE_URL.replace(/\/$/,'')}/fapi/v1/ticker/bookTicker?symbol=${SYMBOL}`);if(!r.ok)throw new Error(`XAU_BOOK_HTTP_${r.status}`);const x=await r.json() as any;return{bid:Number(x.bidPrice),ask:Number(x.askPrice)};}
  private async klines(interval:'15m'|'4h',limit:number):Promise<Candle[]>{const r=await fetch(`${env.BINANCE_BASE_URL.replace(/\/$/,'')}/fapi/v1/klines?symbol=${SYMBOL}&interval=${interval}&limit=${limit}`);if(!r.ok)throw new Error(`XAU_KLINES_${interval}_HTTP_${r.status}`);const now=Date.now(),rows=await r.json() as any[];return rows.filter(x=>Number(x[6])<=now).map(x=>({time:Number(x[0]),open:Number(x[1]),high:Number(x[2]),low:Number(x[3]),close:Number(x[4]),volume:Number(x[5]||0)}));}
  private saveState(v:any){this.database.db.prepare(`INSERT INTO engine_state(key,value,updated_at) VALUES('xauTsmomPaper',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(JSON.stringify(v),Date.now());}
  private ensureSchema(){this.database.db.exec(`CREATE TABLE IF NOT EXISTS xau_tsmom_trades(id TEXT PRIMARY KEY,side TEXT NOT NULL,state TEXT NOT NULL,entry_price REAL NOT NULL,exit_price REAL,quantity REAL NOT NULL,notional REAL NOT NULL,margin_used REAL NOT NULL,leverage REAL NOT NULL,open_time INTEGER NOT NULL,close_time INTEGER,gross_pnl REAL NOT NULL DEFAULT 0,fees REAL NOT NULL DEFAULT 0,funding REAL NOT NULL DEFAULT 0,net_pnl REAL NOT NULL DEFAULT 0,close_reason TEXT,signal_bucket INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);CREATE UNIQUE INDEX IF NOT EXISTS ux_xau_tsmom_open ON xau_tsmom_trades(state) WHERE state='OPEN';CREATE INDEX IF NOT EXISTS idx_xau_tsmom_time ON xau_tsmom_trades(open_time DESC);`);}
}

function ema(v:number[],p:number){if(!v.length)return[];const a=2/(p+1),o=[v[0]];for(let i=1;i<v.length;i++)o.push(v[i]*a+o[i-1]*(1-a));return o;}
function atrSeries(r:Candle[],p:number){const o=new Array(r.length).fill(0);if(!r.length)return o;o[0]=r[0].high-r[0].low;for(let i=1;i<r.length;i++){const tr=Math.max(r[i].high-r[i].low,Math.abs(r[i].high-r[i-1].close),Math.abs(r[i].low-r[i-1].close));o[i]=i<p?(o[i-1]*i+tr)/(i+1):(o[i-1]*(p-1)+tr)/p;}return o;}
function mean(v:number[]){return v.length?v.reduce((a,b)=>a+b,0)/v.length:0;}
