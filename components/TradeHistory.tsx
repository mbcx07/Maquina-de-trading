
import React from 'react';
import { Trade, MarketType } from '../types';

interface Props {
  trades: Trade[];
}

const TradeHistory: React.FC<Props> = ({ trades }) => {
  const closedTrades = [...trades]
    .filter(t => t.status === 'CLOSED' && !isNaN(t.pnl))
    .sort((a, b) => (b.exitTime || 0) - (a.exitTime || 0));

  const wins = closedTrades.filter(t => t.pnl > 0).length;
  const winRate = closedTrades.length > 0 ? (wins / closedTrades.length) * 100 : 0;

  return (
    <div className="bg-[#0d1117] border border-slate-800 rounded-[2.5rem] p-8 shadow-2xl overflow-hidden relative">
      <div className="flex justify-between items-center mb-8 relative z-10">
        <div>
          <h2 className="text-xl font-black text-white italic uppercase tracking-tighter">
            Auditoría Predictiva
          </h2>
          <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mt-1">Historial Real Sincronizado</p>
        </div>
        <div className="flex gap-4">
          <div className="text-right">
            <span className="text-[9px] text-slate-500 font-black uppercase block">Trades</span>
            <span className="text-lg font-black font-mono text-indigo-400">{closedTrades.length}</span>
          </div>
          <div className="text-right">
            <span className="text-[9px] text-slate-500 font-black uppercase block">Win Rate</span>
            <span className="text-lg font-black font-mono text-emerald-400">
              {winRate.toFixed(1)}%
            </span>
          </div>
        </div>
      </div>

      <div className="overflow-x-auto relative z-10">
        <table className="w-full text-left border-separate border-spacing-y-3">
          <thead>
            <tr className="text-[10px] text-slate-500 uppercase font-black tracking-[0.2em]">
              <th className="px-6 pb-2">Asset</th>
              <th className="px-6 pb-2">Market</th>
              <th className="px-6 pb-2 text-right">Entry / Exit</th>
              <th className="px-6 pb-2 text-right">PnL Neto</th>
              <th className="px-6 pb-2 text-right">ROI %</th>
            </tr>
          </thead>
          <tbody>
            {closedTrades.slice(0, 15).map((trade) => {
              const isProfit = trade.pnl >= 0;
              // v33.5: Cálculo de ROI seguro (PNL / Margen usado)
              const safeAmount = (trade.amount && trade.amount > 0) ? trade.amount : 1;
              const roi = (trade.pnl / safeAmount) * 100;
              
              return (
                <tr key={trade.id} className="group bg-black/40 hover:bg-slate-900/60 transition-all border border-slate-800">
                  <td className="px-6 py-4 rounded-l-2xl border-l border-t border-b border-slate-800 group-hover:border-indigo-500/30">
                    <div className="flex flex-col">
                      <span className="text-sm font-black text-white tracking-tight">{trade.symbol}</span>
                      <span className="text-[7px] text-slate-600 font-mono uppercase">{trade.strategy}</span>
                    </div>
                  </td>
                  <td className="px-6 py-4 border-t border-b border-slate-800 group-hover:border-indigo-500/30">
                    <span className={`text-[9px] px-2 py-1 rounded font-black ${trade.isReal ? 'bg-amber-500/10 text-amber-500' : 'bg-slate-700 text-slate-400'}`}>
                      {trade.leverage}X {trade.isReal ? 'REAL' : 'PAPER'}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-right border-t border-b border-slate-800 group-hover:border-indigo-500/30">
                    <div className="flex flex-col font-mono text-[10px]">
                      <span className="text-slate-500">${trade.entryPrice.toFixed(trade.entryPrice < 1 ? 5 : 2)}</span>
                      <span className="text-indigo-400">${trade.exitPrice?.toFixed(trade.entryPrice < 1 ? 5 : 2)}</span>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-right border-t border-b border-slate-800 group-hover:border-indigo-500/30">
                    <span className={`text-sm font-black font-mono ${isProfit ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {isProfit ? '+' : ''}${trade.pnl.toFixed(4)}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-right rounded-r-2xl border-r border-t border-b border-slate-800 group-hover:border-indigo-500/30">
                    <div className={`inline-flex items-center px-3 py-1 rounded-lg text-[9px] font-black font-mono ${isProfit ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'}`}>
                      {roi >= 0 ? '▲' : '▼'} {Math.abs(roi).toFixed(1)}%
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default TradeHistory;
