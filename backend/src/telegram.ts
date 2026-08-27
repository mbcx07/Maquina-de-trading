import { env } from './config.js';
import type { TradeRecord } from './types.js';

export class TelegramService {
  isConfigured(): boolean {
    return Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
  }

  async send(text: string): Promise<void> {
    if (!this.isConfigured()) return;

    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`TELEGRAM_HTTP_${response.status}:${body.slice(0, 180)}`);
    }
  }

  async tradeOpened(trade: TradeRecord, slotText?: string): Promise<void> {
    const market = trade.broker === 'BINANCE' ? 'CRYPTO / BINANCE FUTURES' : 'FOREX / MT5';
    const sizing = trade.broker === 'BINANCE'
      ? `Leverage: ${trade.leverage ?? '-'}x\nMargen: ${money(trade.marginUsed)}\nNocional: ${money(trade.notional)}`
      : `Lote: ${trade.lotSize ?? '-'}`;

    await this.send([
      '🟢 <b>OPERACIÓN ABIERTA</b>',
      `<b>Mercado:</b> ${market}`,
      `<b>Símbolo:</b> ${trade.symbol}`,
      `<b>Dirección:</b> ${trade.side}`,
      `<b>Entrada:</b> ${num(trade.entryPrice)}`,
      `<b>SL:</b> ${num(trade.stopLoss)}`,
      `<b>TP:</b> ${num(trade.takeProfit)}`,
      sizing,
      `<b>Confianza:</b> ${num(trade.confidence)}%`,
      `<b>Rolling WR:</b> ${num(trade.rollingWinRate)}%`,
      `<b>Estrategia:</b> ${trade.strategy}`,
      slotText ? `<b>Slot:</b> ${slotText}` : '',
    ].filter(Boolean).join('\n'));
  }

  async tradeClosed(trade: TradeRecord, cumulativeProfit: number, currentWinRate: number): Promise<void> {
    const win = trade.realizedPnl > 0;
    const icon = win ? '✅' : trade.realizedPnl < 0 ? '❌' : '➖';
    const duration = trade.openTime && trade.closeTime
      ? formatDuration(trade.closeTime - trade.openTime)
      : '-';

    await this.send([
      `${icon} <b>OPERACIÓN CERRADA</b>`,
      `<b>Mercado:</b> ${trade.broker === 'BINANCE' ? 'CRYPTO' : 'FOREX'}`,
      `<b>Símbolo:</b> ${trade.symbol}`,
      `<b>Resultado:</b> ${win ? 'WIN' : trade.realizedPnl < 0 ? 'LOSS' : 'BREAKEVEN'}`,
      `<b>Salida:</b> ${num(trade.exitPrice)}`,
      `<b>PnL:</b> ${money(trade.realizedPnl)}`,
      `<b>Duración:</b> ${duration}`,
      `<b>Cierre:</b> ${trade.closeReason ?? 'UNKNOWN'}`,
      `<b>Win rate:</b> ${num(currentWinRate)}%`,
      `<b>Profit acumulado:</b> ${money(cumulativeProfit)}`,
    ].join('\n'));
  }

  async alert(title: string, detail: string): Promise<void> {
    await this.send(`⚠️ <b>${title}</b>\n${detail}`);
  }
}

function num(value: number | undefined): string {
  return value == null || !Number.isFinite(value) ? '-' : String(Number(value.toFixed(8)));
}

function money(value: number | undefined): string {
  return value == null || !Number.isFinite(value) ? '-' : `${value >= 0 ? '' : '-'}$${Math.abs(value).toFixed(2)}`;
}

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
