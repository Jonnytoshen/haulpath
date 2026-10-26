import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout } from 'node:timers/promises';
import { startApplication, jsonRequest } from './helpers/application.mjs';

let application;
let upstream;
let handleUpstream;
const upstreamRequests = [];

before(async () => {
  upstream = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    upstreamRequests.push(url);
    await handleUpstream(url, response);
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  application = await startApplication({
    HAULPATH_TEST_MODE: '1',
    AMAP_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
    AMAP_WEB_SERVICE_KEY: 'test-web-secret',
    AMAP_JS_KEY: 'test-browser-key',
    AMAP_JS_SECURITY_CODE: 'test-js-secret',
  });
});

after(async () => {
  await application?.stop();
  await application?.cleanup();
  if (upstream) await new Promise((resolve) => upstream.close(resolve));
});

const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);
const inputPoint = (name, longitude = 121.471234567, latitude = 31.231234567) => ({ name, longitude, latitude, source: 'manual' });

function drivingResponse(response, distance = '1001') {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ status: '1', route: { paths: [
    { distance, steps: [{ polyline: '121.47,31.23;120.1,31.8' }, { polyline: '120.1,31.8;118.79,32.06' }] },
    { distance: '9999999', steps: [{ polyline: '0,0;1,1' }] },
  ] } }));
}

async function createRoute(strategy = 32) {
  const project = (await request('/api/projects', 'POST', { name: '行前测算项目' })).body;
  const points = (await request('/api/coordinates', 'POST', { points: [
    inputPoint('上海仓'), inputPoint('南京客户', 118.79, 32.06), inputPoint('上海仓回程'),
  ] })).body;
  const result = await request(`/api/projects/${project.id}/routes`, 'POST', { name: '往返线路', points, strategy });
  assert.equal(result.status, 201);
  const route = result.body;
  return { route, path: `/api/routes/${route.id}?projectId=${project.id}`, plan: `/api/routes/${route.id}/plan?projectId=${project.id}` };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('ordered adjacent planning uses each preference and the first returned path with integer meter totals', async () => {
  for (const strategy of [0, 1, 2, ...Array.from({ length: 14 }, (_, index) => index + 32)]) {
    const route = await createRoute(strategy);
    const requests = [];
    handleUpstream = (url, response) => { requests.push(url); drivingResponse(response, requests.length === 1 ? '1001' : '2002'); };
    const result = await request(route.plan, 'POST');
    assert.equal(result.status, 200);
    assert.equal(result.body.strategy, strategy);
    assert.equal(result.body.snapshot.strategy, strategy);
    assert.equal(result.body.snapshot.totalDistanceMeters, 3003);
    assert.equal(result.body.planning, null);
    assert.deepEqual(result.body.snapshot.legs.map((leg) => [leg.index, leg.from.name, leg.to.name, leg.distanceMeters]), [
      [1, '上海仓', '南京客户', 1001], [2, '南京客户', '上海仓回程', 2002],
    ]);
    assert.deepEqual(result.body.snapshot.legs[0].polyline, [[121.47, 31.23], [120.1, 31.8], [120.1, 31.8], [118.79, 32.06]]);
    assert.equal(requests.length, 2);
    assert.ok(requests.every((url) => url.pathname === '/v5/direction/driving' && url.searchParams.get('strategy') === String(strategy) && url.searchParams.get('show_fields') === 'polyline'));
    assert.equal(requests[0].searchParams.get('origin'), '121.471235,31.231235');
    assert.equal(requests[0].searchParams.get('destination'), '118.790000,32.060000');
    assert.equal(requests[1].searchParams.get('origin'), '118.790000,32.060000');
    assert.equal(requests[1].searchParams.get('destination'), '121.471235,31.231235');
    const persisted = (await request(route.path)).body;
    assert.deepEqual(persisted.snapshot, result.body.snapshot);
    assert.equal((await request(route.path, 'PATCH', { name: '重命名后的线路' })).body.inputVersion, route.route.inputVersion);
    assert.equal(requests.length, 2);
  }
});

test('route preferences reject unsupported values and nonnumeric types without changing saved inputs', async () => {
  const route = await createRoute(32);
  const invalidStrategies = [-1, 3, 31, 46, 999, 32.5, '32', null, true, {}, []];
  for (const strategy of invalidStrategies) {
    const created = await request(`/api/projects/${route.route.projectId}/routes`, 'POST', { name: '无效偏好', strategy });
    assert.equal(created.status, 400, `create rejects ${JSON.stringify(strategy)}`);
    const updated = await request(route.path, 'PATCH', { strategy });
    assert.equal(updated.status, 400, `update rejects ${JSON.stringify(strategy)}`);
    assert.deepEqual((await request(route.path)).body, route.route);
  }
});

test('progress is observable while the previous complete result remains intact until all legs succeed', async () => {
  const route = await createRoute();
  handleUpstream = (_url, response) => drivingResponse(response);
  const previous = (await request(route.plan, 'POST')).body.snapshot;
  const secondStarted = deferred();
  const release = deferred();
  let count = 0;
  handleUpstream = async (_url, response) => {
    if (++count === 2) { secondStarted.resolve(); await release.promise; }
    drivingResponse(response, '7777');
  };
  const pending = request(route.plan, 'POST');
  try {
    await secondStarted.promise;
    const running = (await request(route.path)).body;
    assert.equal(running.planning.status, 'running');
    assert.equal(running.planning.completed, 1);
    assert.equal(running.planning.total, 2);
    assert.deepEqual(running.snapshot, previous);
    await request(route.path, 'PATCH', { name: '运行时改名' });
  } finally { release.resolve(); }
  const completed = await pending;
  assert.equal(completed.status, 200);
  assert.equal(completed.body.name, '运行时改名');
  assert.equal(completed.body.snapshot.totalDistanceMeters, 15554);
  assert.equal(completed.body.planning, null);
});

test('a failed leg reports its interval and preserves the entire previous result for fresh and stale inputs', async () => {
  for (const state of ['first', 'valid', 'stale']) {
    const route = await createRoute();
    handleUpstream = (_url, response) => drivingResponse(response);
    const previous = state === 'first' ? null : (await request(route.plan, 'POST')).body.snapshot;
    if (state === 'stale') await request(route.path, 'PATCH', { strategy: 34 });
    let count = 0;
    handleUpstream = (_url, response) => {
      if (++count === 1) return drivingResponse(response, '8888');
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ status: '0', infocode: '10003', info: 'test-web-secret' }));
    };
    const failed = await request(route.plan, 'POST');
    assert.equal(failed.status, 502);
    assert.match(failed.body.error, /第2.*南京客户.*上海仓回程.*额度/);
    assert.doesNotMatch(JSON.stringify(failed.body), /test-web-secret/);
    const current = (await request(route.path)).body;
    assert.deepEqual(current.snapshot, previous);
    assert.equal(current.planning.status, 'failed');
    assert.equal(current.planning.completed, 1);
    assert.equal(current.planning.error, failed.body.error);
    if (state !== 'first') assert.equal(current.inputVersion === current.snapshot.inputVersion, state === 'valid');
  }
});

test('late successes and failures cannot overwrite edited inputs or a newer task for the same input', async () => {
  for (const edit of [false, true]) {
    for (const oldFails of [false, true]) {
      const route = await createRoute();
      const oldStarted = deferred();
      const release = deferred();
      let count = 0;
      handleUpstream = async (_url, response) => {
        if (++count === 1) {
          oldStarted.resolve();
          await release.promise;
          if (oldFails) {
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({ status: '0', infocode: '10001' }));
            return;
          }
          return drivingResponse(response, '1111');
        }
        drivingResponse(response, '3333');
      };
      const oldPending = request(route.plan, 'POST');
      let newest;
      try {
        await oldStarted.promise;
        if (edit) await request(route.path, 'PATCH', { strategy: 36 });
        newest = await request(route.plan, 'POST');
        assert.equal(newest.status, 200);
        assert.equal(newest.body.snapshot.totalDistanceMeters, 6666);
      } finally { release.resolve(); }
      const late = await oldPending;
      assert.equal(late.status, 409);
      assert.match(late.body.error, /已更新|取代/);
      const current = (await request(route.path)).body;
      assert.deepEqual(current.snapshot, newest.body.snapshot);
      assert.equal(current.planning, null);
      assert.equal(count, 3);
    }
  }
});

test('simultaneous route calculations bound the number of active upstream driving requests', async () => {
  const routes = await Promise.all([createRoute(), createRoute(), createRoute()]);
  const twoStarted = deferred();
  const release = deferred();
  let active = 0;
  let maximum = 0;
  handleUpstream = async (_url, response) => {
    active++;
    maximum = Math.max(maximum, active);
    if (active >= 2) twoStarted.resolve();
    await release.promise;
    drivingResponse(response);
    active--;
  };
  const pending = routes.map((route) => request(route.plan, 'POST'));
  let results;
  try {
    await twoStarted.promise;
    await setTimeout(150);
    assert.equal(maximum, 2);
  } finally { release.resolve(); results = await Promise.all(pending); }
  assert.ok(results.every((result) => result.status === 200));
  assert.equal(maximum, 2);
});

test('invalid route drafts and wrong project ownership never issue driving requests', async () => {
  const route = await createRoute();
  const other = (await request('/api/projects', 'POST', { name: '其他项目' })).body;
  let calls = 0;
  handleUpstream = (_url, response) => { calls++; drivingResponse(response); };
  assert.equal((await request(`/api/routes/${route.route.id}/plan?projectId=${other.id}`, 'POST')).status, 404);
  await request(route.path, 'PATCH', { points: [route.route.points[0]] });
  assert.equal((await request(route.plan, 'POST')).status, 400);
  await request(route.path, 'PATCH', { points: [route.route.points[0], { ...route.route.points[0], id: 'duplicate' }] });
  assert.match((await request(route.plan, 'POST')).body.error, /坐标相同/);
  assert.equal(calls, 0);
});

test('malformed first paths and no-route responses fail without promoting partial or alternate results', async () => {
  const route = await createRoute();
  const results = [
    { status: '1', route: { paths: [] } },
    { status: '1', route: { paths: [{ distance: '1.5', steps: [{ polyline: '121,31;122,32' }] }] } },
    { status: '1', route: { paths: [{ distance: '1000', steps: [] }, { distance: '1', steps: [{ polyline: '121,31;122,32' }] }] } },
    { status: '1', route: { paths: [{ distance: '1000', steps: [{ polyline: 'invalid' }] }] } },
  ];
  for (const payload of results) {
    handleUpstream = (_url, response) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(payload)); };
    const result = await request(route.plan, 'POST');
    assert.equal(result.status, 502);
    assert.match(result.body.error, /第1个区间/);
    const current = (await request(route.path)).body;
    assert.equal(current.snapshot, null);
    assert.equal(current.planning.status, 'failed');
    assert.equal(current.planning.completed, 0);
  }
});

test('an upstream timeout gives a retryable interval error without publishing a partial result', { timeout: 25_000 }, async () => {
  const route = await createRoute();
  handleUpstream = () => {};
  const result = await request(route.plan, 'POST');
  assert.equal(result.status, 504);
  assert.match(result.body.error, /第1个区间.*超时/);
  const current = (await request(route.path)).body;
  assert.equal(current.snapshot, null);
  assert.equal(current.planning.status, 'failed');
});
