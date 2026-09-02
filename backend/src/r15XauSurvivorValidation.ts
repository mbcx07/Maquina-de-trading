import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Candle } from './analysis.js';

const DAY=86400000, M15=900000, H4=14400000;
const DATA='https://data.binance.vision/data/futures/um/monthly/klines';
const INITIAL=50, LEVERAGE=10, MARGIN=0.01;
const COST={fee:.05,spread:.025,slip:.01,funding8h:.005};
type Side=1|-1;
type P={lookback:number;threshold:number;hold:number;vol:number};
type F=Candle&{atrPct:number;h4e20:number;h4e50:number};
type Trade={side:Side;r:number;pnl:number};
type Metrics={trades:number;wins:number;wr:number;pf:number;ret:number;dd:number;balance:number;buy:number;sell:number};
const MODEL:P={lookback:64,threshold:1,hold:64,vol:1};

async function main(){
 const endDay=Math.floor((Date.now()-DAY)/DAY)*DAY,end=endDay+DAY-1,start=end-240*DAY;
 const dir=await mkdtemp(path.join(os.tmpdir(),'xau-survivor-'));
 const m1=await load('XAUUSDT',start,end,dir),m15=agg(m1,M15),h4=agg(m1,H4),f=feat(m15,h4);
 if(f.length<10000)throw new Error(`SHORT:${f.length}`);
 const base=sim(f,500,f.length-2,MODEL,1);
 console.log('R15_SURVIVOR_BASE',JSON.stringify({model:MODEL,from:new Date(f[0].time).toISOString(),to:new Date(f.at(-1)!.time).toISOString(),metrics:fmt(base.m),cost:COST}));
 for(const k of [1,1.25,1.5,2])console.log('R15_SURVIVOR_COST',JSON.stringify({mult:k,metrics:fmt(sim(f,500,f.length-2,MODEL,k).m)}));
 const windows:any[]=[];
 for(let s=f[0].time;s<f.at(-1)!.time;s+=30*DAY){const e=s+30*DAY,a=Math.max(500,lb(f,s)),b=Math.min(f.length-2,lb(f,e)-1);if(b<=a)continue;windows.push({from:new Date(s).toISOString().slice(0,10),...fmt(sim(f,a,b,MODEL,1).m)});}
 console.log('R15_SURVIVOR_WINDOWS',JSON.stringify({positive:windows.filter(x=>x.ret>0).length,total:windows.length,windows}));
 const split=lb(f,f[0].time+(f.at(-1)!.time-f[0].time)*.75),near:any[]=[];
 for(const lookback of [56,64,72])for(const threshold of [.8,1,1.2])for(const hold of [56,64,72])for(const vol of [.9,1,1.1]){const p={lookback,threshold,hold,vol};near.push({p,full:fmt(sim(f,500,f.length-2,p,1).m),test:fmt(sim(f,split,f.length-2,p,1).m)});}
 const fullGood=near.filter(x=>x.full.ret>0&&x.full.pf>1).length,testGood=near.filter(x=>x.test.trades>=10&&x.test.ret>0&&x.test.pf>1).length;
 console.log('R15_SURVIVOR_SENSITIVITY',JSON.stringify({variants:near.length,fullGood,testGood,fullPct:pct(fullGood,near.length),testPct:pct(testGood,near.length),base:near.find(x=>x.p.lookback===64&&x.p.threshold===1&&x.p.hold===64&&x.p.vol===1)}));
 console.log('R15_SURVIVOR_SIDES',JSON.stringify({buy:stats(base.t.filter(x=>x.side===1)),sell:stats(base.t.filter(x=>x.side===-1))}));
 const mc=bootstrap(base.t.map(x=>x.r),10000);console.log('R15_SURVIVOR_MC',JSON.stringify(mc));
 const stressed=sim(f,500,f.length-2,MODEL,1.5).m;
 const pass=base.m.ret>0&&base.m.pf>=1.1&&stressed.ret>=0&&testGood/near.length>=.5&&Number(mc.lossPct)<35;
 console.log(pass?'R15_SURVIVOR_ROBUST_PASS':'R15_SURVIVOR_ROBUST_FAIL',JSON.stringify({pass}));
}

function sim(f:F[],start:number,end:number,p:P,k:number):{m:Metrics;t:Trade[]}{
 let bal=INITIAL,peak=INITIAL,dd=0,w=0,gp=0,gl=0,n=0,buy=0,sell=0,i=Math.max(start,500,p.lookback+5);const t:Trade[]=[];
 while(i<end-2&&bal>1){const b=f[i],av=mean(f.slice(Math.max(0,i-100),i).map(x=>x.atrPct));if(!(av>0)||b.atrPct<av*p.vol){i++;continue;}const mom=(b.close-f[i-p.lookback].close)/f[i-p.lookback].close*100;if(Math.abs(mom)<p.threshold){i++;continue;}const side:Side=mom>0?1:-1;if(side===1?b.h4e20<b.h4e50:b.h4e20>b.h4e50){i++;continue;}const e=i+1,x=Math.min(end,e+p.hold),entry=f[e].open*(1+side*(COST.spread/2+COST.slip)*k/100),exit=f[x].close*(1-side*(COST.spread/2+COST.slip)*k/100),notional=bal*MARGIN*LEVERAGE,qty=notional/entry,fees=(notional+qty*exit)*COST.fee*k/100,held=(x-e+1)*.25,funding=notional*COST.funding8h*k/100*Math.floor(held/8),gross=side===1?(exit-entry)*qty:(entry-exit)*qty,pnl=gross-fees-funding,before=bal;bal+=pnl;n++;if(side===1)buy++;else sell++;if(pnl>0){w++;gp+=pnl}else gl+=Math.abs(pnl);peak=Math.max(peak,bal);dd=Math.max(dd,(peak-bal)/peak*100);t.push({side,r:pnl/before*100,pnl});i=x+1;}
 return{m:{trades:n,wins:w,wr:n?w/n*100:0,pf:gl?gp/gl:gp?99:0,ret:(bal-INITIAL)/INITIAL*100,dd,balance:bal,buy,sell},t};
}
function bootstrap(r:number[],runs:number){const rnd=lcg(340015),rets:number[]=[],dds:number[]=[];let loss=0;for(let z=0;z<runs;z++){let eq=INITIAL,pk=INITIAL,dd=0;for(let i=0;i<r.length;i++){eq*=1+r[Math.floor(rnd()*r.length)]/100;pk=Math.max(pk,eq);dd=Math.max(dd,(pk-eq)/pk*100);}const rr=(eq-INITIAL)/INITIAL*100;rets.push(rr);dds.push(dd);if(rr<0)loss++;}rets.sort((a,b)=>a-b);dds.sort((a,b)=>a-b);return{runs,n:r.length,lossPct:pct(loss,runs),retP05:rndq(rets,.05),retMedian:rndq(rets,.5),retP95:rndq(rets,.95),ddP50:rndq(dds,.5),ddP95:rndq(dds,.95)};}
function stats(t:Trade[]){const gp=t.filter(x=>x.pnl>0).reduce((s,x)=>s+x.pnl,0),gl=t.filter(x=>x.pnl<=0).reduce((s,x)=>s+Math.abs(x.pnl),0);return{trades:t.length,wr:pct(t.filter(x=>x.pnl>0).length,t.length),pf:Number((gl?gp/gl:gp?99:0).toFixed(3)),meanR:Number(mean(t.map(x=>x.r)).toFixed(4))};}
function fmt(m:Metrics){return{trades:m.trades,wr:Number(m.wr.toFixed(2)),pf:Number(m.pf.toFixed(3)),ret:Number(m.ret.toFixed(3)),dd:Number(m.dd.toFixed(3)),balance:Number(m.balance.toFixed(4)),buy:m.buy,sell:m.sell};}
function pct(a:number,b:number){return b?Number((a/b*100).toFixed(2)):0}function rndq(a:number[],p:number){return Number((a[Math.floor((a.length-1)*p)]??0).toFixed(3));}function lcg(s:number){let x=s>>>0;return()=>{x=(1664525*x+1013904223)>>>0;return x/4294967296};}
function feat(m:Candle[],h:Candle[]):F[]{const a=atr(m,14),hc=h.map(x=>x.close),e20=ema(hc,20),e50=ema(hc,50);let j=0;return m.map((x,i)=>{while(j+1<h.length&&h[j+1].time+H4<=x.time+M15)j++;return{...x,atrPct:a[i]/x.close*100,h4e20:e20[j]??0,h4e50:e50[j]??0};});}
function lb(a:F[],t:number){let l=0,r=a.length;while(l<r){const m=(l+r)>>1;if(a[m].time<t)l=m+1;else r=m;}return l;}function agg(r:Candle[],b:number){const m=new Map<number,Candle>();for(const x of r){const t=Math.floor(x.time/b)*b,y=m.get(t);if(!y)m.set(t,{...x,time:t});else{y.high=Math.max(y.high,x.high);y.low=Math.min(y.low,x.low);y.close=x.close;y.volume+=x.volume;}}return[...m.values()].sort((a,b)=>a.time-b.time);}function ema(v:number[],p:number){const o=new Array(v.length).fill(0),q=2/(p+1);if(!v.length)return o;o[0]=v[0];for(let i=1;i<v.length;i++)o[i]=v[i]*q+o[i-1]*(1-q);return o;}function atr(r:Candle[],p:number){const o=new Array(r.length).fill(0);if(!r.length)return o;o[0]=r[0].high-r[0].low;for(let i=1;i<r.length;i++){const tr=Math.max(r[i].high-r[i].low,Math.abs(r[i].high-r[i-1].close),Math.abs(r[i].low-r[i-1].close));o[i]=i<p?(o[i-1]*i+tr)/(i+1):(o[i-1]*(p-1)+tr)/p;}return o;}function mean(v:number[]){return v.length?v.reduce((a,b)=>a+b,0)/v.length:0;}
function months(s:number,e:number){const a:string[]=[];let d=new Date(Date.UTC(new Date(s).getUTCFullYear(),new Date(s).getUTCMonth(),1)),z=new Date(Date.UTC(new Date(e).getUTCFullYear(),new Date(e).getUTCMonth(),1));while(d<=z){a.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`);d=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1));}return a;}
async function load(sym:string,s:number,e:number,dir:string){const out:Candle[]=[];for(const mo of months(s,e)){const fn=`${sym}-1m-${mo}.zip`,res=await fetch(`${DATA}/${sym}/1m/${fn}`);if(res.status===404)continue;if(!res.ok)throw new Error(`DATA_${res.status}`);const file=path.join(dir,fn);await writeFile(file,Buffer.from(await res.arrayBuffer()));const csv=execFileSync('unzip',['-p',file],{encoding:'utf8',maxBuffer:256*1024*1024});for(const line of csv.split(/\r?\n/)){if(!line)continue;const a=line.split(','),raw=Number(a[0]);if(!Number.isFinite(raw))continue;const time=raw>1e17?Math.floor(raw/1e6):raw>1e14?Math.floor(raw/1e3):raw,x:Candle={time,open:Number(a[1]),high:Number(a[2]),low:Number(a[3]),close:Number(a[4]),volume:Number(a[5]??0)};if(time>=s&&time<=e&&x.close>0)out.push(x);}}const map=new Map(out.map(x=>[x.time,x]));return[...map.values()].sort((a,b)=>a.time-b.time);}
main().catch(e=>{console.error('R15_SURVIVOR_ERROR',e instanceof Error?e.message:String(e));process.exit(1);});
