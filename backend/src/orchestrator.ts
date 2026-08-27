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

    if (autoExecute && settings.engineEnabled) {
      for (const opportunity of selectedCrypto) {
        try {
          const trade = await this.cryptoExecution.execute(opportunity);
          executionResults.push({ opportunityId: opportunity.id, broker: 'BINANCE', ok: true, tradeId: trade.id });
        } catch (error) {
          executionResults.push({
            opportunityId: opportunity.id,
            broker: 'BINANCE',
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    // Hard product rule for the Linux individual edition: Forex can be ranked and
    // surfaced as a signal, but this orchestrator never creates an MT5/Forex trade.
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
