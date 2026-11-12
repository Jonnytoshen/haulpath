import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { startApplication, jsonRequest } from './helpers/application.mjs';
import {
  roadFixture,
  roadPoint,
  roadResponse,
  waitRoadTask,
} from './helpers/directed-road-fixture.mjs';

test(
  'road preparation returns a durable task before the directed upstream finishes and reuses exact roads',
  { timeout: 120000 },
  async () => {
    let release = () => {};
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const calls = [];
    const upstream = createServer(async (request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      calls.push(url);
      await held;
      roadResponse(
        url,
        response,
        url.searchParams.get('origin') === '121.470000,31.230000' ? '1001' : '2002',
      );
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    let app;
    try {
      app = await startApplication({
        HAULPATH_TEST_MODE: '1',
        AMAP_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
        AMAP_WEB_SERVICE_KEY: 'roads-test-key',
      });
      const request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
      const fixture = await roadFixture(request);
      const launched = await Promise.race([
        request(`${fixture.path}/roads`, 'POST', { expectedRevision: fixture.scenario.revision }),
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error('启动接口等待了道路服务')), 5000);
          timer.unref();
        }),
      ]);
      assert.equal(launched.status, 202, JSON.stringify(launched.body));
      assert.ok(launched.body.task.taskId);
      assert.equal(launched.body.currentReady, false);
      const taskId = launched.body.task.taskId;
      const pending = await request(`${fixture.path}/roads/${taskId}`);
      assert.equal(pending.status, 200);
      assert.equal((pending.body.task ?? pending.body).inputVersion, fixture.scenario.inputVersion);
      release();
      await waitRoadTask(request, fixture.path, taskId, 'completed');
      const prepared = (await request(`${fixture.path}/roads`)).body;
      assert.equal(prepared.currentReady, true);
      assert.equal(prepared.completed, 2);
      assert.equal(prepared.total, 2);
      assert.deepEqual(
        prepared.roads.map(({ distanceMeters }) => distanceMeters).sort((a, b) => a - b),
        [1001, 2002],
      );
      assert.equal(calls.length, 2, 'reverse direction must be requested separately');
      assert.ok(calls.every((url) => url.searchParams.get('strategy') === '34'));
      const second = await request(`${fixture.path}/roads`, 'POST', {
        expectedRevision: fixture.scenario.revision,
      });
      assert.equal(second.status, 202);
      await waitRoadTask(request, fixture.path, second.body.task.taskId, 'completed');
      assert.equal(calls.length, 2, 'matching road data should be reused');
      assert.deepEqual(
        (await request(fixture.path)).body,
        fixture.scenario,
        'road results cannot silently change scenario inputs',
      );
    } finally {
      release();
      await app?.stop();
      await app?.cleanup();
      upstream.closeAllConnections();
      await new Promise((resolve) => upstream.close(resolve));
    }
  },
);

async function withRoadApplication(handle, operation, environment = {}) {
  const upstream = createServer((request, response) =>
    handle(new URL(request.url, 'http://127.0.0.1'), response),
  );
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  let app;
  try {
    app = await startApplication({
      HAULPATH_TEST_MODE: '1',
      AMAP_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
      AMAP_WEB_SERVICE_KEY: 'roads-test-key',
      ...environment,
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
  'rate limits preserve successful roads and retries request only the missing direction',
  { timeout: 120000 },
  async () => {
    const calls = [];
    let failReturn = true;
    await withRoadApplication(
      (url, response) => {
        calls.push(url);
        if (failReturn && url.searchParams.get('origin') === '121.600000,31.230000') {
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ status: '0', infocode: '10003' }));
        } else roadResponse(url, response, '1001');
      },
      async (request) => {
        const { scenario, path } = await roadFixture(request);
        const first = await request(`${path}/roads`, 'POST', {
          expectedRevision: scenario.revision,
        });
        assert.equal(first.status, 202);
        const failed = await waitRoadTask(request, path, first.body.task.taskId, 'failed');
        assert.match(failed.error, /额度|频率/);
        assert.equal(failed.completed, 1);
        assert.equal(failed.roads[0].distanceMeters, 1001);
        const partial = (await request(`${path}/roads`)).body;
        assert.equal(partial.currentReady, false);
        assert.equal(partial.completed, 1);
        assert.equal(partial.total, 2);
        failReturn = false;
        const retry = await request(`${path}/roads`, 'POST', {
          expectedRevision: scenario.revision,
        });
        const completed = await waitRoadTask(request, path, retry.body.task.taskId, 'completed');
        assert.equal(completed.reused, 1);
        assert.equal(calls.length, 3);
        assert.equal(calls.at(-1).searchParams.get('origin'), '121.600000,31.230000');
        assert.deepEqual((await request(`${path}/roads/${failed.taskId}`)).body, failed);
        assert.equal((await request(`${path}/roads`)).body.currentReady, true);
      },
    );
  },
);

test(
  'candidate entry and exit follow each cycle preference while continuation is versioned and project memory stays independent',
  { timeout: 120000 },
  async () => {
    const calls = [];
    await withRoadApplication(
      (url, response) => {
        calls.push(url);
        roadResponse(url, response);
      },
      async (request) => {
        let { scenario, path, project } = await roadFixture(request);
        const secondRoute = (
          await request(`/api/projects/${project.id}/routes`, 'POST', {
            name: '矿区往返',
            strategy: 35,
            points: [
              roadPoint('c', '矿区', 121.8),
              roadPoint('d', '卸料场', 121.9),
              roadPoint('c-return', '矿区返回', 121.8),
            ],
          })
        ).body;
        scenario = (
          await request(`${path}/cycles`, 'POST', {
            sourceRouteId: secondRoute.id,
            expectedRevision: scenario.revision,
          })
        ).body;
        const network = {
          stationTypes: [],
          powerSources: [],
          fixedLayout: [],
          sites: [
            {
              name: '中途候选',
              longitude: 121.5500001,
              latitude: 31.23,
              coordinateSystem: 'GCJ-02',
              source: 'manual',
              siteNotes: '道路准备候选',
              siteConfirmed: false,
              connection: null,
            },
          ],
        };
        const saved = await request(`${path}/station-network`, 'PUT', {
          expectedRevision: scenario.revision,
          network,
        });
        assert.equal(saved.status, 200, JSON.stringify(saved.body));
        scenario = saved.body;
        const launch = async () => {
          const response = await request(`${path}/roads`, 'POST', {
            expectedRevision: scenario.revision,
          });
          assert.equal(response.status, 202, JSON.stringify(response.body));
          return waitRoadTask(request, path, response.body.task.taskId, 'completed');
        };
        const first = await launch();
        assert.equal(first.total, 14, 'four business, eight station roads and two continuations');
        assert.equal(calls.filter((url) => url.searchParams.get('strategy') === '34').length, 6);
        assert.equal(calls.filter((url) => url.searchParams.get('strategy') === '35').length, 6);
        assert.equal(calls.filter((url) => url.searchParams.get('strategy') === '32').length, 2);
        assert.ok(
          first.snapshot.requirements.some(({ uses }) =>
            uses.some(({ kind }) => kind === 'station-entry'),
          ),
        );
        assert.ok(
          first.snapshot.requirements.some(({ uses }) =>
            uses.some(({ kind }) => kind === 'station-exit'),
          ),
        );
        const settings = await request(`${path}/road-settings`, 'PUT', {
          expectedRevision: scenario.revision,
          continuationStrategy: 36,
        });
        assert.equal(settings.status, 200, JSON.stringify(settings.body));
        assert.equal(settings.body.inputVersion, scenario.inputVersion + 1);
        scenario = settings.body;
        assert.equal((await request(`${path}/roads`)).body.currentReady, false);
        const second = await launch();
        assert.equal(second.reused, 12);
        assert.equal(calls.length, 16);
        assert.ok(calls.slice(-2).every((url) => url.searchParams.get('strategy') === '36'));
        assert.deepEqual(
          (
            await request(`${path}/road-settings`, 'PUT', {
              expectedRevision: scenario.revision,
              continuationStrategy: 36,
            })
          ).body,
          scenario,
          'same-value preference does not manufacture a version',
        );
        const inherited = await request(`/api/projects/${project.id}/routes`, 'POST', {
          name: '核对项目记忆',
        });
        assert.equal(inherited.body.strategy, 35);
        const compared = await request(
          `/api/projects/${project.id}/scenarios/${scenario.id}/copy`,
          'POST',
          { expectedRevision: scenario.revision, name: '独立道路草案' },
        );
        assert.equal(compared.status, 201);
        assert.deepEqual(compared.body.context.roadSettings, { continuationStrategy: 36 });
        const copyView = (
          await request(`/api/projects/${project.id}/scenarios/${compared.body.id}/roads`)
        ).body;
        assert.equal(copyView.task, null);
        assert.equal(copyView.completed, 14);
        assert.equal(copyView.currentReady, false);
        const moved = {
          ...network,
          sites: [
            {
              ...network.sites[0],
              id: scenario.context.stationNetwork.sites[0].id,
              longitude: 121.5500002,
            },
          ],
        };
        scenario = (
          await request(`${path}/station-network`, 'PUT', {
            expectedRevision: scenario.revision,
            network: moved,
          })
        ).body;
        const third = await launch();
        assert.equal(third.reused, 6);
        assert.equal(
          calls.length,
          24,
          'sub-microdegree change invalidates eight roads even if request text rounds alike',
        );
        assert.deepEqual((await request(`${path}/roads/${first.taskId}`)).body, first);
        const foreign = await roadFixture(request, '隔离道路项目');
        assert.equal((await request(`${foreign.path}/roads/${first.taskId}`)).status, 404);
        const foreignLaunch = await request(`${foreign.path}/roads`, 'POST', {
          expectedRevision: foreign.scenario.revision,
        });
        const foreignTask = await waitRoadTask(
          request,
          foreign.path,
          foreignLaunch.body.task.taskId,
          'completed',
        );
        assert.equal(
          foreignTask.reused,
          0,
          'another project cannot silently reuse this project cache',
        );
        assert.equal(calls.length, 26);
      },
    );
  },
);

async function until(check, message) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await check()) return;
    await delay(50);
  }
  assert.fail(message);
}

test(
  'queued and running tasks stop durably and a late response cannot replace a retry',
  { timeout: 120000 },
  async () => {
    let hold = true;
    const pending = [];
    const calls = [];
    await withRoadApplication(
      (url, response) => {
        calls.push(url);
        if (hold) pending.push([url, response]);
        else roadResponse(url, response, '1001');
      },
      async (request) => {
        const first = await roadFixture(request);
        const launched = await request(`${first.path}/roads`, 'POST', {
          expectedRevision: first.scenario.revision,
        });
        assert.equal(launched.status, 202);
        await until(() => calls.length === 1, '首个道路请求未到达');
        const duplicate = await request(`${first.path}/roads`, 'POST', {
          expectedRevision: first.scenario.revision,
        });
        assert.equal(
          duplicate.body.task.taskId,
          launched.body.task.taskId,
          'duplicate start cannot run two copies of the same input',
        );
        const second = await roadFixture(request, '排队停止项目');
        const queued = await request(`${second.path}/roads`, 'POST', {
          expectedRevision: second.scenario.revision,
        });
        assert.equal(queued.status, 202);
        assert.equal(
          (await request(`${second.path}/roads/${queued.body.task.taskId}`)).body.status,
          'queued',
        );
        const queuedStop = await request(
          `${second.path}/roads/${queued.body.task.taskId}/stop`,
          'POST',
        );
        assert.equal(queuedStop.status, 200);
        assert.equal(queuedStop.body.task.status, 'stopped');
        const stopped = await request(
          `${first.path}/roads/${launched.body.task.taskId}/stop`,
          'POST',
        );
        assert.equal(stopped.status, 200);
        assert.equal(stopped.body.task.status, 'stopped');
        hold = false;
        const retry = await request(`${first.path}/roads`, 'POST', {
          expectedRevision: first.scenario.revision,
        });
        const completed = await waitRoadTask(
          request,
          first.path,
          retry.body.task.taskId,
          'completed',
        );
        assert.equal(completed.reused, 0);
        for (const [url, response] of pending) roadResponse(url, response, '7777');
        assert.equal(calls.length, 3, 'stopped queued tasks must never issue upstream requests');
        assert.deepEqual(
          (await request(`${first.path}/roads/${launched.body.task.taskId}`)).body.status,
          'stopped',
        );
        assert.equal(
          (await request(`${second.path}/roads/${queued.body.task.taskId}`)).body.status,
          'stopped',
        );
        assert.deepEqual(
          (await request(`${first.path}/roads`)).body.roads.map(
            ({ distanceMeters }) => distanceMeters,
          ),
          [1001, 1001],
        );
        assert.equal(
          (await request(`${first.path}/roads/${queued.body.task.taskId}/stop`, 'POST')).status,
          404,
        );
      },
    );
  },
);

test(
  'input updates and freezing supersede active tasks without publishing late roads into either version',
  { timeout: 120000 },
  async () => {
    let hold = true;
    const pending = [];
    await withRoadApplication(
      (url, response) => {
        if (hold) pending.push([url, response]);
        else roadResponse(url, response, '1001');
      },
      async (request) => {
        let { scenario, path, project } = await roadFixture(request);
        const first = await request(`${path}/roads`, 'POST', {
          expectedRevision: scenario.revision,
        });
        await until(() => pending.length === 1, '旧版本请求未开始');
        const cycle = scenario.context.transportCycles[0];
        const edited = await request(`${path}/cycles/${cycle.id}`, 'PATCH', {
          expectedRevision: scenario.revision,
          strategy: 36,
        });
        assert.equal(edited.status, 200);
        scenario = edited.body;
        const superseded = await waitRoadTask(request, path, first.body.task.taskId, 'superseded');
        assert.equal(superseded.snapshot.context.transportCycles[0].strategy, 34);
        for (const [url, response] of pending) roadResponse(url, response, '7777');
        hold = false;
        const retry = await request(`${path}/roads`, 'POST', {
          expectedRevision: scenario.revision,
        });
        const ready = await waitRoadTask(request, path, retry.body.task.taskId, 'completed');
        assert.equal(ready.reused, 0);
        assert.ok(
          ready.roads.every(
            ({ strategy, distanceMeters }) => strategy === 36 && distanceMeters === 1001,
          ),
        );
        assert.deepEqual(
          (await request(`${path}/roads/${first.body.task.taskId}`)).body,
          superseded,
        );
        hold = true;
        scenario = (
          await request(`${path}/cycles/${cycle.id}`, 'PATCH', {
            expectedRevision: scenario.revision,
            strategy: 35,
          })
        ).body;
        const beforeFreeze = await request(`${path}/roads`, 'POST', {
          expectedRevision: scenario.revision,
        });
        await until(() => pending.length === 2, '冻结前请求未开始');
        const frozen = (
          await request(`${path}/freeze`, 'POST', { expectedRevision: scenario.revision })
        ).body;
        const copied = await request(`${path}/copy`, 'POST', {
          expectedRevision: frozen.revision,
          name: '冻结后独立草案',
        });
        assert.equal(copied.status, 201);
        assert.equal(
          (await request(`${path}/roads`, 'POST', { expectedRevision: frozen.revision })).status,
          409,
        );
        assert.equal(
          (
            await request(`${path}/road-settings`, 'PUT', {
              expectedRevision: frozen.revision,
              continuationStrategy: 33,
            })
          ).status,
          409,
        );
        const frozenTask = await waitRoadTask(
          request,
          path,
          beforeFreeze.body.task.taskId,
          'superseded',
        );
        for (const [url, response] of pending)
          if (!response.writableEnded) roadResponse(url, response, '7777');
        hold = false;
        const copyPath = `/api/projects/${project.id}/scenarios/${copied.body.id}`;
        const copyView = (await request(`${copyPath}/roads`)).body;
        assert.equal(copyView.task, null);
        assert.equal(copyView.completed, 0);
        assert.deepEqual((await request(path)).body, frozen);
        assert.equal(frozenTask.roads.length, 0);
        assert.deepEqual(
          (await request(`${path}/roads/${beforeFreeze.body.task.taskId}`)).body,
          frozenTask,
        );
        const bypass = await request(`${copyPath}`, 'PATCH', {
          expectedRevision: copied.body.revision,
          context: { ...copied.body.context, roadSettings: { continuationStrategy: 45 } },
        });
        assert.equal(
          bypass.status,
          400,
          'generic context cannot bypass dedicated preference validation',
        );
        assert.deepEqual((await request(copyPath)).body, copied.body);
      },
    );
  },
);

test(
  'a road request timeout is terminal and keeps the successful direction available for retry',
  { timeout: 120000 },
  async () => {
    let hold = true;
    await withRoadApplication(
      (url, response) => {
        if (hold && url.searchParams.get('origin') === '121.600000,31.230000') return;
        roadResponse(url, response, '1001');
      },
      async (request) => {
        const { scenario, path } = await roadFixture(request);
        const launched = await request(`${path}/roads`, 'POST', {
          expectedRevision: scenario.revision,
        });
        const failed = await waitRoadTask(request, path, launched.body.task.taskId, 'timed-out');
        assert.match(failed.error, /超时/);
        assert.equal(failed.completed, 1);
        assert.equal((await request(`${path}/roads`)).body.currentReady, false);
        hold = false;
        const retried = await request(`${path}/roads`, 'POST', {
          expectedRevision: scenario.revision,
        });
        const ready = await waitRoadTask(request, path, retried.body.task.taskId, 'completed');
        assert.equal(ready.reused, 1);
      },
    );
  },
);

test(
  'missing configuration, invalid tasks and an empty scenario never manufacture a ready road matrix',
  { timeout: 120000 },
  async () => {
    await withRoadApplication(
      () => assert.fail('missing configuration must not call upstream'),
      async (request) => {
        const { scenario, path, project } = await roadFixture(request);
        const launched = await request(`${path}/roads`, 'POST', {
          expectedRevision: scenario.revision,
        });
        assert.equal(launched.status, 202);
        const failed = await waitRoadTask(request, path, launched.body.task.taskId, 'failed');
        assert.match(failed.error, /缺少高德 Web 服务 Key/);
        assert.equal(failed.completed, 0);
        assert.equal((await request(`${path}/roads`)).body.currentReady, false);
        assert.equal(
          (await request(`${path}/roads`, 'POST', { expectedRevision: 999 })).status,
          409,
        );
        assert.equal(
          (
            await request(`${path}/roads`, 'POST', {
              expectedRevision: scenario.revision,
              roads: [],
            })
          ).status,
          400,
        );
        assert.equal((await request(`${path}/roads/missing`)).status, 404);
        const empty = (
          await request(`/api/projects/${project.id}/scenarios`, 'POST', { name: '空草案' })
        ).body;
        const emptyPath = `/api/projects/${project.id}/scenarios/${empty.id}`;
        assert.equal((await request(`${emptyPath}/roads`)).body.currentReady, false);
        assert.equal(
          (await request(`${emptyPath}/roads`, 'POST', { expectedRevision: empty.revision }))
            .status,
          400,
        );
        for (const continuationStrategy of [3, '32', null])
          assert.equal(
            (
              await request(`${path}/road-settings`, 'PUT', {
                expectedRevision: scenario.revision,
                continuationStrategy,
              })
            ).status,
            400,
          );
        assert.deepEqual((await request(path)).body, scenario);
      },
      { AMAP_WEB_SERVICE_KEY: '' },
    );
  },
);

test(
  'valid cycle snapshots and a colocated candidate supply roads without inventing polylines or new upstream requests',
  { timeout: 120000 },
  async () => {
    const calls = [];
    await withRoadApplication(
      (url, response) => {
        calls.push(url);
        roadResponse(url, response, '1234');
      },
      async (request) => {
        const { project, route } = await roadFixture(request);
        const planned = await request(
          `/api/routes/${route.id}/plan?projectId=${project.id}`,
          'POST',
        );
        assert.equal(planned.status, 200);
        assert.equal(calls.length, 2);
        let scenario = (
          await request(`/api/projects/${project.id}/scenarios`, 'POST', { name: '复用来源道路' })
        ).body;
        const path = `/api/projects/${project.id}/scenarios/${scenario.id}`;
        scenario = (
          await request(`${path}/cycles`, 'POST', {
            expectedRevision: scenario.revision,
            sourceRouteId: route.id,
          })
        ).body;
        scenario = (
          await request(`${path}/station-network`, 'PUT', {
            expectedRevision: scenario.revision,
            network: {
              stationTypes: [],
              powerSources: [],
              fixedLayout: [],
              sites: [
                {
                  name: '港区同址站',
                  longitude: 121.47,
                  latitude: 31.23,
                  coordinateSystem: 'GCJ-02',
                  source: 'manual',
                  siteNotes: '',
                  siteConfirmed: false,
                  connection: null,
                },
              ],
            },
          })
        ).body;
        const available = (await request(`${path}/roads`)).body;
        assert.equal(available.total, 3);
        assert.equal(available.completed, 3);
        assert.equal(
          available.currentReady,
          false,
          'available cache still requires an explicit preparation for this version',
        );
        const launched = await request(`${path}/roads`, 'POST', {
          expectedRevision: scenario.revision,
        });
        const task = await waitRoadTask(request, path, launched.body.task.taskId, 'completed');
        assert.equal(task.reused, 3);
        assert.equal(calls.length, 2);
        assert.equal(task.roads.filter(({ source }) => source === 'cycle-snapshot').length, 2);
        const colocated = task.roads.find(({ source }) => source === 'same-location');
        assert.equal(colocated.distanceMeters, 0);
        assert.deepEqual(colocated.polyline, []);
        assert.ok(task.snapshot.requirements.some(({ uses }) => uses.length > 1));
        assert.deepEqual((await request(path)).body, scenario);
        assert.deepEqual(
          (await request(`/api/routes/${route.id}?projectId=${project.id}`)).body,
          planned.body,
        );
      },
    );
  },
);

test(
  'a queued copy rechecks shared cache after its predecessor completes and owns a separate immutable task',
  { timeout: 120000 },
  async () => {
    let release = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const calls = [];
    await withRoadApplication(
      async (url, response) => {
        calls.push(url);
        await gate;
        roadResponse(url, response, '1001');
      },
      async (request) => {
        const { project, scenario, path } = await roadFixture(request);
        const first = await request(`${path}/roads`, 'POST', {
          expectedRevision: scenario.revision,
        });
        await until(() => calls.length === 1, '首个道路任务没有开始');
        const copy = (
          await request(`${path}/copy`, 'POST', {
            expectedRevision: scenario.revision,
            name: '排队复用副本',
          })
        ).body;
        const copyPath = `/api/projects/${project.id}/scenarios/${copy.id}`;
        const second = await request(`${copyPath}/roads`, 'POST', {
          expectedRevision: copy.revision,
        });
        assert.equal(second.status, 202);
        assert.equal(second.body.task.status, 'queued');
        assert.equal(second.body.task.reused, 0);
        assert.notEqual(first.body.task.taskId, second.body.task.taskId);
        release();
        await waitRoadTask(request, path, first.body.task.taskId, 'completed');
        const reused = await waitRoadTask(request, copyPath, second.body.task.taskId, 'completed');
        assert.equal(reused.reused, 2);
        assert.equal(calls.length, 2);
        assert.equal(reused.scenarioId, copy.id);
        assert.equal(reused.inputVersion, 1);
        assert.deepEqual(reused.snapshot.context, copy.context);
        assert.equal((await request(`${path}/roads/${reused.taskId}`)).status, 404);
      },
    );
  },
);

test(
  'explicitly adopted newer source roads beat old cache while completed frozen roads remain fixed',
  { timeout: 120000 },
  async () => {
    let distance = '1001';
    await withRoadApplication(
      (url, response) => roadResponse(url, response, distance),
      async (request) => {
        const original = await roadFixture(request);
        const first = await request(`${original.path}/roads`, 'POST', {
          expectedRevision: original.scenario.revision,
        });
        const originalTask = await waitRoadTask(
          request,
          original.path,
          first.body.task.taskId,
          'completed',
        );
        const frozen = (
          await request(`${original.path}/freeze`, 'POST', {
            expectedRevision: original.scenario.revision,
          })
        ).body;
        assert.ok(
          (await request(`${original.path}/roads`)).body.roads.every(
            ({ distanceMeters }) => distanceMeters === 1001,
          ),
        );
        distance = '1500';
        const plan = `/api/routes/${original.route.id}/plan?projectId=${original.project.id}`;
        assert.equal((await request(plan, 'POST')).status, 200);
        let adopted = (
          await request(`/api/projects/${original.project.id}/scenarios`, 'POST', {
            name: '采用较新来源',
          })
        ).body;
        const path = `/api/projects/${original.project.id}/scenarios/${adopted.id}`;
        adopted = (
          await request(`${path}/cycles`, 'POST', {
            expectedRevision: adopted.revision,
            sourceRouteId: original.route.id,
          })
        ).body;
        assert.ok(
          (await request(`${path}/roads`)).body.roads.every(
            ({ distanceMeters }) => distanceMeters === 1500,
          ),
          'explicitly adopted source snapshot must not be shadowed by older shared cache',
        );
        const second = await request(`${path}/roads`, 'POST', {
          expectedRevision: adopted.revision,
        });
        const adoptedTask = await waitRoadTask(request, path, second.body.task.taskId, 'completed');
        assert.ok(adoptedTask.roads.every(({ distanceMeters }) => distanceMeters === 1500));
        const frozenView = (await request(`${original.path}/roads`)).body;
        assert.equal(frozenView.currentReady, true);
        assert.ok(
          frozenView.roads.every(({ distanceMeters }) => distanceMeters === 1001),
          'completed frozen version must keep its own prepared road basis after shared cache changes',
        );
        assert.deepEqual(
          (await request(`${original.path}/roads/${originalTask.taskId}`)).body,
          originalTask,
        );
        distance = '1700';
        await request(plan, 'POST');
        const refreshed = await request(
          `${path}/cycles/${adopted.context.transportCycles[0].id}/source`,
          'POST',
          { expectedRevision: adopted.revision },
        );
        assert.equal(refreshed.status, 200);
        adopted = refreshed.body;
        const next = await request(`${path}/roads`, 'POST', { expectedRevision: adopted.revision });
        const nextTask = await waitRoadTask(request, path, next.body.task.taskId, 'completed');
        assert.ok(nextTask.roads.every(({ distanceMeters }) => distanceMeters === 1700));
        assert.deepEqual((await request(`${path}/roads/${adoptedTask.taskId}`)).body, adoptedTask);
        assert.deepEqual((await request(original.path)).body, frozen);
      },
    );
  },
);

test(
  'unprepared and partially prepared frozen versions cannot adopt roads from another draft implicitly',
  { timeout: 120000 },
  async () => {
    let holdReturn = false;
    const pending = [];
    await withRoadApplication(
      (url, response) => {
        if (holdReturn && url.searchParams.get('origin') === '121.600000,31.230000')
          pending.push([url, response]);
        else roadResponse(url, response, '1001');
      },
      async (request) => {
        for (const partial of [false, true]) {
          const { scenario, path, project } = await roadFixture(
            request,
            partial ? '冻结部分资料' : '冻结未准备资料',
          );
          let taskId;
          if (partial) {
            holdReturn = true;
            const launched = await request(`${path}/roads`, 'POST', {
              expectedRevision: scenario.revision,
            });
            taskId = launched.body.task.taskId;
            await until(
              async () => (await request(`${path}/roads/${taskId}`)).body.completed === 1,
              '首条道路没有持久保存',
            );
          }
          const frozenResponse = await request(`${path}/freeze`, 'POST', {
            expectedRevision: scenario.revision,
          });
          assert.equal(frozenResponse.status, 200);
          const frozen = frozenResponse.body;
          const before = (await request(`${path}/roads`)).body;
          assert.equal(before.completed, partial ? 1 : 0);
          assert.equal(before.currentReady, false);
          const copy = (
            await request(`${path}/copy`, 'POST', {
              expectedRevision: frozen.revision,
              name: '独立补齐道路',
            })
          ).body;
          const copyPath = `/api/projects/${project.id}/scenarios/${copy.id}`;
          const launchedCopy = await request(`${copyPath}/roads`, 'POST', {
            expectedRevision: copy.revision,
          });
          holdReturn = false;
          for (const [url, response] of pending)
            if (!response.writableEnded) roadResponse(url, response, '7777');
          await waitRoadTask(request, copyPath, launchedCopy.body.task.taskId, 'completed');
          const after = (await request(`${path}/roads`)).body;
          assert.equal(
            after.completed,
            before.completed,
            'shared cache growth must not change the frozen road basis',
          );
          assert.deepEqual(after.roads, before.roads);
          assert.equal(after.currentReady, false);
          assert.deepEqual((await request(path)).body, frozen);
          if (taskId) {
            const task = (await request(`${path}/roads/${taskId}`)).body;
            assert.equal(task.status, 'superseded');
            assert.equal(task.roads.length, 1);
          }
        }
      },
    );
  },
);

test(
  'forbidden candidate sites leave road scope while draft candidates may prepare roads before confirmation',
  { timeout: 120000 },
  async () => {
    const calls = [];
    await withRoadApplication(
      (url, response) => {
        calls.push(url);
        roadResponse(url, response);
      },
      async (request) => {
        const fixture = await roadFixture(request);
        const { path } = fixture;
        let scenario = (
          await request(`${path}/station-network`, 'PUT', {
            expectedRevision: fixture.scenario.revision,
            network: {
              stationTypes: [],
              powerSources: [],
              fixedLayout: [],
              sites: [
                {
                  name: '尚未确认的建议位置',
                  longitude: 121.55,
                  latitude: 31.23,
                  coordinateSystem: 'GCJ-02',
                  siteNotes: '',
                  siteConfirmed: false,
                  connection: null,
                },
              ],
            },
          })
        ).body;
        assert.equal(
          (await request(`${path}/roads`)).body.total,
          6,
          'business directions and candidate entry/exit',
        );
        const network = scenario.context.stationNetwork;
        const site = network.sites[0];
        const { originalLongitude, originalLatitude, ...input } = site;
        scenario = (
          await request(`${path}/station-network`, 'PUT', {
            expectedRevision: scenario.revision,
            network: {
              ...network,
              sites: [{ ...input, longitude: originalLongitude, latitude: originalLatitude }],
              constraints: {
                maxInvestment: null,
                maxStations: null,
                requiredSiteIds: [],
                excludedSiteIds: [site.id],
              },
            },
          })
        ).body;
        const launch = await request(`${path}/roads`, 'POST', {
          expectedRevision: scenario.revision,
        });
        assert.equal(launch.status, 202, JSON.stringify(launch.body));
        const done = await waitRoadTask(request, path, launch.body.task.taskId, 'completed');
        assert.equal(done.total, 2);
        assert.ok(
          done.snapshot.requirements.every((row) =>
            row.uses.every((use) => use.kind === 'business'),
          ),
        );
        assert.equal(calls.length, 2);
        assert.equal((await request(`${path}/roads`)).body.currentReady, true);
        const unblocked = {
          ...scenario.context.stationNetwork,
          sites: [{ ...input, longitude: originalLongitude, latitude: originalLatitude }],
          constraints: {
            maxInvestment: null,
            maxStations: null,
            requiredSiteIds: [],
            excludedSiteIds: [],
          },
        };
        scenario = (
          await request(`${path}/station-network`, 'PUT', {
            expectedRevision: scenario.revision,
            network: unblocked,
          })
        ).body;
        const current = (await request(`${path}/roads`)).body;
        assert.equal(current.total, 6);
        assert.equal(
          current.currentReady,
          false,
          'restoring a candidate requires new-version road adoption',
        );
        assert.equal(
          (await request(`${path}/roads/${done.taskId}`)).body.total,
          2,
          'old snapshot retains its own scope',
        );
      },
    );
  },
);
