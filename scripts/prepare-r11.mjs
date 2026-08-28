import fs from 'node:fs';

const sourcePath = new URL('../AppR8.tsx', import.meta.url);
const targetPath = new URL('../AppR11.tsx', import.meta.url);
let src = fs.readFileSync(sourcePath, 'utf8');

src = src
  .replace(
    "import { v34Api } from './services/v34Api';\n",
    "import { v34Api } from './services/v34Api';\nimport { AutoScanBadgeR11, PerformanceChartR11, buildCryptoCurveR11, buildForexCurveR11 } from './components/PerformanceChartR11';\n",
  )
  .replace("const BUILD = 'R8';", "const BUILD = 'R11';")
  .replace(/V34 <span className="text-cyan-400">R8<\/span>/g, 'V34 <span className="text-cyan-400">R11</span>')
  .replace(/Build R8/g, 'Build R11')
  .replace('grid grid-cols-1 2xl:grid-cols-2 gap-4 items-start', 'grid grid-cols-1 lg:grid-cols-2 gap-4 items-start')
  .replace('V33.5 estructural · ejecución automática · izquierda', 'R11 CALIBRADO · sweep/reclaim + MSS + retest LIMIT · M5/M15 · AUTO')
  .replace('FOREX / METALS / INDICES · SIGNAL DESK', 'FOREX + XAUUSD · R11 SIGNAL DESK')
  .replace('FOREX / METALS / INDICES', 'FOREX + XAUUSD')
  .replace('señales manuales · derecha · sin ejecución automática', 'R11 calibrado por par · LIMIT manual · M5/M15 · scanner AUTO')
  .replace(' XAUUSD se consulta como XAU/USD. NAS100 se resuelve contra el catálogo de Twelve Data; si el plan no lo permite, solo ese instrumento queda marcado con error.', ' XAUUSD se consulta como XAU/USD. NAS100 fue retirado del universo Forex. R11 calibra cada instrumento por separado y rechaza los que no tienen modelo positivo.')
  .replace('R8 no usa el piso artificial 1%/1.5% de R7. SL y TP vuelven a ser estructura/fractal/ATR + 1.35R/2.2R/3.5R. El leverage se refleja en margen, PnL y ROE.', 'R11 calibra cada símbolo por separado. Busca sweep/reclaim + MSS en M5, exige sesgo M5/M15 alineado y espera un retest LIMIT hasta 3 velas M5. El RR TP1 se calibra entre 0.45R y 0.75R; M1 no participa.')
  .replace("scanStepMinutes:3, maxHoldMinutes:90", "scanStepMinutes:5, maxHoldMinutes:45")
  .replace('value="ESTRUCTURA V33.5"', 'value="R11 CALIBRADO"');

src = src.replace(
  "  const forexData = state.brokerStatus?.forexData || {};\n",
  "  const forexData = state.brokerStatus?.forexData || {};\n  const cryptoCurve = settings.appMode === 'PAPER' && Array.isArray(paper.equityCurve) && paper.equityCurve.length ? paper.equityCurve.map((p:any)=>({ time:Number(p.time||p.at||0), value:Number(p.equity||0) })).filter((p:any)=>p.time>0) : buildCryptoCurveR11(cryptoHistory);\n  const forexCurve = buildForexCurveR11(forexPerformance.recent || []);\n",
);

src = src.replace(
  '        <ScannerCard scanner={cryptoScanner} kind="crypto" />',
  '        <ScannerCard scanner={cryptoScanner} kind="crypto" />\n        <PerformanceChartR11 title="GANANCIA CRYPTO · OPERACIONES CERRADAS" points={cryptoCurve} unit="$" />\n        <AutoScanBadgeR11 scanner={cryptoScanner} fallbackSeconds={15} />',
);
src = src.replace(
  '        <ScannerCard scanner={forexScanner} kind="forex" />',
  '        <ScannerCard scanner={forexScanner} kind="forex" />\n        <PerformanceChartR11 title="GANANCIA FOREX · RETORNO DE SEÑALES FILLED" points={forexCurve} unit="%" />\n        <AutoScanBadgeR11 scanner={forexScanner} fallbackMinutes={forexScanner.effectiveIntervalMinutes || settings.forexSignalScanIntervalMinutes || 5} />',
);

src = src.replace(
  '<MiniMetric label="Abiertas" value={String(forexPerformance.open || 0)} />',
  '<MiniMetric label="Pendientes LIMIT" value={String(forexPerformance.pending || 0)} /><MiniMetric label="Filled abiertas" value={String(forexPerformance.filledOpen || 0)} />',
);

src = src.replace(
  '<InfoBox label="Modelo SL/TP" value="R11 CALIBRADO" />',
  '<InfoBox label="Modelo" value="R11 · RETEST LIMIT" />',
);

src = src.replace(
  '<InfoBox label="Créditos restantes" value={String(forexScanner.usage?.creditsLeft ?? forexData.usage?.creditsLeft ?? \'—\')} />',
  '<InfoBox label="Créditos restantes" value={String(forexScanner.usage?.creditsLeft ?? forexData.usage?.creditsLeft ?? \'—\')} /><InfoBox label="Modelos R11 listos" value={String(forexScanner.modelsReady ?? 0)} /><InfoBox label="Modelos rechazados" value={String(forexScanner.modelsRejected ?? 0)} />',
);

src = src.replace(/\n\s*<div className="flex flex-wrap gap-2">\s*<SecondaryButton disabled=\{busy \|\| !settings\.engineEnabled\} onClick=\{\(\) => run\(\(\) => v34Api\.runCryptoScanner\(\), 'Scanner Crypto ejecutado\.'\)\}>Escanear Crypto ahora<\/SecondaryButton>\s*<\/div>/, '');

src = src.replace(
  '<SecondaryButton disabled={busy || !forexData.configured} onClick={() => run(() => v34Api.runForexScanner(), \'Scanner Forex ejecutado.\')}>Escanear Forex ahora</SecondaryButton>',
  '<SecondaryButton disabled={busy || !forexData.configured} onClick={() => run(() => v34Api.runForexScanner(), \'Diagnóstico Forex R11 ejecutado.\')}>Diagnóstico / escaneo ahora</SecondaryButton>',
);

src = src.replace(
  '<div className="flex flex-wrap gap-2 mt-3"><PrimaryButton disabled={busy} onClick={() => void saveSymbols()}>Guardar instrumentos</PrimaryButton><SecondaryButton disabled={busy || !forex.configured} onClick={() => run(() => v34Api.runForexScanner(), \'Forex escaneado.\')}>Escanear ahora</SecondaryButton></div>',
  '<div className="flex flex-wrap gap-2 mt-3"><PrimaryButton disabled={busy} onClick={() => void saveSymbols()}>Guardar instrumentos</PrimaryButton><SecondaryButton disabled={busy || !forex.configured} onClick={() => run(() => v34Api.runForexScanner(), \'Diagnóstico Forex R11 ejecutado.\')}>Probar R11 ahora</SecondaryButton></div>',
);

src = src.replace(
`      {kind === 'crypto' && (\n        <div className="grid grid-cols-4 gap-2 text-center">\n          <Tiny label="Detectadas" value={scanner.opportunities || 0} />\n          <Tiny label="Revalidadas" value={scanner.revalidated || 0} />\n          <Tiny label="Seleccionadas" value={scanner.selected || 0} />\n          <Tiny label="Ejecutadas" value={scanner.executed || 0} />\n        </div>\n      )}`,
`      {kind === 'crypto' && (\n        <div className="grid grid-cols-4 gap-2 text-center">\n          <Tiny label="Retest tocado" value={scanner.opportunities || 0} />\n          <Tiny label="Modelos aptos" value={scanner.qualifiedUniverse || 0} />\n          <Tiny label="Seleccionadas" value={scanner.selected || 0} />\n          <Tiny label="Ejecutadas" value={scanner.executed || 0} />\n        </div>\n      )}`,
);

src = src.replace(
`      {kind === 'forex' && (\n        <div className="grid grid-cols-4 gap-2 text-center">\n          <Tiny label="Escaneadas" value={scanner.scanned || 0} />\n          <Tiny label="Setups" value={scanner.signals || 0} />\n          <Tiny label="Calificadas" value={scanner.qualified || 0} />\n          <Tiny label="Errores" value={scanner.errors || 0} />\n        </div>\n      )}`,
`      {kind === 'forex' && (\n        <div className="grid grid-cols-3 md:grid-cols-6 gap-2 text-center">\n          <Tiny label="Escaneadas" value={scanner.scanned || 0} />\n          <Tiny label="Setups LIMIT" value={scanner.signals || 0} />\n          <Tiny label="Enviadas" value={scanner.sent || 0} />\n          <Tiny label="Modelos OK" value={scanner.modelsReady || 0} />\n          <Tiny label="Modelos NO" value={scanner.modelsRejected || 0} />\n          <Tiny label="Errores" value={scanner.errors || 0} />\n        </div>\n      )}`,
);

src = src.replace(
  '<th className="p-3 text-left">Instrumento</th><th>Side</th><th>Entry</th><th>SL</th><th>TP1</th><th>TP2</th><th>TP3</th><th>Conf.</th><th>WR</th>',
  '<th className="p-3 text-left">Instrumento</th><th>Orden</th><th>Side</th><th>Entry LIMIT</th><th>SL</th><th>TP1</th><th>TP2</th><th>TP3</th><th>Conf.</th><th>WR OOS</th>',
);
src = src.replace(
  '<td className="p-3 text-white font-black">{r.symbol}</td><td className={`text-center font-black ${r.side === \'BUY\' ? \'text-emerald-400\' : \'text-rose-400\'}`}>{r.side}</td><td className="text-center">{price(r.entry)}</td>',
  '<td className="p-3 text-white font-black">{r.symbol}</td><td className="text-center text-cyan-300 font-black">{r.metadata?.orderType || \'LIMIT\'}</td><td className={`text-center font-black ${r.side === \'BUY\' ? \'text-emerald-400\' : \'text-rose-400\'}`}>{r.side}</td><td className="text-center">{price(r.entry)}</td>',
);

const backtestFn = /function BacktestResult\(\{ result \}: any\) \{[^\n]*\}/;
const backtestReplacement = `function BacktestResult({ result }: any) {\n  const m=result.metrics||{}, first=result.inSample||{}, final=result.outOfSample||{};\n  const audits=result.modelAudit||[];\n  return <div className="space-y-4">\n    <div className="rounded-2xl border border-cyan-500/25 bg-cyan-500/5 p-4 text-[9px] leading-5 text-cyan-100/80"><b>R11 OOS REAL:</b> los 21 días anteriores al rango seleccionado se usan para calibrar. Tus fechas seleccionadas quedan 100% fuera de la selección del modelo. Costos incluidos.</div>\n    <div className="grid grid-cols-2 md:grid-cols-4 gap-2"><MiniMetric label="Net" value={money(m.netProfit)}/><MiniMetric label="Return" value={pct(m.returnPct)}/><MiniMetric label="WR OOS total" value={pct(m.winRate)}/><MiniMetric label="PF" value={factor(m.profitFactor)}/><MiniMetric label="Expect." value={money(m.expectancy)}/><MiniMetric label="Max DD" value={pct(m.maxDrawdownPct)}/><MiniMetric label="Costos" value={money(m.costs)}/><MiniMetric label="Trades" value={String(m.trades||0)}/></div>\n    <div className="grid grid-cols-1 md:grid-cols-2 gap-2"><div className="rounded-2xl border border-indigo-500/20 p-4 text-[9px]"><b>Primer 70% del rango OOS</b> · Profit {money(first.netProfit)} · WR {pct(first.winRate)} · PF {factor(first.profitFactor)} · Expectancy {money(first.expectancy)}</div><div className="rounded-2xl border border-cyan-500/20 p-4 text-[9px]"><b>30% final OOS</b> · Profit {money(final.netProfit)} · WR {pct(final.winRate)} · PF {factor(final.profitFactor)} · Expectancy {money(final.expectancy)}</div></div>\n    <R11ModelAudit rows={audits}/>\n    <PaperBySymbol rows={(result.bySymbol||[]).map((r:any)=>[r.symbol,r.metrics])}/>\n  </div>;\n}\nfunction R11ModelAudit({rows}:any){if(!rows.length)return <Empty text="Sin auditoría de modelos R11"/>;return <div className="overflow-x-auto"><table className="w-full min-w-[950px] text-[9px]"><thead className="text-slate-600 uppercase"><tr><th className="p-3 text-left">Símbolo</th><th>Modelo</th><th>Val WR</th><th>Hold WR</th><th>PF Val/Hold</th><th>RR</th><th>Entry ATR</th><th>Disp ATR</th></tr></thead><tbody>{rows.map((r:any)=><tr key={r.symbol} className="border-t border-slate-900"><td className="p-3 text-white font-black">{r.symbol}</td><td className={r.ready?'text-center font-black text-emerald-400':'text-center font-black text-rose-400'}>{r.ready?(r.fallback?'FALLBACK OOS':'STRICT OOS'):'RECHAZADO'}</td><td className="text-center">{r.validation?pct(r.validation.winRate):'—'}</td><td className="text-center">{r.holdout?pct(r.holdout.winRate):'—'}</td><td className="text-center">{r.validation?factor(r.validation.profitFactor):'—'} / {r.holdout?factor(r.holdout.profitFactor):'—'}</td><td className="text-center">{r.config?.rr??'—'}</td><td className="text-center">{r.config?.entryATR??'—'}</td><td className="text-center">{r.config?.dispATR??'—'}</td></tr>)}</tbody></table></div>;}`;
if (!backtestFn.test(src)) throw new Error('R11_BACKTEST_RESULT_NOT_FOUND');
src = src.replace(backtestFn, backtestReplacement);

src = src.replace(
  'const emptyForexPerformance={tracked:0,open:0,resolved:0,wins:0,losses:0,expired:0,winRate:0,netReturnPct:0,profitFactor:0,expectancyPct:0,bySymbol:[],recent:[]};',
  'const emptyForexPerformance={tracked:0,open:0,pending:0,filledOpen:0,resolved:0,wins:0,losses:0,expired:0,winRate:0,netReturnPct:0,profitFactor:0,expectancyPct:0,bySymbol:[],recent:[]};',
);

if (!src.includes("const BUILD = 'R11';")) throw new Error('R11_BUILD_REPLACEMENT_FAILED');
if (!src.includes('PerformanceChartR11 title=')) throw new Error('R11_PERIOD_CHART_INJECTION_FAILED');
if (!src.includes('R11 OOS REAL')) throw new Error('R11_BACKTEST_UI_FAILED');
if (!src.includes('NAS100 fue retirado')) throw new Error('R11_FOREX_UNIVERSE_TEXT_FAILED');

fs.writeFileSync(targetPath, src);
console.log('Generated AppR11.tsx');
