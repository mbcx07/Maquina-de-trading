import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Candle } from './analysis.js';

const DAY=86_400_000,MIN=60_000,FIVE=5*MIN;
const VISION='https://data.binance.vision/data/futures/um/monthly/klines';
const LOOKBACK_DAYS=240;
const ROUND_TRIP_COST_PCT=0.05*2+0.025+0.01*2;
type Side=1|-1;
type Session='ALL'|'LONDON'|'NY'|'OVERLAP';
interface F extends Candle{ema20:number;ema50:number;ema200:number;rsi:number;atr:number;atrPct:number;volAvg:number;mom3:number;mom6:number;mom12:number;mom24:number;}
interface Rule{name:string;session:Session;horizon:number;side:(f:F[],i:number)=>Side|null;}
interface M{n:number;winRate:number;meanNet:number;medianNet:number;t:number;grossMean:number;}
interface Row{rule:Rule;train:M;validation:M;test:M;score:number;}

async function main(){const endDay=Math.floor((Date.now()-DAY)/DAY)*DAY,end=endDay+DAY-1,start=end-LOOKBACK_DAYS*DAY,dir=await mkdtemp(path.join(os.tmpdir(),'r15-edge-')),m1=await fetchVision('XAUUSDT',start,end,dir);if(m1.length<120*1440)throw new Error(`EDGE_HISTORY_SHORT:${m1.length}`);const bars=features(aggregate(m1,FIVE)),first=bars[0].time,last=bars.at(-1)!.time,span=last-first,s1=first+span*.5,s2=first+span*.75,i1=bars.findIndex(x=>x.time>=s1),i2=bars.findIndex(x=>x.time>=s2),rules=buildRules(),rows:Row[]=[];
for(const rule of rules){const train=evaluate(bars,220,i1-1,rule),validation=evaluate(bars,i1,i2-1,rule),test=evaluate(bars,i2,bars.length-50,rule);if(train.n<20)continue;const score=train.meanNet*Math.sqrt(train.n)+Math.min(3,Math.max(-3,train.t));rows.push({rule,train,validation,test,score});}
rows.sort((a,b)=>b.score-a.score);const persistent=rows.filter(r=>r.train.n>=20&&r.train.meanNet>0&&r.train.t>0.7&&r.validation.n>=8&&r.validation.meanNet>0&&r.test.n>=8&&r.test.meanNet>0).sort((a,b)=>(b.test.meanNet+b.validation.meanNet)-(a.test.meanNet+a.validation.meanNet));
console.log('R15_EDGE_META',JSON.stringify({m1:m1.length,m5:bars.length,from:new Date(first).toISOString(),to:new Date(last).toISOString(),days:Number((span/DAY).toFixed(2)),rules:rules.length,costPct:ROUND_TRIP_COST_PCT,persistent:persistent.length}));for(const [i,r] of rows.slice(0,20).entries())console.log('R15_EDGE_TOP',JSON.stringify({rank:i+1,name:r.rule.name,session:r.rule.session,horizonMin:r.rule.horizon*5,train:c(r.train),validation:c(r.validation),test:c(r.test)}));for(const [i,r] of persistent.slice(0,20).entries())console.log('R15_EDGE_PERSISTENT',JSON.stringify({rank:i+1,name:r.rule.name,session:r.rule.session,horizonMin:r.rule.horizon*5,train:c(r.train),validation:c(r.validation),test:c(r.test)}));if(!persistent.length)console.log('R15_EDGE_NONE');}

function buildRules(){const rules:Rule[]=[];const sessions:Session[]=['ALL','LONDON','NY','OVERLAP'],horizons=[3,6,12,24,48];const add=(name:string,fn:(f:F[],i:number)=>Side|null)=>{for(const session of sessions)for(const horizon of horizons)rules.push({name,session,horizon,side:fn});};
for(const n of [3,6,12,24]){add(`MOM_${n}`, (f,i)=>ret(f,i,n)>0?1:ret(f,i,n)<0?-1:null);add(`REV_${n}`,(f,i)=>ret(f,i,n)>0?-1:ret(f,i,n)<0?1:null);}
for(const n of [6,12,24,48])add(`DONCHIAN_${n}`,(f,i)=>{const p=f.slice(i-n,i);if(p.length<n)return null;return f[i].close>Math.max(...p.map(x=>x.high))?1:f[i].close<Math.min(...p.map(x=>x.low))?-1:null;});
add('EMA_TREND',(f,i)=>f[i].ema20>f[i].ema50&&f[i].ema50>f[i].ema200?1:f[i].ema20<f[i].ema50&&f[i].ema50<f[i].ema200?-1:null);
add('EMA20_50',(f,i)=>f[i].ema20>f[i].ema50?1:f[i].ema20<f[i].ema50?-1:null);
add('RSI_REVERT_30_70',(f,i)=>f[i].rsi<=30?1:f[i].rsi>=70?-1:null);
add('RSI_MOM_55_45',(f,i)=>f[i].rsi>=55?1:f[i].rsi<=45?-1:null);
add('HIGH_VOL_MOM_6',(f,i)=>f[i].atrPct>mean(f.slice(Math.max(0,i-50),i).map(x=>x.atrPct))*1.2?(ret(f,i,6)>0?1:ret(f,i,6)<0?-1:null):null);
add('HIGH_VOL_REV_6',(f,i)=>f[i].atrPct>mean(f.slice(Math.max(0,i-50),i).map(x=>x.atrPct))*1.2?(ret(f,i,6)>0?-1:ret(f,i,6)<0?1:null):null);
add('HIGH_VOLUME_MOM',(f,i)=>f[i].volume>f[i].volAvg*1.4?(f[i].close>f[i].open?1:f[i].close<f[i].open?-1:null):null);
add('PULLBACK_TREND',(f,i)=>{const b=f[i],p=f[i-1];if(b.ema20>b.ema50&&p.low<=b.ema20&&b.close>b.ema20&&b.close>b.open)return 1;if(b.ema20<b.ema50&&p.high>=b.ema20&&b.close<b.ema20&&b.close<b.open)return-1;return null});
return rules;}
function evaluate(f:F[],start:number,end:number,r:Rule):M{const xs:number[]=[],gross:number[]=[];for(let i=Math.max(220,start);i<=end-r.horizon;i++){if(!sessionOk(f[i].time,r.session))continue;const side=r.side(f,i);if(!side)continue;const entry=f[i+1].open,exit=f[i+r.horizon].close;if(!(entry>0&&exit>0))continue;const g=side*(exit-entry)/entry*100,n=g-ROUND_TRIP_COST_PCT;gross.push(g);xs.push(n);}const n=xs.length,m=mean(xs),sd=stdev(xs,m);return{n,winRate:n?xs.filter(x=>x>0).length/n*100:0,meanNet:m,medianNet:median(xs),t:n&&sd>0?m/(sd/Math.sqrt(n)):0,grossMean:mean(gross)};}
function sessionOk(t:number,s:Session){if(s==='ALL')return true;const h=new Date(t).getUTCHours();if(s==='LONDON')return h>=7&&h<11;if(s==='NY')return h>=13&&h<18;return h>=12&&h<17;}
function ret(f:F[],i:number,n:number){return i>=n?(f[i].close-f[i-n].close)/f[i-n].close:0}
function c(m:M){return{n:m.n,winRate:Number(m.winRate.toFixed(2)),meanNetPct:Number(m.meanNet.toFixed(4)),medianNetPct:Number(m.medianNet.toFixed(4)),t:Number(m.t.toFixed(3)),grossMeanPct:Number(m.grossMean.toFixed(4))}}
function features(r:Candle[]):F[]{const close=r.map(x=>x.close),e20=ema(close,20),e50=ema(close,50),e200=ema(close,200),rs=rsi(close,14),a=atr(r,14);return r.map((x,i)=>({...x,ema20:e20[i],ema50:e50[i],ema200:e200[i],rsi:rs[i],atr:a[i],atrPct:x.close>0?a[i]/x.close*100:0,volAvg:mean(r.slice(Math.max(0,i-19),i+1).map(y=>y.volume)),mom3:i>=3?retRaw(r,i,3):0,mom6:i>=6?retRaw(r,i,6):0,mom12:i>=12?retRaw(r,i,12):0,mom24:i>=24?retRaw(r,i,24):0}));}
function retRaw(r:Candle[],i:number,n:number){return(r[i].close-r[i-n].close)/r[i-n].close*100}
function aggregate(rows:Candle[],bucket:number){const map=new Map<number,Candle>();for(const x of rows){const t=Math.floor(x.time/bucket)*bucket,b=map.get(t);if(!b)map.set(t,{...x,time:t});else{b.high=Math.max(b.high,x.high);b.low=Math.min(b.low,x.low);b.close=x.close;b.volume+=x.volume;}}return[...map.values()].sort((a,b)=>a.time-b.time)}
function ema(v:number[],p:number){const o=new Array(v.length).fill(0);if(!v.length)return o;const k=2/(p+1);o[0]=v[0];for(let i=1;i<v.length;i++)o[i]=v[i]*k+o[i-1]*(1-k);return o}
function atr(r:Candle[],p:number){const o=new Array(r.length).fill(0);if(!r.length)return o;o[0]=r[0].high-r[0].low;for(let i=1;i<r.length;i++){const tr=Math.max(r[i].high-r[i].low,Math.abs(r[i].high-r[i-1].close),Math.abs(r[i].low-r[i-1].close));o[i]=i<p?(o[i-1]*i+tr)/(i+1):(o[i-1]*(p-1)+tr)/p;}return o}
function rsi(v:number[],p:number){const o=new Array(v.length).fill(50);let g=0,l=0;for(let i=1;i<v.length;i++){const d=v[i]-v[i-1];if(i<=p){if(d>=0)g+=d;else l-=d;if(i===p){g/=p;l/=p}}else{g=(g*(p-1)+Math.max(d,0))/p;l=(l*(p-1)+Math.max(-d,0))/p}if(i>=p)o[i]=l<=1e-12?(g>0?100:50):100-100/(1+g/l)}return o}
function mean(v:number[]){return v.length?v.reduce((a,b)=>a+b,0)/v.length:0}function median(v:number[]){if(!v.length)return 0;const x=[...v].sort((a,b)=>a-b),m=Math.floor(x.length/2);return x.length%2?x[m]:(x[m-1]+x[m])/2}function stdev(v:number[],m=mean(v)){return v.length?Math.sqrt(v.reduce((s,x)=>s+(x-m)**2,0)/v.length):0}
function monthKeys(start:number,end:number){const out:string[]=[];let d=new Date(Date.UTC(new Date(start).getUTCFullYear(),new Date(start).getUTCMonth(),1)),last=new Date(Date.UTC(new Date(end).getUTCFullYear(),new Date(end).getUTCMonth(),1));while(d<=last){out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`);d=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1));}return out;}
async function fetchVision(symbol:string,start:number,end:number,dir:string):Promise<Candle[]>{const out:Candle[]=[];for(const month of monthKeys(start,end)){const fn=`${symbol}-1m-${month}.zip`,res=await fetch(`${VISION}/${symbol}/1m/${fn}`);if(res.status===404)continue;if(!res.ok)throw new Error(`VISION_${res.status}:${fn}`);const file=path.join(dir,fn);await writeFile(file,Buffer.from(await res.arrayBuffer()));const csv=execFileSync('unzip',['-p',file],{encoding:'utf8',maxBuffer:256*1024*1024});for(const line of csv.split(/\r?\n/)){if(!line.trim())continue;const a=line.split(','),raw=Number(a[0]);if(!Number.isFinite(raw))continue;const time=raw>1e17?Math.floor(raw/1_000_000):raw>1e14?Math.floor(raw/1000):raw,x:Candle={time,open:Number(a[1]),high:Number(a[2]),low:Number(a[3]),close:Number(a[4]),volume:Number(a[5]??0)};if([x.time,x.open,x.high,x.low,x.close].every(Number.isFinite)&&time>=start&&time<=end)out.push(x)}}const map=new Map(out.map(x=>[x.time,x]));return[...map.values()].sort((a,b)=>a.time-b.time)}
main().catch(e=>{console.error('R15_EDGE_ERROR',e instanceof Error?e.message:String(e));process.exit(1)});
