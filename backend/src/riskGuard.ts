import { TradingDatabase } from './database.js';
import { TelegramService } from './telegram.js';
import type { EngineSettings } from './types.js';

interface EquityRow {
  broker: 'BINANCE' | 'MT5';
  equity: number;
  created_at: number;
}

export interface RiskStatus {
  status: 'DISABLED' | 'ARMED' | 'TRIPPED' | 'NO_DATA';
  reason?: string;
  broker?: 'BINANCE' | 'MT5';
  dailyDrawdownPct?: number;
  maxDrawdownPct?: number;
  checkedAt: number;
}

export class PortfolioRiskGuard {
  constructor(
    private readonly database: TradingDatabase,
    private readonly telegram: TelegramService,
    private readonly getSettings: () => EngineSettings,
  ) {}

  async evaluate(): Promise<RiskStatus> {
    const settings = this.getSettings();
    const checkedAt = Date.now();

    if (!settings.riskKillSwitchEnabled || settings.appMode === 'PAPER') {
      return this.save({ status: 'DISABLED', checkedAt });
    }

    const rows = this.database.db.prepare(`
      SELECT broker, equity, created_at
      FROM equity_snapshots
      WHERE broker IN ('BINANCE','MT5')
      ORDER BY created_at ASC
    `).all() as EquityRow[];

    if (!rows.length) return this.save({ status: 'NO_DATA', checkedAt });

    const dayStart = utcDayStart(checkedAt);
    const breaches: RiskStatus[] = [];

    for (const broker of ['BINANCE', 'MT5'] as const) {
      const brokerRows = rows.filter((row) => row.broker === broker && row.equity > 0);
      if (!brokerRows.length) continue;

      const latest = brokerRows.at(-1)!;
      const todayRows = brokerRows.filter((row) => row.created_at >= dayStart);
      const dayBase = todayRows[0]?.equity ?? latest.equity;
      const historicalPeak = brokerRows.reduce((peak, row) => Math.max(peak, row.equity), brokerRows[0].equity);

      const dailyDrawdownPct = dayBase > 0
        ? Math.max(0, (dayBase - latest.equity) / dayBase * 100)
        : 0;
      const maxDrawdownPct = historicalPeak > 0
        ? Math.max(0, (historicalPeak - latest.equity) / historicalPeak * 100)
        : 0;

      if (dailyDrawdownPct >= settings.dailyLossLimitPct) {
        breaches.push({
          status: 'TRIPPED',
          reason: `DAILY_LOSS_LIMIT_${settings.dailyLossLimitPct}%`,
          broker,
          dailyDrawdownPct,
          maxDrawdownPct,
          checkedAt,
        });
      } else if (maxDrawdownPct >= settings.maxDrawdownPct) {
        breaches.push({
          status: 'TRIPPED',
          reason: `MAX_DRAWDOWN_LIMIT_${settings.maxDrawdownPct}%`,
          broker,
          dailyDrawdownPct,
          maxDrawdownPct,
          checkedAt,
        });
      }
    }

    if (!breaches.length) return this.save({ status: 'ARMED', checkedAt });

    const breach = breaches.sort((a, b) =>
      Math.max(b.dailyDrawdownPct ?? 0, b.maxDrawdownPct ?? 0) -
      Math.max(a.dailyDrawdownPct ?? 0, a.maxDrawdownPct ?? 0),
    )[0];

    const previous = this.load();
    if (settings.engineEnabled) {
      this.database.saveSettings({ ...settings, engineEnabled: false });
    }

    const saved = this.save(breach);
    if (previous?.status !== 'TRIPPED' || previous.reason !== breach.reason || previous.broker !== breach.broker) {
      await this.telegram.alert(
        'RISK KILL-SWITCH ACTIVADO',
        [
          `Broker: ${breach.broker}`,
          `Motivo: ${breach.reason}`,
          `Pérdida diaria: ${(breach.dailyDrawdownPct ?? 0).toFixed(2)}%`,
          `Drawdown desde máximo: ${(breach.maxDrawdownPct ?? 0).toFixed(2)}%`,
          'Nuevas entradas pausadas. Las posiciones abiertas conservan su protección.',
        ].join('\n'),
      ).catch(() => undefined);
    }

    return saved;
  }

  load(): RiskStatus | null {
    const row = this.database.db.prepare(`SELECT value FROM engine_state WHERE key = 'riskGuard'`).get() as
      | { value: string }
      | undefined;
    if (!row) return null;
    try { return JSON.parse(row.value) as RiskStatus; } catch { return null; }
  }

  private save(status: RiskStatus): RiskStatus {
    this.database.db.prepare(`
      INSERT INTO engine_state(key, value, updated_at)
      VALUES('riskGuard', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(JSON.stringify(status), status.checkedAt);
    return status;
  }
}

function utcDayStart(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}
