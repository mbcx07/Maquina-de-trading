
import React from 'react';
import { StrategyResult } from '../types';

interface Props {
  strategies: StrategyResult[];
}

const StrategyLeaderboard: React.FC<Props> = ({ strategies }) => {
  return (
    <div className="bg-[#0d1117] border border-slate-800 rounded-3xl p-5 h-full shadow-2xl flex flex-col min-h-[400px]">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] flex items-center gap-2">
          <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse"></div>
          ALPHA DISCOVERY MONITOR
        </h2>
        <span className="text-[8px] font-black font-mono px-2 py-0.5 bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 rounded-full">
          OBJETIVO: 80% WR
        </span>
      </div>
      
      <div className="space-y-3 flex-grow overflow-y-auto pr-1 scrollbar-none">
        {strategies.sort((a, b) => b.winRate - a.winRate).map((s: any) => {
          const isTargetAchieved = s.winRate >= 80;
          const isHighProb = s.winRate >= 70;

          return (
            <div 
              key={`${s.symbol}-${s.strategy}`} 
              className={`bg-black/30 border rounded-xl p-3 transition-all group ${
                isTargetAchieved 
                  ? 'border-emerald-500/50 shadow-[0_0_15px_rgba(16,185,129,0.15)]' 
                  : isHighProb 
                    ? 'border-indigo-500/40' 
                    : 'border-slate-800/60'
              }`}
            >
              <div className="flex justify-between items-center mb-1">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-black text-white group-hover:text-indigo-400">{s.symbol}</span>
                  <span className={`text-[7px] font-bold px-1.5 py-0.5 rounded border ${
                    isTargetAchieved 
                      ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' 
                      : 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20'
                  }`}>
                    {isTargetAchieved ? 'SNIPER 80%' : s.strategy}
                  </span>
                </div>
                <span className={`text-[11px] font-mono font-black ${
                  isTargetAchieved 
                    ? 'text-emerald-400 font-bold' 
                    : isHighProb 
                      ? 'text-indigo-300' 
                      : 'text-slate-500'
                }`}>
                  WR: {s.winRate.toFixed(0)}%
                </span>
              </div>
              
              <div className="relative w-full h-1.5 bg-slate-800 rounded-full overflow-hidden mt-2">
                {/* Marcador del 80% */}
                <div className="absolute left-[80%] top-0 bottom-0 w-0.5 bg-white/40 z-10"></div>
                <div 
                  className={`h-full transition-all duration-700 ease-out ${
                    isTargetAchieved 
                      ? 'bg-emerald-400 shadow-[0_0_8px_#34d399]' 
                      : isHighProb 
                        ? 'bg-indigo-500' 
                        : 'bg-slate-700'
                  }`} 
                  style={{ width: `${Math.min(s.winRate, 100)}%` }}
                ></div>
              </div>
              
              <div className="flex justify-between items-center mt-2">
                 <p className={`text-[7px] uppercase font-black tracking-widest ${
                   isTargetAchieved 
                     ? 'text-emerald-400' 
                     : isHighProb 
                       ? 'text-indigo-400' 
                       : 'text-slate-600'
                 }`}>
                   {isTargetAchieved ? 'ALPHA 80% VALIDADO' : isHighProb ? 'PROBABLE ALPHA' : 'CALIBRANDO'}
                 </p>
                 <span className="text-[6px] text-slate-500 font-bold uppercase">
                   {s.tradesEvaluated > 0 ? `BT: ${s.tradesEvaluated} TRADES` : 'BT: ROLLED'}
                 </span>
              </div>
            </div>
          );
        })}
        
        {strategies.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center opacity-40 py-20 text-center">
            <div className="w-8 h-8 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin mb-4"></div>
            <p className="text-[8px] font-black uppercase tracking-widest text-emerald-400">Rastreando pares para Win Rate 80%...</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default StrategyLeaderboard;
