import fs from 'node:fs';

const sourcePath = new URL('../AppR8.tsx', import.meta.url);
const targetPath = new URL('../AppR10.tsx', import.meta.url);
let src = fs.readFileSync(sourcePath, 'utf8');

src = src
  .replace(
    "import { v34Api } from './services/v34Api';\n",
    "import { v34Api } from './services/v34Api';\nimport { AutoScanBadgeR10, PerformanceChartR10, buildCryptoCurveR10, buildForexCurveR10 } from './components/PerformanceChartR10';\n",
  )
  .replace("const BUILD = 'R8';", "const BUILD = 'R10';")
  .replace(/V34 <span className="text-cyan-400">R8<\/span>/g, 'V34 <span className="text-cyan-400">R10</span>')
  .replace(/Build R8/g, 'Build R10')
  .replace(/R8 no usa/g, 'R10 no usa/g')
  .replace('grid grid-cols-1 2xl:grid-cols-2 gap-4 items-start', 'grid grid-cols-1 lg:grid-cols-2 gap-4 items-start')
  .replace('V33.5 estructural · ejecución automática · izquierda', 'R10 HIGH-WR · sweep/reclaim + MSS · M5/M15 · AUTO')
  .replace('FOREX / METALS / INDICES · SIGNAL DESK', 'FOREX + XAUUSD · SIGNAL DESK')
  .replace('FOREX / METALS / INDICES', 'FOREX + XAUUSD')
  .replace('señales manuales · derecha · sin ejecución automática', 'R10 HIGH-WR · M5/M15 · señales manuales · scanner AUTO')
  .replace(' XAUUSD se consulta como XAU/USD. NAS100 se resuelve contra el catálogo de Twelve Data; si el plan no lo permite, solo ese instrumento queda marcado con error.', ' XAUUSD se consulta como XAU/USD. NAS100 fue retirado del universo Forex.')
  .replace('R10 no usa el piso artificial 1%/1.5% de R7. SL y TP vuelven a ser estructura/fractal/ATR + 1.35R/2.2R/3.5R. El leverage se refleja en margen, PnL y ROE.', 'R10 usa sweep/reclaim + MSS en M5, sesgo M15 y objetivos de alta probabilidad: TP1 0.60R, TP2 1.00R y TP3 1.50R. M1 no interviene en la entrada.')
  .replace("scanStepMinutes:3, maxHoldMinutes:90", "scanStepMinutes:5, maxHoldMinutes:45");

src = src.replace(
  "  const forexData = state.brokerStatus?.forexData || {};\n",
  "  const forexData = state.brokerStatus?.forexData || {};\n  const cryptoCurve = settings.appMode === 'PAPER' && Array.isArray(paper.equityCurve) && paper.equityCurve.length ? paper.equityCurve.map((p:any)=>({ time:Number(p.time||p.at||0), value:Number(p.equity||0) })).filter((p:any)=>p.time>0) : buildCryptoCurveR10(cryptoHistory);\n  const forexCurve = buildForexCurveR10(forexPerformance.recent || []);\n",
);

src = src.replace(
  '        <ScannerCard scanner={cryptoScanner} kind="crypto" />',
  '        <ScannerCard scanner={cryptoScanner} kind="crypto" />\n        <PerformanceChartR10 title="GANANCIA CRYPTO · OPERACIONES CERRADAS" points={cryptoCurve} unit="$" />\n        <AutoScanBadgeR10 scanner={cryptoScanner} fallbackSeconds={15} />',
);

src = src.replace(
  '        <ScannerCard scanner={forexScanner} kind="forex" />',
  '        <ScannerCard scanner={forexScanner} kind="forex" />\n        <PerformanceChartR10 title="GANANCIA FOREX · RETORNO DE SEÑALES" points={forexCurve} unit="%" />\n        <AutoScanBadgeR10 scanner={forexScanner} fallbackMinutes={forexScanner.effectiveIntervalMinutes || settings.forexSignalScanIntervalMinutes || 30} />',
);

src = src.replace(/\n\s*<div className="flex flex-wrap gap-2">\s*<SecondaryButton disabled=\{busy \|\| !settings\.engineEnabled\} onClick=\{\(\) => run\(\(\) => v34Api\.runCryptoScanner\(\), 'Scanner Crypto ejecutado\.'\)\}>Escanear Crypto ahora<\/SecondaryButton>\s*<\/div>/, '');
src = src.replace(/\n\s*<div className="flex flex-wrap gap-2">\s*<SecondaryButton disabled=\{busy \|\| !forexData\.configured\} onClick=\{\(\) => run\(\(\) => v34Api\.runForexScanner\(\), 'Scanner Forex ejecutado\.'\)\}>Escanear Forex ahora<\/SecondaryButton>\s*<\/div>/, '');
src = src.replace(
  '<div className="flex flex-wrap gap-2 mt-3"><PrimaryButton disabled={busy} onClick={() => void saveSymbols()}>Guardar instrumentos</PrimaryButton><SecondaryButton disabled={busy || !forex.configured} onClick={() => run(() => v34Api.runForexScanner(), \'Forex escaneado.\')}>Escanear ahora</SecondaryButton></div>',
  '<div className="flex flex-wrap gap-2 mt-3"><PrimaryButton disabled={busy} onClick={() => void saveSymbols()}>Guardar instrumentos</PrimaryButton><span className="px-3 py-2 rounded-xl border border-cyan-800/40 bg-cyan-500/5 text-[8px] font-black uppercase tracking-widest text-cyan-300">Scanner automático con Engine ON</span></div>',
);

if (!src.includes("const BUILD = 'R10';")) throw new Error('R10_BUILD_REPLACEMENT_FAILED');
if (!src.includes('lg:grid-cols-2')) throw new Error('R10_LAYOUT_REPLACEMENT_FAILED');
if (!src.includes('PerformanceChartR10 title=')) throw new Error('R10_PERIOD_CHART_INJECTION_FAILED');
if (!src.includes('buildCryptoCurveR10')) throw new Error('R10_CHART_IMPORT_FAILED');
if (src.includes('Escanear Crypto ahora') || src.includes('Escanear Forex ahora') || src.includes('>Escanear ahora<')) throw new Error('R10_MANUAL_SCAN_BUTTON_REMAINS');

fs.writeFileSync(targetPath, src);
console.log('Generated AppR10.tsx');
