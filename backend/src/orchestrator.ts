import { CryptoExecutionService } from './cryptoExecution.js';
import { TradingDatabase } from './database.js';
import { ForexExecutionService } from './forexExecution.js';
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
    private readonly forexExecution: ForexExecutionService,
    private readonly getSettings: () => EngineSettings,
  ) {}

  async process(opportunities: Opportunity[], autoExecute = true): Promise<OrchestrationResult> {
    for (const opportunity of opportunities) this.repository.saveSignal(opportunity);

    const settings = this.getSettings();
    const activeTrades = this.database.getActiveTrades();
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

      for (const opportunity of selectedForex) {
        try {
          const trade = await this.forexExecution.execute(opportunity);
          executionResults.push({ opportunityId: opportunity.id, broker: 'MT5', ok: true, tradeId: trade.id });
        } catch (error) {
          executionResults.push({
            opportunityId: opportunity.id,
            broker: 'MT5',
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    return {
      received: opportunities.length,
      selected: { crypto: selectedCrypto, forex: selectedForex },
      executionResults,
    };
  }
}
