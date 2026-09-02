import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CommodityCandleR15 } from './commodityStrategyR15.js';

const DAY=86_400_000;
const VISION='https://data.binance.vision/data/futures/um/daily/klines';
const DAYS=90;
const COST={spreadPct:0.025,slippagePct:0.01,feePct:0.05,leverage:10,marginPct:1};

type Feature={time:number;longScore:number;shortScore:number;atrPct:number;m5Bias:-1|0|1;open:number;high:number;low:number;close:number};
type Params={threshold:number;targetAtr:number;stopAtr:number;edge:number;hold:number;session:'ALL'|'LIQUID';volRatio:number};
type Metrics={trades:number;wins:number;winRate:number;profitFactor:number;netReturnPct:number;maxDdPct:number;finalBalance:number;expectancy:number};

async function main(){
 const endDay=Math.floor((Date.now()-DAY)/DAY)*DAY;const end=endDay+DAY-1;const start=end-DAYS*DAY;const dir=await mkdtemp(path.join(os.tmpdir(),'r15-xau-opt-'));
 const candles=await fetchVision('XAUUSDT',start,end,dir);if(candles.length<50_000)throw new Error(`XAU_HISTORY_TOO_SHORT:${candles.length}`);
 const splitTime=start+60*DAY;const features=buildFeatures(candles);
 const trainStart=features.findIndex(f=>f.time>=start);const split=features.findIndex(f=>f.time>=splitTime);const endIndex=features.length-2;
 const candidates: Array<{p:Params;m:Metrics;score:number}>=[];
 for(const threshold of [55,60,65,70])for(const targetAtr of [2,3,4])for(const stopAtr of [1.5,2.5])for(const edge of [1.3,1.6,2])for(const hold of [10,20,30])for(const session of ['ALL','LIQUID'] as const)for(const volRatio of [0.2,0.3]){
   const p={threshold,targetAtr,stopAtr,edge,hold,session,volRatio};const m=simulate(features,Math.max(60,trainStart),split-1,p);
   if(m.trades<40||m.netReturnPct<=0||m.profitFactor<1.02)continue;
   const score=m.netReturnPct-m.maxDdPct*0.8+Math.min(2,m.profitFactor)*3+Math.min(500,m.trades)*0.002;
   candidates.push({p,m,score});
 }
 candidates.sort((a,b)=>b.score-a.score);
 console.log('R15_XAU_OPT_META',JSON.stringify({candles:candles.length,from:new Date(candles[0].time).toISOString(),to:new Date(candles.at(-1)!.time).toISOString(),trainDays:60,validationDays:30,cost:COST,candidates:candidates.length}));
 for(const [rank,c] of candidates.slice(0,12).entries()){
   const validation=simulate(features,split,endIndex,c.p);
   console.log('R15_XAU_OPT',JSON.stringify({rank:rank+1,params:c.p,train:c.m,validation}));
 }
 if(!candidates.length) console.log('R15_XAU_OPT_NO_POSITIVE_TRAIN_MODEL');
}

function simulate(f:Feature[],start:number,end:number,p:Params):Metrics{
 let balance=50,peak=50,maxDd=0,wins=0,gp=0,gl=0,trades=0;let i=start;
 while(i<end-1){const s=f[i];const hour=new Date(s.time).getUTCHours();if(p.session==='LIQUID'&&(hour<6||hour>=21)){i++;continue;}if(s.atrPct<COST_TOTAL()*p.volRatio){i++;continue;}
   const long=s.m5Bias===1&&s.longScore>=p.threshold;const short=s.m5Bias===-1&&s.shortScore>=p.threshold;if(!long&&!short){i++;continue;}const side:1|-1=long&&short?(s.longScore>=s.shortScore?1:-1):long?1:-1;
   const next=f[i+1];let entry=next.open*(1+side*(COST.spreadPct/2+COST.slippagePct)/100);const targetPct=Math.max(COST_TOTAL()*p.edge,s.atrPct*p.targetAtr);const stopPct=Math.max(0.08,s.atrPct*p.stopAtr);
   const tp=entry*(1+side*targetPct/100);const sl=entry*(1-side*stopPct/100);const before=balance;const margin=balance*COST.marginPct/100;const notional=margin*COST.leverage;const qty=notional/entry;const entryFee=notional*COST.feePct/100;
   let exitIndex=Math.min(end,i+1+p.hold),exit=f[exitIndex].close,reason='TIME';for(let j=i+1;j<=exitIndex;j++){const b=f[j];const hitSl=side===1?b.low<=sl:b.high>=sl;const hitTp=side===1?b.high>=tp:b.low<=tp;if(hitSl){exit=sl;exitIndex=j;reason='SL';break;}if(hitTp){exit=tp;exitIndex=j;reason='TP';break;}}
   exit=exit*(1-side*(COST.spreadPct/2+COST.slippagePct)/100);const gross=side===1?(exit-entry)*qty:(entry-exit)*qty;const exitFee=qty*exit*COST.feePct/100;const pnl=gross-entryFee-exitFee;balance+=pnl;trades++;if(pnl>0){wins++;gp+=pnl;}else gl+=Math.abs(pnl);peak=Math.max(peak,balance);maxDd=Math.max(maxDd,peak>0?(peak-balance)/peak*100:100);if(balance<=1)break;i=Math.max(i+1,exitIndex+1);
 }
 return {trades,wins,winRate:trades?wins/trades*100:0,profitFactor:gl>0?gp/gl:gp>0?99:0,netReturnPct:(balance-50)/50*100,maxDdPct:maxDd,finalBalance:balance,expectancy:trades?(balance-50)/trades:0};
}

function buildFeatures(c:CommodityCandleR15[]):Feature[]{const closes=c.map(x=>x.close);const e9=ema(closes,9),e21=ema(closes,21),atr14=atrSeries(c,14),rsi14=rsiSeries(closes,14);const m5=aggregate5(c);const m5c=m5.map(x=>x.close),m5e20=ema(m5c,20),m5e50=ema(m5c,50);let m5i=0;const out:Feature[]=[];
 for(let i=0;i<c.length;i++){while(m5i+1<m5.length&&m5[m5i+1].time+5*60_000<=c[i].time+60_000)m5i++;const bias:m5i extends never?never: -1|0|1=(m5i>=2&&m5e20[m5i]>m5e50[m5i]&&m5e20[m5i]>=m5e20[m5i-2])?1:(m5i>=2&&m5e20[m5i]<m5e50[m5i]&&m5e20[m5i]<=m5e20[m5i-2])?-1:0;let ls=0,ss=0;const r=rsi14[i],a=atr14[i];if(e9[i]>e21[i])ls+=18;else if(e9[i]<e21[i])ss+=18;if(i>=3&&e9[i]>e9[i-3])ls+=9;if(i>=3&&e9[i]<e9[i-3])ss+=9;if(r>=50&&r<=78)ls+=14;if(r>=22&&r<=50)ss+=14;if(i>=1&&c[i-1].low<=e9[i]+a*.3)ls+=8;if(i>=1&&c[i-1].high>=e9[i]-a*.3)ss+=8;if(c[i].close>c[i].open)ls+=7;else if(c[i].close<c[i].open)ss+=7;if(i>=1&&c[i].close>c[i-1].high)ls+=13;else if(i>=1&&c[i].close>c[i-1].close)ls+=5;if(i>=1&&c[i].close<c[i-1].low)ss+=13;else if(i>=1&&c[i].close<c[i-1].close)ss+=5;if(a>0&&Math.abs(c[i].close-c[i].open)/a>=.08){if(c[i].close>c[i].open)ls+=8;else ss+=8;}const avgVol=mean(c.slice(Math.max(0,i-19),i+1).map(x=>x.volume));if(avgVol>0&&c[i].volume>=avgVol*1.15){if(c[i].close>c[i].open)ls+=8;else if(c[i].close<c[i].open)ss+=8;}out.push({time:c[i].time,longScore:ls,shortScore:ss,atrPct:a>0?a/c[i].close*100:0,m5Bias:bias,open:c[i].open,high:c[i].high,low:c[i].low,close:c[i].close});}
 return out;}

function aggregate5(c:CommodityCandleR15[]){const map=new Map<number,CommodityCandleR15>();for(const x of c){const t=Math.floor(x.time/(5*60_000))*(5*60_000);const b=map.get(t);if(!b)map.set(t,{...x,time:t});else{b.high=Math.max(b.high,x.high);b.low=Math.min(b.low,x.low);b.close=x.close;b.volume+=x.volume;}}return [...map.values()].sort((a,b)=>a.time-b.time)}
function ema(v:number[],p:number[]|number):number[]{const period=typeof p==='number'?p:p[0];const a=2/(period+1),o=new Array(v.length);if(!v.length)return[];o[0]=v[0];for(let i=1;i<v.length;i++)o[i]=v[i]*a+o[i-1]*(1-a);return o}
function atrSeries(c:CommodityCandleR15[],p:number){const o=new Array(c.length).fill(0);if(!c.length)return o;o[0]=c[0].high-c[0].low;for(let i=1;i<c.length;i++){const tr=Math.max(c[i].high-c[i].low,Math.abs(c[i].high-c[i-1].close),Math.abs(c[i].low-c[i-1].close));o[i]=i<p?(o[i-1]*i+tr)/(i+1):(o[i-1]*(p-1)+tr)/p;}return o}
function rsiSeries(v:number[],p:number){const o=new Array(v.length).fill(50);let g=0,l=0;for(let i=1;i<v.length;i++){const d=v[i]-v[i-1];if(i<=p){if(d>=0)g+=d;else l-=d;if(i===p){g/=p;l/=p;}}else{g=(g*(p-1)+Math.max(d,0))/p;l=(l*(p-1)+Math.max(-d,0))/p;}if(i>=p)o[i]=l<=1e-12?(g>0?100:50):100-100/(1+g/l);}return o}
function COST_TOTAL(){return COST.spreadPct+COST.slippagePct*2+COST.feePct*2}
function mean(v:number[]){return v.length?v.reduce((a,b)=>a+b,0)/v.length:0}

async function fetchVision(symbol:string,startTime:number,endTime:number,dir:string){const output:CommodityCandleR15[]=[];for(let cursor=Math.floor(startTime/DAY)*DAY;cursor<=Math.floor(endTime/DAY)*DAY;cursor+=DAY){const day=new Date(cursor).toISOString().slice(0,10),fn=`${symbol}-1m-${day}.zip`;const r=await fetch(`${VISION}/${symbol}/1m/${fn}`);if(r.status===404)continue;if(!r.ok)throw new Error(`VISION_${r.status}:${fn}`);const file=path.join(dir,fn);await writeFile(file,Buffer.from(await r.arrayBuffer()));const csv=execFileSync('unzip',['-p',file],{encoding:'utf8',maxBuffer:64*1024*1024});for(const line of csv.split(/\r?\n/)){if(!line.trim())continue;const a=line.split(','),raw=Number(a[0]);if(!Number.isFinite(raw))continue;const time=normalize(raw);const row={time,open:Number(a[1]),high:Number(a[2]),low:Number(a[3]),close:Number(a[4]),volume:Number(a[5]??0)};if([row.time,row.open,row.high,row.low,row.close].every(Number.isFinite)&&time>=startTime&&time<=endTime)output.push(row);}}const map=new Map(output.map(x=>[x.time,x]));return [...map.values()].sort((a,b)=>a.time-b.time)}
function normalize(v:number){if(v>1e17)return Math.floor(v/1_000_000);if(v>1e14)return Math.floor(v/1000);return v}
main().catch(e=>{console.error('R15_XAU_OPT_ERROR',e instanceof Error?e.message:String(e));process.exit(1)});
