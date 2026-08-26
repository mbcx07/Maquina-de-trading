
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Portfolio, LogEntry, Trade, MarketType, Timeframe, StrategyResult, Candle, StrategyType } from './types';
import { binanceService } from './services/binance';
import { automationEngine } from './services/automation';
import { marketService } from './services/marketData';
import { INITIAL_CAPITAL, LEVERAGE as DEFAULT_LEVERAGE } from './constants';

import LiveLog from './components/LiveLog';
import QuantMetrics from './components/QuantMetrics';
import TradeDetail from './components/TradeDetail';
import TradeHistory from './components/TradeHistory';
import StrategyLeaderboard from './components/StrategyLeaderboard';

const App: React.FC = () => {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [engineActive, setEngineActive] = useState(false);
  const [tradingMode, setTradingMode] = useState<'PAPER' | 'REAL'>('PAPER');
  const [currentLeverage, setCurrentLeverage] = useState(DEFAULT_LEVERAGE);
  const [leaderboard, setLeaderboard] = useState<StrategyResult[]>([]);
  const [scanningSymbol, setScanningSymbol] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [networkError, setNetworkError] = useState("");
  const [activeNode, setActiveNode] = useState("APEX-V33.5");
  
  const processingSymbols = useRef<Set<string>>(new Set());
  const tradesRef = useRef<Trade[]>([]);
  const balanceRef = useRef<number>(INITIAL_CAPITAL);

  const [portfolio, setPortfolio] = useState<Portfolio>({
    futuresBalance: INITIAL_CAPITAL,
    initialBalance: INITIAL_CAPITAL,
    equity: INITIAL_CAPITAL,
    totalPnl: 0,
    trades: []
  });

  const addLog = useCallback((message: string, level: LogEntry['level'], category: LogEntry['category']) => {
    setLogs(prev => [{ timestamp: Date.now(), level, message, category }, ...prev].slice(0, 50));
  }, []);

  const syncState = useCallback(async () => {
    if (tradingMode !== 'REAL') return;
    try {
      const bal = await binanceService.getAvailableBalance();
      if (bal > 0) {
        // Detectar caída masiva de balance (posible liquidación)
        if (balanceRef.current > 0 && bal < balanceRef.current * 0.9) {
            addLog("ALERTA: Caída de balance detectada. Reconciliando posiciones...", "ERROR", "RISK");
        }
        balanceRef.current = bal;
        setPortfolio(prev => ({ ...prev, futuresBalance: bal, equity: bal }));
        setIsConnected(true);
      }

      const realPositions = await binanceService.getOpenPositions();
      const realSymbols = new Set(realPositions.map(p => p.symbol));

      let updatedTrades = [...tradesRef.current];
      let needsStateUpdate = false;
      
      // 1. Detectar posiciones cerradas externamente (Binance las quitó de PositionRisk)
      for (const t of updatedTrades) {
        if (t.status === 'OPEN' && t.isReal && !realSymbols.has(t.symbol)) {
          needsStateUpdate = true;
          try {
            const history = await binanceService.getUserTrades(t.symbol);
            const lastTrade = history[0];
            t.status = 'CLOSED';
            t.exitPrice = lastTrade ? parseFloat(lastTrade.price) : marketService.getLivePrice(t.symbol);
            t.pnl = lastTrade ? parseFloat(lastTrade.realizedPnl) : 0;
            t.exitTime = Date.now();
            addLog(`SYNC: ${t.symbol} cerrada en Binance (SL/TP/LQ).`, "INFO", "EXECUTION");
          } catch (e) {
            t.status = 'CLOSED';
            t.exitTime = Date.now();
          }
        }
      }

      // 2. Actualizar trades abiertos con datos en tiempo real de Binance
      for (const p of realPositions) {
        const existingIndex = updatedTrades.findIndex(t => t.symbol === p.symbol && t.status === 'OPEN');
        
        const realPnl = parseFloat(p.unrealizedProfit || p.unRealizedProfit || "0");
        const realLev = parseInt(p.leverage || "1");
        const realEntry = parseFloat(p.entryPrice || "0");
        const realNotional = Math.abs(parseFloat(p.notional || "0"));
        const posAmt = parseFloat(p.positionAmt);
        
        if (existingIndex !== -1) {
          if (updatedTrades[existingIndex].pnl !== realPnl) needsStateUpdate = true;
          updatedTrades[existingIndex].leverage = realLev;
          updatedTrades[existingIndex].entryPrice = realEntry;
          updatedTrades[existingIndex].amount = realNotional / (realLev || 1);
          updatedTrades[existingIndex].pnl = realPnl;
        } else {
          // Adoptar posición que no estaba en la App
          needsStateUpdate = true;
          const adopted: Trade = {
            id: `EXT-${p.symbol}-${Date.now()}`,
            symbol: p.symbol, strategy: StrategyType.EXPERT_CONFLUENCE,
            timeframe: Timeframe.M1, market: MarketType.FUTURES,
            entryPrice: realEntry, amount: realNotional / (realLev || 1),
            leverage: realLev, entryTime: Date.now(), status: 'OPEN',
            pnl: realPnl, side: posAmt > 0 ? 'BUY' : 'SELL', isReal: true
          };
          updatedTrades.unshift(adopted);
          addLog(`DETECTADO: Posición externa en ${p.symbol} sincronizada.`, "SUCCESS", "MARKET");
        }
      }

      if (needsStateUpdate) {
        tradesRef.current = updatedTrades;
        setPortfolio(prev => ({ ...prev, trades: updatedTrades }));
      }
      setActiveNode(binanceService.activeProxyName);
    } catch (e: any) {
      setNetworkError(e.message);
    }
  }, [tradingMode, addLog]);

  const handleDecision = useCallback(async (decision: any) => {
    if (processingSymbols.current.has(decision.symbol)) return;
    processingSymbols.current.add(decision.symbol);

    try {
      const isReal = tradingMode === 'REAL';
      let confirmedLeverage = currentLeverage;
      let confirmedMargin = decision.margin;

      if (isReal) {
        addLog(`ORDEN: ${decision.symbol} enviando...`, "INFO", "EXECUTION");
        confirmedLeverage = await binanceService.setLeverage(decision.symbol, currentLeverage);
        
        // Re-calcular margen con el apalancamiento real que aplicó Binance
        confirmedMargin = decision.notional / confirmedLeverage;

        const qty = binanceService.formatQuantity(decision.symbol, (decision.notional / decision.entry));
        const side = decision.side === 'LONG' ? 'BUY' : 'SELL';
        const res = await binanceService.createOrder(decision.symbol, side, qty);
        
        if (res.success) {
          addLog(`OK: ${decision.symbol} @ ${confirmedLeverage}x`, "SUCCESS", "EXECUTION");
          const exitSide = side === 'BUY' ? 'SELL' : 'BUY';
          binanceService.setNativeExit(decision.symbol, exitSide, decision.sl, 'STOP_MARKET').catch(() => {});
          binanceService.setNativeExit(decision.symbol, exitSide, decision.tp, 'TAKE_PROFIT_MARKET').catch(() => {});
        } else throw new Error(res.error);
      }

      const newTrade: Trade = {
        id: `T-${Date.now()}`,
        symbol: decision.symbol, strategy: decision.strategy,
        timeframe: Timeframe.M1, market: MarketType.FUTURES,
        entryPrice: decision.entry, amount: confirmedMargin,
        leverage: confirmedLeverage, entryTime: Date.now(),
        status: 'OPEN', pnl: 0, side: decision.side === 'LONG' ? 'BUY' : 'SELL',
        takeProfit: decision.tp, stopLoss: decision.sl, isReal
      };

      setPortfolio(prev => {
        const updated = [newTrade, ...prev.trades];
        tradesRef.current = updated;
        return { ...prev, trades: updated };
      });
    } catch (e: any) {
      addLog(`FALLO: ${decision.symbol} - ${e.message}`, "ERROR", "EXECUTION");
    } finally {
      processingSymbols.current.delete(decision.symbol);
      setTimeout(syncState, 2000);
    }
  }, [tradingMode, currentLeverage, addLog, syncState]);

  const handleEvaluation = useCallback((result: StrategyResult) => {
    setLeaderboard(prev => {
      const idx = prev.findIndex(item => item.symbol === result.symbol && item.strategy === result.strategy);
      if (idx !== -1) {
        const updated = [...prev];
        updated[idx] = result;
        return updated.sort((a, b) => b.winRate - a.winRate);
      }
      return [result, ...prev].slice(0, 25).sort((a, b) => b.winRate - a.winRate);
    });
  }, []);

  useEffect(() => {
    const mainLoop = setInterval(() => {
      if (engineActive) {
        const openSymbols = tradesRef.current.filter(t => t.status === 'OPEN').map(t => t.symbol);
        automationEngine.monitorAndScan(balanceRef.current, currentLeverage, openSymbols, handleDecision, handleEvaluation, setScanningSymbol, addLog);
      }
    }, 10000);
    return () => clearInterval(mainLoop);
  }, [engineActive, currentLeverage, handleDecision, handleEvaluation, addLog]);

  useEffect(() => {
    const priceUpdater = setInterval(async () => {
      try {
        const prices = await binanceService.getAllPrices();
        if (prices.size > 0) {
          setIsConnected(true);
          prices.forEach((p, s) => marketService.updateRealPrice(s, p));
        }
      } catch (e: any) {}
    }, 5000);
    return () => clearInterval(priceUpdater);
  }, []);

  return (
    <div className="min-h-screen bg-[#010409] text-slate-200 p-4 font-mono">
      <div className="max-w-[1500px] mx-auto space-y-4">
        <div className="bg-[#0d1117] border border-slate-800 rounded-3xl p-6 flex flex-wrap justify-between items-center shadow-2xl gap-6">
          <div className="flex items-center gap-6">
            <div className={`w-3 h-3 rounded-full ${engineActive ? 'bg-indigo-500 animate-pulse' : 'bg-slate-700'}`}></div>
            <div>
              <h1 className="text-2xl font-black text-white italic uppercase tracking-tighter">QUANTUM<span className="text-indigo-500">SNIPER</span> v33.5</h1>
              <div className="flex flex-col mt-1">
                <div className="flex items-center gap-2">
                  <span className={`w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-emerald-500 shadow-[0_0_10px_#10b981]' : 'bg-rose-500 animate-ping'}`}></span>
                  <p className="text-[9px] text-slate-500 font-bold uppercase tracking-widest">
                    {isConnected ? `NODE: ${activeNode}` : 'CONNECTING...'}
                  </p>
                </div>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-8">
            <div className="flex flex-col gap-1.5">
              <span className="text-[8px] font-black text-indigo-500 uppercase tracking-[0.2em] text-center">LEV CONFIG</span>
              <div className="flex bg-black/40 p-1.5 rounded-2xl border border-slate-800">
                  {[20, 50, 75, 100, 125].map(lv => (
                    <button key={lv} onClick={() => setCurrentLeverage(lv)} className={`w-12 h-9 rounded-xl text-[10px] font-black transition-all border ${currentLeverage === lv ? 'bg-indigo-600 border-indigo-400 text-white shadow-[0_0_15px_rgba(79,70,229,0.4)]' : 'border-transparent text-slate-600'}`}>{lv}x</button>
                  ))}
               </div>
            </div>
            <div className="flex bg-black/60 p-1.5 rounded-2xl border border-slate-700">
               <button onClick={() => setTradingMode('PAPER')} className={`px-4 py-2 rounded-xl text-[9px] font-black ${tradingMode === 'PAPER' ? 'bg-slate-800 text-white' : 'text-slate-600'}`}>PAPER</button>
               <button onClick={() => setTradingMode('REAL')} className={`px-4 py-2 rounded-xl text-[9px] font-black ${tradingMode === 'REAL' ? 'bg-amber-500 text-black shadow-lg' : 'text-slate-600'}`}>REAL</button>
            </div>
            <button onClick={() => setEngineActive(!engineActive)} className={`px-12 py-4 rounded-2xl font-black uppercase text-xs transition-all ${engineActive ? 'bg-rose-600 shadow-[0_0_25px_rgba(225,29,72,0.4)]' : 'bg-indigo-600 shadow-[0_0_25px_rgba(79,70,229,0.4)]'} text-white`}>
              {engineActive ? 'HALT' : 'ENGAGE'}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
          <QuantMetrics portfolio={portfolio} />
          <div className="lg:col-span-2 bg-[#0d1117] border border-slate-800 rounded-[2.5rem] p-8 flex flex-col items-center justify-center min-h-[450px]">
             {engineActive && scanningSymbol ? (
               <div className="text-center space-y-8 animate-in fade-in zoom-in duration-700">
                  <div className="w-32 h-32 border-4 border-indigo-500/10 border-t-indigo-500 rounded-full animate-spin"></div>
                  <h2 className="text-2xl font-black text-white italic uppercase tracking-tighter">Scanning...</h2>
                  <p className="text-sm text-indigo-400 font-black tracking-[0.4em] bg-indigo-500/10 px-6 py-2 rounded-full border border-indigo-500/20">{scanningSymbol}</p>
               </div>
             ) : (
               <div className="text-center space-y-8">
                 <div className="w-24 h-24 border-4 border-indigo-500/10 border-t-indigo-500 rounded-full flex items-center justify-center text-indigo-500 font-black text-2xl italic">33.5</div>
                 <h2 className="text-3xl font-black text-white italic uppercase tracking-widest">SRE ENGINE</h2>
                 <p className="text-[10px] text-slate-500 font-black uppercase tracking-[0.5em] leading-relaxed">Auto-Sync: ENABLED<br/>Anti-Liquidation: ACTIVE</p>
               </div>
             )}
          </div>
          <StrategyLeaderboard strategies={leaderboard} />
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
          <div className="xl:col-span-2 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
               {portfolio.trades.filter(t => t.status === 'OPEN').map(t => (
                 <TradeDetail key={t.id} trade={t} onClose={async (tr, pr) => {
                    try {
                        if (tradingMode === 'REAL') {
                            const qty = binanceService.formatQuantity(tr.symbol, (tr.amount * tr.leverage / tr.entryPrice));
                            await binanceService.closePosition(tr.symbol, tr.side, qty);
                            addLog(`CERRADO: ${tr.symbol}`, "SUCCESS", "EXECUTION");
                        } else {
                            setPortfolio(prev => ({
                                ...prev,
                                trades: prev.trades.map(item => item.id === tr.id ? { ...item, status: 'CLOSED', exitPrice: pr, exitTime: Date.now(), pnl: (pr - item.entryPrice) * (item.amount * item.leverage / item.entryPrice) * (item.side === 'BUY' ? 1 : -1) } : item)
                            }));
                        }
                        setTimeout(syncState, 2000);
                    } catch (e: any) { addLog(`ERROR CIERRE: ${e.message}`, "ERROR", "EXECUTION"); }
                 }} />
               ))}
            </div>
            <TradeHistory trades={portfolio.trades} />
          </div>
          <div className="xl:col-span-1"><LiveLog logs={logs} /></div>
        </div>
      </div>
    </div>
  );
};

export default App;
