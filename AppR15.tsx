import React, { useEffect, useMemo, useRef, useState } from 'react';

type MarketKind = 'XAU' | 'CRUDE';
type VenueKind = 'EXCHANGE' | 'MT5';
type Timeframe = '30s' | '1m';
type CrudeSideMode = 'BUY' | 'SELL' | 'BOTH';
type Candle = { time:number; open:number; high:number; low:number; close:number; volume?:number; buyVolume?:number; sellVolume?:number };
type Trade = { id:string; venue:string; mode:string; symbol:string; displaySymbol:string; side:'BUY'|'SELL'; state:string; entryPrice:number; exitPrice?:number; stopLoss:number; takeProfit:number; quantity:number; leverage:number; marginUsed:number; entrySpreadPct:number; estimatedRoundTripCostPct:number; realizedPnl:number; unrealizedPnl:number; openTime:number; closeTime?:number; closeReason?:string; metadata?:any };
type ChartPayload = { ok?:boolean; kind?:string; venue?:string; venueLabel?:string; symbol?:string; display?:string; bid?:number; ask?:number; spreadPct?:number; m1?:Candle[]; micro30s?:Candle[]; trades?:Trade[]; diagnostic?:any; updatedAt?:number; error?:string };
type AppState = { release?:string; edition?:string; mode?:string; engineEnabled?:boolean; crudeSideMode?:CrudeSideMode; policy?:any; integrations?:any; exchange?:any; forex?:any; comparison?:any[]; recentTrades?:Trade[]; backtest?:any };
type UpdaterState = { ok?:boolean; currentSha?:string; remoteSha?:string; updateAvailable?:boolean; dirty?:string[]; release?:string; agent?:{busy?:boolean;phase?:string;lastOk?:boolean;lastError?:string;lastOutput?:string} };

const API = (import.meta as any).env?.VITE_V34_API_BASE || '/backend';
const STATE_MS = 2000;
const CHART_MS = 5000;

export default function AppR15(){
  const [state,setState]=useState<AppState>({});
  const [market,setMarket]=useState<MarketKind>('XAU');
  const [venue,setVenue]=useState<VenueKind>('EXCHANGE');
  const [timeframe,setTimeframe]=useState<Timeframe>('30s');
  const [chart,setChart]=useState<ChartPayload>({});
  const [streamStatus,setStreamStatus]=useState<'CONNECTING'|'LIVE'|'ERROR'>('CONNECTING');
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [updater,setUpdater]=useState<UpdaterState>({});
  const [updateBusy,setUpdateBusy]=useState(false);
  const [autoUpdate,setAutoUpdate]=useState(()=>localStorage.getItem('quantum.r15.autoUpdate')!=='false');
  const [backtestDays,setBacktestDays]=useState<number|'MAX'>(30);
  const eventRef=useRef<EventSource|null>(null);

  const refreshState=async()=>{try{const r=await fetch(`${API}/api/state?ts=${Date.now()}`,{cache:'no-store'});const b=await r.json().catch(()=>({}));if(!r.ok)throw new Error(b.error||`STATE_${r.status}`);setState(b);setError('');}catch(e){setError(msg(e));}};
  const refreshChart=async()=>{try{const r=await fetch(`${API}/api/chart/${market}/${venue}?ts=${Date.now()}`,{cache:'no-store'});const b=await r.json().catch(()=>({}));if(!r.ok)throw new Error(b.error||`CHART_${r.status}`);setChart(b);}catch(e){setChart(old=>({...old,error:msg(e)}));}};
  const command=async(path:string,body?:any)=>{setBusy(true);try{const r=await fetch(`${API}${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const b=await r.json().catch(()=>({}));if(!r.ok&&r.status!==202)throw new Error(b.error||`HTTP_${r.status}`);await Promise.all([refreshState(),refreshChart()]);return b;}catch(e){setError(msg(e));return null;}finally{setBusy(false);}};
  const patchSettings=async(patch:any)=>{setBusy(true);try{const r=await fetch(`${API}/api/settings`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(patch)});const b=await r.json().catch(()=>({}));if(!r.ok)throw new Error(b.error||`SETTINGS_${r.status}`);await refreshState();}catch(e){setError(msg(e));}finally{setBusy(false);}};

  useEffect(()=>{void refreshState();const t=window.setInterval(()=>void refreshState(),STATE_MS);return()=>clearInterval(t);},[]);
  useEffect(()=>{void refreshChart();const t=window.setInterval(()=>void refreshChart(),CHART_MS);return()=>clearInterval(t);},[market,venue]);
  useEffect(()=>{
    eventRef.current?.close();
    setStreamStatus('CONNECTING');
    const es=new EventSource(`${API}/api/stream/${market}/${venue}`);
    eventRef.current=es;
    es.addEventListener('tick',(event:any)=>{try{const tick=JSON.parse(event.data);setStreamStatus('LIVE');setChart(old=>mergeTick(old,tick));}catch{}});
    es.addEventListener('stream_error',()=>setStreamStatus('ERROR'));
    es.onerror=()=>setStreamStatus('ERROR');
    return()=>{es.close();if(eventRef.current===es)eventRef.current=null;};
  },[market,venue]);

  useEffect(()=>{localStorage.setItem('quantum.r15.autoUpdate',autoUpdate?'true':'false');},[autoUpdate]);
  useEffect(()=>{void checkUpdate();const t=window.setInterval(async()=>{const result=await checkUpdate();if(autoUpdate&&result?.updateAvailable&&openPositions===0&&!result.agent?.busy)void applyUpdate(true);},10*60_000);return()=>clearInterval(t);},[autoUpdate,state]);

  const checkUpdate=async()=>{try{const r=await fetch(`/updater/check?ts=${Date.now()}`,{cache:'no-store'});if(!r.ok)throw new Error(`UPDATER_${r.status}`);const b=await r.json();setUpdater(b);return b as UpdaterState;}catch(e){setUpdater(old=>({...old,agent:{...old.agent,lastError:msg(e)}}));return null;}};
  const applyUpdate=async(automatic=false)=>{if(updateBusy||updater.agent?.busy)return;if(openPositions>0){if(!automatic)setError('Actualización bloqueada: hay posiciones abiertas.');return;}setUpdateBusy(true);try{const r=await fetch('/updater/apply',{method:'POST'});const b=await r.json().catch(()=>({}));if(!r.ok&&r.status!==202)throw new Error(b.error||`UPDATE_${r.status}`);setUpdater(old=>({...old,...b}));pollUpdater();}catch(e){setError(msg(e));setUpdateBusy(false);}};
  const pollUpdater=()=>{const t=window.setInterval(async()=>{try{const r=await fetch(`/updater/status?ts=${Date.now()}`,{cache:'no-store'});if(!r.ok)return;const b=await r.json();setUpdater(b);if(b.agent?.phase==='COMPLETED'&&b.agent?.lastOk){clearInterval(t);setTimeout(()=>location.reload(),1200);}if(b.agent?.phase==='ERROR'){clearInterval(t);setUpdateBusy(false);setError(b.agent?.lastError||'UPDATE_ERROR');}}catch{}},1500);};

  const exchangePaper=state.exchange?.paper||{};
  const mt5Paper=state.forex?.paper||{};
  const openPositions=Number(exchangePaper.openPositions||0)+Number(mt5Paper.openPositions||0);
  const selectedService=venue==='EXCHANGE'?state.exchange:state.forex;
  const instrument=findInstrument(selectedService,market);
  const diagnostic=chart.diagnostic||instrument?.lastDiagnostic||{};
  const comparison=(state.comparison||[]).filter((r:any)=>r.display===(market==='XAU'?'XAUUSD':'CRUDE OIL'));
  const backtest=state.backtest?.[market]||{};

  return <div className="min-h-screen bg-[#02050a] text-slate-100 selection:bg-cyan-400/30">
    <div className="fixed inset-0 pointer-events-none overflow-hidden"><div className="absolute -top-52 left-[8%] w-[44rem] h-[44rem] rounded-full bg-cyan-500/[.07] blur-[150px]"/><div className="absolute top-[28%] right-[-16rem] w-[42rem] h-[42rem] rounded-full bg-fuchsia-500/[.05] blur-[160px]"/><div className="absolute bottom-[-20rem] left-[30%] w-[48rem] h-[48rem] rounded-full bg-emerald-500/[.04] blur-[170px]"/></div>
    <header className="sticky top-0 z-50 border-b border-slate-700/70 bg-[#02050a]/94 backdrop-blur-2xl">
      <div className="max-w-[1900px] mx-auto px-4 lg:px-6 py-4 flex flex-col 2xl:flex-row 2xl:items-center justify-between gap-4">
        <div className="flex items-center gap-4"><div className="w-12 h-12 rounded-2xl border border-cyan-400/40 bg-cyan-500/10 grid place-items-center shadow-[0_0_35px_rgba(34,211,238,.16)]"><b className="text-xl text-cyan-200">Q</b></div><div><div className="flex flex-wrap gap-2 items-center"><span className="text-xs font-black uppercase tracking-[.18em] text-cyan-200">Quantum Commodities</span><Pill text={`R15 · ${state.mode||'PAPER'}`} tone="cyan"/><Pill text={state.engineEnabled?'AUTO ON':'PAUSED'} tone={state.engineEnabled?'green':'amber'}/><Pill text={streamStatus} tone={streamStatus==='LIVE'?'green':streamStatus==='ERROR'?'red':'amber'}/></div><h1 className="mt-1 text-2xl md:text-3xl font-black">XAUUSD + CRUDE <span className="text-slate-400">· Exchange ↔ MT5</span></h1></div></div>
        <div className="flex flex-wrap gap-2 items-center"><Conn label="BINANCE" ok={state.integrations?.binance?.configured}/><Conn label="ASTER" ok={state.integrations?.aster?.configured||state.mode==='PAPER'}/><Conn label="MT5" ok={state.integrations?.mt5?.connected||state.forex?.status==='RUNNING'}/><button disabled={busy} onClick={()=>void command(state.engineEnabled?'/api/pause':'/api/start')} className={`h-11 px-5 rounded-xl border text-sm font-black uppercase ${state.engineEnabled?'border-amber-400/40 bg-amber-500/10 text-amber-200':'border-emerald-400/40 bg-emerald-500/10 text-emerald-200'}`}>{state.engineEnabled?'Pausar':'Iniciar automático'}</button><UpdateControl updater={updater} auto={autoUpdate} setAuto={setAutoUpdate} check={checkUpdate} apply={()=>applyUpdate(false)} disabled={openPositions>0} busy={updateBusy}/></div>
      </div>
    </header>

    <main className="relative max-w-[1900px] mx-auto p-4 lg:p-6 space-y-5">
      {error&&<div className="rounded-2xl border border-rose-400/40 bg-rose-500/10 px-5 py-4 text-sm text-rose-100"><b>ALERTA · </b>{error}</div>}

      <section className="grid grid-cols-1 xl:grid-cols-[1fr_auto] gap-4">
        <div className="grid grid-cols-2 gap-2 rounded-3xl border border-slate-700 bg-slate-950/60 p-2"><BigSelect active={market==='XAU'} title="XAUUSD" subtitle="Gold · BUY / SELL" onClick={()=>setMarket('XAU')}/><BigSelect active={market==='CRUDE'} title="CRUDE OIL" subtitle={`Modo ${state.crudeSideMode||'BUY'}`} onClick={()=>setMarket('CRUDE')}/></div>
        <div className="grid grid-cols-2 gap-2 rounded-3xl border border-slate-700 bg-slate-950/60 p-2 min-w-[360px]"><BigSelect active={venue==='EXCHANGE'} title="EXCHANGE" subtitle={market==='XAU'?'Binance USD-M':'Aster / Binance Wallet'} onClick={()=>setVenue('EXCHANGE')}/><BigSelect active={venue==='MT5'} title="FOREX / MT5" subtitle={findInstrument(state.forex,market)?.symbol||'Auto detect'} onClick={()=>setVenue('MT5')}/></div>
      </section>

      {market==='CRUDE'&&<section className="rounded-2xl border border-amber-400/25 bg-amber-500/[.06] p-4 flex flex-col md:flex-row md:items-center justify-between gap-3"><div><p className="text-sm font-black text-amber-100">Dirección permitida para CRUDE OIL</p><p className="text-xs text-slate-300 mt-1">BUY es el valor por defecto. El cambio aplica simultáneamente a Exchange y MT5.</p></div><div className="flex gap-2">{(['BUY','SELL','BOTH'] as CrudeSideMode[]).map(mode=><button key={mode} disabled={busy} onClick={()=>void patchSettings({crudeSideMode:mode})} className={`px-5 py-3 rounded-xl border text-sm font-black ${state.crudeSideMode===mode?'border-amber-300 bg-amber-400/20 text-amber-50':'border-slate-600 bg-slate-950/60 text-slate-300'}`}>{mode}</button>)}</div></section>}

      <section className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        <AccountCard title="EXCHANGE PAPER" paper={exchangePaper} subtitle="XAU Binance + CL Aster"/>
        <AccountCard title="MT5 PAPER" paper={mt5Paper} subtitle="Spread real del broker"/>
        <ScoreCard diagnostic={diagnostic}/>
        <div className="rounded-2xl border border-slate-700 bg-slate-950/65 p-4"><p className="label">COSTOS / MERCADO</p><div className="grid grid-cols-2 gap-3 mt-3"><KV k="Bid" v={price(chart.bid??instrument?.book?.bid)}/><KV k="Ask" v={price(chart.ask??instrument?.book?.ask)}/><KV k="Spread" v={pct4(chart.spreadPct??instrument?.spreadPct)}/><KV k="TP bruto" v={pct4(diagnostic.targetPct)}/><KV k="Costo RT" v={pct4(diagnostic.costPct)}/><KV k="ATR" v={pct4(diagnostic.atrPct)}/></div></div>
      </section>

      <section className="rounded-[30px] border border-cyan-900/70 bg-[#040912]/95 overflow-hidden shadow-[0_35px_110px_rgba(0,0,0,.5)]">
        <div className="px-5 py-4 border-b border-slate-700 flex flex-col lg:flex-row lg:items-center justify-between gap-3"><div><div className="flex items-center gap-2 flex-wrap"><h2 className="text-xl font-black">{market==='XAU'?'XAUUSD':'CRUDE OIL'} · {venue}</h2><Pill text={streamStatus==='LIVE'?'STREAM 500ms':'RECONECTANDO'} tone={streamStatus==='LIVE'?'green':'amber'}/>{chart.symbol&&<Pill text={chart.symbol} tone="violet"/>}</div><p className="text-sm text-slate-300 mt-1">Precio vivo, velas, entradas, salidas, SL/TP y movimiento tick-a-tick.</p></div><div className="flex gap-2 items-center"><button className={`px-4 py-2 rounded-xl border text-sm font-black ${timeframe==='30s'?'border-cyan-300 bg-cyan-500/15 text-cyan-100':'border-slate-600 text-slate-300'}`} onClick={()=>setTimeframe('30s')}>30s</button><button className={`px-4 py-2 rounded-xl border text-sm font-black ${timeframe==='1m'?'border-cyan-300 bg-cyan-500/15 text-cyan-100':'border-slate-600 text-slate-300'}`} onClick={()=>setTimeframe('1m')}>1m</button><button className="px-4 py-2 rounded-xl border border-cyan-500/30 text-sm font-black text-cyan-100" onClick={()=>void refreshChart()}>↻ Recargar velas</button></div></div>
        <RealtimeChart payload={chart} timeframe={timeframe}/>
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <DiagnosticPanel diagnostic={diagnostic}/>
        <BacktestPanel market={market} backtest={backtest} days={backtestDays} setDays={setBacktestDays} start={()=>void command('/api/backtest/start',{kind:market,days:backtestDays})} forward={comparison}/>
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-2 gap-4">{comparison.map((row:any)=><ComparisonCard key={row.key} row={row}/>)}</section>
    </main>
  </div>;
}

function RealtimeChart({payload,timeframe}:{payload:ChartPayload;timeframe:Timeframe}){
  const candles=((timeframe==='30s'?payload.micro30s:payload.m1)||[]).slice(-100);
  const trades=payload.trades||[];
  if(candles.length<2)return <div className="h-[560px] grid place-items-center text-base text-slate-400">{payload.error||'Esperando datos de mercado…'}</div>;
  const W=1600,H=580,left=78,right=110,top=30,bottom=54;
  const start=candles[0].time,end=candles.at(-1)!.time+(timeframe==='30s'?30_000:60_000);
  const visibleTrades=trades.filter(t=>t.openTime>=start-180_000||(t.closeTime&&t.closeTime>=start-180_000));
  const levels=visibleTrades.flatMap(t=>[t.entryPrice,t.stopLoss,t.takeProfit,t.exitPrice||0]).filter(v=>v>0);
  const live=[Number(payload.bid||0),Number(payload.ask||0)].filter(v=>v>0);
  let min=Math.min(...candles.map(c=>c.low),...(levels.length?levels:[Infinity]),...(live.length?live:[Infinity]));
  let max=Math.max(...candles.map(c=>c.high),...(levels.length?levels:[-Infinity]),...(live.length?live:[-Infinity]));
  const pad=Math.max((max-min)*.09,Math.abs(max)*.00015,1e-6);min-=pad;max+=pad;
  const pw=W-left-right,ph=H-top-bottom;const x=(t:number)=>left+(t-start)/Math.max(1,end-start)*pw;const y=(p:number)=>top+(max-p)/Math.max(1e-12,max-min)*ph;const cw=Math.max(3,Math.min(15,pw/candles.length*.66));
  const mid=live.length===2?(live[0]+live[1])/2:candles.at(-1)!.close;const active=visibleTrades.filter(t=>t.state==='OPEN').at(-1);
  return <div className="relative overflow-hidden"><svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[560px]" preserveAspectRatio="none"><defs><linearGradient id="bg15" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#071827"/><stop offset="55%" stopColor="#04101b"/><stop offset="100%" stopColor="#02060b"/></linearGradient><filter id="g15"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs><rect width={W} height={H} fill="url(#bg15)"/>
    {[0,1,2,3,4,5].map(g=>{const gy=top+g/5*ph;const val=max-g/5*(max-min);return <g key={g}><line x1={left} y1={gy} x2={W-right} y2={gy} stroke="#20344a" strokeWidth="1" strokeDasharray="5 10"/><text x={W-right+12} y={gy+5} fill="#a9bdd2" fontSize="15" fontFamily="JetBrains Mono">{formatPrice(val)}</text></g>})}
    {candles.map((c,i)=>{const cx=x(c.time+(timeframe==='30s'?15_000:30_000));const up=c.close>=c.open;const col=up?'#2dd4bf':'#fb7185';const bt=y(Math.max(c.open,c.close)),bb=y(Math.min(c.open,c.close));return <g key={`${c.time}-${i}`}><line x1={cx} x2={cx} y1={y(c.high)} y2={y(c.low)} stroke={col} strokeWidth="1.5"/><rect x={cx-cw/2} y={bt} width={cw} height={Math.max(2,bb-bt)} rx="1.4" fill={col}/></g>})}
    {active&&<><Level yy={y(active.takeProfit)} x1={left} x2={W-right} color="#34d399" text={`TP ${formatPrice(active.takeProfit)}`}/><Level yy={y(active.entryPrice)} x1={left} x2={W-right} color="#38bdf8" text={`ENTRY ${formatPrice(active.entryPrice)}`}/><Level yy={y(active.stopLoss)} x1={left} x2={W-right} color="#fb7185" text={`SL ${formatPrice(active.stopLoss)}`}/></>}
    {visibleTrades.map(t=>{const ex=x(clamp(t.openTime,start,end)),ey=y(t.entryPrice),buy=t.side==='BUY',col=buy?'#34d399':'#fb7185';return <g key={t.id} filter="url(#g15)"><circle cx={ex} cy={ey} r="7" fill="#02050a" stroke={col} strokeWidth="3"/><text x={ex+12} y={ey-10} fill={col} fontSize="15" fontWeight="900">{t.side}</text>{t.closeTime&&t.exitPrice&&<><circle cx={x(clamp(t.closeTime,start,end))} cy={y(t.exitPrice)} r="7" fill="#02050a" stroke={t.realizedPnl>=0?'#67e8f9':'#fda4af'} strokeWidth="3"/><text x={x(clamp(t.closeTime,start,end))+12} y={y(t.exitPrice)-10} fill={t.realizedPnl>=0?'#67e8f9':'#fda4af'} fontSize="14">{t.closeReason||'EXIT'}</text></>}</g>})}
    {mid>0&&<g filter="url(#g15)"><line x1={left} y1={y(mid)} x2={W-right} y2={y(mid)} stroke="#22d3ee" strokeWidth="2" strokeDasharray="8 5"/><rect x={W-right+4} y={y(mid)-15} width="102" height="30" rx="7" fill="#083344" stroke="#22d3ee"/><text x={W-right+12} y={y(mid)+5} fill="#cffafe" fontSize="15" fontWeight="900" fontFamily="JetBrains Mono">{formatPrice(mid)}</text></g>}
    {[0,1,2,3,4,5].map(g=>{const t=start+g/5*(end-start);return <text key={g} x={x(t)} y={H-18} fill="#9fb2c6" fontSize="14" textAnchor={g===0?'start':g===5?'end':'middle'}>{new Date(t).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:timeframe==='30s'?'2-digit':undefined})}</text>})}
  </svg><div className="absolute top-4 left-4 flex gap-2 flex-wrap"><LiveChip label="BID" value={price(payload.bid)} tone="cyan"/><LiveChip label="ASK" value={price(payload.ask)} tone="violet"/><LiveChip label="SPREAD" value={pct4(payload.spreadPct)}/></div></div>;
}

function BacktestPanel({market,backtest,days,setDays,start,forward}:any){const result=backtest?.result;return <div className="rounded-3xl border border-violet-700/40 bg-slate-950/65 p-5"><div className="flex flex-col md:flex-row md:items-center justify-between gap-3"><div><p className="label text-violet-200">BACKTEST HISTÓRICO · EXCHANGE</p><h3 className="text-xl font-black mt-1">{market==='XAU'?'XAUUSDT Binance':'CLUSDT Aster'}</h3><p className="text-sm text-slate-300 mt-1">1m histórico aproximado vs forward 30s/1m real.</p></div><div className="flex gap-2 flex-wrap">{[7,30,90,'MAX'].map(d=><button key={String(d)} onClick={()=>setDays(d)} className={`px-4 py-2 rounded-xl border text-sm font-black ${days===d?'border-violet-300 bg-violet-500/20 text-white':'border-slate-600 text-slate-300'}`}>{d==='MAX'?'MAX':`${d}D`}</button>)}<button disabled={backtest?.status==='RUNNING'} onClick={start} className="px-5 py-2 rounded-xl border border-violet-300 bg-violet-500/20 text-sm font-black text-white">{backtest?.status==='RUNNING'?'Calculando…':'Ejecutar'}</button></div></div>
  {backtest?.status==='RUNNING'&&<div className="mt-4 rounded-xl bg-violet-500/10 border border-violet-500/30 p-3 text-sm">Páginas: {backtest.progress?.pages||0} · Velas: {(backtest.progress?.candles||0).toLocaleString()} · descargando histórico…</div>}
  {backtest?.error&&<div className="mt-4 text-rose-200 text-sm">{backtest.error}</div>}
  {result&&<><div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4"><KVCard k="WR histórico" v={pct(result.winRate)}/><KVCard k="Trades" v={String(result.trades)}/><KVCard k="Profit Factor" v={result.profitFactor==null?'∞':num(result.profitFactor,2)}/><KVCard k="Retorno" v={pct(result.returnPct)} tone={result.returnPct>=0?'green':'red'}/><KVCard k="Balance final" v={money(result.finalBalance)}/><KVCard k="Max DD" v={pct(result.maxDrawdownPct)}/><KVCard k="Días reales" v={num(result.daysCovered,1)}/><KVCard k="Desde" v={result.from?new Date(result.from).toLocaleDateString():'—'}/></div><p className="text-xs text-slate-400 mt-4 leading-relaxed">{result.note}</p></>}
  <div className="mt-4 border-t border-slate-700 pt-4"><p className="label">FORWARD PAPER ACTUAL</p><div className="grid grid-cols-2 gap-3 mt-2">{(forward||[]).map((r:any)=><div key={r.key} className="rounded-xl bg-black/25 p-3"><b className={r.source==='EXCHANGE'?'text-cyan-200':'text-violet-200'}>{r.source}</b><div className="text-sm mt-2">WR {pct(r.winRate)} · PnL {money(r.netPnl)} · {r.trades} trades</div></div>)}</div></div></div>}

function DiagnosticPanel({diagnostic}:any){return <div className="rounded-3xl border border-cyan-700/40 bg-slate-950/65 p-5"><p className="label text-cyan-200">DIAGNÓSTICO DE SEÑAL</p><div className="grid grid-cols-3 gap-3 mt-3"><KVCard k="LONG" v={num(diagnostic.longScore,0)} tone={diagnostic.longScore>=diagnostic.threshold?'green':undefined}/><KVCard k="SHORT" v={num(diagnostic.shortScore,0)} tone={diagnostic.shortScore>=diagnostic.threshold?'green':undefined}/><KVCard k="UMBRAL" v={num(diagnostic.threshold,0)}/></div><p className="mt-4 text-sm font-black">{diagnostic.reason||'Esperando cálculo'}</p>{diagnostic.blockedBy&&<p className="mt-2 text-sm text-amber-200">Bloqueado por: {diagnostic.blockedBy}</p>}<div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4"><ComponentList title="Confluencias LONG" rows={diagnostic.componentsLong}/><ComponentList title="Confluencias SHORT" rows={diagnostic.componentsShort}/></div></div>}
function ComponentList({title,rows}:any){return <div className="rounded-xl border border-slate-700 bg-black/20 p-3"><b className="text-sm text-slate-200">{title}</b><div className="mt-2 flex flex-wrap gap-2">{(rows||[]).length?(rows||[]).map((r:string,i:number)=><span key={i} className="px-2.5 py-1 rounded-lg bg-slate-800 text-xs text-slate-200">{r}</span>):<span className="text-xs text-slate-500">Sin confluencias suficientes</span>}</div></div>}
function AccountCard({title,paper,subtitle}:any){return <div className="rounded-2xl border border-emerald-700/35 bg-slate-950/65 p-4"><p className="label text-emerald-200">{title}</p><div className="flex items-end justify-between mt-2"><div><p className="text-3xl font-black">{money(paper.equity??50)}</p><p className="text-xs text-slate-300 mt-1">{subtitle}</p></div><Pill text={`Inicio ${money(paper.initialBalance??50)}`} tone="green"/></div><div className="grid grid-cols-3 gap-2 mt-4"><KV k="PnL" v={money(paper.realizedPnl)}/><KV k="WR" v={pct(paper.winRate)}/><KV k="Trades" v={String(paper.closedTrades??0)}/></div></div>}
function ScoreCard({diagnostic}:any){const action=diagnostic.action||'WAIT';return <div className="rounded-2xl border border-cyan-700/35 bg-slate-950/65 p-4"><p className="label text-cyan-200">SEÑAL EN VIVO</p><div className="flex items-center justify-between mt-2"><b className={`text-3xl ${action==='BUY'?'text-emerald-300':action==='SELL'?'text-rose-300':'text-slate-300'}`}>{action}</b><span className="text-xl font-black">{num(diagnostic.score,0)} / {num(diagnostic.threshold,0)}</span></div><p className="text-xs text-slate-300 mt-2">{diagnostic.reason||'Calculando…'}</p></div>}
function ComparisonCard({row}:any){return <div className="rounded-2xl border border-slate-700 bg-slate-950/60 p-4"><div className="flex justify-between"><div><p className="label">{row.display}</p><h3 className={`text-xl font-black ${row.source==='EXCHANGE'?'text-cyan-200':'text-violet-200'}`}>{row.source}</h3></div><Pill text={`${row.trades} trades`} tone={row.source==='EXCHANGE'?'cyan':'violet'}/></div><div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4"><KVCard k="WR" v={pct(row.winRate)}/><KVCard k="PnL" v={money(row.netPnl)} tone={row.netPnl>=0?'green':'red'}/><KVCard k="PF" v={row.profitFactor==null?'∞':num(row.profitFactor,2)}/><KVCard k="Spread" v={pct4(row.avgSpreadPct)}/></div></div>}
function UpdateControl({updater,auto,setAuto,check,apply,disabled,busy}:any){return <div className="flex items-center gap-1 rounded-xl border border-slate-600 bg-slate-950/80 p-1"><button onClick={()=>void check()} className="px-3 py-2 text-xs font-black text-slate-200">Buscar update</button><button disabled={disabled||busy||!updater.updateAvailable} onClick={apply} className="px-3 py-2 rounded-lg border border-cyan-400/30 bg-cyan-500/10 text-xs font-black text-cyan-100 disabled:opacity-30">{busy?'Actualizando…':updater.updateAvailable?'Actualizar ahora':'Al día'}</button><label className="px-2 flex gap-2 items-center text-xs text-slate-300"><input type="checkbox" checked={auto} onChange={e=>setAuto(e.target.checked)}/>Auto</label></div>}
function BigSelect({active,title,subtitle,onClick}:any){return <button onClick={onClick} className={`rounded-2xl px-5 py-4 text-left border ${active?'border-cyan-300/50 bg-cyan-500/10':'border-transparent hover:bg-white/[.04]'}`}><p className="text-lg font-black">{title}</p><p className="text-xs text-slate-300 mt-1">{subtitle}</p></button>}
function Conn({label,ok}:any){return <span className={`h-11 px-3 rounded-xl border flex items-center gap-2 text-xs font-black ${ok?'border-emerald-400/30 text-emerald-200':'border-slate-700 text-slate-400'}`}><i className={`w-2 h-2 rounded-full ${ok?'bg-emerald-400':'bg-slate-600'}`}/>{label}</span>}
function Pill({text,tone='slate'}:any){const c:any={cyan:'border-cyan-400/35 bg-cyan-500/10 text-cyan-100',green:'border-emerald-400/35 bg-emerald-500/10 text-emerald-100',red:'border-rose-400/35 bg-rose-500/10 text-rose-100',amber:'border-amber-400/35 bg-amber-500/10 text-amber-100',violet:'border-violet-400/35 bg-violet-500/10 text-violet-100',slate:'border-slate-600 bg-slate-900 text-slate-200'};return <span className={`px-3 py-1 rounded-full border text-xs font-black uppercase ${c[tone]}`}>{text}</span>}
function LiveChip({label,value,tone}:any){return <div className={`px-4 py-2 rounded-xl border bg-black/65 backdrop-blur text-sm font-mono ${tone==='cyan'?'border-cyan-400/35 text-cyan-100':tone==='violet'?'border-violet-400/35 text-violet-100':'border-slate-500 text-slate-100'}`}><span className="text-slate-300">{label} </span><b>{value}</b></div>}
function Level({yy,x1,x2,color,text}:any){return <g><line x1={x1} y1={yy} x2={x2} y2={yy} stroke={color} strokeWidth="1.8" strokeDasharray="10 7"/><text x={x1+10} y={yy-7} fill={color} fontSize="15" fontWeight="900">{text}</text></g>}
function KV({k,v}:any){return <div><p className="text-xs text-slate-400">{k}</p><p className="text-sm font-black mt-1">{v}</p></div>}
function KVCard({k,v,tone}:any){return <div className="rounded-xl border border-slate-700 bg-black/25 p-3"><p className="text-xs text-slate-400">{k}</p><p className={`text-base font-black mt-1 ${tone==='green'?'text-emerald-300':tone==='red'?'text-rose-300':'text-slate-100'}`}>{v}</p></div>}
function findInstrument(service:any,market:MarketKind){const rows=Array.isArray(service?.instruments)?service.instruments:[];return rows.find((r:any)=>String(r.kind).toUpperCase()===market)}
function mergeTick(old:ChartPayload,tick:any):ChartPayload{const next={...old,bid:tick.bid??old.bid,ask:tick.ask??old.ask,spreadPct:tick.spreadPct??old.spreadPct,diagnostic:tick.diagnostic??old.diagnostic,updatedAt:tick.time??Date.now()};if(tick.microLast){const rows=[...(next.micro30s||[])];const idx=rows.findIndex(r=>r.time===tick.microLast.time);if(idx>=0)rows[idx]=tick.microLast;else rows.push(tick.microLast);next.micro30s=rows.slice(-180);}return next}
function price(v:any){const n=Number(v);if(!Number.isFinite(n)||n<=0)return'—';return n>=1000?n.toFixed(2):n>=100?n.toFixed(3):n>=1?n.toFixed(4):n.toFixed(6)}
function formatPrice(n:number){return n>=1000?n.toFixed(2):n>=100?n.toFixed(3):n>=1?n.toFixed(4):n.toFixed(6)}
function money(v:any){const n=Number(v||0);return `${n<0?'-':''}$${Math.abs(n).toFixed(2)}`}
function pct(v:any){const n=Number(v);return Number.isFinite(n)?`${n.toFixed(1)}%`:'—'}
function pct4(v:any){const n=Number(v);return Number.isFinite(n)?`${n.toFixed(4)}%`:'—'}
function num(v:any,d=1){const n=Number(v);return Number.isFinite(n)?n.toFixed(d):'—'}
function clamp(v:number,min:number,max:number){return Math.max(min,Math.min(max,v))}
function msg(e:any){return e instanceof Error?e.message:String(e)}
