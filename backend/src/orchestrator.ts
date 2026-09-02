import { CryptoExecutionService } from './cryptoExecution.js';
import { TradingDatabase } from './database.js';
import { TradingRepository } from './repositories.js';
import { selectCryptoOpportunities, selectForexOpportunities } from './selection.js';
import type { EngineSettings, Opportunity } from './types.js';

export interface OrchestrationResult {
  received: number;
  selected: {
    crypto: Opportunity[];
    forex: Opportunity[];
  };
  executionResults: Array<Record<string, unknown>>;
}

export class OpportunityOrchestrator {
  constructor(
    private readonly database: TradingDatabase,
    private readonly repository: TradingRepository,
    private readonly cryptoExecution: CryptoExecutionService,
    private readonly getSettings: () => EngineSettings,
  ) {}

  async process(opportunities: Opportunity[], autoExecute = true): Promise<OrchestrationResult> {
    for (const opportunity of opportunities) this.repository.saveSignal(opportunity);

    const settings = this.getSettings();
    const allActiveTrades = this.database.getActiveTrades();
    const activeTrades = allActiveTrades.filter((trade) =>
      trade.broker !== 'BINANCE' || (trade.executionMode ?? 'REAL') === settings.appMode,
    );
    const context = {
      maxCryptoTrades: Math.min(10, settings.maxConcurrentCryptoTrades),
      maxForexTrades: settings.maxConcurrentForexTrades,
      forexMaxEntriesPerSymbol: settings.forexMaxEntriesPerSymbol,
      activeTrades,
    };

    const eligibleCrypto = opportunities.filter((opportunity) =>
      opportunity.broker === 'BINANCE' &&
      opportunity.confidence >= settings.cryptoMinSignalConfidence &&
      opportunity.rollingWinRate >= settings.cryptoMinRollingWinRate,
    );
    const eligibleForex = opportunities.filter((opportunity) =>
      opportunity.broker === 'MT5' &&
      opportunity.confidence >= settings.forexMinSignalConfidence &&
      opportunity.rollingWinRate >= settings.forexMinRollingWinRate,
    );

    const selectedCrypto = selectCryptoOpportunities(eligibleCrypto, context);
    const selectedForex = selectForexOpportunities(eligibleForex, context);
    const executionResults: Array<Record<string, unknown>> = [];

    if (autoExecute && settings.engineEnabled && selectedCrypto.length) {
      // Important latency rule: Binance opportunities are independent symbols and are
      // intentionally launched together. The executor performs the final SQLite atomic
      // reservation, so concurrent promises cannot exceed max slots or duplicate a symbol.
      // This avoids a slow first order making later retest opportunities stale.
      const settled = await Promise.allSettled(
        selectedCrypto.map(async (opportunity) => {
          const trade = await this.cryptoExecution.execute(opportunity);
          return { opportunityId: opportunity.id, broker: 'BINANCE', ok: true, tradeId: trade.id } as Record<string, unknown>;
        }),
      );

      for (let i = 0; i < settled.length; i++) {
        const item = settled[i];
        const opportunity = selectedCrypto[i];
        if (item.status === 'fulfilled') executionResults.push(item.value);
        else executionResults.push({
          opportunityId: opportunity.id,
          broker: 'BINANCE',
          ok: false,
          error: item.reason instanceof Error ? item.reason.message : String(item.reason),
        });
      }
    }

    // Legacy Forex path remains signal-only when invoked from the old runtime.
    for (const opportunity of selectedForex) {
      executionResults.push({
        opportunityId: opportunity.id,
        broker: 'MT5',
        ok: true,
        signalOnly: true,
        executed: false,
      });
    }

    return {
      received: opportunities.length,
      selected: { crypto: selectedCrypto, forex: selectedForex },
      executionResults,
    };
  }
}
