import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { startApplication, jsonRequest } from './helpers/application.mjs';

const noMap = { AMAP_JS_KEY: '', AMAP_JS_SECURITY_CODE: '', AMAP_WEB_SERVICE_KEY: '' };
const point = (name = '园区电源', changes = {}) => ({
  name,
  longitude: 121.47,
  latitude: 31.23,
  coordinateSystem: 'GCJ-02',
  source: 'manual',
  availableCapacityKw: 800,
  capacitySource: '供电方书面容量资料',
  connectionNotes: '接入方案待站址逐项确认',
  ...changes,
});
const inputOf = (saved) =>
  saved.points.map((entry) => ({
    id: entry.id,
    name: entry.name,
    longitude: entry.originalLongitude,
    latitude: entry.originalLatitude,
    coordinateSystem: entry.coordinateSystem,
    source: entry.source,
    availableCapacityKw: entry.availableCapacityKw,
    capacitySource: entry.capacitySource,
    connectionNotes: entry.connectionNotes,
  }));
async function fixture(request, name = '电源资源项目') {
  const project = (await request('/api/projects', 'POST', { name })).body;
  const path = `/api/projects/${project.id}/power-connection-points`;
  const initial = await request(path);
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.body, { projectId: project.id, revision: 1, points: [] });
  return { project, path, initial: initial.body };
}
async function save(request, path, current, points) {
  const response = await request(path, 'PUT', { expectedRevision: current.revision, points });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body;
}

test('twenty project power points retain explicit capacity, source and stable identities through SQLite restart', async () => {
  let application = await startApplication(noMap);
  const directory = application.directory;
  const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);
  try {
    const { project, path, initial } = await fixture(request);
    const scenario = (
      await request(`/api/projects/${project.id}/scenarios`, 'POST', { name: '独立方案草案' })
    ).body;
    const scenarioPath = `/api/projects/${project.id}/scenarios/${scenario.id}`;
    let saved = await save(
      request,
      path,
      initial,
      Array.from({ length: 20 }, (_, index) =>
        point(index < 2 ? '同名电源' : `电源 ${index + 1}`, {
          longitude: 121 + index / 100,
          availableCapacityKw: index === 0 ? null : index === 1 ? 0 : 800 + index,
          capacitySource: index === 0 ? '' : '供电台账',
        }),
      ),
    );
    assert.equal(saved.projectId, project.id);
    assert.equal(saved.points.length, 20);
    assert.equal(new Set(saved.points.map((entry) => entry.id)).size, 20);
    assert.equal(saved.points[0].availableCapacityKw, null, 'missing capacity stays missing');
    assert.equal(saved.points[1].availableCapacityKw, 0, 'zero capacity is an explicit input');
    assert.equal(saved.points[0].capacitySource, '');
    for (const entry of saved.points) {
      assert.equal(entry.projectId, project.id);
      assert.equal(entry.originalLongitude, entry.longitude);
      assert.equal(entry.originalLatitude, entry.latitude);
      assert.equal(entry.coordinateSystem, 'GCJ-02');
    }
    assert.deepEqual((await request(scenarioPath)).body, scenario);
    const originalIds = saved.points.map((entry) => entry.id);
    const updates = inputOf(saved);
    updates[0] = {
      ...updates[0],
      name: '已补容量',
      availableCapacityKw: 950,
      capacitySource: '核实资料',
    };
    updates.splice(5, 1);
    saved = await save(request, path, saved, updates.reverse());
    assert.deepEqual(
      saved.points.map((entry) => entry.id),
      originalIds.filter((_, i) => i !== 5).reverse(),
    );
    assert.equal(saved.points.at(-1).availableCapacityKw, 950);
    assert.deepEqual(
      (await request(scenarioPath)).body,
      scenario,
      'shared resource edits do not rewrite scenario inputs',
    );
    await application.stop();
    const database = new Database(join(directory, 'test.sqlite'), { readonly: true });
    try {
      assert.equal(database.pragma('user_version', { simple: true }), 5);
      const row = database
        .prepare('SELECT payload FROM project_power_connection_points WHERE project_id = ?')
        .get(project.id);
      assert.deepEqual(JSON.parse(row.payload), saved);
    } finally {
      database.close();
    }
    application = await startApplication(noMap, directory);
    assert.deepEqual((await request(path)).body, saved);
    assert.deepEqual((await request(scenarioPath)).body, scenario);
    assert.equal((await request(`/api/projects/${project.id}`, 'DELETE')).status, 204);
    assert.equal((await request(path)).status, 404);
  } finally {
    await application.stop();
    await application.cleanup();
  }
});

test('power collection rejects invalid batches and foreign identities atomically with revision protection', async () => {
  const application = await startApplication(noMap);
  const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);
  try {
    const { path, initial } = await fixture(request);
    const foreign = await fixture(request, '其他电源项目');
    const saved = await save(request, path, initial, [point()]);
    const foreignSaved = await save(request, foreign.path, foreign.initial, [
      point('其他项目电源'),
    ]);
    const valid = inputOf(saved)[0];
    for (const invalid of [
      ...[-1, '800'].map((availableCapacityKw) => ({ ...valid, availableCapacityKw })),
      { ...valid, name: '' },
      { ...valid, longitude: 181 },
      { ...valid, latitude: -91 },
      { ...valid, coordinateSystem: 'BD-09' },
      { ...valid, capacitySource: 123 },
      { ...valid, connectionNotes: false },
      { ...valid, source: 'guessed' },
      null,
    ]) {
      const response = await request(path, 'PUT', {
        expectedRevision: saved.revision,
        points: [point('有效新条目'), invalid],
      });
      assert.equal(response.status, 400, JSON.stringify(invalid));
      assert.deepEqual(
        (await request(path)).body,
        saved,
        'no valid prefix from an invalid batch is committed',
      );
    }
    for (const id of ['unknown-power-id', foreignSaved.points[0].id]) {
      assert.equal(
        (
          await request(path, 'PUT', {
            expectedRevision: saved.revision,
            points: [{ ...valid, id }],
          })
        ).status,
        404,
      );
      assert.deepEqual((await request(path)).body, saved);
    }
    for (const body of [
      { expectedRevision: saved.revision, points: [valid, valid] },
      { expectedRevision: saved.revision, points: {} },
      { expectedRevision: String(saved.revision), points: [valid] },
      { points: [valid] },
      { expectedRevision: saved.revision, points: [valid], projectId: foreign.project.id },
    ]) {
      assert.equal((await request(path, 'PUT', body)).status, 400, JSON.stringify(body));
      assert.deepEqual((await request(path)).body, saved);
    }
    const nonFinite = await fetch(`${application.baseUrl}${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: saved.revision, points: [valid] }).replace(
        '"availableCapacityKw":800',
        '"availableCapacityKw":1e400',
      ),
    });
    assert.equal(nonFinite.status, 400);
    assert.deepEqual((await request(path)).body, saved);
    assert.equal(
      (await request('/api/projects/missing-project/power-connection-points')).status,
      404,
    );
    assert.equal((await request(path, 'PUT', { expectedRevision: 1, points: [] })).status, 409);
    const race = await Promise.all(
      [810, 820].map((availableCapacityKw) =>
        request(path, 'PUT', {
          expectedRevision: saved.revision,
          points: [{ ...valid, availableCapacityKw }],
        }),
      ),
    );
    assert.deepEqual(race.map((entry) => entry.status).sort(), [200, 409]);
    assert.deepEqual((await request(path)).body, race.find((entry) => entry.status === 200).body);
  } finally {
    await application.stop();
    await application.cleanup();
  }
});

test('WGS84 power conversion preserves declarations, avoids reconversion and never commits failed batches', async () => {
  const conversions = [];
  let fail = false;
  const upstream = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    conversions.push(url);
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify(
        fail
          ? { status: '0', info: 'test conversion unavailable' }
          : {
              status: '1',
              locations: url.searchParams
                .get('locations')
                .split('|')
                .map(() => '121.476,31.236')
                .join(';'),
            },
      ),
    );
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const environment = {
    ...noMap,
    HAULPATH_TEST_MODE: '1',
    AMAP_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
    AMAP_WEB_SERVICE_KEY: 'power-test-key',
  };
  let application = await startApplication(environment);
  const directory = application.directory;
  const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);
  try {
    const { path, initial } = await fixture(request);
    let saved = await save(request, path, initial, [
      point('GPS电源', { coordinateSystem: 'WGS84' }),
      point('高德电源'),
    ]);
    assert.equal(conversions.length, 1);
    assert.equal(conversions[0].pathname, '/v3/assistant/coordinate/convert');
    assert.equal(conversions[0].searchParams.get('coordsys'), 'gps');
    assert.equal(saved.points[0].longitude, 121.476);
    assert.equal(saved.points[0].latitude, 31.236);
    assert.equal(saved.points[0].originalLongitude, 121.47);
    assert.equal(saved.points[0].originalLatitude, 31.23);
    assert.equal(saved.points[0].coordinateSystem, 'WGS84');
    assert.equal(saved.points[1].longitude, 121.47);
    fail = true;
    const rejected = await request(path, 'PUT', {
      expectedRevision: saved.revision,
      points: [
        ...inputOf(saved),
        point('有效高德新条目'),
        point('转换失败GPS', { coordinateSystem: 'WGS84' }),
      ],
    });
    assert.equal(rejected.status, 502);
    assert.deepEqual((await request(path)).body, saved);
    const conversionCount = conversions.length;
    await application.stop();
    application = await startApplication(noMap, directory);
    const update = inputOf(saved);
    update[0].availableCapacityKw = 1200;
    update[0].capacitySource = '供电方更新资料';
    saved = await save(request, path, saved, update);
    assert.equal(
      saved.points[0].longitude,
      121.476,
      'capacity edits preserve normalized coordinates without credentials',
    );
    assert.equal(conversions.length, conversionCount);
    update[0].longitude = 121.48;
    const unavailable = await request(path, 'PUT', {
      expectedRevision: saved.revision,
      points: update,
    });
    assert.equal(unavailable.status, 503);
    assert.match(unavailable.body.error, /AMAP_WEB_SERVICE_KEY/);
    assert.deepEqual((await request(path)).body, saved);
  } finally {
    await application.stop();
    await application.cleanup();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test('schema 3 project, route, point library and scenario inputs survive the power-resource migration', async () => {
  let application = await startApplication(noMap);
  const directory = application.directory;
  const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);
  try {
    const { project, path } = await fixture(request, 'schema3保留项目');
    const normalized = (await request('/api/coordinates', 'POST', { points: [point('旧点位')] }))
      .body;
    const library = (
      await request(`/api/projects/${project.id}/points`, 'POST', { points: normalized })
    ).body;
    const route = (
      await request(`/api/projects/${project.id}/routes`, 'POST', {
        name: '旧线路',
        points: normalized,
        strategy: 34,
      })
    ).body;
    const scenario = (
      await request(`/api/projects/${project.id}/scenarios`, 'POST', { name: '旧草案' })
    ).body;
    await application.stop();
    const database = new Database(join(directory, 'test.sqlite'));
    try {
      database.exec(
        'DROP TABLE road_preparation_tasks; DROP TABLE directed_roads; DROP TABLE project_power_connection_points; PRAGMA user_version = 3;',
      );
    } finally {
      database.close();
    }
    application = await startApplication(noMap, directory);
    assert.deepEqual((await request('/api/projects')).body, [project]);
    assert.deepEqual((await request(`/api/projects/${project.id}/points`)).body, library);
    assert.deepEqual(
      (await request(`/api/routes/${route.id}?projectId=${project.id}`)).body,
      route,
    );
    assert.deepEqual(
      (await request(`/api/projects/${project.id}/scenarios/${scenario.id}`)).body,
      scenario,
    );
    assert.deepEqual((await request(path)).body, {
      projectId: project.id,
      revision: 1,
      points: [],
    });
    const saved = await save(request, path, { revision: 1 }, [point()]);
    assert.equal(saved.points.length, 1);
  } finally {
    await application.stop();
    await application.cleanup();
  }
});

test('a delayed coordinate conversion cannot overwrite a newer power-resource revision', async () => {
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  let releaseConversion;
  const gate = new Promise((resolve) => {
    releaseConversion = resolve;
  });
  const upstream = createServer(async (_request, response) => {
    markStarted();
    await gate;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ status: '1', locations: '121.476,31.236' }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const application = await startApplication({
    ...noMap,
    HAULPATH_TEST_MODE: '1',
    AMAP_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
    AMAP_WEB_SERVICE_KEY: 'power-race-test-key',
  });
  const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);
  try {
    const { path, initial } = await fixture(request, '迟到转换验收');
    const pending = request(path, 'PUT', {
      expectedRevision: initial.revision,
      points: [point('迟到GPS电源', { coordinateSystem: 'WGS84' })],
    });
    await Promise.race([
      started,
      pending.then((result) => {
        throw new Error(
          `conversion finished before controlled boundary: ${JSON.stringify(result)}`,
        );
      }),
    ]);
    const saved = await save(request, path, initial, [
      point('另一窗口已确认资料', { availableCapacityKw: 1300 }),
    ]);
    releaseConversion();
    assert.equal((await pending).status, 409);
    assert.deepEqual((await request(path)).body, saved);
    assert.equal(saved.points[0].availableCapacityKw, 1300);
  } finally {
    releaseConversion();
    await application.stop();
    await application.cleanup();
    await new Promise((resolve) => upstream.close(resolve));
  }
});
