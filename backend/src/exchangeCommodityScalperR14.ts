import crypto from 'node:crypto';
import { AsterV3Client, type AsterAggTrade } from './aster.js';
import { BinanceUsdmClient } from './binance.js';
import { env } from './config.js';
import { TradingDatabase } from './database.js';
import { TelegramService } from './telegram.js';
import type { AppMode, TradeSide } from './types.js';

export type ExchangeCommodityKind = 'XAU' | 'CRUDE';
type Venue = 'BINANCE' | 'ASTER';

interface Instrument {
  kind: ExchangeCommodityKind;
  symbol: 'XAUUSDT' | 'CLUSDT';
  display: 'XAUUSD' | 'CRUDE OIL';
  venue: Venue;
  allowLong: boolean;
  allowShort: boolean;
  maxSpreadPct: number;
  feePct: number;
}

interface Book { bid: number; ask: number; bidQty: number; askQty: number; time: number }
interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }
interface Agg { price: number; qty: number; time: number; buyerIsMaker: boolean }
interface MicroBar { time: number; open: number; high: number; low: number; close: number; volume: number; buyVolume: number; sellVolume: number }
interface Cache { book?: Book; candles: Candle[]; micro: MicroBar[]; refreshedAt: number; lastSignalBucket?: number; lastDiagnostic?: Record<string, unknown> }

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
  flow: number;
  atrPct: number;
}

export interface ExchangeCommodityTrade {
  id: string;
  venue: Venue;
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

const INSTRUMENTS: Instrument[] = [
  { kind: 'XAU', symbol: 'XAUUSDT', display: 'XAUUSD', venue: 'BINANCE', allowLong: true, allowShort: true, maxSpreadPct: env.COMMODITY_MAX_SPREAD_PCT_XAU, feePct: env.COMMODITY_TAKER_FEE_PCT_BINANCE },
  { kind: 'CRUDE', symbol: 'CLUSDT', display: 'CRUDE OIL', venue: 'ASTER', allowLong: true, allowShort: false, maxSpreadPct: env.COMMODITY_MAX_SPREAD_PCT_CL, feePct: env.COMMODITY_TAKER_FEE_PCT_ASTER },
];

export class ExchangeCommodityScalperR14 {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private enabled = true;
  private readonly cache = new Map<ExchangeCommodityKind, Cache>();

  constructor(
    private readonly database: TradingDatabase,
    private readonly binance: BinanceUsdmClient,
    private readonly aster: AsterV3Client,
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

  setEnabled(value: boolean): void { this.enabled = value; }
  isEnabled(): boolean { return this.enabled; }

  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const startedAt = Date.now();
    const mode = this.getMode();
    let opened = 0;
    let closed = 0;
    let errors = 0;
    const instruments: Record<string, unknown>[] = [];

    try {
      if (!this.enabled) {
        this.saveState({ status: 'PAUSED', enabled: false, mode, completedAt: Date.now() });
        return;
      }

      for (const instrument of INSTRUMENTS) {
        try {
          const market = await this.snapshot(instrument);
          if (await this.monitor(instrument, market.book)) closed++;
          const cache = this.cache.get(instrument.kind)!;
          const leverageInfo = await this.resolveMaxLeverage(instrument, mode);

          if (!this.getOpen(instrument, mode)) {
            const signal = evaluate(instrument, market.book, market.candles, market.micro);
            cache.lastDiagnostic = signal
              ? {
                  action: signal.side, score: signal.score, reason: signal.reason,
                  spreadPct: signal.spreadPct, costPct: signal.costPct,
                  targetPct: signal.targetPct, stopPct: signal.stopPct,
                  rsi: signal.rsi, takerBuyRatio: signal.flow,
                  maxLeverage: leverageInfo.maxLeverage,
                  maxLeverageSource: leverageInfo.source,
                }
              : {
                  action: 'WAIT', reason: 'NO_VALID_30S_1M_SETUP', spreadPct: spreadPct(market.book),
                  maxLeverage: leverageInfo.maxLeverage, maxLeverageSource: leverageInfo.source,
                };

            if (signal) {
              const bucket = Math.floor(Date.now() / 30_000) * 30_000;
              if (cache.lastSignalBucket !== bucket) {
                const row = await this.open(instrument, signal, leverageInfo.maxLeverage);
                cache.lastSignalBucket = bucket;
                if (row) opened++;
              }
            }
          }

          instruments.push({
            kind: instrument.kind,
            symbol: instrument.symbol,
            display: instrument.display,
            venue: instrument.venue,
            venueLabel: instrument.venue === 'BINANCE' ? 'Binance USD-M' : 'Aster / Binance Wallet',
            allowedSides: instrument.allowShort ? 'BUY/SELL' : 'BUY_ONLY',
            book: market.book,
            spreadPct: spreadPct(market.book),
            maxLeverage: leverageInfo.maxLeverage,
            maxLeverageSource: leverageInfo.source,
            lastDiagnostic: cache.lastDiagnostic,
          });
        } catch (error) {
          errors++;
          instruments.push({ kind: instrument.kind, symbol: instrument.symbol, venue: instrument.venue, error: message(error) });
        }
      }

      this.saveState({
        status: errors === INSTRUMENTS.length ? 'DATA_ERROR' : errors ? 'RUNNING_WITH_ERRORS' : 'RUNNING',
        enabled: true,
        mode,
        startedAt,
        completedAt: Date.now(),
        opened,
        closed,
        errors,
        timeframe: '30s aggTrades / 1m context',
        instruments,
        paper: this.paperSummary(),
        policy: {
          maxLeverage: 'MAX_ALLOWED_BY_CONTRACT',
          marginPctPerTrade: env.COMMODITY_MARGIN_PCT,
          costGate: `${env.COMMODITY_MIN_EDGE_MULTIPLE}x spread+fees+slippage`,
          crudeBuyOnly: true,
        },
      });
    } finally {
      this.running = false;
    }
  }

  getState(): Record<string, unknown> {
    const row = this.database.db.prepare(`SELECT value,updated_at FROM engine_state WHERE key='exchangeCommodityR14'`).get() as { value: string; updated_at: number } | undefined;
    if (!row) return { status: 'STARTING', enabled: this.enabled };
    try { return { ...JSON.parse(row.value), updatedAt: row.updated_at, paper: this.paperSummary(), recentTrades: this.recentTrades(100) }; }
    catch { return { status: 'STATE_ERROR', enabled: this.enabled }; }
  }

  recentTrades(limit = 100): ExchangeCommodityTrade[] {
    const rows = this.database.db.prepare(`SELECT * FROM commodity_trades WHERE venue IN ('BINANCE','ASTER') ORDER BY created_at DESC LIMIT ?`).all(Math.max(1, Math.min(500, limit))) as Record<string, unknown>[];
    return rows.map(mapTrade);
  }

  paperSummary(): Record<string, unknown> {
    const rows = this.database.db.prepare(`SELECT * FROM commodity_trades WHERE venue IN ('BINANCE','ASTER') AND mode='PAPER' ORDER BY created_at ASC`).all() as Record<string, unknown>[];
    const trades = rows.map(mapTrade);
    const closed = trades.filter((row) => row.state === 'CLOSED');
    const open = trades.filter((row) => row.state === 'OPEN');
    const realized = closed.reduce((sum, row) => sum + row.realizedPnl, 0);
    const floating = open.reduce((sum, row) => sum + row.unrealizedPnl, 0);
    const initial = env.PAPER_INITIAL_BALANCE;
    const wins = closed.filter((row) => row.realizedPnl > 0).length;
    let cumulative = 0;
    return {
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
      equityCurve: closed.map((row) => ({ time: row.closeTime ?? row.openTime, equity: initial + (cumulative += row.realizedPnl) })),
    };
  }

  async chart(kind: ExchangeCommodityKind): Promise<Record<string, unknown>> {
    const instrument = INSTRUMENTS.find((row) => row.kind === kind)!;
    const market = await this.snapshot(instrument);
    const trades = this.recentTrades(200).filter((row) => row.symbol === instrument.symbol);
    return {
      ok: true,
      kind,
      venue: instrument.venue,
      venueLabel: instrument.venue === 'BINANCE' ? 'Binance USD-M' : 'Aster / Binance Wallet',
      symbol: instrument.symbol,
      display: instrument.display,
      bid: market.book.bid,
      ask: market.book.ask,
      spreadPct: spreadPct(market.book),
      m1: market.candles.slice(-120),
      micro30s: market.micro.slice(-120),
      trades,
      updatedAt: Date.now(),
    };
  }

  private async snapshot(instrument: Instrument): Promise<{ book: Book; candles: Candle[]; micro: MicroBar[] }> {
    const cache = this.cache.get(instrument.kind) ?? { candles: [], micro: [], refreshedAt: 0 };
    const book = instrument.venue === 'BINANCE'
      ? await binanceBook(instrument.symbol)
      : toAsterBook(await this.aster.getBookTicker(instrument.symbol));
    cache.book = book;

    if (!cache.candles.length || Date.now() - cache.refreshedAt >= 15_000) {
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

  private async resolveMaxLeverage(instrument: Instrument, mode: AppMode): Promise<{ maxLeverage: number; source: string }> {
    if (instrument.venue === 'BINANCE') {
      if (this.binance.hasCredentials()) {
        try { return { maxLeverage: await this.binance.getMaxAllowedLeverage(instrument.symbol), source: 'BINANCE_LEVERAGE_BRACKET' }; }
        catch { /* fallback below */ }
      }
      return { maxLeverage: 10, source: mode === 'PAPER' ? 'PAPER_FALLBACK_10X' : 'FALLBACK_10X' };
    }
    return { maxLeverage: await this.aster.getMaxAllowedLeverage(instrument.symbol), source: this.aster.hasCredentials() ? 'ASTER_LEVERAGE_BRACKET' : 'ASTER_PUBLIC_FALLBACK_20X' };
  }

  private async open(instrument: Instrument, signal: Signal, maxLeverage: number): Promise<ExchangeCommodityTrade | null> {
    if (instrument.kind === 'CRUDE' && signal.side !== 'BUY') return null;
    const mode = this.getMode();
    if (mode === 'TESTNET') return null;
    if (mode === 'REAL' && !env.COMMODITY_ALLOW_REAL) return null;

    let balance = Number(this.paperSummary().balance ?? env.PAPER_INITIAL_BALANCE);
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
      const row = this.aster.getSymbolMeta(instrument.symbol);
      meta = row;
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
      if (instrument.venue === 'BINANCE') {
        const order = await this.binance.createMarketOrder(instrument.symbol, signal.side, quantity);
        fill = Number(order.avgPrice ?? order.price ?? fill) || fill;
        orderId = String(order.orderId ?? order.clientOrderId ?? orderId);
      } else {
        const order = await this.aster.createMarketOrder(instrument.symbol, 'BUY', quantity);
        fill = Number(order.avgPrice ?? order.price ?? fill) || fill;
        orderId = String(order.orderId ?? orderId);
      }
    }

    const tp = signal.side === 'BUY' ? fill * (1 + signal.targetPct / 100) : fill * (1 - signal.targetPct / 100);
    const sl = signal.side === 'BUY' ? fill * (1 - signal.stopPct / 100) : fill * (1 + signal.stopPct / 100);
    if (mode === 'REAL') {
      const exitSide: TradeSide = signal.side === 'BUY' ? 'SELL' : 'BUY';
      if (instrument.venue === 'BINANCE') {
        await this.binance.createCloseAllConditional(instrument.symbol, exitSide, 'STOP_MARKET', roundPrice(sl, meta.pricePrecision), `R14SL${Date.now()}`.slice(0, 32));
        await this.binance.createCloseAllConditional(instrument.symbol, exitSide, 'TAKE_PROFIT_MARKET', roundPrice(tp, meta.pricePrecision), `R14TP${Date.now()}`.slice(0, 32));
      } else {
        await this.aster.createCloseAllConditional(instrument.symbol, exitSide, 'STOP_MARKET', roundPrice(sl, meta.pricePrecision));
        await this.aster.createCloseAllConditional(instrument.symbol, exitSide, 'TAKE_PROFIT_MARKET', roundPrice(tp, meta.pricePrecision));
      }
    }

    const notional = quantity * fill;
    const entryFee = notional * instrument.feePct / 100;
    const row: ExchangeCommodityTrade = {
      id: `EXCMD-${crypto.randomUUID()}`, venue: instrument.venue, mode, symbol: instrument.symbol, displaySymbol: instrument.display,
      side: signal.side, state: 'OPEN', entryPrice: fill, stopLoss: sl, takeProfit: tp, quantity, leverage,
      marginUsed: margin, notional, entrySpreadPct: signal.spreadPct, estimatedRoundTripCostPct: signal.costPct,
      entryFee, exitFee: 0, realizedPnl: 0, unrealizedPnl: -entryFee, openTime: Date.now(), orderId,
      metadata: {
        strategy: 'R14_DUAL_COMMODITY_SCALPER_30S_1M', kind: instrument.kind, score: signal.score, reason: signal.reason,
        rsi: signal.rsi, flow: signal.flow, targetPct: signal.targetPct, stopPct: signal.stopPct,
        maxLeverageUsed: leverage, maxLeveragePolicy: 'MAX_ALLOWED_BY_CONTRACT', crudeBuyOnly: instrument.kind === 'CRUDE',
      },
    };
    this.insert(row);
    await this.telegram.alert(`R14 ${instrument.display} ${signal.side}`, `${instrument.venue} ${instrument.symbol}\nEntrada: ${fill}\nSL: ${sl}\nTP: ${tp}\nLeverage máximo usado: ${leverage}x\nSpread: ${signal.spreadPct.toFixed(4)}%`).catch(() => undefined);
    return row;
  }

  private async monitor(instrument: Instrument, book: Book): Promise<boolean> {
    const trade = this.getOpen(instrument, this.getMode());
    if (!trade) return false;
    if (trade.mode === 'REAL') {
      const exists = instrument.venue === 'BINANCE'
        ? (await this.binance.getPositions()).some((row) => row.symbol === instrument.symbol)
        : (await this.aster.getPositions(instrument.symbol)).some((row) => row.symbol === instrument.symbol);
      if (!exists) {
        await this.finish(trade, trade.side === 'BUY' ? book.bid : book.ask, 'VENUE_EXIT');
        return true;
      }
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
        await this.aster.createMarketOrder(instrument.symbol, 'SELL', trade.quantity, true);
      }
    }
    await this.finish(trade, exit, hitSl ? 'SL' : hitTp ? 'TP' : 'TIME_EXIT');
    return true;
  }

  private async finish(trade: ExchangeCommodityTrade, exit: number, reason: string): Promise<void> {
    const instrument = INSTRUMENTS.find((row) => row.symbol === trade.symbol)!;
    const exitFee = trade.quantity * exit * instrument.feePct / 100;
    const gross = trade.side === 'BUY' ? (exit - trade.entryPrice) * trade.quantity : (trade.entryPrice - exit) * trade.quantity;
    const net = gross - trade.entryFee - exitFee;
    this.database.db.prepare(`UPDATE commodity_trades SET state='CLOSED',exit_price=?,exit_fee=?,realized_pnl=?,unrealized_pnl=0,close_time=?,close_reason=?,updated_at=? WHERE id=?`)
      .run(exit, exitFee, net, Date.now(), reason, Date.now(), trade.id);
  }

  private getOpen(instrument: Instrument, mode: AppMode): ExchangeCommodityTrade | null {
    const row = this.database.db.prepare(`SELECT * FROM commodity_trades WHERE venue=? AND symbol=? AND mode=? AND state='OPEN' ORDER BY open_time DESC LIMIT 1`).get(instrument.venue, instrument.symbol, mode) as Record<string, unknown> | undefined;
    return row ? mapTrade(row) : null;
  }

  private insert(row: ExchangeCommodityTrade): void {
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

  private saveState(value: Record<string, unknown>): void {
    this.database.db.prepare(`INSERT INTO engine_state(key,value,updated_at) VALUES('exchangeCommodityR14',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
      .run(JSON.stringify(value), Date.now());
  }
}

function evaluate(instrument: Instrument, book: Book, candles: Candle[], micro: MicroBar[]): Signal | null {
  if (candles.length < 40 || micro.length < 2) return null;
  const spread = spreadPct(book);
  if (spread > instrument.maxSpreadPct) return null;
  const closes = candles.map((row) => row.close);
  const e9s = emaSeries(closes, 9), e21s = emaSeries(closes, 21);
  const e9 = e9s.at(-1) ?? 0, e21 = e21s.at(-1) ?? 0, e9Prev = e9s.at(-4) ?? e9;
  const rsiValue = rsi(closes, 14), atrValue = atr(candles, 14), mid = (book.bid + book.ask) / 2;
  if (!(atrValue > 0) || !(mid > 0)) return null;
  const atrPct = atrValue / mid * 100;
  const costPct = spread + instrument.feePct * 2 + env.COMMODITY_SLIPPAGE_PCT * 2;
  const targetPct = Math.max(costPct * env.COMMODITY_MIN_EDGE_MULTIPLE, atrPct * 0.65);
  const stopPct = Math.max(costPct * 1.25, atrPct * 0.40);
  if (!(targetPct > costPct) || targetPct > Math.max(1.2, atrPct * 8)) return null;
  const latest = micro.at(-1)!, previous = micro.at(-2)!;
  const total = latest.buyVolume + latest.sellVolume;
  const flow = total > 0 ? latest.buyVolume / total : 0.5;
  const body = Math.abs(latest.close - latest.open);
  const displacement = body >= atrValue * 0.10;
  const long = e9 > e21 && e9 > e9Prev && rsiValue >= 52 && rsiValue <= 76 && previous.low <= e9 + atrValue * 0.20 && latest.close > previous.high && latest.close > latest.open && displacement && flow >= (instrument.kind === 'CRUDE' ? 0.58 : 0.55);
  const short = e9 < e21 && e9 < e9Prev && rsiValue >= 24 && rsiValue <= 48 && previous.high >= e9 - atrValue * 0.20 && latest.close < previous.low && latest.close < latest.open && displacement && flow <= 0.45;
  if (instrument.allowLong && long) {
    const entry = book.ask * (1 + env.COMMODITY_SLIPPAGE_PCT / 100);
    return { side:'BUY',score:scoreSignal(Math.abs(e9-e21)/atrValue,rsiValue,flow,spread,instrument.maxSpreadPct),reason:'EX_M1_UPTREND_30S_BREAK',spreadPct:spread,costPct,targetPct,stopPct,entry,stopLoss:entry*(1-stopPct/100),takeProfit:entry*(1+targetPct/100),rsi:rsiValue,flow,atrPct };
  }
  if (instrument.allowShort && short) {
    const entry = book.bid * (1 - env.COMMODITY_SLIPPAGE_PCT / 100);
    return { side:'SELL',score:scoreSignal(Math.abs(e9-e21)/atrValue,100-rsiValue,1-flow,spread,instrument.maxSpreadPct),reason:'EX_M1_DOWNTREND_30S_BREAK',spreadPct:spread,costPct,targetPct,stopPct,entry,stopLoss:entry*(1+stopPct/100),takeProfit:entry*(1-targetPct/100),rsi:rsiValue,flow,atrPct };
  }
  return null;
}

async function binanceBook(symbol: string): Promise<Book> {
  const response = await fetch(`${env.BINANCE_BASE_URL.replace(/\/$/,'')}/fapi/v1/ticker/bookTicker?symbol=${encodeURIComponent(symbol)}`);
  if (!response.ok) throw new Error(`BINANCE_BOOK_HTTP_${response.status}:${symbol}`);
  const row = await response.json() as any;
  return { bid:Number(row.bidPrice??0),ask:Number(row.askPrice??0),bidQty:Number(row.bidQty??0),askQty:Number(row.askQty??0),time:Number(row.time??Date.now()) };
}
async function binanceKlines(symbol: string): Promise<Candle[]> {
  const response = await fetch(`${env.BINANCE_BASE_URL.replace(/\/$/,'')}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=1m&limit=180`);
  if (!response.ok) throw new Error(`BINANCE_KLINES_HTTP_${response.status}:${symbol}`);
  const rows = await response.json() as any[]; const now=Date.now();
  return rows.filter((row)=>Number(row[6]??0)<=now).map((row)=>({time:Number(row[0]),open:Number(row[1]),high:Number(row[2]),low:Number(row[3]),close:Number(row[4]),volume:Number(row[5]??0)}));
}
async function binanceAgg(symbol: string): Promise<Agg[]> {
  const response = await fetch(`${env.BINANCE_BASE_URL.replace(/\/$/,'')}/fapi/v1/aggTrades?symbol=${encodeURIComponent(symbol)}&limit=1000`);
  if (!response.ok) throw new Error(`BINANCE_AGG_HTTP_${response.status}:${symbol}`);
  const rows=await response.json() as any[];
  return rows.map((row)=>({price:Number(row.p??0),qty:Number(row.q??0),time:Number(row.T??0),buyerIsMaker:Boolean(row.m)})).filter((row)=>row.price>0&&row.qty>0&&row.time>0);
}
function toAsterBook(row: any): Book { return { bid:row.bidPrice,ask:row.askPrice,bidQty:row.bidQty,askQty:row.askQty,time:row.time }; }
function buildMicroBars(rows: Array<Agg|AsterAggTrade>): MicroBar[] {
  const map=new Map<number,MicroBar>(); const now=Date.now();
  for(const row of rows){ const time=Number(row.time); if(time<now-10*60_000) continue; const bucket=Math.floor(time/30_000)*30_000; let bar=map.get(bucket); if(!bar){bar={time:bucket,open:Number(row.price),high:Number(row.price),low:Number(row.price),close:Number(row.price),volume:0,buyVolume:0,sellVolume:0};map.set(bucket,bar);} const p=Number(row.price),q=Number(row.qty); bar.high=Math.max(bar.high,p);bar.low=Math.min(bar.low,p);bar.close=p;bar.volume+=q;if(row.buyerIsMaker)bar.sellVolume+=q;else bar.buyVolume+=q; }
  return [...map.values()].filter((bar)=>bar.time+30_000<=now).sort((a,b)=>a.time-b.time);
}
function spreadPct(book: Book){ const mid=(book.bid+book.ask)/2; return mid>0?Math.max(0,(book.ask-book.bid)/mid*100):Infinity; }
function emaSeries(values:number[],period:number){ if(!values.length)return[];const a=2/(period+1),out=[values[0]];for(let i=1;i<values.length;i++)out.push(values[i]*a+out[i-1]*(1-a));return out; }
function rsi(values:number[],period:number){ if(values.length<=period)return 50;let g=0,l=0;for(let i=values.length-period;i<values.length;i++){const d=values[i]-values[i-1];if(d>=0)g+=d;else l-=d;}if(l===0)return 100;const rs=g/Math.max(l,1e-12);return 100-100/(1+rs); }
function atr(candles:Candle[],period:number){const v:number[]=[];for(let i=Math.max(1,candles.length-period);i<candles.length;i++){const c=candles[i],p=candles[i-1];v.push(Math.max(c.high-c.low,Math.abs(c.high-p.close),Math.abs(c.low-p.close)));}return v.length?v.reduce((a,b)=>a+b,0)/v.length:0;}
function scoreSignal(trend:number,momentum:number,flow:number,spread:number,maxSpread:number){return Math.round(Math.max(45,Math.min(95,30+Math.min(25,trend*30)+Math.min(20,Math.abs(momentum-50)*.8)+Math.min(25,Math.max(0,flow-.5)*100)+Math.max(0,20*(1-spread/Math.max(maxSpread,1e-9))))));}
function roundDown(value:number,step:number,precision:number){const s=step>0?step:Math.pow(10,-Math.max(0,precision));return Number((Math.floor((value+1e-12)/s)*s).toFixed(Math.max(0,precision)));}
function roundPrice(value:number,precision:number){return Number(value.toFixed(Math.max(0,precision)));}
function mapTrade(row:Record<string,unknown>):ExchangeCommodityTrade{return{id:String(row.id),venue:String(row.venue) as Venue,mode:String(row.mode) as AppMode,symbol:String(row.symbol),displaySymbol:String(row.display_symbol),side:String(row.side) as TradeSide,state:String(row.state) as any,entryPrice:Number(row.entry_price),exitPrice:row.exit_price==null?undefined:Number(row.exit_price),stopLoss:Number(row.stop_loss),takeProfit:Number(row.take_profit),quantity:Number(row.quantity),leverage:Number(row.leverage),marginUsed:Number(row.margin_used),notional:Number(row.notional),entrySpreadPct:Number(row.entry_spread_pct),estimatedRoundTripCostPct:Number(row.estimated_round_trip_cost_pct),entryFee:Number(row.entry_fee??0),exitFee:Number(row.exit_fee??0),realizedPnl:Number(row.realized_pnl??0),unrealizedPnl:Number(row.unrealized_pnl??0),openTime:Number(row.open_time),closeTime:row.close_time==null?undefined:Number(row.close_time),closeReason:row.close_reason==null?undefined:String(row.close_reason),orderId:row.order_id==null?undefined:String(row.order_id),metadata:row.metadata?JSON.parse(String(row.metadata)):undefined};}
function message(error:unknown){return error instanceof Error?error.message:String(error);}
