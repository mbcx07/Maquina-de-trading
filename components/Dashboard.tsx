
import React from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { Portfolio, MarketType } from '../types';

interface Props {
  portfolio: Portfolio;
}

const Dashboard: React.FC<Props> = ({ portfolio }) => {
  // Reconstruct history for both markets
  const closedTrades = portfolio.trades.filter(t => t.status === 'CLOSED').sort((a, b) => (a.exitTime || 0) - (b.exitTime || 0));
  
  const chartData = closedTrades.reduce((acc: any[], trade) => {
    const last = acc[acc.length - 1];
    const isSpot = trade.market === MarketType.SPOT;
    
    const newEntry = {
      time: new Date(trade.exitTime!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      total: last.total + trade.pnl,
      spot: isSpot ? last.spot + trade.pnl : last.spot,
      futures: !isSpot ? last.futures + trade.pnl : last.futures
    };
    
    acc.push(newEntry);
    return acc;
  }, [{ time: 'Inicio', total: portfolio.initialBalance, spot: portfolio.initialBalance / 2, futures: portfolio.initialBalance / 2 }]);

  return (
    <div className="bg-slate-900/50 border border-slate-800 rounded-3xl p-6 h-[450px] shadow-2xl">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-lg font-black text-white flex items-center gap-2">
          <svg className="w-5 h-5 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z"></path></svg>
          Curva de Equidad Multi-Mercado
        </h2>
        <div className="flex gap-4 text-[9px] font-mono font-bold uppercase">
          <span className="flex items-center gap-1.5"><div className="w-2 h-2 rounded-full bg-emerald-500"></div> Total</span>
          <span className="flex items-center gap-1.5"><div className="w-2 h-2 rounded-full bg-cyan-400"></div> Spot</span>
          <span className="flex items-center gap-1.5"><div className="w-2 h-2 rounded-full bg-amber-500"></div> Futuros</span>
        </div>
      </div>

      <div className="h-[320px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
            <defs>
              <linearGradient id="colorTotal" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#10b981" stopOpacity={0.2}/>
                <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
              </linearGradient>
              <linearGradient id="colorSpot" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#22d3ee" stopOpacity={0.1}/>
                <stop offset="95%" stopColor="#22d3ee" stopOpacity={0}/>
              </linearGradient>
              <linearGradient id="colorFut" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.1}/>
                <stop offset="95%" stopColor="#f59e0b" stopOpacity={0}/>
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
            <XAxis dataKey="time" stroke="#475569" fontSize={9} tickLine={false} axisLine={false} />
            <YAxis stroke="#475569" fontSize={9} tickLine={false} axisLine={false} domain={['auto', 'auto']} />
            <Tooltip 
              contentStyle={{ backgroundColor: '#020617', border: '1px solid #1e293b', borderRadius: '12px', fontSize: '10px' }}
              itemStyle={{ fontWeight: 'bold' }}
              labelStyle={{ color: '#64748b', marginBottom: '4px' }}
            />
            {/* Area para Futuros */}
            <Area type="monotone" dataKey="futures" stroke="#f59e0b" strokeWidth={2} fillOpacity={1} fill="url(#colorFut)" />
            {/* Area para Spot */}
            <Area type="monotone" dataKey="spot" stroke="#22d3ee" strokeWidth={2} fillOpacity={1} fill="url(#colorSpot)" />
            {/* Area para Total (Encima de todo) */}
            <Area type="monotone" dataKey="total" stroke="#10b981" strokeWidth={3} fillOpacity={1} fill="url(#colorTotal)" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      
      <p className="text-[9px] text-slate-500 font-mono text-center mt-4 uppercase tracking-widest opacity-50">
        Evolución histórica basada en trades cerrados
      </p>
    </div>
  );
};

export default Dashboard;
