import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDockerApplication } from './helpers/application.mjs';
import { amapEnvironment, injectAmap } from './helpers/amap.mjs';
import { jsonRequest } from '../helpers/application.mjs';
import {
  dailyTransportFixture,
  waitDailyTransportTask,
} from '../helpers/daily-transport-fixture.mjs';

test(
  'the Docker standalone application computes and persists a real Worker transport plan',
  { timeout: 1200000 },
  async (context) => {
    const app = await createDockerApplication({ environment: amapEnvironment });
    try {
      await injectAmap(app);
      const request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
      const { path, scenario } = await dailyTransportFixture(request);
      const started = await request(`${path}/daily-transport`, 'POST', {
        expectedRevision: scenario.revision,
      });
      assert.equal(started.status, 202, JSON.stringify(started));
      const task = await waitDailyTransportTask(request, path, started.body.task.taskId);
      assert.equal(task.result.totalCompletedTonnes, 25);
      assert.equal(task.result.totalMissingTonnes, 0);
      assert.equal(task.result.trips.length, 3);
      // The controlled road service returns 1,234 m per leg. Three cycles have 7,404 m and
      // 6 × 1.234 km / 30 km/h × 60 + 3 × (5 + 5) = 44.808 working minutes.
      assert.equal(task.result.totalDistanceMeters, 7404);
      assert.ok(Math.abs(task.result.vehicles[0].workingMinutes - 44.808) < 1e-7);
      assert.equal(task.result.validation.valid, true);
      assert.equal(task.result.energyStatus, 'not-checked');
      assert.equal(task.result.physicalFeasibility, 'not-established');
      await app.restart();
      assert.deepEqual((await request(`${path}/daily-transport/${task.taskId}`)).body, task);
      context.diagnostic(
        `${app.platform} Docker standalone: real Worker completed 25 t and persisted across restart`,
      );
    } finally {
      await app.cleanup();
    }
  },
);
