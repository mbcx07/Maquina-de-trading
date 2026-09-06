import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

type Bar={time:number;open:number;high:number;low:number;close:number;volume:number};
type Side='BUY'|'SELL';
type Trade={side:Side;entryTime:number;exitTime:number;grossPct:number;netPct:number;accountRetPct:number;reason:string;votes?:number};
type Stats={trades:number;wins:number;winRate:number;profitFactor:number;netMarketSumPct:number;accountReturnPct:number;maxDrawdownPct:number;tradesPerDay:number;final50:number;avgVotes?:number};

const SYMBOL='XAUUSDT';
const BASE=`https://data.binance.vision/data/futures/um/daily/klines/${SYMBOL}/1m`;
const DAY=86400000, DAYS=120, COST=0.145, EXPOSURE=0.10;

async function fetchDay(day:string,dir:string):Promise<Bar[]> {
  const fn=`${SYMBOL}-1m-${day}.zip`,res=await fetch(`${BASE}/${fn}`);
  if(res.status===404)return[]; if(!res.ok)throw new Error(`VISION_${res.status}:${day}`);
  const file=path.join(dir,fn); await writeFile(file,Buffer.from(await res.arrayBuffer()));
  const csv=execFileSync('unzip',['-p',file],{encoding:'utf8',maxBuffer:256*1024*1024});
  const out:Bar[]=[];
  for(const line of csv.split(/\r?\n/)){if(!line.trim())continue;const c=line.split(',');const t=+c[0],o=+c[1],h=+c[2],l=+c[3],cl=+c[4],v=+c[5];if([t,o,h,l,cl,v].every(Number.isFinite))out.push({time:t,open:o,high:h,low:l,close:cl,volume:v});}
  return out;
}
function ema(v:number[],p:number){const o=new Array(v.length).fill(NaN);if(!v.length)return o;const k=2/(p+1);let e=v[0];o[0]=e;for(let i=1;i<v.length;i++){e=v[i]*k+e*(1-k);o[i]=e;}return o;}
function sma(v:number[],p:number){const o=new Array(v.length).fill(NaN);let s=0;for(let i=0;i<v.length;i++){s+=v[i];if(i>=p)s-=v[i-p];if(i>=p-1)o[i]=s/p;}return o;}
function std(v:number[],p:number){const o=new Array(v.length).fill(NaN);for(let i=p-1;i<v.length;i++){let m=0;for(let j=i-p+1;j<=i;j++)m+=v[j];m/=p;let s=0;for(let j=i-p+1;j<=i;j++){const d=v[j]-m;s+=d*d;}o[i]=Math.sqrt(s/p);}return o;}
function atr(b:Bar[],p=14){const tr=b.map((x,i)=>i?Math.max(x.high-x.low,Math.abs(x.high-b[i-1].close),Math.abs(x.low-b[i-1].close)):x.high-x.low);const o=new Array(b.length).fill(NaN);let a=tr[0];o[0]=a;for(let i=1;i<tr.length;i++){a=i<p?(a*i+tr[i])/(i+1):(a*(p-1)+tr[i])/p;o[i]=a;}return o;}
function rsi(c:number[],p=14){const o=new Array(c.length).fill(NaN);let ag=0,al=0;for(let i=1;i<c.length;i++){const d=c[i]-c[i-1],g=Math.max(d,0),l=Math.max(-d,0);if(i<=p){ag+=g;al+=l;if(i===p){ag/=p;al/=p;o[i]=al===0?100:100-100/(1+ag/al);}}else{ag=(ag*(p-1)+g)/p;al=(al*(p-1)+l)/p;o[i]=al===0?100:100-100/(1+ag/al);}}return o;}
function adxDI(b:Bar[],p=14){const n=b.length,plus=new Array(n).fill(0),minus=new Array(n).fill(0),tr=new Array(n).fill(0);for(let i=1;i<n;i++){const up=b[i].high-b[i-1].high,dn=b[i-1].low-b[i].low;plus[i]=up>dn&&up>0?up:0;minus[i]=dn>up&&dn>0?dn:0;tr[i]=Math.max(b[i].high-b[i].low,Math.abs(b[i].high-b[i-1].close),Math.abs(b[i].low-b[i-1].close));}const pdi=new Array(n).fill(NaN),mdi=new Array(n).fill(NaN),adx=new Array(n).fill(NaN);let atrs=0,ps=0,ms=0;const dx=new Array(n).fill(NaN);for(let i=1;i<n;i++){if(i<=p){atrs+=tr[i];ps+=plus[i];ms+=minus[i];if(i===p){pdi[i]=100*ps/atrs;mdi[i]=100*ms/atrs;dx[i]=100*Math.abs(pdi[i]-mdi[i])/Math.max(1e-9,pdi[i]+mdi[i]);}}else{atrs=atrs-atrs/p+tr[i];ps=ps-ps/p+plus[i];ms=ms-ms/p+minus[i];pdi[i]=100*ps/atrs;mdi[i]=100*ms/atrs;dx[i]=100*Math.abs(pdi[i]-mdi[i])/Math.max(1e-9,pdi[i]+mdi[i]);}}let sum=0,cnt=0;for(let i=p;i<n;i++){if(Number.isFinite(dx[i])){if(cnt<p){sum+=dx[i];cnt++;if(cnt===p)adx[i]=sum/p;}else{const prev=adx[i-1];adx[i]=(prev*(p-1)+dx[i])/p;}}}return{adx,pdi,mdi};}
function macd(c:number[]){const e12=ema(c,12),e26=ema(c,26),m=c.map((_,i)=>e12[i]-e26[i]),sig=ema(m.map(x=>Number.isFinite(x)?x:0),9);return{m,sig};}
function stoch(b:Bar[],p=14){const out=new Array(b.length).fill(NaN);for(let i=p-1;i<b.length;i++){let lo=Infinity,hi=-Infinity;for(let j=i-p+1;j<=i;j++){lo=Math.min(lo,b[j].low);hi=Math.max(hi,b[j].high);}out[i]=100*(b[i].close-lo)/Math.max(1e-9,hi-lo);}return out;}
function roc(c:number[],p:number,i:number){return i>=p?(c[i]/c[i-p]-1)*100:0;}
function hh(b:Bar[],i:number,n:number){let x=-Infinity;for(let j=i-n;j<i;j++)x=Math.max(x,b[j].high);return x;}
function ll(b:Bar[],i:number,n:number){let x=Infinity;for(let j=i-n;j<i;j++)x=Math.min(x,b[j].low);return x;}

function stats(t:Trade[],bars:Bar[],start:number,end:number):Stats{let eq=100,peak=100,dd=0,gp=0,gl=0,w=0,sm=0,v=0;for(const x of t){eq*=1+x.accountRetPct/100;peak=Math.max(peak,eq);dd=Math.max(dd,(peak-eq)/peak*100);sm+=x.netPct;if(x.accountRetPct>0){w++;gp+=x.accountRetPct}else gl+=Math.abs(x.accountRetPct);v+=x.votes||0;}const days=Math.max(1,(bars[end-1].time-bars[start].time)/DAY);return{trades:t.length,wins:w,winRate:t.length?w/t.length*100:0,profitFactor:gl?gp/gl:gp?99:0,netMarketSumPct:sm,accountReturnPct:eq-100,maxDrawdownPct:dd,tradesPerDay:t.length/days,final50:50*eq/100,avgVotes:t.length?v/t.length:undefined};}

function runMonster(b:Bar[],start:number,end:number):Stats{
 const c=b.map(x=>x.close),a=atr(b,14),e8=ema(c,8),e14=ema(c,14),e200=ema(c,200),di=adxDI(b,14);
 const trades:Trade[]=[]; let i=Math.max(start,220),nextSignalTime=0;
 while(i<end-10){
   if(b[i].time<nextSignalTime){i++;continue;}
   if(!(di.adx[i]>=12)){i++;continue;}
   const trendUp=c[i]>e200[i]&&e8[i]>e14[i]&&di.pdi[i]>di.mdi[i];
   const trendDn=c[i]<e200[i]&&e8[i]<e14[i]&&di.mdi[i]>di.pdi[i];
   const top=Math.max(e8[i],e14[i]),bot=Math.min(e8[i],e14[i]);
   const pullBuy=b[i].low<=top+a[i]*.20&&c[i]>top&&c[i]>b[i].open;
   const pullSell=b[i].high>=bot-a[i]*.20&&c[i]<bot&&c[i]<b[i].open;
   const breakBuy=c[i]>Math.max(b[i-1].high,b[i-2].high)&&c[i]>b[i].open;
   const breakSell=c[i]<Math.min(b[i-1].low,b[i-2].low)&&c[i]<b[i].open;
   const side:Side|null=trendUp&&(pullBuy||breakBuy)?'BUY':trendDn&&(pullSell||breakSell)?'SELL':null;
   if(!side){i++;continue;}
   const limit=side==='BUY'?c[i]-a[i]*.5:c[i]+a[i]*.5;
   let fill=-1;
   for(let j=i+1;j<=Math.min(end-1,i+5);j++){if(side==='BUY'&&b[j].low<=limit){fill=j;break;}if(side==='SELL'&&b[j].high>=limit){fill=j;break;}}
   nextSignalTime=b[i].time+10*60_000;
   if(fill<0){i++;continue;}
   const slD=a[i]*5,tpD=slD*.5,sl=side==='BUY'?limit-slD:limit+slD,tp=side==='BUY'?limit+tpD:limit-tpD;
   let exit=b[Math.min(end-1,fill+240)].close,xi=Math.min(end-1,fill+240),reason='TIME';
   for(let j=fill;j<=Math.min(end-1,fill+240);j++){const x=b[j];if(side==='BUY'){if(x.low<=sl){exit=sl;xi=j;reason='SL';break;}if(x.high>=tp){exit=tp;xi=j;reason='TP';break;}}else{if(x.high>=sl){exit=sl;xi=j;reason='SL';break;}if(x.low<=tp){exit=tp;xi=j;reason='TP';break;}}}
   const gross=side==='BUY'?(exit-limit)/limit*100:(limit-exit)/limit*100,net=gross-COST;trades.push({side,entryTime:b[fill].time,exitTime:b[xi].time,grossPct:gross,netPct:net,accountRetPct:net*EXPOSURE,reason});i=xi+1;
 }
 return stats(trades,b,start,end);
}

function buildVotes(b:Bar[]){
 const c=b.map(x=>x.close),a=atr(b,14),r=rsi(c,14),e200=ema(c,200),mac=macd(c),st=stoch(b,14);
 const emaPairs=[[5,13],[8,21],[9,21],[10,30],[12,26],[14,35],[20,50],[21,55],[30,60],[50,100]];
 const emas=new Map<number,number[]>();for(const [x,y] of emaPairs){if(!emas.has(x))emas.set(x,ema(c,x));if(!emas.has(y))emas.set(y,ema(c,y));}
 const extra=[8,13,21,34,55,89];for(const n of extra)if(!emas.has(n))emas.set(n,ema(c,n));
 const smaCache=new Map<number,number[]>(),stdCache=new Map<number,number[]>();for(const p of [10,12,15,18,20,24,30,36,45,60]){smaCache.set(p,sma(c,p));stdCache.set(p,std(c,p));}
 return (i:number)=>{let buy=0,sell=0;
   for(const [f,s] of emaPairs){const ef=emas.get(f)!,es=emas.get(s)!;if(c[i]>e200[i]&&ef[i]>es[i])buy++;if(c[i]<e200[i]&&ef[i]<es[i])sell++;}
   for(const n of [3,5,8,10,12,15,20,30,45,60]){if(i>n&&c[i]>hh(b,i,n))buy++;if(i>n&&c[i]<ll(b,i,n))sell++;}
   for(const [k,n] of [[.1,8],[.15,13],[.2,21],[.25,34],[.3,55],[.35,89],[.4,21],[.5,34],[.6,55],[.75,89]] as [number,number][]){const ee=emas.get(n)!;if(c[i]>e200[i]&&b[i].low<=ee[i]+a[i]*k&&c[i]>ee[i]&&c[i]>b[i].open)buy++;if(c[i]<e200[i]&&b[i].high>=ee[i]-a[i]*k&&c[i]<ee[i]&&c[i]<b[i].open)sell++;}
   for(const th of [52,54,56,58,60,62,64,66,68,70]){if(r[i]>=th)buy++;if(r[i]<=100-th)sell++;}
   for(const th of [20,22,24,26,28,30,32,34,36,38]){if(r[i]<=th)buy++;if(r[i]>=100-th)sell++;}
   for(const k of [0,.02,.04,.06,.08,.1,.12,.14,.16,.18]){const d=(mac.m[i]-mac.sig[i])/Math.max(a[i],1e-9);if(d>k)buy++;if(d<-k)sell++;}
   for(const th of [15,20,25,30,35,65,70,75,80,85]){if(th<=35){if(st[i]<=th)buy++;if(st[i]>=100-th)sell++;}else{if(st[i]>=th)buy++;if(st[i]<=100-th)sell++;}}
   for(const p of [2,3,5,8,10,15,20,30,45,60]){const x=roc(c,p,i);if(x>0)buy++;if(x<0)sell++;}
   for(const p of [10,12,15,18,20,24,30,36,45,60]){const ss=smaCache.get(p)!,sd=stdCache.get(p)!;if(i>=p&&c[i]<ss[i]-2*sd[i])buy++;if(i>=p&&c[i]>ss[i]+2*sd[i])sell++;}
   const body=Math.abs(c[i]-b[i].open),rng=Math.max(1e-9,b[i].high-b[i].low),lower=Math.min(c[i],b[i].open)-b[i].low,upper=b[i].high-Math.max(c[i],b[i].open);
   const prev=b[i-1];const engulfB=c[i]>b[i].open&&prev.close<prev.open&&b[i].open<prev.close&&c[i]>prev.open;const engulfS=c[i]<b[i].open&&prev.close>prev.open&&b[i].open>prev.close&&c[i]<prev.open;
   const condsB=[lower>body*2,engulfB,c[i]>b[i-1].high,c[i]>hh(b,i,5),c[i]>hh(b,i,10),body/rng>.6&&c[i]>b[i].open,body/rng>.75&&c[i]>b[i].open,upper/rng<.15&&c[i]>b[i].open,c[i]>e200[i]&&r[i]>50,c[i]>e200[i]&&mac.m[i]>mac.sig[i]];
   const condsS=[upper>body*2,engulfS,c[i]<b[i-1].low,c[i]<ll(b,i,5),c[i]<ll(b,i,10),body/rng>.6&&c[i]<b[i].open,body/rng>.75&&c[i]<b[i].open,lower/rng<.15&&c[i]<b[i].open,c[i]<e200[i]&&r[i]<50,c[i]<e200[i]&&mac.m[i]<mac.sig[i]];
   for(const x of condsB)if(x)buy++;for(const x of condsS)if(x)sell++;
   return{buy,sell};
 };
}
function runEnsemble(b:Bar[],start:number,end:number):Stats{
 const vote=buildVotes(b),a=atr(b,14);const trades:Trade[]=[];let i=Math.max(start,220);
 while(i<end-2){const v=vote(i);let side:Side|null=null,votes=0;if(v.buy>=5&&v.buy>v.sell){side='BUY';votes=v.buy;}else if(v.sell>=5&&v.sell>v.buy){side='SELL';votes=v.sell;}if(!side){i++;continue;}
   const entry=b[i+1].open,slD=a[i]*2.5,tpD=slD*1.5,sl=side==='BUY'?entry-slD:entry+slD,tp=side==='BUY'?entry+tpD:entry-tpD;let exit=b[Math.min(end-1,i+121)].close,xi=Math.min(end-1,i+121),reason='TIME';
   for(let j=i+1;j<=Math.min(end-1,i+121);j++){const x=b[j];if(side==='BUY'){if(x.low<=sl){exit=sl;xi=j;reason='SL';break;}if(x.high>=tp){exit=tp;xi=j;reason='TP';break;}}else{if(x.high>=sl){exit=sl;xi=j;reason='SL';break;}if(x.low<=tp){exit=tp;xi=j;reason='TP';break;}}}
   const gross=side==='BUY'?(exit-entry)/entry*100:(entry-exit)/entry*100,net=gross-COST;trades.push({side,entryTime:b[i+1].time,exitTime:b[xi].time,grossPct:gross,netPct:net,accountRetPct:net*EXPOSURE,reason,votes});i=xi+2;
 }
 return stats(trades,b,start,end);
}
async function main(){const end=Math.floor((Date.now()-2*DAY)/DAY)*DAY,start=end-DAYS*DAY,dir=await mkdtemp(path.join(os.tmpdir(),'xau-r18-'));const bars:Bar[]=[];for(let t=start;t<end;t+=DAY){const d=new Date(t).toISOString().slice(0,10),x=await fetchDay(d,dir);bars.push(...x);}bars.sort((a,b)=>a.time-b.time);console.log('DATA',JSON.stringify({bars:bars.length,from:new Date(bars[0].time).toISOString(),to:new Date(bars.at(-1)!.time).toISOString()}));const n=bars.length,a=Math.floor(n*.5),bb=Math.floor(n*.75);const ranges=[['TRAIN',0,a],['VALIDATION',a,bb],['BLIND_TEST',bb,n],['FULL',0,n]] as const;for(const [name,s,e] of ranges){const monster=runMonster(bars,s,e),ensemble=runEnsemble(bars,s,e);console.log('COMPARE',name,JSON.stringify({AI_MONSTER_V6:monster,ENSEMBLE_100_CONFLUENCE_5:ensemble}));}}
main().catch(e=>{console.error(e);process.exit(1);});
