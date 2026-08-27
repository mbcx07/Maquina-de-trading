import { BinanceUsdmClient } from './binance.js';
import { TradingDatabase } from './database.js';
import { TradingRepository } from './repositories.js';
import { TelegramService } from './telegram.js';
import type { EngineSettings, TradeRecord, TradeSide } from './types.js';

export interface EmergencyStopResult {
  mode: EngineSettings['emergencyStopMode'];
  paused: boolean;
  attempted: number;
  closeRequested: number;
  failed: number;
  results: Array<{
    tradeId: string;
    broker: 'BINANCE';
    symbol: string;
    ok: boolean;
    detail?: string;
  }>;
}

export class EmergencyStopService {
  constructor(
    private readonly database: TradingDatabase,
    private readonly repository: TradingRepository,
    private readonly binance: BinanceUsdmClient,
    private readonly telegram: TelegramService,
    private readonly getSettings: () => EngineSettings,
  ) {}

  async trigger(): Promise<EmergencyStopResult> {
    const settings = this.getSettings();
    this.database.saveSettings({ ...settings, engineEnabled: false });
    this.database.db.prepare(`
      INSERT INTO engine_state(key, value, updated_at)
      VALUES('emergencyStop', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(JSON.stringify({ active: true, mode: settings.emergencyStopMode, at: Date.now() }), Date.now());

    if (settings.emergencyStopMode === 'PAUSE_ONLY') {
      const result: EmergencyStopResult = {
        mode: 'PAUSE_ONLY', paused: true, attempted: 0, closeRequested: 0, failed: 0, results: [],
      };
      await this.telegram.alert(
        'EMERGENCY STOP · PAUSE ONLY',
        'Nuevas entradas Binance bloqueadas. Las posiciones gestionadas permanecen abiertas con sus SL/TP. Forex solo emite señales y queda pausado.',
      ).catch(() => undefined);
      return result;
    }

    const tracked = this.database.getActiveTrades('BINANCE');
    if (settings.appMode === 'PAPER') {
      for (const trade of tracked) this.closePaper(trade);
      const result: EmergencyStopResult = {
        mode: 'CLOSE_TRACKED',
        paused: true,
        attempted: tracked.length,
        closeRequested: tracked.length,
        failed: 0,
        results: tracked.map((trade) => ({ tradeId: trade.id, broker: 'BINANCE', symbol: trade.symbol, ok: true, detail: 'PAPER_CLOSED' })),
      };
      await this.telegram.alert('EMERGENCY STOP · CLOSE TRACKED', `PAPER: ${tracked.length} operaciones Binance gestionadas cerradas.`).catch(() => undefined);
      return result;
    }

    const results: EmergencyStopResult['results'] = [];
    let positionMap = new Map<string, { positionAmt: number }>();
    try {
      const positions = await this.binance.getPositions();
      positionMap = new Map(positions.map((position) => [position.symbol.toUpperCase(), position]));
    } catch (error) {
      const detail = message(error);
      for (const trade of tracked) results.push({ tradeId: trade.id, broker: 'BINANCE', symbol: trade.symbol, ok: false, detail });
    }

    for (const trade of tracked) {
      if (results.some((result) => result.tradeId === trade.id)) continue;
      try {
        const live = positionMap.get(trade.symbol.toUpperCase());
        if (!live || Math.abs(live.positionAmt) <= 0) {
          this.repository.patchTrade(trade.id, { state: 'SYNC_REQUIRED' });
          results.push({ tradeId: trade.id, broker: 'BINANCE', symbol: trade.symbol, ok: true, detail: 'NO_LIVE_POSITION_RECONCILE' });
          continue;
        }

        this.repository.patchTrade(trade.id, { state: 'CLOSING' });
        await this.binance.cancelAllAlgoOpenOrders(trade.symbol).catch(() => undefined);
        const closeSide: TradeSide = live.positionAmt > 0 ? 'SELL' : 'BUY';
        await this.binance.signedRequest('/fapi/v1/order', 'POST', {
          symbol: trade.symbol.toUpperCase(),
          side: closeSide,
          type: 'MARKET',
          quantity: Math.abs(live.positionAmt),
          reduceOnly: true,
          newOrderRespType: 'RESULT',
        });
        this.database.addTradeEvent(trade.id, 'EMERGENCY_CLOSE_REQUESTED', { broker: 'BINANCE', mode: 'CLOSE_TRACKED' });
        results.push({ tradeId: trade.id, broker: 'BINANCE', symbol: trade.symbol, ok: true, detail: 'REDUCE_ONLY_MARKET_SENT' });
      } catch (error) {
        this.repository.patchTrade(trade.id, { state: 'SYNC_REQUIRED' });
        const detail = message(error);
        this.database.addTradeEvent(trade.id, 'EMERGENCY_CLOSE_FAILED', { broker: 'BINANCE', error: detail });
        results.push({ tradeId: trade.id, broker: 'BINANCE', symbol: trade.symbol, ok: false, detail });
      }
    }

    const closeRequested = results.filter((result) => result.ok).length;
    const failed = results.filter((result) => !result.ok).length;
    const output: EmergencyStopResult = {
      mode: 'CLOSE_TRACKED',
      paused: true,
      attempted: tracked.length,
      closeRequested,
      failed,
      results,
    };

    await this.telegram.alert(
      'EMERGENCY STOP · CLOSE TRACKED',
      `Motor pausado. Cierres Binance solicitados: ${closeRequested}/${tracked.length}. Fallos: ${failed}. Forex es signal-only y no tiene posiciones que cerrar.`,
    ).catch(() => undefined);
    return output;
  }

  private closePaper(trade: TradeRecord): void {
    const now = Date.now();
    this.repository.patchTrade(trade.id, {
      state: 'CLOSED',
      exitPrice: trade.entryPrice,
      unrealizedPnl: 0,
      realizedPnl: 0,
      closeReason: 'MANUAL',
      closeTime: now,
    });
    this.database.addTradeEvent(trade.id, 'EMERGENCY_PAPER_CLOSE', { at: now });
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
