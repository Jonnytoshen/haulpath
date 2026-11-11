import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stationTurnoverFixture } from './helpers/station-turnover-fixture.mjs';
import { startVehicleEnergyApplication } from './helpers/vehicle-energy-fixture.mjs';
import { sharedPowerFixture, sharedPowerDistances } from './helpers/shared-power-fixture.mjs';
import { operationInputs, waitDailyTransportTask } from './helpers/daily-transport-fixture.mjs';
import { jsonRequest, startApplication } from './helpers/application.mjs';
import { repeatableFixture } from './helpers/repeatable-day-fixture.mjs';

const near = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-7, `Expected ${expected}, got ${actual}`);

test(
  'a repeatable day restores independently checked vehicle and station energy without free daily batteries',
  { timeout: 180000 },
  async (t) => {
    const { request } = await startVehicleEnergyApplication(t);
    const model = await repeatableFixture(request);
    const task = await model.startPeriodic();
    const result = task.result;
    assert.equal(result.physicalFeasibility, 'feasible');
    assert.equal(result.vehicleEnergy.periodicityStatus, 'checked');
    assert.equal(result.validation.valid, true);
    const [vehicle] = result.vehicleEnergy.vehicles;
    near(vehicle.initialKwh, 290);
    near(vehicle.finalKwh, 290);
    near(vehicle.consumedKwh, 341);
    const { initial, final } = result.periodicity;
    assert.deepEqual(initial, final);
    near(initial.vehicles[0].kwh, 290);
    assert.equal(initial.stations[0].full, 1);
    near(result.sharedPower.sources[0].gridEnergyKwh, 378 + 8 / 9);
    assert.equal(result.sharedPower.horizonMinute, 1440);
    assert.deepEqual((await request(`${model.path}/daily-transport/${task.taskId}`)).body, task);
  },
);

test(
  'midnight connects overnight vehicle work and continuous charging with actual daily purchases',
  { timeout: 180000 },
  async (t) => {
    const { request } = await startVehicleEnergyApplication(t);
    const model = await repeatableFixture(request, { startMinute: 1320, endMinute: 1520 });
    const task = await model.startPeriodic();
    const { result } = task;
    assert.equal(result.validation.valid, true);
    const state = result.periodicity.initial;
    near(state.vehicles[0].kwh, 424); // 38 minutes at 2 kWh/min after swapping at 1402.
    assert.equal(state.vehicles[0].eventKind, 'station-exit');
    near(state.vehicles[0].remainingMinutes, 42);
    const station = state.stations[0];
    assert.equal(station.full, 0);
    assert.equal(station.packs.length, 1);
    assert.equal(station.packs[0].kind, 'charging');
    near(station.packs[0].kwh, 227.4); // 159 + 38 * 1.8
    near(station.packs[0].endInMinutes, 151 + 4 / 9);
    const charges = result.stationTurnover.stations[0].charges;
    assert.ok(charges.some((c) => c.startMinute === -38));
    near(result.sharedPower.sources[0].gridEnergyKwh, 378 + 8 / 9);
    assert.ok(
      result.sharedPower.sources[0].intervals.every(
        (i) => i.startMinute >= 0 && i.endMinute <= 1440,
      ),
    );
    await t.test('a pack may wait across midnight for the next daily charge window', async () => {
      await model.saveStationType({
        batteryInventory: 2,
        chargeWindows: [{ startMinute: 90, endMinute: 360 }],
      });
      const pending = await model.startPeriodic();
      const boundary = pending.result.periodicity.initial.stations[0];
      assert.equal(boundary.full, 1);
      assert.equal(boundary.packs[0].kind, 'pending');
      near(boundary.packs[0].kwh, 159);
      near(boundary.packs[0].startInMinutes, 90);
      near(pending.result.sharedPower.sources[0].gridEnergyKwh, 378 + 8 / 9);
    });
  },
);

test(
  'a service crossing midnight retains the allocated full pack and the old vehicle battery separately',
  { timeout: 180000 },
  async (t) => {
    const { request } = await startVehicleEnergyApplication(t);
    const model = await repeatableFixture(request, { startMinute: 1360, endMinute: 1560 });
    const task = await model.startPeriodic();
    const initial = task.result.periodicity.initial;
    near(initial.vehicles[0].kwh, 159);
    assert.equal(initial.vehicles[0].eventKind, 'swap');
    near(initial.vehicles[0].remainingMinutes, 2);
    assert.equal(initial.stations[0].full, 0);
    assert.equal(initial.stations[0].packs[0].kind, 'in-service');
    near(initial.stations[0].storedKwh, 500);
    assert.deepEqual(initial, task.result.periodicity.final);
    near(task.result.periodicity.energy.consumedKwh, 341);
  },
);

test(
  'first-day success does not certify recurring vehicle energy or recurring station inventory',
  { timeout: 180000 },
  async (t) => {
    const { request } = await startVehicleEnergyApplication(t);
    const model = await stationTurnoverFixture(request, { count: 1, batteryInventory: 1 });
    const first = await model.startTurnover();
    assert.equal(first.result.validation.valid, true);
    const run = async () => {
      await model.prepare();
      const started = await request(`${model.path}/daily-transport`, 'POST', {
        expectedRevision: model.scenario.revision,
        config: { stage: 'repeatable-day' },
      });
      assert.equal(started.status, 202);
      return waitDailyTransportTask(request, model.path, started.body.task.taskId, 'failed');
    };
    const noVehicleClosure = await run();
    assert.equal(noVehicleClosure.result, null);
    assert.match(noVehicleClosure.error, /未找到闭合.*不证明全局无解/);
    assert.match(noVehicleClosure.error, /无法到站|安全电量/);
    assert.deepEqual((await request(`${model.path}/daily-transport`)).body.resultTask, first);
    const operations = operationInputs(model.scenario.context.operations);
    operations.battery.capacityKwh = 500;
    await model.save('/operations', 'PUT', { operations });
    await model.saveStationType({
      refreshBattery: true,
      chargeWindows: [{ startMinute: 562, endMinute: 600 }],
    });
    const noInventoryClosure = await run();
    assert.equal(noInventoryClosure.result, null);
    assert.match(noInventoryClosure.error, /满电电池不足.*充电窗口/);
    assert.match(noInventoryClosure.error, /不证明全局无解/);
    assert.deepEqual((await request(`${model.path}/daily-transport`)).body.resultTask, first);
  },
);

test(
  'two overnight stations repeat against one shared source, and periodic evidence survives restart',
  { timeout: 180000 },
  async (t) => {
    const { app, request } = await startVehicleEnergyApplication(t, {
      extraDistances: sharedPowerDistances,
    });
    const model = await sharedPowerFixture(request, {
      perStation: 1,
      startMinute: 1320,
      endMinute: 1520,
    });
    const operations = operationInputs(model.scenario.context.operations);
    operations.battery.capacityKwh = 500;
    await model.save('/operations', 'PUT', { operations });
    await model.saveStationType({ refreshBattery: true });
    await model.prepare();
    const started = await request(`${model.path}/daily-transport`, 'POST', {
      expectedRevision: model.scenario.revision,
      config: { stage: 'repeatable-day' },
    });
    assert.equal(started.status, 202);
    const task = await waitDailyTransportTask(request, model.path, started.body.task.taskId);
    const result = task.result;
    near(result.sharedPower.sources[0].gridEnergyKwh, 757 + 7 / 9);
    near(result.sharedPower.sources[0].peakPowerKw, 120);
    assert.equal(
      result.periodicity.initial.stations.filter((s) => s.packs[0].kind === 'charging').length,
      1,
    );
    assert.equal(
      result.periodicity.initial.stations.filter((s) => s.packs[0].kind === 'pending').length,
      1,
    );
    assert.deepEqual(result.periodicity.initial, result.periodicity.final);
    await app.stop();
    const reopened = await startApplication(
      { HAULPATH_TEST_MODE: '1', AMAP_JS_KEY: '', AMAP_JS_SECURITY_CODE: '' },
      app.directory,
    );
    try {
      assert.deepEqual(
        (await jsonRequest(reopened.baseUrl, `${model.path}/daily-transport/${task.taskId}`)).body,
        task,
      );
    } finally {
      await reopened.stop();
    }
  },
);
