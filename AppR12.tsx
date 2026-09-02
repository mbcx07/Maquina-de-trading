import React, { useEffect, useMemo, useState } from 'react';

type InstrumentState = {
  symbol: string;
  display: string;
  venue: string;
  allowedSides: string;
  book?: { bid?: number; ask?: number; bidQty?: number; askQty?: number; time?: number };
  spreadPct?: number;
  lastDiagnostic?: {
    action?: string;
    reason?: string;
    score?: number;
    spreadPct?: number;
    costPct?: number;
    targetPct?: number;
    stopPct?: number;
    rsi?: number;
    takerBuyRatio?: number;
  };
  error?: string;
};

type CommodityTrade = {
  id: string;
  venue: string;
  mode: string;
  symbol: string;
  displaySymbol: string;
  side: 'BUY' | 'SELL';
  state: string;
  entryPrice: number;
  exitPrice?: number;
  stopLoss: number;
  takeProfit: number;
  quantity: number;
  leverage: number;
  marginUsed: number;
  notional: number;
  entrySpreadPct: number;
  estimatedRoundTripCostPct: number;
  entryFee: number;
  exitFee: number;
  realizedPnl: number;
  unrealizedPnl: number;
  openTime: number;
  closeTime?: number;
  closeReason?: string;
  metadata?: Record<string, any>;
};

type State = {
  ok?: boolean;
  release?: string;
  mode?: string;
  realExecutionLocked?: boolean;
  policy?: any;
  brokers?: any;
  scalper?: {
    status?: string;
    enabled?: boolean;
    completedAt?: number;
    timeframe?: string;
    instruments?: InstrumentState[];
    paper?: any;
    recentTrades?: CommodityTrade[];
    policy?: any;
  };
};

type RangeKey = 'day' | 'week' | 'month' | 'year';
const RANGE_MS: Record<RangeKey, number> = {
  day: 24 * 60 * 60_000,
  week: 7 * 24 * 60 * 60_000,
  month: 30 * 24 * 60 * 60_000,
  year: 365 * 24 * 60 * 60_000,
};
const RANGE_LABEL: Record<RangeKey, string> = { day: 'Día', week: 'Semana', month: 'Mes', year: 'Año' };

const API = (import.meta as any).env?.VITE_V34_API_BASE || '/backend';

export default function AppR12() {
  const [state, setState] = useState<State>({});
  const [trades, setTrades] = useState<CommodityTrade[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = async () => {
    try {
      const [stateResponse, tradeResponse] = await Promise.all([
        fetch(`${API}/api/state`, { cache: 'no-store' }),
        fetch(`${API}/api/trades?limit=500`, { cache: 'no-store' }),
      ]);
      if (!stateResponse.ok) throw new Error(`STATE_HTTP_${stateResponse.status}`);
      const s = await stateResponse.json();
      const t = tradeResponse.ok ? await tradeResponse.json() : { trades: [] };
      setState(s);
      setTrades(Array.isArray(t.trades) ? t.trades : []);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, []);

  const command = async (path: '/api/start' | '/api/pause') => {
    setBusy(true);
    try {
      const response = await fetch(`${API}${path}`, { method: 'POST' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP_${response.status}`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const scalper = state.scalper || {};
  const paper = scalper.paper || {};
  const instruments = Array.isArray(scalper.instruments) ? scalper.instruments : [];
  const xau = instruments.find((item) => item.symbol === 'XAUUSDT');
  const crude = instruments.find((item) => item.symbol === 'CLUSDT');
  const activeTrades: CommodityTrade[] = Array.isArray(paper.activeTrades) ? paper.activeTrades : trades.filter((trade) => trade.state === 'OPEN');

  return (
    <div className="min-h-screen bg-[#03060b] text-slate-100">
      <header className="sticky top-0 z-40 border-b border-slate-800/80 bg-[#03060b]/95 backdrop-blur-xl">
        <div className="max-w-[1800px] mx-auto px-4 lg:px-6 py-4 flex flex-col xl:flex-row xl:items-center justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="px-2.5 py-1 rounded-full border border-cyan-500/35 bg-cyan-500/10 text-[9px] font-black tracking-[.2em] text-cyan-300">QUANTUM R12</span>
              <ModeBadge mode={state.mode || 'PAPER'} locked={Boolean(state.realExecutionLocked)} />
              <StatusBadge status={scalper.status || (loading ? 'LOADING' : 'UNKNOWN')} />
            </div>
            <h1 className="mt-2 text-2xl md:text-3xl font-black tracking-tight">COMMODITIES SCALPER <span className="text-cyan-400">30s / 1m</span></h1>
            <p className="mt-1 text-[10px] text-slate-500 uppercase tracking-[.16em]">Solo XAUUSD + Crude Oil · spread real · costos antes de entrar</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="px-3 py-2 rounded-xl border border-slate-800 bg-slate-950/70 text-[9px]">
              <span className="text-slate-500">Último ciclo </span>
              <b>{scalper.completedAt ? new Date(scalper.completedAt).toLocaleTimeString() : '—'}</b>
            </div>
            {scalper.enabled !== false ? (
              <button disabled={busy} onClick={() => void command('/api/pause')} className="px-4 py-2 rounded-xl border border-amber-500/40 bg-amber-500/10 text-amber-300 text-[9px] font-black uppercase tracking-widest disabled:opacity-40">Pausar</button>
            ) : (
              <button disabled={busy} onClick={() => void command('/api/start')} className="px-4 py-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 text-[9px] font-black uppercase tracking-widest disabled:opacity-40">Iniciar automático</button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-[1800px] mx-auto p-4 lg:p-6 space-y-5">
        {error && <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300"><b>Error:</b> {error}</div>}

        <section className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-2">
          <Metric label="Balance PAPER" value={money(paper.balance)} />
          <Metric label="Equity PAPER" value={money(paper.equity)} />
          <Metric label="PnL realizado" value={money(paper.realizedPnl)} tone={Number(paper.realizedPnl) >= 0 ? 'green' : 'red'} />
          <Metric label="PnL flotante" value={money(paper.floatingPnl)} tone={Number(paper.floatingPnl) >= 0 ? 'green' : 'red'} />
          <Metric label="Win rate" value={pct(paper.winRate)} />
          <Metric label="Cerradas" value={String(paper.closedTrades ?? 0)} />
          <Metric label="Abiertas" value={String(paper.openPositions ?? 0)} />
          <Metric label="Margen / trade" value="1.00%" />
        </section>

        <section className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
          <InstrumentPanel
            title="XAUUSD"
            subtitle="Gold · Binance Futures"
            symbol="XAUUSDT"
            instrument={xau}
            sideBadge="BUY / SELL"
            sideTone="cyan"
            brokerConfigured={state.brokers?.binance?.configured}
            trade={activeTrades.find((trade) => trade.symbol === 'XAUUSDT')}
          />
          <InstrumentPanel
            title="CRUDE OIL"
            subtitle="Crude Oil · Aster Perpetual"
            symbol="CLUSDT"
            instrument={crude}
            sideBadge="BUY ONLY"
            sideTone="green"
            brokerConfigured={state.brokers?.aster?.privateConfigured}
            trade={activeTrades.find((trade) => trade.symbol === 'CLUSDT')}
          />
        </section>

        <section className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <PerformanceChart title="XAUUSD · GANANCIA NETA" trades={trades.filter((trade) => trade.symbol === 'XAUUSDT')} />
          <PerformanceChart title="CRUDE OIL · GANANCIA NETA" trades={trades.filter((trade) => trade.symbol === 'CLUSDT')} />
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-950/45 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-800 flex flex-wrap justify-between gap-2">
            <div><p className="text-[9px] font-black uppercase tracking-[.18em] text-slate-400">Historial R12</p><p className="text-[8px] text-slate-600 mt-1">PnL neto incluye comisiones estimadas y spread de ejecución PAPER.</p></div>
            <span className="text-[8px] text-slate-600">{trades.length} registros</span>
          </div>
          <TradeTable trades={trades.slice(0, 100)} />
        </section>

        <section className="grid grid-cols-1 md:grid-cols-3 gap-3 text-[9px]">
          <InfoCard title="Regla de costos">TP bruto mínimo = <b>2.5×</b> (spread + comisión entrada + comisión salida + slippage). Si no hay margen suficiente después de costos, no abre.</InfoCard>
          <InfoCard title="Crude Oil">La dirección <b className="text-emerald-400">SELL está deshabilitada en código</b>. Aunque aparezca tendencia bajista, CLUSDT no puede abrir corto.</InfoCard>
          <InfoCard title="REAL protegido">La ejecución REAL R12 está bloqueada por defecto. PAPER usa mercado real; REAL requiere habilitación explícita y credenciales privadas de cada venue.</InfoCard>
        </section>
      </main>
    </div>
  );
}

function InstrumentPanel({ title, subtitle, symbol, instrument, sideBadge, sideTone, brokerConfigured, trade }: any) {
  const book = instrument?.book || {};
  const diagnostic = instrument?.lastDiagnostic || {};
  const spread = Number(instrument?.spreadPct ?? diagnostic.spreadPct);
  const action = diagnostic.action || (instrument?.error ? 'ERROR' : 'WAIT');
  const actionClass = action === 'BUY' ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' : action === 'SELL' ? 'text-rose-400 border-rose-500/30 bg-rose-500/10' : 'text-slate-400 border-slate-700 bg-slate-900';
  return (
    <article className="rounded-3xl border border-slate-800 bg-gradient-to-b from-slate-950/90 to-[#05080d] overflow-hidden shadow-2xl shadow-black/20">
      <div className="p-5 border-b border-slate-800 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[8px] uppercase tracking-[.22em] text-slate-600">{subtitle}</p>
          <h2 className="text-3xl font-black mt-1">{title}</h2>
          <p className="text-[9px] font-mono text-slate-500 mt-1">{symbol}</p>
        </div>
        <div className="text-right space-y-2">
          <span className={`inline-flex px-3 py-1.5 rounded-full border text-[9px] font-black tracking-widest ${sideTone === 'green' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300'}`}>{sideBadge}</span>
          <p className={`text-[8px] ${brokerConfigured ? 'text-emerald-500' : 'text-slate-600'}`}>{brokerConfigured ? 'REAL CREDENTIALS CONFIGURED' : 'PAPER · PUBLIC DATA'}</p>
        </div>
      </div>

      <div className="p-5 space-y-4">
        {instrument?.error && <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-[9px] text-rose-300 break-words">{instrument.error}</div>}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <SmallMetric label="BID" value={price(book.bid)} />
          <SmallMetric label="ASK" value={price(book.ask)} />
          <SmallMetric label="SPREAD" value={Number.isFinite(spread) ? `${spread.toFixed(4)}%` : '—'} />
          <SmallMetric label="SEÑAL" value={action} tone={action === 'BUY' ? 'green' : action === 'SELL' ? 'red' : undefined} />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <SmallMetric label="Score" value={num(diagnostic.score, 0)} />
          <SmallMetric label="Costo RT" value={pct4(diagnostic.costPct)} />
          <SmallMetric label="TP bruto" value={pct4(diagnostic.targetPct)} />
          <SmallMetric label="SL bruto" value={pct4(diagnostic.stopPct)} />
          <SmallMetric label="RSI 1m" value={num(diagnostic.rsi, 1)} />
          <SmallMetric label="Taker BUY" value={Number.isFinite(Number(diagnostic.takerBuyRatio)) ? `${(Number(diagnostic.takerBuyRatio) * 100).toFixed(1)}%` : '—'} />
          <SmallMetric label="Bid Qty" value={num(book.bidQty, 3)} />
          <SmallMetric label="Ask Qty" value={num(book.askQty, 3)} />
        </div>
        <div className={`rounded-xl border px-3 py-2 text-[9px] ${actionClass}`}>
          <b>30s / 1m:</b> {diagnostic.reason || (action === 'WAIT' ? 'Esperando confluencia y costo favorable.' : action)}
        </div>

        {trade ? (
          <div className="rounded-2xl border border-indigo-500/25 bg-indigo-500/5 p-4">
            <div className="flex justify-between gap-3"><b className="text-sm">POSICIÓN ABIERTA</b><span className={trade.side === 'BUY' ? 'text-emerald-400 font-black' : 'text-rose-400 font-black'}>{trade.side}</span></div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-3">
              <SmallMetric label="Entrada" value={price(trade.entryPrice)} />
              <SmallMetric label="SL" value={price(trade.stopLoss)} />
              <SmallMetric label="TP" value={price(trade.takeProfit)} />
              <SmallMetric label="PnL" value={money(trade.unrealizedPnl)} tone={trade.unrealizedPnl >= 0 ? 'green' : 'red'} />
            </div>
          </div>
        ) : <div className="rounded-xl border border-dashed border-slate-800 py-4 text-center text-[8px] uppercase tracking-widest text-slate-700">Sin posición abierta</div>}
      </div>
    </article>
  );
}

function PerformanceChart({ title, trades }: { title: string; trades: CommodityTrade[] }) {
  const [range, setRange] = useState<RangeKey>('day');
  const closed = useMemo(() => trades.filter((trade) => trade.state === 'CLOSED' && trade.closeTime).sort((a, b) => Number(a.closeTime) - Number(b.closeTime)), [trades]);
  const cutoff = Date.now() - RANGE_MS[range];
  const prior = closed.filter((trade) => Number(trade.closeTime) <= cutoff).reduce((sum, trade) => sum + Number(trade.realizedPnl || 0), 0);
  let cumulative = prior;
  const current = closed.filter((trade) => Number(trade.closeTime) > cutoff).map((trade) => ({ time: Number(trade.closeTime), value: cumulative += Number(trade.realizedPnl || 0), pnl: Number(trade.realizedPnl || 0) }));
  const points = current.length ? [{ time: cutoff, value: prior, pnl: 0 }, ...current] : [];
  const start = points[0]?.value ?? prior;
  const end = points.at(-1)?.value ?? start;
  const gain = end - start;
  const values = points.map((point) => point.value);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 0;
  const span = Math.max(0.000001, max - min);
  const w = 800, h = 220, left = 54, right = 12, top = 15, bottom = 28;
  const coords = points.map((point, index) => [left + (points.length <= 1 ? 0 : index / (points.length - 1) * (w - left - right)), top + (h - top - bottom) - (point.value - min) / span * (h - top - bottom)] as const);
  const path = coords.map((point, index) => `${index ? 'L' : 'M'} ${point[0].toFixed(1)} ${point[1].toFixed(1)}`).join(' ');
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-950/45 p-4">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div><p className="text-[8px] uppercase tracking-[.18em] text-slate-500">{title}</p><p className={`text-2xl font-black mt-1 ${gain >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{money(gain)}</p></div>
        <div className="flex gap-1 flex-wrap">{(Object.keys(RANGE_LABEL) as RangeKey[]).map((key) => <button key={key} onClick={() => setRange(key)} className={`px-3 py-2 rounded-lg border text-[8px] font-black uppercase ${range === key ? 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300' : 'border-slate-800 text-slate-600'}`}>{RANGE_LABEL[key]}</button>)}</div>
      </div>
      {points.length < 2 ? <div className="h-44 flex items-center justify-center text-[8px] uppercase tracking-widest text-slate-700">Sin operaciones cerradas en este periodo</div> : (
        <>
          <svg className="w-full h-52 mt-2" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
            {[0, 1, 2, 3, 4].map((n) => { const y = top + n / 4 * (h - top - bottom); return <line key={n} x1={left} x2={w - right} y1={y} y2={y} stroke="#172033" strokeWidth="1" />; })}
            <path d={path} fill="none" stroke="currentColor" strokeWidth="3" vectorEffect="non-scaling-stroke" className={gain >= 0 ? 'text-emerald-400' : 'text-rose-400'} />
          </svg>
          <div className="grid grid-cols-3 gap-2"><SmallMetric label="Ganancia periodo" value={money(gain)} tone={gain >= 0 ? 'green' : 'red'} /><SmallMetric label="Mín / Máx" value={`${money(min)} / ${money(max)}`} /><SmallMetric label="Cierres" value={String(current.length)} /></div>
        </>
      )}
    </div>
  );
}

function TradeTable({ trades }: { trades: CommodityTrade[] }) {
  if (!trades.length) return <div className="py-12 text-center text-[9px] uppercase tracking-widest text-slate-700">Aún no hay operaciones R12</div>;
  return <div className="overflow-x-auto"><table className="w-full min-w-[1100px] text-[9px]"><thead className="text-slate-600 uppercase"><tr><th className="p-3 text-left">Mercado</th><th>Venue</th><th>Side</th><th>Estado</th><th>Entrada</th><th>Salida</th><th>SL</th><th>TP</th><th>Spread</th><th>Costo RT</th><th>Lev.</th><th>PnL neto</th><th>Motivo</th><th>Hora</th></tr></thead><tbody>{trades.map((trade) => <tr key={trade.id} className="border-t border-slate-900 hover:bg-slate-900/30"><td className="p-3 font-black text-white">{trade.displaySymbol}</td><td className="text-center">{trade.venue}</td><td className={`text-center font-black ${trade.side === 'BUY' ? 'text-emerald-400' : 'text-rose-400'}`}>{trade.side}</td><td className="text-center">{trade.state}</td><td className="text-center">{price(trade.entryPrice)}</td><td className="text-center">{price(trade.exitPrice)}</td><td className="text-center text-rose-300">{price(trade.stopLoss)}</td><td className="text-center text-emerald-300">{price(trade.takeProfit)}</td><td className="text-center">{pct4(trade.entrySpreadPct)}</td><td className="text-center">{pct4(trade.estimatedRoundTripCostPct)}</td><td className="text-center">{trade.leverage}x</td><td className={`text-center font-black ${trade.realizedPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{trade.state === 'CLOSED' ? money(trade.realizedPnl) : money(trade.unrealizedPnl)}</td><td className="text-center">{trade.closeReason || '—'}</td><td className="text-center">{new Date(trade.closeTime || trade.openTime).toLocaleString()}</td></tr>)}</tbody></table></div>;
}

function Metric({ label, value, tone }: any) { return <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3 min-w-0"><p className="text-[7px] uppercase tracking-[.16em] text-slate-600">{label}</p><p className={`text-sm font-black mt-1 truncate ${tone === 'green' ? 'text-emerald-400' : tone === 'red' ? 'text-rose-400' : 'text-slate-200'}`}>{value}</p></div>; }
function SmallMetric({ label, value, tone }: any) { return <div className="rounded-xl border border-slate-800/80 bg-black/30 p-2 min-w-0"><p className="text-[7px] uppercase tracking-widest text-slate-600">{label}</p><p className={`text-[10px] font-black mt-1 break-words ${tone === 'green' ? 'text-emerald-400' : tone === 'red' ? 'text-rose-400' : 'text-slate-300'}`}>{value}</p></div>; }
function InfoCard({ title, children }: any) { return <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-4"><p className="text-[8px] uppercase tracking-[.18em] text-cyan-500 font-black">{title}</p><p className="mt-2 text-slate-500 leading-5">{children}</p></div>; }
function ModeBadge({ mode, locked }: { mode: string; locked: boolean }) { return <span className={`px-2.5 py-1 rounded-full border text-[9px] font-black tracking-widest ${mode === 'PAPER' ? 'border-violet-500/35 bg-violet-500/10 text-violet-300' : locked ? 'border-rose-500/35 bg-rose-500/10 text-rose-300' : 'border-emerald-500/35 bg-emerald-500/10 text-emerald-300'}`}>{mode}{mode === 'REAL' && locked ? ' · LOCKED' : ''}</span>; }
function StatusBadge({ status }: { status: string }) { const good = status === 'RUNNING'; const warn = status === 'RUNNING_WITH_ERRORS'; return <span className={`px-2.5 py-1 rounded-full border text-[9px] font-black tracking-widest ${good ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-300' : warn ? 'border-amber-500/35 bg-amber-500/10 text-amber-300' : 'border-slate-700 bg-slate-900 text-slate-400'}`}>{status}</span>; }
function money(value: any) { const n = Number(value); return Number.isFinite(n) ? `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(4)}` : '—'; }
function pct(value: any) { const n = Number(value); return Number.isFinite(n) ? `${n.toFixed(2)}%` : '—'; }
function pct4(value: any) { const n = Number(value); return Number.isFinite(n) ? `${n.toFixed(4)}%` : '—'; }
function price(value: any) { const n = Number(value); if (!Number.isFinite(n) || n <= 0) return '—'; return n >= 1000 ? n.toFixed(2) : n >= 10 ? n.toFixed(3) : n.toFixed(5); }
function num(value: any, digits = 2) { const n = Number(value); return Number.isFinite(n) ? n.toFixed(digits) : '—'; }
