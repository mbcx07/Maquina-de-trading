import type { Broker, TradeRecord } from './types.js';

export interface TradingMetrics {
  trades: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRate: number;
  realizedPnl: number;
  grossProfit: number;
  grossLoss: number;
  netProfit: number;
  profitFactor: number | null;
  expectancy: number;
  averageWin: number;
  averageLoss: number;
  largestWin: number;
  largestLoss: number;
  fees: number;
  fundingOrSwap: number;
  openTrades: number;
  unrealizedPnl: number;
}

export function calculateMetrics(trades: TradeRecord[], broker?: Broker): TradingMetrics {
  const scoped = broker ? trades.filter((trade) => trade.broker === broker) : trades;
  const closed = scoped.filter((trade) => trade.state === 'CLOSED');
  const open = scoped.filter((trade) => ['PENDING', 'OPENING', 'OPEN', 'CLOSING', 'SYNC_REQUIRED'].includes(trade.state));

  const wins = closed.filter((trade) => trade.realizedPnl > 0);
  const losses = closed.filter((trade) => trade.realizedPnl < 0);
  const breakeven = closed.filter((trade) => trade.realizedPnl === 0);

  const grossProfit = sum(wins.map((trade) => trade.realizedPnl));
  const grossLossAbs = Math.abs(sum(losses.map((trade) => trade.realizedPnl)));
  const realizedPnl = sum(closed.map((trade) => trade.realizedPnl));
  const fees = sum(scoped.map((trade) => trade.commission ?? 0));
  const fundingOrSwap = sum(scoped.map((trade) => trade.fundingOrSwap ?? 0));
  const netProfit = realizedPnl - fees + fundingOrSwap;

  return {
    trades: closed.length,
    wins: wins.length,
    losses: losses.length,
    breakeven: breakeven.length,
    winRate: closed.length ? (wins.length / closed.length) * 100 : 0,
    realizedPnl,
    grossProfit,
    grossLoss: -grossLossAbs,
    netProfit,
    profitFactor: grossLossAbs > 0 ? grossProfit / grossLossAbs : grossProfit > 0 ? null : 0,
    expectancy: closed.length ? realizedPnl / closed.length : 0,
    averageWin: wins.length ? grossProfit / wins.length : 0,
    averageLoss: losses.length ? -grossLossAbs / losses.length : 0,
    largestWin: wins.length ? Math.max(...wins.map((trade) => trade.realizedPnl)) : 0,
    largestLoss: losses.length ? Math.min(...losses.map((trade) => trade.realizedPnl)) : 0,
    fees,
    fundingOrSwap,
    openTrades: open.length,
    unrealizedPnl: sum(open.map((trade) => trade.unrealizedPnl ?? 0)),
  };
}

export function metricsBySymbol(trades: TradeRecord[], broker?: Broker): Record<string, TradingMetrics> {
  const scoped = broker ? trades.filter((trade) => trade.broker === broker) : trades;
  const symbols = [...new Set(scoped.map((trade) => trade.symbol))];
  return Object.fromEntries(symbols.map((symbol) => [symbol, calculateMetrics(scoped.filter((trade) => trade.symbol === symbol))]));
}

export function metricsByStrategy(trades: TradeRecord[], broker?: Broker): Record<string, TradingMetrics> {
  const scoped = broker ? trades.filter((trade) => trade.broker === broker) : trades;
  const strategies = [...new Set(scoped.map((trade) => trade.strategy))];
  return Object.fromEntries(strategies.map((strategy) => [strategy, calculateMetrics(scoped.filter((trade) => trade.strategy === strategy))]));
}

function sum(values: number[]): number {
  return values.reduce((acc, value) => acc + (Number.isFinite(value) ? value : 0), 0);
}
