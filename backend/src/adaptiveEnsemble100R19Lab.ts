import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

type Side='BUY'|'SELL';
type Agg={time:number;price:number;qty:number;maker:boolean};
type Bar={time:number;open:number;high:number;low:number;close:number;volume:number;buyVolume:number;sellVolume:number};
type Vote={id:string;family:string;side:Side};
type State={n:number;win:number;emaEdge:number;emaHit:number};
type Cfg={alpha:number;minSamples:number;minActive:number;minFamilies:number;minWeight:number;leadRatio:number;cooldown:number};
type Stats={trades:number;wins:number;winRate:number;pf:number;returnPct:number;ddPct:number;tradesPerDay:number;final50:number;avgActive:number;avgWeightLead:number};
const SYMBOL='XAUUSDT',DAY=86400000,DAYS=14,H=6,COST=.145,EXPOSURE=.10;
const BASE=`https://data.binance.vision/data/futures/um/daily/aggTrades/${SYMBOL}`;
function norm(v:number){if(v>1e17)return Math.floor(v/1e6);if(v>1e14)return Math.floor(v/1e3);return v;}
async function fetchDay(d:string,dir:string){const fn=`${SYMBOL}-aggTrades-${d}.zip`,r=await fetch(`${BASE}/${fn}`);if(r.status===404)return[] as Agg[];if(!r.ok)throw new Error(`VISION_${r.status}:${d}`);const f=path.join(dir,fn);await writeFile(f,Buffer.from(await r.arrayBuffer()));const csv=execFileSync('unzip',['-p',f],{encoding:'utf8',maxBuffer:512*1024*1024});const out:Agg[]=[];for(const line of csv.split(/\r?\n/)){if(!line.trim())continue;const c=line.split(','),p=+c[1],q=+c[2],t=+c[5];if(Number.isFinite(p)&&Number.isFinite(q)&&Number.isFinite(t))out.push({time:norm(t),price:p,qty:q,maker:String(c[6]).trim().toLowerCase()==='true'});}return out;}
function agg(rows:Agg[],ms:number){const m=new Map<number,Bar>();for(const x of rows){const k=Math.floor(x.time/ms)*ms;let b=m.get(k);if(!b){b={time:k,open:x.price,high:x.price,low:x.price,close:x.price,volume:0,buyVolume:0,sellVolume:0};m.set(k,b);}b.high=Math.max(b.high,x.price);b.low=Math.min(b.low,x.price);b.close=x.price;b.volume+=x.qty;if(x.maker)b.sellVolume+=x.qty;else b.buyVolume+=x.qty;}return[...m.values()].sort((a,b)=>a.time-b.time);}
function ema(v:number[],p:number){let x=v[0]??0,k=2/(p+1);for(let i=1;i<v.length;i++)x=v[i]*k+x*(1-k);return x;}
function sma(v:number[],p:number){const a=v.slice(-p);return a.reduce((s,x)=>s+x,0)/Math.max(1,a.length);}
function sd(v:number[],p:number){const a=v.slice(-p),m=sma(a,p);return Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/Math.max(1,a.length));}
function rsi(v:number[],p:number){if(v.length<p+1)return 50;let g=0,l=0;for(let i=v.length-p;i<v.length;i++){const d=v[i]-v[i-1];if(d>0)g+=d;else l-=d;}return l?100-100/(1+g/l):100;}
function atr(b:Bar[],p:number){const a=b.slice(-p-1);let s=0,n=0;for(let i=1;i<a.length;i++){s+=Math.max(a[i].high-a[i].low,Math.abs(a[i].high-a[i-1].close),Math.abs(a[i].low-a[i-1].close));n++;}return n?s/n:0;}
function hi(b:Bar[],p:number){return Math.max(...b.slice(-p-1,-1).map(x=>x.high));}function lo(b:Bar[],p:number){return Math.min(...b.slice(-p-1,-1).map(x=>x.low));}
function roc(c:number[],p:number){const a=c.at(-1)!,z=c.at(-1-p)??a;return(z? a/z-1:0)*100;}
function flow(b:Bar[],p:number){const a=b.slice(-p),bv=a.reduce((s,x)=>s+x.buyVolume,0),sv=a.reduce((s,x)=>s+x.sellVolume,0),t=bv+sv;return t?(bv-sv)/t:0;}
function votes(b:Bar[]):Vote[]{const c=b.map(x=>x.close),x=b.at(-1)!,out:Vote[]=[];const add=(f:string,n:number,s:Side|null)=>{if(s)out.push({id:`${f}_${n}`,family:f,side:s});};
 for(let n=0;n<10;n++){const fast=3+n,slow=10+n*2,ef=ema(c,fast),es=ema(c,slow);add('EMA',n,ef>es?'BUY':ef<es?'SELL':null);}
 for(let n=0;n<10;n++){const p=2+n,r=roc(c,p),th=.008+n*.004;add('MOM',n,r>th?'BUY':r<-th?'SELL':null);}
 for(let n=0;n<10;n++){const p=4+n;add('BREAK',n,x.close>hi(b,p)?'BUY':x.close<lo(b,p)?'SELL':null);}
 const e20=ema(c,20),e50=ema(c,50),a=atr(b,14);for(let n=0;n<10;n++){const tol=a*(.15+n*.03),near=Math.abs(x.close-e20)<=tol;add('PULL',n,near&&e20>e50?'BUY':near&&e20<e50?'SELL':null);}
 for(let n=0;n<10;n++){const p=6+n,rv=rsi(c,p),u=53+n*.8,d=47-n*.8;add('RSI',n,rv>=u?'BUY':rv<=d?'SELL':null);}
 for(let n=0;n<10;n++){const p=10+n,m=sma(c,p),s=sd(c,p),z=s?(x.close-m)/s:0,th=.55+n*.1;add('BOLL',n,z>=th?'BUY':z<=-th?'SELL':null);}
 for(let n=0;n<10;n++){const p=10+n*2,a2=b.slice(-p),den=a2.reduce((s,y)=>s+Math.max(y.volume,1e-9),0),vw=a2.reduce((s,y)=>s+y.close*Math.max(y.volume,1e-9),0)/den,pc=(x.close/vw-1)*100,th=.006+n*.003;add('VWAP',n,pc>=th?'BUY':pc<=-th?'SELL':null);}
 for(let n=0;n<10;n++){const f=flow(b,2+n),th=.05+n*.016;add('FLOW',n,f>=th?'BUY':f<=-th?'SELL':null);}
 for(let n=0;n<10;n++){const p=5+n,av=sma(b.slice(0,-1).map(y=>y.volume),p),ratio=av?x.volume/av:0,th=1.05+n*.1;add('VOL',n,ratio>=th?(x.close>x.open?'BUY':x.close<x.open?'SELL':null):null);}
 const p=b.at(-2)!;for(let n=0;n<10;n++){const range=Math.max(1e-9,x.high-x.low),body=Math.abs(x.close-x.open)/range,th=.35+n*.04;add('CANDLE',n,body>=th&&x.close>p.close?'BUY':body>=th&&x.close<p.close?'SELL':null);}
 return out;}
function weight(s:State,c:Cfg){if(s.n<c.minSamples)return 0;const hitEdge=Math.max(0,(s.emaHit-.5)*2);const edge=Math.max(0,s.emaEdge/COST);return Math.min(3,hitEdge*1.5+edge*.8);}
function run(b:Bar[],cfg:Cfg,start:number,end:number,tradeStart:number):Stats{const st=new Map<string,State>(),pending:Array<{due:number;price:number;votes:Vote[]}|undefined>=[];let eq=100,pk=100,dd=0,gp=0,gl=0,n=0,w=0,next=start,actSum=0,leadSum=0;
 for(let i=Math.max(start,130);i<Math.min(end-H-1,b.length-H-1);i++){
   const due=pending[i];if(due){const ret=(b[i].close/due.price-1)*100;for(const v of due.votes){const signed=v.side==='BUY'?ret:-ret,net=signed-COST;const s=st.get(v.id)??{n:0,win:0,emaEdge:0,emaHit:.5};s.n++;if(net>0)s.win++;s.emaEdge=s.n===1?net:cfg.alpha*net+(1-cfg.alpha)*s.emaEdge;const hit=net>0?1:0;s.emaHit=s.n===1?hit:cfg.alpha*hit+(1-cfg.alpha)*s.emaHit;st.set(v.id,s);}}
   const vs=votes(b.slice(0,i+1));pending[i+H]={due:i+H,price:b[i].close,votes:vs};if(i<tradeStart||i<next)continue;
   let bw=0,sw=0,bc=0,sc=0;const bf=new Set<string>(),sf=new Set<string>();for(const v of vs){const wt=weight(st.get(v.id)??{n:0,win:0,emaEdge:0,emaHit:.5},cfg);if(wt<=0)continue;if(v.side==='BUY'){bw+=wt;bc++;bf.add(v.family)}else{sw+=wt;sc++;sf.add(v.family)}}
   const total=bw+sw,side:Side|null=bw>=cfg.minWeight&&bc>=cfg.minActive&&bf.size>=cfg.minFamilies&&bw>=sw*cfg.leadRatio?'BUY':sw>=cfg.minWeight&&sc>=cfg.minActive&&sf.size>=cfg.minFamilies&&sw>=bw*cfg.leadRatio?'SELL':null;if(!side)continue;actSum+=side==='BUY'?bc:sc;leadSum+=(Math.max(bw,sw)+1e-9)/(Math.min(bw,sw)+1e-9);
   const entry=b[i+1].open,a=atr(b.slice(0,i+1),14);if(!(a>0))continue;const target=Math.max(COST*2.8,a/entry*100*2.2),stop=Math.max(COST*1.25,target*.48);const tp=side==='BUY'?entry*(1+target/100):entry*(1-target/100),sl=side==='BUY'?entry*(1-stop/100):entry*(1+stop/100);let exit=b[Math.min(i+H,end-1)].close,xi=Math.min(i+H,end-1);for(let j=i+1;j<=Math.min(i+H,end-1);j++){const y=b[j],hs=side==='BUY'?y.low<=sl:y.high>=sl,ht=side==='BUY'?y.high>=tp:y.low<=tp;if(hs){exit=sl;xi=j;break}if(ht){exit=tp;xi=j;break}}
   const gross=(side==='BUY'?(exit/entry-1):(entry/exit-1))*100,net=gross-COST,ar=net*EXPOSURE;eq*=1+ar/100;pk=Math.max(pk,eq);dd=Math.max(dd,(pk-eq)/pk*100);n++;if(ar>0){w++;gp+=ar}else gl+=Math.abs(ar);next=xi+cfg.cooldown;
 }
 const days=Math.max(1,(b[Math.min(end-1,b.length-1)].time-b[Math.max(tradeStart,0)].time)/DAY);return{trades:n,wins:w,winRate:n?w/n*100:0,pf:gl?gp/gl:gp?99:0,returnPct:eq-100,ddPct:dd,tradesPerDay:n/days,final50:eq/2,avgActive:n?actSum/n:0,avgWeightLead:n?leadSum/n:0};}
function score(s:Stats){if(s.trades<10)return-999;return s.returnPct-s.ddPct*.35+Math.min(3,s.tradesPerDay*.05)+(s.pf-1)*2;}
async function main(){const end=Math.floor((Date.now()-2*DAY)/DAY)*DAY,start=end-DAYS*DAY,dir=await mkdtemp(path.join(os.tmpdir(),'r19-')),bars:Bar[]=[];for(let t=start;t<end;t+=DAY){const d=new Date(t).toISOString().slice(0,10),r=await fetchDay(d,dir),a=agg(r,30000);console.log('DAY',d,r.length,a.length);bars.push(...a)}bars.sort((a,b)=>a.time-b.time);const N=bars.length,t1=Math.floor(N*.5),t2=Math.floor(N*.75);const cfgs:Cfg[]=[];for(const alpha of [.03,.06,.1])for(const minSamples of [20,40])for(const minWeight of [3,5,8])cfgs.push({alpha,minSamples,minActive:5,minFamilies:3,minWeight,leadRatio:1.35,cooldown:2});const rows=cfgs.map(c=>{const tr=run(bars,c,0,t1,Math.floor(t1*.35)),va=run(bars,c,0,t2,t1);return{c,tr,va,s:score(tr)+score(va)*1.5}}).sort((a,b)=>b.s-a.s);console.log('R19_TOP5',JSON.stringify(rows.slice(0,5)));const best=rows[0];const test=run(bars,best.c,0,N,t2);console.log('R19_ADAPTIVE_RESULT',JSON.stringify({symbol:SYMBOL,days:DAYS,bars30s:N,costPct:COST,risk:{initial:50,marginPct:1,leverage:10},config:best.c,train:best.tr,validation:best.va,test,survived:best.tr.returnPct>0&&best.va.returnPct>0&&test.returnPct>0&&best.va.pf>1&&test.pf>1}));}
main().catch(e=>{console.error('R19_ERROR',e instanceof Error?e.message:String(e));process.exit(1)});