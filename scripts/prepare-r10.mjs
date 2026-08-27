import fs from 'node:fs';

const sourcePath = new URL('../AppR8.tsx', import.meta.url);
const targetPath = new URL('../AppR10.tsx', import.meta.url);
let src = fs.readFileSync(sourcePath, 'utf8');

src = src
  .replace("const BUILD = 'R8';", "const BUILD = 'R10';")
  .replace(/V34 <span className="text-cyan-400">R8<\/span>/g, 'V34 <span className="text-cyan-400">R10</span>')
  .replace(/Build R8/g, 'Build R10')
  .replace(/R8 no usa/g, 'R10 no usa/g')
  .replace('grid grid-cols-1 2xl:grid-cols-2 gap-4 items-start', 'grid grid-cols-1 lg:grid-cols-2 gap-4 items-start')
  .replace('V33.5 estructural · ejecución automática · izquierda', 'R10 HIGH-WR · sweep/reclaim + MSS · M5/M15 · AUTO')
  .replace('FOREX / METALS / INDICES · SIGNAL DESK', 'FOREX + XAUUSD · SIGNAL DESK')
  .replace('señales manuales · derecha · sin ejecución automática', 'R10 HIGH-WR · M5/M15 · señales manuales · scanner AUTO')
  .replace(' XAUUSD se consulta como XAU/USD. NAS100 se resuelve contra el catálogo de Twelve Data; si el plan no lo permite, solo ese instrumento queda marcado con error.', ' XAUUSD se consulta como XAU/USD. NAS100 fue retirado del universo Forex.')
  .replace('V33.5 estructural', 'R10 Sweep/Reclaim/MSS');

src = src.replace(
  "  const forexData = state.brokerStatus?.forexData || {};\n",
  "  const forexData = state.brokerStatus?.forexData || {};\n  const cryptoCurve = settings.appMode === 'PAPER' && Array.isArray(paper.equityCurve) && paper.equityCurve.length ? paper.equityCurve.map((p:any)=>({ time:Number(p.time||p.at||0), value:Number(p.equity||0) })).filter((p:any)=>p.time>0) : buildCryptoCurve(cryptoHistory);\n  const forexCurve = buildForexCurve(forexPerformance.recent || []);\n",
);

src = src.replace(
  '        <ScannerCard scanner={cryptoScanner} kind="crypto" />',
  '        <ScannerCard scanner={cryptoScanner} kind="crypto" />\n        <PerformanceChart title="GANANCIA CRYPTO · OPERACIONES CERRADAS" points={cryptoCurve} unit="$" />\n        <AutoScanBadge scanner={cryptoScanner} fallbackSeconds={15} />',
);

src = src.replace(
  '        <ScannerCard scanner={forexScanner} kind="forex" />',
  '        <ScannerCard scanner={forexScanner} kind="forex" />\n        <PerformanceChart title="GANANCIA FOREX · RETORNO DE SEÑALES" points={forexCurve} unit="%" />\n        <AutoScanBadge scanner={forexScanner} fallbackMinutes={forexScanner.effectiveIntervalMinutes || settings.forexSignalScanIntervalMinutes || 30} />',
);

src = src.replace(/\n\s*<div className="flex flex-wrap gap-2">\s*<SecondaryButton disabled=\{busy \|\| !settings\.engineEnabled\} onClick=\{\(\) => run\(\(\) => v34Api\.runCryptoScanner\(\), 'Scanner Crypto ejecutado\.'\)\}>Escanear Crypto ahora<\/SecondaryButton>\s*<\/div>/, '');
src = src.replace(/\n\s*<div className="flex flex-wrap gap-2">\s*<SecondaryButton disabled=\{busy \|\| !forexData\.configured\} onClick=\{\(\) => run\(\(\) => v34Api\.runForexScanner\(\), 'Scanner Forex ejecutado\.'\)\}>Escanear Forex ahora<\/SecondaryButton>\s*<\/div>/, '');
src = src.replace(
  '<div className="flex flex-wrap gap-2 mt-3"><PrimaryButton disabled={busy} onClick={() => void saveSymbols()}>Guardar instrumentos</PrimaryButton><SecondaryButton disabled={busy || !forex.configured} onClick={() => run(() => v34Api.runForexScanner(), \'Forex escaneado.\')}>Escanear ahora</SecondaryButton></div>',
  '<div className="flex flex-wrap gap-2 mt-3"><PrimaryButton disabled={busy} onClick={() => void saveSymbols()}>Guardar instrumentos</PrimaryButton><span className="px-3 py-2 rounded-xl border border-cyan-800/40 bg-cyan-500/5 text-[8px] font-black uppercase tracking-widest text-cyan-300">Scanner automático con Engine ON</span></div>',
);

src = src.replace(
  'function PositionTable({ rows, paper, busy, onClose }: any) {',
  `function PerformanceChart({ title, points, unit = '$' }: any) {
  const [range, setRange] = useState<'day'|'week'|'month'|'year'>('day');
  const all = (Array.isArray(points) ? points : [])
    .map((p:any)=>({time:Number(p?.time||0),value:Number(p?.value||0)}))
    .filter((p:any)=>Number.isFinite(p.time)&&p.time>0&&Number.isFinite(p.value))
    .sort((a:any,b:any)=>a.time-b.time);
  const ranges:any = { day: 86400000, week: 7*86400000, month: 30*86400000, year: 365*86400000 };
  const labels:any = { day: 'Día', week: 'Semana', month: 'Mes', year: 'Año' };
  const cutoff = Date.now() - ranges[range];
  let baseIndex = -1;
  for(let i=0;i<all.length;i++){ if(all[i].time<=cutoff) baseIndex=i; else break; }
  const inPeriod = all.filter((p:any)=>p.time>cutoff);
  const baseline = baseIndex>=0 ? all[baseIndex] : (inPeriod[0] || all[0]);
  const series = baseline ? [baseline, ...inPeriod.filter((p:any)=>p.time>baseline.time)] : [];
  const compact = downsamplePoints(series, 240);
  const startValue = series[0]?.value ?? 0;
  const endValue = series.at(-1)?.value ?? startValue;
  const gain = endValue - startValue;
  const values = compact.map((p:any)=>p.value);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 0;
  const span = Math.max(1e-9,max-min);
  const w=900,h=230,left=55,right=16,top=18,bottom=34;
  const plotW=w-left-right,plotH=h-top-bottom;
  const coords = compact.map((p:any,i:number)=>{
    const x=left+(compact.length<=1?0:(i/(compact.length-1))*plotW);
    const y=top+plotH-((p.value-min)/span)*plotH;
    return [x,y];
  });
  const line=coords.map((c:any,i:number)=>\`${'${'}i===0?'M':'L'} ${'${'}c[0].toFixed(1)} ${'${'}c[1].toFixed(1)}\`).join(' ');
  const area=coords.length?\`${'${'}line} L ${'${'}coords.at(-1)[0]} ${'${'}top+plotH} L ${'${'}coords[0][0]} ${'${'}top+plotH} Z\`:'';
  const fmt=(v:number)=> unit==='$' ? \`${'${'}v<0?'-':''}$${'${'}Math.abs(v).toFixed(2)}\` : \`${'${'}v.toFixed(2)}%\`;
  const hasMoves = series.length>1;
  const startTime = series[0]?.time;
  const endTime = series.at(-1)?.time;
  return <div className="rounded-2xl border border-slate-800 bg-black/25 p-4 space-y-3">
    <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-3">
      <div><p className="text-[8px] font-black uppercase tracking-[0.18em] text-slate-500">{title}</p><div className="mt-1 flex items-end gap-2"><b className={\`text-2xl ${'${'}gain>=0?'text-emerald-400':'text-rose-400'}\`}>{fmt(gain)}</b><span className="text-[8px] uppercase text-slate-600 pb-1">{labels[range]}</span></div></div>
      <div className="flex flex-wrap gap-1">{(['day','week','month','year'] as const).map((key)=><button key={key} onClick={()=>setRange(key)} className={\`px-3 py-2 rounded-lg text-[8px] font-black uppercase border ${'${'}range===key?'border-cyan-400/60 bg-cyan-500/15 text-cyan-200':'border-slate-800 bg-slate-950 text-slate-500 hover:text-slate-300'}\`}>{labels[key]}</button>)}</div>
    </div>
    {!hasMoves ? <div className="h-44 flex items-center justify-center text-[8px] uppercase tracking-widest text-slate-700">Sin cierres suficientes en este periodo</div> : <>
      <svg viewBox=\"0 0 900 230\" className=\"w-full h-52\" preserveAspectRatio=\"none\">
        {[0,1,2,3,4].map((g)=>{const y=top+(g/4)*plotH;const val=max-(g/4)*span;return <g key={g}><line x1={left} y1={y} x2={w-right} y2={y} stroke=\"#172033\" strokeWidth=\"1\"/><text x=\"4\" y={y+4} fill=\"#64748b\" fontSize=\"11\">{fmt(val)}</text></g>})}
        <path d={area} fill=\"currentColor\" opacity=\"0.08\" className={gain>=0?'text-emerald-400':'text-rose-400'} />
        <path d={line} fill=\"none\" stroke=\"currentColor\" strokeWidth=\"3\" vectorEffect=\"non-scaling-stroke\" className={gain>=0?'text-emerald-400':'text-rose-400'} />
        {coords.length>0&&<circle cx={coords.at(-1)[0]} cy={coords.at(-1)[1]} r=\"5\" fill=\"currentColor\" className={gain>=0?'text-emerald-300':'text-rose-300'} />}
      </svg>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        <ChartStat label="Ganancia periodo" value={fmt(gain)} tone={gain>=0?'green':'red'} />
        <ChartStat label="Inicio" value={fmt(startValue)} />
        <ChartStat label="Final" value={fmt(endValue)} />
        <ChartStat label="Mín / Máx" value={\`${'${'}fmt(min)} / ${'${'}fmt(max)}\`} />
        <ChartStat label="Cierres / tramo" value={String(Math.max(0,series.length-1))} />
      </div>
      <div className="flex justify-between text-[7px] text-slate-600"><span>{startTime?new Date(startTime).toLocaleString():'—'}</span><span>{endTime?new Date(endTime).toLocaleString():'—'}</span></div>
    </>}
  </div>;
}
function ChartStat({label,value,tone}:any){return <div className="rounded-xl border border-slate-800/80 bg-slate-950/60 p-2"><p className="text-[7px] uppercase tracking-widest text-slate-600">{label}</p><p className={\`mt-1 text-[9px] font-black ${'${'}tone==='green'?'text-emerald-400':tone==='red'?'text-rose-400':'text-slate-300'}\`}>{value}</p></div>}
function downsamplePoints(points:any[],max:number){if(points.length<=max)return points;const out:any[]=[];const step=(points.length-1)/(max-1);for(let i=0;i<max;i++)out.push(points[Math.round(i*step)]);return out;}
function AutoScanBadge({ scanner, fallbackSeconds, fallbackMinutes }: any){const secs=fallbackSeconds ?? Math.max(60,Number(fallbackMinutes||30)*60);return <div className="rounded-xl border border-emerald-800/30 bg-emerald-500/5 px-3 py-2 flex flex-wrap justify-between gap-2 text-[8px] uppercase tracking-widest"><b className="text-emerald-400">AUTO SCAN ACTIVO</b><span className="text-slate-500">TF {scanner.timeframe||'5m/15m'} · ciclo aprox. {secs<60?\`${'${'}secs}s\`: \`${'${'}Math.round(secs/60)} min\`} · último {scanner.completedAt?new Date(scanner.completedAt).toLocaleTimeString():'—'}</span></div>;}
function buildCryptoCurve(rows:any[]){const closed=[...(rows||[])].filter((r:any)=>r?.state==='CLOSED').sort((a:any,b:any)=>Number(a.closeTime||a.updatedAt||0)-Number(b.closeTime||b.updatedAt||0));let value=0;const out:any[]=[];for(const r of closed){value+=tradeNetPnl(r);out.push({time:Number(r.closeTime||r.updatedAt||Date.now()),value});}return out;}
function buildForexCurve(rows:any[]){const closed=[...(rows||[])].filter((r:any)=>r?.status==='WIN'||r?.status==='LOSS').sort((a:any,b:any)=>Number(a.resolvedAt||a.createdAt||0)-Number(b.resolvedAt||b.createdAt||0));let value=0;const out:any[]=[];for(const r of closed){value+=Number(r.returnPct||0);out.push({time:Number(r.resolvedAt||r.createdAt||Date.now()),value});}return out;}

function PositionTable({ rows, paper, busy, onClose }: any) {`,
);

if (!src.includes("const BUILD = 'R10';")) throw new Error('R10_BUILD_REPLACEMENT_FAILED');
if (!src.includes('lg:grid-cols-2')) throw new Error('R10_LAYOUT_REPLACEMENT_FAILED');
if (!src.includes("setRange<'day'")) throw new Error('R10_PERIOD_CHART_INJECTION_FAILED');
if (src.includes('Escanear Crypto ahora') || src.includes('Escanear Forex ahora') || src.includes('>Escanear ahora<')) throw new Error('R10_MANUAL_SCAN_BUTTON_REMAINS');

fs.writeFileSync(targetPath, src);
console.log('Generated AppR10.tsx');
