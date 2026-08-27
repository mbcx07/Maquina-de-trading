const API_BASE = (import.meta as any).env?.VITE_V34_API_BASE || 'http://127.0.0.1:8787';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  const text = await response.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!response.ok) throw new Error(data?.error || data?.detail || data?.test?.error || `HTTP ${response.status}`);
  return data as T;
}

export const v34Api = {
  getState: () => request<any>('/api/state'),
  patchSettings: (patch: Record<string, unknown>) => request('/api/settings', {
    method: 'PATCH',
    body: JSON.stringify(patch),
  }),
  startEngine: () => request('/api/engine/start', { method: 'POST' }),
  pauseEngine: () => request('/api/engine/pause', { method: 'POST' }),
  emergencyStop: () => request('/api/emergency-stop', { method: 'POST' }),
  reconcile: () => request('/api/reconcile', { method: 'POST' }),
  runForexScanner: () => request<any>('/api/scanners/forex/run', { method: 'POST' }),
  runCryptoScanner: () => request<any>('/api/scanners/crypto/run', { method: 'POST' }),
  closePaperTrade: (tradeId: string) => request<any>(`/api/paper/trades/${encodeURIComponent(tradeId)}/close`, { method: 'POST' }),

  getIntegrations: () => request<any>('/api/integrations'),
  saveBinanceIntegration: (apiKey: string, apiSecret: string) => request<any>('/api/integrations/binance', {
    method: 'PUT',
    body: JSON.stringify({ apiKey, apiSecret }),
  }),
  saveTelegramIntegration: (botToken: string, chatId: string) => request<any>('/api/integrations/telegram', {
    method: 'PUT',
    body: JSON.stringify({ botToken, chatId }),
  }),
  saveForexDataIntegration: (apiKey: string) => request<any>('/api/integrations/twelve-data', {
    method: 'PUT',
    body: JSON.stringify({ apiKey }),
  }),
  saveMt5Integration: (bridgeUrl: string, bridgeToken: string) => request<any>('/api/integrations/mt5', {
    method: 'PUT',
    body: JSON.stringify({ bridgeUrl, bridgeToken }),
  }),
  testIntegration: (provider: 'binance' | 'telegram' | 'twelve-data' | 'mt5') => request<any>(`/api/integrations/${provider}/test`, {
    method: 'POST',
  }),
  removeIntegration: (provider: 'binance' | 'telegram' | 'twelve-data' | 'mt5') => request<any>(`/api/integrations/${provider}`, {
    method: 'DELETE',
  }),

  createBacktest: (payload: Record<string, unknown>) => request<any>('/api/backtests', {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  listBacktests: (limit = 20) => request<any>(`/api/backtests?limit=${limit}`),
  getBacktest: (id: string) => request<any>(`/api/backtests/${encodeURIComponent(id)}`),
};
