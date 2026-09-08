import {execFileSync} from 'node:child_process';
import {mkdtemp,writeFile} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
type Side='BUY'|'SELL'; type Agg={time:number;price:number;qty:number}; type Bar={time:number;open:number;high:number;low:number;close:number;volume:number};
type Pos={side:Side,entry:number,lot:number,level:number};
type Mode='flat'|'step2';
type Cfg={spacing:number,target:number,levels:number,lotMode:Mode,stop:number,oppGap:number,trailArm:number,trailGive:number,maxHold:number};
type Stats={cycles:number,wins:number,losses:number,wr:number,net:number,final50:number,pf:number,dd:number,ddPct:number,cpd:number,maxOpen:number,blown:boolean,avgWin:number,avgLoss:number};
const SYMBOL='XAUUSDT',DAY=86400000,DAYS=84,COST=.22,BASE=`https://data.binance.vision/data/futures/um/daily/aggTrades/${SYMBOL}`;
function norm(v:number){if(v>1e17)return Math.floor(v/1e6);if(v>1e14)return Math.floor(v/1e3);return v}
async function fetchDay(d:string,dir:string){const fn=`${SYMBOL}-aggTrades-${d}.zip`,r=await fetch(`${BASE}/${fn}`);if(r.status===404)return[] as Agg[];if(!r.ok)throw Error(`VISION_${r.status}:${d}`);const f=path.join(dir,fn);await writeFile(f,Buffer.from(await r.arrayBuffer()));const csv=execFileSync('unzip',['-p',f],{encoding:'utf8',maxBuffer:512*1024*1024});const out:Agg[]=[];for(const line of csv.split(/\r?\n/)){if(!line.trim())continue;const c=line.split(','),p=+c[1],q=+c[2],t=+c[5];if(Number.isFinite(p)&&Number.isFinite(q)&&Number.isFinite(t))out.push({time:norm(t),price:p,qty:q})}return out}
function agg(rows:Agg[]){const m=new Map<number,Bar>();for(const x of rows){const k=Math.floor(x.time/60000)*60000;let b=m.get(k);if(!b){b={time:k,open:x.price,high:x.price,low:x.price,close:x.price,volume:0};m.set(k,b)}b.high=Math.max(b.high,x.price);b.low=Math.min(b.low,x.price);b.close=x.price;b.volume+=x.qty}return[...m.values()].sort((a,b)=>a.time-b.time)}
function lot(level:number,mode:Mode){return mode==='flat'?.01:.01*Math.min(4,1+Math.floor((level-1)/2))}
function pnl(pos:Pos[],px:number){let x=0;for(const p of pos)x+=(p.side==='BUY'?px-p.entry:p.entry-px)*(p.lot/.01);return x-pos.reduce((s,p)=>s+COST*(p.lot/.01),0)}
function run(b:Bar[],c:Cfg,start:number,end:number):Stats{let eq=50,peak=50,dd=0,gp=0,gl=0,cycles=0,wins=0,losses=0,maxOpen=0,blown=false,anchor=b[start]?.close||0,cycleStart=start,active:Side|null=null,opp:Side|null=null,maxBasket=-1e9;let pos:Pos[]=[];const fired=new Set<number>(),oppFired=new Set<number>();
 const reset=(i:number)=>{anchor=b[i].close;cycleStart=i;active=null;opp=null;pos=[];fired.clear();oppFired.clear();maxBasket=-1e9};reset(start);
 const close=(v:number,i:number)=>{eq+=v;cycles++;if(v>=0){wins++;gp+=v}else{losses++;gl+=-v}peak=Math.max(peak,eq);if(eq<=5){blown=true;return}reset(i)};
 for(let i=start+1;i<Math.min(end,b.length)&&!blown;i++){const bar=b[i];
  if(!active){const up=bar.high>=anchor+c.spacing,dn=bar.low<=anchor-c.spacing;if(up||dn){if(up&&dn)active=bar.close>=anchor?'SELL':'BUY';else active=up?'BUY':'SELL'}}
  if(active){for(let lv=1;lv<=c.levels;lv++){const px=anchor+(active==='BUY'?1:-1)*c.spacing*lv;if(!fired.has(lv)&&((active==='BUY'&&bar.high>=px)||(active==='SELL'&&bar.low<=px))){pos.push({side:active,entry:px,lot:lot(lv,c.lotMode),level:lv});fired.add(lv)}}
   const os:Side=active==='BUY'?'SELL':'BUY',trigger=anchor+(os==='BUY'?1:-1)*c.spacing*c.oppGap;if(!opp&&((os==='BUY'&&bar.high>=trigger)||(os==='SELL'&&bar.low<=trigger)))opp=os;
   if(opp){for(let lv=1;lv<=Math.min(3,c.levels);lv++){const px=anchor+(opp==='BUY'?1:-1)*c.spacing*(c.oppGap+lv-1);if(!oppFired.has(lv)&&((opp==='BUY'&&bar.high>=px)||(opp==='SELL'&&bar.low<=px))){pos.push({side:opp,entry:px,lot:lot(Math.min(c.levels,lv+1),c.lotMode),level:lv});oppFired.add(lv)}}}
  }
  maxOpen=Math.max(maxOpen,pos.length);if(!pos.length){if(i-cycleStart>20)reset(i);continue}
  const cur=pnl(pos,bar.close),lo=pnl(pos,bar.low),hi=pnl(pos,bar.high),worst=Math.min(lo,hi),best=Math.max(lo,hi);maxBasket=Math.max(maxBasket,cur,best);const marked=eq+cur;peak=Math.max(peak,marked);dd=Math.max(dd,peak-marked);
  if(worst<=-c.stop){close(-c.stop,i);continue} // conservative: adverse basket stop first
  if(best>=c.target){close(c.target,i);continue}
  if(c.trailArm>0&&maxBasket>=c.trailArm&&cur<=maxBasket-c.trailGive){close(cur,i);continue}
  if(i-cycleStart>=c.maxHold){close(cur,i);continue}
 }
 if(!blown&&pos.length){close(pnl(pos,b[Math.min(end-1,b.length-1)].close),Math.min(end-1,b.length-1))}
 const days=Math.max(1,(b[Math.min(end-1,b.length-1)].time-b[start].time)/DAY);return{cycles,wins,losses,wr:cycles?wins/cycles*100:0,net:eq-50,final50:eq,pf:gl?gp/gl:gp?99:0,dd,ddPct:dd/Math.max(50,peak)*100,cpd:cycles/days,maxOpen,blown,avgWin:wins?gp/wins:0,avgLoss:losses?gl/losses:0}}
function score(s:Stats){if(s.blown||s.cycles<15)return-1e9;return s.net-s.dd*.65+(s.pf-1)*12+Math.min(8,s.cpd)-Math.max(0,s.avgLoss-s.avgWin*4)*.2}
async function main(){const end=Math.floor((Date.now()-2*DAY)/DAY)*DAY,start=end-DAYS*DAY,dir=await mkdtemp(path.join(os.tmpdir(),'r25-'));let b:Bar[]=[];for(let t=start;t<end;t+=DAY){const d=new Date(t).toISOString().slice(0,10),r=await fetchDay(d,dir),a=agg(r);console.log('DAY',d,r.length,a.length);b.push(...a)}b.sort((a,z)=>a.time-z.time);const N=b.length,t1=Math.floor(N*.5),t2=Math.floor(N*.75);console.log('R25_BARS',N);
 const visual:Cfg={spacing:.5,target:5,levels:8,lotMode:'step2',stop:25,oppGap:4,trailArm:0,trailGive:1,maxHold:720};console.log('R25_VISUAL',JSON.stringify({c:visual,tr:run(b,visual,0,t1),va:run(b,visual,t1,t2),te:run(b,visual,t2,N)}));
 const cfgs:Cfg[]=[];for(const spacing of [.4,.5,.65,.8,1])for(const target of [3,5,7,10])for(const levels of [5,8])for(const lotMode of ['flat','step2'] as Mode[])for(const stop of [8,12,15,20,25])for(const oppGap of [3,5,7])for(const trailArm of [0,2.5])for(const maxHold of [240,720])cfgs.push({spacing,target,levels,lotMode,stop,oppGap,trailArm,trailGive:1.25,maxHold});console.log('R25_CONFIGS',cfgs.length);
 const rows=cfgs.map(c=>{const tr=run(b,c,0,t1),va=run(b,c,t1,t2);return{c,tr,va,s:score(tr)+1.7*score(va)}}).sort((a,z)=>z.s-a.s);console.log('R25_TOP10',JSON.stringify(rows.slice(0,10)));const best=rows[0],te=run(b,best.c,t2,N);console.log('R25_RESULT',JSON.stringify({basis:'directional STOP pyramid inferred from screenshots; opposite ladder delayed as hedge/reversal; basket cash target; improved basket trailing and capped tail loss',symbol:SYMBOL,days:DAYS,barsM1:N,costPer001:COST,initial:50,visual:{c:visual,tr:run(b,visual,0,t1),va:run(b,visual,t1,t2),te:run(b,visual,t2,N)},optimized:{c:best.c,tr:best.tr,va:best.va,te,survived:!best.tr.blown&&!best.va.blown&&!te.blown&&best.tr.net>0&&best.va.net>0&&te.net>0&&best.va.pf>1&&te.pf>1}}))}
main().catch(e=>{console.error('R25_ERROR',e);process.exit(1)});