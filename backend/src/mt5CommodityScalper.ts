import crypto from 'node:crypto';
import { env } from './config.js';
import { TradingDatabase } from './database.js';
import { Mt5BridgeClient, type Mt5MarketSnapshot, type Mt5Tick } from './mt5.js';
import { TelegramService } from './telegram.js';
import type { AppMode, TradeSide } from './types.js';
import type { Candle } from './analysis.js';

export type Mt5CommodityKind = 'XAU' | 'CRUDE';

interface DetectedInstrument {
  kind: Mt5CommodityKind;
  symbol: string;
  display: 'XAUUSD' | 'CRUDE OIL';
  allowLong: boolean;
  allowShort: boolean;
  maxSpreadPct: number;
}

interface MicroBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  buyVolume: number;
  sellVolume: number;
}

interface Signal {
  side: TradeSide;
  score: number;
  reason: string;
  spreadPct: number;
  costPct: number;
  targetPct: number;
  stopPct: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  rsi: number;
  flowRatio: number;
  atrPct: number;
}

interface Cache {
  snapshot?: Mt5MarketSnapshot;
  candles: Candle[];
  microBars: MicroBar[];
  lastDiagnostic?: Record<string, unknown>;
  refreshedAt: number;
  lastSignalBucket?: number;
}

export interface Mt5CommodityTrade {
  id: string;
  venue: 'MT5';
  mode: AppMode;
  symbol: string;
  displaySymbol: string;
  side: TradeSide;
  state: 'OPEN' | 'CLOSED' | 'REJECTED';
  entryPrice: number;
  exitPrice?: number;
  stopLoss: number;
  takeProfit: number;
  quantity: number;
  leverage: number;
  marginUsed: number;
  notional: number;
  entrySpreadPct: number;
  estimatedRoundTripCostPct: number;
  entryFee: number;
  exitFee: number;
  realizedPnl: number;
  unrealizedPnl: number;
  openTime: number;
  closeTime?: number;
  closeReason?: string;
  orderId?: string;
  metadata?: Record<string, unknown>;
}

const XAU_PATTERNS = ['XAUUSD', 'GOLD', 'XAU/USD', 'XAU'];
const CRUDE_PATTERNS = ['USOIL', 'XTIUSD', 'WTI', 'CLUSD', 'CL', 'CRUDE', 'US OIL', 'OIL.WTI', 'WTICOUSD', 'UKOIL', 'BRENT', 'BRN'];

export class Mt5CommodityScalperService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private enabled = true;
  private detectedAt = 0;
  private instruments: DetectedInstrument[] = [];
  private readonly cache = new Map<Mt5CommodityKind, Cache>();

  constructor(
    private readonly database: TradingDatabase,
    private readonly mt5: Mt5BridgeClient,
    private readonly telegram: TelegramService,
    private readonly getMode: () => AppMode,
  ) {
    this.ensureSchema();
  }

  start(): void {
    if (this.timer) return;
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), env.COMMODITY_LOOP_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setEnabled(enabled: boolean): void { this.enabled = enabled; }
  isEnabled(): boolean { return this.enabled; }

  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const startedAt = Date.now();
    const mode = this.getMode();
    let opened = 0;
    let closed = 0;
    let errors = 0;
    const diagnostics: Record<string, unknown>[] = [];

    try {
      if (!this.enabled) {
        this.saveState({ status: 'PAUSED', enabled: false, mode, startedAt, completedAt: Date.now() });
        return;
      }

      const health = await this.mt5.health();
      if (!health.ok) throw new Error('MT5_BRIDGE_HEALTH_FALSE');
      await this.detectInstruments();

      for (const instrument of this.instruments) {
        try {
          const snapshot = await this.mt5.marketSnapshot(instrument.symbol);
          const cache = await this.refreshMarket(instrument, snapshot);
          if (await this.monitorOpenTrade(instrument, snapshot)) closed++;

          if (!this.getOpenTrade(instrument.symbol, mode)) {
            const signal = evaluate(instrument, snapshot, cache.candles, cache.microBars);
            cache.lastDiagnostic = signal
              ? {
                  action: signal.side,
                  score: signal.score,
                  reason: signal.reason,
                  spreadPct: signal.spreadPct,
                  costPct: signal.costPct,
                  targetPct: signal.targetPct,
                  stopPct: signal.stopPct,
                  rsi: signal.rsi,
                  takerBuyRatio: signal.flowRatio,
                  brokerLeverage: health.account.leverage,
                }
              : {
                  action: 'WAIT',
                  reason: 'NO_VALID_30S_1M_SETUP',
                  spreadPct: spreadPct(snapshot),
                  brokerLeverage: health.account.leverage,
                };

            if (signal) {
              const bucket = Math.floor(Date.now() / 30_000) * 30_000;
              if (cache.lastSignalBucket !== bucket) {
                const trade = await this.openTrade(instrument, signal, health.account.leverage);
                cache.lastSignalBucket = bucket;
                if (trade) opened++;
              }
            }
          }

          diagnostics.push({
            kind: instrument.kind,
            display: instrument.display,
            symbol: instrument.symbol,
            venue: 'MT5',
            allowedSides: instrument.allowShort ? 'BUY/SELL' : 'BUY_ONLY',
            brokerLeverage: health.account.leverage,
            book: {
              bid: snapshot.bid,
              ask: snapshot.ask,
              time: snapshot.timeMsc,
            },
            spreadPct: spreadPct(snapshot),
            spreadPoints: snapshot.spreadPoints,
            lastDiagnostic: cache.lastDiagnostic,
          });
        } catch (error) {
          errors++;
          diagnostics.push({ kind: instrument.kind, display: instrument.display, symbol: instrument.symbol, venue: 'MT5', error: message(error) });
        }
      }

      this.saveState({
        status: this.instruments.length === 0 ? 'SYMBOLS_NOT_FOUND' : errors === this.instruments.length ? 'DATA_ERROR' : errors ? 'RUNNING_WITH_ERRORS' : 'RUNNING',
        enabled: true,
        mode,
        startedAt,
        completedAt: Date.now(),
        opened,
        closed,
        errors,
        timeframe: '30s ticks / 1m context',
        account: {
          server: health.account.server,
          currency: health.account.currency,
          balance: health.account.balance,
          equity: health.account.equity,
          leverage: health.account.leverage,
          hedging: health.account.hedging,
        },
        instruments: diagnostics,
        paper: this.paperSummary(),
        policy: {
          costs: 'broker bid/ask spread + configured commission allowance + slippage allowance',
          marginPctPerTrade: env.COMMODITY_MARGIN_PCT,
          crudeBuyOnly: true,
          autoSymbolDetection: true,
        },
      });
    } catch (error) {
      this.saveState({ status: 'DATA_ERROR', enabled: true, mode, startedAt, completedAt: Date.now(), error: message(error), instruments: diagnostics });
    } finally {
      this.running = false;
    }
  }

  getState(): Record<string, unknown> {
    const row = this.database.db.prepare(`SELECT value,updated_at FROM engine_state WHERE key='mt5CommodityScalper'`).get() as { value: string; updated_at: number } | undefined;
    if (!row) return { status: 'STARTING', enabled: this.enabled };
    try { return { ...JSON.parse(row.value), updatedAt: row.updated_at, paper: this.paperSummary(), recentTrades: this.recentTrades(100) }; }
    catch { return { status: 'STATE_ERROR', enabled: this.enabled }; }
  }

  recentTrades(limit = 100): Mt5CommodityTrade[] {
    const rows = this.database.db.prepare(`SELECT * FROM commodity_trades WHERE venue='MT5' ORDER BY created_at DESC LIMIT ?`).all(Math.max(1, Math.min(500, limit))) as Record<string, unknown>[];
    return rows.map(mapTrade);
  }

  paperSummary(): Record<string, unknown> {
    const rows = this.database.db.prepare(`SELECT * FROM commodity_trades WHERE venue='MT5' AND mode='PAPER' ORDER BY created_at ASC`).all() as Record<string, unknown>[];
    const trades = rows.map(mapTrade);
    const closed = trades.filter((trade) => trade.state === 'CLOSED');
    const open = trades.filter((trade) => trade.state === 'OPEN');
    const realized = closed.reduce((sum, trade) => sum + trade.realizedPnl, 0);
    const floating = open.reduce((sum, trade) => sum + trade.unrealizedPnl, 0);
    const initial = env.PAPER_INITIAL_BALANCE;
    const balance = initial + realized;
    const wins = closed.filter((trade) => trade.realizedPnl > 0).length;
    let cumulative = 0;
    const equityCurve = closed.map((trade) => ({ time: trade.closeTime ?? trade.openTime, equity: initial + (cumulative += trade.realizedPnl) }));
    return {
      initialBalance: initial,
      balance,
      equity: balance + floating,
      realizedPnl: realized,
      floatingPnl: floating,
      openPositions: open.length,
      closedTrades: closed.length,
      wins,
      losses: closed.length - wins,
      winRate: closed.length ? wins / closed.length * 100 : 0,
      equityCurve,
      activeTrades: open,
    };
  }

  async chart(kind: Mt5CommodityKind): Promise<Record<string, unknown>> {
    await this.detectInstruments();
    const instrument = this.instruments.find((row) => row.kind === kind);
    if (!instrument) return { ok: false, kind, error: 'MT5_SYMBOL_NOT_FOUND' };
    const snapshot = await this.mt5.marketSnapshot(instrument.symbol);
    const cache = await this.refreshMarket(instrument, snapshot);
    const trades = this.recentTrades(200).filter((row) => row.symbol === instrument.symbol);
    return {
      ok: true,
      kind,
      venue: 'MT5',
      symbol: instrument.symbol,
      display: instrument.display,
      bid: snapshot.bid,
      ask: snapshot.ask,
      spreadPct: spreadPct(snapshot),
      m1: cache.candles.slice(-120),
      micro30s: cache.microBars.slice(-120),
      trades,
      updatedAt: Date.now(),
    };
  }

  private async detectInstruments(): Promise<void> {
    if (this.instruments.length && Date.now() - this.detectedAt < 5 * 60_000) return;
    const symbols = await this.mt5.symbols();
    const xau = pickSymbol(symbols.map((row) => row.name), XAU_PATTERNS, 'XAU');
    const crude = pickSymbol(symbols.map((row) => row.name), CRUDE_PATTERNS, 'CRUDE');
    this.instruments = [
      ...(xau ? [{ kind: 'XAU' as const, symbol: xau, display: 'XAUUSD' as const, allowLong: true, allowShort: true, maxSpreadPct: env.MT5_COMMODITY_MAX_SPREAD_PCT_XAU }] : []),
      ...(crude ? [{ kind: 'CRUDE' as const, symbol: crude, display: 'CRUDE OIL' as const, allowLong: true, allowShort: false, maxSpreadPct: env.MT5_COMMODITY_MAX_SPREAD_PCT_CL }] : []),
    ];
    this.detectedAt = Date.now();
  }

  private async refreshMarket(instrument: DetectedInstrument, snapshot: Mt5MarketSnapshot): Promise<Cache> {
    const current = this.cache.get(instrument.kind) ?? { candles: [], microBars: [], refreshedAt: 0 };
    current.snapshot = snapshot;
    if (!current.candles.length || Date.now() - current.refreshedAt >= 15_000) {
      const [candles, ticks] = await Promise.all([
        this.mt5.rates(instrument.symbol, 'M1', 180),
        this.mt5.ticks(instrument.symbol, 600, 10000),
      ]);
      current.candles = candles.filter((candle) => candle.time + 60_000 <= Date.now());
      current.microBars = buildMicroBars(ticks);
      current.refreshedAt = Date.now();
    }
    this.cache.set(instrument.kind, current);
    return current;
  }

  private async openTrade(instrument: DetectedInstrument, signal: Signal, accountLeverage: number): Promise<Mt5CommodityTrade | null> {
    if (instrument.kind === 'CRUDE' && signal.side !== 'BUY') return null;
    const mode = this.getMode();
    if (mode === 'TESTNET') return null;

    const size = await this.mt5.calculateSize({
      symbol: instrument.symbol,
      side: signal.side,
      entry: signal.entry,
      sl: signal.stopLoss,
      percent: env.COMMODITY_MARGIN_PCT,
      mode: 'MARGIN_PERCENT',
    });
    if (!(size.volume > 0)) return null;

    let fillPrice = signal.entry;
    let ticket = Number(String(Date.now()).slice(-9));
    let volume = size.volume;

    if (mode === 'REAL') {
      const order = await this.mt5.openOrder({
        symbol: instrument.symbol,
        side: signal.side,
        volume,
        sl: signal.stopLoss,
        tp: signal.takeProfit,
        comment: `R14-${instrument.kind}`,
      });
      fillPrice = Number(order.price || fillPrice);
      ticket = Number(order.ticket || ticket);
      volume = Number(order.volume || volume);
    }

    const takeProfit = signal.side === 'BUY' ? fillPrice * (1 + signal.targetPct / 100) : fillPrice * (1 - signal.targetPct / 100);
    const stopLoss = signal.side === 'BUY' ? fillPrice * (1 - signal.stopPct / 100) : fillPrice * (1 + signal.stopPct / 100);
    const trade: Mt5CommodityTrade = {
      id: `MT5CMD-${crypto.randomUUID()}`,
      venue: 'MT5',
      mode,
      symbol: instrument.symbol,
      displaySymbol: instrument.display,
      side: signal.side,
      state: 'OPEN',
      entryPrice: fillPrice,
      stopLoss,
      takeProfit,
      quantity: volume,
      leverage: Math.max(1, Number(accountLeverage || 1)),
      marginUsed: size.capitalTarget,
      notional: 0,
      entrySpreadPct: signal.spreadPct,
      estimatedRoundTripCostPct: signal.costPct,
      entryFee: 0,
      exitFee: 0,
      realizedPnl: 0,
      unrealizedPnl: 0,
      openTime: Date.now(),
      orderId: String(ticket),
      metadata: {
        strategy: 'R14_DUAL_COMMODITY_SCALPER_30S_1M',
        kind: instrument.kind,
        score: signal.score,
        reason: signal.reason,
        targetPct: signal.targetPct,
        stopPct: signal.stopPct,
        rsi: signal.rsi,
        flowRatio: signal.flowRatio,
        brokerSpreadIncluded: true,
        brokerLeverage: accountLeverage,
        sizing: size,
        crudeBuyOnly: instrument.kind === 'CRUDE',
      },
    };
    this.insertTrade(trade);
    await this.telegram.alert(
      `R14 MT5 ${instrument.display} ${signal.side}`,
      `${instrument.symbol}\nEntrada: ${fillPrice}\nSL: ${stopLoss}\nTP: ${takeProfit}\nSpread broker: ${signal.spreadPct.toFixed(4)}%\nLeverage cuenta: ${accountLeverage}x`,
    ).catch(() => undefined);
    return trade;
  }

  private async monitorOpenTrade(instrument: DetectedInstrument, snapshot: Mt5MarketSnapshot): Promise<boolean> {
    const trade = this.getOpenTrade(instrument.symbol, this.getMode());
    if (!trade) return false;
    const exit = trade.side === 'BUY'
      ? snapshot.bid * (1 - env.MT5_COMMODITY_SLIPPAGE_PCT / 100)
      : snapshot.ask * (1 + env.MT5_COMMODITY_SLIPPAGE_PCT / 100);

    if (trade.mode === 'REAL') {
      const positions = await this.mt5.positions(instrument.symbol);
      const ticket = Number(trade.orderId ?? 0);
      const active = positions.find((row) => row.ticket === ticket);
      if (!active) {
        const history = ticket ? await this.mt5.history(ticket).catch(() => null) : null;
        const actualExit = Number(history?.summary.exitPrice ?? exit);
        const actualNet = history
          ? history.summary.profit + history.summary.commission + history.summary.swap + history.summary.fee
          : await this.mt5.calculateProfit({ symbol: instrument.symbol, side: trade.side, volume: trade.quantity, entry: trade.entryPrice, exit: actualExit });
        await this.finishTrade(trade, actualExit, history?.summary.closeReason ?? 'BROKER_EXIT', actualNet);
        return true;
      }

      const expired = Date.now() - trade.openTime >= env.COMMODITY_MAX_HOLD_SECONDS * 1000;
      if (expired) {
        const result = await this.mt5.closePosition(active.ticket);
        const actualExit = Number(result.price || exit);
        const pnl = await this.mt5.calculateProfit({ symbol: instrument.symbol, side: trade.side, volume: trade.quantity, entry: trade.entryPrice, exit: actualExit });
        await this.finishTrade(trade, actualExit, 'TIME_EXIT', pnl);
        return true;
      }

      this.database.db.prepare(`UPDATE commodity_trades SET unrealized_pnl=?,updated_at=? WHERE id=?`).run(active.profit + active.swap, Date.now(), trade.id);
      return false;
    }

    const hitStop = trade.side === 'BUY' ? exit <= trade.stopLoss : exit >= trade.stopLoss;
    const hitTp = trade.side === 'BUY' ? exit >= trade.takeProfit : exit <= trade.takeProfit;
    const expired = Date.now() - trade.openTime >= env.COMMODITY_MAX_HOLD_SECONDS * 1000;
    const floating = await this.mt5.calculateProfit({ symbol: instrument.symbol, side: trade.side, volume: trade.quantity, entry: trade.entryPrice, exit });
    if (!hitStop && !hitTp && !expired) {
      this.database.db.prepare(`UPDATE commodity_trades SET unrealized_pnl=?,updated_at=? WHERE id=?`).run(floating, Date.now(), trade.id);
      return false;
    }
    const reason = hitStop ? 'SL' : hitTp ? 'TP' : 'TIME_EXIT';
    await this.finishTrade(trade, exit, reason, floating);
    return true;
  }

  private async finishTrade(trade: Mt5CommodityTrade, exitPrice: number, reason: string, pnl: number): Promise<void> {
    this.database.db.prepare(`
      UPDATE commodity_trades SET state='CLOSED',exit_price=?,realized_pnl=?,unrealized_pnl=0,close_time=?,close_reason=?,updated_at=? WHERE id=?
    `).run(exitPrice, pnl, Date.now(), reason, Date.now(), trade.id);
    await this.telegram.alert(`R14 MT5 ${trade.displaySymbol} CERRADA`, `${trade.side} · ${reason}\nPnL: ${pnl.toFixed(2)}\nEntrada: ${trade.entryPrice}\nSalida: ${exitPrice}`).catch(() => undefined);
  }

  private getOpenTrade(symbol: string, mode: AppMode): Mt5CommodityTrade | null {
    const row = this.database.db.prepare(`SELECT * FROM commodity_trades WHERE venue='MT5' AND symbol=? AND mode=? AND state='OPEN' ORDER BY open_time DESC LIMIT 1`).get(symbol, mode) as Record<string, unknown> | undefined;
    return row ? mapTrade(row) : null;
  }

  private insertTrade(trade: Mt5CommodityTrade): void {
    this.database.db.prepare(`
      INSERT INTO commodity_trades(
        id,venue,mode,symbol,display_symbol,side,state,entry_price,exit_price,stop_loss,take_profit,quantity,leverage,
        margin_used,notional,entry_spread_pct,estimated_round_trip_cost_pct,entry_fee,exit_fee,realized_pnl,unrealized_pnl,
        open_time,close_time,close_reason,order_id,metadata,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      trade.id, trade.venue, trade.mode, trade.symbol, trade.displaySymbol, trade.side, trade.state, trade.entryPrice,
      trade.exitPrice ?? null, trade.stopLoss, trade.takeProfit, trade.quantity, trade.leverage, trade.marginUsed, trade.notional,
      trade.entrySpreadPct, trade.estimatedRoundTripCostPct, trade.entryFee, trade.exitFee, trade.realizedPnl, trade.unrealizedPnl,
      trade.openTime, trade.closeTime ?? null, trade.closeReason ?? null, trade.orderId ?? null,
      trade.metadata ? JSON.stringify(trade.metadata) : null, Date.now(), Date.now(),
    );
  }

  private ensureSchema(): void {
    this.database.db.exec(`
      CREATE TABLE IF NOT EXISTS commodity_trades(
        id TEXT PRIMARY KEY, venue TEXT NOT NULL, mode TEXT NOT NULL, symbol TEXT NOT NULL, display_symbol TEXT NOT NULL,
        side TEXT NOT NULL, state TEXT NOT NULL, entry_price REAL NOT NULL, exit_price REAL, stop_loss REAL NOT NULL,
        take_profit REAL NOT NULL, quantity REAL NOT NULL, leverage REAL NOT NULL, margin_used REAL NOT NULL, notional REAL NOT NULL,
        entry_spread_pct REAL NOT NULL, estimated_round_trip_cost_pct REAL NOT NULL, entry_fee REAL NOT NULL DEFAULT 0,
        exit_fee REAL NOT NULL DEFAULT 0, realized_pnl REAL NOT NULL DEFAULT 0, unrealized_pnl REAL NOT NULL DEFAULT 0,
        open_time INTEGER NOT NULL, close_time INTEGER, close_reason TEXT, order_id TEXT, metadata TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      DROP INDEX IF EXISTS ux_commodity_active_mode_symbol;
      CREATE UNIQUE INDEX IF NOT EXISTS ux_commodity_active_venue_mode_symbol
        ON commodity_trades(venue,mode,symbol) WHERE state='OPEN';
      CREATE INDEX IF NOT EXISTS idx_commodity_close_time ON commodity_trades(close_time DESC);
    `);
  }

  private saveState(value: Record<string, unknown>): void {
    this.database.db.prepare(`
      INSERT INTO engine_state(key,value,updated_at) VALUES('mt5CommodityScalper',?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(JSON.stringify(value), Date.now());
  }
}

function evaluate(instrument: DetectedInstrument, snapshot: Mt5MarketSnapshot, candles: Candle[], microBars: MicroBar[]): Signal | null {
  if (candles.length < 40 || microBars.length < 2) return null;
  const spread = spreadPct(snapshot);
  if (!(spread >= 0) || spread > instrument.maxSpreadPct) return null;
  const closes = candles.map((row) => row.close);
  const e9s = emaSeries(closes, 9);
  const e21s = emaSeries(closes, 21);
  const e9 = e9s.at(-1) ?? 0;
  const e21 = e21s.at(-1) ?? 0;
  const e9Prev = e9s.at(-4) ?? e9;
  const rsiValue = rsi(closes, 14);
  const atrValue = atr(candles, 14);
  const mid = (snapshot.bid + snapshot.ask) / 2;
  if (!(atrValue > 0) || !(mid > 0)) return null;
  const atrPct = atrValue / mid * 100;
  const costPct = spread + env.MT5_COMMODITY_COMMISSION_PCT * 2 + env.MT5_COMMODITY_SLIPPAGE_PCT * 2;
  const targetPct = Math.max(costPct * env.COMMODITY_MIN_EDGE_MULTIPLE, atrPct * 0.65);
  const stopPct = Math.max(costPct * 1.25, atrPct * 0.40);
  if (!(targetPct > costPct) || targetPct > Math.max(1.2, atrPct * 8)) return null;

  const latest = microBars.at(-1)!;
  const previous = microBars.at(-2)!;
  const flowTotal = latest.buyVolume + latest.sellVolume;
  const flow = flowTotal > 0 ? latest.buyVolume / flowTotal : 0.5;
  const body = Math.abs(latest.close - latest.open);
  const displacement = body >= atrValue * 0.10;
  const pullbackLong = previous.low <= e9 + atrValue * 0.20;
  const pullbackShort = previous.high >= e9 - atrValue * 0.20;
  const longBreak = latest.close > previous.high && latest.close > latest.open;
  const shortBreak = latest.close < previous.low && latest.close < latest.open;
  const longTrend = e9 > e21 && e9 > e9Prev && rsiValue >= 52 && rsiValue <= 76;
  const shortTrend = e9 < e21 && e9 < e9Prev && rsiValue >= 24 && rsiValue <= 48;
  const longFlow = flow >= 0.54;
  const shortFlow = flow <= 0.46;

  if (instrument.allowLong && longTrend && pullbackLong && longBreak && displacement && longFlow) {
    const entry = snapshot.ask * (1 + env.MT5_COMMODITY_SLIPPAGE_PCT / 100);
    return {
      side: 'BUY', score: scoreSignal(Math.abs(e9 - e21) / atrValue, rsiValue, flow, spread, instrument.maxSpreadPct),
      reason: 'MT5_M1_UPTREND_30S_PULLBACK_BREAK', spreadPct: spread, costPct, targetPct, stopPct,
      entry, stopLoss: entry * (1 - stopPct / 100), takeProfit: entry * (1 + targetPct / 100),
      rsi: rsiValue, flowRatio: flow, atrPct,
    };
  }
  if (instrument.allowShort && shortTrend && pullbackShort && shortBreak && displacement && shortFlow) {
    const entry = snapshot.bid * (1 - env.MT5_COMMODITY_SLIPPAGE_PCT / 100);
    return {
      side: 'SELL', score: scoreSignal(Math.abs(e9 - e21) / atrValue, 100 - rsiValue, 1 - flow, spread, instrument.maxSpreadPct),
      reason: 'MT5_M1_DOWNTREND_30S_PULLBACK_BREAK', spreadPct: spread, costPct, targetPct, stopPct,
      entry, stopLoss: entry * (1 + stopPct / 100), takeProfit: entry * (1 - targetPct / 100),
      rsi: rsiValue, flowRatio: flow, atrPct,
    };
  }
  return null;
}

function pickSymbol(symbols: string[], patterns: string[], kind: Mt5CommodityKind): string | null {
  const scored = symbols.map((symbol) => {
    const upper = symbol.toUpperCase();
    let score = 0;
    for (let i = 0; i < patterns.length; i++) {
      const pattern = patterns[i].replace(/\s+/g, '').toUpperCase();
      const clean = upper.replace(/[^A-Z0-9]/g, '');
      if (clean === pattern.replace(/[^A-Z0-9]/g, '')) score = Math.max(score, 200 - i * 5);
      else if (clean.includes(pattern.replace(/[^A-Z0-9]/g, ''))) score = Math.max(score, 120 - i * 3);
    }
    if (kind === 'XAU' && upper.includes('XAU') && upper.includes('USD')) score += 80;
    if (kind === 'CRUDE' && (upper.includes('WTI') || upper.includes('USOIL') || upper.includes('XTI') || upper === 'CL')) score += 80;
    if (kind === 'CRUDE' && (upper.includes('BRENT') || upper.includes('UKOIL'))) score += 30;
    return { symbol, score };
  }).filter((row) => row.score > 0).sort((a, b) => b.score - a.score || a.symbol.length - b.symbol.length);
  return scored[0]?.symbol ?? null;
}

function buildMicroBars(ticks: Mt5Tick[]): MicroBar[] {
  const buckets = new Map<number, MicroBar>();
  for (const tick of ticks) {
    const time = Number(tick.timeMsc);
    const price = Number(tick.price || ((tick.bid + tick.ask) / 2));
    if (!(time > 0) || !(price > 0)) continue;
    const bucket = Math.floor(time / 30_000) * 30_000;
    let bar = buckets.get(bucket);
    if (!bar) {
      bar = { time: bucket, open: price, high: price, low: price, close: price, volume: 0, buyVolume: 0, sellVolume: 0 };
      buckets.set(bucket, bar);
    }
    bar.high = Math.max(bar.high, price);
    bar.low = Math.min(bar.low, price);
    bar.close = price;
    const volume = Math.max(0.000001, Number(tick.volume || 1));
    bar.volume += volume;
    // MT5 tick flags: BUY/SELL flags are exposed by the bridge when available.
    const isBuy = Boolean((tick as any).buy) || (!Boolean((tick as any).sell) && price >= (tick.ask || price));
    const isSell = Boolean((tick as any).sell) || (!Boolean((tick as any).buy) && price <= (tick.bid || price));
    if (isBuy && !isSell) bar.buyVolume += volume;
    else if (isSell && !isBuy) bar.sellVolume += volume;
    else { bar.buyVolume += volume * 0.5; bar.sellVolume += volume * 0.5; }
  }
  const now = Date.now();
  return [...buckets.values()].filter((bar) => bar.time + 30_000 <= now).sort((a, b) => a.time - b.time);
}

function spreadPct(snapshot: Mt5MarketSnapshot): number {
  const mid = (snapshot.bid + snapshot.ask) / 2;
  return mid > 0 ? Math.max(0, (snapshot.ask - snapshot.bid) / mid * 100) : Number.POSITIVE_INFINITY;
}

function emaSeries(values: number[], period: number): number[] {
  if (!values.length) return [];
  const alpha = 2 / (period + 1);
  const output = [values[0]];
  for (let i = 1; i < values.length; i++) output.push(values[i] * alpha + output[i - 1] * (1 - alpha));
  return output;
}

function rsi(values: number[], period: number): number {
  if (values.length <= period) return 50;
  let gain = 0;
  let loss = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    if (change >= 0) gain += change;
    else loss -= change;
  }
  if (loss === 0) return 100;
  const rs = gain / Math.max(loss, 1e-12);
  return 100 - 100 / (1 + rs);
}

function atr(candles: Candle[], period: number): number {
  const values: number[] = [];
  for (let i = Math.max(1, candles.length - period); i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];
    values.push(Math.max(current.high - current.low, Math.abs(current.high - previous.close), Math.abs(current.low - previous.close)));
  }
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function scoreSignal(trendStrength: number, momentum: number, flow: number, spread: number, maxSpread: number): number {
  const trend = Math.min(25, trendStrength * 30);
  const momentumScore = Math.min(20, Math.abs(momentum - 50) * 0.8);
  const flowScore = Math.min(25, Math.max(0, flow - 0.5) * 100);
  const spreadScore = Math.max(0, 20 * (1 - spread / Math.max(maxSpread, 1e-9)));
  return Math.round(Math.max(45, Math.min(95, 30 + trend + momentumScore + flowScore + spreadScore)));
}

function mapTrade(row: Record<string, unknown>): Mt5CommodityTrade {
  return {
    id: String(row.id), venue: 'MT5', mode: String(row.mode) as AppMode, symbol: String(row.symbol), displaySymbol: String(row.display_symbol),
    side: String(row.side) as TradeSide, state: String(row.state) as 'OPEN' | 'CLOSED' | 'REJECTED', entryPrice: Number(row.entry_price),
    exitPrice: row.exit_price == null ? undefined : Number(row.exit_price), stopLoss: Number(row.stop_loss), takeProfit: Number(row.take_profit),
    quantity: Number(row.quantity), leverage: Number(row.leverage), marginUsed: Number(row.margin_used), notional: Number(row.notional),
    entrySpreadPct: Number(row.entry_spread_pct), estimatedRoundTripCostPct: Number(row.estimated_round_trip_cost_pct), entryFee: Number(row.entry_fee ?? 0),
    exitFee: Number(row.exit_fee ?? 0), realizedPnl: Number(row.realized_pnl ?? 0), unrealizedPnl: Number(row.unrealized_pnl ?? 0), openTime: Number(row.open_time),
    closeTime: row.close_time == null ? undefined : Number(row.close_time), closeReason: row.close_reason == null ? undefined : String(row.close_reason),
    orderId: row.order_id == null ? undefined : String(row.order_id), metadata: row.metadata ? JSON.parse(String(row.metadata)) : undefined,
  };
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
