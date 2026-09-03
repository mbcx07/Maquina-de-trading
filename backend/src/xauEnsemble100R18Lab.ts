import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

type Side='BUY'|'SELL';
type Agg={time:number;price:number;qty:number;buyerMaker:boolean};
type Bar={time:number;open:number;high:number;low:number;close:number;volume:number;buyVolume:number;sellVolume:number};
type Vote={id:string;family:string;side:Side|null};
type Stats={trades:number;wins:number;winRate:number;pf:number;returnPct:number;maxDdPct:number;expectancyPct:number;tradesPerDay:number;final50:number};

const SYMBOL='XAUUSDT';
const BASE=`https://data.binance.vision/data/futures/um/daily/aggTrades/${SYMBOL}`;
const DAY=86_400_000;
const DAYS=90;
const TF=30*60_000;
const COST_PCT=0.145;
const ACCOUNT_EXPOSURE=0.10; // 1% margin x10 leverage
const MIN_VOTES=5;
const MIN_FAMILIES=3;

function normEpoch(v:number){if(v>1e17)return Math.floor(v/1_000_000);if(v>1e14)return Math.floor(v/1000);return v;}
async function fetchDay(day:string,dir:string):Promise<Agg[]>{const fn=`${SYMBOL}-aggTrades-${day}.zip`,r=await fetch(`${BASE}/${fn}`);if(r.status===404)return[];if(!r.ok)throw new Error(`VISION_${r.status}:${day}`);const f=path.join(dir,fn);await writeFile(f,Buffer.from(await r.arrayBuffer()));const csv=execFileSync('unzip',['-p',f],{encoding:'utf8',maxBuffer:512*1024*1024});const out:Agg[]=[];for(const line of csv.split(/\r?\n/)){if(!line.trim())continue;const c=line.split(','),p=+c[1],q=+c[2],t=+c[5];if(Number.isFinite(p)&&Number.isFinite(q)&&Number.isFinite(t))out.push({time:normEpoch(t),price:p,qty:q,buyerMaker:String(c[6]).trim().toLowerCase()==='true'});}return out;}
function aggregate(rows:Agg[],ms:number):Bar[]{const m=new Map<number,Bar>();for(const x of rows){const k=Math.floor(x.time/ms)*ms;let b=m.get(k);if(!b){b={time:k,open:x.price,high:x.price,low:x.price,close:x.price,volume:0,buyVolume:0,sellVolume:0};m.set(k,b);}b.high=Math.max(b.high,x.price);b.low=Math.min(b.low,x.price);b.close=x.price;b.volume+=x.qty;if(x.buyerMaker)b.sellVolume+=x.qty;else b.buyVolume+=x.qty;}return [...m.values()].sort((a,b)=>a.time-b.time);}
function ema(v:number[],p:number){let x=v[0]??0,k=2/(p+1);const o:number[]=[];for(const y of v){x=o.length?y*k+x*(1-k):y;o.push(x);}return o;}
function smaAt(v:number[],i:number,p:number){if(i<p-1)return NaN;let s=0;for(let j=i-p+1;j<=i;j++)s+=v[j];return s/p;}
function stdAt(v:number[],i:number,p:number){const m=smaAt(v,i,p);if(!Number.isFinite(m))return NaN;let s=0;for(let j=i-p+1;j<=i;j++)s+=(v[j]-m)**2;return Math.sqrt(s/p);}
function rsiAt(v:number[],i:number,p:number){if(i<p)return 50;let g=0,l=0;for(let j=i-p+1;j<=i;j++){const d=v[j]-v[j-1];if(d>0)g+=d;else l-=d;}return l===0?100:100-100/(1+g/l);}
function atrAt(b:Bar[],i:number,p:number){if(i<p)return 0;let s=0;for(let j=i-p+1;j<=i;j++){const pc=b[j-1]?.close??b[j].open;s+=Math.max(b[j].high-b[j].low,Math.abs(b[j].high-pc),Math.abs(b[j].low-pc));}return s/p;}
function hi(b:Bar[],i:number,p:number){let x=-Infinity;for(let j=Math.max(0,i-p);j<i;j++)x=Math.max(x,b[j].high);return x;}
function lo(b:Bar[],i:number,p:number){let x=Infinity;for(let j=Math.max(0,i-p);j<i;j++)x=Math.min(x,b[j].low);return x;}
function roc(v:number[],i:number,p:number){return i>=p?(v[i]/v[i-p]-1)*100:0;}
function flow(b:Bar){const t=b.buyVolume+b.sellVolume;return t?(b.buyVolume-b.sellVolume)/t:0;}

function buildVotes(b:Bar[],i:number):Vote[]{
 const c=b.map(x=>x.close), e10=ema(c,10),e20=ema(c,20),e50=ema(c,50),e100=ema(c,100);const x=b[i],a=atrAt(b,i,14),votes:Vote[]=[];
 const add=(family:string,n:number,side:Side|null)=>votes.push({id:`${family}_${n}`,family,side});
 // 1 EMA trend 10
 for(let n=0;n<10;n++){const fast=[5,8,10,12,15,18,20,24,30,35][n],slow=[20,24,30,35,40,50,60,70,80,100][n];const ef=ema(c,fast)[i],es=ema(c,slow)[i];add('EMA_TREND',n,ef>es?'BUY':ef<es?'SELL':null);}
 // 2 SMA trend 10
 for(let n=0;n<10;n++){const p1=[5,8,10,12,15,20,24,30,36,40][n],p2=[20,24,30,40,50,60,72,80,100,120][n],s1=smaAt(c,i,p1),s2=smaAt(c,i,p2);add('SMA_TREND',n,s1>s2?'BUY':s1<s2?'SELL':null);}
 // 3 RSI momentum/reversion 10
 for(let n=0;n<10;n++){const p=[7,9,11,13,14,16,18,20,22,25][n],r=rsiAt(c,i,p);const mom=n<5;add('RSI',n,mom?(r>55?'BUY':r<45?'SELL':null):(r<30?'BUY':r>70?'SELL':null));}
 // 4 ROC momentum 10
 for(let n=0;n<10;n++){const p=[2,3,4,5,6,8,10,12,16,20][n],r=roc(c,i,p),th=[.05,.08,.1,.12,.15,.18,.2,.25,.3,.4][n];add('ROC',n,r>th?'BUY':r<-th?'SELL':null);}
 // 5 Donchian breakout 10
 for(let n=0;n<10;n++){const p=[4,6,8,10,12,16,20,24,32,40][n];add('DONCHIAN',n,x.close>hi(b,i,p)?'BUY':x.close<lo(b,i,p)?'SELL':null);}
 // 6 Bollinger mean reversion/trend 10
 for(let n=0;n<10;n++){const p=[10,12,14,16,18,20,24,28,32,40][n],m=smaAt(c,i,p),sd=stdAt(c,i,p),z=sd?(x.close-m)/sd:0;const trend=n<5;add('BOLLINGER',n,trend?(z>1?'BUY':z<-1?'SELL':null):(z<-1.7?'BUY':z>1.7?'SELL':null));}
 // 7 Pullback in trend 10
 for(let n=0;n<10;n++){const ref=n<5?e20[i]:e50[i],up=e20[i]>e50[i],dn=e20[i]<e50[i],tol=a*[.15,.2,.25,.3,.35,.2,.25,.3,.35,.4][n];const near=Math.abs(x.close-ref)<=tol;add('PULLBACK',n,near&&up?'BUY':near&&dn?'SELL':null);}
 // 8 Price action 10
 for(let n=0;n<10;n++){const body=Math.abs(x.close-x.open),rng=Math.max(1e-9,x.high-x.low),upW=x.high-Math.max(x.open,x.close),loW=Math.min(x.open,x.close)-x.low;let s:Side|null=null;if(n<5){if(x.close>x.open&&loW>body*(1.5+n*.25))s='BUY';else if(x.close<x.open&&upW>body*(1.5+n*.25))s='SELL';}else{const prev=b[i-1];if(prev){if(x.close>x.open&&prev.close<prev.open&&x.close>prev.open&&x.open<prev.close)s='BUY';else if(x.close<x.open&&prev.close>prev.open&&x.close<prev.open&&x.open>prev.close)s='SELL';}}add('PRICE_ACTION',n,s);}
 // 9 Volume/flow 10
 for(let n=0;n<10;n++){const f=flow(x),th=[.05,.08,.1,.12,.15,.18,.2,.22,.25,.3][n];add('FLOW',n,f>th?'BUY':f<-th?'SELL':null);}
 // 10 Volatility expansion / ATR 10
 for(let n=0;n<10;n++){const prevAtr=atrAt(b,i-1,14),exp=prevAtr? a/prevAtr:1,th=[1.0,1.02,1.04,1.06,1.08,1.1,1.12,1.15,1.18,1.2][n];const dir=x.close>x.open?'BUY':x.close<x.open?'SELL':null;add('ATR_EXPANSION',n,exp>=th?dir:null);}
 return votes;
}
function consensus(v:Vote[]){const buy=v.filter(x=>x.side==='BUY'),sell=v.filter(x=>x.side==='SELL');const fam=(xs:Vote[])=>new Set(xs.map(x=>x.family)).size;const bOk=buy.length>=MIN_VOTES&&fam(buy)>=MIN_FAMILIES,sOk=sell.length>=MIN_VOTES&&fam(sell)>=MIN_FAMILIES;if(bOk&&sOk)return buy.length>=sell.length?{side:'BUY' as Side,votes:buy.length,families:fam(buy)}:{side:'SELL' as Side,votes:sell.length,families:fam(sell)};if(bOk)return{side:'BUY' as Side,votes:buy.length,families:fam(buy)};if(sOk)return{side:'SELL' as Side,votes:sell.length,families:fam(sell)};return null;}
function run(b:Bar[],start:number,end:number):Stats{let eq=100,pk=100,dd=0,gp=0,gl=0,w=0,n=0,sum=0,next=start;for(let i=Math.max(start,130);i<Math.min(end-10,b.length-10);i++){if(i<next)continue;const con=consensus(buildVotes(b,i));if(!con)continue;const entry=b[i+1].open,a=atrAt(b,i,14);if(!(a>0))continue;const sl=con.side==='BUY'?entry-1.0*a:entry+1.0*a,tp=con.side==='BUY'?entry+2.0*a:entry-2.0*a;let exit=b[Math.min(end-1,i+9)].close,xi=Math.min(end-1,i+9);for(let j=i+1;j<=Math.min(end-1,i+9);j++){const x=b[j],hs=con.side==='BUY'?x.low<=sl:x.high>=sl,ht=con.side==='BUY'?x.high>=tp:x.low<=tp;if(hs){exit=sl;xi=j;break;}if(ht){exit=tp;xi=j;break;}}const gross=con.side==='BUY'?(exit-entry)/entry*100:(entry-exit)/entry*100,net=gross-COST_PCT,ar=net*ACCOUNT_EXPOSURE;eq*=1+ar/100;pk=Math.max(pk,eq);dd=Math.max(dd,(pk-eq)/pk*100);sum+=ar;n++;if(ar>0){w++;gp+=ar}else gl+=Math.abs(ar);next=xi+1;}const days=Math.max(1,(b[Math.min(end-1,b.length-1)].time-b[Math.max(start,0)].time)/DAY);return{trades:n,wins:w,winRate:n?w/n*100:0,pf:gl?gp/gl:gp?99:0,returnPct:eq-100,maxDdPct:dd,expectancyPct:n?sum/n:0,tradesPerDay:n/days,final50:50*eq/100};}
function pass(s:Stats,min:number){return s.trades>=min&&s.returnPct>0&&s.expectancyPct>0&&s.pf>1;}
async function main(){const end=Math.floor((Date.now()-2*DAY)/DAY)*DAY,start=end-DAYS*DAY,dir=await mkdtemp(path.join(os.tmpdir(),'xau100-'));const bars:Bar[]=[];for(let t=start;t<end;t+=DAY){const d=new Date(t).toISOString().slice(0,10),r=await fetchDay(d,dir),a=aggregate(r,TF);console.log('DAY',d,'aggTrades',r.length,'bars30m',a.length);bars.push(...a);}bars.sort((a,b)=>a.time-b.time);const n=bars.length,trEnd=Math.floor(n*.5),vaEnd=Math.floor(n*.75),tr=run(bars,0,trEnd),va=run(bars,trEnd,vaEnd),te=run(bars,vaEnd,n);console.log('ENSEMBLE100_RESULT',JSON.stringify({model:'100_STRATEGIES_CONFLUENCE_5_MIN3FAMILIES',strategies:100,minVotes:MIN_VOTES,minFamilies:MIN_FAMILIES,costPct:COST_PCT,train:tr,validation:va,test:te,survived:pass(tr,20)&&pass(va,8)&&pass(te,8)}));}
main().catch(e=>{console.error('ENSEMBLE100_ERROR',e instanceof Error?e.message:String(e));process.exit(1);});