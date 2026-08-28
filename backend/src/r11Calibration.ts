import { Worker } from 'node:worker_threads';
import type { Candle } from './analysis.js';
import type { R11Model } from './highWinrateR11.js';

export function calibrateR11Async(m5: Candle[], m15: Candle[]): Promise<R11Model> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./r11CalibrationWorker.ts', import.meta.url), {
      execArgv: ['--import', 'tsx'],
    });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
      void worker.terminate();
    };
    worker.once('message', (message: any) => {
      if (message?.ok === true && message.model) finish(() => resolve(message.model as R11Model));
      else finish(() => reject(new Error(String(message?.error || 'R11_WORKER_UNKNOWN_ERROR'))));
    });
    worker.once('error', (error) => finish(() => reject(error)));
    worker.once('exit', (code) => {
      if (!settled && code !== 0) finish(() => reject(new Error(`R11_WORKER_EXIT_${code}`)));
    });
    worker.postMessage({ m5, m15 });
  });
}
