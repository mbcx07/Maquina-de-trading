import React, { useEffect, useMemo, useRef, useState } from 'react';

type MarketKind = 'XAU' | 'CRUDE';
type VenueKind = 'EXCHANGE' | 'MT5';
type Timeframe = '30s' | '1m';

type Candle = { time: number; open: number; high: number; low: number; close: number; volume?: number };
type Trade = {
  id: string; venue: string; mode: string; symbol: string; displaySymbol: string; side: 'BUY'|'SELL'; state: string;
  entryPrice: number; exitPrice?: number; stopLoss: number; takeProfit: number; quantity: number; leverage: number;
  marginUsed: number; entrySpreadPct: number; estimatedRoundTripCostPct: number; realizedPnl: number; unrealizedPnl: number;
  openTime: number; closeTime?: number; closeReason?: string; metadata?: any;
};
type ChartPayload = {
  ok?: boolean; kind?: string; venue?: string; venueLabel?: string; symbol?: string; display?: string;
  bid?: number; ask?: number; spreadPct?: number; m1?: Candle[]; micro30s?: Candle[]; trades?: Trade[]; updatedAt?: number; error?: string;
};

type AppState = {
  release?: string; edition?: string; mode?: string; engineEnabled?: boolean; policy?: any; integrations?: any;
  exchange?: any; forex?: any; comparison?: any[]; recentTrades?: Trade[];
};

type UpdaterState = {
  ok?: boolean; currentSha?: string; remoteSha?: string; updateAvailable?: boolean; dirty?: string[]; release?: string;
  checkedAt?: number; agent?: { busy?: boolean; phase?: string; lastOk?: boolean; lastError?: string; completedAt?: number; lastOutput?: string };
};

const API = (import.meta as any).env?.VITE_V34_API_BASE || '/backend';
const REFRESH_STATE_MS = 3000;
const REFRESH_CHART_MS = 1800;

export default function AppR14() {
  const [state, setState] = useState<AppState>({});
  const [market, setMarket] = useState<MarketKind>('XAU');
  const [venue, setVenue] = useState<VenueKind>('EXCHANGE');
  const [timeframe, setTimeframe] = useState<Timeframe>('30s');
  const [chart, setChart] = useState<ChartPayload>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [updater, setUpdater] = useState<UpdaterState>({});
  const [updateBusy, setUpdateBusy] = useState(false);
  const [autoUpdate, setAutoUpdate] = useState(() => localStorage.getItem('quantum.r14.autoUpdate') !== 'false');
  const appliedRef = useRef(false);

  const refreshState = async () => {
    try {
      const response = await fetch(`${API}/api/state?ts=${Date.now()}`, { cache: 'no-store' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `STATE_HTTP_${response.status}`);
      setState(body);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const refreshChart = async () => {
    try {
      const response = await fetch(`${API}/api/chart/${market}/${venue}?ts=${Date.now()}`, { cache: 'no-store' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `CHART_HTTP_${response.status}`);
      setChart(body);
    } catch (e) {
      setChart({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  };

  const command = async (path: '/api/start'|'/api/pause'|'/api/run') => {
    setBusy(true);
    try {
      const response = await fetch(`${API}${path}`, { method: 'POST' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP_${response.status}`);
      await Promise.all([refreshState(), refreshChart()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const checkUpdate = async () => {
    try {
      const response = await fetch(`/updater/check?ts=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`UPDATER_HTTP_${response.status}`);
      const body = await response.json();
      setUpdater(body);
      return body as UpdaterState;
    } catch (e) {
      setUpdater((old) => ({ ...old, ok: false, agent: { ...old.agent, lastError: e instanceof Error ? e.message : String(e) } }));
      return null;
    }
  };

  const applyUpdate = async (automatic = false) => {
    if (updateBusy || updater.agent?.busy) return;
    if (openPositions > 0) {
      if (!automatic) setError('ACTUALIZACIÓN BLOQUEADA: hay posiciones abiertas. La app no se reinicia durante trades activos.');
      return;
    }
    setUpdateBusy(true);
    appliedRef.current = true;
    try {
      const response = await fetch('/updater/apply', { method: 'POST' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok && response.status !== 202) throw new Error(body.error || `UPDATER_APPLY_${response.status}`);
      setUpdater((old) => ({ ...old, ...body }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setUpdateBusy(false);
      appliedRef.current = false;
    }
  };

  const openPositions = useMemo(() => {
    const ex = Array.isArray(state.exchange?.recentTrades) ? state.exchange.recentTrades : [];
    const fx = Array.isArray(state.forex?.recentTrades) ? state.forex.recentTrades : [];
    return [...ex, ...fx].filter((row: any) => row?.state === 'OPEN').length;
  }, [state]);

  useEffect(() => {
    void refreshState();
    const timer = window.setInterval(() => void refreshState(), REFRESH_STATE_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    void refreshChart();
    const timer = window.setInterval(() => void refreshChart(), REFRESH_CHART_MS);
    return () => window.clearInterval(timer);
  }, [market, venue]);

  useEffect(() => {
    localStorage.setItem('quantum.r14.autoUpdate', autoUpdate ? 'true' : 'false');
  }, [autoUpdate]);

  useEffect(() => {
    void checkUpdate();
    const timer = window.setInterval(async () => {
      const result = await checkUpdate();
      if (autoUpdate && result?.updateAvailable && openPositions === 0 && !result.agent?.busy) {
        void applyUpdate(true);
      }
    }, 10 * 60_000);
    return () => window.clearInterval(timer);
  }, [autoUpdate, openPositions]);

  useEffect(() => {
    if (!updateBusy && !updater.agent?.busy && !appliedRef.current) return;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`/updater/status?ts=${Date.now()}`, { cache: 'no-store' });
        if (!response.ok) return;
        const body = await response.json();
        setUpdater(body);
        const phase = body.agent?.phase;
        if (phase === 'COMPLETED' && body.agent?.lastOk === true) {
          window.clearInterval(timer);
          window.setTimeout(() => window.location.reload(), 1600);
        }
        if (phase === 'ERROR') {
          window.clearInterval(timer);
          setUpdateBusy(false);
          appliedRef.current = false;
          setError(body.agent?.lastError || 'UPDATE_ERROR');
        }
      } catch {
        // During container recreation the endpoint can disappear briefly. Keep polling.
      }
    }, 1800);
    return () => window.clearInterval(timer);
  }, [updateBusy, updater.agent?.busy]);

  const comparisons = Array.isArray(state.comparison) ? state.comparison : [];
  const marketComparisons = comparisons.filter((row: any) => row.display === (market === 'XAU' ? 'XAUUSD' : 'CRUDE OIL'));
  const exchangeInstrument = findInstrument(state.exchange, market);
  const mt5Instrument = findInstrument(state.forex, market);
  const selectedInstrument = venue === 'EXCHANGE' ? exchangeInstrument : mt5Instrument;
  const liveSpread = Number(chart.spreadPct ?? selectedInstrument?.spreadPct);
  const liveLeverage = venue === 'EXCHANGE'
    ? Number(selectedInstrument?.maxLeverage ?? selectedInstrument?.lastDiagnostic?.maxLeverage ?? 0)
    : Number(selectedInstrument?.brokerLeverage ?? state.forex?.account?.leverage ?? 0);

  return (
    <div className="min-h-screen text-slate-100 bg-[#02050a] selection:bg-cyan-400/30">
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute -top-40 left-[10%] w-[38rem] h-[38rem] rounded-full bg-cyan-500/[0.055] blur-[130px]" />
        <div className="absolute top-[30%] right-[-12rem] w-[36rem] h-[36rem] rounded-full bg-violet-500/[0.045] blur-[140px]" />
        <div className="absolute bottom-[-18rem] left-[35%] w-[42rem] h-[42rem] rounded-full bg-emerald-500/[0.035] blur-[150px]" />
      </div>

      <header className="sticky top-0 z-50 border-b border-cyan-950/60 bg-[#02050a]/90 backdrop-blur-2xl">
        <div className="max-w-[1900px] mx-auto px-4 lg:px-6 py-3 flex flex-col 2xl:flex-row 2xl:items-center justify-between gap-3">
          <div className="flex items-center gap-4 min-w-0">
            <div className="relative w-11 h-11 shrink-0 rounded-2xl border border-cyan-400/30 bg-cyan-500/5 grid place-items-center shadow-[0_0_35px_rgba(34,211,238,.12)]">
              <div className="absolute inset-2 rounded-xl border border-cyan-300/15 rotate-45" />
              <span className="font-black text-cyan-300 text-lg">Q</span>
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[8px] font-black tracking-[.24em] text-cyan-300 uppercase">Quantum Dual Commodities</span>
                <Pill text={`R14 · ${state.mode || 'PAPER'}`} tone={state.mode === 'REAL' ? 'red' : 'cyan'} />
                <Pill text={state.engineEnabled ? 'AUTO ON' : 'PAUSED'} tone={state.engineEnabled ? 'green' : 'amber'} />
              </div>
              <h1 className="mt-1 text-xl md:text-2xl font-black tracking-tight truncate">XAUUSD + CRUDE <span className="text-slate-500">· Exchange ↔ MT5</span></h1>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <ConnectionPill label="BINANCE" ok={state.integrations?.binance?.configured} />
            <ConnectionPill label="ASTER" ok={state.integrations?.aster?.configured || state.mode === 'PAPER'} />
            <ConnectionPill label="MT5" ok={state.integrations?.mt5?.connected || state.forex?.status === 'RUNNING'} />
            <button onClick={() => void command(state.engineEnabled ? '/api/pause' : '/api/start')} disabled={busy} className={`h-9 px-4 rounded-xl border text-[9px] font-black uppercase tracking-widest transition ${state.engineEnabled ? 'border-amber-400/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/15' : 'border-emerald-400/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/15'} disabled:opacity-40`}>
              {state.engineEnabled ? 'Pausar motor' : 'Iniciar automático'}
            </button>
            <UpdateControl updater={updater} autoUpdate={autoUpdate} setAutoUpdate={setAutoUpdate} onCheck={checkUpdate} onApply={() => applyUpdate(false)} disabled={openPositions > 0} busy={updateBusy} />
          </div>
        </div>
      </header>

      <main className="relative max-w-[1900px] mx-auto p-4 lg:p-6 space-y-5">
        {error && <div className="rounded-2xl border border-rose-500/25 bg-rose-500/[0.08] px-4 py-3 text-xs text-rose-200"><b className="mr-2">ALERTA</b>{error}</div>}

        <section className="grid grid-cols-1 xl:grid-cols-[1fr_auto] gap-4 items-stretch">
          <div className="rounded-3xl border border-slate-800/80 bg-slate-950/45 p-2 flex gap-2">
            <MarketButton active={market === 'XAU'} title="XAUUSD" subtitle="Gold" onClick={() => setMarket('XAU')} />
            <MarketButton active={market === 'CRUDE'} title="CRUDE OIL" subtitle="BUY ONLY" onClick={() => setMarket('CRUDE')} />
          </div>
          <div className="rounded-3xl border border-slate-800/80 bg-slate-950/45 p-2 grid grid-cols-2 min-w-[310px]">
            <VenueButton active={venue === 'EXCHANGE'} title="EXCHANGE" subtitle={market === 'XAU' ? 'Binance USD-M' : 'Aster / Binance Wallet'} onClick={() => setVenue('EXCHANGE')} />
            <VenueButton active={venue === 'MT5'} title="FOREX / MT5" subtitle={mt5Instrument?.symbol || 'Auto-detect'} onClick={() => setVenue('MT5')} />
          </div>
        </section>

        <section className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-2">
          <Metric label="BID" value={price(chart.bid ?? selectedInstrument?.book?.bid)} />
          <Metric label="ASK" value={price(chart.ask ?? selectedInstrument?.book?.ask)} />
          <Metric label="SPREAD" value={Number.isFinite(liveSpread) ? `${liveSpread.toFixed(4)}%` : '—'} />
          <Metric label={venue === 'MT5' ? 'Leverage broker' : 'Leverage máximo'} value={liveLeverage > 0 ? `${liveLeverage}x` : '—'} accent="cyan" />
          <Metric label="Señal" value={String(selectedInstrument?.lastDiagnostic?.action || 'WAIT')} accent={selectedInstrument?.lastDiagnostic?.action === 'BUY' ? 'green' : selectedInstrument?.lastDiagnostic?.action === 'SELL' ? 'red' : undefined} />
          <Metric label="Score" value={num(selectedInstrument?.lastDiagnostic?.score, 0)} />
          <Metric label="Costo RT" value={pct4(selectedInstrument?.lastDiagnostic?.costPct)} />
          <Metric label="TP bruto" value={pct4(selectedInstrument?.lastDiagnostic?.targetPct)} />
        </section>

        <section className="rounded-[28px] border border-cyan-950/70 bg-[#040911]/90 overflow-hidden shadow-[0_30px_100px_rgba(0,0,0,.45)]">
          <div className="px-4 lg:px-5 py-3 border-b border-slate-800/80 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-black">{market === 'XAU' ? 'XAUUSD' : 'CRUDE OIL'}</h2>
                <Pill text={venue === 'EXCHANGE' ? (market === 'XAU' ? 'BINANCE USD-M' : 'ASTER / BINANCE WALLET') : `MT5 · ${chart.symbol || mt5Instrument?.symbol || 'DETECTANDO'}`} tone={venue === 'EXCHANGE' ? 'cyan' : 'violet'} />
                {market === 'CRUDE' && <Pill text="BUY ONLY" tone="green" />}
              </div>
              <p className="mt-1 text-[8px] uppercase tracking-[.18em] text-slate-600">Precio vivo · entradas/salidas · SL/TP · microestructura</p>
            </div>
            <div className="flex items-center gap-1 rounded-xl border border-slate-800 bg-black/30 p-1">
              <TfButton active={timeframe === '30s'} text="30s" onClick={() => setTimeframe('30s')} />
              <TfButton active={timeframe === '1m'} text="1m" onClick={() => setTimeframe('1m')} />
              <button onClick={() => void refreshChart()} className="ml-1 px-3 py-2 rounded-lg text-[8px] font-black uppercase tracking-wider text-cyan-300 hover:bg-cyan-500/10">↻ Live</button>
            </div>
          </div>
          <FuturisticChart payload={chart} timeframe={timeframe} />
        </section>

        <section className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <VenueComparisonCard market={market} source="EXCHANGE" comparison={marketComparisons.find((row: any) => row.source === 'EXCHANGE')} instrument={exchangeInstrument} />
          <VenueComparisonCard market={market} source="MT5" comparison={marketComparisons.find((row: any) => row.source === 'MT5')} instrument={mt5Instrument} />
        </section>

        <section className="rounded-3xl border border-slate-800/80 bg-slate-950/40 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-800/80 flex flex-wrap justify-between gap-2">
            <div><p className="text-[9px] font-black uppercase tracking-[.2em] text-slate-400">Comparativa acumulada</p><p className="text-[8px] text-slate-600 mt-1">Misma estrategia · diferencias reales de spread, leverage y venue.</p></div>
            <span className="text-[8px] text-slate-600">{state.recentTrades?.length || 0} registros recientes</span>
          </div>
          <ComparisonTable rows={comparisons} />
        </section>

        <section className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <InfoCard title="Exchange">XAU usa <b>Binance USD-M</b>. Crude usa <b>Aster / Binance Wallet</b>. El motor pide el leverage máximo permitido por contrato y usa 1% de margen.</InfoCard>
          <InfoCard title="Forex / MT5">El símbolo de crudo se <b>detecta automáticamente</b> en tu broker. Cada entrada considera bid/ask y el spread real del broker antes de aceptar el scalp.</InfoCard>
          <InfoCard title="Auto-update">Cada 10 minutos busca una versión nueva. Si no hay posiciones abiertas, puede actualizar automáticamente. <b>Nunca reinicia durante una operación.</b></InfoCard>
        </section>
      </main>
    </div>
  );
}

function FuturisticChart({ payload, timeframe }: { payload: ChartPayload; timeframe: Timeframe }) {
  const source = timeframe === '30s' ? payload.micro30s : payload.m1;
  const candles = (Array.isArray(source) ? source : []).slice(-90).filter((c: any) => Number(c?.time) > 0 && Number(c?.high) > 0);
  const trades = Array.isArray(payload.trades) ? payload.trades : [];
  const W = 1500, H = 520, left = 70, right = 86, top = 24, bottom = 48;
  if (candles.length < 2) {
    return <div className="h-[500px] grid place-items-center text-[9px] uppercase tracking-[.2em] text-slate-700">{payload.error || 'Esperando datos de mercado…'}</div>;
  }

  const start = candles[0].time;
  const end = candles.at(-1)!.time + (timeframe === '30s' ? 30_000 : 60_000);
  const relevantTrades = trades.filter((t) => (t.openTime >= start - 120_000 && t.openTime <= end + 120_000) || (t.closeTime && t.closeTime >= start - 120_000));
  const levels = relevantTrades.flatMap((t) => [t.entryPrice, t.stopLoss, t.takeProfit, t.exitPrice || 0]).filter((v) => v > 0);
  const live = [Number(payload.bid || 0), Number(payload.ask || 0)].filter((v) => v > 0);
  let min = Math.min(...candles.map((c) => c.low), ...(levels.length ? levels : [Infinity]), ...(live.length ? live : [Infinity]));
  let max = Math.max(...candles.map((c) => c.high), ...(levels.length ? levels : [-Infinity]), ...(live.length ? live : [-Infinity]));
  const pad = Math.max((max - min) * 0.08, Math.abs(max) * 0.00015, 1e-6);
  min -= pad; max += pad;
  const plotW = W - left - right, plotH = H - top - bottom;
  const x = (time: number) => left + ((time - start) / Math.max(1, end - start)) * plotW;
  const y = (price: number) => top + (max - price) / Math.max(1e-12, max - min) * plotH;
  const candleW = Math.max(2.2, Math.min(13, plotW / candles.length * 0.62));
  const lastMid = live.length === 2 ? (live[0] + live[1]) / 2 : Number(candles.at(-1)?.close || 0);
  const active = relevantTrades.filter((t) => t.state === 'OPEN').at(-1);

  return (
    <div className="relative w-full overflow-hidden">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[500px]" preserveAspectRatio="none">
        <defs>
          <linearGradient id="r14bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#071522"/><stop offset="100%" stopColor="#02060b"/></linearGradient>
          <linearGradient id="r14area" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stopColor="#22d3ee" stopOpacity=".02"/><stop offset="50%" stopColor="#22d3ee" stopOpacity=".08"/><stop offset="100%" stopColor="#8b5cf6" stopOpacity=".02"/></linearGradient>
          <filter id="glow"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        </defs>
        <rect width={W} height={H} fill="url(#r14bg)" />
        <rect x={left} y={top} width={plotW} height={plotH} fill="url(#r14area)" />
        {[0,1,2,3,4,5].map((g) => {
          const gy = top + g / 5 * plotH;
          const value = max - g / 5 * (max - min);
          return <g key={`h${g}`}><line x1={left} y1={gy} x2={W-right} y2={gy} stroke="#142334" strokeWidth="1" strokeDasharray="4 10"/><text x={W-right+10} y={gy+4} fill="#526578" fontSize="12" fontFamily="JetBrains Mono">{formatPrice(value)}</text></g>;
        })}
        {[0,1,2,3,4,5,6].map((g) => { const gx=left+g/6*plotW; return <line key={`v${g}`} x1={gx} y1={top} x2={gx} y2={top+plotH} stroke="#0e1a27" strokeWidth="1"/>; })}

        {candles.map((c, i) => {
          const cx = x(c.time + (timeframe === '30s' ? 15_000 : 30_000));
          const up = c.close >= c.open;
          const bodyTop = y(Math.max(c.open, c.close));
          const bodyBottom = y(Math.min(c.open, c.close));
          const bodyH = Math.max(1.5, bodyBottom - bodyTop);
          const color = up ? '#2dd4bf' : '#fb7185';
          return <g key={`${c.time}-${i}`}>
            <line x1={cx} x2={cx} y1={y(c.high)} y2={y(c.low)} stroke={color} strokeWidth="1.25" opacity=".82" />
            <rect x={cx-candleW/2} y={bodyTop} width={candleW} height={bodyH} rx="1.2" fill={color} opacity=".9" />
          </g>;
        })}

        {active && <>
          <PriceLevel y={y(active.takeProfit)} x1={left} x2={W-right} color="#34d399" label={`TP ${formatPrice(active.takeProfit)}`} />
          <PriceLevel y={y(active.entryPrice)} x1={left} x2={W-right} color="#38bdf8" label={`ENTRY ${formatPrice(active.entryPrice)}`} />
          <PriceLevel y={y(active.stopLoss)} x1={left} x2={W-right} color="#fb7185" label={`SL ${formatPrice(active.stopLoss)}`} />
        </>}

        {relevantTrades.map((trade) => {
          const ex = x(clampTime(trade.openTime, start, end));
          const ey = y(trade.entryPrice);
          const buy = trade.side === 'BUY';
          const color = buy ? '#34d399' : '#fb7185';
          return <g key={trade.id} filter="url(#glow)">
            <path d={buy ? `M ${ex} ${ey+13} L ${ex-7} ${ey+24} L ${ex+7} ${ey+24} Z` : `M ${ex} ${ey-13} L ${ex-7} ${ey-24} L ${ex+7} ${ey-24} Z`} fill={color}/>
            <circle cx={ex} cy={ey} r="4" fill="#02050a" stroke={color} strokeWidth="2" />
            <text x={ex+10} y={ey+(buy?-12:18)} fill={color} fontSize="10" fontWeight="800">{trade.side}</text>
            {trade.closeTime && trade.exitPrice && <>
              <circle cx={x(clampTime(trade.closeTime, start, end))} cy={y(trade.exitPrice)} r="6" fill="#02050a" stroke={trade.realizedPnl >= 0 ? '#67e8f9' : '#fda4af'} strokeWidth="2" />
              <text x={x(clampTime(trade.closeTime, start, end))+10} y={y(trade.exitPrice)-8} fill={trade.realizedPnl >= 0 ? '#67e8f9' : '#fda4af'} fontSize="10">{trade.closeReason || 'EXIT'}</text>
            </>}
          </g>;
        })}

        {lastMid > 0 && <g filter="url(#glow)">
          <line x1={left} y1={y(lastMid)} x2={W-right} y2={y(lastMid)} stroke="#22d3ee" strokeWidth="1.4" strokeDasharray="7 5" opacity=".9" />
          <rect x={W-right+3} y={y(lastMid)-12} width="80" height="24" rx="6" fill="#083344" stroke="#22d3ee" strokeOpacity=".6" />
          <text x={W-right+10} y={y(lastMid)+4} fill="#a5f3fc" fontSize="11" fontWeight="800" fontFamily="JetBrains Mono">{formatPrice(lastMid)}</text>
        </g>}

        {[0,1,2,3,4,5].map((g) => {
          const time = start + g / 5 * (end-start);
          return <text key={`t${g}`} x={x(time)} y={H-15} fill="#526578" fontSize="11" textAnchor={g===0?'start':g===5?'end':'middle'}>{new Date(time).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second: timeframe==='30s'?'2-digit':undefined})}</text>;
        })}
      </svg>
      <div className="absolute left-4 top-4 flex flex-wrap gap-2 pointer-events-none">
        <div className="px-3 py-2 rounded-xl border border-cyan-400/20 bg-black/55 backdrop-blur text-[9px] font-mono"><span className="text-slate-600">BID </span><b className="text-cyan-200">{price(payload.bid)}</b></div>
        <div className="px-3 py-2 rounded-xl border border-violet-400/20 bg-black/55 backdrop-blur text-[9px] font-mono"><span className="text-slate-600">ASK </span><b className="text-violet-200">{price(payload.ask)}</b></div>
        <div className="px-3 py-2 rounded-xl border border-slate-700 bg-black/55 backdrop-blur text-[9px] font-mono"><span className="text-slate-600">SPREAD </span><b>{Number.isFinite(Number(payload.spreadPct)) ? `${Number(payload.spreadPct).toFixed(4)}%` : '—'}</b></div>
      </div>
    </div>
  );
}

function PriceLevel({ y, x1, x2, color, label }: any) {
  return <g><line x1={x1} y1={y} x2={x2} y2={y} stroke={color} strokeWidth="1" strokeDasharray="10 7" opacity=".62"/><text x={x1+8} y={y-5} fill={color} fontSize="10" fontWeight="700">{label}</text></g>;
}

function VenueComparisonCard({ market, source, comparison, instrument }: any) {
  const exchange = source === 'EXCHANGE';
  return <article className={`rounded-3xl border ${exchange ? 'border-cyan-950/80' : 'border-violet-950/80'} bg-slate-950/45 p-5`}>
    <div className="flex items-start justify-between gap-3">
      <div><p className="text-[8px] uppercase tracking-[.2em] text-slate-600">{market === 'XAU' ? 'XAUUSD' : 'CRUDE OIL'}</p><h3 className="mt-1 font-black text-lg">{exchange ? 'EXCHANGE' : 'FOREX / MT5'}</h3><p className="mt-1 text-[9px] text-slate-500">{exchange ? (market === 'XAU' ? 'Binance USD-M · XAUUSDT' : 'Aster / Binance Wallet · CLUSDT') : `Broker symbol: ${instrument?.symbol || 'detectando…'}`}</p></div>
      <Pill text={instrument?.status || instrument?.lastDiagnostic?.action || 'MONITOR'} tone={exchange ? 'cyan' : 'violet'} />
    </div>
    <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-2">
      <Small label="WR" value={pct(comparison?.winRate)} />
      <Small label="PnL neto" value={money(comparison?.netPnl)} tone={Number(comparison?.netPnl)>=0?'green':'red'} />
      <Small label="Spread prom." value={pct4(comparison?.avgSpreadPct)} />
      <Small label="Leverage prom." value={Number(comparison?.avgLeverage)>0?`${Number(comparison.avgLeverage).toFixed(1)}x`:'—'} />
      <Small label="Trades" value={String(comparison?.trades ?? 0)} />
      <Small label="Abiertas" value={String(comparison?.open ?? 0)} />
      <Small label="Hold prom." value={Number(comparison?.avgHoldSeconds)>0?`${Number(comparison.avgHoldSeconds).toFixed(0)}s`:'—'} />
      <Small label="Spread vivo" value={pct4(instrument?.spreadPct)} />
    </div>
  </article>;
}

function UpdateControl({ updater, autoUpdate, setAutoUpdate, onCheck, onApply, disabled, busy }: any) {
  const phase = updater.agent?.phase || 'IDLE';
  const working = busy || updater.agent?.busy;
  return <div className="flex items-center gap-1 rounded-xl border border-slate-800 bg-slate-950/80 p-1">
    <button onClick={() => void onCheck()} className="px-3 py-2 rounded-lg text-[8px] font-black uppercase tracking-widest text-slate-400 hover:text-cyan-200 hover:bg-cyan-500/5">Buscar update</button>
    <button onClick={() => void onApply()} disabled={disabled || working || !updater.updateAvailable} className="px-3 py-2 rounded-lg bg-cyan-500/10 border border-cyan-400/20 text-[8px] font-black uppercase tracking-widest text-cyan-200 disabled:opacity-30 disabled:cursor-not-allowed">
      {working ? phase : updater.updateAvailable ? 'Actualizar ahora' : 'Al día'}
    </button>
    <label className="flex items-center gap-2 px-2 cursor-pointer" title="Solo actualiza automáticamente cuando no hay operaciones abiertas">
      <input type="checkbox" checked={autoUpdate} onChange={(e) => setAutoUpdate(e.target.checked)} className="accent-cyan-400" />
      <span className="text-[7px] font-bold uppercase tracking-wider text-slate-500">Auto</span>
    </label>
  </div>;
}

function ComparisonTable({ rows }: any) {
  return <div className="overflow-x-auto"><table className="w-full min-w-[800px] text-[9px]"><thead className="bg-black/30 text-slate-600 uppercase tracking-wider"><tr>{['Mercado','Fuente','Trades','WR','PnL neto','Spread prom.','Leverage prom.','Hold prom.','Abiertas'].map((h)=><th key={h} className="px-4 py-3 text-left">{h}</th>)}</tr></thead><tbody>{(rows||[]).map((r:any)=><tr key={r.key} className="border-t border-slate-800/60 hover:bg-white/[.015]"><td className="px-4 py-3 font-black">{r.display}</td><td className={`px-4 py-3 font-black ${r.source==='EXCHANGE'?'text-cyan-300':'text-violet-300'}`}>{r.source}</td><td className="px-4 py-3">{r.trades}</td><td className="px-4 py-3">{pct(r.winRate)}</td><td className={`px-4 py-3 font-bold ${Number(r.netPnl)>=0?'text-emerald-400':'text-rose-400'}`}>{money(r.netPnl)}</td><td className="px-4 py-3">{pct4(r.avgSpreadPct)}</td><td className="px-4 py-3">{Number(r.avgLeverage)>0?`${Number(r.avgLeverage).toFixed(1)}x`:'—'}</td><td className="px-4 py-3">{Number(r.avgHoldSeconds)>0?`${Number(r.avgHoldSeconds).toFixed(0)}s`:'—'}</td><td className="px-4 py-3">{r.open}</td></tr>)}</tbody></table></div>;
}

function findInstrument(service: any, market: MarketKind) {
  const rows = Array.isArray(service?.instruments) ? service.instruments : [];
  return rows.find((r: any) => String(r.kind || '').toUpperCase() === market) || rows.find((r:any) => market === 'XAU' ? String(r.symbol||'').includes('XAU') : String(r.display||'').includes('CRUDE'));
}

function MarketButton({ active, title, subtitle, onClick }: any) { return <button onClick={onClick} className={`flex-1 rounded-2xl px-5 py-3 text-left transition border ${active?'border-cyan-400/30 bg-cyan-500/[.08] shadow-[0_0_30px_rgba(34,211,238,.07)]':'border-transparent hover:bg-white/[.025]'}`}><p className={`font-black text-base ${active?'text-cyan-200':'text-slate-300'}`}>{title}</p><p className="text-[8px] mt-1 uppercase tracking-widest text-slate-600">{subtitle}</p></button>; }
function VenueButton({ active, title, subtitle, onClick }: any) { return <button onClick={onClick} className={`rounded-2xl px-4 py-3 text-left transition ${active?'bg-white/[.055] text-white':'text-slate-500 hover:text-slate-300'}`}><p className="text-[9px] font-black tracking-wider">{title}</p><p className="text-[7px] mt-1 truncate text-slate-600">{subtitle}</p></button>; }
function TfButton({ active, text, onClick }: any) { return <button onClick={onClick} className={`px-3 py-2 rounded-lg text-[8px] font-black ${active?'bg-cyan-500/15 text-cyan-200 border border-cyan-400/20':'text-slate-600 hover:text-slate-300 border border-transparent'}`}>{text}</button>; }
function Metric({ label, value, accent }: any) { return <div className="rounded-2xl border border-slate-800/70 bg-slate-950/50 p-3 min-w-0"><p className="text-[7px] uppercase tracking-[.16em] text-slate-600 truncate">{label}</p><p className={`mt-1 text-sm font-black font-mono truncate ${accent==='cyan'?'text-cyan-300':accent==='green'?'text-emerald-400':accent==='red'?'text-rose-400':'text-slate-200'}`}>{value}</p></div>; }
function Small({ label, value, tone }: any) { return <div className="rounded-xl border border-slate-800/70 bg-black/20 p-2"><p className="text-[7px] uppercase tracking-wider text-slate-600">{label}</p><p className={`mt-1 text-[10px] font-black ${tone==='green'?'text-emerald-400':tone==='red'?'text-rose-400':'text-slate-300'}`}>{value}</p></div>; }
function Pill({ text, tone='slate' }: any) { const cls:any={cyan:'border-cyan-400/25 bg-cyan-500/10 text-cyan-200',green:'border-emerald-400/25 bg-emerald-500/10 text-emerald-300',red:'border-rose-400/25 bg-rose-500/10 text-rose-300',amber:'border-amber-400/25 bg-amber-500/10 text-amber-300',violet:'border-violet-400/25 bg-violet-500/10 text-violet-300',slate:'border-slate-700 bg-slate-900 text-slate-400'}; return <span className={`px-2.5 py-1 rounded-full border text-[7px] font-black uppercase tracking-[.14em] ${cls[tone]||cls.slate}`}>{text}</span>; }
function ConnectionPill({ label, ok }: any) { return <span className={`h-9 px-3 rounded-xl border flex items-center gap-2 text-[8px] font-black ${ok?'border-emerald-500/20 bg-emerald-500/[.06] text-emerald-300':'border-slate-800 bg-slate-950 text-slate-600'}`}><i className={`w-1.5 h-1.5 rounded-full ${ok?'bg-emerald-400 shadow-[0_0_9px_#34d399]':'bg-slate-700'}`}/>{label}</span>; }
function InfoCard({ title, children }: any) { return <div className="rounded-2xl border border-slate-800/70 bg-slate-950/40 p-4 text-[9px] leading-relaxed text-slate-500"><p className="mb-2 text-[8px] font-black uppercase tracking-[.18em] text-slate-300">{title}</p>{children}</div>; }

function price(value: any){const n=Number(value);if(!Number.isFinite(n)||n<=0)return'—';return n>=1000?n.toFixed(2):n>=100?n.toFixed(3):n>=1?n.toFixed(4):n.toFixed(6);}
function formatPrice(value:number){return value>=1000?value.toFixed(2):value>=100?value.toFixed(3):value>=1?value.toFixed(4):value.toFixed(6);}
function money(value:any){const n=Number(value);if(!Number.isFinite(n))return'$0.00';return `${n<0?'-':''}$${Math.abs(n).toFixed(2)}`;}
function pct(value:any){const n=Number(value);return Number.isFinite(n)?`${n.toFixed(1)}%`:'—';}
function pct4(value:any){const n=Number(value);return Number.isFinite(n)?`${n.toFixed(4)}%`:'—';}
function num(value:any, decimals=1){const n=Number(value);return Number.isFinite(n)?n.toFixed(decimals):'—';}
function clampTime(time:number,min:number,max:number){return Math.max(min,Math.min(max,time));}
