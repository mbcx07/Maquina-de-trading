import crypto from 'node:crypto';
import { env } from './config.js';
import { effectiveSides, evaluateCommodityLiveR15, spreadPct, type CommodityBookR15, type CommodityCandleR15, type CommodityDiagnosticR15, type CommodityKindR15, type CommodityMicroBarR15, type CommoditySignalR15, type CrudeSideModeR15 } from './commodityStrategyR15.js';
import { TradingDatabase } from './database.js';
import { Mt5BridgeClient, type Mt5Account, type Mt5MarketSnapshot, type Mt5Tick } from './mt5.js';
import { TelegramService } from './telegram.js';
import type { AppMode, TradeSide } from './types.js';

interface DetectedInstrumentR15 {
  kind: CommodityKindR15;
  symbol: string;
  display: 'XAUUSD' | 'CRUDE OIL';
  maxSpreadPct: number;
}

interface CacheR15 {
  snapshot?: Mt5MarketSnapshot;
  candles: CommodityCandleR15[];
  micro: CommodityMicroBarR15[];
  refreshedAt: number;
  lastSignalBucket?: number;
  lastDiagnostic?: CommodityDiagnosticR15 & Record<string, unknown>;
}

export interface Mt5CommodityTradeR15 {
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

export class Mt5CommodityScalperR15 {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private enabled = true;
  private detectedAt = 0;
  private instruments: DetectedInstrumentR15[] = [];
  private readonly cache = new Map<CommodityKindR15, CacheR15>();
  private accountCache: Mt5Account | null = null;
  private accountAt = 0;
  private readonly paperStart: number;

  constructor(
    private readonly database: TradingDatabase,
    private readonly mt5: Mt5BridgeClient,
    private readonly telegram: TelegramService,
    private readonly getMode: () => AppMode,
    private readonly getCrudeSideMode: () => CrudeSideModeR15,
  ) {
    this.ensureSchema();
    this.paperStart = this.ensurePaperStart();
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

  setEnabled(value: boolean): void { this.enabled = value; }
  isEnabled(): boolean { return this.enabled; }

  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const startedAt = Date.now();
    const mode = this.getMode();
    try {
      if (!this.enabled) {
        this.saveState({ status: 'PAUSED', enabled: false, mode, completedAt: Date.now(), paper: this.paperSummary() });
        return;
      }
      const account = await this.getAccount();
      await this.detectInstruments();
      const results = await Promise.allSettled(this.instruments.map((instrument) => this.processInstrument(instrument, account, mode)));
      const instruments = results.map((result, index) => result.status === 'fulfilled'
        ? result.value
        : { kind: this.instruments[index]?.kind, symbol: this.instruments[index]?.symbol, venue: 'MT5', error: message(result.reason) });
      const errors = results.filter((row) => row.status === 'rejected').length;
      this.saveState({
        status: this.instruments.length === 0 ? 'SYMBOLS_NOT_FOUND' : errors === this.instruments.length ? 'DATA_ERROR' : errors ? 'RUNNING_WITH_ERRORS' : 'RUNNING',
        enabled: true,
        mode,
        startedAt,
        completedAt: Date.now(),
        errors,
        timeframe: '30s ticks / 1m context',
        account: {
          server: account.server,
          currency: account.currency,
          balance: account.balance,
          equity: account.equity,
          leverage: account.leverage,
          hedging: account.hedging,
        },
        instruments,
        paper: this.paperSummary(),
        policy: {
          strategy: 'R15_SCORE_CONFLUENCE',
          scoreThreshold: env.COMMODITY_SIGNAL_SCORE_MIN,
          costs: 'live broker bid/ask spread + commission allowance + slippage allowance',
          marginPctPerTrade: env.COMMODITY_MARGIN_PCT,
          paperInitialBalance: env.COMMODITY_PAPER_INITIAL_BALANCE,
          crudeSideMode: this.getCrudeSideMode(),
          autoSymbolDetection: true,
        },
      });
    } catch (error) {
      this.saveState({ status: 'DATA_ERROR', enabled: true, mode, startedAt, completedAt: Date.now(), error: message(error), paper: this.paperSummary() });
    } finally {
      this.running = false;
    }
  }

  getState(): Record<string, unknown> {
    const row = this.database.db.prepare(`SELECT value,updated_at FROM engine_state WHERE key='mt5CommodityR15'`).get() as { value: string; updated_at: number } | undefined;
    if (!row) return { status: 'STARTING', enabled: this.enabled, paper: this.paperSummary() };
    try { return { ...JSON.parse(row.value), updatedAt: row.updated_at, paper: this.paperSummary(), recentTrades: this.recentTrades(150) }; }
    catch { return { status: 'STATE_ERROR', enabled: this.enabled, paper: this.paperSummary() }; }
  }

  recentTrades(limit = 100): Mt5CommodityTradeR15[] {
    const rows = this.database.db.prepare(`SELECT * FROM commodity_trades WHERE venue='MT5' ORDER BY created_at DESC LIMIT ?`).all(Math.max(1, Math.min(500, limit))) as Record<string, unknown>[];
    return rows.map(mapTrade);
  }

  paperSummary(): Record<string, unknown> {
    const rows = this.database.db.prepare(`SELECT * FROM commodity_trades WHERE venue='MT5' AND mode='PAPER' AND created_at>=? ORDER BY created_at ASC`).all(this.paperStart) as Record<string, unknown>[];
    const trades = rows.map(mapTrade);
    const closed = trades.filter((row) => row.state === 'CLOSED');
    const open = trades.filter((row) => row.state === 'OPEN');
    const realized = closed.reduce((sum, row) => sum + row.realizedPnl, 0);
    const floating = open.reduce((sum, row) => sum + row.unrealizedPnl, 0);
    const initial = env.COMMODITY_PAPER_INITIAL_BALANCE;
    const wins = closed.filter((row) => row.realizedPnl > 0).length;
    let cumulative = 0;
    return {
      sessionStart: this.paperStart,
      initialBalance: initial,
      balance: initial + realized,
      equity: initial + realized + floating,
      realizedPnl: realized,
      floatingPnl: floating,
      openPositions: open.length,
      closedTrades: closed.length,
      wins,
      losses: closed.length - wins,
      winRate: closed.length ? wins / closed.length * 100 : 0,
      activeTrades: open,
      equityCurve: [{ time: this.paperStart, equity: initial }, ...closed.map((row) => ({ time: row.closeTime ?? row.openTime, equity: initial + (cumulative += row.realizedPnl) }))],
    };
  }

  async chart(kind: CommodityKindR15): Promise<Record<string, unknown>> {
    await this.detectInstruments();
    const instrument = this.instruments.find((row) => row.kind === kind);
    if (!instrument) return { ok: false, kind, error: 'MT5_SYMBOL_NOT_FOUND' };
    const snapshot = await this.mt5.marketSnapshot(instrument.symbol);
    const cache = await this.refreshMarket(instrument, snapshot, false);
    return {
      ok: true,
      kind,
      venue: 'MT5',
      symbol: instrument.symbol,
      display: instrument.display,
      bid: snapshot.bid,
      ask: snapshot.ask,
      spreadPct: mt5SpreadPct(snapshot),
      m1: cache.candles.slice(-180),
      micro30s: cache.micro.slice(-180),
      trades: this.recentTrades(250).filter((row) => row.symbol === instrument.symbol),
      diagnostic: cache.lastDiagnostic ?? null,
      updatedAt: Date.now(),
    };
  }

  async liveTick(kind: CommodityKindR15): Promise<Record<string, unknown>> {
    await this.detectInstruments();
    const instrument = this.instruments.find((row) => row.kind === kind);
    if (!instrument) return { kind, venue: 'MT5', error: 'MT5_SYMBOL_NOT_FOUND' };
    const snapshot = await this.mt5.marketSnapshot(instrument.symbol);
    const cache = this.cache.get(kind);
    return {
      kind,
      venue: 'MT5',
      symbol: instrument.symbol,
      bid: snapshot.bid,
      ask: snapshot.ask,
      spreadPct: mt5SpreadPct(snapshot),
      time: snapshot.timeMsc,
      microLast: cache?.micro.at(-1) ?? null,
      diagnostic: cache?.lastDiagnostic ?? null,
    };
  }

  private async processInstrument(instrument: DetectedInstrumentR15, account: Mt5Account, mode: AppMode): Promise<Record<string, unknown>> {
    const snapshot = await this.mt5.marketSnapshot(instrument.symbol);
    const cache = await this.refreshMarket(instrument, snapshot, false);
    await this.monitorOpenTrade(instrument, snapshot);
    const sides = effectiveSides(instrument.kind, this.getCrudeSideMode());
    const book: CommodityBookR15 = { bid: snapshot.bid, ask: snapshot.ask, time: snapshot.timeMsc };
    const diagnostic = evaluateCommodityLiveR15({
      kind: instrument.kind,
      allowLong: sides.allowLong,
      allowShort: sides.allowShort,
      maxSpreadPct: instrument.maxSpreadPct,
      feePct: env.MT5_COMMODITY_COMMISSION_PCT,
      slippagePct: env.MT5_COMMODITY_SLIPPAGE_PCT,
    }, book, cache.candles, cache.micro);
    cache.lastDiagnostic = { ...diagnostic, brokerLeverage: account.leverage };

    if (!this.getOpenTrade(instrument.symbol, mode) && diagnostic.signal) {
      const bucket = Math.floor(Date.now() / 30_000) * 30_000;
      if (cache.lastSignalBucket !== bucket) {
        await this.openTrade(instrument, diagnostic.signal, account);
        cache.lastSignalBucket = bucket;
      }
    }

    return {
      kind: instrument.kind,
      display: instrument.display,
      symbol: instrument.symbol,
      venue: 'MT5',
      allowedSides: sides.allowLong && sides.allowShort ? 'BUY/SELL' : sides.allowLong ? 'BUY_ONLY' : 'SELL_ONLY',
      brokerLeverage: account.leverage,
      book: { bid: snapshot.bid, ask: snapshot.ask, time: snapshot.timeMsc },
      spreadPct: mt5SpreadPct(snapshot),
      spreadPoints: snapshot.spreadPoints,
      lastDiagnostic: cache.lastDiagnostic,
    };
  }

  private async getAccount(): Promise<Mt5Account> {
    if (this.accountCache && Date.now() - this.accountAt < 15_000) return this.accountCache;
    const health = await this.mt5.health();
    if (!health.ok) throw new Error('MT5_BRIDGE_HEALTH_FALSE');
    this.accountCache = health.account;
    this.accountAt = Date.now();
    return health.account;
  }

  private async detectInstruments(): Promise<void> {
    if (this.instruments.length && Date.now() - this.detectedAt < 5 * 60_000) return;
    const symbols = await this.mt5.symbols();
    const names = symbols.map((row) => row.name);
    const xau = pickSymbol(names, XAU_PATTERNS, 'XAU');
    const crude = pickSymbol(names, CRUDE_PATTERNS, 'CRUDE');
    this.instruments = [
      ...(xau ? [{ kind: 'XAU' as const, symbol: xau, display: 'XAUUSD' as const, maxSpreadPct: env.MT5_COMMODITY_MAX_SPREAD_PCT_XAU }] : []),
      ...(crude ? [{ kind: 'CRUDE' as const, symbol: crude, display: 'CRUDE OIL' as const, maxSpreadPct: env.MT5_COMMODITY_MAX_SPREAD_PCT_CL }] : []),
    ];
    this.detectedAt = Date.now();
  }

  private async refreshMarket(instrument: DetectedInstrumentR15, snapshot: Mt5MarketSnapshot, force: boolean): Promise<CacheR15> {
    const cache = this.cache.get(instrument.kind) ?? { candles: [], micro: [], refreshedAt: 0 };
    cache.snapshot = snapshot;
    if (force || !cache.candles.length || Date.now() - cache.refreshedAt >= env.COMMODITY_MARKET_REFRESH_MS) {
      const [candles, ticks] = await Promise.all([
        this.mt5.rates(instrument.symbol, 'M1', 180),
        this.mt5.ticks(instrument.symbol, 720, 16000),
      ]);
      cache.candles = candles.filter((candle) => candle.time + 60_000 <= Date.now()).map((row) => ({ ...row, volume: Number(row.volume ?? 0) }));
      cache.micro = buildMicroBars(ticks);
      cache.refreshedAt = Date.now();
    }
    this.cache.set(instrument.kind, cache);
    return cache;
  }

  private async openTrade(instrument: DetectedInstrumentR15, signal: CommoditySignalR15, account: Mt5Account): Promise<Mt5CommodityTradeR15 | null> {
    const sides = effectiveSides(instrument.kind, this.getCrudeSideMode());
    if (signal.side === 'BUY' && !sides.allowLong) return null;
    if (signal.side === 'SELL' && !sides.allowShort) return null;
    const mode = this.getMode();
    if (mode === 'TESTNET') return null;
    if (mode === 'REAL' && !env.COMMODITY_ALLOW_REAL) return null;

    const brokerSize = await this.mt5.calculateSize({
      symbol: instrument.symbol,
      side: signal.side,
      entry: signal.entry,
      sl: signal.stopLoss,
      percent: env.COMMODITY_MARGIN_PCT,
      mode: 'MARGIN_PERCENT',
    });
    let volume = brokerSize.volume;
    let capitalTarget = brokerSize.capitalTarget;
    if (mode === 'PAPER') {
      const desired = Number(this.paperSummary().balance ?? env.COMMODITY_PAPER_INITIAL_BALANCE) * env.COMMODITY_MARGIN_PCT / 100;
      const ratio = brokerSize.capitalTarget > 0 ? desired / brokerSize.capitalTarget : 0;
      const raw = brokerSize.volume * ratio;
      volume = roundVolume(raw, brokerSize.volumeStep, brokerSize.volumeMin, brokerSize.volumeMax);
      capitalTarget = desired;
    }
    if (!(volume >= brokerSize.volumeMin) || !(volume > 0)) return null;

    let fillPrice = signal.entry;
    let ticket = Number(String(Date.now()).slice(-9));
    if (mode === 'REAL') {
      const order = await this.mt5.openOrder({
        symbol: instrument.symbol,
        side: signal.side,
        volume,
        sl: signal.stopLoss,
        tp: signal.takeProfit,
        comment: `R15-${instrument.kind}`,
      });
      fillPrice = Number(order.price || fillPrice);
      ticket = Number(order.ticket || ticket);
      volume = Number(order.volume || volume);
    }
    const takeProfit = signal.side === 'BUY' ? fillPrice * (1 + signal.targetPct / 100) : fillPrice * (1 - signal.targetPct / 100);
    const stopLoss = signal.side === 'BUY' ? fillPrice * (1 - signal.stopPct / 100) : fillPrice * (1 + signal.stopPct / 100);
    const trade: Mt5CommodityTradeR15 = {
      id: `MT5CMD15-${crypto.randomUUID()}`,
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
      leverage: Math.max(1, Number(account.leverage || 1)),
      marginUsed: capitalTarget,
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
        strategy: 'R15_SCORE_COMMODITY_30S_1M',
        kind: instrument.kind,
        score: signal.score,
        reason: signal.reason,
        components: signal.components,
        targetPct: signal.targetPct,
        stopPct: signal.stopPct,
        rsi: signal.rsi,
        flowRatio: signal.flow,
        brokerSpreadIncluded: true,
        brokerLeverage: account.leverage,
        paperVirtualBalance: mode === 'PAPER' ? env.COMMODITY_PAPER_INITIAL_BALANCE : undefined,
        sizing: brokerSize,
        crudeSideMode: this.getCrudeSideMode(),
      },
    };
    this.insertTrade(trade);
    await this.telegram.alert(`R15 MT5 ${instrument.display} ${signal.side}`, `${instrument.symbol}\nScore: ${signal.score}\nEntrada: ${fillPrice}\nSL: ${stopLoss}\nTP: ${takeProfit}\nSpread broker: ${signal.spreadPct.toFixed(4)}%`).catch(() => undefined);
    return trade;
  }

  private async monitorOpenTrade(instrument: DetectedInstrumentR15, snapshot: Mt5MarketSnapshot): Promise<boolean> {
    const trade = this.getOpenTrade(instrument.symbol, this.getMode());
    if (!trade) return false;
    const rawExit = trade.side === 'BUY' ? snapshot.bid : snapshot.ask;
    const exit = trade.side === 'BUY'
      ? rawExit * (1 - env.MT5_COMMODITY_SLIPPAGE_PCT / 100)
      : rawExit * (1 + env.MT5_COMMODITY_SLIPPAGE_PCT / 100);

    if (trade.mode === 'REAL') {
      const activePositions = await this.mt5.positions(instrument.symbol);
      const active = activePositions.find((row) => String(row.ticket) === String(trade.orderId)) ?? activePositions[0];
      if (!active) {
        const history = trade.orderId ? await this.mt5.history(Number(trade.orderId)).catch(() => null) : null;
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
    await this.finishTrade(trade, exit, hitStop ? 'SL' : hitTp ? 'TP' : 'TIME_EXIT', floating);
    return true;
  }

  private async finishTrade(trade: Mt5CommodityTradeR15, exitPrice: number, reason: string, pnl: number): Promise<void> {
    this.database.db.prepare(`UPDATE commodity_trades SET state='CLOSED',exit_price=?,realized_pnl=?,unrealized_pnl=0,close_time=?,close_reason=?,updated_at=? WHERE id=?`)
      .run(exitPrice, pnl, Date.now(), reason, Date.now(), trade.id);
    await this.telegram.alert(`R15 MT5 ${trade.displaySymbol} CERRADA`, `${trade.side} · ${reason}\nPnL: ${pnl.toFixed(2)}\nEntrada: ${trade.entryPrice}\nSalida: ${exitPrice}`).catch(() => undefined);
  }

  private getOpenTrade(symbol: string, mode: AppMode): Mt5CommodityTradeR15 | null {
    const row = this.database.db.prepare(`SELECT * FROM commodity_trades WHERE venue='MT5' AND symbol=? AND mode=? AND state='OPEN' ORDER BY open_time DESC LIMIT 1`).get(symbol, mode) as Record<string, unknown> | undefined;
    return row ? mapTrade(row) : null;
  }

  private insertTrade(trade: Mt5CommodityTradeR15): void {
    this.database.db.prepare(`INSERT INTO commodity_trades(
      id,venue,mode,symbol,display_symbol,side,state,entry_price,exit_price,stop_loss,take_profit,quantity,leverage,
      margin_used,notional,entry_spread_pct,estimated_round_trip_cost_pct,entry_fee,exit_fee,realized_pnl,unrealized_pnl,
      open_time,close_time,close_reason,order_id,metadata,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      trade.id,trade.venue,trade.mode,trade.symbol,trade.displaySymbol,trade.side,trade.state,trade.entryPrice,trade.exitPrice??null,trade.stopLoss,trade.takeProfit,trade.quantity,trade.leverage,
      trade.marginUsed,trade.notional,trade.entrySpreadPct,trade.estimatedRoundTripCostPct,trade.entryFee,trade.exitFee,trade.realizedPnl,trade.unrealizedPnl,trade.openTime,trade.closeTime??null,
      trade.closeReason??null,trade.orderId??null,trade.metadata?JSON.stringify(trade.metadata):null,Date.now(),Date.now(),
    );
  }

  private ensureSchema(): void {
    this.database.db.exec(`
      CREATE TABLE IF NOT EXISTS commodity_trades(
        id TEXT PRIMARY KEY,venue TEXT NOT NULL,mode TEXT NOT NULL,symbol TEXT NOT NULL,display_symbol TEXT NOT NULL,side TEXT NOT NULL,state TEXT NOT NULL,
        entry_price REAL NOT NULL,exit_price REAL,stop_loss REAL NOT NULL,take_profit REAL NOT NULL,quantity REAL NOT NULL,leverage REAL NOT NULL,margin_used REAL NOT NULL,
        notional REAL NOT NULL,entry_spread_pct REAL NOT NULL,estimated_round_trip_cost_pct REAL NOT NULL,entry_fee REAL NOT NULL DEFAULT 0,exit_fee REAL NOT NULL DEFAULT 0,
        realized_pnl REAL NOT NULL DEFAULT 0,unrealized_pnl REAL NOT NULL DEFAULT 0,open_time INTEGER NOT NULL,close_time INTEGER,close_reason TEXT,order_id TEXT,metadata TEXT,
        created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
      );
      DROP INDEX IF EXISTS ux_commodity_active_mode_symbol;
      CREATE UNIQUE INDEX IF NOT EXISTS ux_commodity_active_venue_mode_symbol ON commodity_trades(venue,mode,symbol) WHERE state='OPEN';
      CREATE INDEX IF NOT EXISTS idx_commodity_close_time ON commodity_trades(close_time DESC);
    `);
  }

  private ensurePaperStart(): number {
    const key = 'r15PaperStart:MT5';
    const row = this.database.db.prepare(`SELECT value FROM engine_state WHERE key=?`).get(key) as { value: string } | undefined;
    if (row && Number(row.value) > 0) return Number(row.value);
    const now = Date.now();
    this.database.db.prepare(`INSERT INTO engine_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(key, String(now), now);
    return now;
  }

  private saveState(value: Record<string, unknown>): void {
    this.database.db.prepare(`INSERT INTO engine_state(key,value,updated_at) VALUES('mt5CommodityR15',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
      .run(JSON.stringify(value), Date.now());
  }
}

function pickSymbol(symbols: string[], patterns: string[], kind: CommodityKindR15): string | null {
  const scored = symbols.map((symbol) => {
    const upper = symbol.toUpperCase();
    const clean = upper.replace(/[^A-Z0-9]/g, '');
    let score = 0;
    for (let i = 0; i < patterns.length; i++) {
      const pattern = patterns[i].replace(/[^A-Z0-9]/g, '').toUpperCase();
      if (clean === pattern) score = Math.max(score, 200 - i * 5);
      else if (clean.includes(pattern)) score = Math.max(score, 120 - i * 3);
    }
    if (kind === 'XAU' && upper.includes('XAU') && upper.includes('USD')) score += 80;
    if (kind === 'CRUDE' && (upper.includes('WTI') || upper.includes('USOIL') || upper.includes('XTI') || upper === 'CL')) score += 80;
    if (kind === 'CRUDE' && (upper.includes('BRENT') || upper.includes('UKOIL'))) score += 30;
    return { symbol, score };
  }).filter((row) => row.score > 0).sort((a, b) => b.score - a.score || a.symbol.length - b.symbol.length);
  return scored[0]?.symbol ?? null;
}

function buildMicroBars(ticks: Mt5Tick[]): CommodityMicroBarR15[] {
  const buckets = new Map<number, CommodityMicroBarR15>();
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
    const isBuy = Boolean((tick as any).buy) || (!Boolean((tick as any).sell) && price >= (tick.ask || price));
    const isSell = Boolean((tick as any).sell) || (!Boolean((tick as any).buy) && price <= (tick.bid || price));
    if (isBuy && !isSell) bar.buyVolume += volume;
    else if (isSell && !isBuy) bar.sellVolume += volume;
    else { bar.buyVolume += volume * 0.5; bar.sellVolume += volume * 0.5; }
  }
  const now = Date.now();
  return [...buckets.values()].filter((bar) => bar.time + 30_000 <= now).sort((a, b) => a.time - b.time);
}

function mt5SpreadPct(snapshot: Mt5MarketSnapshot): number {
  return spreadPct({ bid: snapshot.bid, ask: snapshot.ask, time: snapshot.timeMsc });
}

function roundVolume(value: number, step: number, min: number, max: number): number {
  if (!(value > 0) || !(step > 0)) return 0;
  const rounded = Math.floor((value + 1e-12) / step) * step;
  const bounded = Math.min(max, rounded);
  if (bounded + 1e-12 < min) return 0;
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)) + 1);
  return Number(bounded.toFixed(Math.min(8, decimals)));
}

function mapTrade(row: Record<string, unknown>): Mt5CommodityTradeR15 {
  let metadata: Record<string, unknown> | undefined;
  try { metadata = row.metadata ? JSON.parse(String(row.metadata)) : undefined; } catch {}
  return {
    id:String(row.id),venue:'MT5',mode:String(row.mode) as AppMode,symbol:String(row.symbol),displaySymbol:String(row.display_symbol),side:String(row.side) as TradeSide,state:String(row.state) as 'OPEN'|'CLOSED'|'REJECTED',
    entryPrice:Number(row.entry_price),exitPrice:row.exit_price==null?undefined:Number(row.exit_price),stopLoss:Number(row.stop_loss),takeProfit:Number(row.take_profit),quantity:Number(row.quantity),leverage:Number(row.leverage),
    marginUsed:Number(row.margin_used),notional:Number(row.notional),entrySpreadPct:Number(row.entry_spread_pct),estimatedRoundTripCostPct:Number(row.estimated_round_trip_cost_pct),entryFee:Number(row.entry_fee),exitFee:Number(row.exit_fee),
    realizedPnl:Number(row.realized_pnl),unrealizedPnl:Number(row.unrealized_pnl),openTime:Number(row.open_time),closeTime:row.close_time==null?undefined:Number(row.close_time),closeReason:row.close_reason==null?undefined:String(row.close_reason),orderId:row.order_id==null?undefined:String(row.order_id),metadata,
  };
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
