import { spreadPct, type CommodityBookR15, type CommodityCandleR15, type CommodityKindR15, type CommodityMicroBarR15, type CommoditySignalR15 } from './commodityStrategyR15.js';
import type { TradeSide } from './types.js';

export type ConsensusFamilyR18 =
  | 'EMA_TREND' | 'MOMENTUM' | 'BREAKOUT' | 'PULLBACK' | 'RSI'
  | 'BOLLINGER' | 'VWAP' | 'FLOW' | 'VOLUME_EXPANSION' | 'CANDLE_STRUCTURE';

export interface ConsensusVoteR18 {
  id: string;
  family: ConsensusFamilyR18;
  variant: number;
  side: TradeSide;
  strength: number;
  reason: string;
}

export interface ConsensusConfigR18 {
  kind: CommodityKindR15;
  allowLong: boolean;
  allowShort: boolean;
  maxSpreadPct: number;
  feePct: number;
  slippagePct: number;
  minVotes?: number;
  minFamilies?: number;
  minVoteLead?: number;
}

export interface ConsensusDiagnosticR18 {
  action: 'BUY' | 'SELL' | 'WAIT';
  reason: string;
  strategyCount: 100;
  minVotes: number;
  minFamilies: number;
  minVoteLead: number;
  buyVotes: number;
  sellVotes: number;
  neutralStrategies: number;
  buyFamilies: number;
  sellFamilies: number;
  winningFamilies: string[];
  spreadPct: number;
  costPct: number;
  targetPct: number;
  stopPct: number;
  atr30Pct: number;
  atr1mPct: number;
  confidencePct: number;
  blockedBy?: string;
  votes: ConsensusVoteR18[];
  signal?: CommoditySignalR15;
}

export function evaluateConsensus100R18(
  config: ConsensusConfigR18,
  book: CommodityBookR15,
  m1: CommodityCandleR15[],
  micro: CommodityMicroBarR15[],
): ConsensusDiagnosticR18 {
  const minVotes = Math.max(5, Math.floor(config.minVotes ?? 5));
  const minFamilies = Math.max(1, Math.floor(config.minFamilies ?? 3));
  const minVoteLead = Math.max(0, Math.floor(config.minVoteLead ?? 2));
  const spread = spreadPct(book);
  const base = (): ConsensusDiagnosticR18 => ({
    action: 'WAIT', reason: 'CALIBRATING', strategyCount: 100, minVotes, minFamilies, minVoteLead,
    buyVotes: 0, sellVotes: 0, neutralStrategies: 100, buyFamilies: 0, sellFamilies: 0,
    winningFamilies: [], spreadPct: spread, costPct: 0, targetPct: 0, stopPct: 0,
    atr30Pct: 0, atr1mPct: 0, confidencePct: 0, votes: [],
  });
  if (m1.length < 60 || micro.length < 30) return { ...base(), reason: 'INSUFFICIENT_HISTORY' };
  if (!(book.bid > 0) || !(book.ask > book.bid)) return { ...base(), reason: 'INVALID_BOOK', blockedBy: 'BOOK' };
  if (spread > config.maxSpreadPct) return { ...base(), reason: 'SPREAD_TOO_WIDE', blockedBy: 'SPREAD' };

  const closedMicro = micro.slice(-120);
  const votes = generate100Votes(m1.slice(-180), closedMicro);
  const buy = votes.filter(v => v.side === 'BUY');
  const sell = votes.filter(v => v.side === 'SELL');
  const buyFamilySet = new Set(buy.map(v => v.family));
  const sellFamilySet = new Set(sell.map(v => v.family));
  const atr30 = atr(closedMicro, 14);
  const atr1 = atr(m1, 14);
  const mid = (book.bid + book.ask) / 2;
  const atr30Pct = mid > 0 ? atr30 / mid * 100 : 0;
  const atr1mPct = mid > 0 ? atr1 / mid * 100 : 0;
  const costPct = spread + config.feePct * 2 + config.slippagePct * 2;
  const targetPct = Math.max(costPct * 2.6, atr30Pct * 2.2, atr1mPct * 0.9);
  const stopPct = Math.max(costPct * 1.25, atr30Pct * 1.15, targetPct * 0.48);

  let side: TradeSide | null = null;
  const buyQualified = config.allowLong && buy.length >= minVotes && buyFamilySet.size >= minFamilies && buy.length >= sell.length + minVoteLead;
  const sellQualified = config.allowShort && sell.length >= minVotes && sellFamilySet.size >= minFamilies && sell.length >= buy.length + minVoteLead;
  if (buyQualified && sellQualified) side = buy.length >= sell.length ? 'BUY' : 'SELL';
  else if (buyQualified) side = 'BUY';
  else if (sellQualified) side = 'SELL';

  const dominant = Math.max(buy.length, sell.length);
  const confidencePct = dominant / 100 * 100;
  const result: ConsensusDiagnosticR18 = {
    action: side ?? 'WAIT',
    reason: side ? 'CONSENSUS_5PLUS_MET' : 'CONSENSUS_NOT_MET',
    strategyCount: 100, minVotes, minFamilies, minVoteLead,
    buyVotes: buy.length, sellVotes: sell.length,
    neutralStrategies: 100 - buy.length - sell.length,
    buyFamilies: buyFamilySet.size, sellFamilies: sellFamilySet.size,
    winningFamilies: [...(side === 'BUY' ? buyFamilySet : side === 'SELL' ? sellFamilySet : new Set<ConsensusFamilyR18>())],
    spreadPct: spread, costPct, targetPct, stopPct, atr30Pct, atr1mPct, confidencePct,
    votes,
  };
  if (!side) return result;
  if (!(targetPct > costPct * 2)) return { ...result, action: 'WAIT', reason: 'EDGE_DOES_NOT_COVER_COST', blockedBy: 'COST' };

  const entry = side === 'BUY'
    ? book.ask * (1 + config.slippagePct / 100)
    : book.bid * (1 - config.slippagePct / 100);
  const stopLoss = side === 'BUY' ? entry * (1 - stopPct / 100) : entry * (1 + stopPct / 100);
  const takeProfit = side === 'BUY' ? entry * (1 + targetPct / 100) : entry * (1 - targetPct / 100);
  const winners = side === 'BUY' ? buy : sell;
  const signal: CommoditySignalR15 = {
    side,
    score: dominant,
    reason: `R18_CONSENSUS_${dominant}_OF_100`,
    spreadPct: spread,
    costPct,
    targetPct,
    stopPct,
    entry,
    stopLoss,
    takeProfit,
    rsi: rsi(m1.map(x => x.close), 14),
    flow: flowRatio(closedMicro.slice(-4)),
    atrPct: atr1mPct,
    components: winners.map(v => `${v.id}:${v.reason}`),
  };
  return { ...result, signal, reason: signal.reason };
}

function generate100Votes(m1: CommodityCandleR15[], micro: CommodityMicroBarR15[]): ConsensusVoteR18[] {
  const out: ConsensusVoteR18[] = [];
  for (let v = 0; v < 10; v++) {
    pushVote(out, 'EMA_TREND', v, voteEma(micro, v));
    pushVote(out, 'MOMENTUM', v, voteMomentum(micro, v));
    pushVote(out, 'BREAKOUT', v, voteBreakout(micro, v));
    pushVote(out, 'PULLBACK', v, votePullback(m1, micro, v));
    pushVote(out, 'RSI', v, voteRsi(micro, v));
    pushVote(out, 'BOLLINGER', v, voteBollinger(micro, v));
    pushVote(out, 'VWAP', v, voteVwap(micro, v));
    pushVote(out, 'FLOW', v, voteFlow(micro, v));
    pushVote(out, 'VOLUME_EXPANSION', v, voteVolume(micro, v));
    pushVote(out, 'CANDLE_STRUCTURE', v, voteCandle(micro, v));
  }
  return out;
}

function pushVote(out: ConsensusVoteR18[], family: ConsensusFamilyR18, variant: number, vote: { side: TradeSide | null; strength: number; reason: string }): void {
  if (!vote.side) return;
  out.push({ id: `${family}_${String(variant + 1).padStart(2, '0')}`, family, variant: variant + 1, side: vote.side, strength: vote.strength, reason: vote.reason });
}

function voteEma(b: CommodityMicroBarR15[], v: number) {
  const c = b.map(x => x.close), fast = 3 + v, slow = 10 + v * 2;
  const ef = ema(c, fast), es = ema(c, slow), prev = ema(c.slice(0, -2), fast);
  if (ef > es && ef > prev) return V('BUY', Math.min(100, (ef / es - 1) * 1e5), `EMA${fast}>EMA${slow}`);
  if (ef < es && ef < prev) return V('SELL', Math.min(100, (es / ef - 1) * 1e5), `EMA${fast}<EMA${slow}`);
  return N('EMA_FLAT');
}
function voteMomentum(b: CommodityMicroBarR15[], v: number) {
  const n = 2 + v, last = b.at(-1)!.close, old = b.at(-1 - n)?.close ?? last, pct = (last / old - 1) * 100, th = 0.008 + v * 0.004;
  if (pct >= th) return V('BUY', Math.abs(pct / th) * 20, `ROC${n} +${pct.toFixed(3)}%`);
  if (pct <= -th) return V('SELL', Math.abs(pct / th) * 20, `ROC${n} ${pct.toFixed(3)}%`);
  return N('MOMENTUM_LOW');
}
function voteBreakout(b: CommodityMicroBarR15[], v: number) {
  const n = 4 + v, x = b.at(-1)!, hist = b.slice(-1 - n, -1), hi = Math.max(...hist.map(y => y.high)), lo = Math.min(...hist.map(y => y.low));
  if (x.close > hi) return V('BUY', 70, `BREAKOUT_${n}`);
  if (x.close < lo) return V('SELL', 70, `BREAKDOWN_${n}`);
  return N('IN_RANGE');
}
function votePullback(m1: CommodityCandleR15[], b: CommodityMicroBarR15[], v: number) {
  const c = m1.map(x => x.close), fast = 8 + v, slow = 20 + v, ef = ema(c, fast), es = ema(c, slow), x = b.at(-1)!, p = b.at(-2)!;
  const tol = atr(b, 14) * (0.15 + v * 0.03);
  if (ef > es && p.low <= x.open + tol && x.close > p.high) return V('BUY', 65, `PULLBACK_RECLAIM_${fast}`);
  if (ef < es && p.high >= x.open - tol && x.close < p.low) return V('SELL', 65, `PULLBACK_REJECT_${fast}`);
  return N('NO_PULLBACK_TRIGGER');
}
function voteRsi(b: CommodityMicroBarR15[], v: number) {
  const period = 6 + v, rv = rsi(b.map(x => x.close), period), up = 53 + v * 0.8, dn = 47 - v * 0.8;
  if (rv >= up) return V('BUY', Math.min(100, rv), `RSI${period}_${rv.toFixed(1)}`);
  if (rv <= dn) return V('SELL', Math.min(100, 100 - rv), `RSI${period}_${rv.toFixed(1)}`);
  return N('RSI_NEUTRAL');
}
function voteBollinger(b: CommodityMicroBarR15[], v: number) {
  const n = 10 + v, a = b.slice(-n).map(x => x.close), last = a.at(-1)!, avg = mean(a), sd = std(a), z = sd > 0 ? (last - avg) / sd : 0, th = 0.55 + v * 0.1;
  if (z >= th) return V('BUY', Math.min(100, z * 30), `BOLL_Z_${z.toFixed(2)}`);
  if (z <= -th) return V('SELL', Math.min(100, -z * 30), `BOLL_Z_${z.toFixed(2)}`);
  return N('BOLL_MID');
}
function voteVwap(b: CommodityMicroBarR15[], v: number) {
  const n = 10 + v * 2, a = b.slice(-n), vv = a.reduce((s, x) => s + x.close * Math.max(x.volume, 1e-9), 0) / a.reduce((s, x) => s + Math.max(x.volume, 1e-9), 0), last = a.at(-1)!.close;
  const pct = (last / vv - 1) * 100, th = 0.006 + v * 0.003;
  if (pct >= th) return V('BUY', Math.min(100, pct / th * 20), `VWAP+${pct.toFixed(3)}%`);
  if (pct <= -th) return V('SELL', Math.min(100, -pct / th * 20), `VWAP${pct.toFixed(3)}%`);
  return N('VWAP_NEUTRAL');
}
function voteFlow(b: CommodityMicroBarR15[], v: number) {
  const n = 2 + v, f = flowRatio(b.slice(-n)), th = 0.525 + v * 0.008;
  if (f >= th) return V('BUY', Math.min(100, f * 100), `BUY_FLOW_${(f * 100).toFixed(1)}%`);
  if (f <= 1 - th) return V('SELL', Math.min(100, (1 - f) * 100), `SELL_FLOW_${((1 - f) * 100).toFixed(1)}%`);
  return N('FLOW_BALANCED');
}
function voteVolume(b: CommodityMicroBarR15[], v: number) {
  const n = 5 + v, x = b.at(-1)!, avg = mean(b.slice(-1 - n, -1).map(y => y.volume)), ratio = avg > 0 ? x.volume / avg : 0, th = 1.05 + v * 0.1;
  if (ratio >= th && x.close > x.open) return V('BUY', Math.min(100, ratio * 30), `VOL_EXP_${ratio.toFixed(2)}x`);
  if (ratio >= th && x.close < x.open) return V('SELL', Math.min(100, ratio * 30), `VOL_EXP_${ratio.toFixed(2)}x`);
  return N('VOLUME_NORMAL');
}
function voteCandle(b: CommodityMicroBarR15[], v: number) {
  const x = b.at(-1)!, p = b.at(-2)!, range = Math.max(1e-12, x.high - x.low), body = Math.abs(x.close - x.open) / range, th = 0.35 + v * 0.04;
  if (body >= th && x.close > x.open && x.close > p.close) return V('BUY', body * 100, `BULL_BODY_${body.toFixed(2)}`);
  if (body >= th && x.close < x.open && x.close < p.close) return V('SELL', body * 100, `BEAR_BODY_${body.toFixed(2)}`);
  return N('CANDLE_WEAK');
}

function V(side: TradeSide, strength: number, reason: string) { return { side, strength: Math.max(0, Math.min(100, strength)), reason }; }
function N(reason: string) { return { side: null as TradeSide | null, strength: 0, reason }; }
function mean(a: number[]): number { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }
function std(a: number[]): number { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); }
function ema(a: number[], period: number): number { if (!a.length) return 0; const k = 2 / (period + 1); let e = a[0]; for (let i = 1; i < a.length; i++) e = a[i] * k + e * (1 - k); return e; }
function rsi(a: number[], period: number): number { if (a.length < period + 1) return 50; let up = 0, dn = 0; for (let i = a.length - period; i < a.length; i++) { const d = a[i] - a[i - 1]; if (d > 0) up += d; else dn -= d; } if (dn === 0) return up > 0 ? 100 : 50; const rs = up / dn; return 100 - 100 / (1 + rs); }
function atr(a: CommodityCandleR15[], period: number): number { if (a.length < 2) return 0; const tr: number[] = []; for (let i = Math.max(1, a.length - period); i < a.length; i++) tr.push(Math.max(a[i].high - a[i].low, Math.abs(a[i].high - a[i - 1].close), Math.abs(a[i].low - a[i - 1].close))); return mean(tr); }
function flowRatio(a: CommodityMicroBarR15[]): number { const buy = a.reduce((s, x) => s + x.buyVolume, 0), sell = a.reduce((s, x) => s + x.sellVolume, 0); return buy + sell > 0 ? buy / (buy + sell) : 0.5; }
