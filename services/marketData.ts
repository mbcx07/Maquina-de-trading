
import { Candle, Asset, Timeframe } from '../types';
import { MOCK_ASSETS } from '../constants';

class MarketSimulator {
  private cache: Map<string, Candle[]> = new Map();
  private realPrices: Map<string, number> = new Map();
  private fallbackPrices: Map<string, number> = new Map();

  public updateRealPrice(symbol: string, price: number) {
    if (price && price > 0) {
      this.realPrices.set(symbol, price);
      this.fallbackPrices.set(symbol, price);
    }
  }

  public generateHistory(asset: Asset, timeframe: Timeframe, length: number = 300): Candle[] {
    const key = `${asset.symbol}-${timeframe}`;
    let candles: Candle[] = [];
    let currentPrice = this.getLivePrice(asset.symbol) || asset.basePrice;
    let now = Date.now();
    const interval = this.getIntervalMs(timeframe);

    const marketBias = (Math.random() - 0.5) * 0.002; 

    for (let i = length; i >= 0; i--) {
      const noise = (Math.random() - 0.5) * asset.volatility * 0.4;
      const change = currentPrice * (marketBias + noise);
      const open = currentPrice;
      const close = currentPrice + change;
      const high = Math.max(open, close) + (Math.random() * currentPrice * 0.001);
      const low = Math.min(open, close) - (Math.random() * currentPrice * 0.001);
      
      candles.push({
        time: now - (i * interval), open, high, low, close,
        volume: (asset.volume24h / 1440) * (0.8 + Math.random() * 0.4)
      });
      currentPrice = close;
    }
    return candles;
  }

  public getLivePrice(symbol: string): number {
    // 1. Prioridad: Precio real actualizado por el socket/ticker
    if (this.realPrices.has(symbol)) {
      return this.realPrices.get(symbol)!;
    }

    // 2. Segundo recurso: Último precio guardado en historial de esta sesión
    if (this.fallbackPrices.has(symbol)) {
      return this.fallbackPrices.get(symbol)!;
    }

    // 3. Tercer recurso: Mock assets
    const asset = MOCK_ASSETS.find(a => a.symbol === symbol);
    if (asset) return asset.basePrice;
    
    return 0;
  }

  private getIntervalMs(timeframe: Timeframe): number {
    switch (timeframe) {
      case Timeframe.M1: return 60 * 1000;
      case Timeframe.M5: return 5 * 60 * 1000;
      default: return 60 * 1000;
    }
  }
}

export const marketService = new MarketSimulator();
