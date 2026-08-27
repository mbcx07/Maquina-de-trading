import { Router, type Request } from 'express';
import { z } from 'zod';
import { BinanceUsdmClient } from './binance.js';
import { IntegrationVault, normalizeWorkspaceId, type IntegrationProvider } from './integrationVault.js';
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
      res.json({
        ok: true,
        workspaceId,
        integrations: vault.getStatus(workspaceId),
      });
    } catch (error) {
      res.status(400).json({ error: message(error) });
    }
  });

  router.put('/binance', async (req, res) => {
    try {
      const workspaceId = workspaceFor(req);
      const body = z.object({
        apiKey: z.string().min(8).max(512),
        apiSecret: z.string().min(8).max(512),
      }).parse(req.body);

      vault.saveBinance(workspaceId, body);
      const test = await testBinance(vault, workspaceId, getSettings);
      res.json({
        ok: test.ok,
        workspaceId,
        test,
        integrations: vault.getStatus(workspaceId),
      });
    } catch (error) {
      res.status(400).json({ error: message(error) });
    }
  });

  router.put('/telegram', async (req, res) => {
    try {
      const workspaceId = workspaceFor(req);
      const body = z.object({
        botToken: z.string().min(10).max(512),
        chatId: z.string().min(1).max(128),
      }).parse(req.body);

      vault.saveTelegram(workspaceId, body);
      const test = await testTelegram(vault, workspaceId);
      res.json({
        ok: test.ok,
        workspaceId,
        test,
        integrations: vault.getStatus(workspaceId),
      });
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
        : await testTelegram(vault, workspaceId);
      res.status(test.ok ? 200 : 400).json({
        ok: test.ok,
        workspaceId,
        provider,
        test,
        integrations: vault.getStatus(workspaceId),
      });
    } catch (error) {
      res.status(400).json({ error: message(error) });
    }
  });

  router.delete('/:provider', (req, res) => {
    try {
      const workspaceId = workspaceFor(req);
      const provider = providerFrom(req.params.provider);
      vault.remove(workspaceId, provider);
      res.json({
        ok: true,
        workspaceId,
        provider,
        integrations: vault.getStatus(workspaceId),
      });
    } catch (error) {
      res.status(400).json({ error: message(error) });
    }
  });

  return router;
}

async function testBinance(
  vault: IntegrationVault,
  workspaceId: string,
  getSettings: () => EngineSettings,
): Promise<Record<string, unknown>> {
  const credentials = vault.getBinance(workspaceId);
  if (!credentials) throw new Error('BINANCE_CREDENTIALS_NOT_CONFIGURED');
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

async function testTelegram(
  vault: IntegrationVault,
  workspaceId: string,
): Promise<Record<string, unknown>> {
  const credentials = vault.getTelegram(workspaceId);
  if (!credentials) throw new Error('TELEGRAM_CREDENTIALS_NOT_CONFIGURED');
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

function providerFrom(value: string | undefined): IntegrationProvider {
  const provider = String(value || '').toUpperCase();
  if (provider !== 'BINANCE' && provider !== 'TELEGRAM') throw new Error('UNKNOWN_INTEGRATION_PROVIDER');
  return provider;
}

function message(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  }
  return error instanceof Error ? error.message : String(error);
}
