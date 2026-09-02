import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Candle } from './analysis.js';

const DAY = 86_400_000;
const MIN = 60_000;
const FIVE = 5 * MIN;
const VISION = 'https://data.binance.vision/data/futures/um/daily/klines';
const LOOKBACK_DAYS = 120;
const INITIAL = 50;
const LEVERAGE = 10;
const MARGIN_PCT = 1;
const FEE_PCT = 0.05;
const SPREAD_PCT = 0.025;
const SLIP_PCT = 0.01;

type Side = 1 | -1;
type Family = 'FIRST_WINDOW_MOMENTUM' | 'OPENING_RANGE_BREAKOUT' | 'SESSION_DONCHIAN';
type SessionName = 'LONDON' | 'NEW_YORK' | 'OVERLAP';
interface Param {
  family: Family;
  session: SessionName;
  windowMin: number;
  trigger: number;
  stopAtr: number;
  rr: number;
  holdMin: number;
}
interface Feature extends Candle { atr: number; ema20: number; ema50: number; ema200: number; rsi: number; volAvg: number; }
interface Metrics { trades:number;wins:number;winRate:number;pf:number;returnPct:number;dd:number;balance:number;expectancy:number; }
interface Candidate { p:Param;train:Metrics;validation:Metrics;test?:Metrics;score:number; }

async function main(){
  const endDay=Math.floor((Date.now()-DAY)/DAY)*DAY;
  const end=endDay+DAY-1,start=end-LOOKBACK_DAYS*DAY;
  const dir=await mkdtemp(path.join(os.tmpdir(),'r15-xau-session-'));
  const m1=await fetchVision('XAUUSDT',start,end,dir);
  if(m1.length<60*1440) throw new Error(`SESSION_HISTORY_TOO_SHORT:${m1.length}`);
  const bars=features(aggregate(m1,FIVE));
  const first=bars[0].time,last=bars.at(-1)!.time,span=last-first;
  const s1=first+span*.5,s2=first+span*.75;
  const i1=bars.findIndex(b=>b.time>=s1),i2=bars.findIndex(b=>b.time>=s2),endIdx=bars.length-2;
  const grid=buildGrid();
  const trained:Candidate[]=[];
  for(const p of grid){
    const train=simulate(bars,220,i1-1,p);
    if(train.trades<10||train.returnPct<=0||train.pf<1.03||train.dd>15)continue;
    const validation=simulate(bars,i1,i2-1,p);
    const score=train.returnPct-train.dd*.8+Math.min(train.pf,3)*3+Math.min(train.trades,100)*.01;
    trained.push({p,train,validation,score});
  }
  trained.sort((a,b)=>b.score-a.score);
  const validated=trained.filter(x=>x.validation.trades>=4&&x.validation.returnPct>=0&&x.validation.pf>=1&&x.validation.dd<=12).slice(0,40).map(x=>({...x,test:simulate(bars,i2,endIdx,x.p)}));
  const survivors=validated.filter(x=>x.test&&x.test.trades>=4&&x.test.returnPct>0&&x.test.pf>=1.05&&x.test.dd<=12).sort((a,b)=>(b.test!.returnPct-b.test!.dd*.6)-(a.test!.returnPct-a.test!.dd*.6));
  console.log('R15_SESSION_META',JSON.stringify({m1:m1.length,m5:bars.length,from:new Date(first).toISOString(),to:new Date(last).toISOString(),days:Number((span/DAY).toFixed(2)),grid:grid.length,positiveTrain:trained.length,validationPass:validated.length,survivors:survivors.length,cost:{feePct:FEE_PCT,spreadPct:SPREAD_PCT,slippagePct:SLIP_PCT,leverage:LEVERAGE,marginPct:MARGIN_PCT}}));
  for(const [i,x] of trained.slice(0,10).entries())console.log('R15_SESSION_TRAIN',JSON.stringify({rank:i+1,p:x.p,train:c(x.train),validation:c(x.validation)}));
  for(const [i,x] of survivors.slice(0,10).entries())console.log('R15_SESSION_SURVIVOR',JSON.stringify({rank:i+1,p:x.p,train:c(x.train),validation:c(x.validation),test:c(x.test!)}));
  if(!survivors.length)console.log('R15_SESSION_NO_SURVIVOR');
}

function buildGrid():Param[]{const out:Param[]=[];
  for(const session of ['LONDON','NEW_YORK'] as const)for(const windowMin of [30,60])for(const trigger of [.04,.07,.10,.15,.20])for(const stopAtr of [1,1.5,2])for(const rr of [1.2,1.8,2.5])for(const holdMin of [30,60,120])out.push({family:'FIRST_WINDOW_MOMENTUM',session,windowMin,trigger,stopAtr,rr,holdMin});
  for(const session of ['LONDON','NEW_YORK'] as const)for(const windowMin of [30,60])for(const trigger of [0,.05,.10])for(const stopAtr of [1,1.5,2])for(const rr of [1.5,2,3])for(const holdMin of [60,120])out.push({family:'OPENING_RANGE_BREAKOUT',session,windowMin,trigger,stopAtr,rr,holdMin});
  for(const session of ['LONDON','NEW_YORK','OVERLAP'] as const)for(const windowMin of [30,60,120])for(const trigger of [6,12,24])for(const stopAtr of [1,1.5,2])for(const rr of [1.5,2,3])out.push({family:'SESSION_DONCHIAN',session,windowMin,trigger,stopAtr,rr,holdMin:120});
  return out;}

function simulate(f:Feature[],start:number,end:number,p:Param):Metrics{let balance=INITIAL,peak=INITIAL,dd=0,wins=0,gp=0,gl=0,trades=0;let i=Math.max(220,start);while(i<end-2&&balance>1){const sig=signal(f,i,p);if(!sig){i++;continue;}const entryIdx=i+1;if(entryIdx>end)break;const b=f[entryIdx];const entry=b.open*(1+sig.side*(SPREAD_PCT/2+SLIP_PCT)/100);const stopDist=Math.max(entry*.0006,f[i].atr*p.stopAtr);const tpDist=Math.max(stopDist*p.rr,entry*((FEE_PCT*2+SPREAD_PCT+SLIP_PCT*2)*1.15)/100);const sl=entry-sig.side*stopDist,tp=entry+sig.side*tpDist;const notional=balance*MARGIN_PCT/100*LEVERAGE,qty=notional/entry,entryFee=notional*FEE_PCT/100;let exitIdx=Math.min(end,entryIdx+Math.max(1,Math.floor(p.holdMin/5))),exit=f[Math.min(end,entryIdx+Math.max(1,Math.floor(p.holdMin/5)))].close;for(let j=entryIdx;j<=exitIdx;j++){const x=f[j],hitSl=sig.side===1?x.low<=sl:x.high>=sl,hitTp=sig.side===1?x.high>=tp:x.low<=tp;if(hitSl){exit=sl;exitIdx=j;break;}if(hitTp){exit=tp;exitIdx=j;break;}}exit*=1-sig.side*(SPREAD_PCT/2+SLIP_PCT)/100;const gross=sig.side===1?(exit-entry)*qty:(entry-exit)*qty,exitFee=qty*exit*FEE_PCT/100,pnl=gross-entryFee-exitFee;balance+=pnl;trades++;if(pnl>0){wins++;gp+=pnl}else gl+=Math.abs(pnl);peak=Math.max(peak,balance);dd=Math.max(dd,(peak-balance)/peak*100);i=Math.max(i+1,exitIdx+1);}return{trades,wins,winRate:trades?wins/trades*100:0,pf:gl>0?gp/gl:gp>0?99:0,returnPct:(balance-INITIAL)/INITIAL*100,dd,balance,expectancy:trades?(balance-INITIAL)/trades:0};}

function signal(f:Feature[],i:number,p:Param):{side:Side}|null{const b=f[i],parts=sessionParts(b.time,p.session);if(!parts)return null;const dayStart=parts.dayStart,start=parts.start,end=parts.end;if(b.time<start||b.time>end)return null;
  if(p.family==='FIRST_WINDOW_MOMENTUM'){const windowEnd=start+p.windowMin*MIN;if(b.time!==windowEnd)return null;const ws=f.filter((x,idx)=>idx<=i&&x.time>=start&&x.time<windowEnd);if(ws.length<Math.floor(p.windowMin/5))return null;const open=ws[0].open,ret=(ws.at(-1)!.close-open)/open*100;if(Math.abs(ret)<p.trigger)return null;const side:Side=ret>0?1:-1;const trend=side===1?b.ema20>b.ema50:b.ema20<b.ema50;if(!trend)return null;return{side};}
  if(p.family==='OPENING_RANGE_BREAKOUT'){const windowEnd=start+p.windowMin*MIN;if(b.time<windowEnd||b.time>windowEnd+120*MIN)return null;const ws=f.filter((x,idx)=>idx<=i&&x.time>=start&&x.time<windowEnd);if(ws.length<Math.floor(p.windowMin/5))return null;const hi=Math.max(...ws.map(x=>x.high)),lo=Math.min(...ws.map(x=>x.low)),buffer=b.atr*p.trigger;const long=b.close>hi+buffer&&b.close>b.open&&b.ema20>b.ema50,short=b.close<lo-buffer&&b.close<b.open&&b.ema20<b.ema50;if(!long&&!short)return null;return{side:long?1:-1};}
  const lookback=Math.floor(p.trigger);const prior=f.slice(i-lookback,i);if(prior.length<lookback)return null;const hi=Math.max(...prior.map(x=>x.high)),lo=Math.min(...prior.map(x=>x.low));const trendLong=b.ema20>b.ema50&&b.ema50>b.ema200,trendShort=b.ema20<b.ema50&&b.ema50<b.ema200;const long=trendLong&&b.close>hi&&b.volume>=b.volAvg*.9,short=trendShort&&b.close<lo&&b.volume>=b.volAvg*.9;if(!long&&!short)return null;return{side:long?1:-1};}

function sessionParts(time:number,session:SessionName){const d=new Date(time),dayStart=Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate());if(session==='LONDON')return{dayStart,start:dayStart+7*60*MIN,end:dayStart+11*60*MIN};if(session==='NEW_YORK')return{dayStart,start:dayStart+13*60*MIN,end:dayStart+18*60*MIN};return{dayStart,start:dayStart+12*60*MIN,end:dayStart+17*60*MIN};}
function features(rows:Candle[]):Feature[]{const c=rows.map(x=>x.close),e20=ema(c,20),e50=ema(c,50),e200=ema(c,200),a=atr(rows,14),r=rsi(c,14);return rows.map((x,i)=>({...x,atr:a[i],ema20:e20[i],ema50:e50[i],ema200:e200[i],rsi:r[i],volAvg:mean(rows.slice(Math.max(0,i-19),i+1).map(y=>y.volume))}));}
function aggregate(rows:Candle[],bucket:number){const map=new Map<number,Candle>();for(const x of rows){const t=Math.floor(x.time/bucket)*bucket,b=map.get(t);if(!b)map.set(t,{...x,time:t});else{b.high=Math.max(b.high,x.high);b.low=Math.min(b.low,x.low);b.close=x.close;b.volume+=x.volume;}}return[...map.values()].sort((a,b)=>a.time-b.time)}
function ema(v:number[],p:number){const o=new Array(v.length).fill(0);if(!v.length)return o;const k=2/(p+1);o[0]=v[0];for(let i=1;i<v.length;i++)o[i]=v[i]*k+o[i-1]*(1-k);return o}
function atr(r:Candle[],p:number){const o=new Array(r.length).fill(0);if(!r.length)return o;o[0]=r[0].high-r[0].low;for(let i=1;i<r.length;i++){const tr=Math.max(r[i].high-r[i].low,Math.abs(r[i].high-r[i-1].close),Math.abs(r[i].low-r[i-1].close));o[i]=i<p?(o[i-1]*i+tr)/(i+1):(o[i-1]*(p-1)+tr)/p;}return o}
function rsi(v:number[],p:number){const o=new Array(v.length).fill(50);let g=0,l=0;for(let i=1;i<v.length;i++){const d=v[i]-v[i-1];if(i<=p){if(d>=0)g+=d;else l-=d;if(i===p){g/=p;l/=p}}else{g=(g*(p-1)+Math.max(d,0))/p;l=(l*(p-1)+Math.max(-d,0))/p}if(i>=p)o[i]=l<=1e-12?(g>0?100:50):100-100/(1+g/l)}return o}
function mean(v:number[]){return v.length?v.reduce((a,b)=>a+b,0)/v.length:0}
function c(m:Metrics){return{trades:m.trades,winRate:Number(m.winRate.toFixed(2)),pf:Number(m.pf.toFixed(3)),returnPct:Number(m.returnPct.toFixed(3)),dd:Number(m.dd.toFixed(3)),balance:Number(m.balance.toFixed(4)),expectancy:Number(m.expectancy.toFixed(5))}}
async function fetchVision(symbol:string,startTime:number,endTime:number,dir:string):Promise<Candle[]>{const out:Candle[]=[];for(let cur=Math.floor(startTime/DAY)*DAY;cur<=Math.floor(endTime/DAY)*DAY;cur+=DAY){const day=new Date(cur).toISOString().slice(0,10),fn=`${symbol}-1m-${day}.zip`,res=await fetch(`${VISION}/${symbol}/1m/${fn}`);if(res.status===404)continue;if(!res.ok)throw new Error(`VISION_${res.status}:${fn}`);const file=path.join(dir,fn);await writeFile(file,Buffer.from(await res.arrayBuffer()));const csv=execFileSync('unzip',['-p',file],{encoding:'utf8',maxBuffer:64*1024*1024});for(const line of csv.split(/\r?\n/)){if(!line.trim())continue;const a=line.split(','),raw=Number(a[0]);if(!Number.isFinite(raw))continue;const time=raw>1e17?Math.floor(raw/1_000_000):raw>1e14?Math.floor(raw/1000):raw;const x:Candle={time,open:Number(a[1]),high:Number(a[2]),low:Number(a[3]),close:Number(a[4]),volume:Number(a[5]??0)};if([x.time,x.open,x.high,x.low,x.close].every(Number.isFinite)&&time>=startTime&&time<=endTime)out.push(x)}}const map=new Map(out.map(x=>[x.time,x]));return[...map.values()].sort((a,b)=>a.time-b.time)}
main().catch(e=>{console.error('R15_SESSION_ERROR',e instanceof Error?e.message:String(e));process.exit(1)});
