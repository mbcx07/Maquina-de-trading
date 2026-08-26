
import React, { useState, useEffect } from 'react';
import { Trade } from '../types';
import { FEE_TAKER } from '../constants';
import { marketService } from '../services/marketData';

interface Props {
  trade: Trade;
  onClose: (trade: Trade, currentPrice: number) => void;
}

const TradeDetail: React.FC<Props> = ({ trade, onClose }) => {
  const [currentPrice, setCurrentPrice] = useState(trade.entryPrice);
  const [isClosing, setIsClosing] = useState(false);
  
  useEffect(() => {
    const timer = setInterval(() => {
      const price = marketService.getLivePrice(trade.symbol);
      if (price > 0) setCurrentPrice(price);
    }, 1000);
    return () => clearInterval(timer);
  }, [trade.symbol]);

  // v33.1: Manejo robusto de NaN
  const safePnl = isNaN(trade.pnl) ? 0 : trade.pnl;
  const safeAmount = (trade.amount && !isNaN(trade.amount) && trade.amount > 0) ? trade.amount : 1;
  const safeLeverage = (trade.leverage && !isNaN(trade.leverage) && trade.leverage > 0) ? trade.leverage : 1;
  
  const netPnlUsdt = trade.isReal 
    ? safePnl 
    : ((trade.side === 'BUY' ? (currentPrice - trade.entryPrice) : (trade.entryPrice - currentPrice)) * (safeAmount * safeLeverage / trade.entryPrice));
  
  const isProfit = netPnlUsdt >= 0;
  
  // ROE Real: PnL / Margen (Amount)
  const currentRoe = trade.isReal 
    ? (netPnlUsdt / safeAmount * 100) 
    : ((trade.side === 'BUY' ? (currentPrice - trade.entryPrice) : (trade.entryPrice - currentPrice)) / trade.entryPrice * safeLeverage * 100);

  const displayRoe = isNaN(currentRoe) ? 0 : currentRoe;

  return (
    <div className="bg-black/60 border border-slate-800 rounded-[2rem] p-6 relative overflow-hidden group shadow-2xl transition-all hover:border-indigo-500/30">
      {/* BADGE DE APALANCAMIENTO REAL */}
      <div className={`absolute top-0 right-0 px-6 py-2 text-[11px] font-black uppercase tracking-tighter shadow-lg ${trade.side === 'BUY' ? 'bg-emerald-500 text-black' : 'bg-rose-500 text-white'}`}>
        {trade.side} | {safeLeverage}X
      </div>
      
      <div className="flex justify-between items-start mb-6 pt-4">
        <div>
          <span className="text-xl font-black block tracking-tighter text-white uppercase">{trade.symbol}</span>
          <span className="text-[9px] font-bold text-slate-500 uppercase tracking-widest mt-1">
            {trade.isReal ? 'EXECUTING LIVE' : 'PAPER TRADING'}
          </span>
        </div>
        <div className="text-right">
           <span className={`text-2xl font-black font-mono tracking-tighter ${isProfit ? 'text-emerald-400' : 'text-rose-400'}`}>
             {displayRoe >= 0 ? '+' : ''}{displayRoe.toFixed(1)}%
           </span>
           <p className="text-[8px] font-black text-slate-600 uppercase mt-1">
             PnL Net: ${netPnlUsdt.toFixed(3)}
           </p>
        </div>
      </div>

      <div className="space-y-3 mb-6 bg-slate-900/40 p-4 rounded-2xl border border-slate-800/50">
        <div className="flex justify-between items-center text-[10px] uppercase font-black">
          <span className="text-slate-500">Margin</span>
          <span className="text-indigo-400 tracking-tight">${safeAmount.toFixed(2)} ({safeLeverage}x)</span>
        </div>
        <div className="flex justify-between items-center text-[10px] uppercase font-black">
          <span className="text-slate-500">Entry</span>
          <span className="text-white tracking-tight">${trade.entryPrice.toFixed(currentPrice < 1 ? 6 : 2)}</span>
        </div>
        <div className="flex justify-between items-center text-[10px] uppercase font-black">
          <span className="text-slate-500">Market</span>
          <span className="text-white tracking-tight animate-pulse">${currentPrice.toFixed(currentPrice < 1 ? 6 : 2)}</span>
        </div>
        
        <div className="h-px bg-slate-800/50 my-2"></div>

        <div className="flex justify-between items-center text-[10px] uppercase font-black">
          <span className="text-emerald-500/70">TP Target ▲</span>
          <span className="text-emerald-400 font-mono">${trade.takeProfit?.toFixed(currentPrice < 1 ? 6 : 2)}</span>
        </div>

        <div className="flex justify-between items-center text-[10px] uppercase font-black">
          <span className="text-rose-500/70">SL Target ▼</span>
          <span className="text-rose-400 font-mono">${trade.stopLoss?.toFixed(currentPrice < 1 ? 6 : 2)}</span>
        </div>
      </div>

      <div className="pt-2">
        <button 
          onClick={() => { 
            if (isClosing) return;
            setIsClosing(true); 
            onClose(trade, currentPrice); 
          }}
          className={`w-full text-[10px] font-black py-4 rounded-xl transition-all uppercase tracking-widest ${isClosing ? 'bg-slate-700 text-slate-500 cursor-not-allowed' : 'bg-slate-800 text-slate-300 hover:bg-rose-600 hover:text-white shadow-lg'}`}
        >
          {isClosing ? 'LIQUIDATING...' : 'CLOSE AT MARKET'}
        </button>
      </div>
    </div>
  );
};

export default TradeDetail;
