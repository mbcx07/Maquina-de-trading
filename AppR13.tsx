import React, { useEffect, useMemo, useState } from 'react';

const API = (import.meta as any).env?.VITE_V34_API_BASE || '/backend';

type CryptoTrade = {
  id:string; symbol:string; side:'BUY'|'SELL'; state:string; entryPrice:number; stopLoss:number; takeProfit:number;
  leverage?:number; unrealizedPnl?:number; realizedPnl?:number; rollingWinRate?:number; confidence?:number;
  openTime?:number; closeTime?:number; closeReason?:string; marginUsed?:number;
};
type Opportunity = { symbol:string; side:'BUY'|'SELL'; score:number; confidence:number; rollingWinRate:number; entry:number; stopLoss:number; takeProfit:number; createdAt:number };
type Instrument = { symbol:string; display:string; venue:string; allowedSides:string; book?:any; spreadPct?:number; lastDiagnostic?:any; error?:string };
type CommodityTrade = { id:string; symbol:string; displaySymbol:string; venue:string; side:'BUY'|'SELL'; state:string; entryPrice:number; exitPrice?:number; stopLoss:number; takeProfit:number; leverage:number; realizedPnl:number; unrealizedPnl:number; openTime:number; closeTime?:number; closeReason?:string };

type AppState = {
  release?:string; edition?:string; mode?:string; engineEnabled?:boolean; settings?:any; brokers?:any;
  crypto?: { scanner?:any; audit?:any; active?:CryptoTrade[]; slots?:{used:number;max:number;free:number}; opportunities?:Opportunity[]; recentTrades?:CryptoTrade[]; metrics?:any; paper?:any; reversalGuard?:any };
  commodities?: { realExecutionLocked?:boolean; policy?:any; scalper?:any };
};

export default function AppR13(){
  const [state,setState]=useState<AppState>({});
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [slotDraft,setSlotDraft]=useState(10);

  const refresh=async()=>{
    try{
      const r=await fetch(`${API}/api/state?ts=${Date.now()}`,{cache:'no-store'});
      const body=await r.json().catch(()=>({}));
      if(!r.ok) throw new Error(body.error||`STATE_HTTP_${r.status}`);
      setState(body);
      setSlotDraft(Number(body.settings?.maxConcurrentCryptoTrades||10));
      setError('');
    }catch(e){setError(e instanceof Error?e.message:String(e));}
  };
  useEffect(()=>{void refresh(); const timer=setInterval(()=>void refresh(),2000); return()=>clearInterval(timer);},[]);

  const command=async(path:string,body?:any)=>{
    setBusy(true);
    try{
      const r=await fetch(`${API}${path}`,{method:body?'PATCH':'POST',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});
      const data=await r.json().catch(()=>({}));
      if(!r.ok) throw new Error(data.error||data.detail||`HTTP_${r.status}`);
      await refresh();
    }catch(e){setError(e instanceof Error?e.message:String(e));}
    finally{setBusy(false);}
  };

  const crypto=state.crypto||{};
  const scanner=crypto.scanner||{};
  const audit=crypto.audit||{};
  const slots=crypto.slots||{used:0,max:10,free:10};
  const active=Array.isArray(crypto.active)?crypto.active:[];
  const opps=Array.isArray(crypto.opportunities)?crypto.opportunities:[];
  const recent=Array.isArray(crypto.recentTrades)?crypto.recentTrades:[];
  const paper=crypto.paper||{};
  const cstate=state.commodities?.scalper||{};
  const instruments:Array<Instrument>=Array.isArray(cstate.instruments)?cstate.instruments:[];
  const xau=instruments.find(x=>x.symbol==='XAUUSDT');
  const crude=instruments.find(x=>x.symbol==='CLUSDT');
  const commodityTrades:Array<CommodityTrade>=Array.isArray(cstate.recentTrades)?cstate.recentTrades:[];
  const commodityPaper=cstate.paper||{};
  const metrics=crypto.metrics?.global||{};

  return <div className="min-h-screen bg-[#02050a] text-slate-100">
    <header className="sticky top-0 z-40 border-b border-slate-800 bg-[#02050a]/95 backdrop-blur-xl">
      <div className="max-w-[1900px] mx-auto px-4 lg:px-6 py-4 flex flex-col 2xl:flex-row 2xl:items-center justify-between gap-4">
        <div>
          <div className="flex flex-wrap gap-2 items-center">
            <Badge text="QUANTUM R13" tone="cyan"/><Badge text={state.mode||'PAPER'} tone={state.mode==='REAL'?'red':'amber'}/><Badge text={state.engineEnabled?'ENGINE ON':'ENGINE PAUSED'} tone={state.engineEnabled?'green':'slate'}/>
          </div>
          <h1 className="mt-2 text-2xl md:text-3xl font-black">CRYPTO FAST + <span className="text-cyan-400">XAU / CRUDE</span></h1>
          <p className="mt-1 text-[9px] uppercase tracking-[.18em] text-slate-500">Crypto R11 M5/M15 · ejecución concurrente · XAU/Crude 30s/1m · Forex OFF</p>
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          <button disabled={busy} onClick={()=>void command('/api/run')} className="btn border-cyan-500/40 text-cyan-300 bg-cyan-500/10">Escanear ahora</button>
          {state.engineEnabled
            ? <button disabled={busy} onClick={()=>void command('/api/pause')} className="btn border-amber-500/40 text-amber-300 bg-amber-500/10">Pausar</button>
            : <button disabled={busy} onClick={()=>void command('/api/start')} className="btn border-emerald-500/40 text-emerald-300 bg-emerald-500/10">Iniciar automático</button>}
        </div>
      </div>
    </header>

    <main className="max-w-[1900px] mx-auto p-4 lg:p-6 space-y-6">
      {error&&<div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 p-4 text-rose-300 text-sm"><b>Error:</b> {error}</div>}

      <section className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-10 gap-2">
        <Metric label="Slots Crypto" value={`${slots.used}/${slots.max}`} tone={slots.free>0?'green':'amber'}/>
        <Metric label="Slots libres" value={String(slots.free)} />
        <Metric label="Escaneadas" value={String(scanner.scanned??0)} />
        <Metric label="Oportunidades" value={String(scanner.opportunities??0)} />
        <Metric label="Ejecutadas ciclo" value={String(scanner.executed??0)} tone={Number(scanner.executed)>0?'green':undefined}/>
        <Metric label="Modelos aptos" value={String(scanner.qualifiedUniverse??0)} />
        <Metric label="Balance PAPER" value={money(paper.balance)} />
        <Metric label="Equity PAPER" value={money(paper.equity)} />
        <Metric label="WR Crypto" value={pct(metrics.winRate)} />
        <Metric label="PnL Crypto" value={money(metrics.netProfit)} tone={Number(metrics.netProfit)>=0?'green':'red'} />
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-[1.05fr_.95fr] gap-5 items-start">
        <Card title="CRYPTO R11 · SCANNER CONTINUO" subtitle="El scanner no se detiene por tener posiciones abiertas">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <Small label="Estado" value={scanner.status||'—'}/><Small label="TF" value={scanner.timeframe||'5m/15m'}/><Small label="Chunk" value={String(scanner.concurrency?.scanChunkSize||8)}/><Small label="Ejecución" value="PARALELA" tone="green"/>
            <Small label="Universo líquido" value={String(scanner.liquidUniverse??'—')}/><Small label="Aptos R11" value={String(scanner.qualifiedUniverse??0)}/><Small label="Seleccionadas" value={String(scanner.selected??0)}/><Small label="Errores" value={String(scanner.errors??0)} tone={Number(scanner.errors)>0?'red':undefined}/>
          </div>
          <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-[9px] leading-5 text-slate-400">
            <b className="text-cyan-300">Anti-entrada tardía:</b> una oportunidad vence a los 25 s y se descarta si el Mark Price se aleja más de 0.25R del retest. Las oportunidades válidas de cada bloque se mandan al executor inmediatamente, sin esperar a que termine todo el universo.
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <Small label="Audit" value={audit.status||scanner.auditProgress?.status||'—'}/><Small label="Progreso" value={`${audit.completed??scanner.auditProgress?.completed??0}/${audit.total??scanner.auditProgress?.total??0}`}/>
          </div>
          <div className="mt-4 flex flex-wrap gap-1.5">
            {(scanner.qualifiedSymbols||audit.qualifiedSymbols||[]).slice(0,60).map((s:string)=><span key={s} className="px-2 py-1 rounded-lg border border-emerald-500/20 bg-emerald-500/5 text-[8px] text-emerald-300">{s}</span>)}
            {!(scanner.qualifiedSymbols||audit.qualifiedSymbols||[]).length&&<span className="text-[9px] text-slate-600">La auditoría todavía no ha aprobado símbolos.</span>}
          </div>
          {!!scanner.lastExecutionErrors?.length&&<div className="mt-4 rounded-xl border border-rose-500/20 bg-rose-500/5 p-3"><p className="text-[8px] uppercase text-rose-400 font-black">Últimos rechazos de ejecución</p>{scanner.lastExecutionErrors.map((e:string,i:number)=><p key={i} className="mt-1 text-[8px] text-rose-300/80 break-all">{e}</p>)}</div>}
        </Card>

        <Card title="CONFIGURACIÓN DE CONCURRENCIA" subtitle="El valor antiguo de 1 slot migra automáticamente a 10">
          <div className="grid grid-cols-3 gap-2">
            <Metric label="Usados" value={String(slots.used)}/><Metric label="Libres" value={String(slots.free)} tone="green"/><Metric label="Máximo" value={String(slots.max)}/>
          </div>
          <div className="mt-4 flex gap-2 items-end">
            <label className="flex-1"><span className="block mb-2 text-[8px] uppercase tracking-widest text-slate-500">Máx. operaciones Crypto simultáneas</span><select value={slotDraft} onChange={e=>setSlotDraft(Number(e.target.value))} className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-3 text-sm">{Array.from({length:10},(_,i)=>i+1).map(n=><option key={n} value={n}>{n}</option>)}</select></label>
            <button disabled={busy} onClick={()=>void command('/api/settings',{maxConcurrentCryptoTrades:slotDraft})} className="btn border-cyan-500/40 text-cyan-300 bg-cyan-500/10">Guardar</button>
          </div>
          <div className="mt-4 text-[9px] text-slate-500 leading-5">El límite de exposición de cuenta sigue activo. Tener 10 slots no obliga a abrir 10 operaciones; solo evita que una posición abierta bloquee oportunidades válidas de otros símbolos.</div>
        </Card>
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        <Card title={`POSICIONES CRYPTO ABIERTAS · ${active.length}`} subtitle="Una posición por símbolo; varios símbolos pueden abrir en paralelo">
          {active.length?<div className="grid grid-cols-1 md:grid-cols-2 gap-2">{active.map(t=><TradeCard key={t.id} trade={t}/>)}</div>:<Empty text="Sin posiciones Crypto abiertas"/>}
        </Card>
        <Card title={`OPORTUNIDADES RECIENTES · ${opps.length}`} subtitle="Solo retests recientes; no se persiguen señales viejas">
          <OpportunityTable rows={opps}/>
        </Card>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-950/40 overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-800"><p className="text-[9px] font-black uppercase tracking-[.18em] text-slate-300">Historial Crypto</p></div>
        <CryptoTable rows={recent.slice(0,100)}/>
      </section>

      <div className="pt-2"><p className="text-[9px] font-black tracking-[.2em] text-slate-500 uppercase">TradFi / Commodities · reemplaza Forex</p><h2 className="mt-1 text-2xl font-black">XAUUSD + CRUDE OIL</h2></div>
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
        <InstrumentPanel title="XAUUSD" subtitle="Gold · Binance Futures" instrument={xau} trade={commodityTrades.find(t=>t.symbol==='XAUUSDT'&&t.state==='OPEN')} badge="BUY / SELL"/>
        <InstrumentPanel title="CRUDE OIL" subtitle="CLUSDT · Aster" instrument={crude} trade={commodityTrades.find(t=>t.symbol==='CLUSDT'&&t.state==='OPEN')} badge="BUY ONLY" green/>
      </section>
      <section className="grid grid-cols-2 md:grid-cols-6 gap-2">
        <Metric label="Commodity balance" value={money(commodityPaper.balance)}/><Metric label="Commodity equity" value={money(commodityPaper.equity)}/><Metric label="Commodity PnL" value={money(commodityPaper.realizedPnl)} tone={Number(commodityPaper.realizedPnl)>=0?'green':'red'}/><Metric label="Commodity WR" value={pct(commodityPaper.winRate)}/><Metric label="Abiertas" value={String(commodityPaper.openPositions??0)}/><Metric label="Crude" value="BUY ONLY" tone="green"/>
      </section>
    </main>
  </div>;
}

function Card({title,subtitle,children}:{title:string;subtitle?:string;children:React.ReactNode}){return <section className="rounded-2xl border border-slate-800 bg-slate-950/45 p-4"><div className="mb-4"><p className="text-[9px] font-black uppercase tracking-[.18em] text-slate-300">{title}</p>{subtitle&&<p className="mt-1 text-[8px] text-slate-600">{subtitle}</p>}</div>{children}</section>}
function Badge({text,tone}:{text:string;tone:string}){const c=tone==='green'?'border-emerald-500/30 bg-emerald-500/10 text-emerald-300':tone==='red'?'border-rose-500/30 bg-rose-500/10 text-rose-300':tone==='amber'?'border-amber-500/30 bg-amber-500/10 text-amber-300':tone==='cyan'?'border-cyan-500/30 bg-cyan-500/10 text-cyan-300':'border-slate-700 bg-slate-900 text-slate-400';return <span className={`px-2.5 py-1 rounded-full border text-[8px] font-black tracking-widest ${c}`}>{text}</span>}
function Metric({label,value,tone}:{label:string;value:string;tone?:string}){return <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 min-w-0"><p className="text-[7px] uppercase tracking-widest text-slate-600">{label}</p><p className={`mt-1 text-sm font-black truncate ${tone==='green'?'text-emerald-400':tone==='red'?'text-rose-400':tone==='amber'?'text-amber-300':'text-slate-200'}`}>{value}</p></div>}
function Small({label,value,tone}:{label:string;value:string;tone?:string}){return <div className="rounded-xl border border-slate-800/80 bg-black/20 p-2"><p className="text-[7px] uppercase text-slate-600">{label}</p><p className={`mt-1 text-[9px] font-black break-words ${tone==='green'?'text-emerald-400':tone==='red'?'text-rose-400':'text-slate-300'}`}>{value}</p></div>}
function Empty({text}:{text:string}){return <div className="py-10 text-center text-[9px] uppercase tracking-widest text-slate-700">{text}</div>}
function TradeCard({trade:t}:{trade:CryptoTrade}){return <div className="rounded-xl border border-slate-800 bg-black/20 p-3"><div className="flex justify-between"><b>{t.symbol}</b><span className={t.side==='BUY'?'text-emerald-400':'text-rose-400'}>{t.side}</span></div><div className="grid grid-cols-2 gap-2 mt-3"><Small label="Entry" value={price(t.entryPrice)}/><Small label="PnL" value={money(t.unrealizedPnl)} tone={Number(t.unrealizedPnl)>=0?'green':'red'}/><Small label="SL" value={price(t.stopLoss)}/><Small label="TP" value={price(t.takeProfit)}/><Small label="Lev" value={`${t.leverage??'—'}x`}/><Small label="WR modelo" value={pct(t.rollingWinRate)}/></div></div>}
function OpportunityTable({rows}:{rows:Opportunity[]}){if(!rows.length)return <Empty text="Sin retests ejecutables en los últimos segundos"/>;return <div className="overflow-auto max-h-[360px]"><table className="w-full min-w-[700px] text-[8px]"><thead className="text-slate-600 uppercase"><tr><th className="p-2 text-left">Símbolo</th><th>Side</th><th>Score</th><th>WR</th><th>Conf</th><th>Entry</th><th>Edad</th></tr></thead><tbody>{rows.map((r,i)=><tr key={`${r.symbol}-${i}`} className="border-t border-slate-900"><td className="p-2 font-black">{r.symbol}</td><td className={`text-center ${r.side==='BUY'?'text-emerald-400':'text-rose-400'}`}>{r.side}</td><td className="text-center">{num(r.score,1)}</td><td className="text-center">{pct(r.rollingWinRate)}</td><td className="text-center">{pct(r.confidence)}</td><td className="text-center">{price(r.entry)}</td><td className="text-center">{Math.max(0,(Date.now()-r.createdAt)/1000).toFixed(0)}s</td></tr>)}</tbody></table></div>}
function CryptoTable({rows}:{rows:CryptoTrade[]}){if(!rows.length)return <Empty text="Sin historial Crypto"/>;return <div className="overflow-auto"><table className="w-full min-w-[900px] text-[8px]"><thead className="text-slate-600 uppercase"><tr><th className="p-3 text-left">Símbolo</th><th>Side</th><th>Estado</th><th>Entry</th><th>SL</th><th>TP</th><th>Lev</th><th>PnL</th><th>Cierre</th></tr></thead><tbody>{rows.map(t=><tr key={t.id} className="border-t border-slate-900"><td className="p-3 font-black">{t.symbol}</td><td className={`text-center ${t.side==='BUY'?'text-emerald-400':'text-rose-400'}`}>{t.side}</td><td className="text-center">{t.state}</td><td className="text-center">{price(t.entryPrice)}</td><td className="text-center">{price(t.stopLoss)}</td><td className="text-center">{price(t.takeProfit)}</td><td className="text-center">{t.leverage??'—'}x</td><td className={`text-center ${Number(t.realizedPnl)>=0?'text-emerald-400':'text-rose-400'}`}>{money(t.state==='OPEN'?t.unrealizedPnl:t.realizedPnl)}</td><td className="text-center">{t.closeReason||'—'}</td></tr>)}</tbody></table></div>}
function InstrumentPanel({title,subtitle,instrument,trade,badge,green}:{title:string;subtitle:string;instrument?:Instrument;trade?:CommodityTrade;badge:string;green?:boolean}){const d=instrument?.lastDiagnostic||{},b=instrument?.book||{};return <Card title={title} subtitle={subtitle}><div className="flex justify-between mb-3"><Badge text={badge} tone={green?'green':'cyan'}/><Badge text={instrument?.error?'DATA ERROR':d.action||'WAIT'} tone={d.action==='BUY'?'green':d.action==='SELL'?'red':'slate'}/></div>{instrument?.error&&<div className="mb-3 text-[8px] text-rose-300 break-all">{instrument.error}</div>}<div className="grid grid-cols-2 md:grid-cols-4 gap-2"><Small label="Bid" value={price(b.bid)}/><Small label="Ask" value={price(b.ask)}/><Small label="Spread" value={pct4(instrument?.spreadPct)}/><Small label="Score" value={num(d.score,0)}/><Small label="Costo RT" value={pct4(d.costPct)}/><Small label="TP bruto" value={pct4(d.targetPct)}/><Small label="RSI 1m" value={num(d.rsi,1)}/><Small label="Taker BUY" value={Number.isFinite(Number(d.takerBuyRatio))?`${(Number(d.takerBuyRatio)*100).toFixed(1)}%`:'—'}/></div>{trade&&<div className="mt-3 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3"><div className="flex justify-between"><b>{trade.side} OPEN</b><span className={Number(trade.unrealizedPnl)>=0?'text-emerald-400':'text-rose-400'}>{money(trade.unrealizedPnl)}</span></div><p className="mt-1 text-[8px] text-slate-500">Entry {price(trade.entryPrice)} · SL {price(trade.stopLoss)} · TP {price(trade.takeProfit)} · {trade.leverage}x</p></div>}</Card>}

function money(v:any){const n=Number(v);return Number.isFinite(n)?`${n<0?'-':''}$${Math.abs(n).toFixed(2)}`:'—'}
function pct(v:any){const n=Number(v);return Number.isFinite(n)?`${n.toFixed(2)}%`:'—'}
function pct4(v:any){const n=Number(v);return Number.isFinite(n)?`${n.toFixed(4)}%`:'—'}
function price(v:any){const n=Number(v);if(!Number.isFinite(n)||n<=0)return'—';return n>=1000?n.toFixed(2):n>=10?n.toFixed(3):n.toFixed(6)}
function num(v:any,d=2){const n=Number(v);return Number.isFinite(n)?n.toFixed(d):'—'}
