
import { Candle, StrategyType, Timeframe, StrategyResult } from '../types';
import { analyzeStructureStrategy } from './strategies';

export const runRollingBacktest = (
  symbol: string,
  timeframe: Timeframe,
  strategy: StrategyType,
  allCandles: Candle[],
  htfCandles?: Candle[]
): StrategyResult => {
  let wins = 0;
  let totalTrades = 0;
  let totalProfit = 0;
  let maxDrawdown = 0;
  let peakEquity = 100;
  let currentEquity = 100;
  
  const ltfLength = allCandles.length;
  if (ltfLength < 60) {
    return {
      strategy, timeframe, symbol,
      profit: 0,
      winRate: 0, 
      drawdown: 0,
      score: 0,
      tradesEvaluated: 0,
      status: 'CALIBRATING'
    };
  }

  const lookback = Math.min(ltfLength - 52, 160);
  
  for (let i = ltfLength - 10; i > ltfLength - lookback; i -= 2) {
    const ltfSlice = allCandles.slice(0, i + 1);
    
    // Si tenemos velas HTF reales usamos el slice correspondiente; si no, agrupamos LTF
    let htfSlice: Candle[];
    if (htfCandles && htfCandles.length >= 50) {
      const currentTime = allCandles[i].time;
      htfSlice = htfCandles.filter(c => c.time <= currentTime);
      if (htfSlice.length < 50) htfSlice = ltfSlice;
    } else {
      htfSlice = ltfSlice;
    }

    const signal = analyzeStructureStrategy(ltfSlice, htfSlice, symbol, allCandles[i].close);
    
    if (signal && signal.side !== 'NONE') {
      totalTrades++;
      const tp = signal.tp;
      const sl = signal.sl;
      let tradeWon = false;
      let pnlPct = 0;

      for (let j = i + 1; j < Math.min(i + 45, ltfLength); j++) {
        const nextCandle = allCandles[j];
        if (signal.side === 'BUY') {
          if (nextCandle.high >= tp) { 
            wins++; 
            tradeWon = true; 
            pnlPct = Math.abs(tp - signal.entry) / signal.entry;
            break; 
          }
          if (nextCandle.low <= sl) { 
            pnlPct = -Math.abs(signal.entry - sl) / signal.entry;
            break; 
          }
        } else {
          if (nextCandle.low <= tp) { 
            wins++; 
            tradeWon = true; 
            pnlPct = Math.abs(signal.entry - tp) / signal.entry;
            break; 
          }
          if (nextCandle.high >= sl) { 
            pnlPct = -Math.abs(sl - signal.entry) / signal.entry;
            break; 
          }
        }
      }

      currentEquity += currentEquity * pnlPct;
      if (currentEquity > peakEquity) peakEquity = currentEquity;
      const dd = ((peakEquity - currentEquity) / peakEquity) * 100;
      if (dd > maxDrawdown) maxDrawdown = dd;
      totalProfit += pnlPct * 100;
    }
  }

  // Cálculo real del Win Rate
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const score = totalTrades >= 3 ? winRate : (winRate * 0.7);

  let status = 'BAJA_FIABILIDAD';
  if (winRate >= 80 && totalTrades >= 2) {
    status = 'ALPHA_80%_CONFIRMED';
  } else if (winRate >= 70 && totalTrades >= 2) {
    status = 'PROBABLE_ALPHA';
  } else if (totalTrades === 0) {
    status = 'SIN_SEÑAL';
  }

  return {
    strategy, 
    timeframe, 
    symbol,
    profit: totalProfit,
    winRate, 
    drawdown: maxDrawdown,
    score,
    tradesEvaluated: totalTrades,
    status,
    expectancy: totalTrades > 0 ? (totalProfit / totalTrades) : 0
  };
};
