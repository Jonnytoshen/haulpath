import assert from 'node:assert/strict';
import {
  operationInputs,
  stationNetworkInputs,
  waitDailyTransportTask,
} from './daily-transport-fixture.mjs';
import { vehicleEnergyFixture } from './vehicle-energy-fixture.mjs';

/**
 * A full-load trip reaches the station at shift start + 76 min with 169 of 300 kWh.
 * Direct travel fails the 60 kWh reserve; each vehicle swaps once and returns at
 * service end + 113 min. A returned battery needs 131 kWh stored at 108 kW net.
 */
export async function stationTurnoverFixture(
  request,
  {
    count = 2,
    startMinute = 480,
    endMinute = 760,
    bays = 1,
    batteryInventory = 2,
    chargePowerKw = 120,
    chargeWindows,
  } = {},
) {
  const model = await vehicleEnergyFixture(request);
  await model.save('/daily-transport', 'PUT', {
    swapDetourLimits: { maxExtraMeters: 5000, maxExtraMinutes: 4 },
  });
  const operations = operationInputs(model.scenario.context.operations);
  Object.assign(operations.vehicleGroups[0], { count, shifts: [{ startMinute, endMinute }] });
  await model.save('/operations', 'PUT', { operations });
  if (count !== 1) {
    await model.save('/demands', 'PUT', {
      demands: model.scenario.context.transportDemands.map((demand) => ({
        ...demand,
        dailyTonnes: count * 10,
      })),
    });
  }
  const saveStationType = (patch) => {
    const network = stationNetworkInputs(model.scenario.context.stationNetwork);
    Object.assign(network.stationTypes[0], patch);
    return model.save('/station-network', 'PUT', { network });
  };
  await saveStationType({
    bays,
    batteryInventory,
    chargePowerKw,
    ...(chargeWindows ? { chargeWindows } : {}),
  });
  return Object.assign(model, {
    saveStationType,
    async startTurnover(expectedStatus = 'completed') {
      await model.prepare();
      const started = await request(`${model.path}/daily-transport`, 'POST', {
        expectedRevision: model.scenario.revision,
        config: { stage: 'station-turnover' },
      });
      assert.equal(started.status, 202, JSON.stringify(started.body));
      return waitDailyTransportTask(request, model.path, started.body.task.taskId, expectedStatus);
    },
  });
}
