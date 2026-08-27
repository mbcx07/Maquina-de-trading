import React, { useCallback, useEffect, useState } from 'react';
import { v34Api } from './services/v34Api';

type View = 'dashboard' | 'settings' | 'backtest';
type IntegrationProvider = 'BINANCE' | 'TELEGRAM' | 'MT5';

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

  const run = async (fn: () => Promise<any>, success?: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await fn();
      if (success) setNotice(success);
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
      <div className="min-h-screen bg-[#010409] text-slate-200 flex items-center justify-center font-mono">
        <div className="text-center space-y-4">
          <div className="w-16 h-16 mx-auto border-4 border-indigo-500/20 border-t-indigo-500 rounded-full animate-spin" />
          <p className="text-[10px] uppercase tracking-[0.35em] text-slate-500">Conectando Quantum Dual V34</p>
          {error && <p className="text-rose-400 text-xs max-w-xl">{error}</p>}
        </div>
      </div>
    );
  }

  const settings = state.settings || {};
  const binanceStatus = integration(state, 'BINANCE');
  const telegramStatus = integration(state, 'TELEGRAM');
  const mt5Integration = integration(state, 'MT5');
  const mt5Status = state.brokerStatus?.mt5 || {};

  const patchSettings = (patch: Record<string, unknown>) => run(() => v34Api.patchSettings(patch));
  const engineAction = (action: 'start' | 'pause' | 'stop') => run(async () => {
    if (action === 'start') return v34Api.startEngine();
    if (action === 'pause') return v34Api.pauseEngine();
    return v34Api.emergencyStop();
  });

  const stopMode = settings.emergencyStopMode || 'PAUSE_ONLY';

  return (
    <div className="min-h-screen bg-[#010409] text-slate-200 p-3 md:p-5 font-mono">
      <div className="max-w-[1850px] mx-auto space-y-4">
        <header className="bg-[#0d1117] border border-slate-800 rounded-3xl p-4 md:p-6 shadow-2xl">
          <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-5">
            <div className="flex items-center gap-4">
              <div className={`w-3 h-3 rounded-full ${settings.engineEnabled ? 'bg-indigo-500 animate-pulse shadow-[0_0_18px_#6366f1]' : 'bg-slate-700'}`} />
              <div>
                <h1 className="text-2xl md:text-3xl font-black italic tracking-tighter uppercase text-white">
                  QUANTUM<span className="text-indigo-500">DUAL</span> V34
                </h1>
                <div className="flex flex-wrap gap-3 mt-2 text-[8px] md:text-[9px] font-black uppercase tracking-widest text-slate-500">
                  <Status label="BINANCE" configured={binanceStatus.configured} ok={binanceStatus.lastTestOk === true} />
                  <Status label="MT5" configured={mt5Integration.configured} ok={Boolean(mt5Status.connected)} />
                  <Status label="TELEGRAM" configured={telegramStatus.configured} ok={telegramStatus.lastTestOk === true} />
                  <span>DB: PERSISTENT</span>
                  <span>SYNC: {lastSync ? new Date(lastSync).toLocaleTimeString() : '—'}</span>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <NavButton active={view === 'dashboard'} onClick={() => setView('dashboard')}>Dashboard</NavButton>
              <NavButton active={view === 'backtest'} onClick={() => setView('backtest')}>📈 Backtest</NavButton>
              <NavButton active={view === 'settings'} onClick={() => setView('settings')}>⚙ Configuración</NavButton>
              <select
                value={settings.appMode}
                disabled={busy || settings.engineEnabled}
                onChange={(e) => void patchSettings({ appMode: e.target.value })}
                className="bg-black/60 border border-slate-700 rounded-xl px-4 py-3 text-[9px] font-black text-white"
              >
                <option value="PAPER">PAPER</option>
                <option value="TESTNET">TESTNET / DEMO</option>
                <option value="REAL">REAL</option>
              </select>
              <button
                disabled={busy}
                onClick={() => void engineAction(settings.engineEnabled ? 'pause' : 'start')}
                className={`px-5 py-3 rounded-xl text-[9px] font-black uppercase ${settings.engineEnabled ? 'bg-amber-500 text-black' : 'bg-indigo-600 text-white'}`}
              >
                {settings.engineEnabled ? 'Pause Engine' : 'Start Engine'}
              </button>
              <button
                disabled={busy}
                onClick={() => void engineAction('stop')}
                title={stopMode === 'CLOSE_TRACKED' ? 'Pausa y solicita cierre de posiciones V34' : 'Solo pausa nuevas entradas'}
                className="px-5 py-3 rounded-xl text-[9px] font-black uppercase bg-rose-700 text-white border border-rose-500/50"
              >
                Emergency Stop · {stopMode === 'CLOSE_TRACKED' ? 'Close' : 'Pause'}
              </button>
            </div>
          </div>
          {state.emergencyStop?.active && (
            <div className="mt-4 bg-rose-500/10 border border-rose-500/30 text-rose-300 rounded-xl px-4 py-3 text-[9px] uppercase font-black">
              Emergency Stop activo · {state.emergencyStop.mode || stopMode}
            </div>
          )}
          {error && <Banner tone="error">{error}</Banner>}
          {notice && <Banner tone="success">{notice}</Banner>}
        </header>

        {view === 'dashboard' && <Dashboard state={state} settings={settings} patchSettings={patchSettings} />}
        {view === 'settings' && (
          <SettingsView
            settings={settings}
            binance={binanceStatus}
            telegram={telegramStatus}
            mt5={mt5Integration}
            mt5Status={mt5Status}
            busy={busy}
            run={run}
            patchSettings={patchSettings}
          />
        )}
        {view === 'backtest' && <BacktestView settings={settings} mt5Connected={Boolean(mt5Status.connected)} />}
      </div>
    </div>
  );
};

function Dashboard({ state, settings, patchSettings }: any) {
  const crypto = state.active?.crypto || [];
  const forex = state.active?.forex || [];
  const cryptoOpps = state.opportunities?.crypto || [];
  const forexOpps = state.opportunities?.forex || [];
  const globalMetrics = state.metrics?.global || emptyMetrics;
  const cryptoMetrics = state.metrics?.crypto || emptyMetrics;
  const forexMetrics = state.metrics?.forex || emptyMetrics;
  const mt5Status = state.brokerStatus?.mt5 || {};
  const recentCrypto = (state.recentTrades || []).filter((t: any) => t.broker === 'BINANCE').slice(0, 15);
  const recentForex = (state.recentTrades || []).filter((t: any) => t.broker === 'MT5').slice(0, 15);

  return (
    <>
      <section className="grid grid-cols-2 lg:grid-cols-6 gap-3">
        <Metric title="Profit Global" value={money(globalMetrics.netProfit)} tone={globalMetrics.netProfit >= 0 ? 'green' : 'red'} />
        <Metric title="Win Rate" value={pct(globalMetrics.winRate)} />
        <Metric title="Crypto PnL" value={money(cryptoMetrics.netProfit)} tone={cryptoMetrics.netProfit >= 0 ? 'green' : 'red'} />
        <Metric title="Crypto WR" value={pct(cryptoMetrics.winRate)} />
        <Metric title="Forex PnL" value={money(forexMetrics.netProfit)} tone={forexMetrics.netProfit >= 0 ? 'green' : 'red'} />
        <Metric title="Forex WR" value={pct(forexMetrics.winRate)} />
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-3 mt-4">
        <ValidationCard title="CRYPTO VALIDATION" trades={cryptoMetrics.trades || 0} target={100} net={cryptoMetrics.netProfit || 0} pf={cryptoMetrics.profitFactor} />
        <ValidationCard title="FOREX VALIDATION" trades={forexMetrics.trades || 0} target={100} net={forexMetrics.netProfit || 0} pf={forexMetrics.profitFactor} />
        <div className="bg-[#0d1117] border border-slate-800 rounded-2xl p-4">
          <p className="text-[8px] uppercase tracking-widest text-slate-500 font-black">Safety</p>
          <p className={`text-lg mt-2 font-black ${state.riskGuard?.status === 'TRIPPED' ? 'text-rose-400' : 'text-emerald-400'}`}>{state.riskGuard?.status || 'INITIALIZING'}</p>
          <p className="text-[8px] text-slate-600 mt-2">Daily {settings.dailyLossLimitPct}% · DD {settings.maxDrawdownPct}% · Stop {settings.emergencyStopMode || 'PAUSE_ONLY'}</p>
        </div>
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-2 gap-4 mt-4">
        <MarketPanel title="CRYPTO · BINANCE FUTURES" accent="indigo" subtitle="Hasta 10 coins simultáneas · nunca se repite símbolo">
          <ScannerLine scanner={state.scanners?.crypto} />
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
            <NumberSetting label="Slots Crypto" value={settings.maxConcurrentCryptoTrades} min={1} max={10} step={1} suffix="/10" onSave={(v: number) => patchSettings({ maxConcurrentCryptoTrades: v })} />
            <NumberSetting label="Margen / trade" value={settings.cryptoMarginPctPerTrade} min={0.01} max={100} step={0.1} suffix="%" onSave={(v: number) => patchSettings({ cryptoMarginPctPerTrade: v })} />
            <NumberSetting label="Leverage" value={settings.cryptoRequestedLeverage} min={1} max={125} step={1} suffix="x" onSave={(v: number) => patchSettings({ cryptoRequestedLeverage: v })} />
            <NumberSetting label="Exposición máx." value={settings.cryptoMaxAccountExposurePct} min={1} max={100} step={1} suffix="%" onSave={(v: number) => patchSettings({ cryptoMaxAccountExposurePct: v })} />
            <NumberSetting label="Pérdida máx. SL" value={settings.cryptoMaxLossPctPerTrade} min={0.01} max={100} step={0.1} suffix="%" onSave={(v: number) => patchSettings({ cryptoMaxLossPctPerTrade: v })} />
            <NumberSetting label="Confianza mín." value={settings.cryptoMinSignalConfidence} min={0} max={100} step={1} suffix="%" onSave={(v: number) => patchSettings({ cryptoMinSignalConfidence: v })} />
          </div>
          <Stats items={[
            ['Slots', `${crypto.length}/${settings.maxConcurrentCryptoTrades}`],
            ['Coins únicas', String(new Set(crypto.map((t: any) => t.symbol)).size)],
            ['Trades', String(cryptoMetrics.trades || 0)],
            ['Profit Factor', factor(cryptoMetrics.profitFactor)],
          ]} />
          <Block title="POSICIONES ABIERTAS"><PositionTable trades={crypto} crypto /></Block>
          <Block title="TOP 10 OPORTUNIDADES"><OpportunityTable rows={cryptoOpps} crypto /></Block>
          <Block title="HISTORIAL CRYPTO"><HistoryTable trades={recentCrypto} /></Block>
        </MarketPanel>

        <MarketPanel title="FOREX · METATRADER 5" accent="cyan" subtitle="Retests permitidos · filtro de spread antes de ejecutar">
          <ScannerLine scanner={state.scanners?.forex} />
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
            <NumberSetting label="Máx. tickets" value={settings.maxConcurrentForexTrades} min={1} max={200} step={1} onSave={(v: number) => patchSettings({ maxConcurrentForexTrades: v })} />
            <NumberSetting label="% por trade" value={settings.forexPctPerTrade} min={0.01} max={100} step={0.1} suffix="%" onSave={(v: number) => patchSettings({ forexPctPerTrade: v })} />
            <SelectSetting label="Sizing" value={settings.forexRiskMode} options={[['RISK_TO_SL', 'Riesgo hasta SL'], ['MARGIN_PERCENT', '% de margen']]} onSave={(v: string) => patchSettings({ forexRiskMode: v })} />
            <NumberSetting label="Entradas / par" value={settings.forexMaxEntriesPerSymbol} min={0} max={50} step={1} suffix={settings.forexMaxEntriesPerSymbol === 0 ? '∞' : ''} onSave={(v: number) => patchSettings({ forexMaxEntriesPerSymbol: v })} />
            <NumberSetting label="Spread máx." value={settings.forexMaxSpreadPoints ?? 30} min={0} max={100000} step={1} suffix="pts" onSave={(v: number) => patchSettings({ forexMaxSpreadPoints: v })} />
            <InfoBox label="Modo MT5" value={settings.appMode === 'PAPER' ? 'PAPER' : mt5Status?.account?.hedging ? 'HEDGING' : 'NETTING / CHECK'} />
          </div>
          <Stats items={[
            ['Tickets', `${forex.length}/${settings.maxConcurrentForexTrades}`],
            ['Pares activos', String(new Set(forex.map((t: any) => t.symbol)).size)],
            ['Trades', String(forexMetrics.trades || 0)],
            ['Profit Factor', factor(forexMetrics.profitFactor)],
          ]} />
          <Block title="POSICIONES / REENTRADAS"><PositionTable trades={forex} /></Block>
          <Block title="SETUPS FOREX"><OpportunityTable rows={forexOpps} /></Block>
          <Block title="HISTORIAL FOREX"><HistoryTable trades={recentForex} /></Block>
        </MarketPanel>
      </section>
    </>
  );
}

function SettingsView({ settings, binance, telegram, mt5, mt5Status, busy, run, patchSettings }: any) {
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [botToken, setBotToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [bridgeUrl, setBridgeUrl] = useState('http://127.0.0.1:8790');
  const [bridgeToken, setBridgeToken] = useState('');
  const [showBinanceSecret, setShowBinanceSecret] = useState(false);
  const [showTelegramToken, setShowTelegramToken] = useState(false);
  const [showBridgeToken, setShowBridgeToken] = useState(false);
  const [forexSymbols, setForexSymbols] = useState((settings.forexSymbols || []).join(', '));

  useEffect(() => setForexSymbols((settings.forexSymbols || []).join(', ')), [settings.forexSymbols]);

  const saveBinance = async () => {
    if (!apiKey.trim() || !apiSecret.trim()) return;
    const result = await run(() => v34Api.saveBinanceIntegration(apiKey.trim(), apiSecret.trim()), 'Binance guardado y validado.');
    if (result) { setApiKey(''); setApiSecret(''); }
  };
  const saveTelegram = async () => {
    if (!botToken.trim() || !chatId.trim()) return;
    const result = await run(() => v34Api.saveTelegramIntegration(botToken.trim(), chatId.trim()), 'Telegram guardado; mensaje de prueba enviado.');
    if (result) { setBotToken(''); setChatId(''); }
  };
  const saveMt5 = async () => {
    if (!bridgeUrl.trim() || !bridgeToken.trim()) return;
    const result = await run(() => v34Api.saveMt5Integration(bridgeUrl.trim(), bridgeToken.trim()), 'MT5 Bridge conectado y validado.');
    if (result) setBridgeToken('');
  };
  const saveForexSymbols = async () => {
    const symbols = forexSymbols.split(',').map((s) => s.trim()).filter(Boolean);
    if (symbols.length) await patchSettings({ forexSymbols: symbols });
  };

  return (
    <div className="space-y-4">
      <section className="bg-gradient-to-br from-indigo-950/35 to-[#0d1117] border border-indigo-900/40 rounded-3xl p-5 md:p-7 shadow-2xl">
        <p className="text-[8px] uppercase tracking-[0.25em] font-black text-indigo-400">Instalación individual</p>
        <h2 className="text-2xl md:text-3xl font-black text-white tracking-tight mt-2">Conexiones y seguridad</h2>
        <p className="text-[10px] text-slate-400 leading-6 mt-3 max-w-5xl">
          Binance, Telegram y el token del bridge MT5 se almacenan cifrados en el backend. La contraseña de tu cuenta MT5 puede quedarse únicamente dentro del terminal MetaTrader 5.
        </p>
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <IntegrationCard title="BINANCE FUTURES" icon="₿" status={binance} description="Cuenta USDⓈ-M Futures para Crypto.">
          <SecretField label="API Key" value={apiKey} onChange={setApiKey} placeholder={binance.configured ? 'Nueva API Key para reemplazar' : 'API Key'} type="text" />
          <SecretField label="API Secret" value={apiSecret} onChange={setApiSecret} placeholder="API Secret" type={showBinanceSecret ? 'text' : 'password'} toggle={() => setShowBinanceSecret((v) => !v)} />
          <SecurityHint>Futures habilitado, retiros deshabilitados. Para REAL usa whitelist de IP.</SecurityHint>
          <IntegrationActions configured={binance.configured} busy={busy} save={saveBinance} test={() => run(() => v34Api.testIntegration('binance'), 'Binance validado.')} remove={() => run(() => v34Api.removeIntegration('binance'), 'Binance desconectado.')} />
        </IntegrationCard>

        <IntegrationCard title="MT5 BRIDGE" icon="M5" status={mt5} description="Conecta el terminal MT5 abierto en tu PC/VPS Windows.">
          <SecretField label="Bridge URL" value={bridgeUrl} onChange={setBridgeUrl} placeholder="http://127.0.0.1:8790" type="text" />
          <SecretField label="Bridge Token" value={bridgeToken} onChange={setBridgeToken} placeholder="Token privado del bridge" type={showBridgeToken ? 'text' : 'password'} toggle={() => setShowBridgeToken((v) => !v)} />
          <SecurityHint>No pegues la contraseña del broker. MT5 puede permanecer iniciado y el bridge usa esa sesión.</SecurityHint>
          {mt5Status?.account && (
            <div className="grid grid-cols-2 gap-2">
              <InfoBox label="Cuenta" value={String(mt5Status.account.login || '—')} />
              <InfoBox label="Modo" value={mt5Status.account.hedging ? 'HEDGING' : 'NETTING'} />
              <InfoBox label="Balance" value={money(mt5Status.account.balance)} />
              <InfoBox label="Leverage" value={`${mt5Status.account.leverage || '—'}x`} />
            </div>
          )}
          <IntegrationActions configured={mt5.configured} busy={busy} save={saveMt5} test={() => run(() => v34Api.testIntegration('mt5'), 'MT5 Bridge validado.')} remove={() => run(() => v34Api.removeIntegration('mt5'), 'MT5 desconectado.')} />
        </IntegrationCard>

        <IntegrationCard title="TELEGRAM" icon="✈" status={telegram} description="Avisos de aperturas, cierres, PnL y seguridad.">
          <SecretField label="Bot Token" value={botToken} onChange={setBotToken} placeholder={telegram.configured ? 'Nuevo token para reemplazar' : 'Token de @BotFather'} type={showTelegramToken ? 'text' : 'password'} toggle={() => setShowTelegramToken((v) => !v)} />
          <SecretField label="Chat ID / Canal" value={chatId} onChange={setChatId} placeholder="Ej. -1001234567890" type="text" />
          <SecurityHint>Guardar y conectar envía automáticamente un mensaje de prueba.</SecurityHint>
          <IntegrationActions configured={telegram.configured} busy={busy} save={saveTelegram} test={() => run(() => v34Api.testIntegration('telegram'), 'Telegram validado.')} remove={() => run(() => v34Api.removeIntegration('telegram'), 'Telegram desconectado.')} />
        </IntegrationCard>
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Panel title="RIESGO Y EMERGENCIA">
          <div className="grid grid-cols-2 gap-2">
            <NumberSetting label="Pérdida diaria máx." value={settings.dailyLossLimitPct} min={0.1} max={100} step={0.1} suffix="%" onSave={(v: number) => patchSettings({ dailyLossLimitPct: v })} />
            <NumberSetting label="Drawdown máximo" value={settings.maxDrawdownPct} min={0.1} max={100} step={0.1} suffix="%" onSave={(v: number) => patchSettings({ maxDrawdownPct: v })} />
            <NumberSetting label="Spread máx. Forex" value={settings.forexMaxSpreadPoints ?? 30} min={0} max={100000} step={1} suffix="pts" onSave={(v: number) => patchSettings({ forexMaxSpreadPoints: v })} />
            <SelectSetting
              label="Emergency Stop"
              value={settings.emergencyStopMode || 'PAUSE_ONLY'}
              options={[
                ['PAUSE_ONLY', 'Solo pausar entradas'],
                ['CLOSE_TRACKED', 'Cerrar operaciones V34 y pausar'],
              ]}
              onSave={(v: string) => patchSettings({ emergencyStopMode: v })}
            />
          </div>
          <div className="grid grid-cols-2 gap-2 mt-3">
            <ToggleSetting label="Crypto activo" checked={Boolean(settings.cryptoEnabled)} onChange={(checked: boolean) => patchSettings({ cryptoEnabled: checked })} />
            <ToggleSetting label="Forex activo" checked={Boolean(settings.forexEnabled)} onChange={(checked: boolean) => patchSettings({ forexEnabled: checked })} />
            <ToggleSetting label="Risk Kill-Switch" checked={Boolean(settings.riskKillSwitchEnabled)} onChange={(checked: boolean) => patchSettings({ riskKillSwitchEnabled: checked })} />
          </div>
          <div className="mt-3 rounded-2xl bg-rose-500/5 border border-rose-500/20 p-4 text-[8px] text-rose-200/70 leading-5">
            CLOSE_TRACKED solo solicita el cierre de posiciones registradas por V34. No debe cerrar operaciones manuales externas. El reconciliador confirma después el cierre y PnL real.
          </div>
        </Panel>

        <Panel title="UNIVERSO FOREX MT5">
          <p className="text-[8px] text-slate-500 leading-5 mb-3">Usa los símbolos exactos publicados por tu broker. Ejemplo: EURUSD o EURUSDm.</p>
          <textarea value={forexSymbols} onChange={(e) => setForexSymbols(e.target.value)} className="w-full min-h-28 bg-[#05080d] border border-slate-700 rounded-2xl p-4 text-[10px] text-white outline-none focus:border-cyan-600" />
          <div className="mt-3"><PrimaryButton disabled={busy} onClick={() => void saveForexSymbols()}>Guardar pares Forex</PrimaryButton></div>
        </Panel>
      </section>

      <Panel title="MT5 · ARRANQUE LOCAL">
        <div className="grid md:grid-cols-4 gap-3">
          <ArchitectureStep n="1" title="Abrir MT5" text="Inicia sesión en Demo y activa trading algorítmico." />
          <ArchitectureStep n="2" title="Bridge" text="Ejecuta uvicorn app:app en el mismo Windows/VPS." />
          <ArchitectureStep n="3" title="Conectar" text="Guarda URL 127.0.0.1:8790 y token privado." />
          <ArchitectureStep n="4" title="Validar" text="Comprueba balance, hedging, permisos y spread." />
        </div>
      </Panel>
    </div>
  );
}

function BacktestView({ settings, mt5Connected }: any) {
  const [broker, setBroker] = useState<'BINANCE' | 'MT5'>('BINANCE');
  const [symbolsText, setSymbolsText] = useState('BTCUSDT, ETHUSDT, SOLUSDT, XRPUSDT, BNBUSDT');
  const [startDate, setStartDate] = useState(daysAgoIso(7));
  const [endDate, setEndDate] = useState(todayIso());
  const [initialBalance, setInitialBalance] = useState(1000);
  const [allocationPct, setAllocationPct] = useState(1);
  const [leverage, setLeverage] = useState(20);
  const [costPct, setCostPct] = useState(0.12);
  const [scanStep, setScanStep] = useState(3);
  const [maxHold, setMaxHold] = useState(90);
  const [sizingMode, setSizingMode] = useState<'MARGIN_PERCENT' | 'RISK_TO_SL'>('MARGIN_PERCENT');
  const [runs, setRuns] = useState<any[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refreshRuns = useCallback(async () => {
    try {
      const list = await v34Api.listBacktests(20);
      setRuns(list.runs || []);
      if (!selectedId && list.runs?.[0]?.id) setSelectedId(list.runs[0].id);
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  }, [selectedId]);

  useEffect(() => { void refreshRuns(); }, [refreshRuns]);
  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    let cancelled = false;
    const load = async () => {
      try {
        const response = await v34Api.getBacktest(selectedId);
        if (!cancelled) setDetail(response.run);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || String(e));
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 4000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [selectedId]);

  useEffect(() => {
    if (broker === 'BINANCE') {
      setSymbolsText('BTCUSDT, ETHUSDT, SOLUSDT, XRPUSDT, BNBUSDT');
      setSizingMode('MARGIN_PERCENT');
      setAllocationPct(Number(settings.cryptoMarginPctPerTrade || 1));
      setLeverage(Number(settings.cryptoRequestedLeverage || 20));
      setCostPct(0.12);
    } else {
      setSymbolsText((settings.forexSymbols || ['EURUSD', 'GBPUSD', 'USDJPY']).slice(0, 10).join(', '));
      setSizingMode(settings.forexRiskMode || 'RISK_TO_SL');
      setAllocationPct(Number(settings.forexPctPerTrade || 1));
      setLeverage(1);
      setCostPct(0.03);
    }
  }, [broker, settings]);

  const start = async () => {
    setError('');
    if (broker === 'MT5' && !mt5Connected) { setError('Conecta primero MT5 Bridge en Configuración.'); return; }
    const symbols = [...new Set(symbolsText.split(',').map((s) => s.trim()).filter(Boolean))];
    if (!symbols.length) { setError('Agrega al menos un símbolo.'); return; }
    setBusy(true);
    try {
      const result = await v34Api.createBacktest({
        broker,
        symbols,
        startTime: new Date(`${startDate}T00:00:00Z`).getTime(),
        endTime: new Date(`${endDate}T23:59:59Z`).getTime(),
        initialBalance,
        allocationPct,
        leverage,
        roundTripCostPct: costPct,
        scanStepMinutes: scanStep,
        maxHoldMinutes: maxHold,
        sizingMode,
      });
      setSelectedId(result.id);
      await refreshRuns();
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const result = detail?.result;
  const progress = detail?.progress || {};

  return (
    <div className="grid grid-cols-1 2xl:grid-cols-[430px_1fr] gap-4">
      <div className="space-y-4">
        <Panel title="NUEVA PRUEBA HISTÓRICA">
          <div className="space-y-3">
            <SelectField label="Mercado" value={broker} onChange={(v: string) => setBroker(v as any)} options={[['BINANCE', 'Crypto · Binance Futures'], ['MT5', 'Forex · MT5']]} />
            <label className="block"><span className="field-label">Símbolos</span><textarea value={symbolsText} onChange={(e) => setSymbolsText(e.target.value)} className="field min-h-24" /></label>
            <div className="grid grid-cols-2 gap-2">
              <DateField label="Desde" value={startDate} onChange={setStartDate} />
              <DateField label="Hasta" value={endDate} onChange={setEndDate} />
              <SmallNumber label="Balance inicial" value={initialBalance} set={setInitialBalance} step={100} />
              <SmallNumber label="% por trade" value={allocationPct} set={setAllocationPct} step={0.1} />
              <SmallNumber label="Leverage" value={leverage} set={setLeverage} step={1} disabled={sizingMode === 'RISK_TO_SL'} />
              <SmallNumber label="Costo round-trip %" value={costPct} set={setCostPct} step={0.01} />
              <SmallNumber label="Escaneo cada min" value={scanStep} set={setScanStep} step={1} />
              <SmallNumber label="Máx. duración min" value={maxHold} set={setMaxHold} step={15} />
            </div>
            <SelectField label="Modelo de tamaño" value={sizingMode} onChange={(v: string) => setSizingMode(v as any)} options={[['MARGIN_PERCENT', '% margen × leverage'], ['RISK_TO_SL', '% de equity hasta SL']]} />
            <SecurityHint>El costo es editable. Para decidir rentabilidad final se contrastará con fees, funding, spread, comisión y swap reales de Demo/Testnet.</SecurityHint>
            {error && <Banner tone="error">{error}</Banner>}
            <PrimaryButton disabled={busy} onClick={() => void start()}>{busy ? 'Iniciando…' : 'Ejecutar backtest'}</PrimaryButton>
          </div>
        </Panel>

        <Panel title="CORRIDAS GUARDADAS">
          <div className="space-y-2 max-h-[460px] overflow-auto">
            {!runs.length && <Empty text="Sin backtests todavía" />}
            {runs.map((run) => (
              <button key={run.id} onClick={() => setSelectedId(run.id)} className={`w-full text-left p-3 rounded-xl border ${selectedId === run.id ? 'border-indigo-500 bg-indigo-500/10' : 'border-slate-800 bg-black/20'}`}>
                <div className="flex justify-between gap-3"><span className="text-[9px] font-black text-white">{run.broker} · {(run.request?.symbols || []).length} símbolos</span><RunStatus status={run.status} /></div>
                <div className="text-[8px] text-slate-600 mt-2">{new Date(run.createdAt).toLocaleString()} · {run.progress?.stage || '—'}</div>
              </button>
            ))}
          </div>
        </Panel>
      </div>

      <div className="space-y-4">
        {!detail && <Panel title="RESULTADO"><Empty text="Selecciona o ejecuta un backtest" /></Panel>}
        {detail && detail.status !== 'COMPLETED' && (
          <Panel title={`BACKTEST ${detail.status}`}>
            <div className="py-8">
              <div className="h-2 bg-slate-900 rounded-full overflow-hidden"><div className="h-full bg-indigo-500" style={{ width: `${progress.total ? Math.min(100, (progress.completed || 0) / progress.total * 100) : 5}%` }} /></div>
              <div className="flex justify-between mt-3 text-[9px] text-slate-500"><span>{progress.stage || detail.status}</span><span>{progress.completed || 0}/{progress.total || 0}</span></div>
              {detail.error && <Banner tone="error">{detail.error}</Banner>}
            </div>
          </Panel>
        )}
        {result && <BacktestResult result={result} />}
      </div>
    </div>
  );
}

function BacktestResult({ result }: any) {
  const m = result.metrics || emptyHistorical;
  const ins = result.inSample || emptyHistorical;
  const oos = result.outOfSample || emptyHistorical;
  return (
    <>
      <section className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-8 gap-2">
        <Metric title="Net Profit" value={money(m.netProfit)} tone={m.netProfit >= 0 ? 'green' : 'red'} />
        <Metric title="Return" value={pct(m.returnPct)} tone={m.returnPct >= 0 ? 'green' : 'red'} />
        <Metric title="Win Rate" value={pct(m.winRate)} />
        <Metric title="Profit Factor" value={factor(m.profitFactor)} />
        <Metric title="Max DD" value={pct(m.maxDrawdownPct)} tone="red" />
        <Metric title="Trades" value={String(m.trades || 0)} />
        <Metric title="Expectancy" value={money(m.expectancy)} tone={m.expectancy >= 0 ? 'green' : 'red'} />
        <Metric title="Costs" value={money(m.costs)} tone="red" />
      </section>
      <Panel title="CURVA DE EQUITY"><EquityChart points={result.equityCurve || []} /></Panel>
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SampleCard title="70% IN-SAMPLE" metrics={ins} />
        <SampleCard title="30% OUT-OF-SAMPLE" metrics={oos} emphasize />
      </section>
      <Panel title="RESULTADO POR SÍMBOLO">
        <div className="overflow-auto max-h-[360px]"><table className="w-full min-w-[650px] text-left"><thead className="text-[7px] uppercase text-slate-600"><tr>{['Símbolo','Trades','WR','Profit','Return','PF','DD'].map((h) => <th key={h} className="px-3 py-2">{h}</th>)}</tr></thead><tbody>{(result.bySymbol || []).map((row: any) => <tr key={row.symbol} className="border-t border-slate-900 text-[9px]"><td className="px-3 py-3 font-black text-white">{row.symbol}</td><td className="px-3 py-3">{row.metrics.trades}</td><td className="px-3 py-3">{pct(row.metrics.winRate)}</td><td className={`px-3 py-3 font-black ${row.metrics.netProfit >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{money(row.metrics.netProfit)}</td><td className="px-3 py-3">{pct(row.metrics.returnPct)}</td><td className="px-3 py-3">{factor(row.metrics.profitFactor)}</td><td className="px-3 py-3">{pct(row.metrics.maxDrawdownPct)}</td></tr>)}</tbody></table></div>
      </Panel>
      <Panel title="INTERPRETACIÓN">
        <div className="grid md:grid-cols-3 gap-3">
          <Verdict label="Rentabilidad OOS" ok={oos.netProfit > 0} text={oos.netProfit > 0 ? 'Positiva fuera de muestra' : 'Negativa fuera de muestra'} />
          <Verdict label="Expectancy OOS" ok={oos.expectancy > 0} text={`${money(oos.expectancy)} por trade`} />
          <Verdict label="Profit Factor OOS" ok={(oos.profitFactor ?? 0) > 1} text={factor(oos.profitFactor)} />
        </div>
        <p className="text-[8px] text-slate-500 leading-5 mt-4">Un resultado positivo no garantiza rentabilidad futura. Se debe repetir en varias ventanas y confirmarse en Demo/Testnet.</p>
      </Panel>
    </>
  );
}

function EquityChart({ points }: any) {
  if (!points?.length) return <Empty text="Sin curva de equity" />;
  const values = points.map((p: any) => Number(p.equity));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(1e-9, max - min);
  const width = 800, height = 220, pad = 18;
  const line = points.map((p: any, i: number) => {
    const x = pad + (i / Math.max(1, points.length - 1)) * (width - pad * 2);
    const y = height - pad - ((Number(p.equity) - min) / range) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return <div><svg viewBox={`0 0 ${width} ${height}`} className="w-full h-[220px] bg-black/20 rounded-2xl border border-slate-800"><line x1={pad} y1={height-pad} x2={width-pad} y2={height-pad} stroke="currentColor" className="text-slate-800" /><polyline points={line} fill="none" stroke="currentColor" strokeWidth="3" className="text-indigo-400" /></svg><div className="flex justify-between text-[8px] text-slate-600 mt-2"><span>Min {money(min)}</span><span>Max {money(max)}</span></div></div>;
}

function SampleCard({ title, metrics, emphasize = false }: any) { return <section className={`rounded-3xl p-5 border ${emphasize ? 'bg-indigo-500/5 border-indigo-800/60' : 'bg-[#0d1117] border-slate-800'}`}><p className="text-[9px] font-black uppercase tracking-widest text-white">{title}</p><div className="grid grid-cols-3 gap-2 mt-4"><MiniStat label="Profit" value={money(metrics.netProfit)} good={metrics.netProfit > 0} /><MiniStat label="WR" value={pct(metrics.winRate)} /><MiniStat label="PF" value={factor(metrics.profitFactor)} good={(metrics.profitFactor ?? 0) > 1} /><MiniStat label="Trades" value={String(metrics.trades || 0)} /><MiniStat label="DD" value={pct(metrics.maxDrawdownPct)} /><MiniStat label="Exp." value={money(metrics.expectancy)} good={metrics.expectancy > 0} /></div></section>; }
function ValidationCard({ title, trades, target, net, pf }: any) { const progress = Math.min(100, trades / target * 100); return <div className="bg-[#0d1117] border border-slate-800 rounded-2xl p-4"><div className="flex justify-between"><p className="text-[8px] uppercase tracking-widest text-slate-500 font-black">{title}</p><span className="text-[8px] text-slate-600">{trades}/{target}</span></div><div className="h-1.5 bg-slate-900 rounded-full overflow-hidden mt-3"><div className="h-full bg-indigo-500" style={{ width: `${progress}%` }} /></div><div className="flex justify-between mt-3 text-[9px]"><span className={net >= 0 ? 'text-emerald-400' : 'text-rose-400'}>{money(net)}</span><span className="text-slate-500">PF {factor(pf)}</span></div></div>; }
function IntegrationActions({ configured, busy, save, test, remove }: any) { return <div className="flex flex-wrap gap-2 pt-2"><PrimaryButton disabled={busy} onClick={() => void save()}>Guardar y conectar</PrimaryButton>{configured && <SecondaryButton disabled={busy} onClick={() => void test()}>Probar conexión</SecondaryButton>}{configured && <DangerButton disabled={busy} onClick={() => void remove()}>Desconectar</DangerButton>}</div>; }
function integration(state: any, provider: IntegrationProvider) { return (state.integrations || []).find((item: any) => item.provider === provider) || { provider, configured: false }; }

const emptyMetrics = { trades: 0, winRate: 0, netProfit: 0, profitFactor: 0 };
const emptyHistorical = { trades: 0, winRate: 0, netProfit: 0, returnPct: 0, profitFactor: 0, expectancy: 0, maxDrawdownPct: 0, costs: 0 };

function Status({ label, configured, ok }: any) { return <span className="flex items-center gap-1.5"><i className={`w-1.5 h-1.5 rounded-full ${ok ? 'bg-emerald-500' : configured ? 'bg-amber-500' : 'bg-rose-500'}`} />{label}</span>; }
function NavButton({ active, onClick, children }: any) { return <button onClick={onClick} className={`px-4 py-3 rounded-xl text-[9px] font-black uppercase border ${active ? 'bg-indigo-600 border-indigo-500 text-white' : 'bg-black/30 border-slate-800 text-slate-400'}`}>{children}</button>; }
function Banner({ tone, children }: any) { return <div className={`mt-4 rounded-xl px-4 py-3 text-[10px] border ${tone === 'error' ? 'bg-rose-500/10 border-rose-500/30 text-rose-300' : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'}`}>{children}</div>; }
function Metric({ title, value, tone }: any) { return <div className="bg-[#0d1117] border border-slate-800 rounded-2xl p-4 shadow-xl"><p className="text-[7px] uppercase tracking-[0.2em] text-slate-500 font-black">{title}</p><p className={`text-xl mt-2 font-black ${tone === 'green' ? 'text-emerald-400' : tone === 'red' ? 'text-rose-400' : 'text-white'}`}>{value}</p></div>; }
function MarketPanel({ title, subtitle, accent, children }: any) { return <section className={`bg-[#0d1117] border ${accent === 'cyan' ? 'border-cyan-950' : 'border-indigo-950'} rounded-[2rem] p-4 md:p-6 shadow-2xl space-y-4`}><div><h2 className={`text-lg md:text-xl font-black italic ${accent === 'cyan' ? 'text-cyan-400' : 'text-indigo-400'}`}>{title}</h2><p className="text-[8px] text-slate-500 uppercase tracking-widest mt-1">{subtitle}</p></div>{children}</section>; }
function ScannerLine({ scanner }: any) { if (!scanner) return <div className="bg-black/20 border border-slate-800 rounded-xl px-3 py-2 text-[8px] text-slate-600">Scanner inicializando…</div>; return <div className="flex flex-wrap gap-3 bg-black/20 border border-slate-800 rounded-xl px-3 py-2 text-[8px] uppercase text-slate-500"><span className="text-indigo-400 font-black">{scanner.status || '—'}</span><span>{scanner.current || '—'}</span><span>{scanner.scanned || 0}/{scanner.total || 0}</span><span>Setups: {scanner.opportunities || 0}</span></div>; }
function NumberSetting({ label, value, min, max, step, suffix = '', onSave }: any) { const [draft, setDraft] = useState(String(value ?? '')); useEffect(() => setDraft(String(value ?? '')), [value]); const save = () => { const n = Number(draft); if (Number.isFinite(n)) void onSave(n); }; return <label className="bg-black/30 border border-slate-800 rounded-2xl p-3 block"><span className="text-[7px] text-slate-500 uppercase font-black tracking-widest">{label}</span><div className="flex items-center gap-2 mt-2"><input type="number" value={draft} min={min} max={max} step={step} onChange={(e) => setDraft(e.target.value)} onBlur={save} onKeyDown={(e) => e.key === 'Enter' && save()} className="w-full bg-[#05080d] border border-slate-700 rounded-xl px-3 py-2 text-sm font-black text-white outline-none" />{suffix && <span className="text-[8px] text-slate-500 font-black">{suffix}</span>}</div></label>; }
function SelectSetting({ label, value, options, onSave }: any) { return <label className="bg-black/30 border border-slate-800 rounded-2xl p-3 block"><span className="text-[7px] text-slate-500 uppercase font-black tracking-widest">{label}</span><select value={value} onChange={(e) => void onSave(e.target.value)} className="w-full mt-2 bg-[#05080d] border border-slate-700 rounded-xl px-3 py-2 text-[9px] font-black text-white">{options.map(([v, t]: string[]) => <option key={v} value={v}>{t}</option>)}</select></label>; }
function ToggleSetting({ label, checked, onChange }: any) { return <label className="flex items-center justify-between bg-black/30 border border-slate-800 rounded-2xl p-4"><span className="text-[8px] font-black text-white uppercase">{label}</span><input type="checkbox" checked={checked} onChange={(e) => void onChange(e.target.checked)} /></label>; }
function InfoBox({ label, value }: any) { return <div className="bg-black/30 border border-slate-800 rounded-2xl p-3"><p className="text-[7px] text-slate-500 uppercase font-black tracking-widest">{label}</p><p className="text-sm text-emerald-400 font-black mt-2 break-all">{value}</p></div>; }
function Stats({ items }: any) { return <div className="grid grid-cols-2 md:grid-cols-4 gap-2">{items.map(([l, v]: string[]) => <div key={l} className="bg-black/30 border border-slate-800 rounded-2xl p-3"><p className="text-[7px] uppercase text-slate-600 font-black">{l}</p><p className="text-base font-black text-white mt-1">{v}</p></div>)}</div>; }
function Block({ title, children }: any) { return <div className="bg-black/20 border border-slate-800 rounded-2xl overflow-hidden"><div className="px-4 py-3 border-b border-slate-800"><h3 className="text-[8px] font-black tracking-[0.18em] uppercase text-slate-400">{title}</h3></div>{children}</div>; }
function Panel({ title, children }: any) { return <section className="bg-[#0d1117] border border-slate-800 rounded-3xl p-5 md:p-6"><h3 className="text-[10px] font-black tracking-widest text-white">{title}</h3><div className="mt-4">{children}</div></section>; }
function ArchitectureStep({ n, title, text }: any) { return <div className="bg-black/25 border border-slate-800 rounded-2xl p-4"><div className="w-7 h-7 rounded-lg bg-indigo-600 grid place-items-center text-[9px] font-black">{n}</div><p className="text-[9px] font-black text-white mt-3 uppercase">{title}</p><p className="text-[8px] text-slate-600 mt-1 leading-4">{text}</p></div>; }
function Empty({ text }: any) { return <div className="py-8 text-center text-[8px] uppercase tracking-widest text-slate-700">{text}</div>; }
function IntegrationCard({ title, icon, status, description, children }: any) { const ok = status.lastTestOk === true; return <section className="bg-[#0d1117] border border-slate-800 rounded-3xl p-5 md:p-6 shadow-2xl"><div className="flex items-start justify-between gap-4"><div className="flex gap-4"><div className="w-12 h-12 rounded-2xl bg-black/40 border border-slate-800 grid place-items-center text-xl font-black">{icon}</div><div><h3 className="text-lg font-black text-white">{title}</h3><p className="text-[9px] text-slate-500 mt-1 leading-5">{description}</p></div></div><span className={`text-[8px] uppercase font-black px-3 py-2 rounded-xl border ${ok ? 'text-emerald-300 bg-emerald-500/10 border-emerald-500/20' : status.configured ? 'text-amber-300 bg-amber-500/10 border-amber-500/20' : 'text-slate-500 bg-black/30 border-slate-800'}`}>{ok ? 'Conectado' : status.configured ? 'Revisar' : 'No configurado'}</span></div>{status.configured && <div className="grid grid-cols-2 gap-2 mt-4"><InfoBox label="Guardado" value={status.maskedPrimary || '••••'} /><InfoBox label="Secundario" value={status.maskedSecondary || '••••'} /></div>}{status.lastError && <div className="mt-3 bg-rose-500/10 border border-rose-500/20 text-rose-300 rounded-xl p-3 text-[8px] break-all">{status.lastError}</div>}<div className="space-y-3 mt-5">{children}</div></section>; }
function SecretField({ label, value, onChange, placeholder, type, toggle }: any) { return <label className="block"><span className="text-[8px] uppercase tracking-widest font-black text-slate-500">{label}</span><div className="flex gap-2 mt-2"><input type={type} value={value} onChange={(e) => onChange(e.target.value)} autoComplete="off" placeholder={placeholder} className="w-full bg-[#05080d] border border-slate-700 rounded-xl px-4 py-3 text-[10px] text-white outline-none focus:border-indigo-500" />{toggle && <button type="button" onClick={toggle} className="px-3 rounded-xl bg-black/30 border border-slate-800 text-[8px] text-slate-400">VER</button>}</div></label>; }
function SecurityHint({ children }: any) { return <div className="rounded-xl bg-amber-500/5 border border-amber-500/15 text-amber-200/70 p-3 text-[8px] leading-5">🔐 {children}</div>; }
function PrimaryButton({ children, ...props }: any) { return <button {...props} className="px-4 py-3 rounded-xl bg-indigo-600 text-white text-[8px] font-black uppercase disabled:opacity-40">{children}</button>; }
function SecondaryButton({ children, ...props }: any) { return <button {...props} className="px-4 py-3 rounded-xl bg-black/40 border border-slate-700 text-slate-300 text-[8px] font-black uppercase disabled:opacity-40">{children}</button>; }
function DangerButton({ children, ...props }: any) { return <button {...props} className="px-4 py-3 rounded-xl bg-rose-950/40 border border-rose-900 text-rose-300 text-[8px] font-black uppercase disabled:opacity-40">{children}</button>; }
function SelectField({ label, value, onChange, options }: any) { return <label className="block"><span className="field-label">{label}</span><select value={value} onChange={(e) => onChange(e.target.value)} className="field">{options.map(([v, t]: string[]) => <option key={v} value={v}>{t}</option>)}</select></label>; }
function DateField({ label, value, onChange }: any) { return <label className="block"><span className="field-label">{label}</span><input type="date" value={value} onChange={(e) => onChange(e.target.value)} className="field" /></label>; }
function SmallNumber({ label, value, set, step, disabled = false }: any) { return <label className="block"><span className="field-label">{label}</span><input disabled={disabled} type="number" value={value} step={step} onChange={(e) => set(Number(e.target.value))} className="field disabled:opacity-40" /></label>; }
function RunStatus({ status }: any) { const good = status === 'COMPLETED'; const bad = status === 'FAILED' || status === 'INTERRUPTED'; return <span className={`text-[7px] font-black px-2 py-1 rounded-lg ${good ? 'bg-emerald-500/10 text-emerald-400' : bad ? 'bg-rose-500/10 text-rose-400' : 'bg-amber-500/10 text-amber-400'}`}>{status}</span>; }
function MiniStat({ label, value, good }: any) { return <div className="bg-black/25 border border-slate-800 rounded-xl p-3"><p className="text-[7px] text-slate-600 uppercase">{label}</p><p className={`text-sm font-black mt-1 ${good === true ? 'text-emerald-400' : good === false ? 'text-rose-400' : 'text-white'}`}>{value}</p></div>; }
function Verdict({ label, ok, text }: any) { return <div className={`rounded-2xl p-4 border ${ok ? 'bg-emerald-500/5 border-emerald-500/20' : 'bg-rose-500/5 border-rose-500/20'}`}><p className="text-[7px] uppercase text-slate-500 font-black">{label}</p><p className={`text-sm mt-2 font-black ${ok ? 'text-emerald-400' : 'text-rose-400'}`}>{text}</p></div>; }

function PositionTable({ trades, crypto = false }: any) { if (!trades.length) return <Empty text="Sin posiciones abiertas" />; return <div className="overflow-x-auto"><table className="w-full min-w-[680px] text-left"><thead className="text-[7px] uppercase text-slate-600"><tr>{['Símbolo','Side',crypto?'Lev/Margen':'Ticket/Lote','Entry','SL','TP','PnL','Estado'].map((h) => <th key={h} className="px-3 py-2">{h}</th>)}</tr></thead><tbody>{trades.map((t: any) => <tr key={t.id} className="border-t border-slate-900 text-[9px]"><td className="px-3 py-3 font-black text-white">{t.symbol}</td><td className={`px-3 py-3 font-black ${t.side === 'BUY' ? 'text-emerald-400' : 'text-rose-400'}`}>{t.side}</td><td className="px-3 py-3">{crypto ? `${t.leverage ?? '-'}x · ${money(t.marginUsed)}` : `${t.brokerOrderId ?? '-'} · ${t.lotSize ?? '-'}`}</td><td className="px-3 py-3">{price(t.entryPrice)}</td><td className="px-3 py-3 text-rose-300">{price(t.stopLoss)}</td><td className="px-3 py-3 text-emerald-300">{price(t.takeProfit)}</td><td className={`px-3 py-3 font-black ${(t.unrealizedPnl || 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{money(t.unrealizedPnl)}</td><td className="px-3 py-3 text-slate-500">{t.state}</td></tr>)}</tbody></table></div>; }
function OpportunityTable({ rows, crypto = false }: any) { if (!rows.length) return <Empty text="Esperando oportunidades" />; return <div className="overflow-auto max-h-[280px]"><table className="w-full min-w-[620px] text-left"><thead className="text-[7px] uppercase text-slate-600 sticky top-0 bg-[#080c12]"><tr>{['#','Símbolo','Side','TF','Score','Conf.','WR',crypto?'Regla':'Setup'].map((h) => <th key={h} className="px-3 py-2">{h}</th>)}</tr></thead><tbody>{rows.map((r: any, i: number) => <tr key={r.id || i} className="border-t border-slate-900 text-[9px]"><td className="px-3 py-2 text-slate-600">{i+1}</td><td className="px-3 py-2 font-black text-white">{r.symbol}</td><td className={`px-3 py-2 ${r.side === 'BUY' ? 'text-emerald-400' : 'text-rose-400'}`}>{r.side}</td><td className="px-3 py-2">{r.timeframe}</td><td className="px-3 py-2 text-indigo-300 font-black">{Number(r.score || 0).toFixed(1)}</td><td className="px-3 py-2">{pct(r.confidence)}</td><td className="px-3 py-2">{pct(r.rollingWinRate)}</td><td className="px-3 py-2 text-slate-600">{crypto ? 'Símbolo único' : r.strategy}</td></tr>)}</tbody></table></div>; }
function HistoryTable({ trades }: any) { if (!trades.length) return <Empty text="Aún no hay historial" />; return <div className="overflow-auto max-h-[290px]"><table className="w-full min-w-[680px] text-left"><thead className="text-[7px] uppercase text-slate-600 sticky top-0 bg-[#080c12]"><tr>{['Símbolo','Side','Estado','Entrada','Salida','PnL','Motivo'].map((h) => <th key={h} className="px-3 py-2">{h}</th>)}</tr></thead><tbody>{trades.map((t: any) => <tr key={t.id} className="border-t border-slate-900 text-[9px]"><td className="px-3 py-2 font-black text-white">{t.symbol}</td><td className={`px-3 py-2 ${t.side === 'BUY' ? 'text-emerald-400' : 'text-rose-400'}`}>{t.side}</td><td className="px-3 py-2 text-slate-500">{t.state}</td><td className="px-3 py-2">{price(t.entryPrice)}</td><td className="px-3 py-2">{price(t.exitPrice)}</td><td className={`px-3 py-2 font-black ${(t.realizedPnl || 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{money(t.realizedPnl)}</td><td className="px-3 py-2 text-slate-600">{t.closeReason || '—'}</td></tr>)}</tbody></table></div>; }

function money(value: any) { const n = Number(value || 0); return `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`; }
function pct(value: any) { return `${Number(value || 0).toFixed(1)}%`; }
function factor(value: any) { return value == null ? '∞' : Number(value || 0).toFixed(2); }
function price(value: any) { return value == null ? '—' : String(Number(Number(value).toFixed(8))); }
function todayIso() { return new Date().toISOString().slice(0, 10); }
function daysAgoIso(days: number) { return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10); }

export default App;
