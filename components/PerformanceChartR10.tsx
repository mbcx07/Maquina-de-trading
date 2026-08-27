import React, { useMemo, useState } from 'react';

export type PerformancePoint = { time: number; value: number };

type RangeKey = 'day' | 'week' | 'month' | 'year';

const RANGE_MS: Record<RangeKey, number> = {
  day: 24 * 60 * 60_000,
  week: 7 * 24 * 60 * 60_000,
  month: 30 * 24 * 60 * 60_000,
  year: 365 * 24 * 60 * 60_000,
};
const RANGE_LABEL: Record<RangeKey, string> = { day: 'Día', week: 'Semana', month: 'Mes', year: 'Año' };

export function PerformanceChartR10({ title, points, unit = '$' }: { title: string; points: PerformancePoint[]; unit?: '$' | '%' }) {
  const [range, setRange] = useState<RangeKey>('day');
  const data = useMemo(() => normalize(points), [points]);
  const view = useMemo(() => selectRange(data, range), [data, range]);
  const compact = useMemo(() => downsample(view.series, 260), [view.series]);

  const values = compact.map((point) => point.value);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 0;
  const span = Math.max(1e-9, max - min);
  const startValue = view.series[0]?.value ?? 0;
  const endValue = view.series.at(-1)?.value ?? startValue;
  const gain = endValue - startValue;
  const fmt = (value: number) => unit === '$'
    ? `${value < 0 ? '-' : ''}$${Math.abs(value).toFixed(2)}`
    : `${value.toFixed(2)}%`;

  const w = 900, h = 230, left = 64, right = 16, top = 18, bottom = 34;
  const plotW = w - left - right, plotH = h - top - bottom;
  const coords = compact.map((point, index) => {
    const x = left + (compact.length <= 1 ? 0 : index / (compact.length - 1) * plotW);
    const y = top + plotH - (point.value - min) / span * plotH;
    return [x, y] as const;
  });
  const line = coords.map((coord, index) => `${index === 0 ? 'M' : 'L'} ${coord[0].toFixed(1)} ${coord[1].toFixed(1)}`).join(' ');
  const area = coords.length ? `${line} L ${coords.at(-1)![0]} ${top + plotH} L ${coords[0][0]} ${top + plotH} Z` : '';
  const positive = gain >= 0;

  return (
    <div className="rounded-2xl border border-slate-800 bg-black/25 p-4 space-y-3">
      <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-3">
        <div>
          <p className="text-[8px] font-black uppercase tracking-[0.18em] text-slate-500">{title}</p>
          <div className="mt-1 flex items-end gap-2">
            <b className={`text-2xl ${positive ? 'text-emerald-400' : 'text-rose-400'}`}>{fmt(gain)}</b>
            <span className="text-[8px] uppercase text-slate-600 pb-1">{RANGE_LABEL[range]}</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          {(Object.keys(RANGE_LABEL) as RangeKey[]).map((key) => (
            <button
              key={key}
              onClick={() => setRange(key)}
              className={`px-3 py-2 rounded-lg text-[8px] font-black uppercase border ${range === key ? 'border-cyan-400/60 bg-cyan-500/15 text-cyan-200' : 'border-slate-800 bg-slate-950 text-slate-500 hover:text-slate-300'}`}
            >
              {RANGE_LABEL[key]}
            </button>
          ))}
        </div>
      </div>

      {view.series.length < 2 ? (
        <div className="h-44 flex items-center justify-center text-[8px] uppercase tracking-widest text-slate-700">Sin cierres suficientes en este periodo</div>
      ) : (
        <>
          <svg viewBox="0 0 900 230" className="w-full h-52" preserveAspectRatio="none">
            {[0, 1, 2, 3, 4].map((grid) => {
              const y = top + grid / 4 * plotH;
              const value = max - grid / 4 * span;
              return (
                <g key={grid}>
                  <line x1={left} y1={y} x2={w - right} y2={y} stroke="#172033" strokeWidth="1" />
                  <text x="3" y={y + 4} fill="#64748b" fontSize="11">{fmt(value)}</text>
                </g>
              );
            })}
            <path d={area} fill="currentColor" opacity="0.08" className={positive ? 'text-emerald-400' : 'text-rose-400'} />
            <path d={line} fill="none" stroke="currentColor" strokeWidth="3" vectorEffect="non-scaling-stroke" className={positive ? 'text-emerald-400' : 'text-rose-400'} />
            {coords.length > 0 && <circle cx={coords.at(-1)![0]} cy={coords.at(-1)![1]} r="5" fill="currentColor" className={positive ? 'text-emerald-300' : 'text-rose-300'} />}
          </svg>

          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            <Stat label="Ganancia periodo" value={fmt(gain)} tone={positive ? 'green' : 'red'} />
            <Stat label="Inicio" value={fmt(startValue)} />
            <Stat label="Final" value={fmt(endValue)} />
            <Stat label="Mín / Máx" value={`${fmt(min)} / ${fmt(max)}`} />
            <Stat label="Cierres" value={String(Math.max(0, view.series.length - 1))} />
          </div>
          <div className="flex justify-between gap-3 text-[7px] text-slate-600">
            <span>{new Date(view.series[0].time).toLocaleString()}</span>
            <span>{new Date(view.series.at(-1)!.time).toLocaleString()}</span>
          </div>
        </>
      )}
    </div>
  );
}

export function AutoScanBadgeR10({ scanner, fallbackSeconds, fallbackMinutes }: any) {
  const seconds = fallbackSeconds ?? Math.max(60, Number(fallbackMinutes || 30) * 60);
  return (
    <div className="rounded-xl border border-emerald-800/30 bg-emerald-500/5 px-3 py-2 flex flex-wrap justify-between gap-2 text-[8px] uppercase tracking-widest">
      <b className="text-emerald-400">AUTO SCAN ACTIVO</b>
      <span className="text-slate-500">TF {scanner.timeframe || '5m/15m'} · ciclo aprox. {seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)} min`} · último {scanner.completedAt ? new Date(scanner.completedAt).toLocaleTimeString() : '—'}</span>
    </div>
  );
}

export function buildCryptoCurveR10(rows: any[]): PerformancePoint[] {
  const closed = [...(rows || [])]
    .filter((row) => row?.state === 'CLOSED')
    .sort((a, b) => Number(a.closeTime || a.updatedAt || 0) - Number(b.closeTime || b.updatedAt || 0));
  let value = 0;
  return closed.map((row) => {
    value += Number(row.realizedPnl || 0) - Number(row.commission || 0) + Number(row.fundingOrSwap || 0);
    return { time: Number(row.closeTime || row.updatedAt || Date.now()), value };
  });
}

export function buildForexCurveR10(rows: any[]): PerformancePoint[] {
  const closed = [...(rows || [])]
    .filter((row) => row?.status === 'WIN' || row?.status === 'LOSS')
    .sort((a, b) => Number(a.resolvedAt || a.createdAt || 0) - Number(b.resolvedAt || b.createdAt || 0));
  let value = 0;
  return closed.map((row) => {
    value += Number(row.returnPct || 0);
    return { time: Number(row.resolvedAt || row.createdAt || Date.now()), value };
  });
}

function normalize(points: PerformancePoint[]): PerformancePoint[] {
  const map = new Map<number, PerformancePoint>();
  for (const point of Array.isArray(points) ? points : []) {
    const time = Number(point?.time || 0);
    const value = Number(point?.value || 0);
    if (Number.isFinite(time) && time > 0 && Number.isFinite(value)) map.set(time, { time, value });
  }
  return [...map.values()].sort((a, b) => a.time - b.time);
}

function selectRange(points: PerformancePoint[], range: RangeKey) {
  const cutoff = Date.now() - RANGE_MS[range];
  let baseline: PerformancePoint | undefined;
  for (const point of points) {
    if (point.time <= cutoff) baseline = point;
    else break;
  }
  const current = points.filter((point) => point.time > cutoff);
  if (!baseline) baseline = current[0] || points[0];
  const series = baseline ? [baseline, ...current.filter((point) => point.time > baseline!.time)] : [];
  return { series };
}

function downsample(points: PerformancePoint[], max: number): PerformancePoint[] {
  if (points.length <= max) return points;
  const out: PerformancePoint[] = [];
  const step = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
  return out;
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'green' | 'red' }) {
  return (
    <div className="rounded-xl border border-slate-800/80 bg-slate-950/60 p-2 min-w-0">
      <p className="text-[7px] uppercase tracking-widest text-slate-600">{label}</p>
      <p className={`mt-1 text-[9px] font-black break-words ${tone === 'green' ? 'text-emerald-400' : tone === 'red' ? 'text-rose-400' : 'text-slate-300'}`}>{value}</p>
    </div>
  );
}
