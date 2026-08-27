import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { v34Api } from './services/v34Api';

const App: React.FC = () => {
  const [state, setState] = useState<any>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [lastSync, setLastSync] = useState<number>(0);

  const refresh = useCallback(async () => {
    try {
      const next = await v34Api.getState();
      setState(next);
      setError('');
      setLastSync(Date.now());
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const patchSettings = async (patch: Record<string, unknown>) => {
    setBusy(true);
    try {
      await v34Api.patchSettings(patch);
      await refresh();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const engineAction = async (action: 'start' | 'pause' | 'stop') => {
    setBusy(true);
    try {
      if (action === 'start') await v34Api.startEngine();
      if (action === 'pause') await v34Api.pauseEngine();
      if (action === 'stop') await v34Api.emergencyStop();
      await refresh();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const settings = state?.settings || {};
  const activeCrypto = state?.active?.crypto || [];
  const activeForex = state?.active?.forex || [];
  const cryptoOpps = state?.opportunities?.crypto || [];
  const forexOpps = state?.opportunities?.forex || [];
  const cryptoMetrics = state?.metrics?.crypto || emptyMetrics;
  const forexMetrics = state?.metrics?.forex || emptyMetrics;
  const globalMetrics = state?.metrics?.global || emptyMetrics;

  const recentCrypto = useMemo(
    () => (state?.recentTrades || []).filter((t: any) => t.broker === 'BINANCE').slice(0, 12),
    [state],
  );
  const recentForex = useMemo(
    () => (state?.recentTrades || []).filter((t: any) => t.broker === 'MT5').slice(0, 12),
    [state],
  );

  if (!state) {
    return (
      <div className="min-h-screen bg-[#010409] text-slate-200 flex items-center justify-center font-mono">
        <div className="text-center space-y-4">
          <div className="w-16 h-16 mx-auto border-4 border-indigo-500/20 border-t-indigo-500 rounded-full animate-spin" />
          <p className="text-xs uppercase tracking-[0.35em] text-slate-500">Conectando V34 Backend</p>
          {error && <p className="text-rose-400 text-xs max-w-xl">{error}</p>}
        </div>
      </div>
    );
  }

  const binanceStatus = state?.brokerStatus?.binance || {};
  const mt5Status = state?.brokerStatus?.mt5 || {};
  const telegramStatus = state?.brokerStatus?.telegram || {};

  return (
    <div className="min-h-screen bg-[#010409] text-slate-200 p-3 md:p-5 font-mono">
      <div className="max-w-[1800px] mx-auto space-y-4">
        <header className="bg-[#0d1117] border border-slate-800 rounded-3xl p-4 md:p-6 shadow-2xl">
          <div className="flex flex-col 2xl:flex-row 2xl:items-center justify-between gap-5">
            <div className="flex items-center gap-4">
              <StatusDot on={Boolean(settings.engineEnabled)} />
              <div>
                <h1 className="text-2xl md:text-3xl font-black italic tracking-tighter uppercase text-white">
                  QUANTUM<span className="text-indigo-500">DUAL</span> V34
                </h1>
                <div className="flex flex-wrap gap-3 mt-2 text-[9px] font-black uppercase tracking-widest text-slate-500">
                  <StatusLabel label="BINANCE" ok={settings.appMode === 'PAPER' || Boolean(binanceStatus.connected)} configured={binanceStatus.configured} />
                  <StatusLabel label="MT5" ok={settings.appMode === 'PAPER' || Boolean(mt5Status.connected)} configured={mt5Status.configured} />
                  <StatusLabel label="TELEGRAM" ok={Boolean(telegramStatus.configured)} configured={telegramStatus.configured} />
                  <span>DB: PERSISTENT</span>
                  <span>SYNC: {lastSync ? new Date(lastSync).toLocaleTimeString() : '—'}</span>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <select
                value={settings.appMode}
                disabled={busy || settings.engineEnabled}
                onChange={(e) => patchSettings({ appMode: e.target.value })}
                className="bg-black/60 border border-slate-700 rounded-xl px-4 py-3 text-[10px] font-black"
              >
                <option value="PAPER">PAPER</option>
                <option value="TESTNET">TESTNET / DEMO</option>
                <option value="REAL">REAL</option>
              </select>
              <button
                disabled={busy}
                onClick={() => engineAction(settings.engineEnabled ? 'pause' : 'start')}
                className={`px-6 py-3 rounded-xl text-[10px] font-black uppercase transition-all ${settings.engineEnabled ? 'bg-amber-500 text-black' : 'bg-indigo-600 text-white shadow-[0_0_22px_rgba(79,70,229,.35)]'}`}
              >
                {settings.engineEnabled ? 'PAUSE ENGINE' : 'START ENGINE'}
              </button>
              <button
                disabled={busy}
                onClick={() => engineAction('stop')}
                className="px-5 py-3 rounded-xl text-[10px] font-black uppercase bg-rose-700 text-white border border-rose-500/50"
              >
                EMERGENCY STOP
              </button>
            </div>
          </div>
          {error && <div className="mt-4 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 px-4 py-3 text-[10px]">{error}</div>}
        </header>

        <section className="grid grid-cols-2 lg:grid-cols-6 gap-3">
          <Metric title="Profit Global" value={money(globalMetrics.netProfit)} tone={globalMetrics.netProfit >= 0 ? 'green' : 'red'} />
          <Metric title="Win Rate Global" value={pct(globalMetrics.winRate)} />
          <Metric title="Crypto PnL" value={money(cryptoMetrics.netProfit)} tone={cryptoMetrics.netProfit >= 0 ? 'green' : 'red'} />
          <Metric title="Crypto WR" value={pct(cryptoMetrics.winRate)} />
          <Metric title="Forex PnL" value={money(forexMetrics.netProfit)} tone={forexMetrics.netProfit >= 0 ? 'green' : 'red'} />
          <Metric title="Forex WR" value={pct(forexMetrics.winRate)} />
        </section>

        <section className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <MarketPanel title="CRYPTO · BINANCE FUTURES" accent="indigo" subtitle="Máximo 10 coins simultáneas · símbolos únicos">
            <SettingsGrid>
              <NumberSetting label="Slots Crypto" value={settings.maxConcurrentCryptoTrades} min={1} max={10} step={1} suffix="/10" onSave={(v) => patchSettings({ maxConcurrentCryptoTrades: v })} />
              <NumberSetting label="Margen / trade" value={settings.cryptoMarginPctPerTrade} min={0.01} max={100} step={0.1} suffix="%" onSave={(v) => patchSettings({ cryptoMarginPctPerTrade: v })} />
              <NumberSetting label="Leverage pedido" value={settings.cryptoRequestedLeverage} min={1} max={125} step={1} suffix="x" onSave={(v) => patchSettings({ cryptoRequestedLeverage: v })} />
              <NumberSetting label="Pérdida máx. al SL" value={settings.cryptoMaxLossPctPerTrade} min={0.01} max={100} step={0.1} suffix="%" onSave={(v) => patchSettings({ cryptoMaxLossPctPerTrade: v })} />
              <NumberSetting label="Confianza mínima" value={settings.cryptoMinSignalConfidence} min={0} max={100} step={1} suffix="%" onSave={(v) => patchSettings({ cryptoMinSignalConfidence: v })} />
              <NumberSetting label="Rolling WR mínimo" value={settings.cryptoMinRollingWinRate} min={0} max={100} step={1} suffix="%" onSave={(v) => patchSettings({ cryptoMinRollingWinRate: v })} />
            </SettingsGrid>

            <MarketStats
              items={[
                ['Slots', `${activeCrypto.length}/${settings.maxConcurrentCryptoTrades}`],
                ['Coins únicas', String(new Set(activeCrypto.map((t: any) => t.symbol)).size)],
                ['Trades cerrados', String(cryptoMetrics.trades || 0)],
                ['Profit Factor', formatFactor(cryptoMetrics.profitFactor)],
              ]}
            />

            <Block title="POSICIONES ABIERTAS">
              <PositionTable trades={activeCrypto} market="CRYPTO" />
            </Block>

            <Block title="TOP 10 OPORTUNIDADES ÚNICAS">
              <OpportunityTable rows={cryptoOpps} crypto />
            </Block>

            <Block title="HISTORIAL CRYPTO">
              <HistoryTable trades={recentCrypto} />
            </Block>
          </MarketPanel>

          <MarketPanel title="FOREX · METATRADER 5" accent="cyan" subtitle="Retests permitidos · tickets independientes por entrada">
            <SettingsGrid>
              <NumberSetting label="Máx. tickets Forex" value={settings.maxConcurrentForexTrades} min={1} max={200} step={1} onSave={(v) => patchSettings({ maxConcurrentForexTrades: v })} />
              <NumberSetting label="% por operación" value={settings.forexPctPerTrade} min={0.01} max={100} step={0.1} suffix="%" onSave={(v) => patchSettings({ forexPctPerTrade: v })} />
              <SelectSetting label="Cálculo de lote" value={settings.forexRiskMode} options={[['RISK_TO_SL', 'Riesgo hasta SL'], ['MARGIN_PERCENT', '% de margen']]} onSave={(v) => patchSettings({ forexRiskMode: v })} />
              <NumberSetting label="Máx. entradas/par" value={settings.forexMaxEntriesPerSymbol} min={0} max={50} step={1} suffix={settings.forexMaxEntriesPerSymbol === 0 ? '∞' : ''} onSave={(v) => patchSettings({ forexMaxEntriesPerSymbol: v })} />
              <NumberSetting label="Slippage máx." value={settings.forexMaxDeviationPoints} min={0} max={1000} step={1} suffix="pts" onSave={(v) => patchSettings({ forexMaxDeviationPoints: v })} />
              <div className="bg-black/30 border border-slate-800 rounded-2xl p-3">
                <p className="text-[8px] text-slate-500 uppercase font-black tracking-widest">Modo de cuenta</p>
                <p className={`mt-2 text-sm font-black ${(mt5Status?.account?.hedging ?? settings.appMode === 'PAPER') ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {settings.appMode === 'PAPER' ? 'PAPER' : mt5Status?.account?.hedging ? 'HEDGING' : 'NETTING / CHECK'}
                </p>
              </div>
            </SettingsGrid>

            <MarketStats
              items={[
                ['Tickets', `${activeForex.length}/${settings.maxConcurrentForexTrades}`],
                ['Pares activos', String(new Set(activeForex.map((t: any) => t.symbol)).size)],
                ['Trades cerrados', String(forexMetrics.trades || 0)],
                ['Profit Factor', formatFactor(forexMetrics.profitFactor)],
              ]}
            />

            <Block title="POSICIONES / REENTRADAS ABIERTAS">
              <PositionTable trades={activeForex} market="FOREX" />
            </Block>

            <Block title="COLA DE SETUPS FOREX">
              <OpportunityTable rows={forexOpps} />
            </Block>

            <Block title="HISTORIAL FOREX">
              <HistoryTable trades={recentForex} />
            </Block>
          </MarketPanel>
        </section>

        <section className="bg-[#0d1117] border border-slate-800 rounded-3xl p-4 md:p-6 shadow-2xl">
          <div className="flex flex-wrap justify-between gap-4 items-center">
            <div>
              <h2 className="text-sm font-black uppercase tracking-widest text-white">Persistencia y seguridad operativa</h2>
              <p className="text-[9px] text-slate-500 mt-2 max-w-4xl leading-relaxed">
                La página ya no guarda la verdad operativa. Al abrirse consulta SQLite en el backend y reconstruye posiciones, historial y métricas. Binance usa como máximo 10 símbolos únicos; Forex permite múltiples tickets del mismo par únicamente cuando son señales/retests distintos y la cuenta MT5 admite hedging.
              </p>
            </div>
            <div className="text-right text-[9px] text-slate-500 uppercase space-y-1">
              <p>Closed trades: <span className="text-white font-black">{globalMetrics.trades || 0}</span></p>
              <p>Open trades: <span className="text-white font-black">{globalMetrics.openTrades || 0}</span></p>
              <p>Fees: <span className="text-white font-black">{money(globalMetrics.fees)}</span></p>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};

const emptyMetrics = {
  trades: 0, wins: 0, losses: 0, winRate: 0, netProfit: 0, profitFactor: 0,
  openTrades: 0, fees: 0, unrealizedPnl: 0,
};

const StatusDot = ({ on }: { on: boolean }) => (
  <div className={`w-3 h-3 rounded-full ${on ? 'bg-indigo-500 animate-pulse shadow-[0_0_15px_#6366f1]' : 'bg-slate-700'}`} />
);

const StatusLabel = ({ label, ok, configured }: { label: string; ok: boolean; configured?: boolean }) => (
  <span className="flex items-center gap-1.5">
    <i className={`w-1.5 h-1.5 rounded-full ${ok ? 'bg-emerald-500' : configured ? 'bg-amber-500' : 'bg-rose-500'}`} />
    {label}
  </span>
);

const Metric = ({ title, value, tone }: { title: string; value: string; tone?: 'green' | 'red' }) => (
  <div className="bg-[#0d1117] border border-slate-800 rounded-2xl p-4 shadow-xl">
    <p className="text-[8px] uppercase tracking-[0.2em] text-slate-500 font-black">{title}</p>
    <p className={`text-xl md:text-2xl mt-2 font-black tracking-tighter ${tone === 'green' ? 'text-emerald-400' : tone === 'red' ? 'text-rose-400' : 'text-white'}`}>{value}</p>
  </div>
);

const MarketPanel = ({ title, subtitle, accent, children }: any) => (
  <section className={`bg-[#0d1117] border ${accent === 'cyan' ? 'border-cyan-950/70' : 'border-indigo-950/70'} rounded-[2rem] p-4 md:p-6 shadow-2xl space-y-4`}>
    <div className="flex justify-between items-start gap-4">
      <div>
        <h2 className={`text-lg md:text-xl font-black italic uppercase ${accent === 'cyan' ? 'text-cyan-400' : 'text-indigo-400'}`}>{title}</h2>
        <p className="text-[9px] text-slate-500 mt-1 uppercase tracking-widest">{subtitle}</p>
      </div>
    </div>
    {children}
  </section>
);

const SettingsGrid = ({ children }: any) => <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">{children}</div>;

const NumberSetting = ({ label, value, min, max, step, suffix = '', onSave }: any) => {
  const [draft, setDraft] = useState(String(value ?? ''));
  useEffect(() => setDraft(String(value ?? '')), [value]);
  const save = () => {
    const number = Number(draft);
    if (Number.isFinite(number)) onSave(number);
  };
  return (
    <label className="bg-black/30 border border-slate-800 rounded-2xl p-3 block">
      <span className="text-[8px] text-slate-500 uppercase font-black tracking-widest">{label}</span>
      <div className="flex items-center gap-2 mt-2">
        <input
          type="number"
          value={draft}
          min={min}
          max={max}
          step={step}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => e.key === 'Enter' && save()}
          className="w-full bg-[#05080d] border border-slate-700 rounded-xl px-3 py-2 text-sm font-black text-white outline-none focus:border-indigo-500"
        />
        {suffix && <span className="text-[9px] font-black text-slate-500">{suffix}</span>}
      </div>
    </label>
  );
};

const SelectSetting = ({ label, value, options, onSave }: any) => (
  <label className="bg-black/30 border border-slate-800 rounded-2xl p-3 block">
    <span className="text-[8px] text-slate-500 uppercase font-black tracking-widest">{label}</span>
    <select value={value} onChange={(e) => onSave(e.target.value)} className="w-full mt-2 bg-[#05080d] border border-slate-700 rounded-xl px-3 py-2 text-[10px] font-black text-white">
      {options.map(([v, text]: string[]) => <option key={v} value={v}>{text}</option>)}
    </select>
  </label>
);

const MarketStats = ({ items }: { items: Array<[string, string]> }) => (
  <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
    {items.map(([label, value]) => (
      <div key={label} className="bg-black/30 border border-slate-800 rounded-2xl p-3">
        <p className="text-[7px] uppercase font-black tracking-widest text-slate-600">{label}</p>
        <p className="text-base font-black text-white mt-1">{value}</p>
      </div>
    ))}
  </div>
);

const Block = ({ title, children }: any) => (
  <div className="bg-black/20 border border-slate-800 rounded-2xl overflow-hidden">
    <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
      <h3 className="text-[9px] font-black tracking-[0.18em] uppercase text-slate-400">{title}</h3>
    </div>
    {children}
  </div>
);

const PositionTable = ({ trades, market }: { trades: any[]; market: 'CRYPTO' | 'FOREX' }) => {
  if (!trades.length) return <Empty text="Sin posiciones abiertas" />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[700px] text-left">
        <thead className="text-[7px] uppercase tracking-widest text-slate-600">
          <tr>{['Símbolo', 'Side', market === 'CRYPTO' ? 'Lev/Margen' : 'Ticket/Lote', 'Entry', 'SL', 'TP', 'PnL', 'Estado'].map(h => <th key={h} className="px-3 py-2">{h}</th>)}</tr>
        </thead>
        <tbody>
          {trades.map((t) => (
            <tr key={t.id} className="border-t border-slate-900 text-[9px]">
              <td className="px-3 py-3 font-black text-white">{t.symbol}</td>
              <td className={`px-3 py-3 font-black ${t.side === 'BUY' ? 'text-emerald-400' : 'text-rose-400'}`}>{t.side}</td>
              <td className="px-3 py-3 text-slate-300">{market === 'CRYPTO' ? `${t.leverage ?? '-'}x · ${money(t.marginUsed)}` : `${t.brokerOrderId ?? '-'} · ${t.lotSize ?? '-'}`}</td>
              <td className="px-3 py-3">{price(t.entryPrice)}</td>
              <td className="px-3 py-3 text-rose-300">{price(t.stopLoss)}</td>
              <td className="px-3 py-3 text-emerald-300">{price(t.takeProfit)}</td>
              <td className={`px-3 py-3 font-black ${(t.unrealizedPnl || 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{money(t.unrealizedPnl)}</td>
              <td className="px-3 py-3 text-slate-500">{t.state}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const OpportunityTable = ({ rows, crypto = false }: { rows: any[]; crypto?: boolean }) => {
  if (!rows.length) return <Empty text="Esperando oportunidades del scanner" />;
  return (
    <div className="overflow-x-auto max-h-[310px] overflow-y-auto">
      <table className="w-full min-w-[650px] text-left">
        <thead className="text-[7px] uppercase tracking-widest text-slate-600 sticky top-0 bg-[#080c12]">
          <tr>{['#', 'Símbolo', 'Side', 'TF', 'Score', 'Conf.', 'WR', crypto ? 'Regla' : 'Setup'].map(h => <th key={h} className="px-3 py-2">{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id || `${r.symbol}-${i}`} className="border-t border-slate-900 text-[9px]">
              <td className="px-3 py-2 text-slate-600">{i + 1}</td>
              <td className="px-3 py-2 text-white font-black">{r.symbol}</td>
              <td className={`px-3 py-2 font-black ${r.side === 'BUY' ? 'text-emerald-400' : 'text-rose-400'}`}>{r.side}</td>
              <td className="px-3 py-2">{r.timeframe}</td>
              <td className="px-3 py-2 text-indigo-300 font-black">{Number(r.score || 0).toFixed(1)}</td>
              <td className="px-3 py-2">{pct(r.confidence)}</td>
              <td className="px-3 py-2">{pct(r.rollingWinRate)}</td>
              <td className="px-3 py-2 text-slate-600">{crypto ? '1 coin / símbolo' : r.strategy}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const HistoryTable = ({ trades }: { trades: any[] }) => {
  if (!trades.length) return <Empty text="Aún no hay historial" />;
  return (
    <div className="overflow-x-auto max-h-[300px] overflow-y-auto">
      <table className="w-full min-w-[680px] text-left">
        <thead className="text-[7px] uppercase tracking-widest text-slate-600 sticky top-0 bg-[#080c12]">
          <tr>{['Símbolo', 'Side', 'Estado', 'Entrada', 'Salida', 'PnL', 'Motivo', 'Hora'].map(h => <th key={h} className="px-3 py-2">{h}</th>)}</tr>
        </thead>
        <tbody>
          {trades.map((t) => (
            <tr key={t.id} className="border-t border-slate-900 text-[9px]">
              <td className="px-3 py-2 font-black text-white">{t.symbol}</td>
              <td className={`px-3 py-2 ${t.side === 'BUY' ? 'text-emerald-400' : 'text-rose-400'}`}>{t.side}</td>
              <td className="px-3 py-2 text-slate-500">{t.state}</td>
              <td className="px-3 py-2">{price(t.entryPrice)}</td>
              <td className="px-3 py-2">{price(t.exitPrice)}</td>
              <td className={`px-3 py-2 font-black ${(t.realizedPnl || t.unrealizedPnl || 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{money(t.state === 'CLOSED' ? t.realizedPnl : t.unrealizedPnl)}</td>
              <td className="px-3 py-2 text-slate-600">{t.closeReason || '—'}</td>
              <td className="px-3 py-2 text-slate-600">{new Date(t.closeTime || t.openTime || t.createdAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const Empty = ({ text }: { text: string }) => <div className="py-8 text-center text-[9px] uppercase tracking-widest text-slate-700">{text}</div>;

function money(value: any): string {
  const n = Number(value || 0);
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`;
}
function pct(value: any): string { return `${Number(value || 0).toFixed(1)}%`; }
function price(value: any): string { return value == null ? '—' : String(Number(Number(value).toFixed(8))); }
function formatFactor(value: any): string { return value == null ? '∞' : Number(value || 0).toFixed(2); }

export default App;
