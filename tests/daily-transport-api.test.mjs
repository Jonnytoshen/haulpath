import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startApplication, jsonRequest } from './helpers/application.mjs';
import { roadResponse } from './helpers/directed-road-fixture.mjs';
import {
  dailyTransportFixture,
  waitDailyTransportTask,
} from './helpers/daily-transport-fixture.mjs';

async function withTransportApplication(operation) {
  const upstream = createServer((request, response) =>
    roadResponse(new URL(request.url, 'http://127.0.0.1'), response, '10000'),
  );
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  let app;
  try {
    app = await startApplication({
      HAULPATH_TEST_MODE: '1',
      AMAP_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
      AMAP_WEB_SERVICE_KEY: 'transport-test',
    });
    const request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
    await operation(request, app);
  } catch (error) {
    throw new Error(`${error.message}\n${app?.logs() ?? ''}`, { cause: error });
  } finally {
    await app?.stop();
    await app?.cleanup();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  }
}

test(
  'a real Worker completes exactly 25 tonnes in three full loops with a partial last load and persists its immutable result',
  { timeout: 120000 },
  async () => {
    await withTransportApplication(async (request) => {
      const { scenario, path } = await dailyTransportFixture(request);
      const launched = await request(`${path}/daily-transport`, 'POST', {
        expectedRevision: scenario.revision,
      });
      assert.equal(launched.status, 202, JSON.stringify(launched.body));
      const task = await waitDailyTransportTask(request, path, launched.body.task.taskId);
      assert.equal(task.inputVersion, scenario.inputVersion);
      assert.equal(task.result.totalCompletedTonnes, 25);
      assert.equal(task.result.totalMissingTonnes, 0);
      assert.equal(task.result.totalDistanceMeters, 60000);
      assert.equal(task.result.trips.length, 3);
      assert.equal(task.result.validation.valid, true);
      assert.equal(task.result.energyStatus, 'not-checked');
      assert.equal(task.result.physicalFeasibility, 'not-established');
      assert.deepEqual(task.snapshot.context, scenario.context);
      assert.ok(task.snapshot.roads.every((road) => road.distanceMeters === 10000));
      assert.deepEqual((await request(path)).body, scenario);
      const view = (await request(`${path}/daily-transport`)).body;
      assert.deepEqual(view.resultTask, task);
      const { body: summary } = await request(`${path}/daily-transport/${task.taskId}?summary=1`);
      assert.deepEqual(summary, view.task);
      assert.equal(summary.status, 'completed');
      assert.deepEqual(summary.progress, {
        completedTrips: 3,
        completedTonnes: 25,
        totalTonnes: 25,
      });
      assert.equal('snapshot' in summary || 'result' in summary, false);
    });
  },
);

test(
  'a short work window reports a demand gap, preserves old results across versions and copies no formal tasks',
  { timeout: 120000 },
  async () => {
    await withTransportApplication(async (request, app) => {
      const fixture = await dailyTransportFixture(request, { endMinute: 579 });
      let { scenario } = fixture;
      const { path, project } = fixture;
      const launch = await request(`${path}/daily-transport`, 'POST', {
        expectedRevision: scenario.revision,
      });
      const task = await waitDailyTransportTask(request, path, launch.body.task.taskId);
      assert.equal(task.result.totalCompletedTonnes, 10);
      assert.equal(task.result.totalMissingTonnes, 15);
      assert.equal(task.result.vehicles[0].workingMinutes, 50);
      assert.match(task.result.demands[0].reason, /未证明无解/);
      const foreign = await dailyTransportFixture(request, { name: '隔离运输项目' });
      assert.equal((await request(`${foreign.path}/daily-transport/${task.taskId}`)).status, 404);
      assert.equal(
        (await request(`${foreign.path}/daily-transport/${task.taskId}/stop`, 'POST')).status,
        404,
      );
      for (const config of [
        { seed: -1 },
        { maxRuntimeMs: 1000 },
        { maxRuntimeMs: 7200001 },
        { roads: [] },
      ])
        assert.equal(
          (
            await request(`${path}/daily-transport`, 'POST', {
              expectedRevision: scenario.revision,
              config,
            })
          ).status,
          400,
        );
      assert.equal(
        (await request(`${path}/daily-transport`, 'POST', { expectedRevision: 999 })).status,
        409,
      );
      const renamed = await request(path, 'PATCH', {
        expectedRevision: scenario.revision,
        name: '只改名保留结果',
      });
      scenario = renamed.body;
      assert.equal(scenario.inputVersion, task.inputVersion);
      assert.deepEqual((await request(`${path}/daily-transport`)).body.resultTask, task);
      const edited = await request(`${path}/demands`, 'PUT', {
        expectedRevision: scenario.revision,
        demands: scenario.context.transportDemands.map((demand) => ({
          ...demand,
          dailyTonnes: 30,
        })),
      });
      assert.equal(edited.status, 200, JSON.stringify(edited.body));
      scenario = edited.body;
      const view = (await request(`${path}/daily-transport`)).body;
      assert.equal(view.inputVersion, task.inputVersion + 1);
      assert.deepEqual(view.resultTask, task);
      assert.ok(view.gaps.some((gap) => /显式准备/.test(gap)));
      const copy = await request(`${path}/copy`, 'POST', {
        expectedRevision: scenario.revision,
        name: '运输副本',
      });
      const copyPath = `/api/projects/${project.id}/scenarios/${copy.body.id}`;
      assert.equal((await request(`${copyPath}/daily-transport`)).body.task, null);
      assert.equal((await request(`${copyPath}/daily-transport`)).body.resultTask, null);
      const frozen = await request(`${path}/freeze`, 'POST', {
        expectedRevision: scenario.revision,
      });
      assert.equal(
        (
          await request(`${path}/daily-transport`, 'POST', {
            expectedRevision: frozen.body.revision,
          })
        ).status,
        409,
      );
      assert.deepEqual((await request(`${path}/daily-transport/${task.taskId}`)).body, task);
      await app.stop();
    });
  },
);

test(
  'a running CPU Worker leaves HTTP responsive, tasks queue and stop, and input changes reject late publication',
  { timeout: 120000 },
  async () => {
    const { makeLongTransportWorkload } = await import('./helpers/daily-transport-fixture.mjs');
    await withTransportApplication(async (request) => {
      // Warm the public routes before measuring or cancelling work; no computation hooks are used.
      await request('/api/projects/missing/scenarios/missing/daily-transport/missing/stop', 'POST');
      const first = await makeLongTransportWorkload(
        request,
        await dailyTransportFixture(request, { tonnes: 1e9 }),
      );
      const second = await makeLongTransportWorkload(
        request,
        await dailyTransportFixture(request, { tonnes: 1e9, name: '运输排队' }),
      );
      const launch = (fixture) =>
        request(`${fixture.path}/daily-transport`, 'POST', {
          expectedRevision: fixture.scenario.revision,
        });
      const running = await launch(first);
      assert.equal(running.status, 202, JSON.stringify(running.body));
      const firstId = running.body.task.taskId;
      const duplicate = await launch(first);
      assert.equal(duplicate.body.task.taskId, firstId);
      const queued = await launch(second);
      const secondId = queued.body.task.taskId;
      assert.equal(
        (await request(`${second.path}/daily-transport/${secondId}`)).body.status,
        'queued',
      );
      const before = performance.now();
      const renamed = await request(`/api/projects/${first.project.id}`, 'PATCH', {
        name: '计算期间正常改项目名称',
      });
      assert.equal(renamed.status, 200);
      assert.ok(performance.now() - before < 3000, 'CPU Worker blocked an ordinary write');
      assert.equal(
        (await request(`${first.path}/daily-transport/${firstId}`)).body.status,
        'running',
      );
      const stopped = await request(`${second.path}/daily-transport/${secondId}/stop`, 'POST');
      assert.equal(stopped.body.task.status, 'stopped');
      const changed = await request(`${first.path}/demands`, 'PUT', {
        expectedRevision: first.scenario.revision,
        demands: first.scenario.context.transportDemands.map((demand) => ({
          ...demand,
          dailyTonnes: 100,
        })),
      });
      assert.equal(changed.status, 200, JSON.stringify(changed.body));
      const superseded = await waitDailyTransportTask(request, first.path, firstId, 'superseded');
      assert.equal(superseded.result, null);
      assert.equal((await request(`${first.path}/daily-transport`)).body.resultTask, null);
      const again = await launch(second);
      const againId = again.body.task.taskId;
      assert.notEqual(againId, secondId);
      const frozen = await request(`${second.path}/freeze`, 'POST', {
        expectedRevision: second.scenario.revision,
      });
      assert.equal(frozen.status, 200);
      await waitDailyTransportTask(request, second.path, againId, 'superseded');
      assert.equal(
        (await request(`${second.path}/daily-transport/${secondId}`)).body.status,
        'stopped',
      );
    });
  },
);
