import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { v34Api } from './services/v34Api';

type View = 'dashboard' | 'settings' | 'backtest';
type Provider = 'BINANCE' | 'TELEGRAM' | 'TWELVE_DATA';

const BUILD = 'R8';

const AppR8: React.FC = () => {
  const [state, setState] = useState<any>(null);
  const [view, setView] = useState<View>('dashboard');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [lastSync, setLastSync] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const next = await v34Api.getState();
      setState(next);
      setLastSync(Date.now());
      setError('');
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const run = async (fn: () => Promise<any>, message?: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await fn();
      if (message) setNotice(message);
      await refresh();
      return result;
    } catch (e: any) {
      setError(e?.message || String(e));
      return null;
    } finally {
      setBusy(false);
    }
  };

  if (!state) {
    return (
      <div className="min-h-screen bg-[#010409] text-slate-300 flex items-center justify-center font-mono">
        <div className="text-center space-y-4">
          <div className="w-14 h-14 mx-auto rounded-full border-4 border-indigo-500/20 border-t-indigo-500 animate-spin" />
          <p className="text-[10px] uppercase tracking-[0.35em] text-slate-500">Quantum Dual V34 {BUILD}</p>
          {error && <p className="text-xs text-rose-400 max-w-xl">{error}</p>}
        </div>
      </div>
    );
  }

  const settings = state.settings || {};
  const engineOn = Boolean(settings.engineEnabled);
  const patchSettings = (patch: Record<string, unknown>) => run(() => v34Api.patchSettings(patch), 'Configuración guardada.');
  const engineAction = (action: 'start' | 'pause' | 'emergency') => run(
    () => action === 'start' ? v34Api.startEngine() : action === 'pause' ? v34Api.pauseEngine() : v34Api.emergencyStop(),
    action === 'start' ? 'Motor iniciado.' : action === 'pause' ? 'Motor pausado.' : 'Emergency Stop ejecutado.',
  );

  return (
    <div className="min-h-screen bg-[#010409] text-slate-200 p-3 md:p-5 font-mono">
      <div className="max-w-[1900px] mx-auto space-y-4">
        <Header state={state} view={view} setView={setView} busy={busy} lastSync={lastSync} engineOn={engineOn} patchSettings={patchSettings} engineAction={engineAction} />
        {error && <Banner tone="error">{error}</Banner>}
        {notice && <Banner tone="ok">{notice}</Banner>}
        {view === 'dashboard' && <Dashboard state={state} patchSettings={patchSettings} run={run} busy={busy} />}
        {view === 'settings' && <Settings state={state} patchSettings={patchSettings} run={run} busy={busy} />}
        {view === 'backtest' && <Backtest settings={settings} />}
      </div>
    </div>
  );
};

function Header({ state, view, setView, busy, lastSync, engineOn, patchSettings, engineAction }: any) {
  const settings = state.settings || {};
  const binance = state.brokerStatus?.binance || {};
  const forex = state.brokerStatus?.forexData || {};
  const telegram = state.brokerStatus?.telegram || {};
  return (
    <header className="bg-[#0d1117] border border-slate-800 rounded-[2rem] p-4 md:p-6 shadow-2xl">
      <div className="flex flex-col 2xl:flex-row 2xl:items-center justify-between gap-5">
        <div className="flex items-center gap-4">
          <span className={`w-3 h-3 rounded-full ${engineOn ? 'bg-emerald-400 animate-pulse shadow-[0_0_18px_#34d399]' : 'bg-slate-700'}`} />
          <div>
            <h1 className="text-2xl md:text-3xl font-black italic tracking-tighter uppercase text-white">
              QUANTUM<span className="text-indigo-500">DUAL</span> V34 <span className="text-cyan-400">R8</span>
            </h1>
            <div className="flex flex-wrap gap-3 mt-2 text-[8px] font-black uppercase tracking-widest text-slate-500">
              <Connection label={settings.appMode === 'PAPER' ? 'Paper Broker' : 'Binance Futures'} ok={settings.appMode === 'PAPER' || Boolean(binance.connected)} />
              <Connection label="Forex Data" ok={Boolean(forex.connected)} />
              <Connection label="Telegram" ok={Boolean(telegram.connected)} pending={!telegram.configured} />
              <span>{settings.appMode}</span><span>Linux</span><span>Build R8</span><span>Sync {lastSync ? new Date(lastSync).toLocaleTimeString() : '—'}</span>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select value={settings.appMode} disabled={busy || engineOn} onChange={(e) => void patchSettings({ appMode: e.target.value })} className="field !w-auto min-w-36">
            <option value="PAPER">PAPER</option><option value="TESTNET">BINANCE TESTNET</option><option value="REAL">REAL</option>
          </select>
          <button disabled={busy} onClick={() => void engineAction(engineOn ? 'pause' : 'start')} className={`px-5 py-3 rounded-xl text-[10px] font-black uppercase ${engineOn ? 'bg-amber-400 text-black' : 'bg-indigo-600 text-white'}`}>
            {engineOn ? 'Pause Engine' : 'Start Engine'}
          </button>
          <button disabled={busy} onClick={() => void engineAction('emergency')} className="px-5 py-3 rounded-xl text-[10px] font-black uppercase bg-rose-700 text-white border border-rose-500/40">Emergency Stop</button>
        </div>
      </div>
      <div className="mt-5 flex flex-wrap gap-2">
        <Nav active={view === 'dashboard'} onClick={() => setView('dashboard')}>Dashboard</Nav>
        <Nav active={view === 'settings'} onClick={() => setView('settings')}>Configuración</Nav>
        <Nav active={view === 'backtest'} onClick={() => setView('backtest')}>Backtest Binance</Nav>
      </div>
    </header>
  );
}

function Dashboard({ state, patchSettings, run, busy }: any) {
  const settings = state.settings || {};
  const binance = state.brokerStatus?.binance || {};
  const paper = state.paper || {};
  const cryptoMetrics = settings.appMode === 'PAPER' ? (paper.metrics || emptyMetrics) : (state.metrics?.crypto || emptyMetrics);
  const cryptoScanner = state.scanners?.crypto || {};
  const cryptoPositions = state.active?.crypto || [];
  const cryptoOpps = state.opportunities?.crypto || [];
  const cryptoHistory = state.recentTrades || [];
  const forexScanner = state.scanners?.forex || {};
  const forexPerformance = forexScanner.performance || emptyForexPerformance;
  const forexSignals = state.forexSignals || [];
  const forexDiagnostics = state.forexDiagnostics || [];
  const forexData = state.brokerStatus?.forexData || {};

  return (
    <div className="grid grid-cols-1 2xl:grid-cols-2 gap-4 items-start">
      <MarketPanel title="CRYPTO · BINANCE USD-M FUTURES" subtitle="V33.5 estructural · ejecución automática · izquierda" accent="indigo">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <MiniMetric label={settings.appMode === 'PAPER' ? 'Paper Balance' : 'Saldo Futures'} value={money(settings.appMode === 'PAPER' ? paper.balance : binance.balance)} />
          <MiniMetric label={settings.appMode === 'PAPER' ? 'Paper Equity' : 'Disponible'} value={money(settings.appMode === 'PAPER' ? paper.equity : binance.availableBalance)} />
          <MiniMetric label="Net PnL" value={money(cryptoMetrics.netProfit)} tone={Number(cryptoMetrics.netProfit) >= 0 ? 'green' : 'red'} />
          <MiniMetric label="Win Rate" value={pct(cryptoMetrics.winRate)} />
          <MiniMetric label="Profit Factor" value={factor(cryptoMetrics.profitFactor)} />
          <MiniMetric label="Expectancy" value={money(cryptoMetrics.expectancy)} />
          <MiniMetric label="Abiertas" value={`${cryptoPositions.length}/${settings.maxConcurrentCryptoTrades || 10}`} />
          <MiniMetric label="ROE actual total" value={pct(totalRoe(cryptoPositions))} tone={totalRoe(cryptoPositions) >= 0 ? 'green' : 'red'} />
        </div>

        <ScannerCard scanner={cryptoScanner} kind="crypto" />

        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <InfoBox label="Leverage objetivo" value={`${settings.cryptoRequestedLeverage || 1}x`} />
          <InfoBox label="Margen/trade" value={pct(settings.cryptoMarginPctPerTrade)} />
          <InfoBox label="Audit aprobadas" value={String(cryptoScanner.qualifiedUniverse ?? 0)} />
          <InfoBox label="Modelo SL/TP" value="ESTRUCTURA V33.5" />
        </div>

        <div className="rounded-2xl border border-indigo-800/30 bg-indigo-500/5 p-3 text-[9px] leading-5 text-indigo-100/80">
          <b>FUTURES:</b> SL/TP son niveles de precio estructurales. La columna ROE muestra el efecto del apalancamiento. Ejemplo: 0.40% de movimiento × 20x ≈ 8% ROE antes de fees/funding.
        </div>

        <div className="flex flex-wrap gap-2">
          <SecondaryButton disabled={busy || !settings.engineEnabled} onClick={() => run(() => v34Api.runCryptoScanner(), 'Scanner Crypto ejecutado.')}>Escanear Crypto ahora</SecondaryButton>
        </div>

        <Block title="POSICIONES ABIERTAS · PRECIO + ROE FUTURES">
          <PositionTable rows={cryptoPositions} paper={settings.appMode === 'PAPER'} busy={busy} onClose={(id: string) => run(() => v34Api.closePaperTrade(id), 'PAPER cerrada.')} />
        </Block>

        <Block title="OPORTUNIDADES RENTABLES APROBADAS">
          <OpportunityTable rows={cryptoOpps} leverage={settings.cryptoRequestedLeverage || 1} />
        </Block>

        <Block title={`HISTORIAL ${settings.appMode} · UNA SOLA TABLA`}>
          <TradeHistory rows={cryptoHistory.slice(0, 60)} />
        </Block>

        {settings.appMode === 'PAPER' && (
          <Block title="ESTADÍSTICA PAPER POR COIN">
            <PaperBySymbol rows={Object.entries(paper.bySymbol || {})} />
          </Block>
        )}
      </MarketPanel>

      <MarketPanel title="FOREX / METALS / INDICES · SIGNAL DESK" subtitle="señales manuales · derecha · sin ejecución automática" accent="cyan">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <MiniMetric label="Data" value={forexData.connected ? 'CONECTADA' : String(forexData.status || 'ERROR')} tone={forexData.connected ? 'green' : 'red'} />
          <MiniMetric label="Señales rastreadas" value={String(forexPerformance.tracked || 0)} />
          <MiniMetric label="Resueltas" value={String(forexPerformance.resolved || 0)} />
          <MiniMetric label="Abiertas" value={String(forexPerformance.open || 0)} />
          <MiniMetric label="Win Rate" value={pct(forexPerformance.winRate)} />
          <MiniMetric label="Profit Factor" value={factor(forexPerformance.profitFactor)} />
          <MiniMetric label="Expectancy" value={pct(forexPerformance.expectancyPct)} />
          <MiniMetric label="Net Return" value={pct(forexPerformance.netReturnPct)} tone={Number(forexPerformance.netReturnPct) >= 0 ? 'green' : 'red'} />
        </div>

        <ScannerCard scanner={forexScanner} kind="forex" />

        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <InfoBox label="Instrumentos" value={String((settings.forexSymbols || []).length)} />
          <InfoBox label="Intervalo efectivo" value={`${forexScanner.effectiveIntervalMinutes || settings.forexSignalScanIntervalMinutes || '—'} min`} />
          <InfoBox label="Créditos/día est." value={String(forexScanner.estimatedDailyCredits || estimateCredits(settings))} />
          <InfoBox label="Créditos restantes" value={String(forexScanner.usage?.creditsLeft ?? forexData.usage?.creditsLeft ?? '—')} />
        </div>

        <div className="rounded-2xl border border-cyan-800/30 bg-cyan-500/5 p-3 text-[9px] leading-5 text-cyan-100/80">
          <b>Universo:</b> {(settings.forexSymbols || []).join(' · ') || 'Sin instrumentos'}. XAUUSD se consulta como XAU/USD. NAS100 se resuelve contra el catálogo de Twelve Data; si el plan no lo permite, solo ese instrumento queda marcado con error.
        </div>

        <div className="flex flex-wrap gap-2">
          <SecondaryButton disabled={busy || !forexData.configured} onClick={() => run(() => v34Api.runForexScanner(), 'Scanner Forex ejecutado.')}>Escanear Forex ahora</SecondaryButton>
        </div>

        {forexDiagnostics.length > 0 && (
          <Block title="ERRORES DE DATOS POR INSTRUMENTO">
            <div className="max-h-44 overflow-y-auto divide-y divide-slate-900">
              {forexDiagnostics.slice(0, 12).map((d: any, i: number) => (
                <div key={`${d.symbol || d.key}-${i}`} className="p-3 text-[8px] leading-5">
                  <span className="font-black text-rose-300">{d.symbol || d.key}</span><span className="text-slate-500"> · {d.error || 'Error de datos'}</span>
                </div>
              ))}
            </div>
          </Block>
        )}

        <Block title="RENDIMIENTO POR INSTRUMENTO">
          <ForexPerformanceBySymbol rows={forexPerformance.bySymbol || []} />
        </Block>

        <Block title="ÚLTIMAS SEÑALES">
          <ForexSignalTable rows={forexSignals} />
        </Block>

        <Block title="RESULTADO VIRTUAL DE SEÑALES · WIN / LOSS / EXPIRED">
          <ForexOutcomeTable rows={forexPerformance.recent || []} />
        </Block>
      </MarketPanel>
    </div>
  );
}

function ScannerCard({ scanner, kind }: any) {
  const audit = scanner.auditProgress || {};
  return (
    <div className="rounded-2xl bg-black/30 border border-slate-800 p-3 space-y-2">
      <div className="flex flex-wrap gap-3 text-[8px] uppercase tracking-widest text-slate-500">
        <b className="text-white">{scanner.status || 'INICIALIZANDO'}</b>
        {scanner.qualification && <span>{scanner.qualification}</span>}
        {scanner.current && <span>{scanner.current}</span>}
        {scanner.scanned != null && scanner.total != null && <span>{scanner.scanned}/{scanner.total}</span>}
        {scanner.diagnostic && <span className="text-amber-300">{scanner.diagnostic}</span>}
      </div>
      {kind === 'crypto' && (
        <div className="grid grid-cols-4 gap-2 text-center">
          <Tiny label="Detectadas" value={scanner.opportunities || 0} />
          <Tiny label="Revalidadas" value={scanner.revalidated || 0} />
          <Tiny label="Seleccionadas" value={scanner.selected || 0} />
          <Tiny label="Ejecutadas" value={scanner.executed || 0} />
        </div>
      )}
      {kind === 'crypto' && audit.total != null && (
        <p className="text-[8px] text-slate-600">Auditor Binance: {audit.completed || 0}/{audit.total || 0} · {audit.status || '—'} {audit.current ? `· ${audit.current}` : ''}</p>
      )}
      {kind === 'crypto' && scanner.lastExecutionErrors?.length > 0 && (
        <p className="text-[8px] text-rose-400 break-all">Último rechazo: {String(scanner.lastExecutionErrors.at(-1))}</p>
      )}
      {kind === 'forex' && (
        <div className="grid grid-cols-4 gap-2 text-center">
          <Tiny label="Escaneadas" value={scanner.scanned || 0} />
          <Tiny label="Setups" value={scanner.signals || 0} />
          <Tiny label="Calificadas" value={scanner.qualified || 0} />
          <Tiny label="Errores" value={scanner.errors || 0} />
        </div>
      )}
    </div>
  );
}

function PositionTable({ rows, paper, busy, onClose }: any) {
  if (!rows.length) return <Empty text="Sin posiciones abiertas" />;
  return (
    <div className="overflow-x-auto"><table className="w-full min-w-[1100px] text-[9px]">
      <thead className="text-slate-600 uppercase"><tr><th className="p-3 text-left">Coin</th><th>Side</th><th>Lev</th><th>Margin</th><th>Entry</th><th>SL precio</th><th>SL mov./ROE</th><th>TP precio</th><th>TP mov./ROE</th><th>PnL</th><th>ROE actual</th><th>Estado</th>{paper && <th>Acción</th>}</tr></thead>
      <tbody>{rows.map((r: any) => {
        const lev = Number(r.leverage || 1);
        const sl = distancePct(r.side, r.entryPrice, r.stopLoss, 'STOP');
        const tp = distancePct(r.side, r.entryPrice, r.takeProfit, 'TP');
        const roe = currentRoe(r);
        return <tr key={r.id} className="border-t border-slate-900">
          <td className="p-3 text-white font-black">{r.symbol}</td><td className={`text-center font-black ${r.side === 'BUY' ? 'text-emerald-400' : 'text-rose-400'}`}>{r.side}</td><td className="text-center">{lev}x</td><td className="text-center">{money(r.marginUsed)}</td><td className="text-center">{price(r.entryPrice)}</td>
          <td className="text-center text-rose-300">{price(r.stopLoss)}</td><td className="text-center"><span className="text-slate-400">{sl.toFixed(3)}%</span><br/><b className="text-rose-300">≈ -{(sl * lev).toFixed(1)}% ROE</b></td>
          <td className="text-center text-emerald-300">{price(r.takeProfit)}</td><td className="text-center"><span className="text-slate-400">{tp.toFixed(3)}%</span><br/><b className="text-emerald-300">≈ +{(tp * lev).toFixed(1)}% ROE</b></td>
          <td className={`text-center font-black ${Number(r.unrealizedPnl) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{money(r.unrealizedPnl)}</td><td className={`text-center font-black ${roe >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{signedPct(roe)}</td><td className="text-center text-slate-500">{r.state}</td>
          {paper && <td className="text-center"><button disabled={busy} onClick={() => onClose?.(r.id)} className="px-2 py-1 rounded-lg border border-amber-700 text-amber-300 disabled:opacity-40">Cerrar</button></td>}
        </tr>;
      })}</tbody>
    </table></div>
  );
}

function OpportunityTable({ rows, leverage }: any) {
  if (!rows.length) return <Empty text="Sin setup válido ahora" />;
  return <div className="overflow-x-auto max-h-80 overflow-y-auto"><table className="w-full min-w-[900px] text-[9px]"><thead className="text-slate-600 uppercase sticky top-0 bg-[#080c12]"><tr><th className="p-3 text-left">Coin</th><th>Side</th><th>Score</th><th>WR</th><th>Entry</th><th>SL mov./ROE</th><th>TP mov./ROE</th></tr></thead><tbody>{rows.map((r: any) => {
    const lev = Number(leverage || 1); const sl = distancePct(r.side, r.entry, r.stopLoss, 'STOP'); const tp = distancePct(r.side, r.entry, r.takeProfit, 'TP');
    return <tr key={r.id} className="border-t border-slate-900"><td className="p-3 text-white font-black">{r.symbol}</td><td className={`text-center ${r.side === 'BUY' ? 'text-emerald-400' : 'text-rose-400'}`}>{r.side}</td><td className="text-center">{Number(r.score || 0).toFixed(1)}</td><td className="text-center">{pct(r.rollingWinRate)}</td><td className="text-center">{price(r.entry)}</td><td className="text-center text-rose-300">{sl.toFixed(3)}% / ≈{(sl * lev).toFixed(1)}%</td><td className="text-center text-emerald-300">{tp.toFixed(3)}% / ≈{(tp * lev).toFixed(1)}%</td></tr>;
  })}</tbody></table></div>;
}

function TradeHistory({ rows }: any) {
  if (!rows.length) return <Empty text="Sin historial" />;
  return <div className="overflow-x-auto max-h-[430px] overflow-y-auto"><table className="w-full min-w-[1000px] text-[9px]"><thead className="text-slate-600 uppercase sticky top-0 bg-[#080c12]"><tr><th className="p-3 text-left">Coin</th><th>Modo</th><th>Side</th><th>Lev</th><th>Entry</th><th>Exit</th><th>PnL neto</th><th>ROI/ROE</th><th>Cierre</th></tr></thead><tbody>{rows.map((r: any) => { const net = tradeNetPnl(r); const roe = r.marginUsed ? net / Number(r.marginUsed) * 100 : 0; return <tr key={r.id} className="border-t border-slate-900"><td className="p-3 text-white font-black">{r.symbol}</td><td className="text-center text-slate-500">{r.executionMode || '—'}</td><td className="text-center">{r.side}</td><td className="text-center">{r.leverage || '—'}x</td><td className="text-center">{price(r.entryPrice)}</td><td className="text-center">{price(r.exitPrice)}</td><td className={`text-center font-black ${net >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{money(net)}</td><td className={`text-center font-black ${roe >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{signedPct(roe)}</td><td className="text-center text-slate-600">{r.closeReason || '—'}</td></tr>; })}</tbody></table></div>;
}

function PaperBySymbol({ rows }: any) {
  if (!rows.length) return <Empty text="Aún no hay operaciones cerradas" />;
  return <div className="overflow-x-auto"><table className="w-full min-w-[650px] text-[9px]"><thead className="text-slate-600 uppercase"><tr><th className="p-3 text-left">Coin</th><th>Trades</th><th>W/L</th><th>WR</th><th>Net</th><th>PF</th><th>Expectancy</th></tr></thead><tbody>{rows.map(([symbol, m]: any) => <tr key={symbol} className="border-t border-slate-900"><td className="p-3 text-white font-black">{symbol}</td><td className="text-center">{m.trades || 0}</td><td className="text-center">{m.wins || 0}/{m.losses || 0}</td><td className="text-center">{pct(m.winRate)}</td><td className={`text-center ${Number(m.netProfit) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{money(m.netProfit)}</td><td className="text-center">{factor(m.profitFactor)}</td><td className="text-center">{money(m.expectancy)}</td></tr>)}</tbody></table></div>;
}

function ForexPerformanceBySymbol({ rows }: any) {
  if (!rows.length) return <Empty text="Aún no hay señales resueltas para estadística" />;
  return <div className="overflow-x-auto max-h-72 overflow-y-auto"><table className="w-full min-w-[760px] text-[9px]"><thead className="text-slate-600 uppercase sticky top-0 bg-[#080c12]"><tr><th className="p-3 text-left">Instrumento</th><th>Tracked</th><th>Resolved</th><th>W/L</th><th>WR</th><th>Net %</th><th>PF</th><th>Expect.</th></tr></thead><tbody>{rows.map((r: any) => <tr key={r.symbol} className="border-t border-slate-900"><td className="p-3 text-white font-black">{r.symbol}</td><td className="text-center">{r.tracked}</td><td className="text-center">{r.resolved}</td><td className="text-center">{r.wins}/{r.losses}</td><td className="text-center">{pct(r.winRate)}</td><td className={`text-center font-black ${Number(r.netReturnPct) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{signedPct(r.netReturnPct)}</td><td className="text-center">{factor(r.profitFactor)}</td><td className="text-center">{signedPct(r.expectancyPct)}</td></tr>)}</tbody></table></div>;
}

function ForexSignalTable({ rows }: any) {
  if (!rows.length) return <Empty text="Aún no hay señales Forex válidas" />;
  return <div className="overflow-x-auto max-h-72 overflow-y-auto"><table className="w-full min-w-[850px] text-[9px]"><thead className="text-slate-600 uppercase sticky top-0 bg-[#080c12]"><tr><th className="p-3 text-left">Instrumento</th><th>Side</th><th>Entry</th><th>SL</th><th>TP1</th><th>TP2</th><th>TP3</th><th>Conf.</th><th>WR</th></tr></thead><tbody>{rows.map((r: any) => <tr key={r.id} className="border-t border-slate-900"><td className="p-3 text-white font-black">{r.symbol}</td><td className={`text-center font-black ${r.side === 'BUY' ? 'text-emerald-400' : 'text-rose-400'}`}>{r.side}</td><td className="text-center">{price(r.entry)}</td><td className="text-center text-rose-300">{price(r.stopLoss)}</td><td className="text-center text-emerald-300">{price(r.takeProfit)}</td><td className="text-center">{price(r.tp2)}</td><td className="text-center">{price(r.tp3)}</td><td className="text-center">{pct(r.confidence)}</td><td className="text-center">{pct(r.rollingWinRate)}</td></tr>)}</tbody></table></div>;
}

function ForexOutcomeTable({ rows }: any) {
  if (!rows.length) return <Empty text="Aún no hay resultados virtuales" />;
  return <div className="overflow-x-auto max-h-72 overflow-y-auto"><table className="w-full min-w-[760px] text-[9px]"><thead className="text-slate-600 uppercase sticky top-0 bg-[#080c12]"><tr><th className="p-3 text-left">Instrumento</th><th>Side</th><th>Estado</th><th>Entry</th><th>Exit</th><th>Return</th><th>Fecha</th></tr></thead><tbody>{rows.map((r: any) => <tr key={r.signalId} className="border-t border-slate-900"><td className="p-3 text-white font-black">{r.symbol}</td><td className="text-center">{r.side}</td><td className={`text-center font-black ${r.status === 'WIN' ? 'text-emerald-400' : r.status === 'LOSS' ? 'text-rose-400' : r.status === 'EXPIRED' ? 'text-amber-300' : 'text-cyan-300'}`}>{r.status}</td><td className="text-center">{price(r.entry)}</td><td className="text-center">{price(r.exitPrice)}</td><td className={`text-center font-black ${Number(r.returnPct) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{r.returnPct == null ? '—' : signedPct(r.returnPct)}</td><td className="text-center text-slate-600">{new Date(r.createdAt).toLocaleString()}</td></tr>)}</tbody></table></div>;
}

function Settings({ state, patchSettings, run, busy }: any) {
  const settings = state.settings || {};
  const integrations = state.integrations || [];
  const binance = statusOf(integrations, 'BINANCE');
  const forex = statusOf(integrations, 'TWELVE_DATA');
  const telegram = statusOf(integrations, 'TELEGRAM');
  const [apiKey, setApiKey] = useState(''); const [apiSecret, setApiSecret] = useState('');
  const [forexKey, setForexKey] = useState(''); const [botToken, setBotToken] = useState(''); const [chatId, setChatId] = useState('');
  const [symbols, setSymbols] = useState((settings.forexSymbols || []).join(', '));
  useEffect(() => setSymbols((settings.forexSymbols || []).join(', ')), [settings.forexSymbols]);

  const saveSymbols = () => run(async () => {
    const list = symbols.split(',').map((s) => s.trim().toUpperCase().replace(/\//g, '')).filter(Boolean);
    const result = await v34Api.patchSettings({ forexSymbols: [...new Set(list)] });
    if (settings.engineEnabled) await v34Api.runForexScanner();
    return result;
  }, 'Instrumentos Forex guardados.');

  return <div className="space-y-4">
    <Panel title="INTEGRACIONES">
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <IntegrationBox title="BINANCE FUTURES" status={binance}>
          <Text label="API Key" value={apiKey} set={setApiKey} /><Text label="API Secret" value={apiSecret} set={setApiSecret} secret />
          <Actions busy={busy} configured={binance.configured} save={() => run(async () => { const r = await v34Api.saveBinanceIntegration(apiKey.trim(), apiSecret.trim()); setApiKey(''); setApiSecret(''); return r; }, 'Binance guardado.')} test={() => run(() => v34Api.testIntegration('binance'), 'Binance validado.')} remove={() => run(() => v34Api.removeIntegration('binance'), 'Binance desconectado.')} />
        </IntegrationBox>
        <IntegrationBox title="TWELVE DATA" status={forex}>
          <Text label="API Key" value={forexKey} set={setForexKey} secret />
          <Actions busy={busy} configured={forex.configured} save={() => run(async () => { const r = await v34Api.saveForexDataIntegration(forexKey.trim()); setForexKey(''); if (settings.engineEnabled) await v34Api.runForexScanner(); return r; }, 'Forex Data guardado.')} test={() => run(() => v34Api.testIntegration('twelve-data'), 'Forex Data validado.')} remove={() => run(() => v34Api.removeIntegration('twelve-data'), 'Forex Data desconectado.')} />
        </IntegrationBox>
        <IntegrationBox title="TELEGRAM" status={telegram}>
          <Text label="Bot Token" value={botToken} set={setBotToken} secret /><Text label="Chat ID" value={chatId} set={setChatId} />
          <Actions busy={busy} configured={telegram.configured} save={() => run(async () => { const r = await v34Api.saveTelegramIntegration(botToken.trim(), chatId.trim()); setBotToken(''); setChatId(''); return r; }, 'Telegram guardado.')} test={() => run(() => v34Api.testIntegration('telegram'), 'Telegram validado.')} remove={() => run(() => v34Api.removeIntegration('telegram'), 'Telegram desconectado.')} />
        </IntegrationBox>
      </div>
    </Panel>

    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
      <Panel title="CRYPTO FUTURES / PAPER">
        <div className="grid grid-cols-2 gap-2">
          <Toggle label="Crypto activo" checked={Boolean(settings.cryptoEnabled)} onChange={(v: boolean) => patchSettings({ cryptoEnabled: v })} />
          <NumberEdit label="Slots" value={settings.maxConcurrentCryptoTrades} min={1} max={10} step={1} suffix="/10" save={(v: number) => patchSettings({ maxConcurrentCryptoTrades: v })} />
          <NumberEdit label="Margen por trade" value={settings.cryptoMarginPctPerTrade} min={0.01} max={100} step={0.1} suffix="%" save={(v: number) => patchSettings({ cryptoMarginPctPerTrade: v })} />
          <NumberEdit label="Leverage" value={settings.cryptoRequestedLeverage} min={1} max={125} step={1} suffix="x" save={(v: number) => patchSettings({ cryptoRequestedLeverage: v })} />
          <NumberEdit label="Riesgo máx./trade" value={settings.cryptoMaxLossPctPerTrade} min={0.1} max={100} step={0.1} suffix="% balance" save={(v: number) => patchSettings({ cryptoMaxLossPctPerTrade: v })} />
          <NumberEdit label="Exposición máx." value={settings.cryptoMaxAccountExposurePct} min={1} max={100} step={1} suffix="%" save={(v: number) => patchSettings({ cryptoMaxAccountExposurePct: v })} />
          <NumberEdit label="Confianza mín." value={settings.cryptoMinSignalConfidence} min={0} max={100} step={1} suffix="%" save={(v: number) => patchSettings({ cryptoMinSignalConfidence: v })} />
          <NumberEdit label="Rolling WR mín." value={settings.cryptoMinRollingWinRate} min={0} max={100} step={1} suffix="%" save={(v: number) => patchSettings({ cryptoMinRollingWinRate: v })} />
          <NumberEdit label="Capital PAPER" value={settings.paperInitialBalance} min={1} max={1000000000} step={10} suffix="USDT" save={(v: number) => patchSettings({ paperInitialBalance: v })} />
          <NumberEdit label="Costo PAPER round-trip" value={settings.paperRoundTripCostPct} min={0} max={10} step={0.01} suffix="%" save={(v: number) => patchSettings({ paperRoundTripCostPct: v })} />
        </div>
        <Hint>R8 no usa el piso artificial 1%/1.5% de R7. SL y TP vuelven a ser estructura/fractal/ATR + 1.35R/2.2R/3.5R. El leverage se refleja en margen, PnL y ROE.</Hint>
      </Panel>

      <Panel title="FOREX / METALS / INDICES">
        <Toggle label="Forex signals" checked={Boolean(settings.forexEnabled)} onChange={(v: boolean) => patchSettings({ forexEnabled: v })} />
        <label className="block mt-3"><span className="field-label">Instrumentos</span><textarea className="field min-h-36" value={symbols} onChange={(e) => setSymbols(e.target.value)} /></label>
        <div className="grid grid-cols-2 gap-2 mt-3">
          <NumberEdit label="Intervalo deseado" value={settings.forexSignalScanIntervalMinutes} min={1} max={1440} step={1} suffix="min" save={(v: number) => patchSettings({ forexSignalScanIntervalMinutes: v })} />
          <NumberEdit label="Máx. señales/ciclo" value={settings.forexSignalsPerCycle} min={1} max={20} step={1} save={(v: number) => patchSettings({ forexSignalsPerCycle: v })} />
          <NumberEdit label="Confianza mín." value={settings.forexMinSignalConfidence} min={0} max={100} step={1} suffix="%" save={(v: number) => patchSettings({ forexMinSignalConfidence: v })} />
          <NumberEdit label="Rolling WR mín." value={settings.forexMinRollingWinRate} min={0} max={100} step={1} suffix="%" save={(v: number) => patchSettings({ forexMinRollingWinRate: v })} />
        </div>
        <div className="flex flex-wrap gap-2 mt-3"><PrimaryButton disabled={busy} onClick={() => void saveSymbols()}>Guardar instrumentos</PrimaryButton><SecondaryButton disabled={busy || !forex.configured} onClick={() => run(() => v34Api.runForexScanner(), 'Forex escaneado.')}>Escanear ahora</SecondaryButton></div>
        <Hint>La app puede elevar automáticamente el intervalo efectivo para no exceder el presupuesto de créditos. Agregar instrumentos sin aumentar intervalo no debe convertir el scanner en una tormenta de 429.</Hint>
      </Panel>
    </div>
  </div>;
}

function Backtest({ settings }: any) {
  const [symbols, setSymbols] = useState('BTCUSDT, ETHUSDT, SOLUSDT, XRPUSDT, BNBUSDT');
  const [startDate, setStartDate] = useState(daysAgo(7)); const [endDate, setEndDate] = useState(today());
  const [runs, setRuns] = useState<any[]>([]); const [selected, setSelected] = useState(''); const [detail, setDetail] = useState<any>(null); const [error, setError] = useState('');
  const load = useCallback(async () => { try { const r = await v34Api.listBacktests(20); setRuns(r.runs || []); if (!selected && r.runs?.[0]?.id) setSelected(r.runs[0].id); } catch (e: any) { setError(e?.message || String(e)); } }, [selected]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (!selected) return; let on = true; const f = async () => { try { const r = await v34Api.getBacktest(selected); if (on) setDetail(r.run); } catch (e: any) { if (on) setError(e?.message || String(e)); } }; void f(); const t = window.setInterval(() => void f(), 4000); return () => { on = false; window.clearInterval(t); }; }, [selected]);
  const start = async () => { try { setError(''); const list = symbols.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean); const r = await v34Api.createBacktest({ broker:'BINANCE', symbols:[...new Set(list)].slice(0,25), startTime:new Date(`${startDate}T00:00:00Z`).getTime(), endTime:new Date(`${endDate}T23:59:59Z`).getTime(), initialBalance:1000, allocationPct:Number(settings.cryptoMarginPctPerTrade || 1), leverage:Number(settings.cryptoRequestedLeverage || 20), roundTripCostPct:0.12, scanStepMinutes:3, maxHoldMinutes:90, sizingMode:'MARGIN_PERCENT' }); setSelected(r.id); await load(); } catch(e:any){setError(e?.message||String(e));} };
  const result = detail?.result;
  return <div className="grid grid-cols-1 2xl:grid-cols-[420px_1fr] gap-4"><Panel title="BACKTEST BINANCE"><label><span className="field-label">Coins</span><textarea className="field min-h-24" value={symbols} onChange={(e)=>setSymbols(e.target.value)} /></label><div className="grid grid-cols-2 gap-2 mt-3"><DateEdit label="Desde" value={startDate} set={setStartDate}/><DateEdit label="Hasta" value={endDate} set={setEndDate}/></div><div className="mt-3"><PrimaryButton onClick={() => void start()}>Ejecutar</PrimaryButton></div>{error && <p className="mt-3 text-rose-400 text-[9px]">{error}</p>}<div className="mt-4 space-y-2 max-h-[420px] overflow-auto">{runs.map((r:any)=><button key={r.id} onClick={()=>setSelected(r.id)} className={`w-full text-left p-3 rounded-xl border ${selected===r.id?'border-indigo-500 bg-indigo-500/10':'border-slate-800'}`}><b className="text-[9px]">{(r.request?.symbols||[]).join(', ')}</b><p className="text-[8px] text-slate-600 mt-1">{r.status}</p></button>)}</div></Panel><Panel title="RESULTADO">{!detail && <Empty text="Selecciona una corrida"/>}{detail && !result && <Empty text={`${detail.status} · ${detail.progress?.stage || 'Procesando'}`}/>} {result && <BacktestResult result={result}/>}</Panel></div>;
}

function BacktestResult({ result }: any) { const m=result.metrics||{}, o=result.outOfSample||{}; return <div className="space-y-4"><div className="grid grid-cols-2 md:grid-cols-4 gap-2"><MiniMetric label="Net" value={money(m.netProfit)}/><MiniMetric label="Return" value={pct(m.returnPct)}/><MiniMetric label="WR" value={pct(m.winRate)}/><MiniMetric label="PF" value={factor(m.profitFactor)}/><MiniMetric label="Expect." value={money(m.expectancy)}/><MiniMetric label="Max DD" value={pct(m.maxDrawdownPct)}/><MiniMetric label="Costos" value={money(m.costs)}/><MiniMetric label="Trades" value={String(m.trades||0)}/></div><div className="rounded-2xl border border-indigo-500/20 p-4 text-[9px]"><b>OOS 30%</b> · Profit {money(o.netProfit)} · WR {pct(o.winRate)} · PF {factor(o.profitFactor)} · Expectancy {money(o.expectancy)}</div><PaperBySymbol rows={(result.bySymbol||[]).map((r:any)=>[r.symbol,r.metrics])}/></div>; }

function IntegrationBox({ title, status, children }: any) { const ok=status.lastTestOk===true; return <div className="rounded-2xl border border-slate-800 bg-black/20 p-4"><div className="flex justify-between gap-2 mb-3"><b className="text-[9px] text-white">{title}</b><span className={`text-[7px] px-2 py-1 rounded ${ok?'bg-emerald-500/10 text-emerald-400':status.configured?'bg-amber-500/10 text-amber-400':'bg-slate-800 text-slate-500'}`}>{ok?'CONECTADO':status.configured?'REVISAR':'NO CONFIGURADO'}</span></div>{status.lastError && <p className="mb-2 text-[8px] text-rose-400 break-all">{status.lastError}</p>}<div className="space-y-2">{children}</div></div>; }
function Actions({ busy, configured, save, test, remove }: any) { return <div className="flex flex-wrap gap-2"><PrimaryButton disabled={busy} onClick={()=>void save()}>Guardar</PrimaryButton>{configured && <><SecondaryButton disabled={busy} onClick={()=>void test()}>Probar</SecondaryButton><DangerButton disabled={busy} onClick={()=>void remove()}>Desconectar</DangerButton></>}</div>; }
function Text({ label, value, set, secret=false }: any){return <label><span className="field-label">{label}</span><input className="field" type={secret?'password':'text'} value={value} onChange={(e)=>set(e.target.value)} autoComplete="off"/></label>;}
function NumberEdit({ label,value,min,max,step,suffix='',save }:any){const[d,setD]=useState(String(value??''));useEffect(()=>setD(String(value??'')),[value]);const commit=()=>{const n=Number(d);if(Number.isFinite(n))void save(n)};return <label className="rounded-2xl border border-slate-800 bg-black/20 p-3"><span className="field-label">{label}</span><div className="flex items-center gap-2"><input className="field" type="number" value={d} min={min} max={max} step={step} onChange={(e)=>setD(e.target.value)} onBlur={commit} onKeyDown={(e)=>e.key==='Enter'&&commit()}/>{suffix&&<span className="text-[8px] text-slate-500">{suffix}</span>}</div></label>;}
function Toggle({label,checked,onChange}:any){return <button onClick={()=>void onChange(!checked)} className={`rounded-2xl border p-3 text-left ${checked?'border-emerald-600/40 bg-emerald-500/5':'border-slate-800 bg-black/20'}`}><span className="field-label">{label}</span><b className={checked?'text-emerald-400':'text-slate-600'}>{checked?'ACTIVO':'OFF'}</b></button>;}
function DateEdit({label,value,set}:any){return <label><span className="field-label">{label}</span><input className="field" type="date" value={value} onChange={(e)=>set(e.target.value)}/></label>;}

function MarketPanel({title,subtitle,accent,children}:any){return <section className={`bg-[#0d1117] border ${accent==='cyan'?'border-cyan-950':'border-indigo-950'} rounded-[2rem] p-4 md:p-5 space-y-4 shadow-2xl min-w-0`}><div><h2 className={`text-lg font-black italic uppercase ${accent==='cyan'?'text-cyan-400':'text-indigo-400'}`}>{title}</h2><p className="text-[8px] text-slate-500 uppercase tracking-widest mt-1">{subtitle}</p></div>{children}</section>;}
function Panel({title,children}:any){return <section className="bg-[#0d1117] border border-slate-800 rounded-3xl p-4 md:p-5 shadow-xl"><h3 className="text-[9px] uppercase tracking-[0.18em] font-black text-slate-400 mb-4">{title}</h3>{children}</section>;}
function Block({title,children}:any){return <div className="border border-slate-800 rounded-2xl overflow-hidden bg-black/20"><div className="px-4 py-3 border-b border-slate-800 text-[8px] uppercase tracking-widest font-black text-slate-500">{title}</div>{children}</div>;}
function MiniMetric({label,value,tone}:any){return <div className="rounded-xl border border-slate-800 bg-black/30 p-3 min-w-0"><p className="text-[7px] uppercase tracking-wider font-black text-slate-600">{label}</p><p className={`mt-1 text-sm font-black break-words ${tone==='green'?'text-emerald-400':tone==='red'?'text-rose-400':'text-white'}`}>{value}</p></div>;}
function InfoBox({label,value}:any){return <div className="rounded-xl border border-slate-800 bg-black/30 p-3 min-w-0"><p className="field-label">{label}</p><p className="text-xs text-white font-black break-words">{value}</p></div>;}
function Tiny({label,value}:any){return <div className="rounded-lg bg-slate-900/70 p-2"><p className="text-[6px] uppercase text-slate-600">{label}</p><b className="text-xs text-white">{value}</b></div>;}
function Hint({children}:any){return <div className="mt-3 rounded-xl border border-slate-800 bg-slate-900/50 p-3 text-[8px] text-slate-500 leading-5">{children}</div>;}
function Banner({tone,children}:any){return <div className={`rounded-2xl border px-4 py-3 text-[10px] ${tone==='error'?'border-rose-500/30 bg-rose-500/10 text-rose-300':'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'}`}>{children}</div>;}
function Empty({text}:any){return <div className="py-8 text-center text-[8px] uppercase tracking-widest text-slate-700">{text}</div>;}
function Connection({label,ok,pending=false}:any){return <span className="flex items-center gap-1.5"><i className={`w-1.5 h-1.5 rounded-full ${ok?'bg-emerald-400':pending?'bg-amber-400':'bg-rose-500'}`}/>{label}</span>;}
function Nav({active,children,onClick}:any){return <button onClick={onClick} className={`px-4 py-2 rounded-xl text-[9px] uppercase font-black tracking-widest border ${active?'bg-indigo-600 border-indigo-500 text-white':'bg-black/20 border-slate-800 text-slate-500'}`}>{children}</button>;}
const PrimaryButton=({children,onClick,disabled}:any)=><button disabled={disabled} onClick={onClick} className="px-4 py-2.5 rounded-xl bg-indigo-600 disabled:opacity-40 text-white text-[8px] uppercase tracking-widest font-black">{children}</button>;
const SecondaryButton=({children,onClick,disabled}:any)=><button disabled={disabled} onClick={onClick} className="px-4 py-2.5 rounded-xl border border-slate-700 disabled:opacity-40 text-slate-300 text-[8px] uppercase tracking-widest font-black">{children}</button>;
const DangerButton=({children,onClick,disabled}:any)=><button disabled={disabled} onClick={onClick} className="px-4 py-2.5 rounded-xl border border-rose-800 disabled:opacity-40 text-rose-400 text-[8px] uppercase tracking-widest font-black">{children}</button>;

const emptyMetrics={trades:0,wins:0,losses:0,winRate:0,netProfit:0,profitFactor:0,expectancy:0};
const emptyForexPerformance={tracked:0,open:0,resolved:0,wins:0,losses:0,expired:0,winRate:0,netReturnPct:0,profitFactor:0,expectancyPct:0,bySymbol:[],recent:[]};
function statusOf(items:any[],provider:Provider){return items.find((x)=>x.provider===provider)||{provider,configured:false};}
function distancePct(side:string,entry:any,level:any,kind:'STOP'|'TP'){const e=Number(entry),l=Number(level);if(!(e>0)||!(l>0))return 0;const d=side==='BUY'?(kind==='STOP'?e-l:l-e):(kind==='STOP'?l-e:e-l);return Math.max(0,d/e*100);}
function currentRoe(r:any){const margin=Number(r.marginUsed||0);return margin>0?Number(r.unrealizedPnl||0)/margin*100:0;}
function totalRoe(rows:any[]){const margin=rows.reduce((s,r)=>s+Math.max(0,Number(r.marginUsed||0)),0);const pnl=rows.reduce((s,r)=>s+Number(r.unrealizedPnl||0),0);return margin>0?pnl/margin*100:0;}
function tradeNetPnl(r:any){return r?.state==='CLOSED'?Number(r.realizedPnl||0)-Number(r.commission||0)+Number(r.fundingOrSwap||0):Number(r.unrealizedPnl||0);}
function estimateCredits(settings:any){const n=(settings.forexSymbols||[]).length;const m=Math.max(1,Number(settings.forexSignalScanIntervalMinutes||60));return Math.ceil(n*2*(1440/m));}
function money(v:any){const n=Number(v||0);return `${n<0?'-':''}$${Math.abs(n).toFixed(2)}`;}
function pct(v:any){return `${Number(v||0).toFixed(1)}%`;}
function signedPct(v:any){const n=Number(v||0);return `${n>0?'+':''}${n.toFixed(1)}%`;}
function factor(v:any){return v==null?'∞':Number(v||0).toFixed(2);}
function price(v:any){if(v==null)return '—';const n=Number(v);if(!Number.isFinite(n))return '—';return n>=1000?n.toFixed(2):n>=1?n.toFixed(5):n.toFixed(8);}
function today(){return new Date().toISOString().slice(0,10);} function daysAgo(d:number){return new Date(Date.now()-d*86400000).toISOString().slice(0,10);}

export default AppR8;
