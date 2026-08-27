import type { Opportunity, SelectorContext, TradeRecord } from './types.js';

const ACTIVE_STATES = new Set(['PENDING', 'OPENING', 'OPEN', 'CLOSING', 'SYNC_REQUIRED']);

function isActiveTrade(trade: TradeRecord): boolean {
  return ACTIVE_STATES.has(trade.state);
}

export function selectCryptoOpportunities(
  opportunities: Opportunity[],
  ctx: SelectorContext,
): Opportunity[] {
  const activeCrypto = ctx.activeTrades.filter(
    (trade) => trade.broker === 'BINANCE' && isActiveTrade(trade),
  );

  const openSymbols = new Set(activeCrypto.map((trade) => trade.symbol.toUpperCase()));
  const freeSlots = Math.max(0, ctx.maxCryptoTrades - openSymbols.size);
  if (freeSlots === 0) return [];

  // Binance rule: one active position per symbol. If multiple signals for the
  // same coin arrive in one scan, only the highest-score setup is executable.
  const bestBySymbol = new Map<string, Opportunity>();

  for (const opportunity of opportunities) {
    if (opportunity.broker !== 'BINANCE') continue;

    const symbol = opportunity.symbol.toUpperCase();
    if (openSymbols.has(symbol)) continue;

    const previous = bestBySymbol.get(symbol);
    if (!previous || opportunity.score > previous.score) {
      bestBySymbol.set(symbol, opportunity);
    }
  }

  return [...bestBySymbol.values()]
    .sort((a, b) => b.score - a.score || b.confidence - a.confidence)
    .slice(0, freeSlots);
}

export function selectForexOpportunities(
  opportunities: Opportunity[],
  ctx: SelectorContext,
): Opportunity[] {
  const activeForex = ctx.activeTrades.filter(
    (trade) => trade.broker === 'MT5' && isActiveTrade(trade),
  );

  const freeSlots = Math.max(0, ctx.maxForexTrades - activeForex.length);
  if (freeSlots === 0) return [];

  const activeFingerprints = new Set(activeForex.map((trade) => trade.signalFingerprint));
  const selectedFingerprints = new Set<string>();

  const entriesBySymbol = new Map<string, number>();
  for (const trade of activeForex) {
    const symbol = trade.symbol.toUpperCase();
    entriesBySymbol.set(symbol, (entriesBySymbol.get(symbol) ?? 0) + 1);
  }

  const sorted = opportunities
    .filter((opportunity) => opportunity.broker === 'MT5')
    .sort((a, b) => b.score - a.score || b.confidence - a.confidence);

  const selected: Opportunity[] = [];

  for (const opportunity of sorted) {
    if (selected.length >= freeSlots) break;
    if (activeFingerprints.has(opportunity.signalFingerprint)) continue;
    if (selectedFingerprints.has(opportunity.signalFingerprint)) continue;

    const symbol = opportunity.symbol.toUpperCase();
    const currentEntries = entriesBySymbol.get(symbol) ?? 0;

    if (
      ctx.forexMaxEntriesPerSymbol > 0 &&
      currentEntries >= ctx.forexMaxEntriesPerSymbol
    ) {
      continue;
    }

    selected.push(opportunity);
    selectedFingerprints.add(opportunity.signalFingerprint);
    entriesBySymbol.set(symbol, currentEntries + 1);
  }

  return selected;
}

export function assertCryptoSymbolAvailable(symbol: string, trades: TradeRecord[]): void {
  const normalized = symbol.toUpperCase();
  const conflict = trades.some(
    (trade) =>
      trade.broker === 'BINANCE' &&
      trade.symbol.toUpperCase() === normalized &&
      isActiveTrade(trade),
  );

  if (conflict) {
    throw new Error(`CRYPTO_SYMBOL_ALREADY_ACTIVE:${normalized}`);
  }
}
