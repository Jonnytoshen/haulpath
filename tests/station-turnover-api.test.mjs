import assert from 'node:assert/strict';
import { test } from 'node:test';
import { operationInputs } from './helpers/daily-transport-fixture.mjs';
import { stationTurnoverFixture } from './helpers/station-turnover-fixture.mjs';
import { startVehicleEnergyApplication } from './helpers/vehicle-energy-fixture.mjs';

function near(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-7, `Expected ${expected}, got ${actual}`);
}

function checkCharge(charge, swap, startMinute) {
  assert.equal(charge.swapEventId, swap.eventId);
  assert.equal(charge.returnedMinute, swap.endMinute);
  assert.equal(charge.returnedKwh, 169);
  assert.equal(charge.gridPowerKw, 120);
  assert.equal(charge.efficiency, 0.9);
  assert.equal(charge.addedKwh, 131);
  // 131 kWh at 90% efficiency requires 145 5/9 kWh input and 72 7/9 minutes.
  near(charge.gridEnergyKwh, 145 + 5 / 9);
  near(charge.startMinute, startMinute);
  near(charge.endMinute, startMinute + 72 + 7 / 9);
}

function checkVehicleSchedule(task, swaps) {
  for (const [index, visit] of swaps.entries()) {
    const vehicle = task.result.vehicleEnergy.vehicles.find((v) => v.vehicleId === visit.vehicleId);
    const swap = vehicle.events.find((event) => event.kind === 'swap');
    assert.equal(visit.eventId, swap.id);
    assert.equal(visit.stationId, swap.stationId);
    assert.equal(visit.arrivalMinute, swap.startMinute);
    near(swap.detour.serviceStartMinute, visit.serviceStartMinute);
    near(swap.endMinute, visit.endMinute);
    assert.equal(swap.startKwh, 169);
    assert.equal(swap.endKwh, 300);
    assert.equal(vehicle.finalKwh, 90);
    const returned = vehicle.events.at(-1);
    assert.equal(returned.kind, 'return');
    assert.equal(returned.to.name, '车场');
    near(returned.endMinute, visit.endMinute + 113);
    if (index > 0) assert.ok(visit.serviceStartMinute > visit.arrivalMinute);
  }
}

test(
  'station turnover checks bay occupation, full-battery recovery, and the actual vehicle plan',
  { timeout: 180000 },
  async (t) => {
    const { request } = await startVehicleEnergyApplication(t);
    const model = await stationTurnoverFixture(request);
    const endpoint = `${model.path}/daily-transport`;
    let checked;

    await t.test(
      'simultaneous arrivals share one bay and respect the local power ceiling',
      async () => {
        checked = await model.startTurnover();
        const { result } = checked;
        assert.equal(checked.config.stage, 'station-turnover');
        assert.equal(result.validation.valid, true);
        assert.equal(result.totalCompletedTonnes, 20);
        assert.equal(result.physicalFeasibility, 'not-established');
        assert.deepEqual(
          [
            result.vehicleEnergy.stationCapacityStatus,
            result.vehicleEnergy.batteryInventoryStatus,
            result.vehicleEnergy.sharedPowerStatus,
            result.vehicleEnergy.periodicityStatus,
          ],
          ['checked', 'checked', 'not-checked', 'not-checked'],
        );
        const [station] = result.stationTurnover.stations;
        assert.equal(station.initialFullBatteries, 2);
        assert.deepEqual(station.horizonInventory, { full: 2, pending: 0, charging: 0 });
        assert.deepEqual(
          station.swaps.map((swap) => [
            swap.arrivalMinute,
            swap.serviceStartMinute,
            swap.endMinute,
            swap.waitReasons,
            swap.fullBatteriesAfterStart,
          ]),
          [
            [556, 556, 562, [], 1],
            [556, 562, 568, ['bay'], 0],
          ],
        );
        assert.equal(station.swaps[0].bay, station.swaps[1].bay);
        assert.equal(station.charges.length, 2);
        checkCharge(station.charges[0], station.swaps[0], 562);
        // Four charging slots are available, but both batteries would exceed 120 kW together.
        checkCharge(station.charges[1], station.swaps[1], 634 + 7 / 9);
        assert.ok(station.charges[1].waitReasons.includes('local-power'));
        checkVehicleSchedule(checked, station.swaps);
        assert.deepEqual((await request(endpoint)).body.resultTask, checked);
      },
    );

    await t.test('a charging slot is exclusive even when local power is sufficient', async () => {
      await model.saveStationType({ bays: 2, chargingSlots: 1, chargePowerKw: 240 });
      const trial = await model.startTurnover();
      const [station] = trial.result.stationTurnover.stations;
      assert.equal(station.swaps.length, 2);
      assert.deepEqual(
        station.swaps.map(({ serviceStartMinute, endMinute, waitReasons }) => [
          serviceStartMinute,
          endMinute,
          waitReasons,
        ]),
        [
          [556, 562, []],
          [556, 562, []],
        ],
      );
      assert.notEqual(station.swaps[0].bay, station.swaps[1].bay);
      checkCharge(station.charges[0], station.swaps[0], 562);
      checkCharge(station.charges[1], station.swaps[1], 634 + 7 / 9);
      assert.ok(station.charges[1].waitReasons.includes('charging-slot'));
    });

    await t.test(
      'a returned battery can serve another vehicle only after full charge',
      async () => {
        await model.saveStationType({ batteryInventory: 1, chargingSlots: 4, chargePowerKw: 120 });
        checked = await model.startTurnover();
        const [station] = checked.result.stationTurnover.stations;
        assert.equal(station.initialFullBatteries, 1);
        assert.deepEqual(station.horizonInventory, { full: 1, pending: 0, charging: 0 });
        assert.equal(station.swaps.length, 2);
        const [first, second] = station.swaps;
        assert.equal(first.serviceStartMinute, 556);
        assert.equal(second.arrivalMinute, 556);
        assert.deepEqual(second.waitReasons, ['full-battery']);
        near(second.serviceStartMinute, 634 + 7 / 9);
        near(second.endMinute, 640 + 7 / 9);
        assert.equal(second.fullBatteriesAfterStart, 0);
        assert.equal(station.charges.length, 2);
        checkCharge(station.charges[0], first, 562);
        checkCharge(station.charges[1], second, 640 + 7 / 9);
        checkVehicleSchedule(checked, station.swaps);
      },
    );

    await t.test(
      'an unavailable charge window leaves no full battery for the next service',
      async () => {
        await model.saveStationType({ chargeWindows: [{ startMinute: 562, endMinute: 634 }] });
        const failed = await model.startTurnover('failed');
        assert.equal(failed.result, null);
        assert.match(failed.error, /人工确认换电站/);
        assert.match(failed.error, /满电.*不足/);
        assert.match(failed.error, /充电窗口/);
        assert.deepEqual((await request(endpoint)).body.resultTask, checked);
      },
    );

    await t.test('local power cannot be replaced by daily energy arithmetic', async () => {
      await model.saveStationType({
        chargePowerKw: 119,
        chargeWindows: [{ startMinute: 0, endMinute: 1440 }],
      });
      const failed = await model.startTurnover('failed');
      assert.equal(failed.result, null);
      assert.match(failed.error, /人工确认换电站/);
      assert.match(failed.error, /满电.*不足/);
      assert.match(failed.error, /功率/);
      assert.deepEqual((await request(endpoint)).body.resultTask, checked);
    });

    await t.test('bay wait cannot move a service past its window', async () => {
      await model.saveStationType({
        bays: 1,
        batteryInventory: 2,
        chargePowerKw: 120,
        serviceWindows: [{ startMinute: 0, endMinute: 565 }],
        chargeWindows: [{ startMinute: 0, endMinute: 1440 }],
      });
      const failed = await model.startTurnover('failed');
      assert.equal(failed.result, null);
      assert.match(failed.error, /人工确认换电站/);
      assert.match(failed.error, /服务窗口/);
      assert.deepEqual((await request(endpoint)).body.resultTask, checked);
    });

    await t.test('bay wait cannot delay return past the shift', async () => {
      await model.saveStationType({ serviceWindows: [{ startMinute: 0, endMinute: 1440 }] });
      const operations = operationInputs(model.scenario.context.operations);
      operations.vehicleGroups[0].shifts[0].endMinute = 680;
      await model.save('/operations', 'PUT', { operations });
      // The second vehicle can start swapping at 562 and leave at 568, but reaches home at 681.
      const failed = await model.startTurnover('failed');
      assert.equal(failed.result, null);
      assert.match(failed.error, /归位.*班次/);
      assert.deepEqual((await request(endpoint)).body.resultTask, checked);
      assert.deepEqual((await request(`${endpoint}/${checked.taskId}`)).body, checked);
    });
  },
);

test(
  'charging preserves the same battery continuously across midnight',
  { timeout: 180000 },
  async (t) => {
    const { request } = await startVehicleEnergyApplication(t);
    const model = await stationTurnoverFixture(request, {
      count: 1,
      startMinute: 1320,
      endMinute: 1520,
      batteryInventory: 1,
      chargeWindows: [{ startMinute: 1420, endMinute: 1520 }],
    });
    const checked = await model.startTurnover();
    const [station] = checked.result.stationTurnover.stations;
    assert.equal(station.swaps.length, 1);
    const [swap] = station.swaps;
    assert.equal(swap.arrivalMinute, 1396);
    assert.equal(swap.serviceStartMinute, 1396);
    assert.equal(swap.endMinute, 1402);
    assert.equal(station.charges.length, 1);
    checkCharge(station.charges[0], swap, 1420);
    assert.ok(station.charges[0].waitReasons.includes('charge-window'));
    near(station.charges[0].endMinute, 1492 + 7 / 9);
    assert.deepEqual(station.horizonInventory, { full: 1, pending: 0, charging: 0 });
    checkVehicleSchedule(checked, [swap]);

    await t.test('the cutoff accounts separately for a battery still charging', async () => {
      // After the battery returns, the next occurrence of 00:10 is minute 1450.
      await model.saveStationType({ chargeWindows: [{ startMinute: 10, endMinute: 180 }] });
      const crossing = await model.startTurnover();
      const ledger = crossing.result.stationTurnover;
      const [station] = ledger.stations;
      assert.equal(ledger.horizonMinute, 1520);
      assert.deepEqual(station.horizonInventory, { full: 0, pending: 0, charging: 1 });
      assert.equal(station.charges[0].statusAtHorizon, 'charging');
      checkCharge(station.charges[0], station.swaps[0], 1450);
    });

    await t.test('a returned battery with no start before the cutoff stays pending', async () => {
      await model.saveStationType({ chargeWindows: [{ startMinute: 90, endMinute: 220 }] });
      const delayed = await model.startTurnover();
      const ledger = delayed.result.stationTurnover;
      const [station] = ledger.stations;
      assert.equal(ledger.horizonMinute, 1520);
      assert.deepEqual(station.horizonInventory, { full: 0, pending: 1, charging: 0 });
      assert.equal(station.charges[0].statusAtHorizon, 'pending');
      assert.equal(station.charges[0].startMinute, null);
      assert.equal(station.charges[0].endMinute, null);
    });

    await t.test(
      'a continuous daily window allows a long charge through the following midnight',
      async () => {
        const operations = operationInputs(model.scenario.context.operations);
        operations.battery.chargePowerKw = 5;
        await model.save('/operations', 'PUT', { operations });
        await model.saveStationType({
          refreshBattery: true,
          chargeWindows: [{ startMinute: 0, endMinute: 1440 }],
        });
        const trial = await model.startTurnover();
        const [station] = trial.result.stationTurnover.stations;
        const [charge] = station.charges;
        assert.equal(charge.startMinute, 1402);
        assert.equal(charge.gridPowerKw, 5);
        // 131 kWh at 4.5 kW net takes 1746 2/3 minutes, past the second midnight at 2880.
        near(charge.endMinute, 3148 + 2 / 3);
        assert.equal(charge.statusAtHorizon, 'charging');
        assert.deepEqual(station.horizonInventory, { full: 0, pending: 0, charging: 1 });
      },
    );
  },
);
