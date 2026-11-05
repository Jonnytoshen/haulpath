import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { roadPoint, waitRoadTask } from './directed-road-fixture.mjs';

export const stationNetworkInputs = (network) => ({
  stationTypes: network.stationTypes.map(({ batteryBasis, ...input }) => {
    void batteryBasis;
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

/** Select one independently confirmed station through public APIs, then restore the supplied operations. */
export async function configureDailyTransportLayout(request, initial, { beforeSelection } = {}) {
  const projectPath = `/api/projects/${initial.projectId}`;
  const path = `${projectPath}/scenarios/${initial.id}`;
  let scenario = initial;
  const save = async (suffix, body) => {
    const response = await request(`${path}${suffix}`, 'PUT', {
      expectedRevision: scenario.revision,
      ...body,
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    scenario = response.body;
  };
  const originalOperations = operationInputs(initial.context.operations);
  // The station editor requires a complete battery basis to make the initial selection.
  // Restore the transportation example's own battery data after that selection is saved.
  await save('/operations', {
    operations: {
      ...originalOperations,
      battery: {
        capacityKwh: 300,
        chargePowerKw: 120,
        chargeEfficiency: 0.9,
        source: '验收布站电池台账',
      },
    },
  });
  const power = await request(`${projectPath}/power-connection-points`, 'PUT', {
    expectedRevision: 1,
    points: [
      {
        name: '验收电源',
        longitude: 122.1,
        latitude: 31.2,
        coordinateSystem: 'GCJ-02',
        availableCapacityKw: 1000,
        capacitySource: '验收供电答复',
        connectionNotes: '独立于候选站址的电源接入位置',
      },
    ],
  });
  assert.equal(power.status, 200, JSON.stringify(power.body));
  await save('/station-network', {
    network: {
      stationTypes: [
        {
          name: '验收站型',
          bays: 2,
          swapMinutes: 6,
          batteryInventory: 8,
          chargingSlots: 4,
          chargePowerKw: 120,
          serviceWindows: [{ startMinute: 0, endMinute: 1440 }],
          chargeWindows: [{ startMinute: 0, endMinute: 1440 }],
          investment: null,
          annualOperatingCost: null,
          source: '验收设备清单',
        },
      ],
      sites: [
        {
          name: '人工确认换电站',
          longitude: 122.15,
          latitude: 31.24,
          coordinateSystem: 'GCJ-02',
          source: 'manual',
          siteNotes: '验收现场踏勘依据',
          siteConfirmed: false,
          connection: null,
        },
      ],
      powerSources: [{ sourcePointId: power.body.points[0].id }],
      fixedLayout: [],
    },
  });
  let network = stationNetworkInputs(scenario.context.stationNetwork);
  network.sites[0] = {
    ...network.sites[0],
    siteConfirmed: true,
    connection: {
      powerSourceId: network.powerSources[0].id,
      availablePowerKw: 800,
      connectionInvestment: null,
      notes: '验收场地接电核对',
      confirmed: false,
    },
  };
  await save('/station-network', { network });
  network = stationNetworkInputs(scenario.context.stationNetwork);
  network.sites[0].connection.confirmed = true;
  await save('/station-network', { network });
  await beforeSelection?.(scenario, path);
  network = stationNetworkInputs(scenario.context.stationNetwork);
  network.fixedLayout = [
    { siteId: network.sites[0].id, stationTypeId: network.stationTypes[0].id },
  ];
  await save('/station-network', { network });
  await save('/operations', { operations: originalOperations });
  assert.equal(scenario.context.stationNetwork.fixedLayout.length, 1);
  assert.equal(scenario.context.stationNetwork.sites[0].connection.confirmed, true);
  return scenario;
}

/** Independent example: two 10 km legs at 30 km/h plus 5 min loading/unloading = 50 min/trip. */
export async function dailyTransportFixture(
  request,
  { tonnes = 25, endMinute = 660, count = 1, name = '逐车运输验收' } = {},
) {
  const project = (await request('/api/projects', 'POST', { name })).body;
  const route = (
    await request(`/api/projects/${project.id}/routes`, 'POST', {
      name: '港区往返',
      points: [
        roadPoint('a', '港区', 121.47),
        roadPoint('b', '堆场', 121.6),
        roadPoint('a-return', '港区返回', 121.47),
      ],
    })
  ).body;
  let scenario = (
    await request(`/api/projects/${project.id}/scenarios`, 'POST', { name: '运输日计划方案' })
  ).body;
  const path = `/api/projects/${project.id}/scenarios/${scenario.id}`;
  async function save(suffix, method, body) {
    const response = await request(`${path}${suffix}`, method, {
      expectedRevision: scenario.revision,
      ...body,
    });
    assert.ok([200, 201, 202].includes(response.status), JSON.stringify(response));
    scenario = response.body;
    return scenario;
  }
  await save('/cycles', 'POST', { sourceRouteId: route.id });
  const cycleId = scenario.context.transportCycles[0].id;
  await save(`/cycles/${cycleId}`, 'PATCH', { confirmed: true });
  const cycle = scenario.context.transportCycles[0];
  await save('/demands', 'PUT', {
    demands: [
      {
        cycleId,
        loadingPositionId: cycle.positions[0].id,
        unloadingPositionId: cycle.positions[1].id,
        dailyTonnes: tonnes,
      },
    ],
  });
  await save('/operations', 'PUT', {
    operations: {
      battery: null,
      measuredSegments: [],
      vehicleGroups: [
        {
          name: '十吨车',
          count,
          baseCycleId: cycleId,
          baseStartPositionId: cycle.positions[0].id,
          payloadTonnes: 10,
          speedKph: 30,
          emptyKwhPerKm: null,
          fullKwhPerKm: null,
          safetySocPercent: null,
          shifts: [{ startMinute: 480, endMinute }],
          loadingMinutes: 5,
          unloadingMinutes: 5,
          source: '独立手算算例',
        },
      ],
    },
  });
  scenario = await configureDailyTransportLayout(request, scenario);
  const prepared = await request(`${path}/roads`, 'POST', { expectedRevision: scenario.revision });
  assert.equal(prepared.status, 202, JSON.stringify(prepared.body));
  await waitRoadTask(request, path, prepared.body.task.taskId, 'completed');
  return { project, route, scenario, cycle, path };
}

export async function waitDailyTransportTask(request, path, taskId, expectedStatus = 'completed') {
  for (let attempt = 0; attempt < 300; attempt++) {
    const response = await request(`${path}/daily-transport/${taskId}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    if (!['queued', 'running'].includes(response.body.status)) {
      if (expectedStatus)
        assert.equal(response.body.status, expectedStatus, JSON.stringify(response.body));
      return response.body;
    }
    await delay(50);
  }
  assert.fail('运输任务未在等待期限内结束');
}

export const operationInputs = (operations) => ({
  battery: operations.battery,
  vehicleGroups: operations.vehicleGroups.map(({ vehicleIds, baseStartBasis, ...input }) => {
    void vehicleIds;
    void baseStartBasis;
    return input;
  }),
  measuredSegments: operations.measuredSegments.map(({ basis, ...input }) => {
    void basis;
    return input;
  }),
});

/** Bounded cancellation workload: deliberately declared fast speed and zero handling, never production defaults. */
export async function makeLongTransportWorkload(request, fixture) {
  const operations = operationInputs(fixture.scenario.context.operations);
  operations.vehicleGroups[0] = {
    ...operations.vehicleGroups[0],
    count: 50,
    speedKph: 60000,
    loadingMinutes: 0,
    unloadingMinutes: 0,
  };
  const saved = await request(`${fixture.path}/operations`, 'PUT', {
    expectedRevision: fixture.scenario.revision,
    operations,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  fixture.scenario = saved.body;
  const ready = await request(`${fixture.path}/roads`, 'POST', {
    expectedRevision: fixture.scenario.revision,
  });
  await waitRoadTask(request, fixture.path, ready.body.task.taskId, 'completed');
  return fixture;
}
