import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { AsterV3Client, type AsterAggTrade, type AsterBookTicker, type AsterCandle } from './aster.js';
import { BinanceUsdmClient } from './binance.js';
import { env } from './config.js';
import { TradingDatabase } from './database.js';
import { TelegramService } from './telegram.js';
import type { AppMode, TradeSide } from './types.js';

export type CommodityVenue = 'BINANCE' | 'ASTER';
export type CommodityState = 'OPEN' | 'CLOSED' | 'REJECTED';

interface CommodityInstrument {
  symbol: 'XAUUSDT' | 'CLUSDT';
  display: 'XAUUSD' | 'CRUDE OIL';
  venue: CommodityVenue;
  allowLong: boolean;
  allowShort: boolean;
  maxSpreadPct: number;
  takerFeePct: number;
}

interface MarketBook {
  bid: number;
  ask: number;
  bidQty: number;
  askQty: number;
  time: number;
}

interface MinuteCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface MicroTrade {
  price: number;
  qty: number;
  time: number;
  buyerIsMaker: boolean;
}

interface MicroBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  takerBuyVolume: number;
  takerSellVolume: number;
}

interface InstrumentCache {
  klines: MinuteCandle[];
  microBars: MicroBar[];
  refreshedAt: number;
  latestBook?: MarketBook;
  lastSignalBucket?: number;
  lastDiagnostic?: Record<string, unknown>;
}

interface ScalperSignal {
  side: TradeSide;
  score: number;
  reason: string;
  atrPct: number;
  spreadPct: number;
  estimatedRoundTripCostPct: number;
  targetPct: number;
  stopPct: number;
  takeProfit: number;
  stopLoss: number;
  referencePrice: number;
  takerBuyRatio: number;
  rsi: number;
}

export interface CommodityTradeRow {
  id: string;
  venue: CommodityVenue;
  mode: AppMode;
  symbol: string;
  displaySymbol: string;
  side: TradeSide;
  state: CommodityState;
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

const INSTRUMENTS: CommodityInstrument[] = [
  {
    symbol: 'XAUUSDT', display: 'XAUUSD', venue: 'BINANCE', allowLong: true, allowShort: true,
    maxSpreadPct: env.COMMODITY_MAX_SPREAD_PCT_XAU, takerFeePct: env.COMMODITY_TAKER_FEE_PCT_BINANCE,
  },
  {
    symbol: 'CLUSDT', display: 'CRUDE OIL', venue: 'ASTER', allowLong: true, allowShort: false,
    maxSpreadPct: env.COMMODITY_MAX_SPREAD_PCT_CL, takerFeePct: env.COMMODITY_TAKER_FEE_PCT_ASTER,
  },
];

export class CommodityScalperService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly cache = new Map<string, InstrumentCache>();
  private enabled = true;

  constructor(
    private readonly database: TradingDatabase,
    private readonly binance: BinanceUsdmClient,
    private readonly aster: AsterV3Client,
    private readonly telegram: TelegramService,
    private readonly getMode: () => AppMode,
  ) {
    this.ensureSchema();
    this.enabled = this.loadEnabled();
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

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.database.db.prepare(`
      INSERT INTO engine_state(key,value,updated_at) VALUES('commodityEnabled',?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(JSON.stringify({ enabled }), Date.now());
  }

  isEnabled(): boolean { return this.enabled; }

  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const startedAt = Date.now();
    const mode = this.getMode();
    const diagnostics: Record<string, unknown>[] = [];
    let opened = 0;
    let closed = 0;
    let errors = 0;

    try {
      if (!this.enabled) {
        this.saveState({ status: 'PAUSED', enabled: false, mode, startedAt, completedAt: Date.now(), policy: policySummary() });
        return;
      }

      for (const instrument of INSTRUMENTS) {
        try {
          const snapshot = await this.snapshot(instrument);
          const closeResult = await this.monitorOpenTrade(instrument, snapshot.book, snapshot.klines);
          if (closeResult) closed++;

          if (!this.getOpenTrade(instrument.symbol, mode)) {
            const signal = this.evaluate(instrument, snapshot.book, snapshot.klines, snapshot.microBars);
            const cache = this.cache.get(instrument.symbol)!;
            cache.lastDiagnostic = signal
              ? { action: signal.side, score: signal.score, spreadPct: signal.spreadPct, costPct: signal.estimatedRoundTripCostPct, targetPct: signal.targetPct, stopPct: signal.stopPct, rsi: signal.rsi, takerBuyRatio: signal.takerBuyRatio }
              : { action: 'WAIT', reason: 'NO_VALID_30S_1M_SETUP', spreadPct: spreadPct(snapshot.book) };

            if (signal) {
              const bucket = Math.floor(Date.now() / 30_000) * 30_000;
              if (cache.lastSignalBucket !== bucket) {
                const result = await this.openTrade(instrument, signal, snapshot.book);
                cache.lastSignalBucket = bucket;
                if (result) opened++;
              }
            }
          }

          diagnostics.push({
            symbol: instrument.symbol,
            display: instrument.display,
            venue: instrument.venue,
            allowedSides: instrument.allowShort ? 'BUY/SELL' : 'BUY_ONLY',
            book: snapshot.book,
            spreadPct: spreadPct(snapshot.book),
            lastDiagnostic: this.cache.get(instrument.symbol)?.lastDiagnostic,
          });
        } catch (error) {
          errors++;
          diagnostics.push({ symbol: instrument.symbol, venue: instrument.venue, error: message(error) });
        }
      }

      this.markUnrealized();
      this.saveEquitySnapshot();
      this.saveState({
        status: errors === INSTRUMENTS.length ? 'DATA_ERROR' : errors ? 'RUNNING_WITH_ERRORS' : 'RUNNING',
        enabled: true,
        mode,
        startedAt,
        completedAt: Date.now(),
        timeframe: '30s trigger / 1m context',
        opened,
        closed,
        errors,
        instruments: diagnostics,
        policy: policySummary(),
        paper: this.paperSummary(),
      });
    } finally {
      this.running = false;
    }
  }

  getState(): Record<string, unknown> {
    const row = this.database.db.prepare(`SELECT value,updated_at FROM engine_state WHERE key='commodityScalper'`).get() as { value: string; updated_at: number } | undefined;
    if (!row) return { status: 'STARTING', enabled: this.enabled, policy: policySummary() };
    try { return { ...JSON.parse(row.value), updatedAt: row.updated_at, paper: this.paperSummary(), recentTrades: this.recentTrades(50) }; }
    catch { return { status: 'STATE_ERROR', enabled: this.enabled }; }
  }

  recentTrades(limit = 50): CommodityTradeRow[] {
    const rows = this.database.db.prepare(`SELECT * FROM commodity_trades ORDER BY created_at DESC LIMIT ?`).all(Math.max(1, Math.min(500, limit))) as Record<string, unknown>[];
    return rows.map(mapCommodityTrade);
  }

  paperSummary(): Record<string, unknown> {
    const rows = this.database.db.prepare(`SELECT * FROM commodity_trades WHERE mode='PAPER' ORDER BY created_at ASC`).all() as Record<string, unknown>[];
    const trades = rows.map(mapCommodityTrade);
    const closed = trades.filter((trade) => trade.state === 'CLOSED');
    const open = trades.filter((trade) => trade.state === 'OPEN');
    const realized = closed.reduce((sum, trade) => sum + trade.realizedPnl, 0);
    const floating = open.reduce((sum, trade) => sum + trade.unrealizedPnl, 0);
    const initial = env.PAPER_INITIAL_BALANCE;
    const balance = initial + realized;
    const equity = balance + floating;
    const wins = closed.filter((trade) => trade.realizedPnl > 0).length;
    const losses = closed.filter((trade) => trade.realizedPnl < 0).length;
    const curve = closed.map((trade) => ({ time: trade.closeTime ?? trade.openTime, pnl: trade.realizedPnl }));
    let cumulative = 0;
    const equityCurve = curve.map((point) => ({ time: point.time, equity: initial + (cumulative += point.pnl) }));
    return {
      initialBalance: initial,
      balance,
      equity,
      floatingPnl: floating,
      realizedPnl: realized,
      openPositions: open.length,
      closedTrades: closed.length,
      wins,
      losses,
      winRate: closed.length ? wins / closed.length * 100 : 0,
      equityCurve,
      activeTrades: open,
      bySymbol: INSTRUMENTS.map((instrument) => {
        const symbolRows = closed.filter((trade) => trade.symbol === instrument.symbol);
        const symbolWins = symbolRows.filter((trade) => trade.realizedPnl > 0).length;
        return {
          symbol: instrument.symbol,
          display: instrument.display,
          trades: symbolRows.length,
          winRate: symbolRows.length ? symbolWins / symbolRows.length * 100 : 0,
          netPnl: symbolRows.reduce((sum, trade) => sum + trade.realizedPnl, 0),
        };
      }),
    };
  }

  private async snapshot(instrument: CommodityInstrument): Promise<{ book: MarketBook; klines: MinuteCandle[]; microBars: MicroBar[] }> {
    const cache = this.cache.get(instrument.symbol) ?? { klines: [], microBars: [], refreshedAt: 0 };
    const book = instrument.venue === 'BINANCE'
      ? await this.binanceBook(instrument.symbol)
      : toBook(await this.aster.getBookTicker(instrument.symbol));
    cache.latestBook = book;

    if (!cache.klines.length || Date.now() - cache.refreshedAt >= env.COMMODITY_REFRESH_MS) {
      const [klines, microTrades] = instrument.venue === 'BINANCE'
        ? await Promise.all([this.binanceKlines(instrument.symbol), this.binanceAggTrades(instrument.symbol)])
        : await Promise.all([this.aster.getKlines(instrument.symbol, '1m', 160), this.aster.getAggTrades(instrument.symbol, 0, Date.now())]);
      cache.klines = klines;
      cache.microBars = buildMicroBars(microTrades);
      cache.refreshedAt = Date.now();
    }
    this.cache.set(instrument.symbol, cache);
    return { book, klines: cache.klines, microBars: cache.microBars };
  }

  private evaluate(instrument: CommodityInstrument, book: MarketBook, candles: MinuteCandle[], microBars: MicroBar[]): ScalperSignal | null {
    if (candles.length < 40 || microBars.length < 2) return null;
    const spread = spreadPct(book);
    if (!(spread >= 0) || spread > instrument.maxSpreadPct) return null;

    const closes = candles.map((candle) => candle.close);
    const ema9 = emaSeries(closes, 9);
    const ema21 = emaSeries(closes, 21);
    const e9 = ema9.at(-1) ?? 0;
    const e21 = ema21.at(-1) ?? 0;
    const e9Prev = ema9.at(-4) ?? e9;
    const rsiValue = rsi(closes, 14);
    const atrValue = atr(candles, 14);
    const mid = (book.bid + book.ask) / 2;
    if (!(atrValue > 0) || !(mid > 0)) return null;
    const atrPct = atrValue / mid * 100;
    const costPct = spread + instrument.takerFeePct * 2 + env.COMMODITY_SLIPPAGE_PCT * 2;
    const targetPct = Math.max(costPct * env.COMMODITY_MIN_EDGE_MULTIPLE, atrPct * 0.65);
    const stopPct = Math.max(costPct * 1.25, atrPct * 0.40);
    if (!(targetPct > costPct) || targetPct > Math.max(1.2, atrPct * 8)) return null;

    const latest = microBars.at(-1)!;
    const previous = microBars.at(-2)!;
    const totalAggressive = latest.takerBuyVolume + latest.takerSellVolume;
    const takerBuyRatio = totalAggressive > 0 ? latest.takerBuyVolume / totalAggressive : 0.5;
    const body = Math.abs(latest.close - latest.open);
    const displacementOk = body >= atrValue * 0.10;
    const pullbackLong = previous.low <= e9 + atrValue * 0.20;
    const pullbackShort = previous.high >= e9 - atrValue * 0.20;
    const longBreak = latest.close > previous.high && latest.close > latest.open;
    const shortBreak = latest.close < previous.low && latest.close < latest.open;

    const longTrend = e9 > e21 && e9 > e9Prev && rsiValue >= 52 && rsiValue <= 76;
    const shortTrend = e9 < e21 && e9 < e9Prev && rsiValue >= 24 && rsiValue <= 48;
    const longFlow = takerBuyRatio >= (instrument.symbol === 'CLUSDT' ? 0.58 : 0.55);
    const shortFlow = takerBuyRatio <= 0.45;

    if (instrument.allowLong && longTrend && pullbackLong && longBreak && displacementOk && longFlow) {
      const entry = book.ask * (1 + env.COMMODITY_SLIPPAGE_PCT / 100);
      return {
        side: 'BUY', score: scoreSignal(emaDistance(e9, e21, atrValue), rsiValue, takerBuyRatio, spread, instrument.maxSpreadPct),
        reason: 'M1_UPTREND_30S_PULLBACK_BREAK_BUY_FLOW', atrPct, spreadPct: spread,
        estimatedRoundTripCostPct: costPct, targetPct, stopPct,
        referencePrice: entry, takeProfit: entry * (1 + targetPct / 100), stopLoss: entry * (1 - stopPct / 100),
        takerBuyRatio, rsi: rsiValue,
      };
    }

    if (instrument.allowShort && shortTrend && pullbackShort && shortBreak && displacementOk && shortFlow) {
      const entry = book.bid * (1 - env.COMMODITY_SLIPPAGE_PCT / 100);
      return {
        side: 'SELL', score: scoreSignal(emaDistance(e9, e21, atrValue), 100 - rsiValue, 1 - takerBuyRatio, spread, instrument.maxSpreadPct),
        reason: 'M1_DOWNTREND_30S_PULLBACK_BREAK_SELL_FLOW', atrPct, spreadPct: spread,
        estimatedRoundTripCostPct: costPct, targetPct, stopPct,
        referencePrice: entry, takeProfit: entry * (1 - targetPct / 100), stopLoss: entry * (1 + stopPct / 100),
        takerBuyRatio, rsi: rsiValue,
      };
    }

    return null;
  }

  private async openTrade(instrument: CommodityInstrument, signal: ScalperSignal, book: MarketBook): Promise<CommodityTradeRow | null> {
    // Hard-coded safety invariant requested by the user: Crude Oil can NEVER open short.
    if (instrument.symbol === 'CLUSDT' && signal.side !== 'BUY') return null;

    const mode = this.getMode();
    if (mode === 'TESTNET') {
      this.cache.get(instrument.symbol)!.lastDiagnostic = { action: 'WAIT', reason: 'COMMODITY_TESTNET_NOT_SUPPORTED_USE_PAPER' };
      return null;
    }

    if (mode === 'REAL' && !env.COMMODITY_ALLOW_REAL) {
      this.cache.get(instrument.symbol)!.lastDiagnostic = { action: 'WAIT', reason: 'REAL_EXECUTION_LOCKED_COMMODITY_ALLOW_REAL_FALSE' };
      return null;
    }

    const leverageRequested = Math.max(1, Math.min(20, env.COMMODITY_REQUESTED_LEVERAGE));
    let balance: number;
    let leverage = leverageRequested;
    let meta: { minQty: number; stepSize: number; minNotional: number; quantityPrecision: number; pricePrecision: number };

    if (mode === 'PAPER') {
      balance = Number(this.paperSummary().balance ?? env.PAPER_INITIAL_BALANCE);
      if (instrument.venue === 'BINANCE') {
        await this.binance.refreshExchangeInfo();
        const m = this.binance.getSymbolMeta(instrument.symbol);
        meta = { minQty: m.filters.minQty, stepSize: m.filters.stepSize, minNotional: m.filters.minNotional, quantityPrecision: m.quantityPrecision, pricePrecision: m.pricePrecision };
        leverage = Math.min(leverage, 10); // Binance TradFi published maximum is 10x.
      } else {
        await this.aster.refreshExchangeInfo();
        const m = this.aster.getSymbolMeta(instrument.symbol);
        meta = m;
        leverage = Math.min(leverage, 20);
      }
    } else if (instrument.venue === 'BINANCE') {
      if (!this.binance.hasCredentials()) throw new Error('BINANCE_CREDENTIALS_REQUIRED_FOR_XAU_REAL');
      await this.binance.refreshExchangeInfo();
      balance = await this.binance.getFuturesBalance();
      leverage = await this.binance.setLeverage(instrument.symbol, Math.min(leverage, 10));
      const m = this.binance.getSymbolMeta(instrument.symbol);
      meta = { minQty: m.filters.minQty, stepSize: m.filters.stepSize, minNotional: m.filters.minNotional, quantityPrecision: m.quantityPrecision, pricePrecision: m.pricePrecision };
    } else {
      if (!this.aster.hasCredentials()) throw new Error('ASTER_PRO_API_REQUIRED_FOR_CRUDE_REAL');
      await this.aster.refreshExchangeInfo();
      balance = (await this.aster.getBalance()).balance;
      leverage = await this.aster.setLeverage(instrument.symbol, leverage);
      meta = this.aster.getSymbolMeta(instrument.symbol);
    }

    const margin = balance * env.COMMODITY_MARGIN_PCT / 100;
    const entryReference = signal.side === 'BUY' ? book.ask : book.bid;
    const targetNotional = margin * leverage;
    if (targetNotional + 1e-9 < meta.minNotional) {
      this.cache.get(instrument.symbol)!.lastDiagnostic = {
        action: 'SKIP', reason: 'MIN_NOTIONAL_WITH_STRICT_1PCT_MARGIN', targetNotional, minNotional: meta.minNotional, margin, leverage,
      };
      return null;
    }
    const quantity = roundDown(targetNotional / entryReference, meta.stepSize, meta.quantityPrecision);
    if (!(quantity >= meta.minQty) || !(quantity > 0)) return null;

    let fillPrice = signal.referencePrice;
    let orderId = `PAPER-${Date.now()}`;
    if (mode === 'REAL') {
      if (instrument.venue === 'BINANCE') {
        const order = await this.binance.createMarketOrder(instrument.symbol, signal.side, quantity);
        fillPrice = Number(order.avgPrice ?? order.price ?? signal.referencePrice) || signal.referencePrice;
        orderId = String(order.orderId ?? `BINANCE-${Date.now()}`);
      } else {
        const order = await this.aster.createMarketOrder(instrument.symbol, 'BUY', quantity);
        fillPrice = Number(order.avgPrice ?? order.price ?? signal.referencePrice) || signal.referencePrice;
        orderId = String(order.orderId ?? `ASTER-${Date.now()}`);
      }
    }

    // Re-anchor protection levels to the actual fill so slippage cannot create micro exits.
    const takeProfit = signal.side === 'BUY' ? fillPrice * (1 + signal.targetPct / 100) : fillPrice * (1 - signal.targetPct / 100);
    const stopLoss = signal.side === 'BUY' ? fillPrice * (1 - signal.stopPct / 100) : fillPrice * (1 + signal.stopPct / 100);

    if (mode === 'REAL') {
      const exitSide: TradeSide = signal.side === 'BUY' ? 'SELL' : 'BUY';
      if (instrument.venue === 'BINANCE') {
        await this.binance.createCloseAllConditional(instrument.symbol, exitSide, 'STOP_MARKET', roundPrice(stopLoss, meta.pricePrecision), `R12SL${Date.now()}`.slice(0, 32));
        await this.binance.createCloseAllConditional(instrument.symbol, exitSide, 'TAKE_PROFIT_MARKET', roundPrice(takeProfit, meta.pricePrecision), `R12TP${Date.now()}`.slice(0, 32));
      } else {
        await this.aster.createCloseAllConditional(instrument.symbol, exitSide, 'STOP_MARKET', roundPrice(stopLoss, meta.pricePrecision));
        await this.aster.createCloseAllConditional(instrument.symbol, exitSide, 'TAKE_PROFIT_MARKET', roundPrice(takeProfit, meta.pricePrecision));
      }
    }

    const notional = quantity * fillPrice;
    const entryFee = notional * instrument.takerFeePct / 100;
    const row: CommodityTradeRow = {
      id: `CMD-${crypto.randomUUID()}`,
      venue: instrument.venue,
      mode,
      symbol: instrument.symbol,
      displaySymbol: instrument.display,
      side: signal.side,
      state: 'OPEN',
      entryPrice: fillPrice,
      stopLoss,
      takeProfit,
      quantity,
      leverage,
      marginUsed: margin,
      notional,
      entrySpreadPct: signal.spreadPct,
      estimatedRoundTripCostPct: signal.estimatedRoundTripCostPct,
      entryFee,
      exitFee: 0,
      realizedPnl: 0,
      unrealizedPnl: -entryFee,
      openTime: Date.now(),
      orderId,
      metadata: {
        strategy: 'R12_COMMODITY_SCALPER_30S_1M',
        reason: signal.reason,
        score: signal.score,
        atrPct: signal.atrPct,
        targetPct: signal.targetPct,
        stopPct: signal.stopPct,
        rsi: signal.rsi,
        takerBuyRatio: signal.takerBuyRatio,
        crudeBuyOnly: instrument.symbol === 'CLUSDT',
      },
    };
    this.insertTrade(row);
    await this.telegram.alert(
      `R12 ${instrument.display} ${signal.side}`,
      [
        `${instrument.venue} · ${instrument.symbol}`,
        `Entrada: ${fillPrice}`,
        `SL: ${stopLoss}`,
        `TP: ${takeProfit}`,
        `Spread: ${signal.spreadPct.toFixed(4)}%`,
        `Costo RT estimado: ${signal.estimatedRoundTripCostPct.toFixed(4)}%`,
        `Margen: ${env.COMMODITY_MARGIN_PCT}% · Leverage: ${leverage}x`,
        instrument.symbol === 'CLUSDT' ? 'CRUDE OIL: BUY-ONLY por política.' : 'XAU: BUY/SELL habilitado.',
      ].join('\n'),
    ).catch(() => undefined);
    return row;
  }

  private async monitorOpenTrade(instrument: CommodityInstrument, book: MarketBook, candles: MinuteCandle[]): Promise<boolean> {
    const mode = this.getMode();
    const trade = this.getOpenTrade(instrument.symbol, mode);
    if (!trade) return false;

    if (mode === 'REAL') {
      const positionExists = instrument.venue === 'BINANCE'
        ? (await this.binance.getPositions()).some((position) => position.symbol === instrument.symbol)
        : (await this.aster.getPositions(instrument.symbol)).some((position) => position.symbol === instrument.symbol);
      if (!positionExists) {
        const exit = trade.side === 'BUY' ? book.bid : book.ask;
        await this.finishTrade(trade, exit, 'VENUE_PROTECTION_OR_EXTERNAL');
        return true;
      }
    }

    const rawExit = trade.side === 'BUY' ? book.bid : book.ask;
    const exit = trade.side === 'BUY'
      ? rawExit * (1 - env.COMMODITY_SLIPPAGE_PCT / 100)
      : rawExit * (1 + env.COMMODITY_SLIPPAGE_PCT / 100);
    const hitStop = trade.side === 'BUY' ? exit <= trade.stopLoss : exit >= trade.stopLoss;
    const hitTp = trade.side === 'BUY' ? exit >= trade.takeProfit : exit <= trade.takeProfit;
    const expired = Date.now() - trade.openTime >= env.COMMODITY_MAX_HOLD_SECONDS * 1000;

    if (!hitStop && !hitTp && !expired) {
      const gross = trade.side === 'BUY'
        ? (exit - trade.entryPrice) * trade.quantity
        : (trade.entryPrice - exit) * trade.quantity;
      this.database.db.prepare(`UPDATE commodity_trades SET unrealized_pnl=?,updated_at=? WHERE id=?`).run(gross - trade.entryFee, Date.now(), trade.id);
      return false;
    }

    let reason = hitStop ? 'SL' : hitTp ? 'TP' : 'TIME_EXIT';
    if (mode === 'REAL' && expired) {
      if (instrument.venue === 'BINANCE') {
        await this.binance.cancelAllAlgoOpenOrders(instrument.symbol).catch(() => undefined);
        await this.binance.createMarketOrder(instrument.symbol, trade.side === 'BUY' ? 'SELL' : 'BUY', trade.quantity);
      } else {
        await this.aster.cancelAllOpenOrders(instrument.symbol).catch(() => undefined);
        await this.aster.createMarketOrder(instrument.symbol, 'SELL', trade.quantity, true);
      }
      reason = 'TIME_EXIT_MARKET';
    }
    await this.finishTrade(trade, exit, reason);
    return true;
  }

  private async finishTrade(trade: CommodityTradeRow, exitPrice: number, reason: string): Promise<void> {
    const instrument = INSTRUMENTS.find((item) => item.symbol === trade.symbol)!;
    const exitNotional = trade.quantity * exitPrice;
    const exitFee = exitNotional * instrument.takerFeePct / 100;
    const gross = trade.side === 'BUY'
      ? (exitPrice - trade.entryPrice) * trade.quantity
      : (trade.entryPrice - exitPrice) * trade.quantity;
    const net = gross - trade.entryFee - exitFee;
    this.database.db.prepare(`
      UPDATE commodity_trades
      SET state='CLOSED',exit_price=?,exit_fee=?,realized_pnl=?,unrealized_pnl=0,close_time=?,close_reason=?,updated_at=?
      WHERE id=?
    `).run(exitPrice, exitFee, net, Date.now(), reason, Date.now(), trade.id);
    await this.telegram.alert(
      `R12 ${trade.displaySymbol} CERRADA`,
      `${trade.side} · ${reason}\nPnL neto: ${net.toFixed(4)} USDT\nEntrada: ${trade.entryPrice}\nSalida: ${exitPrice}`,
    ).catch(() => undefined);
  }

  private getOpenTrade(symbol: string, mode: AppMode): CommodityTradeRow | null {
    const row = this.database.db.prepare(`
      SELECT * FROM commodity_trades WHERE symbol=? AND mode=? AND state='OPEN' ORDER BY open_time DESC LIMIT 1
    `).get(symbol, mode) as Record<string, unknown> | undefined;
    return row ? mapCommodityTrade(row) : null;
  }

  private insertTrade(trade: CommodityTradeRow): void {
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

  private markUnrealized(): void {
    const mode = this.getMode();
    for (const instrument of INSTRUMENTS) {
      const trade = this.getOpenTrade(instrument.symbol, mode);
      const book = this.cache.get(instrument.symbol)?.latestBook;
      if (!trade || !book) continue;
      const exit = trade.side === 'BUY' ? book.bid : book.ask;
      const gross = trade.side === 'BUY' ? (exit - trade.entryPrice) * trade.quantity : (trade.entryPrice - exit) * trade.quantity;
      this.database.db.prepare(`UPDATE commodity_trades SET unrealized_pnl=?,updated_at=? WHERE id=?`).run(gross - trade.entryFee, Date.now(), trade.id);
    }
  }

  private saveEquitySnapshot(): void {
    const summary = this.paperSummary();
    this.database.db.prepare(`INSERT INTO commodity_equity(balance,equity,created_at) VALUES(?,?,?)`).run(Number(summary.balance ?? 0), Number(summary.equity ?? 0), Date.now());
  }

  private async binanceBook(symbol: string): Promise<MarketBook> {
    const response = await fetch(`${env.BINANCE_BASE_URL.replace(/\/$/, '')}/fapi/v1/ticker/bookTicker?symbol=${encodeURIComponent(symbol)}`);
    if (!response.ok) throw new Error(`BINANCE_BOOK_HTTP_${response.status}:${symbol}`);
    const row = await response.json() as any;
    return { bid: Number(row.bidPrice ?? 0), ask: Number(row.askPrice ?? 0), bidQty: Number(row.bidQty ?? 0), askQty: Number(row.askQty ?? 0), time: Number(row.time ?? Date.now()) };
  }

  private async binanceKlines(symbol: string): Promise<MinuteCandle[]> {
    const response = await fetch(`${env.BINANCE_BASE_URL.replace(/\/$/, '')}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=1m&limit=160`);
    if (!response.ok) throw new Error(`BINANCE_KLINES_HTTP_${response.status}:${symbol}`);
    const rows = await response.json() as any[];
    const now = Date.now();
    return rows.filter((row) => Number(row[6] ?? 0) <= now).map((row) => ({
      time: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5] ?? 0),
    }));
  }

  private async binanceAggTrades(symbol: string): Promise<MicroTrade[]> {
    const response = await fetch(`${env.BINANCE_BASE_URL.replace(/\/$/, '')}/fapi/v1/aggTrades?symbol=${encodeURIComponent(symbol)}&limit=1000`);
    if (!response.ok) throw new Error(`BINANCE_AGGTRADES_HTTP_${response.status}:${symbol}`);
    const rows = await response.json() as any[];
    return rows.map((row) => ({ price: Number(row.p ?? 0), qty: Number(row.q ?? 0), time: Number(row.T ?? 0), buyerIsMaker: Boolean(row.m) })).filter((row) => row.price > 0 && row.qty > 0 && row.time > 0);
  }

  private ensureSchema(): void {
    this.database.db.exec(`
      CREATE TABLE IF NOT EXISTS commodity_trades(
        id TEXT PRIMARY KEY,
        venue TEXT NOT NULL,
        mode TEXT NOT NULL,
        symbol TEXT NOT NULL,
        display_symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        state TEXT NOT NULL,
        entry_price REAL NOT NULL,
        exit_price REAL,
        stop_loss REAL NOT NULL,
        take_profit REAL NOT NULL,
        quantity REAL NOT NULL,
        leverage REAL NOT NULL,
        margin_used REAL NOT NULL,
        notional REAL NOT NULL,
        entry_spread_pct REAL NOT NULL,
        estimated_round_trip_cost_pct REAL NOT NULL,
        entry_fee REAL NOT NULL DEFAULT 0,
        exit_fee REAL NOT NULL DEFAULT 0,
        realized_pnl REAL NOT NULL DEFAULT 0,
        unrealized_pnl REAL NOT NULL DEFAULT 0,
        open_time INTEGER NOT NULL,
        close_time INTEGER,
        close_reason TEXT,
        order_id TEXT,
        metadata TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS ux_commodity_active_mode_symbol
        ON commodity_trades(mode,symbol) WHERE state='OPEN';
      CREATE INDEX IF NOT EXISTS idx_commodity_close_time ON commodity_trades(close_time DESC);
      CREATE TABLE IF NOT EXISTS commodity_equity(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        balance REAL NOT NULL,
        equity REAL NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  private loadEnabled(): boolean {
    const row = this.database.db.prepare(`SELECT value FROM engine_state WHERE key='commodityEnabled'`).get() as { value: string } | undefined;
    if (!row) return true;
    try { return JSON.parse(row.value).enabled !== false; } catch { return true; }
  }

  private saveState(value: Record<string, unknown>): void {
    this.database.db.prepare(`
      INSERT INTO engine_state(key,value,updated_at) VALUES('commodityScalper',?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(JSON.stringify(value), Date.now());
  }
}

function policySummary() {
  return {
    symbols: [
      { display: 'XAUUSD', venueSymbol: 'XAUUSDT', venue: 'BINANCE', directions: 'BUY/SELL' },
      { display: 'CRUDE OIL', venueSymbol: 'CLUSDT', venue: 'ASTER', directions: 'BUY_ONLY' },
    ],
    triggerTimeframe: '30s synthetic from aggTrades',
    contextTimeframe: '1m',
    marginPctPerTrade: env.COMMODITY_MARGIN_PCT,
    requestedLeverage: env.COMMODITY_REQUESTED_LEVERAGE,
    maxHoldSeconds: env.COMMODITY_MAX_HOLD_SECONDS,
    minEdgeMultipleVsCosts: env.COMMODITY_MIN_EDGE_MULTIPLE,
    costs: 'real bid/ask spread + taker fees + estimated slippage',
    crudeShortInvariant: 'SELL_DISABLED_IN_CODE',
  };
}

function toBook(book: AsterBookTicker): MarketBook {
  return { bid: book.bidPrice, ask: book.askPrice, bidQty: book.bidQty, askQty: book.askQty, time: book.time };
}

function buildMicroBars(trades: Array<MicroTrade | AsterAggTrade>): MicroBar[] {
  const now = Date.now();
  const buckets = new Map<number, MicroBar>();
  for (const trade of trades) {
    const time = Number(trade.time);
    if (!Number.isFinite(time) || time < now - 5 * 60_000) continue;
    const bucket = Math.floor(time / 30_000) * 30_000;
    const price = Number(trade.price);
    const qty = Number(trade.qty);
    let bar = buckets.get(bucket);
    if (!bar) {
      bar = { time: bucket, open: price, high: price, low: price, close: price, volume: 0, takerBuyVolume: 0, takerSellVolume: 0 };
      buckets.set(bucket, bar);
    }
    bar.high = Math.max(bar.high, price);
    bar.low = Math.min(bar.low, price);
    bar.close = price;
    bar.volume += qty;
    if (trade.buyerIsMaker) bar.takerSellVolume += qty;
    else bar.takerBuyVolume += qty;
  }
  return [...buckets.values()].filter((bar) => bar.time + 30_000 <= now).sort((a, b) => a.time - b.time);
}

function spreadPct(book: MarketBook): number {
  const mid = (book.bid + book.ask) / 2;
  return mid > 0 ? Math.max(0, (book.ask - book.bid) / mid * 100) : Number.POSITIVE_INFINITY;
}

function emaSeries(values: number[], period: number): number[] {
  if (!values.length) return [];
  const alpha = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * alpha + out[i - 1] * (1 - alpha));
  return out;
}

function rsi(values: number[], period: number): number {
  if (values.length <= period) return 50;
  let gain = 0;
  let loss = 0;
  const start = values.length - period;
  for (let i = start; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    if (change >= 0) gain += change;
    else loss -= change;
  }
  if (loss === 0) return 100;
  const rs = gain / Math.max(loss, 1e-12);
  return 100 - 100 / (1 + rs);
}

function atr(candles: MinuteCandle[], period: number): number {
  if (candles.length < 2) return 0;
  const values: number[] = [];
  for (let i = Math.max(1, candles.length - period); i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    values.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function emaDistance(fast: number, slow: number, atrValue: number): number {
  return atrValue > 0 ? Math.abs(fast - slow) / atrValue : 0;
}

function scoreSignal(trendStrength: number, momentum: number, flow: number, spread: number, maxSpread: number): number {
  const trend = Math.min(25, trendStrength * 30);
  const momentumScore = Math.min(20, Math.abs(momentum - 50) * 0.8);
  const flowScore = Math.min(25, Math.max(0, flow - 0.5) * 100);
  const spreadScore = Math.max(0, 20 * (1 - spread / Math.max(maxSpread, 1e-9)));
  return Math.round(Math.max(45, Math.min(95, 30 + trend + momentumScore + flowScore + spreadScore)));
}

function roundDown(value: number, step: number, precision: number): number {
  if (!(value > 0)) return 0;
  const normalizedStep = step > 0 ? step : Math.pow(10, -Math.max(0, precision));
  const rounded = Math.floor((value + 1e-12) / normalizedStep) * normalizedStep;
  return Number(rounded.toFixed(Math.max(0, precision)));
}

function roundPrice(value: number, precision: number): number {
  return Number(value.toFixed(Math.max(0, precision)));
}

function mapCommodityTrade(row: Record<string, unknown>): CommodityTradeRow {
  return {
    id: String(row.id),
    venue: String(row.venue) as CommodityVenue,
    mode: String(row.mode) as AppMode,
    symbol: String(row.symbol),
    displaySymbol: String(row.display_symbol),
    side: String(row.side) as TradeSide,
    state: String(row.state) as CommodityState,
    entryPrice: Number(row.entry_price),
    exitPrice: row.exit_price == null ? undefined : Number(row.exit_price),
    stopLoss: Number(row.stop_loss),
    takeProfit: Number(row.take_profit),
    quantity: Number(row.quantity),
    leverage: Number(row.leverage),
    marginUsed: Number(row.margin_used),
    notional: Number(row.notional),
    entrySpreadPct: Number(row.entry_spread_pct),
    estimatedRoundTripCostPct: Number(row.estimated_round_trip_cost_pct),
    entryFee: Number(row.entry_fee ?? 0),
    exitFee: Number(row.exit_fee ?? 0),
    realizedPnl: Number(row.realized_pnl ?? 0),
    unrealizedPnl: Number(row.unrealized_pnl ?? 0),
    openTime: Number(row.open_time),
    closeTime: row.close_time == null ? undefined : Number(row.close_time),
    closeReason: row.close_reason == null ? undefined : String(row.close_reason),
    orderId: row.order_id == null ? undefined : String(row.order_id),
    metadata: row.metadata ? JSON.parse(String(row.metadata)) : undefined,
  };
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
