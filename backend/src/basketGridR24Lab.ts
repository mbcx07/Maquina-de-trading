import {execFileSync} from 'node:child_process';
import {mkdtemp,writeFile} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
type Side='BUY'|'SELL'; type Agg={time:number;price:number;qty:number}; type Bar={time:number;open:number;high:number;low:number;close:number;volume:number};
type Pos={side:Side,entry:number,lot:number,level:number};
type Cfg={spacing:number,targetUsd:number,levels:number,lotMode:'flat'|'step2'|'step3',maxBasketLoss:number,recenterBars:number};
type Stats={cycles:number,wins:number,losses:number,winRate:number,netUsd:number,final50:number,pf:number,maxDdUsd:number,maxDdPct:number,avgCycleUsd:number,cyclesPerDay:number,maxOpen:number,blown:boolean};
const SYMBOL='XAUUSDT',DAY=86400000,DAYS=84;const BASE=`https://data.binance.vision/data/futures/um/daily/aggTrades/${SYMBOL}`;
const COST_PER_001_USD=0.22; // approximate all-in spread+commission+slippage per 0.01-lot round trip, stressable proxy
function norm(v:number){if(v>1e17)return Math.floor(v/1e6);if(v>1e14)return Math.floor(v/1e3);return v}
async function fetchDay(d:string,dir:string){const fn=`${SYMBOL}-aggTrades-${d}.zip`,r=await fetch(`${BASE}/${fn}`);if(r.status===404)return[] as Agg[];if(!r.ok)throw Error(`VISION_${r.status}:${d}`);const f=path.join(dir,fn);await writeFile(f,Buffer.from(await r.arrayBuffer()));const csv=execFileSync('unzip',['-p',f],{encoding:'utf8',maxBuffer:512*1024*1024});const out:Agg[]=[];for(const line of csv.split(/\r?\n/)){if(!line.trim())continue;const c=line.split(','),p=+c[1],q=+c[2],t=+c[5];if(Number.isFinite(p)&&Number.isFinite(q)&&Number.isFinite(t))out.push({time:norm(t),price:p,qty:q})}return out}
function agg(rows:Agg[],ms:number){const m=new Map<number,Bar>();for(const x of rows){const k=Math.floor(x.time/ms)*ms;let b=m.get(k);if(!b){b={time:k,open:x.price,high:x.price,low:x.price,close:x.price,volume:0};m.set(k,b)}b.high=Math.max(b.high,x.price);b.low=Math.min(b.low,x.price);b.close=x.price;b.volume+=x.qty}return[...m.values()].sort((a,b)=>a.time-b.time)}
function lotFor(level:number,mode:Cfg['lotMode']){if(mode==='flat')return .01;if(mode==='step2')return .01*Math.min(4,1+Math.floor((level-1)/2));return .01*Math.min(4,1+Math.floor((level-1)/3))}
function grossPnl(pos:Pos[],px:number){let x=0;for(const p of pos){const oz=p.lot/.01;x+=(p.side==='BUY'?px-p.entry:p.entry-px)*oz}return x}
function closeCost(pos:Pos[]){let c=0;for(const p of pos)c+=COST_PER_001_USD*(p.lot/.01);return c}
function run(b:Bar[],cfg:Cfg,start:number,end:number):Stats{let eq=50,peak=50,maxDd=0,gp=0,gl=0,cycles=0,wins=0,losses=0,maxOpen=0,blown=false;let anchor=b[start]?.close||0,cycleStart=start;let pos:Pos[]=[];const firedB=new Set<number>(),firedS=new Set<number>();
 const reset=(i:number)=>{anchor=b[i].close;cycleStart=i;pos=[];firedB.clear();firedS.clear()};reset(start);
 for(let i=start+1;i<Math.min(end,b.length);i++){const bar=b[i];
  // Trigger every STOP level crossed; opposite ladder remains alive, matching screenshot behavior.
  for(let lv=1;lv<=cfg.levels;lv++){const buy=anchor+cfg.spacing*lv,sell=anchor-cfg.spacing*lv;if(!firedB.has(lv)&&bar.high>=buy){pos.push({side:'BUY',entry:buy,lot:lotFor(lv,cfg.lotMode),level:lv});firedB.add(lv)}if(!firedS.has(lv)&&bar.low<=sell){pos.push({side:'SELL',entry:sell,lot:lotFor(lv,cfg.lotMode),level:lv});firedS.add(lv)}}
  maxOpen=Math.max(maxOpen,pos.length);
  if(pos.length){const mtm=grossPnl(pos,bar.close)-closeCost(pos);const marked=eq+mtm;peak=Math.max(peak,marked);maxDd=Math.max(maxDd,peak-marked);
   // conservative intrabar basket check: evaluate close plus extremes and take adverse stop first when both could occur
   const pnlLo=grossPnl(pos,bar.low)-closeCost(pos),pnlHi=grossPnl(pos,bar.high)-closeCost(pos);const worst=Math.min(pnlLo,pnlHi),best=Math.max(pnlLo,pnlHi);
   if(worst<=-cfg.maxBasketLoss){eq+=-cfg.maxBasketLoss;gl+=cfg.maxBasketLoss;cycles++;losses++;if(eq<=5){blown=true;break}reset(i);continue}
   if(best>=cfg.targetUsd){eq+=cfg.targetUsd;gp+=cfg.targetUsd;cycles++;wins++;peak=Math.max(peak,eq);reset(i);continue}
  }
  // If no order has triggered for a while, rebuild grid around current price.
  if(pos.length===0&&i-cycleStart>=cfg.recenterBars)reset(i);
 }
 // force-close any open basket at final close
 if(!blown&&pos.length){const p=grossPnl(pos,b[Math.min(end-1,b.length-1)].close)-closeCost(pos);eq+=p;cycles++;if(p>=0){wins++;gp+=p}else{losses++;gl+=-p}}
 const days=Math.max(1,(b[Math.min(end-1,b.length-1)].time-b[start].time)/DAY),ddPct=maxDd/Math.max(50,peak)*100;return{cycles,wins,losses,winRate:cycles?wins/cycles*100:0,netUsd:eq-50,final50:eq,pf:gl?gp/gl:gp?99:0,maxDdUsd:maxDd,maxDdPct:ddPct,avgCycleUsd:cycles?(eq-50)/cycles:0,cyclesPerDay:cycles/days,maxOpen,blown}}
function score(s:Stats){if(s.blown||s.cycles<20)return-1e9;return s.netUsd-s.maxDdUsd*.8+(s.pf-1)*8+Math.min(8,s.cyclesPerDay)}
async function main(){const end=Math.floor((Date.now()-2*DAY)/DAY)*DAY,start=end-DAYS*DAY,dir=await mkdtemp(path.join(os.tmpdir(),'r24-'));let b:Bar[]=[];for(let t=start;t<end;t+=DAY){const d=new Date(t).toISOString().slice(0,10),r=await fetchDay(d,dir),a=agg(r,60000);console.log('DAY',d,r.length,a.length);b.push(...a)}b.sort((a,z)=>a.time-z.time);const N=b.length,t1=Math.floor(N*.5),t2=Math.floor(N*.75);console.log('R24_BARS',N);
 const inferred:Cfg={spacing:.50,targetUsd:5,levels:8,lotMode:'step2',maxBasketLoss:25,recenterBars:10};console.log('R24_INFERRED',JSON.stringify({config:inferred,train:run(b,inferred,0,t1),validation:run(b,inferred,t1,t2),test:run(b,inferred,t2,N)}));
 const cfgs:Cfg[]=[];for(const spacing of [.35,.50,.65,.80,1.00])for(const targetUsd of [3,5,7,10])for(const levels of [5,8,10])for(const lotMode of ['flat','step2','step3'] as Cfg['lotMode'][])for(const maxBasketLoss of [10,15,20,25,30])for(const recenterBars of [5,10,20])cfgs.push({spacing,targetUsd,levels,lotMode,maxBasketLoss,recenterBars});console.log('R24_CONFIGS',cfgs.length);
 const rows=cfgs.map(c=>{const tr=run(b,c,0,t1),va=run(b,c,t1,t2);return{c,tr,va,s:score(tr)+score(va)*1.7}}).sort((a,z)=>z.s-a.s);console.log('R24_TOP10',JSON.stringify(rows.slice(0,10)));const best=rows[0],test=run(b,best.c,t2,N);console.log('R24_RESULT',JSON.stringify({basis:'reconstruction inferred from screenshots: dual BUY/SELL STOP ladder, ~0.50 USD spacing, 0.01/0.02/0.03 lot progression, basket money target',symbol:SYMBOL,days:DAYS,barsM1:N,costPer001RoundTripUsd:COST_PER_001_USD,initialUsd:50,inferred:{config:inferred,train:run(b,inferred,0,t1),validation:run(b,inferred,t1,t2),test:run(b,inferred,t2,N)},optimized:{config:best.c,train:best.tr,validation:best.va,test,survived:!best.tr.blown&&!best.va.blown&&!test.blown&&best.tr.netUsd>0&&best.va.netUsd>0&&test.netUsd>0&&best.va.pf>1&&test.pf>1}}))}
main().catch(e=>{console.error('R24_ERROR',e);process.exit(1)});