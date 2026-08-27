import { env } from './config.js';
import type { TelegramCredentials } from './integrationVault.js';
import type { TradeRecord } from './types.js';

export class TelegramService {
  constructor(private readonly getCredentials?: () => TelegramCredentials | null) {}

  private credentials(): TelegramCredentials | null {
    const fromVault = this.getCredentials?.();
    if (fromVault?.botToken && fromVault?.chatId) return fromVault;
    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
      return { botToken: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID };
    }
    return null;
  }

  isConfigured(): boolean {
    return Boolean(this.credentials());
  }

  async testConnection(): Promise<{ ok: true; botUsername?: string; chatId: string }> {
    const credentials = this.credentials();
    if (!credentials) throw new Error('TELEGRAM_CREDENTIALS_NOT_CONFIGURED');

    const meResponse = await fetch(`https://api.telegram.org/bot${credentials.botToken}/getMe`);
    const meText = await meResponse.text();
    let me: any;
    try { me = JSON.parse(meText); } catch { me = null; }
    if (!meResponse.ok || !me?.ok) {
      throw new Error(`TELEGRAM_GETME_FAILED:${me?.description ?? meText.slice(0, 160)}`);
    }

    const testResponse = await fetch(`https://api.telegram.org/bot${credentials.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: credentials.chatId,
        text: '✅ Quantum Dual V34 conectado correctamente.',
        disable_web_page_preview: true,
      }),
    });
    const testText = await testResponse.text();
    let test: any;
    try { test = JSON.parse(testText); } catch { test = null; }
    if (!testResponse.ok || !test?.ok) {
      throw new Error(`TELEGRAM_SEND_TEST_FAILED:${test?.description ?? testText.slice(0, 160)}`);
    }

    return {
      ok: true,
      botUsername: me?.result?.username ? String(me.result.username) : undefined,
      chatId: credentials.chatId,
    };
  }

  async send(text: string): Promise<void> {
    const credentials = this.credentials();
    if (!credentials) return;

    const response = await fetch(`https://api.telegram.org/bot${credentials.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: credentials.chatId,
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
