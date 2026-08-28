import { parentPort } from 'node:worker_threads';
import { calibrateR11 } from './highWinrateR11.js';
import type { Candle } from './analysis.js';

if (!parentPort) throw new Error('R11_WORKER_PARENT_PORT_MISSING');

parentPort.on('message', (payload: { m5: Candle[]; m15: Candle[] }) => {
  try {
    const model = calibrateR11(payload.m5, payload.m15);
    parentPort!.postMessage({ ok: true, model });
  } catch (error) {
    parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
