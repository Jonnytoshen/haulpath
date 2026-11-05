import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';
import type { DailyTransportWorkerData } from '../workers/daily-transport-protocol';

const run = promisify(execFile);

/** Next changes cwd to the application; the standalone server has the same application layout. */
function applicationDirectory(): string {
  const cwd = process.cwd();
  return existsSync(resolve(cwd, 'apps/web/.haulpath-workers')) ? resolve(cwd, 'apps/web') : cwd;
}

export async function createDailyTransportWorker(data: DailyTransportWorkerData): Promise<Worker> {
  const application = applicationDirectory();
  if (process.env.NODE_ENV === 'development') {
    // Compile at task launch as well as dev startup so edits to imported domain source are effective
    // without restarting Next. The compiler runs in a separate process and never blocks HTTP reads.
    await run(process.execPath, [resolve(application, '../../scripts/build-workers.mjs')], {
      cwd: resolve(application, '../..'),
      timeout: 30000,
    });
  }
  const entry = resolve(application, '.haulpath-workers/daily-transport.cjs');
  if (!existsSync(entry)) throw new Error('运输 Worker 产物缺失，请重新构建应用');
  // Keep the Node constructor out of Next's web-worker URL rewriting. The file is an already
  // bundled Node artifact included explicitly in the deployment trace.
  return Reflect.construct(Worker, [
    entry,
    { workerData: data, resourceLimits: { maxOldGenerationSizeMb: 512 } },
  ]) as Worker;
}
