
import React from 'react';
import { Portfolio } from '../types';
import { TARGET_WINRATE } from '../constants';

interface Props {
  portfolio: Portfolio;
}

const QuantMetrics: React.FC<Props> = ({ portfolio }) => {
  const closedTrades = portfolio.trades.filter(t => t.status === 'CLOSED');
  
  const getStats = (trades: typeof closedTrades) => {
    const total = trades.length;
    const wins = trades.filter(t => t.pnl > 0).length;
    const losses = trades.filter(t => t.pnl < 0).length;
    const winRate = total > 0 ? (wins / total) * 100 : 0;
    return { total, wins, losses, winRate };
  };

  const global = getStats(closedTrades);
  const growth = ((portfolio.futuresBalance - portfolio.initialBalance) / portfolio.initialBalance) * 100;
  const isTargetMet = global.winRate >= TARGET_WINRATE && global.total >= 3;

  return (
    <div className="bg-slate-900/40 border border-slate-800/60 rounded-3xl p-6 h-full flex flex-col justify-between">
      <div>
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xs font-black text-slate-400 uppercase tracking-[0.2em] flex items-center gap-2">
            <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></div>
            Account Overview
          </h2>
          <span className="text-[7px] font-bold font-mono px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
            TARGET: {TARGET_WINRATE}% WR
          </span>
        </div>
        
        <div className="space-y-4">
          <div className="bg-black/40 border border-slate-800 p-4 rounded-2xl">
            <p className="text-[8px] text-slate-500 font-black uppercase mb-1 tracking-widest">Total Net Balance</p>
            <p className="text-3xl font-black font-mono text-white leading-none">
              <span className="text-emerald-400 text-lg mr-1">$</span>
              {portfolio.futuresBalance.toFixed(2)}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-3 text-center relative overflow-hidden">
              <p className="text-[7px] text-slate-500 uppercase font-bold mb-1">Live Win Rate</p>
              <p className={`text-lg font-black font-mono ${global.winRate >= 80 ? 'text-emerald-400 font-bold' : global.winRate >= 60 ? 'text-indigo-400' : 'text-slate-300'}`}>
                {global.winRate.toFixed(1)}%
              </p>
              <span className="text-[6px] text-slate-600 font-mono uppercase mt-0.5 block">
                {global.wins}W / {global.losses}L ({global.total} TRADES)
              </span>
            </div>
            <div className="bg-slate-950/60 border border-slate-800 rounded-2xl p-3 text-center">
              <p className="text-[7px] text-slate-500 uppercase font-bold mb-1">Crecimiento</p>
              <p className={`text-lg font-black font-mono ${growth >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                {growth >= 0 ? '+' : ''}{growth.toFixed(1)}%
              </p>
              <span className="text-[6px] text-slate-600 font-mono uppercase mt-0.5 block">
                PNL: ${(portfolio.futuresBalance - portfolio.initialBalance).toFixed(2)}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-4 pt-4 border-t border-slate-800/50">
        <div className="flex justify-between items-center text-[10px] font-black uppercase mb-2">
          <span className="text-slate-500">Target Winrate 80%</span>
          <span className={`font-mono ${isTargetMet ? 'text-emerald-400' : 'text-slate-400'}`}>
            {global.winRate.toFixed(0)}% / {TARGET_WINRATE}%
          </span>
        </div>
        <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
          <div 
            className={`h-full transition-all duration-500 ${global.winRate >= 80 ? 'bg-emerald-400' : 'bg-indigo-500'}`}
            style={{ width: `${Math.min((global.winRate / TARGET_WINRATE) * 100, 100)}%` }}
          ></div>
        </div>
      </div>
    </div>
  );
};

export default QuantMetrics;
