import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

type Side='BUY'|'SELL';
type AggTrade={time:number;price:number;qty:number;buyerMaker:boolean};
type Bar={time:number;open:number;high:number;low:number;close:number;volume:number;buyVolume:number;sellVolume:number;trades:number};
type Config={imbalanceMin:number;volumeZMin:number;velocityZMin:number;trendBars:number;trendMinPct:number;breakoutBars:number;tpAtr:number;slAtr:number;maxHoldBars:number;cooloffBars:number};
type Trade={netPct:number};
type Stats={trades:number;wins:number;losses:number;winRate:number;netReturnPct:number;expectancyPct:number;profitFactor:number;maxDrawdownPct:number;tradesPerDay:number};
type Prepared={bars:Bar[];atr:number[];volZ:number[];velZ:number[]};

const BASE='https://data.binance.vision/data/futures/um/daily/aggTrades/XAUUSDT';
const SYMBOL='XAUUSDT',BAR_MS=30_000,DAY=86_400_000,DAYS=42;
const COST_SCENARIOS=[0.145,0.10,0.075,0.05,0.03];

async function fetchDay(day:string,dir:string):Promise<AggTrade[]>{
  const filename=`${SYMBOL}-aggTrades-${day}.zip`,response=await fetch(`${BASE}/${filename}`);
  if(response.status===404)return[];if(!response.ok)throw new Error(`VISION_${response.status}:${day}`);
  const file=path.join(dir,filename);await writeFile(file,Buffer.from(await response.arrayBuffer()));
  const csv=execFileSync('unzip',['-p',file],{encoding:'utf8',maxBuffer:512*1024*1024}),out:AggTrade[]=[];
  for(const line of csv.split(/\r?\n/)){if(!line.trim())continue;const c=line.split(','),price=Number(c[1]),qty=Number(c[2]),raw=Number(c[5]);if(!Number.isFinite(price)||!Number.isFinite(qty)||!Number.isFinite(raw))continue;out.push({time:norm(raw),price,qty,buyerMaker:String(c[6]).trim().toLowerCase()==='true'});}return out;
}
function norm(v:number){if(v>1e17)return Math.floor(v/1_000_000);if(v>1e14)return Math.floor(v/1000);return v;}
function toBars(trades:AggTrade[]):Bar[]{const m=new Map<number,Bar>();for(const t of trades){const k=Math.floor(t.time/BAR_MS)*BAR_MS;let b=m.get(k);if(!b){b={time:k,open:t.price,high:t.price,low:t.price,close:t.price,volume:0,buyVolume:0,sellVolume:0,trades:0};m.set(k,b);}b.high=Math.max(b.high,t.price);b.low=Math.min(b.low,t.price);b.close=t.price;b.volume+=t.qty;b.trades++;if(t.buyerMaker)b.sellVolume+=t.qty;else b.buyVolume+=t.qty;}return[...m.values()].sort((a,b)=>a.time-b.time);}
function atrSeries(b:Bar[],p=20){const o=new Array<number>(b.length).fill(0);if(!b.length)return o;o[0]=b[0].high-b[0].low;for(let i=1;i<b.length;i++){const tr=Math.max(b[i].high-b[i].low,Math.abs(b[i].high-b[i-1].close),Math.abs(b[i].low-b[i-1].close));o[i]=i<p?(o[i-1]*i+tr)/(i+1):(o[i-1]*(p-1)+tr)/p;}return o;}
function rollingZ(v:number[],p:number){const o=new Array<number>(v.length).fill(0),q:number[]=[];let s=0,s2=0;for(let i=0;i<v.length;i++){const x=v[i];q.push(x);s+=x;s2+=x*x;if(q.length>p){const y=q.shift()!;s-=y;s2-=y*y;}if(q.length>=20){const m=s/q.length,va=Math.max(1e-12,s2/q.length-m*m);o[i]=(x-m)/Math.sqrt(va);}}return o;}
function hi(b:Bar[],i:number,n:number){let x=-Infinity;for(let j=Math.max(0,i-n);j<i;j++)x=Math.max(x,b[j].high);return x;}
function lo(b:Bar[],i:number,n:number){let x=Infinity;for(let j=Math.max(0,i-n);j<i;j++)x=Math.min(x,b[j].low);return x;}
function prep(bars:Bar[]):Prepared{return{bars,atr:atrSeries(bars),volZ:rollingZ(bars.map(x=>x.volume),120),velZ:rollingZ(bars.map(x=>x.trades),120)};}

function run(d:Prepared,c:Config,start:number,end:number,cost:number):Stats{
  const {bars,atr,volZ,velZ}=d,trades:Trade[]=[];let next=start;
  for(let i=Math.max(start,240);i<Math.min(end,bars.length-2);i++){
    if(i<next)continue;const b=bars[i],tot=b.buyVolume+b.sellVolume;if(tot<=0||atr[i]<=0)continue;const imb=(b.buyVolume-b.sellVolume)/tot;if(volZ[i]<c.volumeZMin||velZ[i]<c.velocityZMin)continue;
    const prev=bars[i-c.trendBars]?.close;if(!(prev>0))continue;const trend=(b.close-prev)/prev*100;let side:Side|null=null;
    if(imb>=c.imbalanceMin&&trend>=c.trendMinPct&&b.close>hi(bars,i,c.breakoutBars))side='BUY';else if(imb<=-c.imbalanceMin&&trend<=-c.trendMinPct&&b.close<lo(bars,i,c.breakoutBars))side='SELL';if(!side)continue;
    const ei=i+1,entry=bars[ei].open,risk=atr[i]*c.slAtr,reward=atr[i]*c.tpAtr,sl=side==='BUY'?entry-risk:entry+risk,tp=side==='BUY'?entry+reward:entry-reward;let exit=bars[Math.min(end-1,ei+c.maxHoldBars)].close,xi=Math.min(end-1,ei+c.maxHoldBars);
    for(let j=ei;j<=Math.min(end-1,ei+c.maxHoldBars);j++){const x=bars[j];if(side==='BUY'){if(x.low<=sl){exit=sl;xi=j;break;}if(x.high>=tp){exit=tp;xi=j;break;}}else{if(x.high>=sl){exit=sl;xi=j;break;}if(x.low<=tp){exit=tp;xi=j;break;}}}
    const gross=side==='BUY'?(exit-entry)/entry*100:(entry-exit)/entry*100;trades.push({netPct:gross-cost});next=xi+c.cooloffBars;
  }
  return stats(trades,bars,start,end);
}
function stats(t:Trade[],b:Bar[],start:number,end:number):Stats{let eq=100,peak=100,dd=0,gp=0,gl=0,w=0;for(const x of t){eq*=1+x.netPct/100;peak=Math.max(peak,eq);dd=Math.max(dd,(peak-eq)/peak*100);if(x.netPct>0){w++;gp+=x.netPct}else gl+=Math.abs(x.netPct);}const f=b[Math.max(start,0)],l=b[Math.min(end-1,b.length-1)],days=Math.max(1,f&&l?(l.time-f.time)/DAY:1);return{trades:t.length,wins:w,losses:t.length-w,winRate:t.length?w/t.length*100:0,netReturnPct:eq-100,expectancyPct:t.length?t.reduce((s,x)=>s+x.netPct,0)/t.length:0,profitFactor:gl>0?gp/gl:gp>0?99:0,maxDrawdownPct:dd,tradesPerDay:t.length/days};}
function score(s:Stats){if(s.trades<25||s.netReturnPct<=0||s.expectancyPct<=0||s.profitFactor<=1)return-Infinity;return s.netReturnPct+Math.min(3,s.profitFactor)*2+s.expectancyPct*50-Math.max(0,s.maxDrawdownPct-8)*2;}

async function main(){
  const endDay=Math.floor((Date.now()-2*DAY)/DAY)*DAY,startDay=endDay-DAYS*DAY,dir=await mkdtemp(path.join(os.tmpdir(),'xau-oflow-')),bars:Bar[]=[];
  for(let t=startDay;t<endDay;t+=DAY){const day=new Date(t).toISOString().slice(0,10),rows=await fetchDay(day,dir),bs=toBars(rows);console.log('DAY',day,'aggTrades',rows.length,'bars30s',bs.length);for(const x of bs)bars.push(x);}bars.sort((a,b)=>a.time-b.time);if(bars.length<20_000)throw new Error(`INSUFFICIENT_30S_BARS:${bars.length}`);
  const data=prep(bars),n=bars.length,trEnd=Math.floor(n*.50),vaEnd=Math.floor(n*.75);console.log('BARS30S',n,'FROM',new Date(bars[0].time).toISOString(),'TO',new Date(bars.at(-1)!.time).toISOString());
  const configs:Config[]=[];for(const imbalanceMin of[0.16,0.28,0.40])for(const volumeZMin of[0,0.75,1.5])for(const velocityZMin of[0,0.75])for(const trendBars of[10,30])for(const trendMinPct of[0.02,0.06])for(const breakoutBars of[4,12])for(const tpAtr of[2,3,4])for(const slAtr of[1,1.75])for(const maxHoldBars of[6,16,30])configs.push({imbalanceMin,volumeZMin,velocityZMin,trendBars,trendMinPct,breakoutBars,tpAtr,slAtr,maxHoldBars,cooloffBars:2});

  for(const cost of COST_SCENARIOS){let best:{cfg:Config;train:Stats;val:Stats;score:number}|null=null,tested=0,trainPositive=0,valPositive=0;for(const cfg of configs){tested++;const tr=run(data,cfg,240,trEnd,cost),sc=score(tr);if(!Number.isFinite(sc))continue;trainPositive++;const va=run(data,cfg,trEnd,vaEnd,cost);if(va.trades<10||va.netReturnPct<=0||va.expectancyPct<=0||va.profitFactor<=1)continue;valPositive++;const combined=sc+va.netReturnPct+va.expectancyPct*50+Math.min(3,va.profitFactor)*2;if(!best||combined>best.score)best={cfg,train:tr,val:va,score:combined};}
    if(!best){console.log('COST_RESULT',JSON.stringify({costPct:cost,tested,trainPositive,valPositive,survived:false,reason:'NO_TRAIN_VALIDATION_EDGE'}));continue;}
    const test=run(data,best.cfg,vaEnd,n,cost),survived=test.trades>=10&&test.netReturnPct>0&&test.expectancyPct>0&&test.profitFactor>1;console.log('COST_RESULT',JSON.stringify({costPct:cost,tested,trainPositive,valPositive,survived,best:{config:best.cfg,train:best.train,validation:best.val,test}}));
  }
}
main().catch(e=>{console.error('ORDERFLOW_ERROR',e instanceof Error?e.message:String(e));process.exit(1);});
