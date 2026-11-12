import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startApplication, jsonRequest } from './helpers/application.mjs';

const battery = {
  capacityKwh: 300,
  chargePowerKw: 120,
  chargeEfficiency: 0.9,
  source: '验收电池台账',
};
const stationType = () => ({
  name: '双工位新建站',
  bays: 2,
  swapMinutes: 6,
  batteryInventory: 8,
  chargingSlots: 4,
  chargePowerKw: 120,
  serviceWindows: [{ startMinute: 0, endMinute: 1440 }],
  chargeWindows: [{ startMinute: 1320, endMinute: 1800 }],
  investment: null,
  annualOperatingCost: null,
  source: '验收设备清单',
});
const site = (name = '人工站址', longitude = 121.47) => ({
  name,
  longitude,
  latitude: 31.23,
  coordinateSystem: 'GCJ-02',
  source: 'manual',
  siteNotes: '现场踏勘依据',
  siteConfirmed: false,
  connection: null,
});
const emptyNetwork = () => ({ stationTypes: [], sites: [], powerSources: [], fixedLayout: [] });
const inputsOf = (network) => ({
  ...(network.constraints ? { constraints: network.constraints } : {}),
  stationTypes: network.stationTypes.map(({ batteryBasis, ...input }) => {
    assert.ok(batteryBasis === null || typeof batteryBasis === 'object');
    return input;
  }),
  sites: network.sites.map(({ originalLongitude, originalLatitude, ...input }) => ({
    ...input,
    longitude: originalLongitude,
    latitude: originalLatitude,
  })),
  powerSources: network.powerSources.map(({ id, sourcePointId }) => ({ id, sourcePointId })),
  fixedLayout: network.fixedLayout,
});
async function setup(request, name = '固定布局项目') {
  const project = (await request('/api/projects', 'POST', { name })).body;
  const resourcePath = `/api/projects/${project.id}/power-connection-points`;
  const powers = (
    await request(resourcePath, 'PUT', {
      expectedRevision: 1,
      points: [
        {
          name: '共享电源',
          longitude: 121.5,
          latitude: 31.2,
          coordinateSystem: 'GCJ-02',
          availableCapacityKw: 1000,
          capacitySource: '供电答复',
          connectionNotes: '独立接电位置',
        },
      ],
    })
  ).body;
  let scenario = (
    await request(`/api/projects/${project.id}/scenarios`, 'POST', { name: '人工固定布局' })
  ).body;
  const path = `/api/projects/${project.id}/scenarios/${scenario.id}`;
  scenario = (
    await request(`${path}/operations`, 'PUT', {
      expectedRevision: scenario.revision,
      operations: { battery, vehicleGroups: [], measuredSegments: [] },
    })
  ).body;
  return { project, resourcePath, powers, path, scenario };
}
async function save(request, path, scenario, network) {
  const response = await request(`${path}/station-network`, 'PUT', {
    expectedRevision: scenario.revision,
    network,
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body;
}

test('manual station drafts retain battery basis, missing prices and project power snapshots through restart', async () => {
  let application = await startApplication();
  const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);
  try {
    const { path, scenario: initial, powers } = await setup(request);
    const saved = await save(request, path, initial, {
      ...emptyNetwork(),
      stationTypes: [stationType()],
      sites: [site()],
      powerSources: [{ sourcePointId: powers.points[0].id }],
    });
    assert.equal(saved.revision, initial.revision + 1);
    assert.equal(saved.inputVersion, initial.inputVersion + 1);
    assert.equal(saved.context.stationNetwork.stationTypes[0].investment, null);
    assert.deepEqual(saved.context.stationNetwork.stationTypes[0].batteryBasis, battery);
    assert.equal(saved.context.stationNetwork.sites[0].siteConfirmed, false);
    assert.equal(saved.context.stationNetwork.powerSources[0].point.availableCapacityKw, 1000);
    assert.deepEqual(
      await save(request, path, saved, inputsOf(saved.context.stationNetwork)),
      saved,
    );
    const directory = application.directory;
    await application.stop();
    application = await startApplication({}, directory);
    assert.deepEqual((await request(path)).body, saved);
  } finally {
    await application.stop();
    await application.cleanup();
  }
});

async function confirmedNetwork(request, path, initial, powers, count = 2) {
  let saved = await save(request, path, initial, {
    ...emptyNetwork(),
    stationTypes: [stationType()],
    sites: Array.from({ length: count }, (_, index) =>
      site(`新建候选 ${index + 1}`, 121.47 + index / 100),
    ),
    powerSources: powers.points.map((point) => ({ sourcePointId: point.id })),
  });
  const configured = inputsOf(saved.context.stationNetwork);
  configured.sites = configured.sites.map((entry) => ({
    ...entry,
    siteConfirmed: true,
    connection: {
      powerSourceId: saved.context.stationNetwork.powerSources[0].id,
      availablePowerKw: 800,
      connectionInvestment: null,
      notes: '已核对场地至电源工程条件',
      confirmed: true,
    },
  }));
  saved = await save(request, path, saved, configured);
  assert.ok(
    saved.context.stationNetwork.sites.every(
      (entry) => entry.siteConfirmed && !entry.connection.confirmed,
    ),
    'new connection requires a separate explicit confirmation',
  );
  const confirming = inputsOf(saved.context.stationNetwork);
  confirming.sites.forEach((entry) => {
    entry.connection.confirmed = true;
  });
  confirming.fixedLayout = confirming.sites.map((entry) => ({
    siteId: entry.id,
    stationTypeId: confirming.stationTypes[0].id,
  }));
  saved = await save(request, path, saved, confirming);
  assert.ok(saved.context.stationNetwork.sites.every((entry) => entry.connection.confirmed));
  return saved;
}

test('twenty selected new stations can share one adopted source without inventing prices or capacity validation', async () => {
  let application = await startApplication();
  const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);
  try {
    const { path, resourcePath, scenario, powers: initialPowers } = await setup(request);
    const first = initialPowers.points[0];
    const powers = (
      await request(resourcePath, 'PUT', {
        expectedRevision: initialPowers.revision,
        points: Array.from({ length: 20 }, (_, index) => ({
          ...(index === 0 ? { id: first.id } : {}),
          name: `电源 ${index + 1}`,
          longitude: 121.5 + index / 100,
          latitude: 31.2,
          coordinateSystem: 'GCJ-02',
          availableCapacityKw: 1000,
          capacitySource: '供电答复',
          connectionNotes: '站址关系另行确认',
        })),
      })
    ).body;
    const saved = await confirmedNetwork(request, path, scenario, powers, 20);
    assert.equal(saved.context.stationNetwork.fixedLayout.length, 20);
    assert.equal(saved.context.stationNetwork.powerSources.length, 20);
    assert.equal(
      new Set(saved.context.stationNetwork.sites.map((entry) => entry.connection.powerSourceId))
        .size,
      1,
    );
    assert.equal(saved.context.stationNetwork.sites[0].connection.availablePowerKw, 800);
    assert.equal(saved.context.stationNetwork.sites[19].connection.availablePowerKw, 800);
    assert.equal(saved.context.stationNetwork.stationTypes[0].investment, null);
    assert.equal(saved.context.stationNetwork.sites[0].connection.connectionInvestment, null);
    assert.deepEqual(
      await save(request, path, saved, inputsOf(saved.context.stationNetwork)),
      saved,
    );
    const directory = application.directory;
    await application.stop();
    application = await startApplication({}, directory);
    assert.deepEqual((await request(path)).body, saved);
  } finally {
    await application.stop();
    await application.cleanup();
  }
});

test('site and supply edits invalidate only relevant confirmations and shared source changes require explicit adoption', async () => {
  const application = await startApplication();
  const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);
  try {
    const { path, resourcePath, scenario, powers } = await setup(request);
    let saved = await confirmedNetwork(request, path, scenario, powers);
    for (const change of [
      (network) => {
        network.sites[0].longitude = 121.49;
      },
      (network) => {
        network.sites[0].siteNotes = '修订场地条件';
      },
      (network) => {
        network.sites[0].connection.availablePowerKw = 700;
      },
      (network) => {
        network.sites[0].connection.connectionInvestment = 50000;
      },
      (network) => {
        network.sites[0].connection.notes = '修订接电工程依据';
      },
    ]) {
      const input = inputsOf(saved.context.stationNetwork);
      change(input);
      input.sites[0].siteConfirmed = true;
      input.sites[0].connection.confirmed = true;
      saved = await save(request, path, saved, input);
      assert.equal(
        saved.context.stationNetwork.sites[0].connection.confirmed,
        false,
        'editing and confirming in the same request cannot bypass invalidation',
      );
      assert.equal(saved.context.stationNetwork.sites[1].connection.confirmed, true);
      assert.equal(
        saved.context.stationNetwork.fixedLayout.length,
        2,
        'invalidated choices remain visible for repair',
      );
      const confirmed = inputsOf(saved.context.stationNetwork);
      confirmed.sites[0].siteConfirmed = true;
      confirmed.sites[0].connection.confirmed = true;
      saved = await save(request, path, saved, confirmed);
      assert.equal(saved.context.stationNetwork.sites[0].siteConfirmed, true);
      assert.equal(saved.context.stationNetwork.sites[0].connection.confirmed, true);
    }
    const source = saved.context.stationNetwork.powerSources[0];
    const current = powers.points[0];
    const projectInput = {
      id: current.id,
      name: current.name,
      longitude: current.originalLongitude,
      latitude: current.originalLatitude,
      coordinateSystem: current.coordinateSystem,
      availableCapacityKw: 900,
      capacitySource: current.capacitySource,
      connectionNotes: current.connectionNotes,
    };
    let updatedPowers = (
      await request(resourcePath, 'PUT', {
        expectedRevision: powers.revision,
        points: [projectInput],
      })
    ).body;
    assert.deepEqual(
      (await request(path)).body,
      saved,
      'project source edits never rewrite adopted scenario snapshot',
    );
    const refresh = inputsOf(saved.context.stationNetwork);
    refresh.powerSources[0].refreshSource = true;
    refresh.sites.forEach((entry) => {
      entry.connection.confirmed = true;
    });
    saved = await save(request, path, saved, refresh);
    assert.equal(saved.context.stationNetwork.powerSources[0].point.availableCapacityKw, 900);
    assert.ok(saved.context.stationNetwork.sites.every((entry) => !entry.connection.confirmed));
    const reconfirm = inputsOf(saved.context.stationNetwork);
    reconfirm.sites.forEach((entry) => {
      entry.connection.confirmed = true;
    });
    saved = await save(request, path, saved, reconfirm);
    const unrelated = { ...projectInput, name: '另一个无关电源' };
    delete unrelated.id;
    updatedPowers = (
      await request(resourcePath, 'PUT', {
        expectedRevision: updatedPowers.revision,
        points: [projectInput, unrelated],
      })
    ).body;
    const noSourceChange = inputsOf(saved.context.stationNetwork);
    noSourceChange.powerSources[0].refreshSource = true;
    saved = await save(request, path, saved, noSourceChange);
    assert.ok(
      saved.context.stationNetwork.sites.every((entry) => entry.connection.confirmed),
      'unrelated resource revisions do not invalidate unchanged adopted point',
    );
    const localEdit = inputsOf(saved.context.stationNetwork);
    localEdit.powerSources[0].point = {
      ...projectInput,
      availableCapacityKw: 850,
      name: '方案内电源依据',
    };
    delete localEdit.powerSources[0].point.id;
    saved = await save(request, path, saved, localEdit);
    assert.ok(saved.context.stationNetwork.sites.every((entry) => !entry.connection.confirmed));
    assert.equal(
      (await request(resourcePath)).body.points[0].name,
      current.name,
      'scenario editing never rewrites project resource',
    );
    assert.equal(
      (await request(resourcePath, 'PUT', { expectedRevision: updatedPowers.revision, points: [] }))
        .status,
      200,
    );
    assert.deepEqual((await request(path)).body, saved);
    assert.deepEqual(
      await save(request, path, saved, inputsOf(saved.context.stationNetwork)),
      saved,
    );
    const missingRefresh = inputsOf(saved.context.stationNetwork);
    missingRefresh.powerSources[0].refreshSource = true;
    assert.equal(
      (
        await request(`${path}/station-network`, 'PUT', {
          expectedRevision: saved.revision,
          network: missingRefresh,
        })
      ).status,
      404,
    );
    assert.deepEqual((await request(path)).body, saved, 'deleted source refresh fails atomically');
    assert.equal(source.sourcePointId, current.id);
  } finally {
    await application.stop();
    await application.cleanup();
  }
});

test('duplicate adoption cannot turn one project power point into multiple independent scenario sources', async () => {
  const application = await startApplication();
  const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);
  try {
    const { path, scenario, powers } = await setup(request);
    const response = await request(`${path}/station-network`, 'PUT', {
      expectedRevision: scenario.revision,
      network: {
        ...emptyNetwork(),
        powerSources: [
          { sourcePointId: powers.points[0].id },
          { sourcePointId: powers.points[0].id },
        ],
      },
    });
    assert.equal(response.status, 400);
    assert.deepEqual((await request(path)).body, scenario);
  } finally {
    await application.stop();
    await application.cleanup();
  }
});

test('refreshing a locally edited snapshot checks the source revision after delayed coordinate conversion', async () => {
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const upstream = createServer(async (_request, response) => {
    markStarted();
    await gate;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ status: '1', locations: '121.476,31.236' }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const application = await startApplication({
    HAULPATH_TEST_MODE: '1',
    AMAP_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
    AMAP_WEB_SERVICE_KEY: 'station-race-test-key',
  });
  const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);
  try {
    const { path, resourcePath, scenario, powers } = await setup(request);
    let saved = await save(request, path, scenario, {
      ...emptyNetwork(),
      powerSources: [{ sourcePointId: powers.points[0].id }],
    });
    const point = powers.points[0];
    const original = {
      name: point.name,
      longitude: point.originalLongitude,
      latitude: point.originalLatitude,
      coordinateSystem: point.coordinateSystem,
      availableCapacityKw: point.availableCapacityKw,
      capacitySource: point.capacitySource,
      connectionNotes: point.connectionNotes,
    };
    const edit = inputsOf(saved.context.stationNetwork);
    edit.powerSources[0].point = { ...original, availableCapacityKw: 800 };
    saved = await save(request, path, saved, edit);
    assert.equal(saved.context.stationNetwork.powerSources[0].sourceRevision, powers.revision);
    const refreshing = inputsOf(saved.context.stationNetwork);
    refreshing.powerSources[0].refreshSource = true;
    refreshing.sites = [{ ...site('延迟转换站址'), coordinateSystem: 'WGS84' }];
    const pending = request(`${path}/station-network`, 'PUT', {
      expectedRevision: saved.revision,
      network: refreshing,
    });
    await Promise.race([
      started,
      pending.then((result) => {
        throw new Error(
          `conversion finished before controlled boundary: ${JSON.stringify(result)}`,
        );
      }),
    ]);
    const changed = await request(resourcePath, 'PUT', {
      expectedRevision: powers.revision,
      points: [{ ...original, id: point.id, availableCapacityKw: 700 }],
    });
    assert.equal(changed.status, 200);
    release();
    assert.equal(
      (await pending).status,
      409,
      'an explicit refresh must recheck its project revision even if prior snapshot sourceRevision was identical',
    );
    assert.deepEqual((await request(path)).body, saved);
  } finally {
    release();
    await application.stop();
    await application.cleanup();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test('station writes reject invalid and foreign associations atomically and preserve scenario revision protection', async () => {
  const application = await startApplication();
  const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);
  try {
    const { path, scenario, powers } = await setup(request);
    const foreign = await setup(request, '其他项目');
    const saved = await confirmedNetwork(request, path, scenario, powers);
    const valid = inputsOf(saved.context.stationNetwork);
    const invalidNetworks = [
      { ...valid, stationTypes: [{ ...valid.stationTypes[0], bays: -1 }] },
      { ...valid, stationTypes: [{ ...valid.stationTypes[0], bays: 1.5 }] },
      { ...valid, stationTypes: [{ ...valid.stationTypes[0], swapMinutes: 0 }] },
      { ...valid, stationTypes: [{ ...valid.stationTypes[0], batteryInventory: -1 }] },
      { ...valid, stationTypes: [{ ...valid.stationTypes[0], chargingSlots: '4' }] },
      { ...valid, stationTypes: [{ ...valid.stationTypes[0], investment: -1 }] },
      { ...valid, stationTypes: [{ ...valid.stationTypes[0], batteryBasis: battery }] },
      {
        ...valid,
        stationTypes: [
          {
            ...valid.stationTypes[0],
            serviceWindows: [
              { startMinute: 1320, endMinute: 1560 },
              { startMinute: 60, endMinute: 180 },
            ],
          },
        ],
      },
      {
        ...valid,
        stationTypes: [
          { ...valid.stationTypes[0], chargeWindows: [{ startMinute: 1440, endMinute: 1500 }] },
        ],
      },
      { ...valid, stationTypes: [valid.stationTypes[0], valid.stationTypes[0]] },
      { ...valid, sites: [{ ...valid.sites[0], id: 'unowned-site' }] },
      { ...valid, sites: [{ ...valid.sites[0], latitude: 91 }] },
      { ...valid, sites: [{ ...valid.sites[0], coordinateSystem: 'unknown' }] },
      { ...valid, sites: [{ ...valid.sites[0], originalLongitude: 121.4 }] },
      { ...valid, sites: [{ ...valid.sites[0], siteConfirmed: 'true' }] },
      {
        ...valid,
        sites: [
          {
            ...valid.sites[0],
            connection: { ...valid.sites[0].connection, powerSourceId: 'foreign-power' },
          },
        ],
      },
      {
        ...valid,
        sites: [
          {
            ...valid.sites[0],
            connection: { ...valid.sites[0].connection, connectionInvestment: -1 },
          },
        ],
      },
      { ...valid, sites: [valid.sites[0], valid.sites[0]] },
      { ...valid, powerSources: [{ ...valid.powerSources[0], id: 'foreign-source' }] },
      {
        ...valid,
        powerSources: [{ ...valid.powerSources[0], sourcePointId: foreign.powers.points[0].id }],
      },
      { ...valid, fixedLayout: [valid.fixedLayout[0], valid.fixedLayout[0]] },
      { ...valid, fixedLayout: [{ ...valid.fixedLayout[0], siteId: 'foreign-site' }] },
      { ...valid, fixedLayout: [{ ...valid.fixedLayout[0], stationTypeId: 'foreign-type' }] },
      { ...valid, powerSources: valid.powerSources, existingStations: [] },
    ];
    for (const network of invalidNetworks) {
      const response = await request(`${path}/station-network`, 'PUT', {
        expectedRevision: saved.revision,
        network,
      });
      assert.equal(response.status, 400, JSON.stringify(network));
      assert.deepEqual((await request(path)).body, saved);
    }
    assert.equal(
      (
        await request(`${path}/station-network`, 'PUT', {
          expectedRevision: saved.revision,
          network: { ...valid, powerSources: [{ sourcePointId: foreign.powers.points[0].id }] },
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await request(`${path}/station-network`, 'PUT', {
          expectedRevision: saved.revision - 1,
          network: valid,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await request(
          `/api/projects/${foreign.project.id}/scenarios/${saved.id}/station-network`,
          'PUT',
          { expectedRevision: saved.revision, network: valid },
        )
      ).status,
      404,
    );
    for (const stationNetwork of [
      undefined,
      null,
      { ...saved.context.stationNetwork, fixedLayout: [] },
    ]) {
      assert.equal(
        (
          await request(path, 'PATCH', {
            expectedRevision: saved.revision,
            context: { ...saved.context, stationNetwork },
          })
        ).status,
        400,
      );
      assert.deepEqual((await request(path)).body, saved);
    }
    const draft = inputsOf(saved.context.stationNetwork);
    draft.sites[0].siteConfirmed = false;
    draft.fixedLayout = [];
    const unconfirmed = await save(request, path, saved, draft);
    draft.fixedLayout = valid.fixedLayout;
    assert.equal(
      (
        await request(`${path}/station-network`, 'PUT', {
          expectedRevision: unconfirmed.revision,
          network: draft,
        })
      ).status,
      400,
    );
    assert.deepEqual((await request(path)).body, unconfirmed);
    const race = await Promise.all(
      ['现场记录甲', '现场记录乙'].map((siteNotes) =>
        request(`${path}/station-network`, 'PUT', {
          expectedRevision: unconfirmed.revision,
          network: { ...draft, fixedLayout: [], sites: [{ ...draft.sites[0], siteNotes }] },
        }),
      ),
    );
    assert.deepEqual(race.map((response) => response.status).sort(), [200, 409]);
    assert.deepEqual(
      (await request(path)).body,
      race.find((response) => response.status === 200).body,
    );
  } finally {
    await application.stop();
    await application.cleanup();
  }
});

test('battery changes require an explicit station-type reassociation and deleted references never silently rebind by name', async () => {
  const application = await startApplication();
  const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);
  try {
    const { path, scenario, powers } = await setup(request);
    let saved = await confirmedNetwork(request, path, scenario, powers);
    const withoutLayout = inputsOf(saved.context.stationNetwork);
    withoutLayout.fixedLayout = [];
    saved = await save(request, path, saved, withoutLayout);
    saved = (
      await request(`${path}/operations`, 'PUT', {
        expectedRevision: saved.revision,
        operations: {
          battery: { ...battery, capacityKwh: 400 },
          vehicleGroups: [],
          measuredSegments: [],
        },
      })
    ).body;
    assert.equal(saved.context.stationNetwork.stationTypes[0].batteryBasis.capacityKwh, 300);
    const selecting = inputsOf(saved.context.stationNetwork);
    selecting.fixedLayout = selecting.sites.map((entry) => ({
      siteId: entry.id,
      stationTypeId: selecting.stationTypes[0].id,
    }));
    assert.equal(
      (
        await request(`${path}/station-network`, 'PUT', {
          expectedRevision: saved.revision,
          network: selecting,
        })
      ).status,
      400,
    );
    selecting.stationTypes[0].refreshBattery = true;
    saved = await save(request, path, saved, selecting);
    assert.equal(saved.context.stationNetwork.stationTypes[0].batteryBasis.capacityKwh, 400);
    const oldTypeId = saved.context.stationNetwork.stationTypes[0].id;
    const deleting = inputsOf(saved.context.stationNetwork);
    deleting.stationTypes = [];
    deleting.powerSources = [];
    saved = await save(request, path, saved, deleting);
    assert.equal(saved.context.stationNetwork.fixedLayout[0].stationTypeId, oldTypeId);
    assert.ok(saved.context.stationNetwork.sites.every((entry) => !entry.connection.confirmed));
    const sameName = inputsOf(saved.context.stationNetwork);
    sameName.stationTypes = [stationType()];
    saved = await save(request, path, saved, sameName);
    assert.notEqual(saved.context.stationNetwork.stationTypes[0].id, oldTypeId);
    assert.equal(saved.context.stationNetwork.fixedLayout[0].stationTypeId, oldTypeId);
  } finally {
    await application.stop();
    await application.cleanup();
  }
});

test('station original WGS84 coordinates normalize once and conversion failures cannot partly save a network', async () => {
  let fail = false;
  const conversions = [];
  const upstream = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    conversions.push(url);
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify(
        fail
          ? { status: '0', info: 'station conversion unavailable' }
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
  let application = await startApplication({
    HAULPATH_TEST_MODE: '1',
    AMAP_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
    AMAP_WEB_SERVICE_KEY: 'station-coordinate-test-key',
  });
  const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);
  try {
    const { path, scenario, powers } = await setup(request);
    let saved = await save(request, path, scenario, {
      ...emptyNetwork(),
      sites: [{ ...site('GPS站址'), coordinateSystem: 'WGS84' }],
      powerSources: [{ sourcePointId: powers.points[0].id }],
    });
    const point = saved.context.stationNetwork.sites[0];
    assert.equal(point.longitude, 121.476);
    assert.equal(point.latitude, 31.236);
    assert.equal(point.originalLongitude, 121.47);
    assert.equal(point.originalLatitude, 31.23);
    assert.equal(point.coordinateSystem, 'WGS84');
    assert.equal(conversions[0].pathname, '/v3/assistant/coordinate/convert');
    assert.equal(conversions[0].searchParams.get('coordsys'), 'gps');
    fail = true;
    const invalid = inputsOf(saved.context.stationNetwork);
    invalid.sites.push(site('有效GCJ新点'), { ...site('失败GPS新点'), coordinateSystem: 'WGS84' });
    assert.equal(
      (
        await request(`${path}/station-network`, 'PUT', {
          expectedRevision: saved.revision,
          network: invalid,
        })
      ).status,
      502,
    );
    assert.deepEqual((await request(path)).body, saved);
    const conversionsBeforeRestart = conversions.length;
    const directory = application.directory;
    await application.stop();
    application = await startApplication(
      { AMAP_WEB_SERVICE_KEY: '', AMAP_JS_KEY: '', AMAP_JS_SECURITY_CODE: '' },
      directory,
    );
    const editing = inputsOf(saved.context.stationNetwork);
    editing.sites[0].siteNotes = '只改场地依据无需再次转换';
    saved = await save(request, path, saved, editing);
    assert.equal(saved.context.stationNetwork.sites[0].longitude, 121.476);
    assert.equal(conversions.length, conversionsBeforeRestart);
    editing.sites[0].longitude = 121.48;
    assert.equal(
      (
        await request(`${path}/station-network`, 'PUT', {
          expectedRevision: saved.revision,
          network: editing,
        })
      ).status,
      503,
    );
    assert.deepEqual((await request(path)).body, saved);
  } finally {
    await application.stop();
    await application.cleanup();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test('generate preliminary candidates from imported business locations and adopted power without roads, preserving edits on repeat', async () => {
  const application = await startApplication();
  const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);
  try {
    const { project, path, scenario, powers } = await setup(request);
    const route = (
      await request(`/api/projects/${project.id}/routes`, 'POST', {
        name: '候选依据线路',
        points: [
          {
            ...site('装货场', 121.47),
            id: 'a',
            originalLongitude: 121.47,
            originalLatitude: 31.23,
          },
          { ...site('卸货场', 121.6), id: 'b', originalLongitude: 121.6, originalLatitude: 31.23 },
          {
            ...site('回程装货场', 121.47),
            id: 'c',
            originalLongitude: 121.47,
            originalLatitude: 31.23,
          },
        ],
      })
    ).body;
    let saved = (
      await request(`${path}/cycles`, 'POST', {
        expectedRevision: scenario.revision,
        sourceRouteId: route.id,
      })
    ).body;
    saved = await save(request, path, saved, {
      ...emptyNetwork(),
      powerSources: [{ sourcePointId: powers.points[0].id }],
    });
    const generated = await request(`${path}/station-network`, 'POST', {
      expectedRevision: saved.revision,
    });
    assert.equal(generated.status, 200, JSON.stringify(generated.body));
    saved = generated.body;
    assert.equal(
      saved.context.stationNetwork.sites.length,
      3,
      'same exact location is proposed once',
    );
    assert.deepEqual(
      saved.context.stationNetwork.sites.map((s) => s.longitude),
      [121.47, 121.6, 121.5],
    );
    assert.ok(
      saved.context.stationNetwork.sites.every(
        (s) =>
          s.source === 'generated' &&
          s.generationBasis &&
          !s.siteConfirmed &&
          s.connection === null,
      ),
    );
    assert.equal(saved.context.stationNetwork.fixedLayout.length, 0);
    assert.equal(saved.context.transportCycles[0].roads.length, 0);
    // A later adopted source at an existing suggested location must become traceable too.
    const laterRoute = (
      await request(`/api/projects/${project.id}/routes`, 'POST', {
        name: '后来引入的同址业务',
        points: [
          {
            ...site('同址装货', 121.47),
            id: 'later',
            originalLongitude: 121.47,
            originalLatitude: 31.23,
          },
        ],
      })
    ).body;
    saved = (
      await request(`${path}/cycles`, 'POST', {
        expectedRevision: saved.revision,
        sourceRouteId: laterRoute.id,
      })
    ).body;
    saved = (await request(`${path}/station-network`, 'POST', { expectedRevision: saved.revision }))
      .body;
    assert.equal(saved.context.stationNetwork.sites.length, 3);
    assert.equal(saved.context.stationNetwork.sites[0].generationBasis.origins.length, 3);
    const edited = inputsOf(saved.context.stationNetwork);
    edited.sites[0].name = '人工修正名称';
    edited.sites[0].longitude = 121.48;
    saved = await save(request, path, saved, edited);
    assert.deepEqual(
      (await request(`${path}/station-network`, 'POST', { expectedRevision: saved.revision })).body,
      saved,
    );
    assert.equal(
      (await request(`${path}/station-network`, 'POST', { expectedRevision: 1 })).status,
      409,
    );
    assert.deepEqual((await request(path)).body, saved);
  } finally {
    await application.stop();
    await application.cleanup();
  }
});

test('hard siting constraints preserve zero limits, block missing budget prices and report saved layout conflicts through public readiness', async () => {
  const application = await startApplication();
  const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);
  try {
    const { path, scenario, powers } = await setup(request);
    let saved = await confirmedNetwork(request, path, scenario, powers);
    const constraints = {
      maxInvestment: 0,
      maxStations: null,
      requiredSiteIds: [],
      excludedSiteIds: [],
    };
    const missing = await request(`${path}/station-network`, 'PUT', {
      expectedRevision: saved.revision,
      network: { ...inputsOf(saved.context.stationNetwork), constraints },
    });
    assert.equal(missing.status, 400);
    assert.match(missing.body.error, /投资.*待填写|投资.*缺失/);
    assert.deepEqual((await request(path)).body, saved);
    const priced = inputsOf(saved.context.stationNetwork);
    priced.stationTypes[0].investment = 0;
    priced.sites.forEach((s) => {
      s.connection.connectionInvestment = 0;
    });
    saved = await save(request, path, saved, priced);
    const confirming = inputsOf(saved.context.stationNetwork);
    confirming.sites.forEach((s) => {
      s.connection.confirmed = true;
    });
    saved = await save(request, path, saved, { ...confirming, constraints });
    assert.equal(saved.context.stationNetwork.constraints.maxInvestment, 0);
    const [first, second] = saved.context.stationNetwork.sites;
    saved = await save(request, path, saved, {
      ...inputsOf(saved.context.stationNetwork),
      constraints: {
        ...constraints,
        maxStations: 0,
        requiredSiteIds: [first.id],
        excludedSiteIds: [second.id],
      },
    });
    let view = (await request(`${path}/daily-transport`)).body;
    assert.match(view.gaps.join('；'), /必选.*站数上限/);
    assert.match(view.gaps.join('；'), /固定布局.*站数上限/);
    assert.match(view.gaps.join('；'), /禁选/);
    const invalid = await request(`${path}/daily-transport`, 'POST', {
      expectedRevision: saved.revision,
      config: { stage: 'vehicle-energy' },
    });
    assert.equal(invalid.status, 400);
    assert.match(invalid.body.error, /站数上限/);
    // A deleted required identity remains explicit until the user removes the constraint.
    const removed = inputsOf(saved.context.stationNetwork);
    removed.sites = removed.sites.filter((s) => s.id !== first.id);
    removed.fixedLayout = [];
    saved = await save(request, path, saved, {
      ...removed,
      constraints: saved.context.stationNetwork.constraints,
    });
    view = (await request(`${path}/daily-transport`)).body;
    assert.match(view.gaps.join('；'), /必选站址.*已删除/);
  } finally {
    await application.stop();
    await application.cleanup();
  }
});

test('budget sums every station and connection in cents and rejects constraint and provenance bypasses atomically', async () => {
  const app = await startApplication();
  const request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
  try {
    const { path, scenario, powers } = await setup(request);
    let saved = await confirmedNetwork(request, path, scenario, powers);
    const priced = inputsOf(saved.context.stationNetwork);
    priced.stationTypes[0].investment = 1.005;
    priced.sites.forEach((s) => {
      s.connection.connectionInvestment = 0;
    });
    saved = await save(request, path, saved, priced);
    const confirmed = inputsOf(saved.context.stationNetwork);
    confirmed.sites.forEach((s) => {
      s.connection.confirmed = true;
    });
    const constraints = {
      maxInvestment: 2.02,
      maxStations: 2,
      requiredSiteIds: [],
      excludedSiteIds: [],
    };
    saved = await save(request, path, saved, { ...confirmed, constraints });
    assert.doesNotMatch(
      (await request(`${path}/daily-transport`)).body.gaps.join('；'),
      /投资.*超过上限/,
    );
    saved = await save(request, path, saved, {
      ...inputsOf(saved.context.stationNetwork),
      constraints: { ...constraints, maxInvestment: 2.01 },
    });
    assert.match(
      (await request(`${path}/daily-transport`)).body.gaps.join('；'),
      /总新增投资超过上限/,
    );
    const id = saved.context.stationNetwork.sites[0].id;
    for (const invalid of [
      { ...constraints, maxStations: -1 },
      { ...constraints, maxStations: 1.5 },
      { ...constraints, maxInvestment: -1 },
      { ...constraints, maxInvestment: '0' },
      { ...constraints, maxInvestment: 1e20 },
      { ...constraints, requiredSiteIds: [id, id] },
      { ...constraints, requiredSiteIds: ['foreign-id'] },
      { ...constraints, excludedSiteIds: ['foreign-id'] },
      { ...constraints, requiredSiteIds: [id], excludedSiteIds: [id] },
    ]) {
      const response = await request(`${path}/station-network`, 'PUT', {
        expectedRevision: saved.revision,
        network: { ...inputsOf(saved.context.stationNetwork), constraints: invalid },
      });
      assert.equal(response.status, 400, JSON.stringify(response));
      assert.deepEqual((await request(path)).body, saved);
    }
    const context = structuredClone(saved.context);
    context.stationNetwork.constraints.maxStations = null;
    assert.equal(
      (await request(path, 'PATCH', { expectedRevision: saved.revision, context })).status,
      400,
    );
    const forged = inputsOf(saved.context.stationNetwork);
    forged.sites[0].generationBasis = { algorithm: 'input-locations-v1', origins: [] };
    assert.equal(
      (
        await request(`${path}/station-network`, 'PUT', {
          expectedRevision: saved.revision,
          network: forged,
        })
      ).status,
      400,
    );
    const omitted = inputsOf(saved.context.stationNetwork);
    delete omitted.constraints;
    assert.deepEqual(
      await save(request, path, saved, omitted),
      saved,
      'omitting constraints cannot silently turn them off',
    );
    // Removing the retained layout is repair, but re-adoption must enforce the active budget.
    const removed = { ...inputsOf(saved.context.stationNetwork), fixedLayout: [] };
    const oldLayout = saved.context.stationNetwork.fixedLayout;
    saved = await save(request, path, saved, removed);
    const overBudget = await request(`${path}/station-network`, 'PUT', {
      expectedRevision: saved.revision,
      network: { ...inputsOf(saved.context.stationNetwork), fixedLayout: oldLayout },
    });
    assert.equal(overBudget.status, 400);
    assert.match(overBudget.body.error, /投资.*超过上限/);
  } finally {
    await app.stop();
    await app.cleanup();
  }
});

test('generated candidates and constraints survive restart, freezing, copying and input comparison without weakening write protection', async () => {
  let app = await startApplication();
  const request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
  try {
    const { project, path, scenario, powers } = await setup(request);
    assert.deepEqual(
      (await request(`${path}/station-network`, 'POST', { expectedRevision: scenario.revision }))
        .body,
      scenario,
      'empty generation is a no-op',
    );
    let saved = await save(request, path, scenario, {
      ...emptyNetwork(),
      powerSources: [{ sourcePointId: powers.points[0].id }],
    });
    saved = (await request(`${path}/station-network`, 'POST', { expectedRevision: saved.revision }))
      .body;
    const constraints = {
      maxInvestment: null,
      maxStations: 0,
      requiredSiteIds: [saved.context.stationNetwork.sites[0].id],
      excludedSiteIds: [],
    };
    saved = await save(request, path, saved, {
      ...inputsOf(saved.context.stationNetwork),
      constraints,
    });
    const directory = app.directory;
    await app.stop();
    app = await startApplication({}, directory);
    assert.deepEqual((await request(path)).body, saved);
    const frozen = (await request(`${path}/freeze`, 'POST', { expectedRevision: saved.revision }))
      .body;
    assert.equal(
      (await request(`${path}/station-network`, 'POST', { expectedRevision: frozen.revision }))
        .status,
      409,
    );
    assert.equal(
      (
        await request(`${path}/station-network`, 'PUT', {
          expectedRevision: frozen.revision,
          network: inputsOf(frozen.context.stationNetwork),
        })
      ).status,
      409,
    );
    const copied = (
      await request(`${path}/copy`, 'POST', {
        expectedRevision: frozen.revision,
        name: '约束调整副本',
      })
    ).body;
    assert.deepEqual(copied.context.stationNetwork, saved.context.stationNetwork);
    const comparePath = `/api/projects/${project.id}/scenarios/compare?left=${frozen.id}&right=${copied.id}`;
    assert.deepEqual((await request(comparePath)).body.differences, []);
    const copyPath = `/api/projects/${project.id}/scenarios/${copied.id}`;
    const changed = await save(request, copyPath, copied, {
      ...inputsOf(copied.context.stationNetwork),
      constraints: { ...constraints, maxStations: 1 },
    });
    assert.equal(changed.inputVersion, copied.inputVersion + 1);
    const diff = (await request(comparePath)).body.differences;
    assert.ok(
      diff.some((item) => item.path.includes('maxStations') && item.label.includes('新建站数上限')),
    );
    assert.deepEqual((await request(path)).body, frozen);
    const foreign = await setup(request, '生成跨项目检查');
    assert.equal(
      (
        await request(
          `/api/projects/${foreign.project.id}/scenarios/${frozen.id}/station-network`,
          'POST',
          { expectedRevision: frozen.revision },
        )
      ).status,
      404,
    );
  } finally {
    await app.stop();
    await app.cleanup();
  }
});

test('budget cannot be enabled when a retained fixed layout has deleted site or station type price references', async () => {
  const app = await startApplication();
  const request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
  try {
    const { path, scenario, powers } = await setup(request);
    let saved = await confirmedNetwork(request, path, scenario, powers);
    const lost = inputsOf(saved.context.stationNetwork);
    lost.sites = [];
    lost.stationTypes = [];
    saved = await save(request, path, saved, lost);
    assert.equal(saved.context.stationNetwork.fixedLayout.length, 2);
    const budget = await request(`${path}/station-network`, 'PUT', {
      expectedRevision: saved.revision,
      network: {
        ...inputsOf(saved.context.stationNetwork),
        constraints: {
          maxInvestment: 1,
          maxStations: null,
          requiredSiteIds: [],
          excludedSiteIds: [],
        },
      },
    });
    assert.equal(budget.status, 400);
    assert.match(budget.body.error, /固定布局.*已删除.*投资/);
    assert.deepEqual((await request(path)).body, saved);
  } finally {
    await app.stop();
    await app.cleanup();
  }
});
