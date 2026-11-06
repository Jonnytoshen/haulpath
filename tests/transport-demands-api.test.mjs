import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { startApplication, jsonRequest } from './helpers/application.mjs';

const point = (id, longitude, latitude) => ({
  id,
  name: '同名业务点',
  longitude,
  latitude,
  originalLongitude: longitude,
  originalLatitude: latitude,
  coordinateSystem: 'GCJ-02',
  source: 'manual',
});

async function setup(request, projectName = '装卸需求项目') {
  const project = (await request('/api/projects', 'POST', { name: projectName })).body;
  const route = (
    await request(`/api/projects/${project.id}/routes`, 'POST', {
      name: '多点往返',
      points: [
        point('a', 121.47, 31.23),
        point('b', 121.6, 31.3),
        point('c', 121.7, 31.4),
        point('a-return', 121.47, 31.23),
      ],
    })
  ).body;
  const scenario = (
    await request(`/api/projects/${project.id}/scenarios`, 'POST', { name: '多点需求草案' })
  ).body;
  const path = `/api/projects/${project.id}/scenarios/${scenario.id}`;
  let saved = (
    await request(`${path}/cycles`, 'POST', { sourceRouteId: route.id, expectedRevision: 1 })
  ).body;
  const cycle = saved.context.transportCycles[0];
  saved = (
    await request(`${path}/cycles/${cycle.id}`, 'PATCH', {
      expectedRevision: saved.revision,
      confirmed: true,
    })
  ).body;
  return { project, route, path, saved, cycle: saved.context.transportCycles[0] };
}

const demand = (cycle, from, to, dailyTonnes) => ({
  cycleId: cycle.id,
  loadingPositionId: cycle.positions[from].id,
  unloadingPositionId: cycle.positions[to].id,
  dailyTonnes,
});

test('transport demands preserve repeated position identities, input order and tonnes through SQLite restart', async () => {
  let application = await startApplication();
  const directory = application.directory;
  const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);
  try {
    const { path, saved: initial, cycle, route, project } = await setup(request);
    const inputs = [demand(cycle, 0, 2, 12.5), demand(cycle, 1, 3, 7.25)];
    const result = await request(`${path}/demands`, 'PUT', {
      expectedRevision: initial.revision,
      demands: inputs,
    });
    assert.equal(result.status, 200);
    let saved = result.body;
    assert.equal(saved.inputVersion, initial.inputVersion + 1);
    assert.equal(saved.revision, initial.revision + 1);
    const demands = saved.context.transportDemands;
    assert.equal(new Set(demands.map((item) => item.id)).size, 2);
    assert.deepEqual(
      demands.map(({ id, ...item }) => {
        assert.ok(id);
        return item;
      }),
      inputs,
    );
    assert.notEqual(demands[0].loadingPositionId, demands[1].unloadingPositionId);
    assert.deepEqual(saved.context.transportCycles, initial.context.transportCycles);
    assert.deepEqual(
      (await request(`/api/routes/${route.id}?projectId=${project.id}`)).body,
      route,
    );
    const unchanged = await request(`${path}/demands`, 'PUT', {
      expectedRevision: saved.revision,
      demands,
    });
    assert.equal(unchanged.status, 200);
    assert.deepEqual(unchanged.body, saved);
    const reordered = await request(`${path}/demands`, 'PUT', {
      expectedRevision: saved.revision,
      demands: [demands[1], { ...demands[0], dailyTonnes: 12.625 }],
    });
    assert.equal(reordered.status, 200);
    saved = reordered.body;
    assert.deepEqual(
      saved.context.transportDemands.map((item) => item.id),
      [demands[1].id, demands[0].id],
    );
    await application.stop();
    const database = new Database(join(directory, 'test.sqlite'), { readonly: true });
    try {
      assert.equal(database.pragma('user_version', { simple: true }), 6);
      const persisted = database
        .prepare('SELECT payload FROM planning_scenarios WHERE id = ?')
        .get(saved.id);
      assert.deepEqual(JSON.parse(persisted.payload), saved);
    } finally {
      database.close();
    }
    application = await startApplication({}, directory);
    assert.deepEqual((await request(path)).body, saved);
  } finally {
    await application.stop();
    await application.cleanup();
  }
});

test('demand batches reject invalid rows, foreign identities, stale revisions and context bypass atomically', async () => {
  const application = await startApplication();
  const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);
  try {
    const { path, saved: initial, cycle } = await setup(request);
    const foreign = await setup(request, '另一项目');
    const valid = demand(cycle, 0, 2, 12.5);
    let response = await request(`${path}/demands`, 'PUT', {
      expectedRevision: initial.revision,
      demands: [valid],
    });
    assert.equal(response.status, 200);
    const saved = response.body;
    const existing = saved.context.transportDemands[0];
    const foreignSaved = (
      await request(`${foreign.path}/demands`, 'PUT', {
        expectedRevision: foreign.saved.revision,
        demands: [demand(foreign.cycle, 0, 1, 5)],
      })
    ).body;
    const otherCycle = (
      await request(`${path}/cycles`, 'POST', {
        sourceRouteId: cycle.source.routeId,
        expectedRevision: saved.revision,
      })
    ).body;
    const current = otherCycle;
    const sibling = current.context.transportCycles[1];
    for (const invalid of [
      { ...valid, loadingPositionId: 'unknown-position' },
      { ...valid, unloadingPositionId: sibling.positions[2].id },
      { ...valid, cycleId: foreign.cycle.id },
      { ...valid, loadingPositionId: cycle.positions[2].id },
      { ...valid, loadingPositionId: cycle.positions[3].id },
      ...[0, -1, null, '12.5'].map((dailyTonnes) => ({ ...valid, dailyTonnes })),
      { ...valid, id: 'unknown-demand' },
      { ...valid, id: foreignSaved.context.transportDemands[0].id },
      { ...valid, extra: '不支持的字段' },
      null,
    ]) {
      response = await request(`${path}/demands`, 'PUT', {
        expectedRevision: current.revision,
        demands: [existing, invalid],
      });
      assert.equal(response.status, 400, JSON.stringify(invalid));
      assert.match(response.body.error, /2/);
      assert.deepEqual((await request(path)).body, current);
    }
    for (const body of [
      { expectedRevision: current.revision, demands: [existing, existing] },
      {
        expectedRevision: current.revision,
        demands: [
          { ...valid, dailyTonnes: 1e308 },
          { ...valid, dailyTonnes: 1e308 },
        ],
      },
      { expectedRevision: current.revision, demands: {} },
      { demands: [existing] },
      { expectedRevision: String(current.revision), demands: [existing] },
      { expectedRevision: current.revision, demands: [existing], projectId: foreign.project.id },
    ]) {
      assert.equal((await request(`${path}/demands`, 'PUT', body)).status, 400);
      assert.deepEqual((await request(path)).body, current);
    }
    const infinity = await fetch(`${application.baseUrl}${path}/demands`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: current.revision,
        demands: [valid],
      }).replace('12.5', '1e400'),
    });
    assert.equal(infinity.status, 400);
    assert.deepEqual((await request(path)).body, current);
    assert.equal(
      (await request(`${path}/demands`, 'PUT', { expectedRevision: 1, demands: [] })).status,
      409,
    );
    const foreignPath = `/api/projects/${foreign.project.id}/scenarios/${current.id}/demands`;
    assert.equal(
      (await request(foreignPath, 'PUT', { expectedRevision: current.revision, demands: [] }))
        .status,
      404,
    );
    for (const demands of [[], [{ ...existing, dailyTonnes: 99 }], undefined]) {
      const context = { ...current.context, transportDemands: demands };
      assert.equal(
        (await request(path, 'PATCH', { expectedRevision: current.revision, context })).status,
        400,
      );
      assert.deepEqual((await request(path)).body, current);
    }
    const enriched = await request(path, 'PATCH', {
      expectedRevision: current.revision,
      context: { ...current.context, resources: { note: '独立资料' } },
    });
    assert.equal(enriched.status, 200);
    assert.deepEqual(enriched.body.context.transportDemands, current.context.transportDemands);
    const race = await Promise.all([
      request(`${path}/demands`, 'PUT', {
        expectedRevision: enriched.body.revision,
        demands: [{ ...existing, dailyTonnes: 30 }],
      }),
      request(`${path}/demands`, 'PUT', {
        expectedRevision: enriched.body.revision,
        demands: [{ ...existing, dailyTonnes: 40 }],
      }),
    ]);
    assert.deepEqual(race.map((result) => result.status).sort(), [200, 409]);
    assert.deepEqual((await request(path)).body, race.find((result) => result.status === 200).body);
  } finally {
    await application.stop();
    await application.cleanup();
  }
});

test('cycle edits retain demand references for repair and a hundred demands remain stable', async () => {
  const application = await startApplication();
  const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);
  try {
    const { path, saved: initial, cycle } = await setup(request);
    let saved = (
      await request(`${path}/demands`, 'PUT', {
        expectedRevision: initial.revision,
        demands: Array.from({ length: 100 }, (_, index) =>
          demand(cycle, index % 2, index % 2 ? 3 : 2, index + 0.25),
        ),
      })
    ).body;
    assert.equal(saved.context.transportDemands.length, 100);
    assert.equal(new Set(saved.context.transportDemands.map((item) => item.id)).size, 100);
    const demands = saved.context.transportDemands;
    const positions = cycle.positions.map(({ id, point }) => ({ id, point }));
    for (const adjusted of [
      [positions[0], positions[2], positions[1], positions[3]],
      [positions[0], positions[1], positions[3]],
    ]) {
      const result = await request(`${path}/cycles/${cycle.id}`, 'PATCH', {
        expectedRevision: saved.revision,
        positions: adjusted,
      });
      assert.equal(result.status, 200);
      saved = result.body;
      assert.deepEqual(saved.context.transportDemands, demands);
    }
    const deleted = await request(
      `${path}/cycles/${cycle.id}?expectedRevision=${saved.revision}`,
      'DELETE',
    );
    assert.equal(deleted.status, 200);
    saved = deleted.body;
    assert.deepEqual(saved.context.transportDemands, demands);
    const cleared = await request(`${path}/demands`, 'PUT', {
      expectedRevision: saved.revision,
      demands: [],
    });
    assert.equal(cleared.status, 200);
    assert.deepEqual(cleared.body.context.transportDemands, []);
    assert.equal(cleared.body.inputVersion, saved.inputVersion + 1);
  } finally {
    await application.stop();
    await application.cleanup();
  }
});
