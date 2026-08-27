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
  if (!response.ok) throw new Error(data?.error || data?.test?.error || `HTTP ${response.status}`);
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

  getIntegrations: () => request<any>('/api/integrations'),
  saveBinanceIntegration: (apiKey: string, apiSecret: string) => request<any>('/api/integrations/binance', {
    method: 'PUT',
    body: JSON.stringify({ apiKey, apiSecret }),
  }),
  saveTelegramIntegration: (botToken: string, chatId: string) => request<any>('/api/integrations/telegram', {
    method: 'PUT',
    body: JSON.stringify({ botToken, chatId }),
  }),
  testIntegration: (provider: 'binance' | 'telegram') => request<any>(`/api/integrations/${provider}/test`, {
    method: 'POST',
  }),
  removeIntegration: (provider: 'binance' | 'telegram') => request<any>(`/api/integrations/${provider}`, {
    method: 'DELETE',
  }),
};
