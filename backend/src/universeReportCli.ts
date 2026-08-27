import Database from 'better-sqlite3';
import { env } from './config.js';

type Metrics = {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  netReturnPct: number;
  profitFactor: number | null;
  expectancyPct: number;
  maxDrawdownPct: number;
};

type Row = {
  symbol: string;
  qualified: boolean;
  reasons: string[];
  metrics: Metrics;
  outOfSample: Metrics;
};

type State = {
  status: string;
  startedAt?: number;
  completedAt?: number;
  total?: number;
  completed?: number;
  current?: string;
  qualifiedSymbols?: string[];
  results?: Row[];
  errors?: Array<{ symbol: string; error: string }>;
  error?: string;
};

const db = new Database(env.DB_PATH, { readonly: true });
const row = db.prepare(`SELECT value FROM engine_state WHERE key='cryptoUniverseAudit'`).get() as { value: string } | undefined;
if (!row) {
  console.log('UNIVERSE_AUDIT: NOT_STARTED');
  process.exit(0);
}

const state = JSON.parse(row.value) as State;
console.log(`UNIVERSE_AUDIT: ${state.status}`);
console.log(`PROGRESS: ${state.completed ?? 0}/${state.total ?? 0}${state.current ? ` current=${state.current}` : ''}`);
if (state.startedAt) console.log(`STARTED: ${new Date(state.startedAt).toISOString()}`);
if (state.completedAt) console.log(`COMPLETED: ${new Date(state.completedAt).toISOString()}`);
if (state.error) console.log(`ERROR: ${state.error}`);

const results = state.results ?? [];
const qualified = results.filter((item) => item.qualified);
console.log(`QUALIFIED: ${qualified.length}`);
console.log(`QUALIFIED_SYMBOLS: ${(state.qualifiedSymbols ?? qualified.map((item) => item.symbol)).join(',') || 'NONE'}`);

if (qualified.length) {
  console.log('\n=== QUALIFIED / ENABLED ===');
  console.table(qualified.map((item) => ({
    symbol: item.symbol,
    trades: item.metrics.trades,
    WR: `${item.metrics.winRate.toFixed(1)}%`,
    net: `${item.metrics.netReturnPct.toFixed(3)}%`,
    PF: item.metrics.profitFactor == null ? 'INF' : item.metrics.profitFactor.toFixed(2),
    expectancy: `${item.metrics.expectancyPct.toFixed(4)}%`,
    DD: `${item.metrics.maxDrawdownPct.toFixed(2)}%`,
    OOS_trades: item.outOfSample.trades,
    OOS_net: `${item.outOfSample.netReturnPct.toFixed(3)}%`,
    OOS_PF: item.outOfSample.profitFactor == null ? 'INF' : item.outOfSample.profitFactor.toFixed(2),
  })));
}

const rejected = results.filter((item) => !item.qualified && item.metrics.trades > 0);
if (rejected.length) {
  console.log('\n=== TOP REJECTED (best net result first) ===');
  console.table(rejected
    .sort((a, b) => b.metrics.netReturnPct - a.metrics.netReturnPct)
    .slice(0, 30)
    .map((item) => ({
      symbol: item.symbol,
      trades: item.metrics.trades,
      WR: `${item.metrics.winRate.toFixed(1)}%`,
      net: `${item.metrics.netReturnPct.toFixed(3)}%`,
      PF: item.metrics.profitFactor == null ? 'INF' : item.metrics.profitFactor.toFixed(2),
      OOS_net: `${item.outOfSample.netReturnPct.toFixed(3)}%`,
      rejectedBy: item.reasons.join('|'),
    })));
}

if (state.errors?.length) {
  console.log('\n=== DATA ERRORS ===');
  console.table(state.errors.slice(-30));
}

db.close();
