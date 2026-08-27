import { BinanceMarketDataClient } from './binanceMarket.js';
import { defaultSettings } from './config.js';
import { auditV335Symbol, defaultAuditRules, type SymbolAuditResult } from './universeAuditCore.js';

const DAY = 24 * 60 * 60_000;
const endTime = Date.now() - 60_000;
const days = Math.max(3, Number(process.env.AUDIT_DAYS || 14));
const startTime = endTime - days * DAY;
const settings = { ...defaultSettings(), appMode: 'PAPER' as const, engineEnabled: false };
const market = new BinanceMarketDataClient(() => settings);
const rules = {
  ...defaultAuditRules(startTime, endTime),
  scanStepMinutes: Math.max(1, Number(process.env.AUDIT_STEP_MINUTES || 5)),
  roundTripCostPct: Math.max(0, Number(process.env.AUDIT_COST_PCT || 0.12)),
};

console.log(`UNIVERSE_AUDIT_START days=${days} step=${rules.scanStepMinutes}m cost=${rules.roundTripCostPct}%`);
const [symbolsAll, tickers] = await Promise.all([
  market.getTradableUsdtPerpetualSymbols(),
  market.getTicker24h(),
]);
const tickerMap = new Map(tickers.map((ticker) => [ticker.symbol, ticker]));
const symbols = symbolsAll
  .filter((symbol) => (tickerMap.get(symbol)?.quoteVolume ?? 0) > 2_000_000)
  .sort((a, b) => (tickerMap.get(b)?.quoteVolume ?? 0) - (tickerMap.get(a)?.quoteVolume ?? 0));

console.log(`UNIVERSE_AUDIT_ELIGIBLE ${symbols.length}/${symbolsAll.length} symbols (>2M USDT 24h volume)`);
const results: SymbolAuditResult[] = [];
const errors: Array<{ symbol: string; error: string }> = [];
const chunkSize = 3;

for (let i = 0; i < symbols.length; i += chunkSize) {
  const chunk = symbols.slice(i, i + chunkSize);
  const settled = await Promise.allSettled(chunk.map(async (symbol) => {
    const { ltf, htf } = await market.getDualHistoricalRange(symbol, startTime, endTime);
    return auditV335Symbol(symbol, ltf, htf, rules);
  }));

  settled.forEach((item, index) => {
    const symbol = chunk[index];
    if (item.status === 'fulfilled') results.push(item.value);
    else errors.push({ symbol, error: item.reason instanceof Error ? item.reason.message : String(item.reason) });
  });

  const done = Math.min(symbols.length, i + chunk.length);
  if (done % 15 === 0 || done === symbols.length) {
    console.log(`UNIVERSE_AUDIT_PROGRESS ${done}/${symbols.length} qualified=${results.filter((r) => r.qualified).length} errors=${errors.length}`);
  }
}

const qualified = results
  .filter((result) => result.qualified)
  .sort((a, b) => b.outOfSample.netReturnPct - a.outOfSample.netReturnPct || b.metrics.netReturnPct - a.metrics.netReturnPct);
const rejected = results.filter((result) => !result.qualified);

console.log(`UNIVERSE_AUDIT_COMPLETE tested=${results.length} qualified=${qualified.length} rejected=${rejected.length} errors=${errors.length}`);
console.log('QUALIFIED_SYMBOLS=' + qualified.map((result) => result.symbol).join(','));
console.log('QUALIFIED_TABLE_BEGIN');
for (const result of qualified) {
  const m = result.metrics;
  const o = result.outOfSample;
  console.log([
    result.symbol,
    `trades=${m.trades}`,
    `wr=${m.winRate.toFixed(1)}%`,
    `net=${m.netReturnPct.toFixed(3)}%`,
    `pf=${m.profitFactor == null ? 'INF' : m.profitFactor.toFixed(2)}`,
    `exp=${m.expectancyPct.toFixed(4)}%`,
    `dd=${m.maxDrawdownPct.toFixed(2)}%`,
    `oosTrades=${o.trades}`,
    `oosNet=${o.netReturnPct.toFixed(3)}%`,
    `oosPF=${o.profitFactor == null ? 'INF' : o.profitFactor.toFixed(2)}`,
  ].join(' | '));
}
console.log('QUALIFIED_TABLE_END');

const topRejected = rejected
  .filter((r) => r.metrics.trades >= 3)
  .sort((a, b) => b.metrics.netReturnPct - a.metrics.netReturnPct)
  .slice(0, 20);
console.log('TOP_REJECTED_BEGIN');
for (const result of topRejected) {
  console.log(`${result.symbol} | trades=${result.metrics.trades} | net=${result.metrics.netReturnPct.toFixed(3)}% | pf=${result.metrics.profitFactor == null ? 'INF' : result.metrics.profitFactor.toFixed(2)} | oosNet=${result.outOfSample.netReturnPct.toFixed(3)}% | ${result.reasons.join(',')}`);
}
console.log('TOP_REJECTED_END');
if (errors.length) {
  console.log('ERRORS_BEGIN');
  for (const item of errors.slice(0, 50)) console.log(`${item.symbol} | ${item.error}`);
  console.log('ERRORS_END');
}
