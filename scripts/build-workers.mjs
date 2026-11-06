import { buildSync } from 'esbuild';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(import.meta.dirname, '..');
export const workerBundle = resolve(
  workspaceRoot,
  'apps/web/.haulpath-workers/daily-transport.cjs',
);

/** Compile the application Worker and its domain source imports into one portable Node bundle. */
export function buildWorkers() {
  mkdirSync(dirname(workerBundle), { recursive: true });
  const temporary = `${workerBundle}.${randomUUID()}.tmp`;
  try {
    buildSync({
      absWorkingDir: workspaceRoot,
      entryPoints: ['apps/web/src/workers/daily-transport.ts'],
      outfile: temporary,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22.12',
      sourcemap: false,
      logLevel: 'warning',
    });
    // A running task keeps its loaded code. New tasks see a complete new bundle, never a partial file.
    renameSync(temporary, workerBundle);
  } finally {
    rmSync(temporary, { force: true });
  }
  return workerBundle;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) buildWorkers();
