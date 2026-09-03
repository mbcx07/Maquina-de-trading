import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

type Side = 'BUY' | 'SELL';
type AggTrade = { time:number; price:number; qty:number; buyerMaker:boolean };
type Bar = { time:number; open:number; high:number; low:number; close:number; volume:number; buyVolume:number; sellVolume:number; trades:number };
type Config = {
  imbalanceMin:number;
  volumeZMin:number;
  velocityZMin:number;
  trendBars:number;
  trendMinPct:number;
  breakoutBars:number;
  tpAtr:number;
  slAtr:number;
  maxHoldBars:number;
  cooloffBars:number;
};
type Trade = { side:Side; entryTime:number; exitTime:number; entry:number; exit:number; grossPct:number; netPct:number; reason:'TP'|'SL'|'TIME'; };
type Stats = { trades:number; wins:number; losses:number; winRate:number; netReturnPct:number; expectancyPct:number; profitFactor:number; maxDrawdownPct:number; tradesPerDay:number };

const BASE='https://data.binance.vision/data/futures/um/daily/aggTrades/XAUUSDT';
const SYMBOL='XAUUSDT';
const BAR_MS=30_000;
const DAY=86_400_000;
const DAYS=42; // enough for blind split while keeping aggTrade download tractable
const ROUND_TRIP_COST_PCT=0.145; // taker in/out + spread/slippage allowance, conservative

async function fetchDay(day:string,dir:string):Promise<AggTrade[]>{
  const filename=`${SYMBOL}-aggTrades-${day}.zip`;
  const url=`${BASE}/${filename}`;
  const response=await fetch(url);
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
    const time=normalizeEpoch(rawTime);
    const buyerMaker=String(c[6]).trim().toLowerCase()==='true';
    out.push({time,price,qty,buyerMaker});
  }
  return out;
}

function normalizeEpoch(v:number){
  if(v>1e17) return Math.floor(v/1_000_000);
  if(v>1e14) return Math.floor(v/1000);
  return v;
}

function toBars(trades:AggTrade[]):Bar[]{
  const map=new Map<number,Bar>();
  for(const t of trades){
    const bucket=Math.floor(t.time/BAR_MS)*BAR_MS;
    let b=map.get(bucket);
    if(!b){b={time:bucket,open:t.price,high:t.price,low:t.price,close:t.price,volume:0,buyVolume:0,sellVolume:0,trades:0};map.set(bucket,b);}
    b.high=Math.max(b.high,t.price); b.low=Math.min(b.low,t.price); b.close=t.price; b.volume+=t.qty; b.trades++;
    if(t.buyerMaker) b.sellVolume+=t.qty; else b.buyVolume+=t.qty;
  }
  return [...map.values()].sort((a,b)=>a.time-b.time);
}

function atrSeries(bars:Bar[],period=20){
  const out=new Array<number>(bars.length).fill(0);
  if(!bars.length) return out;
  out[0]=bars[0].high-bars[0].low;
  for(let i=1;i<bars.length;i++){
    const tr=Math.max(bars[i].high-bars[i].low,Math.abs(bars[i].high-bars[i-1].close),Math.abs(bars[i].low-bars[i-1].close));
    out[i]=i<period?(out[i-1]*i+tr)/(i+1):(out[i-1]*(period-1)+tr)/period;
  }
  return out;
}

function rollingZ(values:number[],period:number){
  const out=new Array<number>(values.length).fill(0);
  let sum=0,sum2=0;
  const q:number[]=[];
  for(let i=0;i<values.length;i++){
    const v=values[i]; q.push(v); sum+=v; sum2+=v*v;
    if(q.length>period){const x=q.shift()!;sum-=x;sum2-=x*x;}
    if(q.length>=Math.min(20,period)){
      const m=sum/q.length; const variance=Math.max(1e-12,sum2/q.length-m*m); out[i]=(v-m)/Math.sqrt(variance);
    }
  }
  return out;
}

function highest(bars:Bar[],i:number,n:number){let x=-Infinity;for(let j=Math.max(0,i-n);j<i;j++)x=Math.max(x,bars[j].high);return x;}
function lowest(bars:Bar[],i:number,n:number){let x=Infinity;for(let j=Math.max(0,i-n);j<i;j++)x=Math.min(x,bars[j].low);return x;}

function run(bars:Bar[],cfg:Config,start:number,end:number):{stats:Stats;trades:Trade[]}{
  const atr=atrSeries(bars,20);
  const volZ=rollingZ(bars.map(b=>b.volume),120);
  const velZ=rollingZ(bars.map(b=>b.trades),120);
  const trades:Trade[]=[];
  let nextAllowed=start;
  for(let i=Math.max(start,240);i<Math.min(end,bars.length-2);i++){
    if(i<nextAllowed) continue;
    const b=bars[i]; const total=b.buyVolume+b.sellVolume; if(total<=0||atr[i]<=0) continue;
    const imb=(b.buyVolume-b.sellVolume)/total;
    if(volZ[i]<cfg.volumeZMin||velZ[i]<cfg.velocityZMin) continue;
    const prev=bars[i-cfg.trendBars]?.close; if(!(prev>0)) continue;
    const trendPct=(b.close-prev)/prev*100;
    let side:Side|null=null;
    if(imb>=cfg.imbalanceMin&&trendPct>=cfg.trendMinPct&&b.close>highest(bars,i,cfg.breakoutBars)) side='BUY';
    else if(imb<=-cfg.imbalanceMin&&trendPct<=-cfg.trendMinPct&&b.close<lowest(bars,i,cfg.breakoutBars)) side='SELL';
    if(!side) continue;

    const entryIndex=i+1; const entry=bars[entryIndex].open; const risk=atr[i]*cfg.slAtr; const reward=atr[i]*cfg.tpAtr;
    const sl=side==='BUY'?entry-risk:entry+risk; const tp=side==='BUY'?entry+reward:entry-reward;
    let exit=bars[Math.min(end-1,entryIndex+cfg.maxHoldBars)].close; let exitIndex=Math.min(end-1,entryIndex+cfg.maxHoldBars); let reason:Trade['reason']='TIME';
    for(let j=entryIndex;j<=Math.min(end-1,entryIndex+cfg.maxHoldBars);j++){
      const x=bars[j];
      if(side==='BUY'){
        const hitSl=x.low<=sl, hitTp=x.high>=tp;
        if(hitSl){exit=sl;exitIndex=j;reason='SL';break;}
        if(hitTp){exit=tp;exitIndex=j;reason='TP';break;}
      }else{
        const hitSl=x.high>=sl, hitTp=x.low<=tp;
        if(hitSl){exit=sl;exitIndex=j;reason='SL';break;}
        if(hitTp){exit=tp;exitIndex=j;reason='TP';break;}
      }
    }
    const grossPct=side==='BUY'?(exit-entry)/entry*100:(entry-exit)/entry*100;
    const netPct=grossPct-ROUND_TRIP_COST_PCT;
    trades.push({side,entryTime:bars[entryIndex].time,exitTime:bars[exitIndex].time,entry,exit,grossPct,netPct,reason});
    nextAllowed=exitIndex+cfg.cooloffBars;
  }
  return {stats:stats(trades,bars,start,end),trades};
}

function stats(trades:Trade[],bars:Bar[],start:number,end:number):Stats{
  let equity=100,peak=100,dd=0,gp=0,gl=0,w=0;
  for(const t of trades){ equity*=1+t.netPct/100; peak=Math.max(peak,equity); dd=Math.max(dd,(peak-equity)/peak*100); if(t.netPct>0){w++;gp+=t.netPct}else gl+=Math.abs(t.netPct); }
  const days=Math.max(1,(bars[Math.max(start,0)]&&bars[Math.min(end-1,bars.length-1)])?(bars[Math.min(end-1,bars.length-1)].time-bars[Math.max(start,0)].time)/DAY:1);
  return {trades:trades.length,wins:w,losses:trades.length-w,winRate:trades.length?w/trades.length*100:0,netReturnPct:equity-100,expectancyPct:trades.length?trades.reduce((s,t)=>s+t.netPct,0)/trades.length:0,profitFactor:gl>0?gp/gl:gp>0?99:0,maxDrawdownPct:dd,tradesPerDay:trades.length/days};
}

function score(s:Stats){
  if(s.trades<30||s.netReturnPct<=0||s.expectancyPct<=0||s.profitFactor<=1) return -Infinity;
  return s.netReturnPct+Math.min(3,s.profitFactor)*2+s.expectancyPct*50-Math.max(0,s.maxDrawdownPct-8)*2;
}

async function main(){
  const endDay=Math.floor((Date.now()-2*DAY)/DAY)*DAY;
  const startDay=endDay-DAYS*DAY;
  const dir=await mkdtemp(path.join(os.tmpdir(),'xau-oflow-'));
  const all:AggTrade[]=[];
  for(let t=startDay;t<endDay;t+=DAY){
    const day=new Date(t).toISOString().slice(0,10);
    const rows=await fetchDay(day,dir);
    console.log('DAY',day,'aggTrades',rows.length);
    all.push(...rows);
  }
  if(all.length<10000) throw new Error(`INSUFFICIENT_AGGTRADES:${all.length}`);
  const bars=toBars(all);
  console.log('BARS30S',bars.length,'FROM',new Date(bars[0].time).toISOString(),'TO',new Date(bars.at(-1)!.time).toISOString());

  const n=bars.length; const trainEnd=Math.floor(n*0.50), valEnd=Math.floor(n*0.75);
  const configs:Config[]=[];
  for(const imbalanceMin of [0.12,0.20,0.28,0.36,0.44])
  for(const volumeZMin of [0,0.5,1,1.5])
  for(const velocityZMin of [0,0.5,1])
  for(const trendBars of [10,20,40])
  for(const trendMinPct of [0.02,0.04,0.08])
  for(const breakoutBars of [4,8,16])
  for(const tpAtr of [1.5,2,3,4])
  for(const slAtr of [1,1.5,2])
  for(const maxHoldBars of [4,8,16,30])
  configs.push({imbalanceMin,volumeZMin,velocityZMin,trendBars,trendMinPct,breakoutBars,tpAtr,slAtr,maxHoldBars,cooloffBars:2});

  let best:{cfg:Config;train:Stats;val:Stats;score:number}|null=null;
  let tested=0,trainPositive=0,valPositive=0;
  for(const cfg of configs){
    tested++;
    const tr=run(bars,cfg,240,trainEnd).stats;
    const sc=score(tr); if(!Number.isFinite(sc)) continue; trainPositive++;
    const va=run(bars,cfg,trainEnd,valEnd).stats;
    if(va.trades<12||va.netReturnPct<=0||va.expectancyPct<=0||va.profitFactor<=1) continue;
    valPositive++;
    const combined=sc+va.netReturnPct+va.expectancyPct*50+Math.min(3,va.profitFactor)*2;
    if(!best||combined>best.score) best={cfg,train:tr,val:va,score:combined};
  }
  console.log('SEARCH',JSON.stringify({tested,trainPositive,valPositive}));
  if(!best){console.log('ORDERFLOW_RESULT',JSON.stringify({survived:false,reason:'NO_CONFIG_SURVIVED_TRAIN_AND_VALIDATION'}));return;}
  const test=run(bars,best.cfg,valEnd,n).stats;
  const result={survived:test.trades>=12&&test.netReturnPct>0&&test.expectancyPct>0&&test.profitFactor>1,best:{config:best.cfg,train:best.train,validation:best.val,test},costPct:ROUND_TRIP_COST_PCT,model:'AGGTRADES_30S_ORDERFLOW_NO_L2_DEPTH'};
  console.log('ORDERFLOW_RESULT',JSON.stringify(result));
}

main().catch(error=>{console.error('ORDERFLOW_ERROR',error instanceof Error?error.message:String(error));process.exit(1);});
