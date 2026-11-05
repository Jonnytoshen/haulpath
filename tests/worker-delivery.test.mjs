import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { workerDeliveryData } from './helpers/worker-delivery-fixture.mjs';

const root = resolve(import.meta.dirname, '..');

test(
  'application Worker bundle computes a hand-worked plan without TypeScript sources or dependencies',
  { timeout: 30000 },
  async () => {
    const built = spawnSync(process.execPath, ['scripts/build-workers.mjs'], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(built.status, 0, `${built.stdout}${built.stderr}`);
    const directory = await mkdtemp(join(tmpdir(), 'haulpath-worker-delivery-'));
    try {
      const entry = join(directory, 'daily-transport.cjs');
      await cp(join(root, 'apps/web/.haulpath-workers/daily-transport.cjs'), entry);
      const identity = {
        taskId: 'delivery',
        projectId: 'project',
        scenarioId: 'scenario',
        inputVersion: 1,
      };
      const message = await new Promise((resolve, reject) => {
        let received = false;
        const worker = new Worker(entry, {
          workerData: workerDeliveryData(),
        });
        worker.on('error', reject);
        worker.on('message', (message) => {
          if (message.type === 'progress') return;
          received = true;
          resolve(message);
        });
        worker.on('exit', (code) => {
          if (!received) reject(new Error(`Worker exited without a result (${code})`));
        });
      });
      assert.equal(message.type, 'result', JSON.stringify(message));
      assert.equal(message.result.totalCompletedTonnes, 25);
      assert.equal(message.result.totalMissingTonnes, 0);
      assert.equal(message.result.trips.length, 3);
      assert.equal(message.result.vehicles[0].workingMinutes, 150);
      assert.equal(message.result.validation.valid, true);
      for (const [key, value] of Object.entries(identity)) assert.equal(message[key], value);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
