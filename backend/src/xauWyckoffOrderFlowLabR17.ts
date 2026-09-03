import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

type Side='BUY'|'SELL';
type AggTrade={time:number;price:number;qty:number;buyerMaker:boolean};
type Bar={time:number;open:number;high:number;low:number;close:number;volume:number;buyVolume:number;sellVolume:number;trades:number};
type Config={rangeBars:number;stopVolZ:number;absorbImb:number;maxPenAtr:number;testBars:number;testVolRatio:number;confirmBars:number;rr:number;maxHoldBars:number;allowShort:boolean};
type Trade={side:Side;entryTime:number;exitTime:number;marketNetPct:number;accountRetPct:number;reason:'TP'|'SL'|'TIME'};
type Stats={trades:number;wins:number;winRate:number;profitFactor:number;marketNetSumPct:number;accountReturnPct:number;expectancyAccountPct:number;maxDrawdownPct:number;tradesPerDay:number;final50:number};

const SYMBOL='XAUUSDT';
const BASE=`https://data.binance.vision/data/futures/um/daily/aggTrades/${SYMBOL}`;
const DAY=86_400_000;
const DAYS=60;
const MICRO_MS=30_000;
const TF_MS=5*60_000;
const COST_PCT=0.145; // conservative round-trip underlying cost
const ACCOUNT_EXPOSURE=0.10; // 1% margin x 10x leverage = 10% notional/equity

function normEpoch(v:number){if(v>1e17)return Math.floor(v/1_000_000);if(v>1e14)return Math.floor(v/1000);return v;}
async function fetchDay(day:string,dir:string):Promise<AggTrade[]>{
  const fn=`${SYMBOL}-aggTrades-${day}.zip`,res=await fetch(`${BASE}/${fn}`);
  if(res.status===404)return[]; if(!res.ok)throw new Error(`VISION_${res.status}:${day}`);
  const file=path.join(dir,fn);await writeFile(file,Buffer.from(await res.arrayBuffer()));
  const csv=execFileSync('unzip',['-p',file],{encoding:'utf8',maxBuffer:512*1024*1024});
  const out:AggTrade[]=[];
  for(const line of csv.split(/\r?\n/)){if(!line.trim())continue;const c=line.split(',');const price=+c[1],qty=+c[2],t=+c[5];if(!Number.isFinite(price)||!Number.isFinite(qty)||!Number.isFinite(t))continue;out.push({time:normEpoch(t),price,qty,buyerMaker:String(c[6]).trim().toLowerCase()==='true'});}return out;
}
function aggregate(trades:AggTrade[],ms:number):Bar[]{const m=new Map<number,Bar>();for(const t of trades){const k=Math.floor(t.time/ms)*ms;let b=m.get(k);if(!b){b={time:k,open:t.price,high:t.price,low:t.price,close:t.price,volume:0,buyVolume:0,sellVolume:0,trades:0};m.set(k,b);}b.high=Math.max(b.high,t.price);b.low=Math.min(b.low,t.price);b.close=t.price;b.volume+=t.qty;b.trades++;if(t.buyerMaker)b.sellVolume+=t.qty;else b.buyVolume+=t.qty;}return[...m.values()].sort((a,b)=>a.time-b.time);}
function aggregateBars(src:Bar[],ms:number):Bar[]{const m=new Map<number,Bar>();for(const x of src){const k=Math.floor(x.time/ms)*ms;let b=m.get(k);if(!b){b={time:k,open:x.open,high:x.high,low:x.low,close:x.close,volume:0,buyVolume:0,sellVolume:0,trades:0};m.set(k,b);}b.high=Math.max(b.high,x.high);b.low=Math.min(b.low,x.low);b.close=x.close;b.volume+=x.volume;b.buyVolume+=x.buyVolume;b.sellVolume+=x.sellVolume;b.trades+=x.trades;}return[...m.values()].sort((a,b)=>a.time-b.time);}
function atr(b:Bar[],p=20){const a=new Array(b.length).fill(0);if(!b.length)return a;a[0]=b[0].high-b[0].low;for(let i=1;i<b.length;i++){const tr=Math.max(b[i].high-b[i].low,Math.abs(b[i].high-b[i-1].close),Math.abs(b[i].low-b[i-1].close));a[i]=i<p?(a[i-1]*i+tr)/(i+1):(a[i-1]*(p-1)+tr)/p;}return a;}
function zSeries(v:number[],p=96){const o=new Array(v.length).fill(0);let s=0,s2=0;const q:number[]=[];for(let i=0;i<v.length;i++){const x=v[i];q.push(x);s+=x;s2+=x*x;if(q.length>p){const y=q.shift()!;s-=y;s2-=y*y;}if(q.length>=24){const mean=s/q.length,vr=Math.max(1e-12,s2/q.length-mean*mean);o[i]=(x-mean)/Math.sqrt(vr);}}return o;}
function lo(b:Bar[],i:number,n:number){let x=Infinity;for(let j=Math.max(0,i-n);j<i;j++)x=Math.min(x,b[j].low);return x;}
function hi(b:Bar[],i:number,n:number){let x=-Infinity;for(let j=Math.max(0,i-n);j<i;j++)x=Math.max(x,b[j].high);return x;}
function imb(x:Bar){const t=x.buyVolume+x.sellVolume;return t?(x.buyVolume-x.sellVolume)/t:0;}
function closeLoc(x:Bar){const r=x.high-x.low;return r>0?(x.close-x.low)/r:.5;}

type Setup={side:Side;springIdx:number;support:number;springVol:number;springLow:number;springHigh:number;sl:number};
function findSetup(b:Bar[],a:number[],vz:number[],i:number,c:Config):Setup|null{
  if(i<Math.max(120,c.rangeBars+5)||a[i]<=0)return null;
  const x=b[i],support=lo(b,i,c.rangeBars),res=hi(b,i,c.rangeBars),im=imb(x),cl=closeLoc(x);
  // Long: Wyckoff stopping effort + spring. Heavy selling / high effort but price rejects lower prices.
  const penL=(support-x.low)/a[i];
  if(vz[i]>=c.stopVolZ && x.low<support && penL>=0 && penL<=c.maxPenAtr && x.close>support && im<=-c.absorbImb && cl>=0.55){
    return{side:'BUY',springIdx:i,support,springVol:x.volume,springLow:x.low,springHigh:x.high,sl:x.low-0.15*a[i]};
  }
  if(c.allowShort){
    const penS=(x.high-res)/a[i];
    if(vz[i]>=c.stopVolZ && x.high>res && penS>=0 && penS<=c.maxPenAtr && x.close<res && im>=c.absorbImb && cl<=0.45){
      return{side:'SELL',springIdx:i,support:res,springVol:x.volume,springLow:x.low,springHigh:x.high,sl:x.high+0.15*a[i]};
    }
  }
  return null;
}
function run(b:Bar[],c:Config,start:number,end:number):Stats{
  const a=atr(b,20),vz=zSeries(b.map(x=>x.volume),96);const trades:Trade[]=[];let next=start;
  for(let i=Math.max(start,140);i<Math.min(end,b.length-10);i++){
    if(i<next)continue;const s=findSetup(b,a,vz,i,c);if(!s)continue;
    let test=-1;
    for(let j=i+1;j<=Math.min(end-3,i+c.testBars);j++){
      const x=b[j];
      if(s.side==='BUY'){
        const quality=x.low>s.springLow && x.low<=s.support+0.55*a[j] && x.volume<=s.springVol*c.testVolRatio && imb(x)>-c.absorbImb && x.close>=s.support;
        if(quality){test=j;break;}
      }else{
        const quality=x.high<s.springHigh && x.high>=s.support-0.55*a[j] && x.volume<=s.springVol*c.testVolRatio && imb(x)<c.absorbImb && x.close<=s.support;
        if(quality){test=j;break;}
      }
    }
    if(test<0)continue;
    let conf=-1;
    for(let j=test+1;j<=Math.min(end-2,test+c.confirmBars);j++){
      if(s.side==='BUY' && b[j].close>b[test].high && imb(b[j])>0){conf=j;break;}
      if(s.side==='SELL'&& b[j].close<b[test].low && imb(b[j])<0){conf=j;break;}
    }
    if(conf<0)continue;
    const ei=conf+1,entry=b[ei].open,sl=s.sl,risk=Math.abs(entry-sl);if(!(risk>0))continue;const tp=s.side==='BUY'?entry+c.rr*risk:entry-c.rr*risk;
    let exit=b[Math.min(end-1,ei+c.maxHoldBars)].close,xi=Math.min(end-1,ei+c.maxHoldBars),reason:Trade['reason']='TIME';
    for(let j=ei;j<=Math.min(end-1,ei+c.maxHoldBars);j++){const x=b[j];if(s.side==='BUY'){const hs=x.low<=sl,ht=x.high>=tp;if(hs){exit=sl;xi=j;reason='SL';break;}if(ht){exit=tp;xi=j;reason='TP';break;}}else{const hs=x.high>=sl,ht=x.low<=tp;if(hs){exit=sl;xi=j;reason='SL';break;}if(ht){exit=tp;xi=j;reason='TP';break;}}}
    const gross=s.side==='BUY'?(exit-entry)/entry*100:(entry-exit)/entry*100,marketNet=gross-COST_PCT,accountRet=marketNet*ACCOUNT_EXPOSURE;
    trades.push({side:s.side,entryTime:b[ei].time,exitTime:b[xi].time,marketNetPct:marketNet,accountRetPct:accountRet,reason});next=xi+2;
  }
  return calc(trades,b,start,end);
}
function calc(t:Trade[],b:Bar[],start:number,end:number):Stats{let eq=100,pk=100,dd=0,gp=0,gl=0,w=0,sm=0;for(const x of t){eq*=1+x.accountRetPct/100;pk=Math.max(pk,eq);dd=Math.max(dd,(pk-eq)/pk*100);sm+=x.marketNetPct;if(x.accountRetPct>0){w++;gp+=x.accountRetPct}else gl+=Math.abs(x.accountRetPct);}const first=b[Math.max(0,start)],last=b[Math.min(b.length-1,end-1)],days=Math.max(1,(last.time-first.time)/DAY);return{trades:t.length,wins:w,winRate:t.length?w/t.length*100:0,profitFactor:gl?gp/gl:gp?99:0,marketNetSumPct:sm,accountReturnPct:eq-100,expectancyAccountPct:t.length?t.reduce((s,x)=>s+x.accountRetPct,0)/t.length:0,maxDrawdownPct:dd,tradesPerDay:t.length/days,final50:50*eq/100};}
function passes(s:Stats,minTrades:number){return s.trades>=minTrades&&s.accountReturnPct>0&&s.expectancyAccountPct>0&&s.profitFactor>1;}
async function main(){const end=Math.floor((Date.now()-2*DAY)/DAY)*DAY,start=end-DAYS*DAY,dir=await mkdtemp(path.join(os.tmpdir(),'xau-wyckoff-'));const micro:Bar[]=[];for(let t=start;t<end;t+=DAY){const d=new Date(t).toISOString().slice(0,10),rows=await fetchDay(d,dir),bs=aggregate(rows,MICRO_MS);console.log('DAY',d,'aggTrades',rows.length,'bars30s',bs.length);micro.push(...bs);}const bars=aggregateBars(micro,TF_MS);console.log('BARS5M',bars.length,'FROM',new Date(bars[0].time).toISOString(),'TO',new Date(bars.at(-1)!.time).toISOString());const n=bars.length,trEnd=Math.floor(n*.50),vaEnd=Math.floor(n*.75);const cfgs:Config[]=[];for(const rangeBars of [12,24,48])for(const stopVolZ of [0.5,1,1.5])for(const absorbImb of [0.08,0.16,0.24])for(const maxPenAtr of [0.5,1,1.5])for(const testBars of [3,6,12])for(const testVolRatio of [0.5,0.7,0.9])for(const confirmBars of [2,4])for(const rr of [1.5,2,3])cfgs.push({rangeBars,stopVolZ,absorbImb,maxPenAtr,testBars,testVolRatio,confirmBars,rr,maxHoldBars:36,allowShort:true});let best:any=null,tested=0,trPos=0,vaPos=0;for(const c of cfgs){tested++;const tr=run(bars,c,0,trEnd);if(!passes(tr,10))continue;trPos++;const va=run(bars,c,trEnd,vaEnd);if(!passes(va,5))continue;vaPos++;const score=tr.accountReturnPct+va.accountReturnPct+Math.min(3,tr.profitFactor)+Math.min(3,va.profitFactor)-tr.maxDrawdownPct-va.maxDrawdownPct;if(!best||score>best.score)best={c,tr,va,score};}console.log('SEARCH',JSON.stringify({tested,trainPositive:trPos,validationPositive:vaPos}));if(!best){console.log('WYCKOFF_RESULT',JSON.stringify({survived:false,reason:'NO_CONFIG_SURVIVED_TRAIN_VALIDATION',model:'WYCKOFF_SPRING_TEST_CONFIRMATION_5M_PLUS_AGGTRADES',costPct:COST_PCT,accountExposure:ACCOUNT_EXPOSURE}));return;}const te=run(bars,best.c,vaEnd,n),survived=passes(te,5);console.log('WYCKOFF_RESULT',JSON.stringify({survived,config:best.c,train:best.tr,validation:best.va,test:te,model:'WYCKOFF_SPRING_TEST_CONFIRMATION_5M_PLUS_AGGTRADES',costPct:COST_PCT,accountExposure:ACCOUNT_EXPOSURE}));}
main().catch(e=>{console.error('WYCKOFF_ERROR',e instanceof Error?e.message:String(e));process.exit(1);});
