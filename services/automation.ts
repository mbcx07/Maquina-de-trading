
import { StrategyType, Timeframe, StrategyResult, Candle } from '../types';
import { analyzeStructureStrategy } from './strategies';
import { runRollingBacktest } from './backtester';
import { binanceService } from './binance';
import { MAX_CONCURRENT_POSITIONS, NOTIONAL_PCT_OF_BALANCE, MAX_RISK_PER_TRADE_PCT, MIN_BACKTEST_WINRATE } from '../constants';

export const automationEngine = {
  isScanning: false,
  lastUniverseSync: 0,
  tradeUniverse: [] as string[],
  scannedCount: 0,

  async updateUniverse(addLog: (m: string, l: any, c: any) => void) {
    if (Date.now() - this.lastUniverseSync < 300000 && this.tradeUniverse.length > 0) return;
    try {
      await binanceService.fetchExchangeInfo();
      const tickerData = await binanceService.getTicker24h();
      
      this.tradeUniverse = tickerData
        .filter(t => {
          const vol = parseFloat(t.quoteVolume);
          return t.symbol.endsWith('USDT') && vol > 2000000;
        })
        .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
        .map(t => t.symbol);

      this.lastUniverseSync = Date.now();
    } catch (e: any) {
      this.tradeUniverse = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'BNBUSDT'];
    }
  },

  async fetchDualKlines(symbol: string): Promise<{ltf: Candle[], htf: Candle[]} | null> {
    try {
      const [ltfRes, htfRes] = await Promise.all([
        binanceService.robustFetch(`${binanceService.restBase}/fapi/v1/klines?symbol=${symbol}&interval=1m&limit=100`),
        binanceService.robustFetch(`${binanceService.restBase}/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=210`)
      ]);

      const mapKlines = (klines: any[]) => klines.map(k => ({
        time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
        low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5])
      }));

      return { ltf: mapKlines(ltfRes), htf: mapKlines(htfRes) };
    } catch (e) { return null; }
  },

  async scanSymbol(
    symbol: string, 
    balance: number,
    leverage: number,
    openSymbols: string[], 
    onDecision: (decision: any) => void,
    onEvaluation: (result: StrategyResult) => void,
    addLog: (msg: string, level: any, cat: any) => void
  ) {
    if (openSymbols.includes(symbol)) return;

    const data = await this.fetchDualKlines(symbol);
    if (!data || data.ltf.length < 50) return;

    // Medición activa del Win Rate mediante Backtesting Rodante
    const backtestResult = runRollingBacktest(
      symbol, 
      Timeframe.M1, 
      StrategyType.EXPERT_CONFLUENCE, 
      data.ltf, 
      data.htf
    );
    
    // Notificar al Leaderboard para visualización del Win Rate en vivo
    onEvaluation(backtestResult);

    const currentPrice = data.ltf[data.ltf.length - 1].close;
    const signal = analyzeStructureStrategy(data.ltf, data.htf, symbol, currentPrice);

    if (signal) {
      // Filtro Sniper 80% Win Rate:
      // Solo ejecutar si el backtest confirma alta probabilidad (>= 75%-80%) o confluencia extrema
      const isHighWinRate = backtestResult.tradesEvaluated === 0 
        ? signal.confidence >= 80 
        : (backtestResult.winRate >= MIN_BACKTEST_WINRATE && signal.confidence >= 75);

      if (!isHighWinRate) {
        addLog(`FILTRO 80% WR: ${symbol} descartado (WR: ${backtestResult.winRate.toFixed(0)}% < 80%).`, "WARNING", "ANALYSIS");
        return;
      }

      addLog(`SNIPER 80% IDENTIFICADO: ${symbol} (${signal.side} WR:${backtestResult.winRate > 0 ? backtestResult.winRate.toFixed(0) + '%' : signal.confidence + '%'})`, "SUCCESS", "ANALYSIS");

      // v33.5: Cálculo estricto del 11% del balance como Nocional
      let targetNotional = balance * NOTIONAL_PCT_OF_BALANCE;
      const riskAmount = Math.abs(currentPrice - signal.sl);
      const riskPct = riskAmount / currentPrice;
      
      const maxAllowedRiskLoss = balance * MAX_RISK_PER_TRADE_PCT;
      const currentRiskLoss = targetNotional * riskPct;

      if (currentRiskLoss > maxAllowedRiskLoss) {
        targetNotional = maxAllowedRiskLoss / riskPct;
        addLog(`RISK: Reduciendo tamaño en ${symbol} para proteger balance.`, "WARNING", "RISK");
      }

      // El margen se calcula basándose en el apalancamiento que usará la orden
      onDecision({
        symbol,
        side: signal.side === 'BUY' ? 'LONG' : 'SHORT',
        entry: currentPrice,
        sl: signal.sl,
        tp: signal.tp,
        tp2: signal.tp2,
        tp3: signal.tp3,
        notional: targetNotional,
        margin: targetNotional / leverage,
        strategy: signal.strategyId,
        reason: `${signal.reason}_WR${backtestResult.winRate.toFixed(0)}`
      });
    }
  },

  async monitorAndScan(
    currentBalance: number,
    currentLeverage: number,
    openSymbols: string[],
    onDecision: (decision: any) => void,
    onEvaluation: (result: StrategyResult) => void,
    onProgress: (symbol: string | null) => void,
    addLog: (msg: string, level: any, cat: any) => void
  ) {
    if (this.isScanning) return;
    this.isScanning = true;
    this.scannedCount = 0;
    
    try {
      await this.updateUniverse(addLog);
      
      const chunkSize = 5;
      for (let i = 0; i < this.tradeUniverse.length; i += chunkSize) {
        if (openSymbols.length >= MAX_CONCURRENT_POSITIONS) break;
        
        const chunk = this.tradeUniverse.slice(i, i + chunkSize);
        await Promise.all(chunk.map(async (symbol) => {
            this.scannedCount++;
            onProgress(`${symbol} [${this.scannedCount}/${this.tradeUniverse.length}]`);
            await this.scanSymbol(symbol, currentBalance, currentLeverage, openSymbols, onDecision, onEvaluation, addLog);
        }));
        
        await new Promise(r => setTimeout(r, 100));
      }
    } finally {
      this.isScanning = false;
      onProgress(null);
    }
  }
};
