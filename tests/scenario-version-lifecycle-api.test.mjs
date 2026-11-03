import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
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

async function setup(request) {
  const project = (await request('/api/projects', 'POST', { name: '版本决策项目' })).body;
  const collection = `/api/projects/${project.id}/scenarios`;
  const created = (await request(collection, 'POST', { name: '冻结依据' })).body;
  return { project, collection, path: `${collection}/${created.id}`, created };
}

async function allInputs(request, project, path, created) {
  const route = (
    await request(`/api/projects/${project.id}/routes`, 'POST', {
      name: '港区决策循环',
      strategy: 34,
      points: [
        point('a', '港区', 121.47, 31.23),
        point('b', '堆场', 121.6, 31.3),
        point('a-return', '港区', 121.47, 31.23),
      ],
    })
  ).body;
  let saved = (
    await request(`${path}/cycles`, 'POST', {
      sourceRouteId: route.id,
      expectedRevision: created.revision,
    })
  ).body;
  const cycle = saved.context.transportCycles[0];
  saved = (
    await request(`${path}/cycles/${cycle.id}`, 'PATCH', {
      confirmed: true,
      expectedRevision: saved.revision,
    })
  ).body;
  saved = (
    await request(`${path}/demands`, 'PUT', {
      expectedRevision: saved.revision,
      demands: [
        {
          cycleId: cycle.id,
          loadingPositionId: cycle.positions[0].id,
          unloadingPositionId: cycle.positions[1].id,
          dailyTonnes: 100,
        },
      ],
    })
  ).body;
  const battery = {
    capacityKwh: 300,
    chargePowerKw: 120,
    chargeEfficiency: 0.9,
    source: '电池台账',
  };
  saved = (
    await request(`${path}/operations`, 'PUT', {
      expectedRevision: saved.revision,
      operations: {
        battery,
        vehicleGroups: [
          {
            name: '港区车型',
            count: 2,
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
            source: '车队台账',
          },
        ],
        measuredSegments: [],
      },
    })
  ).body;
  const powers = (
    await request(`/api/projects/${project.id}/power-connection-points`, 'PUT', {
      expectedRevision: 1,
      points: [
        {
          name: '项目电源',
          longitude: 121.5,
          latitude: 31.2,
          coordinateSystem: 'GCJ-02',
          availableCapacityKw: 1000,
          capacitySource: '供电答复',
          connectionNotes: '工程条件待核对',
        },
      ],
    })
  ).body;
  saved = (
    await request(`${path}/station-network`, 'PUT', {
      expectedRevision: saved.revision,
      network: {
        stationTypes: [
          {
            name: '双工位',
            bays: 2,
            swapMinutes: 6,
            batteryInventory: 8,
            chargingSlots: 4,
            chargePowerKw: 120,
            serviceWindows: [],
            chargeWindows: [],
            investment: null,
            annualOperatingCost: null,
            source: '设备台账',
          },
        ],
        sites: [
          {
            name: '港区站址',
            longitude: 121.48,
            latitude: 31.24,
            coordinateSystem: 'GCJ-02',
            source: 'manual',
            siteNotes: '候选场地',
            siteConfirmed: false,
            connection: null,
          },
        ],
        powerSources: [{ sourcePointId: powers.points[0].id }],
        fixedLayout: [],
      },
    })
  ).body;
  const response = await request(path, 'PATCH', {
    expectedRevision: saved.revision,
    context: {
      ...saved.context,
      resources: { businessBoundary: '一体化' },
      annual: [{ year: 2030, growthPercent: 5 }],
      results: [{ note: '旧扩展容器，非正式结果' }],
    },
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return { saved: response.body, route, powers };
}

test('freezing preserves a decision snapshot and rejects every scenario write through restart', async () => {
  let application = await startApplication();
  const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);
  try {
    const { project, collection, path, created } = await setup(request);
    const route = (
      await request(`/api/projects/${project.id}/routes`, 'POST', {
        name: '决策循环',
        points: [point('a', '仓库', 121.47, 31.23), point('b', '堆场', 121.6, 31.3)],
      })
    ).body;
    const imported = (
      await request(`${path}/cycles`, 'POST', {
        sourceRouteId: route.id,
        expectedRevision: created.revision,
      })
    ).body;
    const frozenResponse = await fetch(`${application.baseUrl}${path}/freeze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: imported.revision }),
    });
    assert.equal(frozenResponse.status, 200);
    const frozen = await frozenResponse.json();
    assert.equal(frozen.status, 'frozen');
    assert.ok(frozen.frozenAt);
    assert.equal(frozen.lineageId, created.id);
    assert.equal(frozen.copiedFrom, null);
    assert.equal(frozen.inputVersion, imported.inputVersion);
    assert.equal(frozen.revision, imported.revision + 1);
    assert.deepEqual(frozen.context, imported.context);
    const cyclePath = `${path}/cycles/${imported.context.transportCycles[0].id}`;
    const revision = frozen.revision;
    const writes = [
      [path, 'PATCH', { name: '不可改名', expectedRevision: revision }],
      [path, 'PATCH', { context: frozen.context, expectedRevision: revision }],
      [`${path}?expectedRevision=${revision}`, 'DELETE'],
      [`${path}/freeze`, 'POST', { expectedRevision: revision }],
      [`${path}/cycles`, 'POST', { sourceRouteId: route.id, expectedRevision: revision }],
      [cyclePath, 'PATCH', { name: '不可改循环', expectedRevision: revision }],
      [`${cyclePath}?expectedRevision=${revision}`, 'DELETE'],
      [`${path}/demands`, 'PUT', { demands: [], expectedRevision: revision }],
      [
        `${path}/operations`,
        'PUT',
        {
          expectedRevision: revision,
          operations: {
            battery: { capacityKwh: null, chargePowerKw: null, chargeEfficiency: null, source: '' },
            vehicleGroups: [],
            measuredSegments: [],
          },
        },
      ],
      [
        `${path}/station-network`,
        'PUT',
        {
          expectedRevision: revision,
          network: { stationTypes: [], sites: [], powerSources: [], fixedLayout: [] },
        },
      ],
      [path, 'PATCH', { name: '迟到请求', expectedRevision: imported.revision }],
    ];
    for (const [target, method, body] of writes) {
      const rejected = await request(target, method, body);
      assert.equal(rejected.status, 409, `${method} ${target}: ${JSON.stringify(rejected.body)}`);
      assert.deepEqual((await request(path)).body, frozen);
    }
    assert.deepEqual((await request(collection)).body, [frozen]);
    const directory = application.directory;
    await application.stop();
    application = await startApplication({}, directory);
    assert.deepEqual((await request(path)).body, frozen);
  } catch (error) {
    throw new Error(`${error.message}\n${application.logs()}`, { cause: error });
  } finally {
    await application.stop();
    await application.cleanup();
  }
});

test('copies retain every supported input and provenance while editing independently of frozen ancestors', async () => {
  let application = await startApplication();
  const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);
  try {
    const { project, collection, path, created } = await setup(request);
    const { saved } = await allInputs(request, project, path, created);
    const frozen = (await request(`${path}/freeze`, 'POST', { expectedRevision: saved.revision }))
      .body;
    const response = await fetch(`${application.baseUrl}${path}/copy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: frozen.revision, name: '调整草案' }),
    });
    assert.equal(response.status, 201);
    const copied = await response.json();
    assert.notEqual(copied.id, frozen.id);
    assert.equal(copied.projectId, project.id);
    assert.equal(copied.status, 'draft');
    assert.equal(copied.frozenAt, null);
    assert.equal(copied.lineageId, frozen.id);
    assert.equal(copied.inputVersion, 1);
    assert.equal(copied.revision, 1);
    assert.deepEqual(copied.copiedFrom, {
      scenarioId: frozen.id,
      name: frozen.name,
      inputVersion: frozen.inputVersion,
      revision: frozen.revision,
    });
    assert.deepEqual(copied.context, { ...frozen.context, results: [] });
    const copyPath = `${collection}/${copied.id}`;
    const demands = copied.context.transportDemands.map((demand) => ({
      ...demand,
      dailyTonnes: 140,
    }));
    const edited = await request(`${copyPath}/demands`, 'PUT', { expectedRevision: 1, demands });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.inputVersion, 2);
    assert.equal(edited.body.context.transportDemands[0].dailyTonnes, 140);
    assert.deepEqual((await request(path)).body, frozen);
    assert.equal(
      (await request(`${copyPath}/copy`, 'POST', { expectedRevision: 1, name: '过期复制' })).status,
      409,
    );
    const next = await request(`${copyPath}/copy`, 'POST', {
      expectedRevision: edited.body.revision,
      name: '第二代草案',
    });
    assert.equal(next.status, 201);
    assert.equal(next.body.lineageId, frozen.id);
    assert.equal(next.body.copiedFrom.scenarioId, copied.id);
    assert.deepEqual(next.body.context, edited.body.context);
    const directory = application.directory;
    await application.stop();
    application = await startApplication({}, directory);
    assert.deepEqual((await request(path)).body, frozen);
    assert.deepEqual((await request(copyPath)).body, edited.body);
    assert.deepEqual((await request(`${collection}/${next.body.id}`)).body, next.body);
    const other = (await request('/api/projects', 'POST', { name: '外部项目' })).body;
    assert.equal(
      (
        await request(`/api/projects/${other.id}/scenarios/${copied.id}/copy`, 'POST', {
          name: '不可跨项目',
          expectedRevision: edited.body.revision,
        })
      ).status,
      404,
    );
    for (const field of ['status', 'lineageId', 'copiedFrom', 'frozenAt']) {
      assert.equal(
        (
          await request(copyPath, 'PATCH', {
            expectedRevision: edited.body.revision,
            [field]: frozen[field],
          })
        ).status,
        400,
      );
    }
    assert.equal((await request(collection)).body.length, 3);
  } catch (error) {
    throw new Error(`${error.message}\n${application.logs()}`, { cause: error });
  } finally {
    await application.stop();
    await application.cleanup();
  }
});

test('one comparison contract explains source, business order and every supported input section within its project', async () => {
  const application = await startApplication();
  const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);
  try {
    const { project, collection, path, created } = await setup(request);
    const { saved } = await allInputs(request, project, path, created);
    let copied = (
      await request(`${path}/copy`, 'POST', { expectedRevision: saved.revision, name: '参数对照' })
    ).body;
    const comparePath = `${collection}/compare?left=${saved.id}&right=${copied.id}`;
    const first = await fetch(`${application.baseUrl}${comparePath}`);
    assert.equal(first.status, 200);
    assert.deepEqual(
      (await first.json()).differences,
      [],
      'name, lineage and copied result-container differences are not business inputs',
    );
    const copyPath = `${collection}/${copied.id}`;
    const cycle = copied.context.transportCycles[0];
    copied = (
      await request(`${copyPath}/cycles/${cycle.id}`, 'PATCH', {
        expectedRevision: copied.revision,
        positions: [cycle.positions[2], cycle.positions[1], cycle.positions[0]].map(
          ({ id, point }) => ({ id, point }),
        ),
        strategy: 35,
      })
    ).body;
    // Preserve a valid load→unload pair after changing the occurrence order.
    copied = (
      await request(`${copyPath}/demands`, 'PUT', {
        expectedRevision: copied.revision,
        demands: copied.context.transportDemands.map((demand) => ({
          ...demand,
          loadingPositionId: cycle.positions[2].id,
          unloadingPositionId: cycle.positions[1].id,
          dailyTonnes: 140,
        })),
      })
    ).body;
    const operations = copied.context.operations;
    copied = (
      await request(`${copyPath}/operations`, 'PUT', {
        expectedRevision: copied.revision,
        operations: {
          ...operations,
          battery: { ...operations.battery, capacityKwh: 360 },
          vehicleGroups: operations.vehicleGroups.map(
            ({ vehicleIds, baseStartBasis, ...input }) => {
              assert.equal(vehicleIds.length, 2);
              assert.ok(baseStartBasis);
              return { ...input, count: 1 };
            },
          ),
        },
      })
    ).body;
    const network = copied.context.stationNetwork;
    copied = (
      await request(`${copyPath}/station-network`, 'PUT', {
        expectedRevision: copied.revision,
        network: {
          ...network,
          stationTypes: network.stationTypes.map(({ batteryBasis, ...input }) => {
            assert.equal(batteryBasis.capacityKwh, 300);
            return { ...input, chargePowerKw: 240 };
          }),
          sites: network.sites.map(({ originalLongitude, originalLatitude, ...input }) => ({
            ...input,
            longitude: originalLongitude,
            latitude: originalLatitude,
            siteNotes: '新增踏勘依据',
          })),
          powerSources: network.powerSources.map(({ id, sourcePointId }) => ({
            id,
            sourcePointId,
          })),
        },
      })
    ).body;
    const contextSave = await request(copyPath, 'PATCH', {
      expectedRevision: copied.revision,
      context: {
        ...copied.context,
        resources: { businessBoundary: '仅站方', addedNull: null },
        annual: [{ year: 2030, growthPercent: 8 }],
      },
    });
    assert.equal(contextSave.status, 200, JSON.stringify(contextSave.body));
    const compared = await request(comparePath);
    assert.equal(compared.status, 200);
    assert.equal(compared.body.left.id, saved.id);
    assert.equal(compared.body.right.revision, contextSave.body.revision);
    const differences = compared.body.differences;
    assert.deepEqual(
      new Set(differences.map(({ section }) => section)),
      new Set(['运输循环', '运输需求', '车辆与运营', '站网配置', '其他资源', '年度参数']),
    );
    const values = (suffix) =>
      differences
        .filter(({ path }) => path.endsWith(suffix))
        .map(({ left, right }) => [left, right]);
    assert.ok(
      differences.some(({ path }) => path.endsWith('.positions.order')),
      'business occurrence order is visible separately',
    );
    assert.ok(values('.strategy').some(([left, right]) => left === 34 && right === 35));
    assert.deepEqual(values('.dailyTonnes'), [[100, 140]]);
    assert.deepEqual(values('.capacityKwh'), [[300, 360]]);
    assert.deepEqual(values('.count'), [[2, 1]]);
    assert.deepEqual(values('.chargePowerKw'), [[120, 240]]);
    assert.deepEqual(values('.businessBoundary'), [['一体化', '仅站方']]);
    assert.ok(
      differences.some(
        ({ path, kind, left, right }) =>
          path === 'resources.addedNull' && kind === 'added' && left === null && right === null,
      ),
    );
    assert.ok(
      differences.some(
        ({ section, left, right }) =>
          section === '年度参数' && left[0].growthPercent === 5 && right[0].growthPercent === 8,
      ),
    );
    assert.deepEqual((await request(path)).body, saved);
    const other = (await request('/api/projects', 'POST', { name: '隔离比较项目' })).body;
    const foreign = (
      await request(`/api/projects/${other.id}/scenarios`, 'POST', { name: '外部版本' })
    ).body;
    assert.equal(
      (await request(`${collection}/compare?left=${saved.id}&right=${foreign.id}`)).status,
      404,
    );
    assert.equal(
      (
        await request(
          `/api/projects/${other.id}/scenarios/compare?left=${saved.id}&right=${copied.id}`,
        )
      ).status,
      404,
    );
    assert.equal((await request(`${collection}/compare?left=${saved.id}`)).status, 400);
  } catch (error) {
    throw new Error(`${error.message}\n${application.logs()}`, { cause: error });
  } finally {
    await application.stop();
    await application.cleanup();
  }
});

test('explicit source updates create one new input version while preserving frozen snapshots and invalidated dependent inputs', async () => {
  let application = await startApplication();
  const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);
  try {
    const { project, collection, path, created } = await setup(request);
    const { saved, route } = await allInputs(request, project, path, created);
    const frozen = (await request(`${path}/freeze`, 'POST', { expectedRevision: saved.revision }))
      .body;
    let copied = (
      await request(`${path}/copy`, 'POST', {
        expectedRevision: frozen.revision,
        name: '引入更新草案',
      })
    ).body;
    const copyPath = `${collection}/${copied.id}`;
    const cycle = copied.context.transportCycles[0];
    copied = (
      await request(`${copyPath}/cycles/${cycle.id}`, 'PATCH', {
        expectedRevision: copied.revision,
        name: '保留本地编排',
        confirmed: true,
        positions: [
          ...cycle.positions.slice(0, 2).map(({ id, point }) => ({ id, point })),
          { point: point('manual', '手工补点', 121.65, 31.35) },
          { id: cycle.positions[2].id, point: cycle.positions[2].point },
        ],
      })
    ).body;
    const sourcePath = `${copyPath}/cycles/${cycle.id}/source`;
    const same = await fetch(`${application.baseUrl}${sourcePath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: copied.revision }),
    });
    assert.equal(same.status, 200);
    assert.deepEqual(
      await same.json(),
      copied,
      'unchanged source does not overwrite local edits or manufacture a version',
    );
    const routePath = `/api/routes/${route.id}?projectId=${project.id}`;
    const updatedRoute = (
      await request(routePath, 'PATCH', {
        name: '最新港区循环',
        strategy: 35,
        points: [
          point('a', '港区新门', 121.48, 31.24),
          point('c', '新料场', 121.7, 31.4),
          point('a-return', '港区新门', 121.48, 31.24),
        ],
      })
    ).body;
    assert.deepEqual(
      (await request(copyPath)).body,
      copied,
      'shared route changes are never silently adopted',
    );
    assert.deepEqual((await request(path)).body, frozen);
    const refreshed = await request(sourcePath, 'POST', { expectedRevision: copied.revision });
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
    const next = refreshed.body;
    assert.equal(next.id, copied.id);
    assert.equal(next.inputVersion, copied.inputVersion + 1);
    assert.equal(next.revision, copied.revision + 1);
    const nextCycle = next.context.transportCycles[0];
    assert.equal(nextCycle.id, cycle.id);
    assert.equal(nextCycle.name, '最新港区循环');
    assert.equal(nextCycle.strategy, 35);
    assert.equal(nextCycle.confirmed, false);
    assert.equal(nextCycle.confirmedAt, null);
    assert.equal(nextCycle.source.inputVersion, updatedRoute.inputVersion);
    assert.deepEqual(
      nextCycle.positions.map(({ point }) => point.name),
      ['港区新门', '新料场', '港区新门'],
    );
    assert.equal(nextCycle.positions[0].id, cycle.positions[0].id);
    assert.equal(nextCycle.positions[2].id, cycle.positions[2].id);
    assert.ok(!nextCycle.positions.some(({ id }) => id === cycle.positions[1].id));
    assert.deepEqual(nextCycle.roads, [], 'refresh does not manufacture directed roads');
    assert.deepEqual(
      next.context.transportDemands,
      copied.context.transportDemands,
      'missing unloading occurrence is retained for explicit repair',
    );
    assert.deepEqual(
      next.context.operations,
      copied.context.operations,
      'old base coordinates remain visible as an invalid basis',
    );
    assert.deepEqual(next.context.stationNetwork, copied.context.stationNetwork);
    assert.deepEqual((await request(routePath)).body, updatedRoute, 'source is never modified');
    assert.deepEqual((await request(path)).body, frozen);
    assert.deepEqual(
      (await request(sourcePath, 'POST', { expectedRevision: next.revision })).body,
      next,
    );
    assert.equal(
      (await request(sourcePath, 'POST', { expectedRevision: copied.revision })).status,
      409,
    );
    assert.equal(
      (
        await request(`${path}/cycles/${cycle.id}/source`, 'POST', {
          expectedRevision: frozen.revision,
        })
      ).status,
      409,
    );
    const compared = await request(`${collection}/compare?left=${frozen.id}&right=${next.id}`);
    assert.equal(compared.status, 200);
    assert.ok(
      compared.body.differences.some(
        ({ path, left, right }) =>
          path.endsWith('.source.inputVersion') && left === 1 && right === 2,
      ),
    );
    assert.ok(compared.body.differences.some(({ path }) => path.endsWith('.positions.order')));
    const directory = application.directory;
    await application.stop();
    application = await startApplication({}, directory);
    assert.deepEqual((await request(copyPath)).body, next);
    assert.deepEqual((await request(path)).body, frozen);
    await request(routePath, 'DELETE');
    assert.equal(
      (await request(sourcePath, 'POST', { expectedRevision: next.revision })).status,
      404,
    );
    assert.deepEqual(
      (await request(copyPath)).body,
      next,
      'deleted source does not delete the adopted snapshot',
    );
    assert.equal(
      (
        await request(`${copyPath}/cycles/missing-cycle/source`, 'POST', {
          expectedRevision: next.revision,
        })
      ).status,
      404,
    );
    const other = (await request('/api/projects', 'POST', { name: '跨项目更新' })).body;
    assert.equal(
      (
        await request(
          `/api/projects/${other.id}/scenarios/${copied.id}/cycles/${cycle.id}/source`,
          'POST',
          { expectedRevision: next.revision },
        )
      ).status,
      404,
    );
  } catch (error) {
    throw new Error(`${error.message}\n${application.logs()}`, { cause: error });
  } finally {
    await application.stop();
    await application.cleanup();
  }
});

test('released schema-four drafts acquire lineage without input changes and unknown context versions cannot be copied', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'haulpath-07-legacy-'));
  const database = new Database(join(directory, 'test.sqlite'));
  const time = '2026-11-03T00:00:00.000Z';
  const old = {
    id: 'released-draft',
    projectId: 'released-project',
    name: '已有草案',
    status: 'draft',
    inputVersion: 9,
    revision: 7,
    context: { schemaVersion: 1, resources: { note: '已发布资料' }, annual: [], results: [] },
    createdAt: time,
    updatedAt: time,
  };
  const future = {
    ...old,
    id: 'future-draft',
    name: '未来上下文',
    context: { ...old.context, schemaVersion: 99, futureInput: { preserved: true } },
  };
  // Literal released schema-four fixture; it deliberately predates lifecycle fields.
  database.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_strategy INTEGER NOT NULL DEFAULT 32);
    CREATE TABLE routes (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, payload TEXT NOT NULL);
    CREATE INDEX routes_project ON routes(project_id);
    CREATE TABLE points (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, payload TEXT NOT NULL);
    CREATE INDEX points_project ON points(project_id);
    CREATE TABLE planning_scenarios (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, payload TEXT NOT NULL);
    CREATE INDEX planning_scenarios_project ON planning_scenarios(project_id);
    CREATE TABLE project_power_connection_points (project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE, payload TEXT NOT NULL);
    PRAGMA user_version = 4;`);
  database
    .prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?)')
    .run(old.projectId, '已发布项目', time, time, 32);
  for (const scenario of [old, future])
    database
      .prepare('INSERT INTO planning_scenarios VALUES (?, ?, ?)')
      .run(scenario.id, old.projectId, JSON.stringify(scenario));
  database.close();
  let application;
  try {
    application = await startApplication({}, directory);
    const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);
    const collection = `/api/projects/${old.projectId}/scenarios`;
    const loaded = (await request(`${collection}/${old.id}`)).body;
    assert.deepEqual(loaded, { ...old, lineageId: old.id, copiedFrom: null, frozenAt: null });
    const copied = await request(`${collection}/${old.id}/copy`, 'POST', {
      expectedRevision: 7,
      name: '旧资料副本',
    });
    assert.equal(copied.status, 201);
    assert.deepEqual(copied.body.context, old.context);
    assert.deepEqual((await request(`${collection}/${old.id}`)).body, loaded);
    const rejected = await request(`${collection}/${future.id}/copy`, 'POST', {
      expectedRevision: 7,
      name: '不能改写未知资料',
    });
    assert.equal(rejected.status, 400);
    assert.deepEqual((await request(`${collection}/${future.id}`)).body.context, future.context);
    assert.equal((await request(collection)).body.length, 3);
  } finally {
    await application?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('freezing during delayed coordinate conversion prevents a late station save from altering either version', async () => {
  let started;
  const conversionStarted = new Promise((resolve) => {
    started = resolve;
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const upstream = createServer(async (_request, response) => {
    started();
    await gate;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ status: '1', locations: '121.476,31.236' }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  let application;
  try {
    application = await startApplication({
      HAULPATH_TEST_MODE: '1',
      AMAP_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
      AMAP_WEB_SERVICE_KEY: 'lifecycle-boundary-test-key',
    });
    const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);
    const { project, path, created, collection } = await setup(request);
    const { saved } = await allInputs(request, project, path, created);
    const pending = request(`${path}/station-network`, 'PUT', {
      expectedRevision: saved.revision,
      network: {
        stationTypes: [],
        powerSources: [],
        fixedLayout: [],
        sites: [
          {
            name: '冻结前发起的站址',
            longitude: 121.47,
            latitude: 31.23,
            coordinateSystem: 'WGS84',
            source: 'manual',
            siteNotes: '高德边界延迟转换',
            siteConfirmed: false,
            connection: null,
          },
        ],
      },
    });
    await Promise.race([
      conversionStarted,
      pending.then((result) => {
        throw new Error(
          `conversion did not reach the controlled boundary: ${JSON.stringify(result)}`,
        );
      }),
    ]);
    const frozenResponse = await request(`${path}/freeze`, 'POST', {
      expectedRevision: saved.revision,
    });
    assert.equal(frozenResponse.status, 200);
    const frozen = frozenResponse.body;
    assert.equal(
      (
        await request(`${path}/copy`, 'POST', {
          expectedRevision: saved.revision,
          name: '旧请求复制',
        })
      ).status,
      409,
    );
    const copied = (
      await request(`${path}/copy`, 'POST', {
        expectedRevision: frozen.revision,
        name: '冻结后新草案',
      })
    ).body;
    assert.deepEqual(copied.context, { ...saved.context, results: [] });
    release();
    assert.equal((await pending).status, 409);
    assert.deepEqual((await request(path)).body, frozen);
    assert.deepEqual((await request(`${collection}/${copied.id}`)).body, copied);
  } finally {
    release();
    await application?.stop();
    await application?.cleanup();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test('identical road replanning changes only source capture time and cannot replace independent cycle edits', async () => {
  let distance = 1234;
  const upstream = createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        status: '1',
        route: {
          paths: [{ distance: String(distance), steps: [{ polyline: '121.47,31.23;121.6,31.3' }] }],
        },
      }),
    );
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  let application;
  try {
    application = await startApplication({
      HAULPATH_TEST_MODE: '1',
      AMAP_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
      AMAP_WEB_SERVICE_KEY: 'road-refresh-test-key',
    });
    const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);
    const { project, path, created } = await setup(request);
    const route = (
      await request(`/api/projects/${project.id}/routes`, 'POST', {
        name: '独立回程依据',
        strategy: 34,
        points: [point('a', '港区', 121.47, 31.23), point('b', '堆场', 121.6, 31.3)],
      })
    ).body;
    const planPath = `/api/routes/${route.id}/plan?projectId=${project.id}`;
    const first = (await request(planPath, 'POST')).body;
    let saved = (
      await request(`${path}/cycles`, 'POST', {
        sourceRouteId: route.id,
        expectedRevision: created.revision,
      })
    ).body;
    const cycle = saved.context.transportCycles[0];
    saved = (
      await request(`${path}/cycles/${cycle.id}`, 'PATCH', {
        expectedRevision: saved.revision,
        confirmed: true,
        positions: [
          ...cycle.positions.map(({ id, point }) => ({ id, point })),
          { point: cycle.positions[0].point },
        ],
      })
    ).body;
    const replanned = (await request(planPath, 'POST')).body;
    assert.equal(replanned.inputVersion, first.inputVersion);
    assert.notEqual(replanned.snapshot.calculatedAt, first.snapshot.calculatedAt);
    assert.deepEqual(replanned.snapshot.legs, first.snapshot.legs);
    const refreshed = await request(`${path}/cycles/${cycle.id}/source`, 'POST', {
      expectedRevision: saved.revision,
    });
    assert.equal(refreshed.status, 200);
    assert.deepEqual(
      refreshed.body,
      saved,
      'capture time alone is not changed input and must preserve manual return and confirmation',
    );
    distance = 1500;
    await request(planPath, 'POST');
    const changed = await request(`${path}/cycles/${cycle.id}/source`, 'POST', {
      expectedRevision: saved.revision,
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.inputVersion, saved.inputVersion + 1);
    assert.equal(changed.body.context.transportCycles[0].source.snapshot.totalDistanceMeters, 1500);
    assert.equal(changed.body.context.transportCycles[0].confirmed, false);
  } finally {
    await application?.stop();
    await application?.cleanup();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test('source refresh preserves separate cycle occurrences when the same source point identity appears twice', async () => {
  const application = await startApplication();
  const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);
  try {
    const { project, path, created } = await setup(request);
    const a = point('repeated-a', '港区', 121.47, 31.23);
    const b = point('b', '堆场', 121.6, 31.3);
    const routeResponse = await request(`/api/projects/${project.id}/routes`, 'POST', {
      name: '往返重复来源身份',
      points: [a, b, a],
    });
    assert.equal(routeResponse.status, 201);
    const route = routeResponse.body;
    let saved = (
      await request(`${path}/cycles`, 'POST', {
        expectedRevision: created.revision,
        sourceRouteId: route.id,
      })
    ).body;
    const cycle = saved.context.transportCycles[0];
    assert.notEqual(cycle.positions[0].id, cycle.positions[2].id);
    const demands = [
      {
        cycleId: cycle.id,
        loadingPositionId: cycle.positions[0].id,
        unloadingPositionId: cycle.positions[1].id,
        dailyTonnes: 100,
      },
      {
        cycleId: cycle.id,
        loadingPositionId: cycle.positions[1].id,
        unloadingPositionId: cycle.positions[2].id,
        dailyTonnes: 50,
      },
    ];
    saved = (await request(`${path}/demands`, 'PUT', { expectedRevision: saved.revision, demands }))
      .body;
    await request(`/api/routes/${route.id}?projectId=${project.id}`, 'PATCH', {
      name: '已更新来源名称',
    });
    const refreshed = await request(`${path}/cycles/${cycle.id}/source`, 'POST', {
      expectedRevision: saved.revision,
    });
    assert.equal(refreshed.status, 200);
    const updated = refreshed.body.context.transportCycles[0];
    assert.deepEqual(
      updated.positions.map(({ id }) => id),
      cycle.positions.map(({ id }) => id),
      'each repeated occurrence retains its own stable identity',
    );
    assert.deepEqual(refreshed.body.context.transportDemands, saved.context.transportDemands);
    const confirmed = await request(`${path}/cycles/${cycle.id}`, 'PATCH', {
      expectedRevision: refreshed.body.revision,
      confirmed: true,
      positions: updated.positions.map(({ id, point }) => ({ id, point })),
    });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.context.transportCycles[0].confirmed, true);
  } finally {
    await application.stop();
    await application.cleanup();
  }
});
