import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { v34Api } from './services/v34Api';

type View = 'dashboard' | 'settings';
type IntegrationProvider = 'BINANCE' | 'TELEGRAM';

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
      throw e;
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
  const crypto = state.active?.crypto || [];
  const forex = state.active?.forex || [];
  const cryptoOpps = state.opportunities?.crypto || [];
  const forexOpps = state.opportunities?.forex || [];
  const globalMetrics = state.metrics?.global || emptyMetrics;
  const cryptoMetrics = state.metrics?.crypto || emptyMetrics;
  const forexMetrics = state.metrics?.forex || emptyMetrics;
  const binanceStatus = integration(state, 'BINANCE');
  const telegramStatus = integration(state, 'TELEGRAM');
  const mt5Status = state.brokerStatus?.mt5 || {};

  const recentCrypto = (state.recentTrades || []).filter((t: any) => t.broker === 'BINANCE').slice(0, 15);
  const recentForex = (state.recentTrades || []).filter((t: any) => t.broker === 'MT5').slice(0, 15);

  const patchSettings = (patch: Record<string, unknown>) =>
    run(() => v34Api.patchSettings(patch));

  const engineAction = (action: 'start' | 'pause' | 'stop') => run(async () => {
    if (action === 'start') return v34Api.startEngine();
    if (action === 'pause') return v34Api.pauseEngine();
    return v34Api.emergencyStop();
  });

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
                  <Status label="MT5" configured={Boolean(mt5Status.configured)} ok={settings.appMode === 'PAPER' || Boolean(mt5Status.connected)} />
                  <Status label="TELEGRAM" configured={telegramStatus.configured} ok={telegramStatus.lastTestOk === true} />
                  <span>WORKSPACE: {state.workspaceId || 'default'}</span>
                  <span>DB: PERSISTENT</span>
                  <span>SYNC: {lastSync ? new Date(lastSync).toLocaleTimeString() : '—'}</span>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <NavButton active={view === 'dashboard'} onClick={() => setView('dashboard')}>Dashboard</NavButton>
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
                className="px-5 py-3 rounded-xl text-[9px] font-black uppercase bg-rose-700 text-white border border-rose-500/50"
              >
                Emergency Stop
              </button>
            </div>
          </div>

          {error && <Banner tone="error">{error}</Banner>}
          {notice && <Banner tone="success">{notice}</Banner>}
        </header>

        {view === 'dashboard' ? (
          <Dashboard
            state={state}
            settings={settings}
            crypto={crypto}
            forex={forex}
            cryptoOpps={cryptoOpps}
            forexOpps={forexOpps}
            recentCrypto={recentCrypto}
            recentForex={recentForex}
            globalMetrics={globalMetrics}
            cryptoMetrics={cryptoMetrics}
            forexMetrics={forexMetrics}
            mt5Status={mt5Status}
            patchSettings={patchSettings}
          />
        ) : (
          <SettingsView
            state={state}
            settings={settings}
            binance={binanceStatus}
            telegram={telegramStatus}
            busy={busy}
            run={run}
            patchSettings={patchSettings}
          />
        )}
      </div>
    </div>
  );
};

function Dashboard(props: any) {
  const {
    state, settings, crypto, forex, cryptoOpps, forexOpps,
    recentCrypto, recentForex, globalMetrics, cryptoMetrics, forexMetrics,
    mt5Status, patchSettings,
  } = props;

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

      <section className="grid grid-cols-1 xl:grid-cols-2 gap-4 mt-4">
        <MarketPanel title="CRYPTO · BINANCE FUTURES" accent="indigo" subtitle="Hasta 10 coins simultáneas · nunca se repite símbolo">
          <ScannerLine scanner={state.scanners?.crypto} />
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
            <NumberSetting label="Slots Crypto" value={settings.maxConcurrentCryptoTrades} min={1} max={10} step={1} suffix="/10" onSave={(v) => patchSettings({ maxConcurrentCryptoTrades: v })} />
            <NumberSetting label="Margen / trade" value={settings.cryptoMarginPctPerTrade} min={0.01} max={100} step={0.1} suffix="%" onSave={(v) => patchSettings({ cryptoMarginPctPerTrade: v })} />
            <NumberSetting label="Leverage" value={settings.cryptoRequestedLeverage} min={1} max={125} step={1} suffix="x" onSave={(v) => patchSettings({ cryptoRequestedLeverage: v })} />
            <NumberSetting label="Exposición máx." value={settings.cryptoMaxAccountExposurePct} min={1} max={100} step={1} suffix="%" onSave={(v) => patchSettings({ cryptoMaxAccountExposurePct: v })} />
            <NumberSetting label="Pérdida máx. SL" value={settings.cryptoMaxLossPctPerTrade} min={0.01} max={100} step={0.1} suffix="%" onSave={(v) => patchSettings({ cryptoMaxLossPctPerTrade: v })} />
            <NumberSetting label="Confianza mín." value={settings.cryptoMinSignalConfidence} min={0} max={100} step={1} suffix="%" onSave={(v) => patchSettings({ cryptoMinSignalConfidence: v })} />
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

        <MarketPanel title="FOREX · METATRADER 5" accent="cyan" subtitle="Retests permitidos · cada entrada conserva su ticket">
          <ScannerLine scanner={state.scanners?.forex} />
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
            <NumberSetting label="Máx. tickets" value={settings.maxConcurrentForexTrades} min={1} max={200} step={1} onSave={(v) => patchSettings({ maxConcurrentForexTrades: v })} />
            <NumberSetting label="% por trade" value={settings.forexPctPerTrade} min={0.01} max={100} step={0.1} suffix="%" onSave={(v) => patchSettings({ forexPctPerTrade: v })} />
            <SelectSetting label="Sizing" value={settings.forexRiskMode} options={[['RISK_TO_SL', 'Riesgo hasta SL'], ['MARGIN_PERCENT', '% de margen']]} onSave={(v) => patchSettings({ forexRiskMode: v })} />
            <NumberSetting label="Entradas / par" value={settings.forexMaxEntriesPerSymbol} min={0} max={50} step={1} suffix={settings.forexMaxEntriesPerSymbol === 0 ? '∞' : ''} onSave={(v) => patchSettings({ forexMaxEntriesPerSymbol: v })} />
            <NumberSetting label="Confianza mín." value={settings.forexMinSignalConfidence} min={0} max={100} step={1} suffix="%" onSave={(v) => patchSettings({ forexMinSignalConfidence: v })} />
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

function SettingsView({ state, settings, binance, telegram, busy, run, patchSettings }: any) {
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [botToken, setBotToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [showBinanceSecret, setShowBinanceSecret] = useState(false);
  const [showTelegramToken, setShowTelegramToken] = useState(false);
  const [forexSymbols, setForexSymbols] = useState((settings.forexSymbols || []).join(', '));

  useEffect(() => setForexSymbols((settings.forexSymbols || []).join(', ')), [settings.forexSymbols]);

  const saveBinance = async () => {
    if (!apiKey.trim() || !apiSecret.trim()) throw new Error('Captura API Key y API Secret de Binance.');
    await run(
      () => v34Api.saveBinanceIntegration(apiKey.trim(), apiSecret.trim()),
      'Binance guardado y validado.',
    );
    setApiKey('');
    setApiSecret('');
  };

  const saveTelegram = async () => {
    if (!botToken.trim() || !chatId.trim()) throw new Error('Captura Bot Token y Chat ID de Telegram.');
    await run(
      () => v34Api.saveTelegramIntegration(botToken.trim(), chatId.trim()),
      'Telegram guardado; se envió un mensaje de prueba.',
    );
    setBotToken('');
    setChatId('');
  };

  const saveForexSymbols = async () => {
    const symbols = forexSymbols.split(',').map((s) => s.trim()).filter(Boolean);
    if (!symbols.length) throw new Error('Agrega al menos un símbolo Forex.');
    await patchSettings({ forexSymbols: symbols });
  };

  return (
    <div className="space-y-4">
      <section className="bg-gradient-to-br from-indigo-950/35 to-[#0d1117] border border-indigo-900/40 rounded-3xl p-5 md:p-7 shadow-2xl">
        <div className="flex flex-col lg:flex-row justify-between gap-5">
          <div>
            <p className="text-[8px] uppercase tracking-[0.25em] font-black text-indigo-400">Cuenta / Integraciones</p>
            <h2 className="text-2xl md:text-3xl font-black text-white tracking-tight mt-2">Conecta tus propias cuentas</h2>
            <p className="text-[10px] text-slate-400 leading-6 mt-3 max-w-4xl">
              Las credenciales se cifran en el backend con AES-256-GCM. El navegador nunca recibe nuevamente el API Secret ni el Bot Token. Esta separación deja preparada la plataforma para que cada membresía tenga conexiones independientes.
            </p>
          </div>
          <div className="bg-black/30 border border-slate-800 rounded-2xl px-5 py-4 min-w-[230px]">
            <p className="text-[7px] uppercase tracking-widest text-slate-600 font-black">Workspace interno</p>
            <p className="text-sm font-black text-white mt-2">{state.workspaceId || 'default'}</p>
            <p className="text-[8px] text-slate-600 mt-2">En membresías será el ID del usuario autenticado.</p>
          </div>
        </div>
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <IntegrationCard
          title="BINANCE FUTURES"
          icon="₿"
          status={binance}
          description="API exclusiva para consultar saldo, posiciones y ejecutar USDⓈ-M Futures."
        >
          <SecretField label="API Key" value={apiKey} onChange={setApiKey} placeholder={binance.configured ? 'Introduce una nueva API Key para reemplazarla' : 'API Key de Binance'} type="text" />
          <SecretField label="API Secret" value={apiSecret} onChange={setApiSecret} placeholder="API Secret" type={showBinanceSecret ? 'text' : 'password'} toggle={() => setShowBinanceSecret((v) => !v)} />
          <SecurityHint>Recomendado: Futures habilitado, retiros deshabilitados e IP whitelist cuando tengas servidor con IP fija.</SecurityHint>
          <div className="flex flex-wrap gap-2 pt-2">
            <PrimaryButton disabled={busy} onClick={() => void saveBinance()}>Guardar y conectar</PrimaryButton>
            {binance.configured && <SecondaryButton disabled={busy} onClick={() => void run(() => v34Api.testIntegration('binance'), 'Conexión Binance validada.')}>Probar conexión</SecondaryButton>}
            {binance.configured && <DangerButton disabled={busy} onClick={() => void run(() => v34Api.removeIntegration('binance'), 'Binance desconectado.')}>Desconectar</DangerButton>}
          </div>
        </IntegrationCard>

        <IntegrationCard
          title="TELEGRAM"
          icon="✈"
          status={telegram}
          description="Bot privado para avisos de apertura, cierre, PnL, errores y kill-switch."
        >
          <SecretField label="Bot Token" value={botToken} onChange={setBotToken} placeholder={telegram.configured ? 'Introduce un nuevo token para reemplazarlo' : 'Token de @BotFather'} type={showTelegramToken ? 'text' : 'password'} toggle={() => setShowTelegramToken((v) => !v)} />
          <SecretField label="Chat ID / Canal" value={chatId} onChange={setChatId} placeholder="Ej. -1001234567890" type="text" />
          <SecurityHint>Al guardar se valida el bot y se envía automáticamente un mensaje de prueba al Chat ID.</SecurityHint>
          <div className="flex flex-wrap gap-2 pt-2">
            <PrimaryButton disabled={busy} onClick={() => void saveTelegram()}>Guardar y conectar</PrimaryButton>
            {telegram.configured && <SecondaryButton disabled={busy} onClick={() => void run(() => v34Api.testIntegration('telegram'), 'Telegram validado; mensaje de prueba enviado.')}>Probar conexión</SecondaryButton>}
            {telegram.configured && <DangerButton disabled={busy} onClick={() => void run(() => v34Api.removeIntegration('telegram'), 'Telegram desconectado.')}>Desconectar</DangerButton>}
          </div>
        </IntegrationCard>
      </section>

      <section className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Panel title="CONFIGURACIÓN DE RIESGO GLOBAL">
          <div className="grid grid-cols-2 gap-2">
            <NumberSetting label="Pérdida diaria máx." value={settings.dailyLossLimitPct} min={0.1} max={100} step={0.1} suffix="%" onSave={(v) => patchSettings({ dailyLossLimitPct: v })} />
            <NumberSetting label="Drawdown máximo" value={settings.maxDrawdownPct} min={0.1} max={100} step={0.1} suffix="%" onSave={(v) => patchSettings({ maxDrawdownPct: v })} />
          </div>
          <label className="flex items-center justify-between mt-3 bg-black/30 border border-slate-800 rounded-2xl p-4">
            <div>
              <p className="text-[9px] font-black text-white uppercase">Risk Kill-Switch</p>
              <p className="text-[8px] text-slate-600 mt-1">Pausa nuevas entradas al alcanzar límites.</p>
            </div>
            <input type="checkbox" checked={Boolean(settings.riskKillSwitchEnabled)} onChange={(e) => void patchSettings({ riskKillSwitchEnabled: e.target.checked })} />
          </label>
        </Panel>

        <Panel title="UNIVERSO FOREX MT5">
          <p className="text-[8px] text-slate-500 leading-5 mb-3">Lista separada por comas. El scanner usa los símbolos exactos publicados por tu broker.</p>
          <textarea
            value={forexSymbols}
            onChange={(e) => setForexSymbols(e.target.value)}
            className="w-full min-h-28 bg-[#05080d] border border-slate-700 rounded-2xl p-4 text-[10px] text-white outline-none focus:border-cyan-600"
          />
          <div className="mt-3"><PrimaryButton disabled={busy} onClick={() => void saveForexSymbols()}>Guardar pares Forex</PrimaryButton></div>
        </Panel>
      </section>

      <section className="bg-[#0d1117] border border-slate-800 rounded-3xl p-5 md:p-7">
        <h3 className="text-sm font-black text-white uppercase tracking-widest">Preparado para membresías</h3>
        <div className="grid md:grid-cols-4 gap-3 mt-4">
          <ArchitectureStep n="1" title="Usuario" text="Login y plan de membresía." />
          <ArchitectureStep n="2" title="Workspace" text="Configuración y secretos aislados." />
          <ArchitectureStep n="3" title="Trading Engine" text="Instancia lógica por usuario." />
          <ArchitectureStep n="4" title="Brokers" text="Binance, MT5 y Telegram propios." />
        </div>
      </section>
    </div>
  );
}

function integration(state: any, provider: IntegrationProvider) {
  const found = (state.integrations || []).find((item: any) => item.provider === provider);
  return found || { provider, configured: false };
}

const emptyMetrics = { trades: 0, wins: 0, losses: 0, winRate: 0, netProfit: 0, profitFactor: 0, openTrades: 0, fees: 0 };

function Status({ label, configured, ok }: { label: string; configured?: boolean; ok?: boolean }) {
  return <span className="flex items-center gap-1.5"><i className={`w-1.5 h-1.5 rounded-full ${ok ? 'bg-emerald-500' : configured ? 'bg-amber-500' : 'bg-rose-500'}`} />{label}</span>;
}

function NavButton({ active, onClick, children }: any) {
  return <button onClick={onClick} className={`px-4 py-3 rounded-xl text-[9px] font-black uppercase border ${active ? 'bg-indigo-600 border-indigo-500 text-white' : 'bg-black/30 border-slate-800 text-slate-400'}`}>{children}</button>;
}

function Banner({ tone, children }: any) {
  return <div className={`mt-4 rounded-xl px-4 py-3 text-[10px] border ${tone === 'error' ? 'bg-rose-500/10 border-rose-500/30 text-rose-300' : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'}`}>{children}</div>;
}

function Metric({ title, value, tone }: any) {
  return <div className="bg-[#0d1117] border border-slate-800 rounded-2xl p-4 shadow-xl"><p className="text-[7px] uppercase tracking-[0.2em] text-slate-500 font-black">{title}</p><p className={`text-xl mt-2 font-black ${tone === 'green' ? 'text-emerald-400' : tone === 'red' ? 'text-rose-400' : 'text-white'}`}>{value}</p></div>;
}

function MarketPanel({ title, subtitle, accent, children }: any) {
  return <section className={`bg-[#0d1117] border ${accent === 'cyan' ? 'border-cyan-950' : 'border-indigo-950'} rounded-[2rem] p-4 md:p-6 shadow-2xl space-y-4`}><div><h2 className={`text-lg md:text-xl font-black italic ${accent === 'cyan' ? 'text-cyan-400' : 'text-indigo-400'}`}>{title}</h2><p className="text-[8px] text-slate-500 uppercase tracking-widest mt-1">{subtitle}</p></div>{children}</section>;
}

function ScannerLine({ scanner }: any) {
  if (!scanner) return <div className="bg-black/20 border border-slate-800 rounded-xl px-3 py-2 text-[8px] text-slate-600">Scanner inicializando…</div>;
  return <div className="flex flex-wrap gap-3 bg-black/20 border border-slate-800 rounded-xl px-3 py-2 text-[8px] uppercase text-slate-500"><span className="text-indigo-400 font-black">{scanner.status || '—'}</span><span>{scanner.current || '—'}</span><span>{scanner.scanned || 0}/{scanner.total || 0}</span><span>Setups: {scanner.opportunities || 0}</span></div>;
}

function NumberSetting({ label, value, min, max, step, suffix = '', onSave }: any) {
  const [draft, setDraft] = useState(String(value ?? ''));
  useEffect(() => setDraft(String(value ?? '')), [value]);
  const save = () => { const n = Number(draft); if (Number.isFinite(n)) void onSave(n); };
  return <label className="bg-black/30 border border-slate-800 rounded-2xl p-3 block"><span className="text-[7px] text-slate-500 uppercase font-black tracking-widest">{label}</span><div className="flex items-center gap-2 mt-2"><input type="number" value={draft} min={min} max={max} step={step} onChange={(e) => setDraft(e.target.value)} onBlur={save} onKeyDown={(e) => e.key === 'Enter' && save()} className="w-full bg-[#05080d] border border-slate-700 rounded-xl px-3 py-2 text-sm font-black text-white outline-none" />{suffix && <span className="text-[8px] text-slate-500 font-black">{suffix}</span>}</div></label>;
}

function SelectSetting({ label, value, options, onSave }: any) {
  return <label className="bg-black/30 border border-slate-800 rounded-2xl p-3 block"><span className="text-[7px] text-slate-500 uppercase font-black tracking-widest">{label}</span><select value={value} onChange={(e) => void onSave(e.target.value)} className="w-full mt-2 bg-[#05080d] border border-slate-700 rounded-xl px-3 py-2 text-[9px] font-black text-white">{options.map(([v, t]: string[]) => <option key={v} value={v}>{t}</option>)}</select></label>;
}

function InfoBox({ label, value }: any) {
  return <div className="bg-black/30 border border-slate-800 rounded-2xl p-3"><p className="text-[7px] text-slate-500 uppercase font-black tracking-widest">{label}</p><p className="text-sm text-emerald-400 font-black mt-2">{value}</p></div>;
}

function Stats({ items }: { items: Array<[string, string]> }) {
  return <div className="grid grid-cols-2 md:grid-cols-4 gap-2">{items.map(([l, v]) => <div key={l} className="bg-black/30 border border-slate-800 rounded-2xl p-3"><p className="text-[7px] uppercase text-slate-600 font-black">{l}</p><p className="text-base font-black text-white mt-1">{v}</p></div>)}</div>;
}

function Block({ title, children }: any) {
  return <div className="bg-black/20 border border-slate-800 rounded-2xl overflow-hidden"><div className="px-4 py-3 border-b border-slate-800"><h3 className="text-[8px] font-black tracking-[0.18em] uppercase text-slate-400">{title}</h3></div>{children}</div>;
}

function PositionTable({ trades, crypto = false }: any) {
  if (!trades.length) return <Empty text="Sin posiciones abiertas" />;
  return <div className="overflow-x-auto"><table className="w-full min-w-[680px] text-left"><thead className="text-[7px] uppercase text-slate-600"><tr>{['Símbolo','Side',crypto?'Lev/Margen':'Ticket/Lote','Entry','SL','TP','PnL','Estado'].map((h) => <th key={h} className="px-3 py-2">{h}</th>)}</tr></thead><tbody>{trades.map((t: any) => <tr key={t.id} className="border-t border-slate-900 text-[9px]"><td className="px-3 py-3 font-black text-white">{t.symbol}</td><td className={`px-3 py-3 font-black ${t.side === 'BUY' ? 'text-emerald-400' : 'text-rose-400'}`}>{t.side}</td><td className="px-3 py-3">{crypto ? `${t.leverage ?? '-'}x · ${money(t.marginUsed)}` : `${t.brokerOrderId ?? '-'} · ${t.lotSize ?? '-'}`}</td><td className="px-3 py-3">{price(t.entryPrice)}</td><td className="px-3 py-3 text-rose-300">{price(t.stopLoss)}</td><td className="px-3 py-3 text-emerald-300">{price(t.takeProfit)}</td><td className={`px-3 py-3 font-black ${(t.unrealizedPnl || 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{money(t.unrealizedPnl)}</td><td className="px-3 py-3 text-slate-500">{t.state}</td></tr>)}</tbody></table></div>;
}

function OpportunityTable({ rows, crypto = false }: any) {
  if (!rows.length) return <Empty text="Esperando oportunidades" />;
  return <div className="overflow-auto max-h-[280px]"><table className="w-full min-w-[620px] text-left"><thead className="text-[7px] uppercase text-slate-600 sticky top-0 bg-[#080c12]"><tr>{['#','Símbolo','Side','TF','Score','Conf.','WR',crypto?'Regla':'Setup'].map((h) => <th key={h} className="px-3 py-2">{h}</th>)}</tr></thead><tbody>{rows.map((r: any, i: number) => <tr key={r.id || i} className="border-t border-slate-900 text-[9px]"><td className="px-3 py-2 text-slate-600">{i+1}</td><td className="px-3 py-2 font-black text-white">{r.symbol}</td><td className={`px-3 py-2 ${r.side === 'BUY' ? 'text-emerald-400' : 'text-rose-400'}`}>{r.side}</td><td className="px-3 py-2">{r.timeframe}</td><td className="px-3 py-2 text-indigo-300 font-black">{Number(r.score || 0).toFixed(1)}</td><td className="px-3 py-2">{pct(r.confidence)}</td><td className="px-3 py-2">{pct(r.rollingWinRate)}</td><td className="px-3 py-2 text-slate-600">{crypto ? 'Símbolo único' : r.strategy}</td></tr>)}</tbody></table></div>;
}

function HistoryTable({ trades }: any) {
  if (!trades.length) return <Empty text="Aún no hay historial" />;
  return <div className="overflow-auto max-h-[290px]"><table className="w-full min-w-[680px] text-left"><thead className="text-[7px] uppercase text-slate-600 sticky top-0 bg-[#080c12]"><tr>{['Símbolo','Side','Estado','Entrada','Salida','PnL','Motivo'].map((h) => <th key={h} className="px-3 py-2">{h}</th>)}</tr></thead><tbody>{trades.map((t: any) => <tr key={t.id} className="border-t border-slate-900 text-[9px]"><td className="px-3 py-2 font-black text-white">{t.symbol}</td><td className={`px-3 py-2 ${t.side === 'BUY' ? 'text-emerald-400' : 'text-rose-400'}`}>{t.side}</td><td className="px-3 py-2 text-slate-500">{t.state}</td><td className="px-3 py-2">{price(t.entryPrice)}</td><td className="px-3 py-2">{price(t.exitPrice)}</td><td className={`px-3 py-2 font-black ${(t.realizedPnl || 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{money(t.realizedPnl)}</td><td className="px-3 py-2 text-slate-600">{t.closeReason || '—'}</td></tr>)}</tbody></table></div>;
}

function IntegrationCard({ title, icon, status, description, children }: any) {
  const ok = status.lastTestOk === true;
  return <section className="bg-[#0d1117] border border-slate-800 rounded-3xl p-5 md:p-6 shadow-2xl"><div className="flex items-start justify-between gap-4"><div className="flex gap-4"><div className="w-12 h-12 rounded-2xl bg-black/40 border border-slate-800 grid place-items-center text-xl">{icon}</div><div><h3 className="text-lg font-black text-white">{title}</h3><p className="text-[9px] text-slate-500 mt-1 leading-5">{description}</p></div></div><span className={`text-[8px] uppercase font-black px-3 py-2 rounded-xl border ${ok ? 'text-emerald-300 bg-emerald-500/10 border-emerald-500/20' : status.configured ? 'text-amber-300 bg-amber-500/10 border-amber-500/20' : 'text-slate-500 bg-black/30 border-slate-800'}`}>{ok ? 'Conectado' : status.configured ? 'Revisar' : 'No configurado'}</span></div>{status.configured && <div className="grid grid-cols-2 gap-2 mt-4"><InfoBox label="Guardado" value={status.maskedPrimary || '••••'} /><InfoBox label="Secundario" value={status.maskedSecondary || '••••'} /></div>}{status.lastError && <div className="mt-3 bg-rose-500/10 border border-rose-500/20 text-rose-300 rounded-xl p-3 text-[8px] break-all">{status.lastError}</div>}<div className="space-y-3 mt-5">{children}</div></section>;
}

function SecretField({ label, value, onChange, placeholder, type, toggle }: any) {
  return <label className="block"><span className="text-[8px] uppercase tracking-widest font-black text-slate-500">{label}</span><div className="flex gap-2 mt-2"><input type={type} value={value} onChange={(e) => onChange(e.target.value)} autoComplete="off" placeholder={placeholder} className="w-full bg-[#05080d] border border-slate-700 rounded-xl px-4 py-3 text-[10px] text-white outline-none focus:border-indigo-500" />{toggle && <button type="button" onClick={toggle} className="px-3 rounded-xl bg-black/30 border border-slate-800 text-[8px] text-slate-400">VER</button>}</div></label>;
}

function SecurityHint({ children }: any) { return <div className="rounded-xl bg-amber-500/5 border border-amber-500/15 text-amber-200/70 p-3 text-[8px] leading-5">🔐 {children}</div>; }
function PrimaryButton({ children, ...props }: any) { return <button {...props} className="px-4 py-3 rounded-xl bg-indigo-600 text-white text-[8px] font-black uppercase disabled:opacity-40">{children}</button>; }
function SecondaryButton({ children, ...props }: any) { return <button {...props} className="px-4 py-3 rounded-xl bg-black/40 border border-slate-700 text-slate-300 text-[8px] font-black uppercase disabled:opacity-40">{children}</button>; }
function DangerButton({ children, ...props }: any) { return <button {...props} className="px-4 py-3 rounded-xl bg-rose-950/40 border border-rose-900 text-rose-300 text-[8px] font-black uppercase disabled:opacity-40">{children}</button>; }
function Panel({ title, children }: any) { return <section className="bg-[#0d1117] border border-slate-800 rounded-3xl p-5 md:p-6"><h3 className="text-[10px] font-black tracking-widest text-white">{title}</h3><div className="mt-4">{children}</div></section>; }
function ArchitectureStep({ n, title, text }: any) { return <div className="bg-black/25 border border-slate-800 rounded-2xl p-4"><div className="w-7 h-7 rounded-lg bg-indigo-600 grid place-items-center text-[9px] font-black">{n}</div><p className="text-[9px] font-black text-white mt-3 uppercase">{title}</p><p className="text-[8px] text-slate-600 mt-1 leading-4">{text}</p></div>; }
function Empty({ text }: any) { return <div className="py-8 text-center text-[8px] uppercase tracking-widest text-slate-700">{text}</div>; }

function money(value: any) { const n = Number(value || 0); return `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`; }
function pct(value: any) { return `${Number(value || 0).toFixed(1)}%`; }
function price(value: any) { return value == null ? '—' : String(Number(Number(value).toFixed(8))); }
function factor(value: any) { return value == null ? '∞' : Number(value || 0).toFixed(2); }

export default App;
