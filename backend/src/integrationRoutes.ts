import { Router, type Request } from 'express';
import { z } from 'zod';
import { BinanceUsdmClient } from './binance.js';
import { ForexDataClient } from './forexData.js';
import { IntegrationVault, normalizeWorkspaceId, type IntegrationProvider } from './integrationVault.js';
import { Mt5BridgeClient } from './mt5.js';
import { TelegramService } from './telegram.js';
import type { EngineSettings } from './types.js';

export type WorkspaceResolver = (req: Request) => string;

export function createIntegrationRouter(
  vault: IntegrationVault,
  getSettings: () => EngineSettings,
  resolveWorkspaceId: WorkspaceResolver = () => normalizeWorkspaceId(undefined),
): Router {
  const router = Router();
  const workspaceFor = (req: Request) => normalizeWorkspaceId(resolveWorkspaceId(req));

  router.get('/', (req, res) => {
    try {
      const workspaceId = workspaceFor(req);
      res.json({ ok: true, workspaceId, integrations: vault.getStatus(workspaceId) });
    } catch (error) {
      res.status(400).json({ error: message(error) });
    }
  });

  router.put('/binance', async (req, res) => {
    try {
      const workspaceId = workspaceFor(req);
      const body = z.object({ apiKey: z.string().min(8).max(512), apiSecret: z.string().min(8).max(512) }).parse(req.body);
      vault.saveBinance(workspaceId, body);
      const test = await testBinance(vault, workspaceId, getSettings);
      res.status(test.ok ? 200 : 400).json({ ok: test.ok, workspaceId, test, integrations: vault.getStatus(workspaceId) });
    } catch (error) {
      res.status(400).json({ error: message(error) });
    }
  });

  router.put('/telegram', async (req, res) => {
    try {
      const workspaceId = workspaceFor(req);
      const body = z.object({ botToken: z.string().min(10).max(512), chatId: z.string().min(1).max(128) }).parse(req.body);
      vault.saveTelegram(workspaceId, body);
      const test = await testTelegram(vault, workspaceId);
      res.status(test.ok ? 200 : 400).json({ ok: test.ok, workspaceId, test, integrations: vault.getStatus(workspaceId) });
    } catch (error) {
      res.status(400).json({ error: message(error) });
    }
  });

  router.put('/twelve-data', async (req, res) => {
    try {
      const workspaceId = workspaceFor(req);
      const body = z.object({ apiKey: z.string().min(8).max(512) }).parse(req.body);
      vault.saveTwelveData(workspaceId, body);
      const test = await testTwelveData(vault, workspaceId);
      res.status(test.ok ? 200 : 400).json({ ok: test.ok, workspaceId, test, integrations: vault.getStatus(workspaceId) });
    } catch (error) {
      res.status(400).json({ error: message(error) });
    }
  });

  // Legacy MT5 connector kept for migration/backward compatibility. Linux individual
  // runtime does not require or execute through MT5.
  router.put('/mt5', async (req, res) => {
    try {
      const workspaceId = workspaceFor(req);
      const body = z.object({ bridgeUrl: z.string().url().max(1024), bridgeToken: z.string().min(4).max(512) }).parse(req.body);
      vault.saveMt5(workspaceId, body);
      const test = await testMt5(vault, workspaceId, getSettings);
      res.status(test.ok ? 200 : 400).json({ ok: test.ok, workspaceId, test, integrations: vault.getStatus(workspaceId) });
    } catch (error) {
      res.status(400).json({ error: message(error) });
    }
  });

  router.post('/:provider/test', async (req, res) => {
    try {
      const workspaceId = workspaceFor(req);
      const provider = providerFrom(req.params.provider);
      const test = provider === 'BINANCE'
        ? await testBinance(vault, workspaceId, getSettings)
        : provider === 'TELEGRAM'
          ? await testTelegram(vault, workspaceId)
          : provider === 'TWELVE_DATA'
            ? await testTwelveData(vault, workspaceId)
            : await testMt5(vault, workspaceId, getSettings);
      res.status(test.ok ? 200 : 400).json({ ok: test.ok, workspaceId, provider, test, integrations: vault.getStatus(workspaceId) });
    } catch (error) {
      res.status(400).json({ error: message(error) });
    }
  });

  router.delete('/:provider', (req, res) => {
    try {
      const workspaceId = workspaceFor(req);
      const provider = providerFrom(req.params.provider);
      vault.remove(workspaceId, provider);
      res.json({ ok: true, workspaceId, provider, integrations: vault.getStatus(workspaceId) });
    } catch (error) {
      res.status(400).json({ error: message(error) });
    }
  });

  return router;
}

async function testBinance(vault: IntegrationVault, workspaceId: string, getSettings: () => EngineSettings): Promise<Record<string, unknown>> {
  if (!vault.getBinance(workspaceId)) throw new Error('BINANCE_CREDENTIALS_NOT_CONFIGURED');
  const client = new BinanceUsdmClient(getSettings, () => vault.getBinance(workspaceId));
  try {
    const result = await client.testConnection();
    vault.markTest(workspaceId, 'BINANCE', true);
    return { ...result, mode: getSettings().appMode };
  } catch (error) {
    const detail = message(error);
    vault.markTest(workspaceId, 'BINANCE', false, detail);
    return { ok: false, error: detail, mode: getSettings().appMode };
  }
}

async function testTelegram(vault: IntegrationVault, workspaceId: string): Promise<Record<string, unknown>> {
  if (!vault.getTelegram(workspaceId)) throw new Error('TELEGRAM_CREDENTIALS_NOT_CONFIGURED');
  const telegram = new TelegramService(() => vault.getTelegram(workspaceId));
  try {
    const result = await telegram.testConnection();
    vault.markTest(workspaceId, 'TELEGRAM', true);
    return result;
  } catch (error) {
    const detail = message(error);
    vault.markTest(workspaceId, 'TELEGRAM', false, detail);
    return { ok: false, error: detail };
  }
}

async function testTwelveData(vault: IntegrationVault, workspaceId: string): Promise<Record<string, unknown>> {
  if (!vault.getTwelveData(workspaceId)) throw new Error('TWELVE_DATA_API_KEY_NOT_CONFIGURED');
  const client = new ForexDataClient(() => vault.getTwelveData(workspaceId));
  try {
    const result = await client.testConnection();
    vault.markTest(workspaceId, 'TWELVE_DATA', true);
    return result;
  } catch (error) {
    const detail = message(error);
    vault.markTest(workspaceId, 'TWELVE_DATA', false, detail);
    return { ok: false, error: detail };
  }
}

async function testMt5(vault: IntegrationVault, workspaceId: string, getSettings: () => EngineSettings): Promise<Record<string, unknown>> {
  if (!vault.getMt5(workspaceId)) throw new Error('MT5_BRIDGE_NOT_CONFIGURED');
  const client = new Mt5BridgeClient(getSettings, () => vault.getMt5(workspaceId));
  try {
    const result = await client.health();
    vault.markTest(workspaceId, 'MT5', true);
    return {
      ok: true,
      account: {
        login: result.account.login,
        server: result.account.server,
        currency: result.account.currency,
        hedging: result.account.hedging,
        balance: result.account.balance,
        equity: result.account.equity,
        leverage: result.account.leverage,
        tradeAllowed: result.account.tradeAllowed,
        tradeExpert: result.account.tradeExpert,
      },
    };
  } catch (error) {
    const detail = message(error);
    vault.markTest(workspaceId, 'MT5', false, detail);
    return { ok: false, error: detail };
  }
}

function providerFrom(value: string | undefined): IntegrationProvider {
  const provider = String(value || '').toUpperCase().replace('-', '_');
  if (!['BINANCE', 'TELEGRAM', 'MT5', 'TWELVE_DATA'].includes(provider)) throw new Error('UNKNOWN_INTEGRATION_PROVIDER');
  return provider as IntegrationProvider;
}

function message(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  return error instanceof Error ? error.message : String(error);
}
