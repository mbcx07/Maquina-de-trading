import fs from 'node:fs';

const sourcePath = new URL('../AppR8.tsx', import.meta.url);
const targetPath = new URL('../AppR9.tsx', import.meta.url);
let src = fs.readFileSync(sourcePath, 'utf8');

src = src
  .replace("const BUILD = 'R8';", "const BUILD = 'R9';")
  .replace(/V34 <span className="text-cyan-400">R8<\/span>/g, 'V34 <span className="text-cyan-400">R9</span>')
  .replace(/Build R8/g, 'Build R9')
  .replace(/R8 no usa/g, 'R9 no usa/g')
  .replace('grid grid-cols-1 2xl:grid-cols-2 gap-4 items-start', 'grid grid-cols-1 lg:grid-cols-2 gap-4 items-start')
  .replace('V33.5 estructural · ejecución automática · izquierda', 'M5 entrada/estructura · M15 tendencia · AUTO · izquierda')
  .replace('señales manuales · derecha · sin ejecución automática', 'M5/M15 · señales manuales · scanner AUTO · derecha');

src = src.replace(
  "  const forexData = state.brokerStatus?.forexData || {};\n",
  "  const forexData = state.brokerStatus?.forexData || {};\n  const cryptoCurve = settings.appMode === 'PAPER' && Array.isArray(paper.equityCurve) && paper.equityCurve.length ? paper.equityCurve.map((p:any)=>({ time:Number(p.time||p.at||0), value:Number(p.equity||0) })) : buildCryptoCurve(cryptoHistory);\n  const forexCurve = buildForexCurve(forexPerformance.recent || []);\n",
);

src = src.replace(
  '        <ScannerCard scanner={cryptoScanner} kind="crypto" />',
  '        <ScannerCard scanner={cryptoScanner} kind="crypto" />\n        <PerformanceChart title="CURVA CRYPTO · EQUITY / PNL ACUMULADO" points={cryptoCurve} />\n        <AutoScanBadge scanner={cryptoScanner} fallbackSeconds={15} />',
);

src = src.replace(
  '        <ScannerCard scanner={forexScanner} kind="forex" />',
  '        <ScannerCard scanner={forexScanner} kind="forex" />\n        <PerformanceChart title="CURVA FOREX · RETORNO ACUMULADO DE SEÑALES" points={forexCurve} suffix="%" />\n        <AutoScanBadge scanner={forexScanner} fallbackMinutes={forexScanner.effectiveIntervalMinutes || settings.forexSignalScanIntervalMinutes || 30} />',
);

src = src.replace(/\n\s*<div className="flex flex-wrap gap-2">\s*<SecondaryButton disabled=\{busy \|\| !settings\.engineEnabled\} onClick=\{\(\) => run\(\(\) => v34Api\.runCryptoScanner\(\), 'Scanner Crypto ejecutado\.'\)\}>Escanear Crypto ahora<\/SecondaryButton>\s*<\/div>/, '');
src = src.replace(/\n\s*<div className="flex flex-wrap gap-2">\s*<SecondaryButton disabled=\{busy \|\| !forexData\.configured\} onClick=\{\(\) => run\(\(\) => v34Api\.runForexScanner\(\), 'Scanner Forex ejecutado\.'\)\}>Escanear Forex ahora<\/SecondaryButton>\s*<\/div>/, '');

src = src.replace(
  '<div className="flex flex-wrap gap-2 mt-3"><PrimaryButton disabled={busy} onClick={() => void saveSymbols()}>Guardar instrumentos</PrimaryButton><SecondaryButton disabled={busy || !forex.configured} onClick={() => run(() => v34Api.runForexScanner(), \'Forex escaneado.\')}>Escanear ahora</SecondaryButton></div>',
  '<div className="flex flex-wrap gap-2 mt-3"><PrimaryButton disabled={busy} onClick={() => void saveSymbols()}>Guardar instrumentos</PrimaryButton><span className="px-3 py-2 rounded-xl border border-cyan-800/40 bg-cyan-500/5 text-[8px] font-black uppercase tracking-widest text-cyan-300">Scanner automático con Engine ON</span></div>',
);

src = src.replace(
  'function PositionTable({ rows, paper, busy, onClose }: any) {',
  `function PerformanceChart({ title, points, suffix = '' }: any) {
  const clean = (Array.isArray(points) ? points : []).filter((p:any)=>Number.isFinite(Number(p?.value))).slice(-120);
  if (clean.length < 2) return <div className="rounded-2xl border border-slate-800 bg-black/20 p-4"><p className="text-[8px] font-black uppercase tracking-widest text-slate-500">{title}</p><div className="h-36 flex items-center justify-center text-[8px] uppercase tracking-widest text-slate-700">Esperando datos para construir gráfica</div></div>;
  const values = clean.map((p:any)=>Number(p.value));
  const min = Math.min(...values), max = Math.max(...values), span = Math.max(1e-9, max-min);
  const w=800,h=180,pad=12;
  const coords = clean.map((p:any,i:number)=>{const x=pad+(i/(clean.length-1))*(w-pad*2);const y=h-pad-((Number(p.value)-min)/span)*(h-pad*2);return [x,y];});
  const d=coords.map((c:any,i:number)=>\`${'${'}i===0?'M':'L'} ${'${'}c[0].toFixed(1)} ${'${'}c[1].toFixed(1)}\`).join(' ');
  const last=values.at(-1) ?? 0;
  return <div className="rounded-2xl border border-slate-800 bg-black/20 p-4"><div className="flex justify-between gap-3 mb-2"><p className="text-[8px] font-black uppercase tracking-widest text-slate-500">{title}</p><b className={last>=0?'text-emerald-400':'text-rose-400'}>{last.toFixed(2)}{suffix}</b></div><svg viewBox=\"0 0 800 180\" className=\"w-full h-40\" preserveAspectRatio=\"none\"><path d={d} fill=\"none\" stroke=\"currentColor\" strokeWidth=\"3\" className={last>=0?'text-emerald-400':'text-rose-400'} /><line x1=\"12\" y1=\"168\" x2=\"788\" y2=\"168\" stroke=\"#1e293b\" strokeWidth=\"1\" /></svg><div className="flex justify-between text-[7px] text-slate-600"><span>Min {min.toFixed(2)}{suffix}</span><span>Max {max.toFixed(2)}{suffix}</span></div></div>;
}
function AutoScanBadge({ scanner, fallbackSeconds, fallbackMinutes }: any){const secs=fallbackSeconds ?? Math.max(60,Number(fallbackMinutes||30)*60);return <div className="rounded-xl border border-emerald-800/30 bg-emerald-500/5 px-3 py-2 flex flex-wrap justify-between gap-2 text-[8px] uppercase tracking-widest"><b className="text-emerald-400">AUTO SCAN ACTIVO</b><span className="text-slate-500">TF {scanner.timeframe||'5m/15m'} · ciclo aprox. {secs<60?\`${'${'}secs}s\`: \`${'${'}Math.round(secs/60)} min\`} · último {scanner.completedAt?new Date(scanner.completedAt).toLocaleTimeString():'—'}</span></div>;}
function buildCryptoCurve(rows:any[]){const closed=[...(rows||[])].filter((r:any)=>r?.state==='CLOSED').sort((a:any,b:any)=>Number(a.closedAt||a.updatedAt||0)-Number(b.closedAt||b.updatedAt||0));let value=0;const out:any[]=[{time:closed[0]?.openedAt||Date.now(),value:0}];for(const r of closed){value+=tradeNetPnl(r);out.push({time:Number(r.closedAt||r.updatedAt||Date.now()),value});}return out;}
function buildForexCurve(rows:any[]){const closed=[...(rows||[])].filter((r:any)=>r?.status==='WIN'||r?.status==='LOSS').sort((a:any,b:any)=>Number(a.resolvedAt||a.createdAt||0)-Number(b.resolvedAt||b.createdAt||0));let value=0;const out:any[]=[{time:closed[0]?.createdAt||Date.now(),value:0}];for(const r of closed){value+=Number(r.returnPct||0);out.push({time:Number(r.resolvedAt||r.createdAt||Date.now()),value});}return out;}

function PositionTable({ rows, paper, busy, onClose }: any) {`,
);

if (!src.includes("const BUILD = 'R9';")) throw new Error('R9_BUILD_REPLACEMENT_FAILED');
if (!src.includes('lg:grid-cols-2')) throw new Error('R9_LAYOUT_REPLACEMENT_FAILED');
if (!src.includes('PerformanceChart')) throw new Error('R9_CHART_INJECTION_FAILED');
if (src.includes('Escanear Crypto ahora') || src.includes('Escanear Forex ahora') || src.includes('>Escanear ahora<')) throw new Error('R9_MANUAL_SCAN_BUTTON_REMAINS');

fs.writeFileSync(targetPath, src);
console.log('Generated AppR9.tsx');
