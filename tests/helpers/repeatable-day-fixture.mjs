import assert from 'node:assert/strict';
import { stationTurnoverFixture } from './station-turnover-fixture.mjs';
import { operationInputs, waitDailyTransportTask } from './daily-transport-fixture.mjs';

// At 500 kWh capacity the repeating vehicle departs/returns with 290 kWh.
// It consumes 11 + 120 + 160 + 37 + 13 = 341 kWh, and returns 159 kWh at its swap.
// Restoring that pack at 120 kW / 90% takes 189 4/9 minutes; purchase = 378 8/9 kWh.
export async function repeatableFixture(request, options = {}) {
  const model = await stationTurnoverFixture(request, {
    count: 1,
    batteryInventory: 1,
    ...options,
  });
  const operations = operationInputs(model.scenario.context.operations);
  operations.battery.capacityKwh = 500;
  await model.save('/operations', 'PUT', { operations });
  await model.saveStationType({ refreshBattery: true });
  return Object.assign(model, {
    async startPeriodic(status = 'completed') {
      await model.prepare();
      const started = await request(`${model.path}/daily-transport`, 'POST', {
        expectedRevision: model.scenario.revision,
        config: { stage: 'repeatable-day' },
      });
      assert.equal(started.status, 202, JSON.stringify(started.body));
      return waitDailyTransportTask(request, model.path, started.body.task.taskId, status);
    },
  });
}
