import crypto from 'node:crypto';
import { AsterV3Client, type AsterAggTrade } from './aster.js';
import { BinanceUsdmClient } from './binance.js';
import { env } from './config.js';
import { effectiveSides, evaluateCommodityLiveR15, spreadPct, type CommodityBookR15, type CommodityCandleR15, type CommodityDiagnosticR15, type CommodityKindR15, type CommodityMicroBarR15, type CommoditySignalR15, type CrudeSideModeR15 } from './commodityStrategyR15.js';
import { TradingDatabase } from './database.js';
import { TelegramService } from './telegram.js';
import type { AppMode, TradeSide } from './types.js';

interface InstrumentR15 {
  kind: CommodityKindR15;
  symbol: 'XAUUSDT' | 'CLUSDT';
  display: 'XAUUSD' | 'CRUDE OIL';
  venue: 'BINANCE' | 'ASTER';
  maxSpreadPct: number;
  feePct: number;
}

interface CacheR15 {
  book?: CommodityBookR15;
  candles: CommodityCandleR15[];
  micro: CommodityMicroBarR15[];
  refreshedAt: number;
  lastSignalBucket?: number;
  lastDiagnostic?: CommodityDiagnosticR15 & Record<string, unknown>;
}

export interface ExchangeCommodityTradeR15 {
  id: string;
  venue: 'BINANCE' | 'ASTER';
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

const INSTRUMENTS: InstrumentR15[] = [
  { kind: 'XAU', symbol: 'XAUUSDT', display: 'XAUUSD', venue: 'BINANCE', maxSpreadPct: env.COMMODITY_MAX_SPREAD_PCT_XAU, feePct: env.COMMODITY_TAKER_FEE_PCT_BINANCE },
  { kind: 'CRUDE', symbol: 'CLUSDT', display: 'CRUDE OIL', venue: 'ASTER', maxSpreadPct: env.COMMODITY_MAX_SPREAD_PCT_CL, feePct: env.COMMODITY_TAKER_FEE_PCT_ASTER },
];

export class ExchangeCommodityScalperR15 {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private enabled = true;
  private readonly cache = new Map<CommodityKindR15, CacheR15>();
  private readonly paperStart: number;

  constructor(
    private readonly database: TradingDatabase,
    private readonly binance: BinanceUsdmClient,
    private readonly aster: AsterV3Client,
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
    const mode = this.getMode();
    const startedAt = Date.now();
    try {
      if (!this.enabled) {
        this.saveState({ status: 'PAUSED', enabled: false, mode, completedAt: Date.now(), paper: this.paperSummary() });
        return;
      }
      const results = await Promise.allSettled(INSTRUMENTS.map((instrument) => this.processInstrument(instrument, mode)));
      const instruments = results.map((result, index) => result.status === 'fulfilled'
        ? result.value
        : { kind: INSTRUMENTS[index].kind, symbol: INSTRUMENTS[index].symbol, venue: INSTRUMENTS[index].venue, error: message(result.reason) });
      const errors = results.filter((row) => row.status === 'rejected').length;
      this.saveState({
        status: errors === INSTRUMENTS.length ? 'DATA_ERROR' : errors ? 'RUNNING_WITH_ERRORS' : 'RUNNING',
        enabled: true,
        mode,
        startedAt,
        completedAt: Date.now(),
        errors,
        timeframe: '30s microstructure / 1m context',
        instruments,
        paper: this.paperSummary(),
        policy: {
          strategy: 'R15_SCORE_CONFLUENCE',
          scoreThreshold: env.COMMODITY_SIGNAL_SCORE_MIN,
          maxLeverage: 'MAX_ALLOWED_BY_CONTRACT',
          marginPctPerTrade: env.COMMODITY_MARGIN_PCT,
          paperInitialBalance: env.COMMODITY_PAPER_INITIAL_BALANCE,
          costGate: `${env.COMMODITY_MIN_EDGE_MULTIPLE}x spread+fees+slippage`,
          crudeSideMode: this.getCrudeSideMode(),
        },
      });
    } finally {
      this.running = false;
    }
  }

  getState(): Record<string, unknown> {
    const row = this.database.db.prepare(`SELECT value,updated_at FROM engine_state WHERE key='exchangeCommodityR15'`).get() as { value: string; updated_at: number } | undefined;
    if (!row) return { status: 'STARTING', enabled: this.enabled, paper: this.paperSummary() };
    try { return { ...JSON.parse(row.value), updatedAt: row.updated_at, paper: this.paperSummary(), recentTrades: this.recentTrades(150) }; }
    catch { return { status: 'STATE_ERROR', enabled: this.enabled, paper: this.paperSummary() }; }
  }

  recentTrades(limit = 100): ExchangeCommodityTradeR15[] {
    const rows = this.database.db.prepare(`SELECT * FROM commodity_trades WHERE venue IN ('BINANCE','ASTER') ORDER BY created_at DESC LIMIT ?`).all(Math.max(1, Math.min(500, limit))) as Record<string, unknown>[];
    return rows.map(mapTrade);
  }

  paperSummary(): Record<string, unknown> {
    const rows = this.database.db.prepare(`SELECT * FROM commodity_trades WHERE venue IN ('BINANCE','ASTER') AND mode='PAPER' AND created_at>=? ORDER BY created_at ASC`).all(this.paperStart) as Record<string, unknown>[];
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
    const instrument = instrumentFor(kind);
    const market = await this.snapshot(instrument, false);
    return this.chartPayload(instrument, market.book, market.candles, market.micro);
  }

  async liveTick(kind: CommodityKindR15): Promise<Record<string, unknown>> {
    const instrument = instrumentFor(kind);
    const book = await this.fetchBook(instrument);
    const cache = this.cache.get(kind);
    return {
      kind,
      venue: instrument.venue,
      symbol: instrument.symbol,
      bid: book.bid,
      ask: book.ask,
      spreadPct: spreadPct(book),
      time: book.time,
      microLast: cache?.micro.at(-1) ?? null,
      diagnostic: cache?.lastDiagnostic ?? null,
    };
  }

  private async processInstrument(instrument: InstrumentR15, mode: AppMode): Promise<Record<string, unknown>> {
    const market = await this.snapshot(instrument, false);
    await this.monitor(instrument, market.book);
    const cache = this.cache.get(instrument.kind)!;
    const leverageInfo = await this.resolveMaxLeverage(instrument, mode);
    const sides = effectiveSides(instrument.kind, this.getCrudeSideMode());
    const diagnostic = evaluateCommodityLiveR15({
      kind: instrument.kind,
      allowLong: sides.allowLong,
      allowShort: sides.allowShort,
      maxSpreadPct: instrument.maxSpreadPct,
      feePct: instrument.feePct,
      slippagePct: env.COMMODITY_SLIPPAGE_PCT,
    }, market.book, market.candles, market.micro);
    cache.lastDiagnostic = {
      ...diagnostic,
      maxLeverage: leverageInfo.maxLeverage,
      maxLeverageSource: leverageInfo.source,
    };

    if (!this.getOpen(instrument, mode) && diagnostic.signal) {
      const bucket = Math.floor(Date.now() / 30_000) * 30_000;
      if (cache.lastSignalBucket !== bucket) {
        await this.open(instrument, diagnostic.signal, leverageInfo.maxLeverage);
        cache.lastSignalBucket = bucket;
      }
    }

    return {
      kind: instrument.kind,
      symbol: instrument.symbol,
      display: instrument.display,
      venue: instrument.venue,
      venueLabel: instrument.venue === 'BINANCE' ? 'Binance USD-M' : 'Aster / Binance Wallet',
      allowedSides: sides.allowLong && sides.allowShort ? 'BUY/SELL' : sides.allowLong ? 'BUY_ONLY' : 'SELL_ONLY',
      book: market.book,
      spreadPct: spreadPct(market.book),
      maxLeverage: leverageInfo.maxLeverage,
      maxLeverageSource: leverageInfo.source,
      lastDiagnostic: cache.lastDiagnostic,
    };
  }

  private async snapshot(instrument: InstrumentR15, forceHistory: boolean): Promise<{ book: CommodityBookR15; candles: CommodityCandleR15[]; micro: CommodityMicroBarR15[] }> {
    const cache = this.cache.get(instrument.kind) ?? { candles: [], micro: [], refreshedAt: 0 };
    const book = await this.fetchBook(instrument);
    cache.book = book;
    if (forceHistory || !cache.candles.length || Date.now() - cache.refreshedAt >= env.COMMODITY_MARKET_REFRESH_MS) {
      if (instrument.venue === 'BINANCE') {
        const [candles, agg] = await Promise.all([binanceKlines(instrument.symbol), binanceAgg(instrument.symbol)]);
        cache.candles = candles;
        cache.micro = buildMicroBars(agg);
      } else {
        const [candles, agg] = await Promise.all([this.aster.getKlines(instrument.symbol, '1m', 180), this.aster.getAggTrades(instrument.symbol)]);
        cache.candles = candles;
        cache.micro = buildMicroBars(agg);
      }
      cache.refreshedAt = Date.now();
    }
    this.cache.set(instrument.kind, cache);
    return { book, candles: cache.candles, micro: cache.micro };
  }

  private async fetchBook(instrument: InstrumentR15): Promise<CommodityBookR15> {
    return instrument.venue === 'BINANCE'
      ? binanceBook(instrument.symbol)
      : toAsterBook(await this.aster.getBookTicker(instrument.symbol));
  }

  private chartPayload(instrument: InstrumentR15, book: CommodityBookR15, candles: CommodityCandleR15[], micro: CommodityMicroBarR15[]): Record<string, unknown> {
    const cache = this.cache.get(instrument.kind);
    return {
      ok: true,
      kind: instrument.kind,
      venue: instrument.venue,
      venueLabel: instrument.venue === 'BINANCE' ? 'Binance USD-M' : 'Aster / Binance Wallet',
      symbol: instrument.symbol,
      display: instrument.display,
      bid: book.bid,
      ask: book.ask,
      spreadPct: spreadPct(book),
      m1: candles.slice(-180),
      micro30s: micro.slice(-180),
      trades: this.recentTrades(250).filter((row) => row.symbol === instrument.symbol),
      diagnostic: cache?.lastDiagnostic ?? null,
      updatedAt: Date.now(),
    };
  }

  private async resolveMaxLeverage(instrument: InstrumentR15, mode: AppMode): Promise<{ maxLeverage: number; source: string }> {
    if (instrument.venue === 'BINANCE') {
      if (this.binance.hasCredentials()) {
        try { return { maxLeverage: await this.binance.getMaxAllowedLeverage(instrument.symbol), source: 'BINANCE_LEVERAGE_BRACKET' }; }
        catch { /* fallback */ }
      }
      return { maxLeverage: 10, source: mode === 'PAPER' ? 'PAPER_FALLBACK_10X' : 'FALLBACK_10X' };
    }
    return { maxLeverage: await this.aster.getMaxAllowedLeverage(instrument.symbol), source: this.aster.hasCredentials() ? 'ASTER_LEVERAGE_BRACKET' : 'ASTER_PUBLIC_FALLBACK' };
  }

  private async open(instrument: InstrumentR15, signal: CommoditySignalR15, maxLeverage: number): Promise<ExchangeCommodityTradeR15 | null> {
    const sides = effectiveSides(instrument.kind, this.getCrudeSideMode());
    if (signal.side === 'BUY' && !sides.allowLong) return null;
    if (signal.side === 'SELL' && !sides.allowShort) return null;
    const mode = this.getMode();
    if (mode === 'TESTNET') return null;
    if (mode === 'REAL' && !env.COMMODITY_ALLOW_REAL) return null;

    let balance = Number(this.paperSummary().balance ?? env.COMMODITY_PAPER_INITIAL_BALANCE);
    let leverage = Math.max(1, Math.floor(maxLeverage));
    let meta: { minQty: number; stepSize: number; minNotional: number; quantityPrecision: number; pricePrecision: number };
    if (instrument.venue === 'BINANCE') {
      await this.binance.refreshExchangeInfo();
      const row = this.binance.getSymbolMeta(instrument.symbol);
      meta = { minQty: row.filters.minQty, stepSize: row.filters.stepSize, minNotional: row.filters.minNotional, quantityPrecision: row.quantityPrecision, pricePrecision: row.pricePrecision };
      if (mode === 'REAL') {
        if (!this.binance.hasCredentials()) throw new Error('BINANCE_CREDENTIALS_REQUIRED_FOR_XAU_REAL');
        balance = await this.binance.getFuturesBalance();
        leverage = await this.binance.setLeverage(instrument.symbol, maxLeverage);
      }
    } else {
      await this.aster.refreshExchangeInfo();
      meta = this.aster.getSymbolMeta(instrument.symbol);
      if (mode === 'REAL') {
        if (!this.aster.hasCredentials()) throw new Error('ASTER_CREDENTIALS_REQUIRED_FOR_CL_REAL');
        balance = (await this.aster.getBalance()).balance;
        leverage = await this.aster.setLeverage(instrument.symbol, maxLeverage);
      }
    }

    const margin = balance * env.COMMODITY_MARGIN_PCT / 100;
    const targetNotional = margin * leverage;
    if (targetNotional + 1e-9 < meta.minNotional) return null;
    const quantity = roundDown(targetNotional / signal.entry, meta.stepSize, meta.quantityPrecision);
    if (!(quantity >= meta.minQty)) return null;

    let fill = signal.entry;
    let orderId = `PAPER-${Date.now()}`;
    if (mode === 'REAL') {
      const order = instrument.venue === 'BINANCE'
        ? await this.binance.createMarketOrder(instrument.symbol, signal.side, quantity)
        : await this.aster.createMarketOrder(instrument.symbol, signal.side, quantity);
      fill = Number((order as any).avgPrice ?? (order as any).price ?? fill) || fill;
      orderId = String((order as any).orderId ?? (order as any).clientOrderId ?? orderId);
    }

    const tp = signal.side === 'BUY' ? fill * (1 + signal.targetPct / 100) : fill * (1 - signal.targetPct / 100);
    const sl = signal.side === 'BUY' ? fill * (1 - signal.stopPct / 100) : fill * (1 + signal.stopPct / 100);
    if (mode === 'REAL') {
      const exitSide: TradeSide = signal.side === 'BUY' ? 'SELL' : 'BUY';
      if (instrument.venue === 'BINANCE') {
        await this.binance.createCloseAllConditional(instrument.symbol, exitSide, 'STOP_MARKET', roundPrice(sl, meta.pricePrecision), `R15SL${Date.now()}`.slice(0, 32));
        await this.binance.createCloseAllConditional(instrument.symbol, exitSide, 'TAKE_PROFIT_MARKET', roundPrice(tp, meta.pricePrecision), `R15TP${Date.now()}`.slice(0, 32));
      } else {
        await this.aster.createCloseAllConditional(instrument.symbol, exitSide, 'STOP_MARKET', roundPrice(sl, meta.pricePrecision));
        await this.aster.createCloseAllConditional(instrument.symbol, exitSide, 'TAKE_PROFIT_MARKET', roundPrice(tp, meta.pricePrecision));
      }
    }

    const notional = quantity * fill;
    const entryFee = notional * instrument.feePct / 100;
    const row: ExchangeCommodityTradeR15 = {
      id: `EXCMD15-${crypto.randomUUID()}`,
      venue: instrument.venue,
      mode,
      symbol: instrument.symbol,
      displaySymbol: instrument.display,
      side: signal.side,
      state: 'OPEN',
      entryPrice: fill,
      stopLoss: sl,
      takeProfit: tp,
      quantity,
      leverage,
      marginUsed: margin,
      notional,
      entrySpreadPct: signal.spreadPct,
      estimatedRoundTripCostPct: signal.costPct,
      entryFee,
      exitFee: 0,
      realizedPnl: 0,
      unrealizedPnl: -entryFee,
      openTime: Date.now(),
      orderId,
      metadata: {
        strategy: 'R15_SCORE_COMMODITY_30S_1M',
        kind: instrument.kind,
        score: signal.score,
        reason: signal.reason,
        components: signal.components,
        rsi: signal.rsi,
        flow: signal.flow,
        targetPct: signal.targetPct,
        stopPct: signal.stopPct,
        crudeSideMode: this.getCrudeSideMode(),
        maxLeverageUsed: leverage,
      },
    };
    this.insert(row);
    await this.telegram.alert(`R15 ${instrument.display} ${signal.side}`, `${instrument.venue} ${instrument.symbol}\nScore: ${signal.score}\nEntrada: ${fill}\nSL: ${sl}\nTP: ${tp}\nLeverage: ${leverage}x\nSpread: ${signal.spreadPct.toFixed(4)}%`).catch(() => undefined);
    return row;
  }

  private async monitor(instrument: InstrumentR15, book: CommodityBookR15): Promise<boolean> {
    const trade = this.getOpen(instrument, this.getMode());
    if (!trade) return false;
    if (trade.mode === 'REAL') {
      const exists = instrument.venue === 'BINANCE'
        ? (await this.binance.getPositions()).some((row) => row.symbol === instrument.symbol)
        : (await this.aster.getPositions(instrument.symbol)).some((row) => row.symbol === instrument.symbol);
      if (!exists) { await this.finish(trade, trade.side === 'BUY' ? book.bid : book.ask, 'VENUE_EXIT'); return true; }
    }
    const raw = trade.side === 'BUY' ? book.bid : book.ask;
    const exit = trade.side === 'BUY' ? raw * (1 - env.COMMODITY_SLIPPAGE_PCT / 100) : raw * (1 + env.COMMODITY_SLIPPAGE_PCT / 100);
    const hitSl = trade.side === 'BUY' ? exit <= trade.stopLoss : exit >= trade.stopLoss;
    const hitTp = trade.side === 'BUY' ? exit >= trade.takeProfit : exit <= trade.takeProfit;
    const expired = Date.now() - trade.openTime >= env.COMMODITY_MAX_HOLD_SECONDS * 1000;
    const gross = trade.side === 'BUY' ? (exit - trade.entryPrice) * trade.quantity : (trade.entryPrice - exit) * trade.quantity;
    if (!hitSl && !hitTp && !expired) {
      this.database.db.prepare(`UPDATE commodity_trades SET unrealized_pnl=?,updated_at=? WHERE id=?`).run(gross - trade.entryFee, Date.now(), trade.id);
      return false;
    }
    if (trade.mode === 'REAL' && expired) {
      if (instrument.venue === 'BINANCE') {
        await this.binance.cancelAllAlgoOpenOrders(instrument.symbol).catch(() => undefined);
        await this.binance.createMarketOrder(instrument.symbol, trade.side === 'BUY' ? 'SELL' : 'BUY', trade.quantity);
      } else {
        await this.aster.cancelAllOpenOrders(instrument.symbol).catch(() => undefined);
        await this.aster.createMarketOrder(instrument.symbol, trade.side === 'BUY' ? 'SELL' : 'BUY', trade.quantity, true);
      }
    }
    await this.finish(trade, exit, hitSl ? 'SL' : hitTp ? 'TP' : 'TIME_EXIT');
    return true;
  }

  private async finish(trade: ExchangeCommodityTradeR15, exit: number, reason: string): Promise<void> {
    const instrument = INSTRUMENTS.find((row) => row.symbol === trade.symbol)!;
    const exitFee = trade.quantity * exit * instrument.feePct / 100;
    const gross = trade.side === 'BUY' ? (exit - trade.entryPrice) * trade.quantity : (trade.entryPrice - exit) * trade.quantity;
    const net = gross - trade.entryFee - exitFee;
    this.database.db.prepare(`UPDATE commodity_trades SET state='CLOSED',exit_price=?,exit_fee=?,realized_pnl=?,unrealized_pnl=0,close_time=?,close_reason=?,updated_at=? WHERE id=?`)
      .run(exit, exitFee, net, Date.now(), reason, Date.now(), trade.id);
  }

  private getOpen(instrument: InstrumentR15, mode: AppMode): ExchangeCommodityTradeR15 | null {
    const row = this.database.db.prepare(`SELECT * FROM commodity_trades WHERE venue=? AND symbol=? AND mode=? AND state='OPEN' ORDER BY open_time DESC LIMIT 1`).get(instrument.venue, instrument.symbol, mode) as Record<string, unknown> | undefined;
    return row ? mapTrade(row) : null;
  }

  private insert(row: ExchangeCommodityTradeR15): void {
    this.database.db.prepare(`INSERT INTO commodity_trades(
      id,venue,mode,symbol,display_symbol,side,state,entry_price,exit_price,stop_loss,take_profit,quantity,leverage,
      margin_used,notional,entry_spread_pct,estimated_round_trip_cost_pct,entry_fee,exit_fee,realized_pnl,unrealized_pnl,
      open_time,close_time,close_reason,order_id,metadata,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      row.id,row.venue,row.mode,row.symbol,row.displaySymbol,row.side,row.state,row.entryPrice,row.exitPrice??null,row.stopLoss,row.takeProfit,row.quantity,row.leverage,
      row.marginUsed,row.notional,row.entrySpreadPct,row.estimatedRoundTripCostPct,row.entryFee,row.exitFee,row.realizedPnl,row.unrealizedPnl,row.openTime,row.closeTime??null,
      row.closeReason??null,row.orderId??null,row.metadata?JSON.stringify(row.metadata):null,Date.now(),Date.now(),
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
    const key = 'r15PaperStart:EXCHANGE';
    const row = this.database.db.prepare(`SELECT value FROM engine_state WHERE key=?`).get(key) as { value: string } | undefined;
    if (row && Number(row.value) > 0) return Number(row.value);
    const now = Date.now();
    this.database.db.prepare(`INSERT INTO engine_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(key, String(now), now);
    return now;
  }

  private saveState(value: Record<string, unknown>): void {
    this.database.db.prepare(`INSERT INTO engine_state(key,value,updated_at) VALUES('exchangeCommodityR15',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
      .run(JSON.stringify(value), Date.now());
  }
}

function instrumentFor(kind: CommodityKindR15): InstrumentR15 {
  return INSTRUMENTS.find((row) => row.kind === kind)!;
}

async function binanceBook(symbol: string): Promise<CommodityBookR15> {
  const response = await fetch(`${env.BINANCE_BASE_URL.replace(/\/$/,'')}/fapi/v1/ticker/bookTicker?symbol=${encodeURIComponent(symbol)}`);
  if (!response.ok) throw new Error(`BINANCE_BOOK_HTTP_${response.status}:${symbol}`);
  const row = await response.json() as any;
  return { bid:Number(row.bidPrice??0),ask:Number(row.askPrice??0),bidQty:Number(row.bidQty??0),askQty:Number(row.askQty??0),time:Number(row.time??Date.now()) };
}

async function binanceKlines(symbol: string): Promise<CommodityCandleR15[]> {
  const response = await fetch(`${env.BINANCE_BASE_URL.replace(/\/$/,'')}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=1m&limit=180`);
  if (!response.ok) throw new Error(`BINANCE_KLINES_HTTP_${response.status}:${symbol}`);
  const rows = await response.json() as any[];
  const now = Date.now();
  return rows.filter((row)=>Number(row[6]??0)<=now).map((row)=>({time:Number(row[0]),open:Number(row[1]),high:Number(row[2]),low:Number(row[3]),close:Number(row[4]),volume:Number(row[5]??0)}));
}

async function binanceAgg(symbol: string): Promise<Array<{ price:number; qty:number; time:number; buyerIsMaker:boolean }>> {
  const response = await fetch(`${env.BINANCE_BASE_URL.replace(/\/$/,'')}/fapi/v1/aggTrades?symbol=${encodeURIComponent(symbol)}&limit=1000`);
  if (!response.ok) throw new Error(`BINANCE_AGG_HTTP_${response.status}:${symbol}`);
  const rows=await response.json() as any[];
  return rows.map((row)=>({price:Number(row.p??0),qty:Number(row.q??0),time:Number(row.T??0),buyerIsMaker:Boolean(row.m)})).filter((row)=>row.price>0&&row.qty>0&&row.time>0);
}

function toAsterBook(row: any): CommodityBookR15 {
  return { bid:row.bidPrice,ask:row.askPrice,bidQty:row.bidQty,askQty:row.askQty,time:row.time };
}

function buildMicroBars(rows: Array<{ price:number; qty:number; time:number; buyerIsMaker:boolean }|AsterAggTrade>): CommodityMicroBarR15[] {
  const map=new Map<number,CommodityMicroBarR15>();
  const now=Date.now();
  for(const row of rows){
    const time=Number(row.time);
    if(time<now-12*60_000) continue;
    const bucket=Math.floor(time/30_000)*30_000;
    let bar=map.get(bucket);
    if(!bar){bar={time:bucket,open:Number(row.price),high:Number(row.price),low:Number(row.price),close:Number(row.price),volume:0,buyVolume:0,sellVolume:0};map.set(bucket,bar);}
    const p=Number(row.price),q=Number(row.qty);
    bar.high=Math.max(bar.high,p);bar.low=Math.min(bar.low,p);bar.close=p;bar.volume+=q;
    if(row.buyerIsMaker)bar.sellVolume+=q;else bar.buyVolume+=q;
  }
  return [...map.values()].filter((bar)=>bar.time+30_000<=now).sort((a,b)=>a.time-b.time);
}

function mapTrade(row:Record<string,unknown>):ExchangeCommodityTradeR15{
  let metadata:Record<string,unknown>|undefined;
  try{metadata=row.metadata?JSON.parse(String(row.metadata)):undefined;}catch{}
  return {id:String(row.id),venue:String(row.venue) as 'BINANCE'|'ASTER',mode:String(row.mode) as AppMode,symbol:String(row.symbol),displaySymbol:String(row.display_symbol),side:String(row.side) as TradeSide,state:String(row.state) as 'OPEN'|'CLOSED'|'REJECTED',entryPrice:Number(row.entry_price),exitPrice:row.exit_price==null?undefined:Number(row.exit_price),stopLoss:Number(row.stop_loss),takeProfit:Number(row.take_profit),quantity:Number(row.quantity),leverage:Number(row.leverage),marginUsed:Number(row.margin_used),notional:Number(row.notional),entrySpreadPct:Number(row.entry_spread_pct),estimatedRoundTripCostPct:Number(row.estimated_round_trip_cost_pct),entryFee:Number(row.entry_fee),exitFee:Number(row.exit_fee),realizedPnl:Number(row.realized_pnl),unrealizedPnl:Number(row.unrealized_pnl),openTime:Number(row.open_time),closeTime:row.close_time==null?undefined:Number(row.close_time),closeReason:row.close_reason==null?undefined:String(row.close_reason),orderId:row.order_id==null?undefined:String(row.order_id),metadata};
}

function roundDown(value:number,step:number,precision:number):number{if(!(step>0))return Number(value.toFixed(precision));const units=Math.floor((value+1e-12)/step);return Number((units*step).toFixed(precision));}
function roundPrice(value:number,precision:number):number{return Number(value.toFixed(Math.max(0,precision)));}
function message(error:unknown):string{return error instanceof Error?error.message:String(error);}
