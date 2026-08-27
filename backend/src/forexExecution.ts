import crypto from 'node:crypto';
import { TradingDatabase } from './database.js';
import { Mt5BridgeClient } from './mt5.js';
import { TradingRepository } from './repositories.js';
import { TelegramService } from './telegram.js';
import type { EngineSettings, Opportunity, TradeRecord } from './types.js';

export class ForexExecutionService {
  constructor(
    private readonly database: TradingDatabase,
    private readonly repository: TradingRepository,
    private readonly mt5: Mt5BridgeClient,
    private readonly telegram: TelegramService,
    private readonly getSettings: () => EngineSettings,
  ) {}

  async execute(opportunity: Opportunity): Promise<TradeRecord> {
    if (opportunity.broker !== 'MT5') throw new Error('NOT_AN_MT5_OPPORTUNITY');

    const settings = this.getSettings();
    if (!settings.engineEnabled) throw new Error('ENGINE_DISABLED');
    if (!settings.forexEnabled) throw new Error('FOREX_ENGINE_DISABLED');

    this.repository.saveSignal(opportunity);

    const active = this.database.getActiveTrades('MT5');
    if (active.length >= settings.maxConcurrentForexTrades) {
      this.repository.rejectOpportunity(opportunity.id, 'FOREX_MAX_SLOTS_REACHED');
      throw new Error('FOREX_MAX_SLOTS_REACHED');
    }

    if (active.some((trade) => trade.signalFingerprint === opportunity.signalFingerprint)) {
      this.repository.rejectOpportunity(opportunity.id, 'FOREX_SIGNAL_ALREADY_ACTIVE');
      throw new Error('FOREX_SIGNAL_ALREADY_ACTIVE');
    }

    const symbol = opportunity.symbol.toUpperCase();
    const sameSymbol = active.filter((trade) => trade.symbol.toUpperCase() === symbol);
    if (
      settings.forexMaxEntriesPerSymbol > 0 &&
      sameSymbol.length >= settings.forexMaxEntriesPerSymbol
    ) {
      this.repository.rejectOpportunity(opportunity.id, 'FOREX_SYMBOL_ENTRY_LIMIT');
      throw new Error('FOREX_SYMBOL_ENTRY_LIMIT');
    }

    let lotSize = Number(opportunity.metadata?.lotSize ?? 0.01);
    let hedging = true;
    let spreadPoints: number | undefined;

    if (settings.appMode !== 'PAPER') {
      const [account, snapshot] = await Promise.all([
        this.mt5.account(),
        this.mt5.marketSnapshot(symbol),
      ]);
      hedging = account.hedging;
      spreadPoints = snapshot.spreadPoints;

      if (
        settings.forexMaxSpreadPoints > 0 &&
        snapshot.spreadPoints > settings.forexMaxSpreadPoints
      ) {
        this.repository.rejectOpportunity(opportunity.id, 'FOREX_SPREAD_TOO_WIDE');
        this.database.db.prepare(`
          INSERT INTO engine_state(key, value, updated_at)
          VALUES(?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
        `).run(
          `spreadReject:${symbol}`,
          JSON.stringify({
            symbol,
            spreadPoints: snapshot.spreadPoints,
            maxSpreadPoints: settings.forexMaxSpreadPoints,
            bid: snapshot.bid,
            ask: snapshot.ask,
            at: Date.now(),
          }),
          Date.now(),
        );
        throw new Error(
          `FOREX_SPREAD_TOO_WIDE:${symbol}:${snapshot.spreadPoints.toFixed(1)}>${settings.forexMaxSpreadPoints}`,
        );
      }

      if (sameSymbol.length > 0 && !hedging) {
        this.repository.rejectOpportunity(opportunity.id, 'MT5_NETTING_BLOCKS_REENTRY');
        throw new Error('MT5_NETTING_BLOCKS_REENTRY');
      }

      const sizing = await this.mt5.calculateSize({
        symbol,
        side: opportunity.side,
        entry: opportunity.entry,
        sl: opportunity.stopLoss,
      });
      lotSize = sizing.volume;
    }

    const id = `FX-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const now = Date.now();
    const reserved: TradeRecord = {
      id,
      broker: 'MT5',
      symbol,
      side: opportunity.side,
      strategy: opportunity.strategy,
      timeframe: opportunity.timeframe,
      confidence: opportunity.confidence,
      rollingWinRate: opportunity.rollingWinRate,
      entryPrice: opportunity.entry,
      stopLoss: opportunity.stopLoss,
      takeProfit: opportunity.takeProfit,
      tp2: opportunity.tp2,
      tp3: opportunity.tp3,
      lotSize,
      commission: 0,
      fundingOrSwap: 0,
      unrealizedPnl: 0,
      realizedPnl: 0,
      state: 'OPENING',
      signalId: opportunity.signalId,
      signalFingerprint: opportunity.signalFingerprint,
      createdAt: now,
      updatedAt: now,
      metadata: {
        opportunityId: opportunity.id,
        score: opportunity.score,
        reentryNumberForSymbol: sameSymbol.length + 1,
        hedging,
        spreadPoints,
        maxSpreadPoints: settings.forexMaxSpreadPoints,
      },
    };

    this.repository.createTradeAtomically(reserved);

    try {
      let ticket = Number(`${Date.now()}`.slice(-9));
      let fillPrice = opportunity.entry;
      let filledVolume = lotSize;

      if (settings.appMode !== 'PAPER') {
        const result = await this.mt5.openOrder({
          symbol,
          side: opportunity.side,
          volume: lotSize,
          sl: opportunity.stopLoss,
          tp: opportunity.takeProfit,
          comment: `V34-${opportunity.signalId}`,
        });
        ticket = result.ticket;
        fillPrice = result.price || opportunity.entry;
        filledVolume = result.volume || lotSize;
      }

      const openTime = Date.now();
      this.repository.patchTrade(id, {
        state: 'OPEN',
        entryPrice: fillPrice,
        lotSize: filledVolume,
        brokerOrderId: String(ticket),
        openTime,
      });
      this.database.addTradeEvent(id, 'TRADE_OPENED', {
        ticket,
        symbol,
        reentryNumberForSymbol: sameSymbol.length + 1,
        hedging,
        spreadPoints,
      });

      const opened = this.database.getActiveTrades('MT5').find((trade) => trade.id === id);
      if (!opened) throw new Error('OPENED_FOREX_TRADE_NOT_FOUND');

      const usedSlots = this.database.getActiveTrades('MT5').length;
      const sameNow = this.database.getActiveTrades('MT5').filter((trade) => trade.symbol === symbol).length;
      await this.telegram.tradeOpened(
        opened,
        `Forex ${usedSlots}/${settings.maxConcurrentForexTrades} · ${symbol} entrada #${sameNow}`,
      ).catch(() => undefined);

      return opened;
    } catch (error) {
      this.repository.patchTrade(id, {
        state: 'REJECTED',
        closeReason: 'ERROR',
        closeTime: Date.now(),
      });
      this.database.addTradeEvent(id, 'TRADE_OPEN_FAILED', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
