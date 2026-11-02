import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startApplication, jsonRequest } from './helpers/application.mjs';

const point = (id, name, longitude, latitude) => ({
  id,
  name,
  longitude,
  latitude,
  originalLongitude: longitude,
  originalLatitude: latitude,
  coordinateSystem: 'GCJ-02',
  source: 'manual',
});

test('transport cycles import route inputs into an independent persisted scenario snapshot', async () => {
  let application = await startApplication();
  const directory = application.directory;
  const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);
  try {
    const project = (await request('/api/projects', 'POST', { name: '运输循环项目' })).body;
    const route = (
      await request(`/api/projects/${project.id}/routes`, 'POST', {
        name: '港区往返',
        strategy: 34,
        points: [
          point('a', '港区', 121.47, 31.23),
          point('b', '堆场', 121.6, 31.3),
          point('a-return', '港区', 121.47, 31.23),
        ],
      })
    ).body;
    const scenario = (
      await request(`/api/projects/${project.id}/scenarios`, 'POST', { name: '北区规划' })
    ).body;
    const path = `/api/projects/${project.id}/scenarios/${scenario.id}`;
    const imported = await request(`${path}/cycles`, 'POST', {
      sourceRouteId: route.id,
      expectedRevision: 1,
    });
    assert.equal(imported.status, 201);
    assert.equal(imported.body.inputVersion, 2);
    assert.equal(imported.body.revision, 2);
    const cycle = imported.body.context.transportCycles[0];
    assert.equal(cycle.name, '港区往返');
    assert.equal(cycle.strategy, 34);
    assert.equal(cycle.confirmed, false);
    assert.deepEqual(
      cycle.positions.map((position) => position.point),
      route.points,
    );
    assert.equal(new Set(cycle.positions.map((position) => position.id)).size, 3);
    assert.deepEqual(
      cycle.positions.map((position) => position.sourcePointId),
      ['a', 'b', 'a-return'],
    );
    assert.equal(cycle.source.routeId, route.id);
    assert.equal(cycle.source.inputVersion, 1);
    assert.deepEqual(cycle.source.points, route.points);
    assert.deepEqual(cycle.roads, []);
    await request(`/api/routes/${route.id}?projectId=${project.id}`, 'PATCH', {
      name: '源线路已改名',
      points: [point('x', '新点', 120, 30)],
    });
    assert.deepEqual((await request(path)).body, imported.body);
    await application.stop();
    application = await startApplication({}, directory);
    assert.deepEqual((await request(path)).body, imported.body);
  } finally {
    await application.stop();
    await application.cleanup();
  }
});

test('return positions and explicit order confirmation remain separate from source routes and project preferences', async () => {
  const application = await startApplication();
  const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);
  try {
    const project = (await request('/api/projects', 'POST', { name: '回程确认' })).body;
    const other = (await request('/api/projects', 'POST', { name: '其他项目' })).body;
    const route = (
      await request(`/api/projects/${project.id}/routes`, 'POST', {
        name: '单程业务',
        strategy: 34,
        points: [point('a', '业务点', 121.47, 31.23), point('b', '业务点', 121.6, 31.3)],
      })
    ).body;
    const foreignRoute = (
      await request(`/api/projects/${other.id}/routes`, 'POST', { name: '外部线路' })
    ).body;
    const scenario = (
      await request(`/api/projects/${project.id}/scenarios`, 'POST', { name: '回程草案' })
    ).body;
    const path = `/api/projects/${project.id}/scenarios/${scenario.id}`;
    let saved = (
      await request(`${path}/cycles`, 'POST', { sourceRouteId: route.id, expectedRevision: 1 })
    ).body;
    const initial = saved.context.transportCycles[0];
    const cyclePath = `${path}/cycles/${initial.id}`;
    assert.equal(
      (await request(cyclePath, 'PATCH', { confirmed: true, expectedRevision: 2 })).status,
      400,
    );
    assert.deepEqual((await request(path)).body, saved);
    const result = await request(cyclePath, 'PATCH', {
      positions: [
        ...initial.positions.map(({ id, point }) => ({ id, point })),
        { point: initial.positions[0].point },
      ],
      confirmed: true,
      expectedRevision: 2,
    });
    assert.equal(result.status, 200);
    saved = result.body;
    let cycle = saved.context.transportCycles[0];
    assert.equal(cycle.confirmed, true);
    assert.ok(cycle.confirmedAt);
    assert.deepEqual(
      cycle.positions.slice(0, 2).map((position) => position.id),
      initial.positions.map((position) => position.id),
    );
    assert.notEqual(cycle.positions[2].id, cycle.positions[0].id);
    assert.equal(cycle.positions[2].sourcePointId, null);
    assert.deepEqual(
      cycle.positions.map((position) => position.point.name),
      ['业务点', '业务点', '业务点'],
    );
    assert.deepEqual(cycle.source, initial.source);
    saved = (
      await request(cyclePath, 'PATCH', { name: '已核对回程', expectedRevision: saved.revision })
    ).body;
    assert.equal(saved.context.transportCycles[0].confirmed, true);
    saved = (await request(cyclePath, 'PATCH', { strategy: 35, expectedRevision: saved.revision }))
      .body;
    assert.equal(saved.context.transportCycles[0].confirmed, false);
    assert.equal(saved.context.transportCycles[0].confirmedAt, null);
    assert.deepEqual(
      (await request(`/api/routes/${route.id}?projectId=${project.id}`)).body,
      route,
    );
    assert.equal(
      (await request(`/api/projects/${project.id}/routes`, 'POST', { name: '验证偏好未改变' })).body
        .strategy,
      34,
    );
    cycle = saved.context.transportCycles[0];
    for (const input of [
      { source: { ...cycle.source, routeId: foreignRoute.id } },
      {
        positions: [
          { id: cycle.positions[0].id, point: cycle.positions[0].point },
          { id: cycle.positions[0].id, point: cycle.positions[1].point },
        ],
      },
      { positions: [{ id: 'unknown-position', point: cycle.positions[0].point }] },
      { confirmed: 'true' },
    ]) {
      assert.equal(
        (await request(cyclePath, 'PATCH', { ...input, expectedRevision: saved.revision })).status,
        400,
      );
      assert.deepEqual((await request(path)).body, saved);
    }
    const tampered = structuredClone(saved.context);
    tampered.transportCycles[0].source.routeId = foreignRoute.id;
    assert.equal(
      (await request(path, 'PATCH', { context: tampered, expectedRevision: saved.revision }))
        .status,
      400,
    );
    assert.deepEqual((await request(path)).body, saved);
    const enriched = { ...saved.context, resources: { note: '其他资源仍可扩展' } };
    saved = (await request(path, 'PATCH', { context: enriched, expectedRevision: saved.revision }))
      .body;
    assert.deepEqual(saved.context.resources, { note: '其他资源仍可扩展' });
    assert.equal(
      (
        await request(`${path}/cycles`, 'POST', {
          sourceRouteId: foreignRoute.id,
          expectedRevision: saved.revision,
        })
      ).status,
      404,
    );
    assert.equal(
      (await request(cyclePath, 'PATCH', { name: '旧修订', expectedRevision: 2 })).status,
      409,
    );
    assert.equal(
      (
        await request(
          `/api/projects/${other.id}/scenarios/${scenario.id}/cycles/${cycle.id}`,
          'PATCH',
          { name: '跨项目', expectedRevision: saved.revision },
        )
      ).status,
      404,
    );
    assert.deepEqual((await request(path)).body, saved);
    const deleted = await request(`${cyclePath}?expectedRevision=${saved.revision}`, 'DELETE');
    assert.equal(deleted.status, 200);
    assert.deepEqual(deleted.body.context.transportCycles, []);
    assert.deepEqual(deleted.body.context.resources, { note: '其他资源仍可扩展' });
    assert.equal(
      (await request(`${cyclePath}?expectedRevision=${deleted.body.revision}`, 'DELETE')).status,
      404,
    );
  } finally {
    await application.stop();
    await application.cleanup();
  }
});

test('imports retain directed road snapshots and never invent reverse or stale road data', async () => {
  const upstream = createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        status: '1',
        route: { paths: [{ distance: '1234', steps: [{ polyline: '121.47,31.23;121.6,31.3' }] }] },
      }),
    );
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  let application;
  try {
    application = await startApplication({
      HAULPATH_TEST_MODE: '1',
      AMAP_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
      AMAP_WEB_SERVICE_KEY: 'test-key',
    });
    const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);
    const project = (await request('/api/projects', 'POST', { name: '道路快照' })).body;
    const route = (
      await request(`/api/projects/${project.id}/routes`, 'POST', {
        name: '有道路资料的单程线路',
        strategy: 34,
        points: [point('a', '港区', 121.47, 31.23), point('b', '堆场', 121.6, 31.3)],
      })
    ).body;
    const planned = (await request(`/api/routes/${route.id}/plan?projectId=${project.id}`, 'POST'))
      .body;
    assert.equal(planned.snapshot.totalDistanceMeters, 1234);
    const scenario = (
      await request(`/api/projects/${project.id}/scenarios`, 'POST', { name: '道路复用' })
    ).body;
    const path = `/api/projects/${project.id}/scenarios/${scenario.id}`;
    let saved = (
      await request(`${path}/cycles`, 'POST', { sourceRouteId: route.id, expectedRevision: 1 })
    ).body;
    const cycle = saved.context.transportCycles[0];
    assert.deepEqual(cycle.source.snapshot, planned.snapshot);
    assert.equal(cycle.roads.length, 1);
    assert.equal(cycle.roads[0].fromPositionId, cycle.positions[0].id);
    assert.equal(cycle.roads[0].toPositionId, cycle.positions[1].id);
    assert.equal(cycle.roads[0].strategy, 34);
    assert.deepEqual(cycle.roads[0].leg, planned.snapshot.legs[0]);
    saved = (
      await request(`${path}/cycles/${cycle.id}`, 'PATCH', {
        expectedRevision: saved.revision,
        positions: [
          ...cycle.positions.map(({ id, point }) => ({ id, point })),
          { point: cycle.positions[0].point },
        ],
        confirmed: true,
      })
    ).body;
    assert.equal(
      saved.context.transportCycles[0].roads.length,
      1,
      'return roads are not synthesized by reversing outbound data',
    );
    await request(`/api/routes/${route.id}?projectId=${project.id}`, 'PATCH', { strategy: 35 });
    saved = (
      await request(`${path}/cycles`, 'POST', {
        sourceRouteId: route.id,
        expectedRevision: saved.revision,
      })
    ).body;
    const stale = saved.context.transportCycles[1];
    assert.deepEqual(stale.source.snapshot, planned.snapshot);
    assert.deepEqual(
      stale.roads,
      [],
      'a stale source snapshot is provenance rather than current road data',
    );
    assert.deepEqual(saved.context.transportCycles[0].source.snapshot, planned.snapshot);
  } finally {
    await application?.stop();
    await application?.cleanup();
    await new Promise((resolve) => upstream.close(resolve));
  }
});
