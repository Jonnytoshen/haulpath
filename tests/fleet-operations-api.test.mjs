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

async function setup(request, projectName = '车队输入项目') {
  const project = (await request('/api/projects', 'POST', { name: projectName })).body;
  const route = (
    await request(`/api/projects/${project.id}/routes`, 'POST', {
      name: '固定往返循环',
      points: [
        point('a', 121.47, 31.23),
        point('b', 121.6, 31.3),
        point('c', 121.7, 31.4),
        point('a-return', 121.47, 31.23),
      ],
    })
  ).body;
  const scenario = (
    await request(`/api/projects/${project.id}/scenarios`, 'POST', { name: '多车型草案' })
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

const battery = () => ({
  capacityKwh: 300,
  chargePowerKw: 120,
  chargeEfficiency: 0.9,
  source: '验收手算资料，非工程默认值',
});
const group = (cycle, name = '重载车型', count = 2) => ({
  name,
  count,
  baseCycleId: cycle.id,
  baseStartPositionId: cycle.positions[0].id,
  payloadTonnes: 40,
  speedKph: 30,
  emptyKwhPerKm: 1,
  fullKwhPerKm: 2,
  safetySocPercent: 20,
  shifts: [{ startMinute: 480, endMinute: 1020 }],
  loadingMinutes: 10,
  unloadingMinutes: 8,
  source: '车队台账与作业观察',
});
const measured = (vehicleGroupId, cycle, from = 0, to = 1) => ({
  vehicleGroupId,
  cycleId: cycle.id,
  fromPositionId: cycle.positions[from].id,
  toPositionId: cycle.positions[to].id,
  durationMinutes: 24,
  emptyKwh: 12,
  fullKwh: 24,
  source: '2026-11-03 区间实测记录',
});
const inputsOf = (operations) => ({
  battery: operations.battery,
  vehicleGroups: operations.vehicleGroups.map(({ vehicleIds, baseStartBasis, ...input }) => {
    assert.ok(vehicleIds);
    assert.ok(baseStartBasis === null || typeof baseStartBasis === 'object');
    return input;
  }),
  measuredSegments: operations.measuredSegments.map(({ basis, ...input }) => {
    assert.ok(basis);
    return input;
  }),
});

async function saveOperations(request, path, saved, operations) {
  const response = await request(`${path}/operations`, 'PUT', {
    expectedRevision: saved.revision,
    operations,
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body;
}

test('fleet drafts, one battery and stable capped vehicle identities persist through SQLite restart', async () => {
  let application = await startApplication();
  const directory = application.directory;
  const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);
  try {
    const { project, route, path, saved: initial, cycle } = await setup(request);
    const draft = {
      battery: { capacityKwh: null, chargePowerKw: null, chargeEfficiency: null, source: '' },
      vehicleGroups: [
        {
          ...group(cycle),
          count: 0,
          baseCycleId: null,
          baseStartPositionId: null,
          payloadTonnes: null,
          speedKph: null,
          emptyKwhPerKm: null,
          fullKwhPerKm: null,
          safetySocPercent: null,
          shifts: [],
          loadingMinutes: null,
          unloadingMinutes: null,
          source: '',
        },
      ],
      measuredSegments: [],
    };
    let saved = await saveOperations(request, path, initial, draft);
    assert.equal(saved.inputVersion, initial.inputVersion + 1);
    assert.equal(saved.revision, initial.revision + 1);
    assert.deepEqual(saved.context.operations.battery, draft.battery);
    assert.deepEqual(saved.context.operations.vehicleGroups[0].vehicleIds, []);
    assert.equal(saved.context.operations.vehicleGroups[0].baseStartBasis, null);
    const firstId = saved.context.operations.vehicleGroups[0].id;
    saved = await saveOperations(request, path, saved, {
      battery: battery(),
      vehicleGroups: [
        { ...group(cycle, '同名车型', 30), id: firstId },
        {
          ...group(cycle, '同名车型', 20),
          payloadTonnes: 20,
          speedKph: 40,
          emptyKwhPerKm: 0.8,
          fullKwhPerKm: 1.5,
          safetySocPercent: 10,
          shifts: [{ startMinute: 1320, endMinute: 1800 }],
        },
      ],
      measuredSegments: [],
    });
    const [first, second] = saved.context.operations.vehicleGroups;
    assert.equal(first.id, firstId);
    assert.equal(first.count, 30);
    assert.equal(second.count, 20);
    assert.equal(first.vehicleIds.length, 30);
    assert.equal(second.vehicleIds.length, 20);
    assert.equal(new Set([...first.vehicleIds, ...second.vehicleIds]).size, 50);
    assert.deepEqual(first.baseStartBasis, { longitude: 121.47, latitude: 31.23 });
    assert.deepEqual(saved.context.operations.battery, battery());
    const unchanged = await saveOperations(
      request,
      path,
      saved,
      inputsOf(saved.context.operations),
    );
    assert.deepEqual(unchanged, saved, 'unchanged operations do not advance either version');
    const renamed = await request(path, 'PATCH', {
      expectedRevision: saved.revision,
      name: '仅改方案名称',
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.inputVersion, saved.inputVersion);
    saved = renamed.body;
    const reordered = inputsOf(saved.context.operations);
    reordered.vehicleGroups = [
      { ...reordered.vehicleGroups[1], name: '轻载改名' },
      { ...reordered.vehicleGroups[0], count: 5 },
    ];
    saved = await saveOperations(request, path, saved, reordered);
    assert.deepEqual(
      saved.context.operations.vehicleGroups.map((item) => item.id),
      [second.id, first.id],
    );
    assert.deepEqual(saved.context.operations.vehicleGroups[1].vehicleIds, first.vehicleIds);
    assert.equal(saved.context.operations.vehicleGroups[1].count, 5);
    const increased = inputsOf(saved.context.operations);
    increased.vehicleGroups[1].count = 30;
    saved = await saveOperations(request, path, saved, increased);
    assert.deepEqual(saved.context.operations.vehicleGroups[1].vehicleIds, first.vehicleIds);
    increased.vehicleGroups[1].count = 31;
    saved = await saveOperations(request, path, saved, increased);
    assert.deepEqual(
      saved.context.operations.vehicleGroups[1].vehicleIds.slice(0, 30),
      first.vehicleIds,
    );
    assert.equal(saved.context.operations.vehicleGroups[1].vehicleIds.length, 31);
    assert.deepEqual(saved.context.transportCycles, initial.context.transportCycles);
    assert.deepEqual(
      (await request(`/api/routes/${route.id}?projectId=${project.id}`)).body,
      route,
    );
    await application.stop();
    const database = new Database(join(directory, 'test.sqlite'), { readonly: true });
    try {
      assert.equal(database.pragma('user_version', { simple: true }), 4);
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

test('fleet input rejects invalid, duplicate and foreign identities atomically with revision protection', async () => {
  const application = await startApplication();
  const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);
  try {
    const { path, saved: initial, cycle } = await setup(request);
    const foreign = await setup(request, '外部车队项目');
    const saved = await saveOperations(request, path, initial, {
      battery: battery(),
      vehicleGroups: [group(cycle)],
      measuredSegments: [],
    });
    const foreignSaved = await saveOperations(request, foreign.path, foreign.saved, {
      battery: battery(),
      vehicleGroups: [group(foreign.cycle)],
      measuredSegments: [],
    });
    const valid = inputsOf(saved.context.operations);
    const vehicle = valid.vehicleGroups[0];
    const invalidGroups = [
      ...[-1, 1.5, '2', null, Number.MAX_SAFE_INTEGER + 1].map((count) => ({ ...vehicle, count })),
      ...[0, -1, '40'].map((payloadTonnes) => ({ ...vehicle, payloadTonnes })),
      ...[0, -1, '30'].map((speedKph) => ({ ...vehicle, speedKph })),
      { ...vehicle, emptyKwhPerKm: -1 },
      { ...vehicle, fullKwhPerKm: -1 },
      { ...vehicle, fullKwhPerKm: 0.5 },
      { ...vehicle, safetySocPercent: -1 },
      { ...vehicle, safetySocPercent: 101 },
      { ...vehicle, loadingMinutes: -1 },
      { ...vehicle, unloadingMinutes: -1 },
      { ...vehicle, name: '' },
      { ...vehicle, id: 'unowned-group' },
      { ...vehicle, id: foreignSaved.context.operations.vehicleGroups[0].id },
      { ...vehicle, baseCycleId: foreign.cycle.id },
      { ...vehicle, baseStartPositionId: cycle.positions[3].id },
      { ...vehicle, baseStartPositionId: foreign.cycle.positions[0].id },
      { ...vehicle, baseCycleId: null },
      { ...vehicle, vehicleIds: ['forged-vehicle'] },
      { ...vehicle, baseStartBasis: { longitude: 0, latitude: 0 } },
      { ...vehicle, shifts: [{ startMinute: -1, endMinute: 10 }] },
      { ...vehicle, shifts: [{ startMinute: 1440, endMinute: 1500 }] },
      { ...vehicle, shifts: [{ startMinute: 60, endMinute: 60 }] },
      { ...vehicle, shifts: [{ startMinute: 60, endMinute: 1501 }] },
      { ...vehicle, shifts: [{ startMinute: 60.5, endMinute: 120 }] },
      {
        ...vehicle,
        shifts: [
          { startMinute: 60, endMinute: 180 },
          { startMinute: 120, endMinute: 240 },
        ],
      },
      {
        ...vehicle,
        shifts: [
          { startMinute: 1320, endMinute: 1560 },
          { startMinute: 60, endMinute: 180 },
        ],
      },
      { ...vehicle, source: 123 },
      { ...vehicle, refreshBase: 'true' },
      null,
    ];
    for (const invalid of invalidGroups) {
      const response = await request(`${path}/operations`, 'PUT', {
        expectedRevision: saved.revision,
        operations: { ...valid, vehicleGroups: [invalid] },
      });
      assert.equal(response.status, 400, JSON.stringify(invalid));
      assert.deepEqual((await request(path)).body, saved);
    }
    for (const invalid of [
      { ...battery(), capacityKwh: 0 },
      { ...battery(), chargePowerKw: 0 },
      { ...battery(), chargeEfficiency: 0 },
      { ...battery(), chargeEfficiency: 1.01 },
      { ...battery(), chargeEfficiency: '0.9' },
      { ...battery(), capacityKwh: -1 },
      [battery(), battery()],
      { ...battery(), extra: 'unsupported' },
    ]) {
      const response = await request(`${path}/operations`, 'PUT', {
        expectedRevision: saved.revision,
        operations: { ...valid, battery: invalid },
      });
      assert.equal(response.status, 400, JSON.stringify(invalid));
      assert.deepEqual((await request(path)).body, saved);
    }
    for (const body of [
      {
        expectedRevision: saved.revision,
        operations: { ...valid, vehicleGroups: [vehicle, vehicle] },
      },
      { expectedRevision: saved.revision, operations: { ...valid, vehicleGroups: {} } },
      { expectedRevision: saved.revision, operations: { ...valid, measuredSegments: {} } },
      { expectedRevision: saved.revision, operations: { ...valid, batteries: [] } },
      { expectedRevision: saved.revision, operations: null },
      { expectedRevision: String(saved.revision), operations: valid },
      { operations: valid },
      { expectedRevision: saved.revision, operations: valid, projectId: foreign.project.id },
    ]) {
      assert.equal(
        (await request(`${path}/operations`, 'PUT', body)).status,
        400,
        JSON.stringify(body),
      );
      assert.deepEqual((await request(path)).body, saved);
    }
    const infinity = await fetch(`${application.baseUrl}${path}/operations`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: saved.revision, operations: valid }).replace(
        '"capacityKwh":300',
        '"capacityKwh":1e400',
      ),
    });
    assert.equal(infinity.status, 400);
    assert.deepEqual((await request(path)).body, saved);
    assert.equal(
      (await request(`${path}/operations`, 'PUT', { expectedRevision: 1, operations: valid }))
        .status,
      409,
    );
    assert.equal(
      (
        await request(
          `/api/projects/${foreign.project.id}/scenarios/${saved.id}/operations`,
          'PUT',
          { expectedRevision: saved.revision, operations: valid },
        )
      ).status,
      404,
    );
    for (const operations of [undefined, null, { ...valid, battery: null }]) {
      assert.equal(
        (
          await request(path, 'PATCH', {
            expectedRevision: saved.revision,
            context: { ...saved.context, operations },
          })
        ).status,
        400,
      );
      assert.deepEqual((await request(path)).body, saved);
    }
    const enriched = await request(path, 'PATCH', {
      expectedRevision: saved.revision,
      context: { ...saved.context, resources: { note: '其他资料保持可编辑' } },
    });
    assert.equal(enriched.status, 200);
    assert.deepEqual(enriched.body.context.operations, saved.context.operations);
    const race = await Promise.all(
      [11, 20].map((loadingMinutes) =>
        request(`${path}/operations`, 'PUT', {
          expectedRevision: enriched.body.revision,
          operations: { ...valid, vehicleGroups: [{ ...vehicle, loadingMinutes }] },
        }),
      ),
    );
    assert.deepEqual(race.map((result) => result.status).sort(), [200, 409]);
    assert.deepEqual((await request(path)).body, race.find((result) => result.status === 200).body);
  } finally {
    await application.stop();
    await application.cleanup();
  }
});

test('measured overrides bind directed occurrences and reject unsupported or duplicate inputs atomically', async () => {
  const application = await startApplication();
  const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);
  try {
    const { path, saved: initial, cycle } = await setup(request);
    const foreign = await setup(request, '其他实测项目');
    let saved = await saveOperations(request, path, initial, {
      battery: battery(),
      vehicleGroups: [group(cycle)],
      measuredSegments: [],
    });
    const vehicleId = saved.context.operations.vehicleGroups[0].id;
    const foreignSaved = await saveOperations(request, foreign.path, foreign.saved, {
      battery: battery(),
      vehicleGroups: [group(foreign.cycle)],
      measuredSegments: [],
    });
    const foreignGroupId = foreignSaved.context.operations.vehicleGroups[0].id;
    const foreignMeasured = await saveOperations(request, foreign.path, foreignSaved, {
      ...inputsOf(foreignSaved.context.operations),
      measuredSegments: [measured(foreignGroupId, foreign.cycle)],
    });
    const valid = measured(vehicleId, cycle);
    saved = await saveOperations(request, path, saved, {
      ...inputsOf(saved.context.operations),
      measuredSegments: [valid, { ...measured(vehicleId, cycle, 2, 3), durationMinutes: 30 }],
    });
    const records = saved.context.operations.measuredSegments;
    assert.equal(new Set(records.map((item) => item.id)).size, 2);
    assert.deepEqual(records[0].basis, {
      strategy: cycle.strategy,
      fromLongitude: 121.47,
      fromLatitude: 31.23,
      toLongitude: 121.6,
      toLatitude: 31.3,
      payloadTonnes: 40,
    });
    assert.notEqual(
      records[0].fromPositionId,
      records[1].toPositionId,
      'repeated locations retain distinct occurrence identities',
    );
    const inputs = inputsOf(saved.context.operations);
    assert.deepEqual(await saveOperations(request, path, saved, inputs), saved);
    for (const invalid of [
      { ...valid, id: 'unowned-measured' },
      { ...valid, id: foreignMeasured.context.operations.measuredSegments[0].id },
      { ...valid, vehicleGroupId: foreignGroupId },
      { ...valid, vehicleGroupId: 'unowned-group' },
      { ...valid, cycleId: foreign.cycle.id },
      { ...valid, fromPositionId: cycle.positions[1].id, toPositionId: cycle.positions[0].id },
      { ...valid, toPositionId: cycle.positions[2].id },
      { ...valid, toPositionId: foreign.cycle.positions[1].id },
      { ...valid, durationMinutes: -1 },
      { ...valid, durationMinutes: 0 },
      { ...valid, emptyKwh: -1 },
      { ...valid, fullKwh: -1 },
      { ...valid, fullKwh: 1 },
      { ...valid, emptyKwh: null },
      { ...valid, durationMinutes: null, emptyKwh: null, fullKwh: null },
      { ...valid, source: '' },
      { ...valid, refreshBasis: 'true' },
      { ...valid, basis: records[0].basis },
      null,
    ]) {
      const response = await request(`${path}/operations`, 'PUT', {
        expectedRevision: saved.revision,
        operations: { ...inputs, measuredSegments: [inputs.measuredSegments[1], invalid] },
      });
      assert.equal(response.status, 400, JSON.stringify(invalid));
      assert.deepEqual((await request(path)).body, saved);
    }
    for (const measuredSegments of [
      [inputs.measuredSegments[0], inputs.measuredSegments[0]],
      [inputs.measuredSegments[0], valid],
    ]) {
      assert.equal(
        (
          await request(`${path}/operations`, 'PUT', {
            expectedRevision: saved.revision,
            operations: { ...inputs, measuredSegments },
          })
        ).status,
        400,
      );
      assert.deepEqual((await request(path)).body, saved);
    }
    saved = await saveOperations(request, path, saved, {
      ...inputs,
      measuredSegments: [
        { ...inputs.measuredSegments[0], durationMinutes: null },
        { ...inputs.measuredSegments[1], emptyKwh: null, fullKwh: null },
      ],
    });
    assert.equal(saved.context.operations.measuredSegments[0].durationMinutes, null);
    assert.equal(saved.context.operations.measuredSegments[1].emptyKwh, null);
  } finally {
    await application.stop();
    await application.cleanup();
  }
});

test('cycle edits retain base and measured evidence until explicit confirmation instead of rebinding', async () => {
  const application = await startApplication();
  const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);
  try {
    const { path, saved: initial, cycle } = await setup(request);
    let saved = await saveOperations(request, path, initial, {
      battery: battery(),
      vehicleGroups: [group(cycle)],
      measuredSegments: [],
    });
    saved = await saveOperations(request, path, saved, {
      ...inputsOf(saved.context.operations),
      measuredSegments: [measured(saved.context.operations.vehicleGroups[0].id, cycle)],
    });
    const original = saved.context.operations;
    const positions = cycle.positions.map(({ id, point }) => ({ id, point }));
    const changed = positions.map((position, index) =>
      index === 0 || index === positions.length - 1
        ? { ...position, point: { ...position.point, longitude: 121.48 } }
        : position,
    );
    const coordinateEdit = await request(`${path}/cycles/${cycle.id}`, 'PATCH', {
      expectedRevision: saved.revision,
      positions: changed,
    });
    assert.equal(coordinateEdit.status, 200);
    saved = coordinateEdit.body;
    assert.deepEqual(
      saved.context.operations,
      original,
      'same position identity with changed coordinates does not rewrite saved evidence',
    );
    const unchanged = await saveOperations(
      request,
      path,
      saved,
      inputsOf(saved.context.operations),
    );
    assert.deepEqual(unchanged, saved, 'ordinary save does not silently refresh stale basis');
    const refresh = inputsOf(saved.context.operations);
    refresh.vehicleGroups[0].refreshBase = true;
    refresh.measuredSegments[0].refreshBasis = true;
    saved = await saveOperations(request, path, saved, refresh);
    assert.equal(saved.context.operations.vehicleGroups[0].baseStartBasis.longitude, 121.48);
    assert.equal(saved.context.operations.measuredSegments[0].basis.fromLongitude, 121.48);
    assert.deepEqual(
      saved.context.operations.vehicleGroups[0].vehicleIds,
      original.vehicleGroups[0].vehicleIds,
    );
    const beforeStrategy = saved.context.operations;
    saved = (
      await request(`${path}/cycles/${cycle.id}`, 'PATCH', {
        expectedRevision: saved.revision,
        strategy: 35,
      })
    ).body;
    assert.deepEqual(saved.context.operations, beforeStrategy);
    const strategyRefresh = inputsOf(saved.context.operations);
    strategyRefresh.measuredSegments[0].refreshBasis = true;
    saved = await saveOperations(request, path, saved, strategyRefresh);
    assert.equal(saved.context.operations.measuredSegments[0].basis.strategy, 35);
    const beforePayload = saved.context.operations.measuredSegments[0].basis;
    const payloadEdit = inputsOf(saved.context.operations);
    payloadEdit.vehicleGroups[0].payloadTonnes = 35;
    saved = await saveOperations(request, path, saved, payloadEdit);
    assert.deepEqual(
      saved.context.operations.measuredSegments[0].basis,
      beforePayload,
      'payload edits retain the old measured full-load basis',
    );
    const currentPositions = saved.context.transportCycles[0].positions.map(({ id, point }) => ({
      id,
      point,
    }));
    const beforeOrder = saved.context.operations;
    saved = (
      await request(`${path}/cycles/${cycle.id}`, 'PATCH', {
        expectedRevision: saved.revision,
        positions: [
          currentPositions[1],
          currentPositions[2],
          currentPositions[0],
          currentPositions[3],
        ],
      })
    ).body;
    assert.deepEqual(
      saved.context.operations,
      beforeOrder,
      'changed first occurrence does not move the vehicle base',
    );
    saved = (
      await request(`${path}/cycles/${cycle.id}?expectedRevision=${saved.revision}`, 'DELETE')
    ).body;
    assert.deepEqual(
      saved.context.operations,
      beforeOrder,
      'deleted cycle leaves inputs available for repair',
    );
    saved = await saveOperations(request, path, saved, {
      battery: null,
      vehicleGroups: [],
      measuredSegments: [],
    });
    assert.deepEqual(saved.context.operations, {
      battery: null,
      vehicleGroups: [],
      measuredSegments: [],
    });
  } finally {
    await application.stop();
    await application.cleanup();
  }
});
