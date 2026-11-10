import assert from 'node:assert/strict';
import { stationTurnoverFixture } from './station-turnover-fixture.mjs';
import {
  operationInputs,
  stationNetworkInputs,
  waitDailyTransportTask,
} from './daily-transport-fixture.mjs';
import { roadPoint } from './directed-road-fixture.mjs';

// A second independent business cycle has the same hand-calculated travel/energy as the first.
// Cross-station approaches are 1000 km, preventing an energy-feasible visit to the other site.
export const sharedPowerDistances = [
  ['121.41:121.53', 11000],
  ['121.53:121.41', 13000],
  ['121.53:121.54', 135000],
  ['121.54:121.53', 22000],
  ['121.53:122.25', 60000],
  ['122.25:121.54', 80000],
  ['121.54:122.25', 94000],
  ['122.25:121.53', 92000],
  ['121.43:122.25', 1000000],
  ['122.25:121.44', 1000000],
  ['121.44:122.25', 1000000],
  ['122.25:121.43', 1000000],
  ['121.53:122.15', 1000000],
  ['122.15:121.54', 1000000],
  ['121.54:122.15', 1000000],
  ['122.15:121.53', 1000000],
];

export async function sharedPowerFixture(request, options = {}) {
  const { perStation = 2, sourceCapacityKw = 120, ...stationOptions } = options;
  const model = await stationTurnoverFixture(request, {
    ...stationOptions,
    count: perStation * 2,
    bays: 2,
    batteryInventory: 1,
  });
  const route = (
    await request(`/api/projects/${model.project.id}/routes`, 'POST', {
      name: '第二港区循环',
      points: [
        roadPoint('a', '第二装货港', 121.53),
        roadPoint('b', '第二卸货场', 121.54),
        roadPoint('c', '第二装货港返回', 121.53),
      ],
    })
  ).body;
  await model.save('/cycles', 'POST', { sourceRouteId: route.id });
  let cycle = model.scenario.context.transportCycles.at(-1);
  await model.save(`/cycles/${cycle.id}`, 'PATCH', { confirmed: true });
  await model.save('/demands', 'PUT', {
    demands: [model.cycle, cycle].map((entry) => ({
      cycleId: entry.id,
      loadingPositionId: entry.positions[0].id,
      unloadingPositionId: entry.positions[1].id,
      dailyTonnes: perStation * 10,
    })),
  });
  const operations = operationInputs(model.scenario.context.operations);
  operations.measuredSegments.push(
    ...operations.measuredSegments.map((entry, index) => ({
      ...entry,
      id: undefined,
      cycleId: cycle.id,
      fromPositionId: cycle.positions[index].id,
      toPositionId: cycle.positions[index + 1].id,
    })),
  );
  await model.save('/operations', 'PUT', { operations });
  let network = stationNetworkInputs(model.scenario.context.stationNetwork);
  network.powerSources[0].point = {
    name: '共享验收电源',
    longitude: 122.1,
    latitude: 31.2,
    coordinateSystem: 'GCJ-02',
    availableCapacityKw: sourceCapacityKw,
    capacitySource: '独立共享功率算例',
    connectionNotes: '两站同源',
  };
  network.fixedLayout = [];
  network.sites[0].connection.availablePowerKw = sourceCapacityKw;
  network.sites.push({
    ...network.sites[0],
    id: undefined,
    name: '第二换电站',
    longitude: 122.25,
    siteConfirmed: false,
    connection: { ...network.sites[0].connection, confirmed: false },
  });
  await model.save('/station-network', 'PUT', { network });
  network = stationNetworkInputs(model.scenario.context.stationNetwork);
  for (const site of network.sites) {
    site.siteConfirmed = true;
    site.connection.confirmed = true;
  }
  await model.save('/station-network', 'PUT', { network });
  network = stationNetworkInputs(model.scenario.context.stationNetwork);
  network.fixedLayout = network.sites.map((site) => ({
    siteId: site.id,
    stationTypeId: network.stationTypes[0].id,
  }));
  await model.save('/station-network', 'PUT', { network });
  return Object.assign(model, {
    async startSharedPower(expectedStatus = 'completed') {
      await model.prepare();
      const response = await request(`${model.path}/daily-transport`, 'POST', {
        expectedRevision: model.scenario.revision,
        config: { stage: 'shared-power' },
      });
      assert.equal(response.status, 202, JSON.stringify(response.body));
      return waitDailyTransportTask(request, model.path, response.body.task.taskId, expectedStatus);
    },
  });
}
