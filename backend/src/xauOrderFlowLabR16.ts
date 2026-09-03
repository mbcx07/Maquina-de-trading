import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

type Side = 'BUY' | 'SELL';
type AggTrade = { time:number; price:number; qty:number; buyerMaker:boolean };
type Bar = { time:number; open:number; high:number; low:number; close:number; volume:number; buyVolume:number; sellVolume:number; trades:number };
type Config = { imbalanceMin:number; volumeZMin:number; velocityZMin:number; trendBars:number; trendMinPct:number; breakoutBars:number; tpAtr:number; slAtr:number; maxHoldBars:number; cooloffBars:number };
type Trade = { side:Side; entryTime:number; exitTime:number; entry:number; exit:number; grossPct:number; netPct:number; reason:'TP'|'SL'|'TIME' };
type Stats = { trades:number; wins:number; losses:number; winRate:number; netReturnPct:number; expectancyPct:number; profitFactor:number; maxDrawdownPct:number; tradesPerDay:number };
type Prepared = { bars:Bar[]; atr:number[]; volZ:number[]; velZ:number[] };

const BASE='https://data.binance.vision/data/futures/um/daily/aggTrades/XAUUSDT';
const SYMBOL='XAUUSDT';
const BAR_MS=30_000;
const DAY=86_400_000;
const DAYS=42;
const ROUND_TRIP_COST_PCT=0.145;

async function fetchDay(day:string,dir:string):Promise<AggTrade[]>{
  const filename=`${SYMBOL}-aggTrades-${day}.zip`;
  const response=await fetch(`${BASE}/${filename}`);
  if(response.status===404) return [];
  if(!response.ok) throw new Error(`VISION_${response.status}:${day}`);
  const bytes=Buffer.from(await response.arrayBuffer());
  const file=path.join(dir,filename);
  await writeFile(file,bytes);
  const csv=execFileSync('unzip',['-p',file],{encoding:'utf8',maxBuffer:512*1024*1024});
  const out:AggTrade[]=[];
  for(const line of csv.split(/\r?\n/)){
    if(!line.trim()) continue;
    const c=line.split(',');
    const price=Number(c[1]),qty=Number(c[2]),rawTime=Number(c[5]);
    if(!Number.isFinite(price)||!Number.isFinite(qty)||!Number.isFinite(rawTime)) continue;
    out.push({time:normalizeEpoch(rawTime),price,qty,buyerMaker:String(c[6]).trim().toLowerCase()==='true'});
  }
  return out;
}
function normalizeEpoch(v:number){if(v>1e17)return Math.floor(v/1_000_000);if(v>1e14)return Math.floor(v/1000);return v;}
function toBars(trades:AggTrade[]):Bar[]{
  const map=new Map<number,Bar>();
  for(const t of trades){
    const bucket=Math.floor(t.time/BAR_MS)*BAR_MS;
    let b=map.get(bucket);
    if(!b){b={time:bucket,open:t.price,high:t.price,low:t.price,close:t.price,volume:0,buyVolume:0,sellVolume:0,trades:0};map.set(bucket,b);}
    b.high=Math.max(b.high,t.price);b.low=Math.min(b.low,t.price);b.close=t.price;b.volume+=t.qty;b.trades++;
    if(t.buyerMaker)b.sellVolume+=t.qty;else b.buyVolume+=t.qty;
  }
  return [...map.values()].sort((a,b)=>a.time-b.time);
}
function atrSeries(bars:Bar[],period=20){
  const out=new Array<number>(bars.length).fill(0);if(!bars.length)return out;out[0]=bars[0].high-bars[0].low;
  for(let i=1;i<bars.length;i++){const tr=Math.max(bars[i].high-bars[i].low,Math.abs(bars[i].high-bars[i-1].close),Math.abs(bars[i].low-bars[i-1].close));out[i]=i<period?(out[i-1]*i+tr)/(i+1):(out[i-1]*(period-1)+tr)/period;}return out;
}
function rollingZ(values:number[],period:number){
  const out=new Array<number>(values.length).fill(0);let sum=0,sum2=0;const q:number[]=[];
  for(let i=0;i<values.length;i++){const v=values[i];q.push(v);sum+=v;sum2+=v*v;if(q.length>period){const x=q.shift()!;sum-=x;sum2-=x*x;}if(q.length>=20){const m=sum/q.length;const variance=Math.max(1e-12,sum2/q.length-m*m);out[i]=(v-m)/Math.sqrt(variance);}}return out;
}
function highest(bars:Bar[],i:number,n:number){let x=-Infinity;for(let j=Math.max(0,i-n);j<i;j++)x=Math.max(x,bars[j].high);return x;}
function lowest(bars:Bar[],i:number,n:number){let x=Infinity;for(let j=Math.max(0,i-n);j<i;j++)x=Math.min(x,bars[j].low);return x;}
function prepare(bars:Bar[]):Prepared{return{bars,atr:atrSeries(bars,20),volZ:rollingZ(bars.map(b=>b.volume),120),velZ:rollingZ(bars.map(b=>b.trades),120)};}

function run(data:Prepared,cfg:Config,start:number,end:number):Stats{
  const {bars,atr,volZ,velZ}=data;const trades:Trade[]=[];let nextAllowed=start;
  for(let i=Math.max(start,240);i<Math.min(end,bars.length-2);i++){
    if(i<nextAllowed)continue;const b=bars[i];const total=b.buyVolume+b.sellVolume;if(total<=0||atr[i]<=0)continue;
    const imb=(b.buyVolume-b.sellVolume)/total;if(volZ[i]<cfg.volumeZMin||velZ[i]<cfg.velocityZMin)continue;
    const prev=bars[i-cfg.trendBars]?.close;if(!(prev>0))continue;const trendPct=(b.close-prev)/prev*100;
    let side:Side|null=null;
    if(imb>=cfg.imbalanceMin&&trendPct>=cfg.trendMinPct&&b.close>highest(bars,i,cfg.breakoutBars))side='BUY';
    else if(imb<=-cfg.imbalanceMin&&trendPct<=-cfg.trendMinPct&&b.close<lowest(bars,i,cfg.breakoutBars))side='SELL';
    if(!side)continue;
    const entryIndex=i+1,entry=bars[entryIndex].open,risk=atr[i]*cfg.slAtr,reward=atr[i]*cfg.tpAtr,sl=side==='BUY'?entry-risk:entry+risk,tp=side==='BUY'?entry+reward:entry-reward;
    let exit=bars[Math.min(end-1,entryIndex+cfg.maxHoldBars)].close,exitIndex=Math.min(end-1,entryIndex+cfg.maxHoldBars),reason:Trade['reason']='TIME';
    for(let j=entryIndex;j<=Math.min(end-1,entryIndex+cfg.maxHoldBars);j++){
      const x=bars[j];if(side==='BUY'){if(x.low<=sl){exit=sl;exitIndex=j;reason='SL';break;}if(x.high>=tp){exit=tp;exitIndex=j;reason='TP';break;}}
      else{if(x.high>=sl){exit=sl;exitIndex=j;reason='SL';break;}if(x.low<=tp){exit=tp;exitIndex=j;reason='TP';break;}}
    }
    const grossPct=side==='BUY'?(exit-entry)/entry*100:(entry-exit)/entry*100,netPct=grossPct-ROUND_TRIP_COST_PCT;
    trades.push({side,entryTime:bars[entryIndex].time,exitTime:bars[exitIndex].time,entry,exit,grossPct,netPct,reason});nextAllowed=exitIndex+cfg.cooloffBars;
  }
  return stats(trades,bars,start,end);
}
function stats(trades:Trade[],bars:Bar[],start:number,end:number):Stats{
  let equity=100,peak=100,dd=0,gp=0,gl=0,w=0;for(const t of trades){equity*=1+t.netPct/100;peak=Math.max(peak,equity);dd=Math.max(dd,(peak-equity)/peak*100);if(t.netPct>0){w++;gp+=t.netPct}else gl+=Math.abs(t.netPct);}
  const first=bars[Math.max(start,0)],last=bars[Math.min(end-1,bars.length-1)],days=Math.max(1,first&&last?(last.time-first.time)/DAY:1);
  return{trades:trades.length,wins:w,losses:trades.length-w,winRate:trades.length?w/trades.length*100:0,netReturnPct:equity-100,expectancyPct:trades.length?trades.reduce((s,t)=>s+t.netPct,0)/trades.length:0,profitFactor:gl>0?gp/gl:gp>0?99:0,maxDrawdownPct:dd,tradesPerDay:trades.length/days};
}
function score(s:Stats){if(s.trades<25||s.netReturnPct<=0||s.expectancyPct<=0||s.profitFactor<=1)return-Infinity;return s.netReturnPct+Math.min(3,s.profitFactor)*2+s.expectancyPct*50-Math.max(0,s.maxDrawdownPct-8)*2;}

async function main(){
  const endDay=Math.floor((Date.now()-2*DAY)/DAY)*DAY,startDay=endDay-DAYS*DAY,dir=await mkdtemp(path.join(os.tmpdir(),'xau-oflow-')),bars:Bar[]=[];
  for(let t=startDay;t<endDay;t+=DAY){const day=new Date(t).toISOString().slice(0,10),rows=await fetchDay(day,dir),dayBars=toBars(rows);console.log('DAY',day,'aggTrades',rows.length,'bars30s',dayBars.length);for(const b of dayBars)bars.push(b);}
  bars.sort((a,b)=>a.time-b.time);if(bars.length<20_000)throw new Error(`INSUFFICIENT_30S_BARS:${bars.length}`);
  const data=prepare(bars),n=bars.length,trainEnd=Math.floor(n*.50),valEnd=Math.floor(n*.75);
  console.log('BARS30S',n,'FROM',new Date(bars[0].time).toISOString(),'TO',new Date(bars.at(-1)!.time).toISOString());

  const configs:Config[]=[];
  for(const imbalanceMin of [0.16,0.28,0.40])
  for(const volumeZMin of [0,0.75,1.5])
  for(const velocityZMin of [0,0.75])
  for(const trendBars of [10,30])
  for(const trendMinPct of [0.02,0.06])
  for(const breakoutBars of [4,12])
  for(const tpAtr of [2,3,4])
  for(const slAtr of [1,1.75])
  for(const maxHoldBars of [6,16,30])configs.push({imbalanceMin,volumeZMin,velocityZMin,trendBars,trendMinPct,breakoutBars,tpAtr,slAtr,maxHoldBars,cooloffBars:2});

  let best:{cfg:Config;train:Stats;val:Stats;score:number}|null=null,tested=0,trainPositive=0,valPositive=0;
  for(const cfg of configs){tested++;const tr=run(data,cfg,240,trainEnd),sc=score(tr);if(!Number.isFinite(sc))continue;trainPositive++;const va=run(data,cfg,trainEnd,valEnd);if(va.trades<10||va.netReturnPct<=0||va.expectancyPct<=0||va.profitFactor<=1)continue;valPositive++;const combined=sc+va.netReturnPct+va.expectancyPct*50+Math.min(3,va.profitFactor)*2;if(!best||combined>best.score)best={cfg,train:tr,val:va,score:combined};}
  console.log('SEARCH',JSON.stringify({tested,trainPositive,valPositive}));
  if(!best){console.log('ORDERFLOW_RESULT',JSON.stringify({survived:false,reason:'NO_CONFIG_SURVIVED_TRAIN_AND_VALIDATION',costPct:ROUND_TRIP_COST_PCT,model:'AGGTRADES_30S_ORDERFLOW_NO_L2_DEPTH'}));return;}
  const test=run(data,best.cfg,valEnd,n),survived=test.trades>=10&&test.netReturnPct>0&&test.expectancyPct>0&&test.profitFactor>1;
  console.log('ORDERFLOW_RESULT',JSON.stringify({survived,best:{config:best.cfg,train:best.train,validation:best.val,test},costPct:ROUND_TRIP_COST_PCT,model:'AGGTRADES_30S_ORDERFLOW_NO_L2_DEPTH'}));
}
main().catch(error=>{console.error('ORDERFLOW_ERROR',error instanceof Error?error.message:String(error));process.exit(1);});
