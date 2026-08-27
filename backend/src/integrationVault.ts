import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { env } from './config.js';
import { TradingDatabase } from './database.js';

export type IntegrationProvider = 'BINANCE' | 'TELEGRAM';

export interface BinanceCredentials {
  apiKey: string;
  apiSecret: string;
}

export interface TelegramCredentials {
  botToken: string;
  chatId: string;
}

export interface IntegrationStatus {
  provider: IntegrationProvider;
  configured: boolean;
  maskedPrimary?: string;
  maskedSecondary?: string;
  lastTestOk?: boolean;
  lastTestAt?: number;
  lastError?: string;
  updatedAt?: number;
}

interface SecretEnvelope {
  v: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

export class IntegrationVault {
  private readonly key: Buffer;

  constructor(private readonly database: TradingDatabase) {
    this.ensureSchema();
    this.key = loadMasterKey();
  }

  private ensureSchema(): void {
    this.database.db.exec(`
      CREATE TABLE IF NOT EXISTS integration_credentials (
        workspace_id TEXT NOT NULL,
        provider TEXT NOT NULL CHECK (provider IN ('BINANCE','TELEGRAM')),
        encrypted_payload TEXT NOT NULL,
        masked_primary TEXT,
        masked_secondary TEXT,
        last_test_ok INTEGER,
        last_test_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(workspace_id, provider)
      );

      CREATE INDEX IF NOT EXISTS idx_integration_workspace
        ON integration_credentials(workspace_id, provider);
    `);
  }

  saveBinance(workspaceId: string, credentials: BinanceCredentials): void {
    const apiKey = credentials.apiKey.trim();
    const apiSecret = credentials.apiSecret.trim();
    if (!apiKey || !apiSecret) throw new Error('BINANCE_CREDENTIALS_REQUIRED');
    this.save(workspaceId, 'BINANCE', { apiKey, apiSecret }, mask(apiKey, 4, 4), mask(apiSecret, 2, 2));
  }

  saveTelegram(workspaceId: string, credentials: TelegramCredentials): void {
    const botToken = credentials.botToken.trim();
    const chatId = credentials.chatId.trim();
    if (!botToken || !chatId) throw new Error('TELEGRAM_CREDENTIALS_REQUIRED');
    this.save(workspaceId, 'TELEGRAM', { botToken, chatId }, mask(botToken, 5, 4), mask(chatId, 3, 3));
  }

  getBinance(workspaceId: string): BinanceCredentials | null {
    return this.get<BinanceCredentials>(workspaceId, 'BINANCE');
  }

  getTelegram(workspaceId: string): TelegramCredentials | null {
    return this.get<TelegramCredentials>(workspaceId, 'TELEGRAM');
  }

  getStatus(workspaceId: string): IntegrationStatus[] {
    const rows = this.database.db.prepare(`
      SELECT provider, masked_primary, masked_secondary, last_test_ok, last_test_at,
             last_error, updated_at
      FROM integration_credentials
      WHERE workspace_id = ?
      ORDER BY provider
    `).all(workspaceId) as Array<Record<string, unknown>>;

    const map = new Map(rows.map((row) => [String(row.provider), row]));
    return (['BINANCE', 'TELEGRAM'] as IntegrationProvider[]).map((provider) => {
      const row = map.get(provider);
      if (!row) return { provider, configured: false };
      return {
        provider,
        configured: true,
        maskedPrimary: row.masked_primary == null ? undefined : String(row.masked_primary),
        maskedSecondary: row.masked_secondary == null ? undefined : String(row.masked_secondary),
        lastTestOk: row.last_test_ok == null ? undefined : Boolean(row.last_test_ok),
        lastTestAt: row.last_test_at == null ? undefined : Number(row.last_test_at),
        lastError: row.last_error == null ? undefined : String(row.last_error),
        updatedAt: Number(row.updated_at),
      };
    });
  }

  markTest(workspaceId: string, provider: IntegrationProvider, ok: boolean, error?: string): void {
    this.database.db.prepare(`
      UPDATE integration_credentials
      SET last_test_ok = ?, last_test_at = ?, last_error = ?, updated_at = ?
      WHERE workspace_id = ? AND provider = ?
    `).run(ok ? 1 : 0, Date.now(), error ?? null, Date.now(), workspaceId, provider);
  }

  remove(workspaceId: string, provider: IntegrationProvider): void {
    this.database.db.prepare(`
      DELETE FROM integration_credentials
      WHERE workspace_id = ? AND provider = ?
    `).run(workspaceId, provider);
  }

  private save(
    workspaceId: string,
    provider: IntegrationProvider,
    payload: Record<string, string>,
    maskedPrimary: string,
    maskedSecondary: string,
  ): void {
    const normalizedWorkspace = normalizeWorkspaceId(workspaceId);
    const encrypted = this.encrypt(JSON.stringify(payload));
    const now = Date.now();

    this.database.db.prepare(`
      INSERT INTO integration_credentials(
        workspace_id, provider, encrypted_payload, masked_primary, masked_secondary,
        last_test_ok, last_test_at, last_error, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
      ON CONFLICT(workspace_id, provider) DO UPDATE SET
        encrypted_payload = excluded.encrypted_payload,
        masked_primary = excluded.masked_primary,
        masked_secondary = excluded.masked_secondary,
        last_test_ok = NULL,
        last_test_at = NULL,
        last_error = NULL,
        updated_at = excluded.updated_at
    `).run(
      normalizedWorkspace,
      provider,
      encrypted,
      maskedPrimary,
      maskedSecondary,
      now,
      now,
    );
  }

  private get<T>(workspaceId: string, provider: IntegrationProvider): T | null {
    const row = this.database.db.prepare(`
      SELECT encrypted_payload
      FROM integration_credentials
      WHERE workspace_id = ? AND provider = ?
    `).get(normalizeWorkspaceId(workspaceId), provider) as { encrypted_payload: string } | undefined;

    if (!row) return null;
    const plaintext = this.decrypt(row.encrypted_payload);
    return JSON.parse(plaintext) as T;
  }

  private encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const envelope: SecretEnvelope = {
      v: 1,
      iv: iv.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
    };
    return JSON.stringify(envelope);
  }

  private decrypt(serialized: string): string {
    const envelope = JSON.parse(serialized) as SecretEnvelope;
    if (envelope.v !== 1) throw new Error('UNSUPPORTED_SECRET_ENVELOPE');
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      this.key,
      Buffer.from(envelope.iv, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  }
}

export function normalizeWorkspaceId(value: string | undefined | null): string {
  const normalized = String(value || env.DEFAULT_WORKSPACE_ID || 'default').trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(normalized)) throw new Error('INVALID_WORKSPACE_ID');
  return normalized;
}

function loadMasterKey(): Buffer {
  const configured = String(env.INTEGRATION_MASTER_KEY || '').trim();
  if (configured) {
    const key = decodeConfiguredKey(configured);
    if (key.length !== 32) throw new Error('INTEGRATION_MASTER_KEY_MUST_BE_32_BYTES');
    return key;
  }

  // Local single-node fallback. Production/membership deployments should provide
  // INTEGRATION_MASTER_KEY through the hosting secret manager so multiple instances
  // share the same encryption key and backups remain decryptable.
  const keyPath = path.resolve(env.LOCAL_VAULT_KEY_PATH);
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  if (fs.existsSync(keyPath)) {
    const existing = Buffer.from(fs.readFileSync(keyPath, 'utf8').trim(), 'base64url');
    if (existing.length !== 32) throw new Error('LOCAL_VAULT_KEY_INVALID');
    return existing;
  }

  const generated = crypto.randomBytes(32);
  fs.writeFileSync(keyPath, generated.toString('base64url'), { mode: 0o600, flag: 'wx' });
  return generated;
}

function decodeConfiguredKey(value: string): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex');
  try { return Buffer.from(value, 'base64url'); } catch { return Buffer.alloc(0); }
}

function mask(value: string, left: number, right: number): string {
  if (value.length <= left + right) return `${value.slice(0, 1)}••••`;
  return `${value.slice(0, left)}••••••${value.slice(-right)}`;
}
