import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { configureDailyTransportLayout } from './daily-transport-fixture.mjs';
import { roadPoint, roadResponse, waitRoadTask } from './directed-road-fixture.mjs';
import { jsonRequest, startApplication } from './application.mjs';

const baseLongitude = 121.41;
const baseStopLongitude = 121.42;
const loadingLongitude = 121.43;
const unloadingLongitude = 121.44;
const stationLongitude = 122.15;

export async function startVehicleEnergyApplication(t, { mode = 'dev', extraDistances = [] } = {}) {
  const distances = new Map([
    [`${baseLongitude}:${loadingLongitude}`, 11000],
    [`${loadingLongitude}:${baseLongitude}`, 13000],
    [`${loadingLongitude}:${unloadingLongitude}`, 135000],
    [`${unloadingLongitude}:${loadingLongitude}`, 22000],
    [`${loadingLongitude}:${stationLongitude}`, 60000],
    [`${stationLongitude}:${unloadingLongitude}`, 80000],
    [`${unloadingLongitude}:${stationLongitude}`, 94000],
    [`${stationLongitude}:${loadingLongitude}`, 92000],
    ...extraDistances,
  ]);
  const upstream = createServer((incoming, response) => {
    const url = new URL(incoming.url, 'http://127.0.0.1');
    const longitude = (key) => Number(url.searchParams.get(key).split(',')[0]);
    const pair = `${longitude('origin')}:${longitude('destination')}`;
    roadResponse(url, response, String(distances.get(pair) ?? 10000));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  });
  const app = await startApplication(
    {
      AMAP_JS_KEY: '',
      AMAP_JS_SECURITY_CODE: '',
      HAULPATH_TEST_MODE: '1',
      AMAP_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
      AMAP_WEB_SERVICE_KEY: 'vehicle-energy-test',
    },
    undefined,
    { mode },
  );
  t.after(async () => {
    await app.stop();
    await app.cleanup();
  });
  return { app, request: (path, method, body) => jsonRequest(app.baseUrl, path, method, body) };
}

export async function vehicleEnergyFixture(request) {
  const project = (await request('/api/projects', 'POST', { name: '逐车电量手算验收' })).body;
  const projectPath = `/api/projects/${project.id}`;
  const collection = `${projectPath}/scenarios`;
  let scenario = (await request(collection, 'POST', { name: '有向绕行换电方案' })).body;
  const path = `${collection}/${scenario.id}`;
  async function save(suffix, method, body) {
    const response = await request(`${path}${suffix}`, method, {
      expectedRevision: scenario.revision,
      ...body,
    });
    assert.ok([200, 201].includes(response.status), JSON.stringify(response));
    scenario = response.body;
    return scenario;
  }
  for (const [name, start, stop] of [
    ['基准循环', ['车场', baseLongitude], ['基准点', baseStopLongitude]],
    ['港区循环', ['装货港', loadingLongitude], ['卸货场', unloadingLongitude]],
  ]) {
    const route = (
      await request(`${projectPath}/routes`, 'POST', {
        name,
        points: [
          roadPoint('from', ...start),
          roadPoint('to', ...stop),
          roadPoint('return', ...start),
        ],
      })
    ).body;
    await save('/cycles', 'POST', { sourceRouteId: route.id });
    await save(`/cycles/${scenario.context.transportCycles.at(-1).id}`, 'PATCH', {
      confirmed: true,
    });
  }
  const [baseCycle, cycle] = scenario.context.transportCycles;
  await save('/demands', 'PUT', {
    demands: [
      {
        cycleId: cycle.id,
        loadingPositionId: cycle.positions[0].id,
        unloadingPositionId: cycle.positions[1].id,
        dailyTonnes: 10,
      },
    ],
  });
  const group = {
    name: '十吨车',
    count: 1,
    baseCycleId: baseCycle.id,
    baseStartPositionId: baseCycle.positions[0].id,
    payloadTonnes: 10,
    speedKph: 60,
    emptyKwhPerKm: 1,
    fullKwhPerKm: 2,
    safetySocPercent: 20,
    shifts: [{ startMinute: 480, endMinute: 680 }],
    loadingMinutes: 5,
    unloadingMinutes: 5,
    source: '独立手算算例',
  };
  await save('/operations', 'PUT', {
    operations: {
      battery: {
        capacityKwh: 300,
        chargePowerKw: 120,
        chargeEfficiency: 0.9,
        source: '验收布站电池台账',
      },
      vehicleGroups: [group],
      measuredSegments: [],
    },
  });
  const vehicleGroupId = scenario.context.operations.vehicleGroups[0].id;
  await save('/operations', 'PUT', {
    operations: {
      battery: scenario.context.operations.battery,
      vehicleGroups: [{ ...group, id: vehicleGroupId }],
      measuredSegments: [
        {
          vehicleGroupId,
          cycleId: cycle.id,
          fromPositionId: cycle.positions[0].id,
          toPositionId: cycle.positions[1].id,
          durationMinutes: 136,
          emptyKwh: 125,
          fullKwh: 275,
          source: '正向直达实测',
        },
        {
          vehicleGroupId,
          cycleId: cycle.id,
          fromPositionId: cycle.positions[1].id,
          toPositionId: cycle.positions[2].id,
          durationMinutes: 15,
          emptyKwh: 37,
          fullKwh: 81,
          source: '反向直达实测',
        },
      ],
    },
  });
  scenario = await configureDailyTransportLayout(request, scenario);

  return {
    project,
    cycle,
    path,
    collection,
    save,
    get scenario() {
      return scenario;
    },
    async prepare() {
      const response = await request(`${path}/roads`, 'POST', {
        expectedRevision: scenario.revision,
      });
      assert.equal(response.status, 202, JSON.stringify(response.body));
      await waitRoadTask(request, path, response.body.task.taskId, 'completed');
    },
  };
}
