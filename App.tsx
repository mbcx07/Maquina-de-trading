import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { v34Api } from './services/v34Api';

type View = 'dashboard' | 'settings' | 'backtest';
type IntegrationProvider = 'BINANCE' | 'TELEGRAM' | 'TWELVE_DATA';

const App: React.FC = () => {
  const [state, setState] = useState<any>(null);
  const [view, setView] = useState<View>('dashboard');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
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
          <p className="text-[10px] uppercase tracking-[0.35em] text-slate-500">Quantum Dual V34 Linux</p>
          {error && <p className="text-xs text-rose-400 max-w-xl">{error}</p>}
        </div>
      </div>
    );
  }

  const settings = state.settings || {};
  const engineOn = Boolean(settings.engineEnabled);

  const patchSettings = (patch: Record<string, unknown>) => run(
    () => v34Api.patchSettings(patch),
    'Configuración guardada.',
  );

  const engineAction = (action: 'start' | 'pause' | 'emergency') => run(
    () => action === 'start'
      ? v34Api.startEngine()
      : action === 'pause'
        ? v34Api.pauseEngine()
        : v34Api.emergencyStop(),
    action === 'start' ? 'Motor iniciado.' : action === 'pause' ? 'Motor pausado.' : 'Emergency Stop ejecutado.',
  );

  return (
    <div className="min-h-screen bg-[#010409] text-slate-200 p-3 md:p-5 font-mono">
      <div className="max-w-[1800px] mx-auto space-y-4">
        <Header
          state={state}
          view={view}
          setView={setView}
          busy={busy}
          lastSync={lastSync}
          engineOn={engineOn}
          patchSettings={patchSettings}
          engineAction={engineAction}
        />

        {error && <Banner tone="error">{error}</Banner>}
        {notice && <Banner tone="ok">{notice}</Banner>}

        {view === 'dashboard' && <Dashboard state={state} patchSettings={patchSettings} />}
        {view === 'settings' && (
          <SettingsView
            state={state}
            busy={busy}
            run={run}
            patchSettings={patchSettings}
          />
        )}
        {view === 'backtest' && <BacktestView settings={settings} />}
      </div>
    </div>
  );
};

function Header({ state, view, setView, busy, lastSync, engineOn, patchSettings, engineAction }: any) {
  const settings = state.settings || {};
  const binance = state.brokerStatus?.binance || {};
  const telegram = state.brokerStatus?.telegram || {};
  const forexData = state.brokerStatus?.forexData || {};

  return (
    <header className="bg-[#0d1117] border border-slate-800 rounded-[2rem] p-4 md:p-6 shadow-2xl">
      <div className="flex flex-col 2xl:flex-row 2xl:items-center justify-between gap-5">
        <div className="flex items-center gap-4">
          <div className={`w-3 h-3 rounded-full ${engineOn ? 'bg-emerald-400 animate-pulse shadow-[0_0_18px_#34d399]' : 'bg-slate-700'}`} />
          <div>
            <h1 className="text-2xl md:text-3xl font-black italic tracking-tighter uppercase text-white">
              QUANTUM<span className="text-indigo-500">DUAL</span> V34
            </h1>
            <div className="flex flex-wrap gap-3 mt-2 text-[8px] font-black uppercase tracking-widest text-slate-500">
              <Connection label="Binance" ok={Boolean(binance.connected) || settings.appMode === 'PAPER'} />
              <Connection label="Forex Data" ok={Boolean(forexData.connected)} />
              <Connection label="Telegram" ok={Boolean(telegram.connected)} />
              <span>Linux</span>
              <span>DB persistent</span>
              <span>Sync {lastSync ? new Date(lastSync).toLocaleTimeString() : '—'}</span>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={settings.appMode}
            disabled={busy || engineOn}
            onChange={(e) => void patchSettings({ appMode: e.target.value })}
            className="bg-black/60 border border-slate-700 rounded-xl px-4 py-3 text-[10px] font-black"
          >
            <option value="PAPER">PAPER</option>
            <option value="TESTNET">BINANCE TESTNET</option>
            <option value="REAL">REAL</option>
          </select>
          <button
            disabled={busy}
            onClick={() => void engineAction(engineOn ? 'pause' : 'start')}
            className={`px-5 py-3 rounded-xl text-[10px] font-black uppercase ${engineOn ? 'bg-amber-400 text-black' : 'bg-indigo-600 text-white'}`}
          >
            {engineOn ? 'Pause Engine' : 'Start Engine'}
          </button>
          <button
            disabled={busy}
            onClick={() => void engineAction('emergency')}
            className="px-5 py-3 rounded-xl text-[10px] font-black uppercase bg-rose-700 text-white border border-rose-500/40"
          >
            Emergency Stop
          </button>
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

function Dashboard({ state, patchSettings }: any) {
  const settings = state.settings || {};
  const metrics = state.metrics?.crypto || emptyMetrics;
  const crypto = state.active?.crypto || [];
  const cryptoOpps = state.opportunities?.crypto || [];
  const forexSignals = state.forexSignals || [];
  const forexStats = state.forexSignalStats || {};
  const recentTrades = state.recentTrades || [];

  return (
    <>
      <section className="grid grid-cols-2 lg:grid-cols-6 gap-3">
        <Metric title="Net Profit" value={money(metrics.netProfit)} tone={Number(metrics.netProfit) >= 0 ? 'green' : 'red'} />
        <Metric title="Win Rate" value={pct(metrics.winRate)} />
        <Metric title="Profit Factor" value={factor(metrics.profitFactor)} />
        <Metric title="Trades cerrados" value={String(metrics.trades || 0)} />
        <Metric title="Crypto abiertos" value={`${crypto.length}/${settings.maxConcurrentCryptoTrades}`} />
        <Metric title="Forex signals 24h" value={String(forexStats.sent24h || 0)} />
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <MarketPanel title="CRYPTO · BINANCE FUTURES" subtitle="Automático · máximo 10 coins · símbolos únicos" accent="indigo">
          <ScannerLine scanner={state.scanners?.crypto} />
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
            <NumberSetting label="Slots" value={settings.maxConcurrentCryptoTrades} min={1} max={10} step={1} suffix="/10" onSave={(v: number) => patchSettings({ maxConcurrentCryptoTrades: v })} />
            <NumberSetting label="Margen / trade" value={settings.cryptoMarginPctPerTrade} min={0.01} max={100} step={0.1} suffix="%" onSave={(v: number) => patchSettings({ cryptoMarginPctPerTrade: v })} />
            <NumberSetting label="Leverage" value={settings.cryptoRequestedLeverage} min={1} max={125} step={1} suffix="x" onSave={(v: number) => patchSettings({ cryptoRequestedLeverage: v })} />
            <NumberSetting label="Exposición máx." value={settings.cryptoMaxAccountExposurePct} min={1} max={100} step={1} suffix="%" onSave={(v: number) => patchSettings({ cryptoMaxAccountExposurePct: v })} />
            <NumberSetting label="Confianza mín." value={settings.cryptoMinSignalConfidence} min={0} max={100} step={1} suffix="%" onSave={(v: number) => patchSettings({ cryptoMinSignalConfidence: v })} />
            <NumberSetting label="Rolling WR mín." value={settings.cryptoMinRollingWinRate} min={0} max={100} step={1} suffix="%" onSave={(v: number) => patchSettings({ cryptoMinRollingWinRate: v })} />
          </div>
          <Block title="POSICIONES ABIERTAS"><PositionTable rows={crypto} /></Block>
          <Block title="TOP OPORTUNIDADES"><OpportunityTable rows={cryptoOpps} /></Block>
          <Block title="HISTORIAL BINANCE"><TradeHistory rows={recentTrades.slice(0, 20)} /></Block>
        </MarketPanel>

        <MarketPanel title="FOREX · SIGNAL DESK" subtitle="Solo señales Telegram · ejecución manual" accent="cyan">
          <ScannerLine scanner={state.scanners?.forex} />
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
            <InfoBox label="Modo" value="SIGNAL ONLY" />
            <InfoBox label="Signals 24h" value={String(forexStats.sent24h || 0)} />
            <InfoBox label="Signals 7d" value={String(forexStats.sent7d || 0)} />
            <NumberSetting label="Escaneo" value={settings.forexSignalScanIntervalMinutes} min={1} max={1440} step={1} suffix="min" onSave={(v: number) => patchSettings({ forexSignalScanIntervalMinutes: v })} />
            <NumberSetting label="Confianza mín." value={settings.forexMinSignalConfidence} min={0} max={100} step={1} suffix="%" onSave={(v: number) => patchSettings({ forexMinSignalConfidence: v })} />
            <NumberSetting label="Rolling WR mín." value={settings.forexMinRollingWinRate} min={0} max={100} step={1} suffix="%" onSave={(v: number) => patchSettings({ forexMinRollingWinRate: v })} />
          </div>
          <div className="rounded-2xl bg-cyan-500/5 border border-cyan-500/20 p-4 text-[9px] text-cyan-100/70 leading-5">
            Forex nunca envía órdenes al broker en esta edición. Cada retest nuevo genera, si pasa los filtros, una alerta con entrada de referencia, SL, TP, R:R, confianza y score.
          </div>
          <Block title="ÚLTIMAS SEÑALES FOREX"><ForexSignalTable rows={forexSignals} /></Block>
        </MarketPanel>
      </section>
    </>
  );
}

function SettingsView({ state, busy, run, patchSettings }: any) {
  const settings = state.settings || {};
  const integrations = state.integrations || [];
  const binance = statusOf(integrations, 'BINANCE');
  const telegram = statusOf(integrations, 'TELEGRAM');
  const forexData = statusOf(integrations, 'TWELVE_DATA');

  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [botToken, setBotToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [forexDataKey, setForexDataKey] = useState('');
  const [forexSymbols, setForexSymbols] = useState((settings.forexSymbols || []).join(', '));

  useEffect(() => setForexSymbols((settings.forexSymbols || []).join(', ')), [settings.forexSymbols]);

  const saveSymbols = async () => {
    const symbols = forexSymbols.split(',').map((s) => s.trim().toUpperCase().replace('/', '')).filter(Boolean);
    if (symbols.length) await patchSettings({ forexSymbols: symbols });
  };

  const estimatedCredits = useMemo(() => {
    const count = (settings.forexSymbols || []).length;
    const interval = Math.max(1, Number(settings.forexSignalScanIntervalMinutes || 15));
    return Math.ceil(count * 2 * (1440 / interval));
  }, [settings.forexSymbols, settings.forexSignalScanIntervalMinutes]);

  return (
    <div className="space-y-4">
      <section className="bg-gradient-to-br from-indigo-950/35 to-[#0d1117] border border-indigo-900/40 rounded-3xl p-5 md:p-7 shadow-2xl">
        <p className="text-[8px] uppercase tracking-[0.25em] font-black text-indigo-400">Linux individual</p>
        <h2 className="text-2xl md:text-3xl font-black text-white tracking-tight mt-2">Integraciones del motor</h2>
        <p className="text-[10px] text-slate-400 leading-6 mt-3 max-w-5xl">
          Binance ejecuta Crypto automáticamente. Forex usa Twelve Data únicamente como fuente de velas y envía señales a Telegram; no existe conexión MT5 ni ejecución Forex automática.
        </p>
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <IntegrationCard title="BINANCE FUTURES" status={binance} description="USDⓈ-M Futures · ejecución automática Crypto">
          <TextField label="API Key" value={apiKey} onChange={setApiKey} placeholder={binance.configured ? 'Nueva API Key para reemplazar' : 'API Key'} />
          <TextField label="API Secret" value={apiSecret} onChange={setApiSecret} placeholder="API Secret" secret />
          <Hint>Permiso Futures habilitado; retiros deshabilitados. En REAL usa whitelist de IP del VPS.</Hint>
          <IntegrationActions
            busy={busy}
            configured={binance.configured}
            save={() => run(async () => {
              const r = await v34Api.saveBinanceIntegration(apiKey.trim(), apiSecret.trim());
              setApiKey(''); setApiSecret(''); return r;
            }, 'Binance guardado y validado.')}
            test={() => run(() => v34Api.testIntegration('binance'), 'Binance validado.')}
            remove={() => run(() => v34Api.removeIntegration('binance'), 'Binance desconectado.')}
          />
        </IntegrationCard>

        <IntegrationCard title="FOREX DATA" status={forexData} description="Twelve Data · solo market data">
          <TextField label="API Key" value={forexDataKey} onChange={setForexDataKey} placeholder={forexData.configured ? 'Nueva key para reemplazar' : 'Twelve Data API Key'} secret />
          <Hint>La key se guarda cifrada. No puede abrir, cerrar ni modificar operaciones.</Hint>
          <div className="grid grid-cols-2 gap-2">
            <InfoBox label="Pares" value={String((settings.forexSymbols || []).length)} />
            <InfoBox label="Créditos/día est." value={String(estimatedCredits)} />
          </div>
          <IntegrationActions
            busy={busy}
            configured={forexData.configured}
            save={() => run(async () => {
              const r = await v34Api.saveForexDataIntegration(forexDataKey.trim());
              setForexDataKey(''); return r;
            }, 'Fuente Forex guardada y validada.')}
            test={() => run(() => v34Api.testIntegration('twelve-data'), 'Forex Data validado.')}
            remove={() => run(() => v34Api.removeIntegration('twelve-data'), 'Forex Data desconectado.')}
          />
        </IntegrationCard>

        <IntegrationCard title="TELEGRAM" status={telegram} description="Aperturas/cierres Crypto + señales Forex">
          <TextField label="Bot Token" value={botToken} onChange={setBotToken} placeholder={telegram.configured ? 'Nuevo token para reemplazar' : 'Token de BotFather'} secret />
          <TextField label="Chat ID / Canal" value={chatId} onChange={setChatId} placeholder="Chat ID" />
          <Hint>Guardar envía un mensaje de prueba. Forex necesita Telegram conectado para iniciar el motor.</Hint>
          <IntegrationActions
            busy={busy}
            configured={telegram.configured}
            save={() => run(async () => {
              const r = await v34Api.saveTelegramIntegration(botToken.trim(), chatId.trim());
              setBotToken(''); setChatId(''); return r;
            }, 'Telegram guardado y validado.')}
            test={() => run(() => v34Api.testIntegration('telegram'), 'Telegram validado.')}
            remove={() => run(() => v34Api.removeIntegration('telegram'), 'Telegram desconectado.')}
          />
        </IntegrationCard>
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Panel title="RIESGO BINANCE">
          <div className="grid grid-cols-2 gap-2">
            <NumberSetting label="Pérdida diaria máx." value={settings.dailyLossLimitPct} min={0.1} max={100} step={0.1} suffix="%" onSave={(v: number) => patchSettings({ dailyLossLimitPct: v })} />
            <NumberSetting label="Drawdown máximo" value={settings.maxDrawdownPct} min={0.1} max={100} step={0.1} suffix="%" onSave={(v: number) => patchSettings({ maxDrawdownPct: v })} />
            <SelectSetting label="Emergency Stop" value={settings.emergencyStopMode} options={[
              ['PAUSE_ONLY', 'Pausar nuevas entradas'],
              ['CLOSE_TRACKED', 'Cerrar Crypto V34 y pausar'],
            ]} onSave={(v: string) => patchSettings({ emergencyStopMode: v })} />
            <ToggleSetting label="Risk Kill-Switch" checked={Boolean(settings.riskKillSwitchEnabled)} onChange={(v: boolean) => patchSettings({ riskKillSwitchEnabled: v })} />
            <ToggleSetting label="Crypto activo" checked={Boolean(settings.cryptoEnabled)} onChange={(v: boolean) => patchSettings({ cryptoEnabled: v })} />
            <ToggleSetting label="Forex signals" checked={Boolean(settings.forexEnabled)} onChange={(v: boolean) => patchSettings({ forexEnabled: v })} />
          </div>
        </Panel>

        <Panel title="FOREX SIGNAL ENGINE">
          <label className="block">
            <span className="field-label">Pares</span>
            <textarea value={forexSymbols} onChange={(e) => setForexSymbols(e.target.value)} className="field min-h-28" />
          </label>
          <div className="grid grid-cols-2 gap-2 mt-3">
            <NumberSetting label="Intervalo scanner" value={settings.forexSignalScanIntervalMinutes} min={1} max={1440} step={1} suffix="min" onSave={(v: number) => patchSettings({ forexSignalScanIntervalMinutes: v })} />
            <NumberSetting label="Máx. signals/ciclo" value={settings.forexSignalsPerCycle} min={1} max={20} step={1} onSave={(v: number) => patchSettings({ forexSignalsPerCycle: v })} />
            <NumberSetting label="Confianza mín." value={settings.forexMinSignalConfidence} min={0} max={100} step={1} suffix="%" onSave={(v: number) => patchSettings({ forexMinSignalConfidence: v })} />
            <NumberSetting label="Rolling WR mín." value={settings.forexMinRollingWinRate} min={0} max={100} step={1} suffix="%" onSave={(v: number) => patchSettings({ forexMinRollingWinRate: v })} />
          </div>
          <div className="mt-3 flex items-center justify-between gap-3">
            <Hint>Con 4 pares y 15 min son ~768 créditos/día. Si aumentas pares o frecuencia, revisa el límite de tu plan de datos.</Hint>
            <PrimaryButton onClick={() => void saveSymbols()}>Guardar pares</PrimaryButton>
          </div>
        </Panel>
      </section>
    </div>
  );
}

function BacktestView({ settings }: any) {
  const [symbols, setSymbols] = useState('BTCUSDT, ETHUSDT, SOLUSDT, XRPUSDT, BNBUSDT');
  const [startDate, setStartDate] = useState(daysAgo(7));
  const [endDate, setEndDate] = useState(today());
  const [initialBalance, setInitialBalance] = useState(1000);
  const [allocationPct, setAllocationPct] = useState(Number(settings.cryptoMarginPctPerTrade || 1));
  const [leverage, setLeverage] = useState(Number(settings.cryptoRequestedLeverage || 20));
  const [costPct, setCostPct] = useState(0.12);
  const [runs, setRuns] = useState<any[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const loadRuns = useCallback(async () => {
    try {
      const data = await v34Api.listBacktests(20);
      setRuns(data.runs || []);
      if (!selectedId && data.runs?.[0]?.id) setSelectedId(data.runs[0].id);
    } catch (e: any) { setError(e?.message || String(e)); }
  }, [selectedId]);

  useEffect(() => { void loadRuns(); }, [loadRuns]);
  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    const load = async () => {
      try {
        const data = await v34Api.getBacktest(selectedId);
        if (active) setDetail(data.run);
      } catch (e: any) { if (active) setError(e?.message || String(e)); }
    };
    void load();
    const timer = window.setInterval(() => void load(), 4000);
    return () => { active = false; window.clearInterval(timer); };
  }, [selectedId]);

  const start = async () => {
    const list = [...new Set(symbols.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))];
    if (!list.length) return;
    setBusy(true); setError('');
    try {
      const result = await v34Api.createBacktest({
        broker: 'BINANCE', symbols: list,
        startTime: new Date(`${startDate}T00:00:00Z`).getTime(),
        endTime: new Date(`${endDate}T23:59:59Z`).getTime(),
        initialBalance, allocationPct, leverage,
        roundTripCostPct: costPct,
        scanStepMinutes: 3,
        maxHoldMinutes: 90,
        sizingMode: 'MARGIN_PERCENT',
      });
      setSelectedId(result.id);
      await loadRuns();
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  const result = detail?.result;
  return (
    <div className="grid grid-cols-1 2xl:grid-cols-[430px_1fr] gap-4">
      <div className="space-y-4">
        <Panel title="NUEVO BACKTEST BINANCE">
          <label className="block"><span className="field-label">Coins</span><textarea className="field min-h-24" value={symbols} onChange={(e) => setSymbols(e.target.value)} /></label>
          <div className="grid grid-cols-2 gap-2 mt-3">
            <DateField label="Desde" value={startDate} set={setStartDate} />
            <DateField label="Hasta" value={endDate} set={setEndDate} />
            <SmallNumber label="Balance" value={initialBalance} set={setInitialBalance} step={100} />
            <SmallNumber label="% margen/trade" value={allocationPct} set={setAllocationPct} step={0.1} />
            <SmallNumber label="Leverage" value={leverage} set={setLeverage} step={1} />
            <SmallNumber label="Costo round-trip %" value={costPct} set={setCostPct} step={0.01} />
          </div>
          {error && <div className="mt-3 text-[9px] text-rose-400">{error}</div>}
          <div className="mt-3"><PrimaryButton disabled={busy} onClick={() => void start()}>{busy ? 'Iniciando…' : 'Ejecutar backtest'}</PrimaryButton></div>
        </Panel>

        <Panel title="CORRIDAS">
          <div className="space-y-2 max-h-[480px] overflow-auto">
            {!runs.length && <Empty text="Sin backtests" />}
            {runs.map((r) => (
              <button key={r.id} onClick={() => setSelectedId(r.id)} className={`w-full text-left rounded-xl border p-3 ${selectedId === r.id ? 'border-indigo-500 bg-indigo-500/10' : 'border-slate-800 bg-black/20'}`}>
                <div className="flex justify-between gap-2 text-[9px] font-black"><span>{(r.request?.symbols || []).join(', ')}</span><span className="text-indigo-300">{r.status}</span></div>
                <div className="text-[8px] text-slate-600 mt-2">{new Date(r.createdAt).toLocaleString()}</div>
              </button>
            ))}
          </div>
        </Panel>
      </div>

      <Panel title="RESULTADO">
        {!detail && <Empty text="Selecciona una corrida" />}
        {detail && !result && (
          <div className="p-8 text-center text-slate-500 text-[10px] uppercase tracking-widest">
            {detail.status} · {detail.progress?.stage || 'Procesando'}
          </div>
        )}
        {result && <BacktestResult result={result} />}
      </Panel>
    </div>
  );
}

function BacktestResult({ result }: any) {
  const m = result.metrics || {};
  const oos = result.outOfSample || {};
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <Metric title="Net Profit" value={money(m.netProfit)} tone={Number(m.netProfit) >= 0 ? 'green' : 'red'} />
        <Metric title="Return" value={pct(m.returnPct)} />
        <Metric title="Win Rate" value={pct(m.winRate)} />
        <Metric title="Profit Factor" value={factor(m.profitFactor)} />
        <Metric title="Expectancy" value={money(m.expectancy)} />
        <Metric title="Max DD" value={pct(m.maxDrawdownPct)} />
        <Metric title="Costos" value={money(m.costs)} />
        <Metric title="Trades" value={String(m.trades || 0)} />
      </div>
      <div className="rounded-2xl border border-indigo-500/20 bg-indigo-500/5 p-4">
        <p className="text-[9px] uppercase tracking-widest font-black text-indigo-300">30% OUT-OF-SAMPLE</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3 text-[10px]">
          <KV k="OOS Profit" v={money(oos.netProfit)} />
          <KV k="OOS WR" v={pct(oos.winRate)} />
          <KV k="OOS PF" v={factor(oos.profitFactor)} />
          <KV k="OOS Expectancy" v={money(oos.expectancy)} />
        </div>
      </div>
      <Block title="POR SÍMBOLO">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[600px] text-[9px]">
            <thead className="text-slate-600 uppercase"><tr><th className="p-3 text-left">Símbolo</th><th>Trades</th><th>WR</th><th>Profit</th><th>PF</th><th>DD</th></tr></thead>
            <tbody>{(result.bySymbol || []).map((row: any) => <tr key={row.symbol} className="border-t border-slate-900"><td className="p-3 font-black text-white">{row.symbol}</td><td className="text-center">{row.metrics?.trades || 0}</td><td className="text-center">{pct(row.metrics?.winRate)}</td><td className="text-center">{money(row.metrics?.netProfit)}</td><td className="text-center">{factor(row.metrics?.profitFactor)}</td><td className="text-center">{pct(row.metrics?.maxDrawdownPct)}</td></tr>)}</tbody>
          </table>
        </div>
      </Block>
    </div>
  );
}

const emptyMetrics = { trades: 0, winRate: 0, netProfit: 0, profitFactor: 0 };

function statusOf(items: any[], provider: IntegrationProvider): any {
  return items.find((item) => item.provider === provider) || { provider, configured: false };
}

const Connection = ({ label, ok }: any) => <span className="flex items-center gap-1.5"><i className={`w-1.5 h-1.5 rounded-full ${ok ? 'bg-emerald-400' : 'bg-rose-500'}`} />{label}</span>;
const Nav = ({ active, children, onClick }: any) => <button onClick={onClick} className={`px-4 py-2 rounded-xl text-[9px] uppercase font-black tracking-widest border ${active ? 'bg-indigo-600 border-indigo-500 text-white' : 'bg-black/20 border-slate-800 text-slate-500'}`}>{children}</button>;

function Metric({ title, value, tone }: any) {
  return <div className="bg-[#0d1117] border border-slate-800 rounded-2xl p-4"><p className="text-[7px] uppercase tracking-widest font-black text-slate-600">{title}</p><p className={`mt-2 text-xl font-black ${tone === 'green' ? 'text-emerald-400' : tone === 'red' ? 'text-rose-400' : 'text-white'}`}>{value}</p></div>;
}

function MarketPanel({ title, subtitle, accent, children }: any) {
  return <section className={`bg-[#0d1117] border ${accent === 'cyan' ? 'border-cyan-950' : 'border-indigo-950'} rounded-[2rem] p-4 md:p-6 space-y-4 shadow-2xl`}><div><h2 className={`text-lg font-black italic uppercase ${accent === 'cyan' ? 'text-cyan-400' : 'text-indigo-400'}`}>{title}</h2><p className="text-[8px] text-slate-500 uppercase tracking-widest mt-1">{subtitle}</p></div>{children}</section>;
}

function Panel({ title, children }: any) {
  return <section className="bg-[#0d1117] border border-slate-800 rounded-3xl p-4 md:p-5 shadow-xl"><h3 className="text-[9px] uppercase tracking-[0.18em] font-black text-slate-400 mb-4">{title}</h3>{children}</section>;
}

function Block({ title, children }: any) {
  return <div className="border border-slate-800 rounded-2xl overflow-hidden bg-black/20"><div className="px-4 py-3 border-b border-slate-800 text-[8px] uppercase tracking-widest font-black text-slate-500">{title}</div>{children}</div>;
}

function ScannerLine({ scanner }: any) {
  if (!scanner) return <div className="text-[8px] text-slate-600">Scanner inicializando…</div>;
  return <div className="flex flex-wrap gap-3 rounded-xl bg-black/30 border border-slate-800 px-3 py-2 text-[8px] uppercase tracking-widest text-slate-500"><span className="text-white font-black">{scanner.status || '—'}</span>{scanner.current && <span>{scanner.current}</span>}{scanner.total != null && <span>{scanner.scanned || 0}/{scanner.total}</span>}{scanner.sent != null && <span>sent {scanner.sent}</span>}{scanner.nextScanMinutes && <span>next ~{scanner.nextScanMinutes}m</span>}</div>;
}

function PositionTable({ rows }: any) {
  if (!rows.length) return <Empty text="Sin posiciones abiertas" />;
  return <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-[9px]"><thead className="text-slate-600 uppercase"><tr><th className="p-3 text-left">Coin</th><th>Side</th><th>Lev</th><th>Entry</th><th>SL</th><th>TP</th><th>PnL</th><th>Estado</th></tr></thead><tbody>{rows.map((r: any) => <tr key={r.id} className="border-t border-slate-900"><td className="p-3 text-white font-black">{r.symbol}</td><td className={`text-center font-black ${r.side === 'BUY' ? 'text-emerald-400' : 'text-rose-400'}`}>{r.side}</td><td className="text-center">{r.leverage || '—'}x</td><td className="text-center">{price(r.entryPrice)}</td><td className="text-center text-rose-300">{price(r.stopLoss)}</td><td className="text-center text-emerald-300">{price(r.takeProfit)}</td><td className="text-center">{money(r.unrealizedPnl)}</td><td className="text-center text-slate-500">{r.state}</td></tr>)}</tbody></table></div>;
}

function OpportunityTable({ rows }: any) {
  if (!rows.length) return <Empty text="Esperando oportunidades" />;
  return <div className="overflow-x-auto max-h-[320px] overflow-y-auto"><table className="w-full min-w-[650px] text-[9px]"><thead className="text-slate-600 uppercase sticky top-0 bg-[#080c12]"><tr><th className="p-3 text-left">#</th><th>Coin</th><th>Side</th><th>Score</th><th>Conf.</th><th>WR</th><th>Entry</th></tr></thead><tbody>{rows.map((r: any, i: number) => <tr key={r.id} className="border-t border-slate-900"><td className="p-3 text-slate-600">{i + 1}</td><td className="text-center text-white font-black">{r.symbol}</td><td className={`text-center ${r.side === 'BUY' ? 'text-emerald-400' : 'text-rose-400'}`}>{r.side}</td><td className="text-center">{Number(r.score || 0).toFixed(1)}</td><td className="text-center">{pct(r.confidence)}</td><td className="text-center">{pct(r.rollingWinRate)}</td><td className="text-center">{price(r.entry)}</td></tr>)}</tbody></table></div>;
}

function ForexSignalTable({ rows }: any) {
  if (!rows.length) return <Empty text="Aún no hay señales Forex" />;
  return <div className="overflow-x-auto max-h-[520px] overflow-y-auto"><table className="w-full min-w-[760px] text-[9px]"><thead className="text-slate-600 uppercase sticky top-0 bg-[#080c12]"><tr><th className="p-3 text-left">Par</th><th>Side</th><th>Entry</th><th>SL</th><th>TP</th><th>Score</th><th>Conf.</th><th>WR</th><th>Hora</th></tr></thead><tbody>{rows.map((r: any) => <tr key={r.id} className="border-t border-slate-900"><td className="p-3 text-white font-black">{r.symbol}</td><td className={`text-center font-black ${r.side === 'BUY' ? 'text-emerald-400' : 'text-rose-400'}`}>{r.side}</td><td className="text-center">{price(r.entry)}</td><td className="text-center text-rose-300">{price(r.stopLoss)}</td><td className="text-center text-emerald-300">{price(r.takeProfit)}</td><td className="text-center">{Number(r.score || 0).toFixed(1)}</td><td className="text-center">{pct(r.confidence)}</td><td className="text-center">{pct(r.rollingWinRate)}</td><td className="text-center text-slate-600">{new Date(r.createdAt).toLocaleString()}</td></tr>)}</tbody></table></div>;
}

function TradeHistory({ rows }: any) {
  if (!rows.length) return <Empty text="Sin historial" />;
  return <div className="overflow-x-auto max-h-[340px] overflow-y-auto"><table className="w-full min-w-[720px] text-[9px]"><thead className="text-slate-600 uppercase sticky top-0 bg-[#080c12]"><tr><th className="p-3 text-left">Coin</th><th>Side</th><th>Estado</th><th>Entry</th><th>Exit</th><th>PnL</th><th>Cierre</th></tr></thead><tbody>{rows.map((r: any) => <tr key={r.id} className="border-t border-slate-900"><td className="p-3 text-white font-black">{r.symbol}</td><td className="text-center">{r.side}</td><td className="text-center text-slate-500">{r.state}</td><td className="text-center">{price(r.entryPrice)}</td><td className="text-center">{price(r.exitPrice)}</td><td className={`text-center font-black ${Number(r.realizedPnl || r.unrealizedPnl) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{money(r.state === 'CLOSED' ? r.realizedPnl : r.unrealizedPnl)}</td><td className="text-center text-slate-600">{r.closeReason || '—'}</td></tr>)}</tbody></table></div>;
}

function IntegrationCard({ title, status, description, children }: any) {
  const ok = status.configured && status.lastTestOk === true;
  return <Panel title={title}><div className="flex items-center justify-between mb-4"><p className="text-[9px] text-slate-500">{description}</p><span className={`px-2 py-1 rounded-lg text-[7px] uppercase font-black ${ok ? 'bg-emerald-500/10 text-emerald-400' : status.configured ? 'bg-amber-500/10 text-amber-400' : 'bg-slate-800 text-slate-500'}`}>{ok ? 'Conectado' : status.configured ? 'Revisar' : 'No configurado'}</span></div>{status.maskedPrimary && <div className="mb-3 text-[8px] text-slate-600">Guardado: <span className="text-slate-400">{status.maskedPrimary}</span></div>}<div className="space-y-3">{children}</div></Panel>;
}

function IntegrationActions({ busy, configured, save, test, remove }: any) {
  return <div className="flex flex-wrap gap-2 pt-2"><PrimaryButton disabled={busy} onClick={() => void save()}>Guardar y conectar</PrimaryButton>{configured && <><SecondaryButton disabled={busy} onClick={() => void test()}>Probar</SecondaryButton><DangerButton disabled={busy} onClick={() => void remove()}>Desconectar</DangerButton></>}</div>;
}

function TextField({ label, value, onChange, placeholder, secret = false }: any) {
  return <label className="block"><span className="field-label">{label}</span><input className="field" type={secret ? 'password' : 'text'} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} autoComplete="off" /></label>;
}

function NumberSetting({ label, value, min, max, step, suffix = '', onSave }: any) {
  const [draft, setDraft] = useState(String(value ?? ''));
  useEffect(() => setDraft(String(value ?? '')), [value]);
  const save = () => { const n = Number(draft); if (Number.isFinite(n)) void onSave(n); };
  return <label className="rounded-2xl border border-slate-800 bg-black/30 p-3"><span className="field-label">{label}</span><div className="flex items-center gap-2 mt-2"><input className="field" type="number" value={draft} min={min} max={max} step={step} onChange={(e) => setDraft(e.target.value)} onBlur={save} onKeyDown={(e) => e.key === 'Enter' && save()} />{suffix && <span className="text-[8px] text-slate-500 font-black">{suffix}</span>}</div></label>;
}

function SelectSetting({ label, value, options, onSave }: any) {
  return <label className="rounded-2xl border border-slate-800 bg-black/30 p-3"><span className="field-label">{label}</span><select className="field mt-2" value={value} onChange={(e) => void onSave(e.target.value)}>{options.map(([v, t]: string[]) => <option key={v} value={v}>{t}</option>)}</select></label>;
}

function ToggleSetting({ label, checked, onChange }: any) {
  return <button onClick={() => void onChange(!checked)} className={`rounded-2xl border p-3 text-left ${checked ? 'border-emerald-600/40 bg-emerald-500/5' : 'border-slate-800 bg-black/30'}`}><p className="field-label">{label}</p><p className={`mt-2 text-sm font-black ${checked ? 'text-emerald-400' : 'text-slate-600'}`}>{checked ? 'ACTIVO' : 'OFF'}</p></button>;
}

const InfoBox = ({ label, value }: any) => <div className="rounded-2xl border border-slate-800 bg-black/30 p-3"><p className="field-label">{label}</p><p className="mt-2 text-sm text-white font-black">{value}</p></div>;
const Hint = ({ children }: any) => <div className="rounded-xl bg-slate-900/60 border border-slate-800 p-3 text-[8px] text-slate-500 leading-5 flex-1">{children}</div>;
const Banner = ({ tone, children }: any) => <div className={`rounded-2xl border px-4 py-3 text-[10px] ${tone === 'error' ? 'border-rose-500/30 bg-rose-500/10 text-rose-300' : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'}`}>{children}</div>;
const Empty = ({ text }: any) => <div className="py-8 text-center text-[8px] uppercase tracking-widest text-slate-700">{text}</div>;
const PrimaryButton = ({ children, onClick, disabled }: any) => <button disabled={disabled} onClick={onClick} className="px-4 py-2.5 rounded-xl bg-indigo-600 disabled:opacity-40 text-white text-[8px] uppercase tracking-widest font-black">{children}</button>;
const SecondaryButton = ({ children, onClick, disabled }: any) => <button disabled={disabled} onClick={onClick} className="px-4 py-2.5 rounded-xl border border-slate-700 disabled:opacity-40 text-slate-300 text-[8px] uppercase tracking-widest font-black">{children}</button>;
const DangerButton = ({ children, onClick, disabled }: any) => <button disabled={disabled} onClick={onClick} className="px-4 py-2.5 rounded-xl border border-rose-800 disabled:opacity-40 text-rose-400 text-[8px] uppercase tracking-widest font-black">{children}</button>;
const KV = ({ k, v }: any) => <div><p className="text-[7px] text-slate-600 uppercase">{k}</p><p className="font-black text-white mt-1">{v}</p></div>;

function SmallNumber({ label, value, set, step }: any) {
  return <label><span className="field-label">{label}</span><input className="field mt-1" type="number" value={value} step={step} onChange={(e) => set(Number(e.target.value))} /></label>;
}
function DateField({ label, value, set }: any) {
  return <label><span className="field-label">{label}</span><input className="field mt-1" type="date" value={value} onChange={(e) => set(e.target.value)} /></label>;
}

function money(value: any): string { const n = Number(value || 0); return `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`; }
function pct(value: any): string { return `${Number(value || 0).toFixed(1)}%`; }
function factor(value: any): string { return value == null ? '∞' : Number(value || 0).toFixed(2); }
function price(value: any): string { return value == null ? '—' : String(Number(Number(value).toFixed(8))); }
function today(): string { return new Date().toISOString().slice(0, 10); }
function daysAgo(days: number): string { const d = new Date(Date.now() - days * 86400000); return d.toISOString().slice(0, 10); }

export default App;
