import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

type Side='BUY'|'SELL';
type Agg={time:number;price:number;qty:number;maker:boolean};
type Bar={time:number;open:number;high:number;low:number;close:number;volume:number;buyVolume:number;sellVolume:number};
type Vote={family:string;side:Side};
type Cfg={holdMin:number;minVotes:number;minFamilies:number;lead:number;mom16Threshold:number};
type Stats={trades:number;winRate:number;pf:number;returnPct:number;ddPct:number;tradesPerDay:number;final50:number};
type Snap={buy:number;sell:number;buyFamilies:number;sellFamilies:number;atr:number;mom16:number};
type ConsensusCfg={minVotes:number;minFamilies:number;lead:number};
type Candidate={i:number;side:Side};

const SYMBOL='XAUUSDT',DAY=86400000,DAYS=56,COST=.145,EXPOSURE=.10;
const BASE=`https://data.binance.vision/data/futures/um/daily/aggTrades/${SYMBOL}`;
const FAMILY_BITS:Record<string,number>={EMA:1<<0,MOM:1<<1,BREAK:1<<2,RSI:1<<3,BOLL:1<<4,FLOW:1<<5,VOL:1<<6,CANDLE:1<<7,PULL:1<<8,VWAP:1<<9};

function norm(v:number){if(v>1e17)return Math.floor(v/1e6);if(v>1e14)return Math.floor(v/1e3);return v;}
async function fetchDay(d:string,dir:string){const fn=`${SYMBOL}-aggTrades-${d}.zip`,r=await fetch(`${BASE}/${fn}`);if(r.status===404)return[] as Agg[];if(!r.ok)throw new Error(`VISION_${r.status}:${d}`);const f=path.join(dir,fn);await writeFile(f,Buffer.from(await r.arrayBuffer()));const csv=execFileSync('unzip',['-p',f],{encoding:'utf8',maxBuffer:512*1024*1024});const out:Agg[]=[];for(const line of csv.split(/\r?\n/)){if(!line.trim())continue;const c=line.split(','),p=+c[1],q=+c[2],t=+c[5];if(Number.isFinite(p)&&Number.isFinite(q)&&Number.isFinite(t))out.push({time:norm(t),price:p,qty:q,maker:String(c[6]).trim().toLowerCase()==='true'});}return out;}
function agg(rows:Agg[],ms:number){const m=new Map<number,Bar>();for(const x of rows){const k=Math.floor(x.time/ms)*ms;let b=m.get(k);if(!b){b={time:k,open:x.price,high:x.price,low:x.price,close:x.price,volume:0,buyVolume:0,sellVolume:0};m.set(k,b);}b.high=Math.max(b.high,x.price);b.low=Math.min(b.low,x.price);b.close=x.price;b.volume+=x.qty;if(x.maker)b.sellVolume+=x.qty;else b.buyVolume+=x.qty;}return[...m.values()].sort((a,b)=>a.time-b.time);}
function ema(v:number[],p:number){let x=v[0]??0,k=2/(p+1);for(let i=1;i<v.length;i++)x=v[i]*k+x*(1-k);return x;}
function sma(v:number[],p:number){const a=v.slice(-p);return a.reduce((s,x)=>s+x,0)/Math.max(1,a.length);}
function sd(v:number[],p:number){const a=v.slice(-p),m=sma(a,p);return Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/Math.max(1,a.length));}
function rsi(v:number[],p:number){if(v.length<p+1)return 50;let g=0,l=0;for(let i=v.length-p;i<v.length;i++){const d=v[i]-v[i-1];if(d>0)g+=d;else l-=d;}return l?100-100/(1+g/l):100;}
function atr(b:Bar[],p:number){const a=b.slice(-p-1);let s=0,n=0;for(let i=1;i<a.length;i++){s+=Math.max(a[i].high-a[i].low,Math.abs(a[i].high-a[i-1].close),Math.abs(a[i].low-a[i-1].close));n++;}return n?s/n:0;}
function flow(b:Bar[],p:number){const a=b.slice(-p),bv=a.reduce((s,x)=>s+x.buyVolume,0),sv=a.reduce((s,x)=>s+x.sellVolume,0),t=bv+sv;return t?(bv-sv)/t:0;}
function roc(c:number[],p:number){const a=c.at(-1)!,z=c.at(-1-p)??a;return(z?a/z-1:0)*100;}
function popcount(x:number){let n=0;while(x){x&=x-1;n++;}return n;}

function votes30(b:Bar[]):Vote[]{const c=b.map(x=>x.close),x=b.at(-1)!,p=b.at(-2)!,out:Vote[]=[];const add=(f:string,s:Side|null)=>{if(s)out.push({family:f,side:s});};
 for(let n=0;n<10;n++){const ef=ema(c,3+n),es=ema(c,10+n*2);add('EMA',ef>es?'BUY':ef<es?'SELL':null)}
 for(let n=0;n<10;n++){const r=roc(c,2+n),th=.008+n*.004;add('MOM',r>th?'BUY':r<-th?'SELL':null)}
 for(let n=0;n<10;n++){const q=4+n,h=Math.max(...b.slice(-q-1,-1).map(z=>z.high)),l=Math.min(...b.slice(-q-1,-1).map(z=>z.low));add('BREAK',x.close>h?'BUY':x.close<l?'SELL':null)}
 for(let n=0;n<10;n++){const rv=rsi(c,6+n),u=53+n*.8,d=47-n*.8;add('RSI',rv>=u?'BUY':rv<=d?'SELL':null)}
 for(let n=0;n<10;n++){const q=10+n,m=sma(c,q),s=sd(c,q),z=s?(x.close-m)/s:0,t=.55+n*.1;add('BOLL',z>=t?'BUY':z<=-t?'SELL':null)}
 for(let n=0;n<10;n++){const f=flow(b,2+n),t=.05+n*.016;add('FLOW',f>=t?'BUY':f<=-t?'SELL':null)}
 for(let n=0;n<10;n++){const av=sma(b.slice(0,-1).map(y=>y.volume),5+n),r=av?x.volume/av:0,t=1.05+n*.1;add('VOL',r>=t?(x.close>x.open?'BUY':x.close<x.open?'SELL':null):null)}
 for(let n=0;n<10;n++){const range=Math.max(1e-9,x.high-x.low),body=Math.abs(x.close-x.open)/range,t=.35+n*.04;add('CANDLE',body>=t&&x.close>p.close?'BUY':body>=t&&x.close<p.close?'SELL':null)}
 for(let n=0;n<10;n++){const e20=ema(c,20),e50=ema(c,50),a=atr(b,14),tol=a*(.15+n*.03);add('PULL',Math.abs(x.close-e20)<=tol?(e20>e50?'BUY':e20<e50?'SELL':null):null)}
 for(let n=0;n<10;n++){const q=10+n*2,a=b.slice(-q),den=a.reduce((s,y)=>s+Math.max(y.volume,1e-9),0),vw=a.reduce((s,y)=>s+y.close*Math.max(y.volume,1e-9),0)/den,pc=(x.close/vw-1)*100,t=.006+n*.003;add('VWAP',pc>=t?'BUY':pc<=-t?'SELL':null)}
 return out;}

function buildSnapshots(b30:Bar[]):Snap[]{const out:Array<Snap>=new Array(b30.length);for(let i=0;i<b30.length;i++){if(i<200){out[i]={buy:0,sell:0,buyFamilies:0,sellFamilies:0,atr:0,mom16:0};continue;}const win=b30.slice(Math.max(0,i-180),i+1),vs=votes30(win);let buy=0,sell=0,bf=0,sf=0;for(const v of vs){if(v.side==='BUY'){buy++;bf|=FAMILY_BITS[v.family]||0}else{sell++;sf|=FAMILY_BITS[v.family]||0}}const a=atr(b30.slice(Math.max(0,i-60),i+1),14);const j=i-16*120,mom16=j>=0&&b30[j].close?(b30[i].close/b30[j].close-1)*100:0;out[i]={buy,sell,buyFamilies:popcount(bf),sellFamilies:popcount(sf),atr:a,mom16};if(i%10000===0)console.log('SNAP',i,'/',b30.length);}return out;}

function consensusCandidates(snaps:Snap[],c:ConsensusCfg,start:number,end:number,useTsmom:boolean,momThreshold:number):Candidate[]{const out:Candidate[]=[];for(let i=Math.max(start,2000);i<end;i++){const s=snaps[i];let side:Side|null=null,cand=0,opp=0,fams=0;if(useTsmom){if(s.mom16>=momThreshold){side='BUY';cand=s.buy;opp=s.sell;fams=s.buyFamilies}else if(s.mom16<=-momThreshold){side='SELL';cand=s.sell;opp=s.buy;fams=s.sellFamilies}else continue;}else{if(s.buy>s.sell){side='BUY';cand=s.buy;opp=s.sell;fams=s.buyFamilies}else if(s.sell>s.buy){side='SELL';cand=s.sell;opp=s.buy;fams=s.sellFamilies}else continue;}if(cand>=c.minVotes&&fams>=c.minFamilies&&cand>=opp*c.lead)out.push({i,side});}return out;}

function simulate(b30:Bar[],snaps:Snap[],cands:Candidate[],holdMin:number,start:number,end:number):Stats{let eq=100,pk=100,dd=0,gp=0,gl=0,n=0,w=0,next=start;const holdBars=holdMin*2;for(const z of cands){const i=z.i;if(i<start||i>=end-holdBars-2||i<next)continue;const side=z.side,entry=b30[i+1].open,a=snaps[i].atr;if(!(a>0))continue;const target=Math.max(COST*2.8,a/entry*100*8),stop=Math.max(COST*1.25,target*.55),tp=side==='BUY'?entry*(1+target/100):entry*(1-target/100),sl=side==='BUY'?entry*(1-stop/100):entry*(1+stop/100);let exit=b30[i+holdBars].close,xi=i+holdBars;for(let j=i+1;j<=i+holdBars;j++){const y=b30[j],hs=side==='BUY'?y.low<=sl:y.high>=sl,ht=side==='BUY'?y.high>=tp:y.low<=tp;if(hs){exit=sl;xi=j;break}if(ht){exit=tp;xi=j;break}}const gross=(side==='BUY'?(exit/entry-1):(entry/exit-1))*100,net=gross-COST,ar=net*EXPOSURE;eq*=1+ar/100;pk=Math.max(pk,eq);dd=Math.max(dd,(pk-eq)/pk*100);n++;if(ar>0){w++;gp+=ar}else gl+=Math.abs(ar);next=xi+2;}const days=Math.max(1,(b30[Math.min(end-1,b30.length-1)].time-b30[Math.max(start,0)].time)/DAY);return{trades:n,winRate:n?w/n*100:0,pf:gl?gp/gl:gp?99:0,returnPct:eq-100,ddPct:dd,tradesPerDay:n/days,final50:eq/2};}
function score(s:Stats){if(s.trades<12)return-999;return s.returnPct-s.ddPct*.35+(s.pf-1)*2+Math.min(2,s.tradesPerDay*.035)}

async function main(){const end=Math.floor((Date.now()-2*DAY)/DAY)*DAY,start=end-DAYS*DAY,dir=await mkdtemp(path.join(os.tmpdir(),'r22fast-')),b30:Bar[]=[];for(let t=start;t<end;t+=DAY){const d=new Date(t).toISOString().slice(0,10),r=await fetchDay(d,dir),a=agg(r,30000);console.log('DAY',d,r.length,a.length);b30.push(...a)}b30.sort((a,b)=>a.time-b.time);const N=b30.length,t1=Math.floor(N*.5),t2=Math.floor(N*.75);console.log('PRECOMPUTE_START',N);const snaps=buildSnapshots(b30);console.log('PRECOMPUTE_DONE');
 const consensusCfgs:ConsensusCfg[]=[];for(const minVotes of [5,10,15,20,25])for(const minFamilies of [2,3,4,5])for(const lead of [1.0,1.1,1.2,1.35])consensusCfgs.push({minVotes,minFamilies,lead});
 const holds=[15,30,60,120],moms=[.3,.5,.6,.8,1.0,1.2];let rows:Array<{c:Cfg;tr:Stats;va:Stats;s:number}>=[];
 for(const cc of consensusCfgs){for(const mt of moms){const allT=consensusCandidates(snaps,cc,0,N,true,mt);for(const holdMin of holds){const c:Cfg={...cc,holdMin,mom16Threshold:mt},tr=simulate(b30,snaps,allT,holdMin,0,t1),va=simulate(b30,snaps,allT,holdMin,t1,t2);rows.push({c,tr,va,s:score(tr)+score(va)*1.5});}}}
 rows.sort((a,b)=>b.s-a.s);console.log('R22_TOP10',JSON.stringify(rows.slice(0,10)));const best=rows[0],bestCC={minVotes:best.c.minVotes,minFamilies:best.c.minFamilies,lead:best.c.lead},bestT=consensusCandidates(snaps,bestCC,0,N,true,best.c.mom16Threshold),test=simulate(b30,snaps,bestT,best.c.holdMin,t2,N),pureC=consensusCandidates(snaps,bestCC,0,N,false,0),pureTrain=simulate(b30,snaps,pureC,best.c.holdMin,0,t1),pureVal=simulate(b30,snaps,pureC,best.c.holdMin,t1,t2),pureTest=simulate(b30,snaps,pureC,best.c.holdMin,t2,N);
 console.log('R22_RESULT',JSON.stringify({symbol:SYMBOL,days:DAYS,bars30s:N,costPct:COST,risk:{initial:50,marginPct:1,leverage:10},architecture:'PURE_30S_SCALPER_PLUS_TSMOM16_ONLY_NO_HTF_ALIGNMENT_FAST',config:best.c,withTsmom:{train:best.tr,validation:best.va,test,survived:best.tr.returnPct>0&&best.va.returnPct>0&&test.returnPct>0&&best.va.pf>1&&test.pf>1},pureScalperSameConfig:{train:pureTrain,validation:pureVal,test:pureTest}}));}
main().catch(e=>{console.error('R22_ERROR',e instanceof Error?e.message:String(e));process.exit(1)});