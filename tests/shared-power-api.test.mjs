import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sharedPowerFixture, sharedPowerDistances } from './helpers/shared-power-fixture.mjs';
import { startVehicleEnergyApplication } from './helpers/vehicle-energy-fixture.mjs';
import { stationNetworkInputs } from './helpers/daily-transport-fixture.mjs';
import { jsonRequest, startApplication } from './helpers/application.mjs';

const near = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-7, `Expected ${expected}, got ${actual}`);

test(
  'shared supply staggers two stations and propagates full-battery waiting into vehicle return',
  { timeout: 180000 },
  async (t) => {
    const { request } = await startVehicleEnergyApplication(t, {
      extraDistances: sharedPowerDistances,
    });
    const model = await sharedPowerFixture(request, { endMinute: 920 });
    const task = await model.startSharedPower();
    const { result } = task;
    assert.equal(result.validation.valid, true);
    assert.equal(result.totalCompletedTonnes, 40);
    assert.equal(result.vehicleEnergy.sharedPowerStatus, 'checked');
    assert.equal(result.vehicleEnergy.periodicityStatus, 'not-checked');
    assert.equal(result.physicalFeasibility, 'not-established');
    const stations = result.stationTurnover.stations;
    assert.deepEqual(
      stations.map((station) => station.swaps.length),
      [2, 2],
    );
    const charges = stations
      .flatMap((station) => station.charges)
      .sort((a, b) => a.startMinute - b.startMinute);
    // Four 131 kWh battery recoveries, each requiring 72 7/9 min at 120 kW / 90%.
    near(charges[0].startMinute, 562);
    for (let index = 1; index < charges.length; index++)
      assert.ok(charges[index].startMinute >= charges[index - 1].endMinute);
    assert.ok(charges.some((charge) => charge.waitReasons.includes('shared-power')));
    const [source] = result.sharedPower.sources;
    assert.equal(source.availableCapacityKw, 120);
    near(source.peakPowerKw, 120);
    near(source.gridEnergyKwh, 582 + 2 / 9);
    assert.ok(source.intervals.some((interval) => interval.stations.length === 1));
    for (const station of stations) {
      const second = station.swaps[1];
      assert.ok(second.waitReasons.includes('full-battery'));
      const vehicle = result.vehicleEnergy.vehicles.find((v) => v.vehicleId === second.vehicleId);
      near(vehicle.events.at(-1).endMinute, second.endMinute + 113);
      assert.deepEqual(station.horizonInventory, { full: 1, pending: 0, charging: 0 });
    }
    assert.deepEqual((await request(`${model.path}/daily-transport/${task.taskId}`)).body, task);

    await t.test(
      'enough window energy cannot replace instantaneous power and continuous charging',
      async () => {
        const network = stationNetworkInputs(model.scenario.context.stationNetwork);
        // 200 kW * 98 min / 60 = 326 2/3 kWh > the 291 1/9 kWh needed to replenish
        // both initial batteries. Two 120 kW sessions still cannot fit continuously.
        network.powerSources[0].point = {
          name: '共享验收电源',
          longitude: 122.1,
          latitude: 31.2,
          coordinateSystem: 'GCJ-02',
          availableCapacityKw: 200,
          capacitySource: '独立共享功率算例',
          connectionNotes: '两站同源',
        };
        network.stationTypes[0].chargeWindows = [{ startMinute: 562, endMinute: 660 }];
        await model.save('/station-network', 'PUT', { network });
        const confirmed = stationNetworkInputs(model.scenario.context.stationNetwork);
        confirmed.sites.forEach((site) => {
          site.connection.confirmed = true;
        });
        await model.save('/station-network', 'PUT', { network: confirmed });
        const failed = await model.startSharedPower('failed');
        assert.equal(failed.result, null);
        assert.match(failed.error, /满电.*不足/);
        assert.match(failed.error, /共享电源/);
        assert.match(failed.error, /充电窗口/);
        assert.deepEqual((await request(`${model.path}/daily-transport`)).body.resultTask, task);
      },
    );
    await t.test('one shared source can supply two simultaneous battery charges', async () => {
      let network = stationNetworkInputs(model.scenario.context.stationNetwork);
      network.powerSources[0].point = {
        name: '共享验收电源',
        longitude: 122.1,
        latitude: 31.2,
        coordinateSystem: 'GCJ-02',
        availableCapacityKw: 240,
        capacitySource: '独立共享功率算例',
        connectionNotes: '两站同源',
      };
      network.stationTypes[0].chargeWindows = [{ startMinute: 0, endMinute: 1440 }];
      await model.save('/station-network', 'PUT', { network });
      network = stationNetworkInputs(model.scenario.context.stationNetwork);
      network.sites.forEach((site) => {
        site.connection.confirmed = true;
      });
      await model.save('/station-network', 'PUT', { network });
      const concurrent = await model.startSharedPower();
      const [source] = concurrent.result.sharedPower.sources;
      assert.equal(source.peakPowerKw, 240);
      assert.ok(source.intervals.some((i) => i.gridPowerKw === 240 && i.stations.length === 2));
      for (const station of concurrent.result.stationTurnover.stations) {
        near(station.charges[0].startMinute, 562);
        near(station.charges[1].startMinute, 640 + 7 / 9);
      }
    });
  },
);

test(
  'shared charging accounts only actual energy before cutoff and keeps continuous reservations across midnight',
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
    const task = await model.startSharedPower();
    const charges = task.result.stationTurnover.stations
      .flatMap((s) => s.charges)
      .sort((a, b) => a.startMinute - b.startMinute);
    near(charges[0].startMinute, 1402);
    near(charges[0].endMinute, 1474 + 7 / 9);
    near(charges[1].startMinute, 1474 + 7 / 9);
    near(charges[1].endMinute, 1547 + 5 / 9);
    const [source] = task.result.sharedPower.sources;
    near(source.gridEnergyKwh, 236); // 120 kW * (1520 - 1402) / 60, not 291 1/9 kWh.
    assert.ok(source.intervals.some((i) => i.endMinute === 1440));
    assert.equal(source.intervals.at(-1).endMinute, 1520);
    assert.equal(charges[1].statusAtHorizon, 'charging');
    await t.test('pending charging requirements are not recorded as purchased energy', async () => {
      await model.saveStationType({ chargeWindows: [{ startMinute: 90, endMinute: 220 }] });
      const pending = await model.startSharedPower();
      assert.equal(pending.result.sharedPower.sources[0].gridEnergyKwh, 0);
      assert.equal(pending.result.sharedPower.sources[0].peakPowerKw, 0);
      for (const station of pending.result.stationTurnover.stations) {
        assert.equal(station.charges[0].startMinute, null);
        near(station.charges[0].gridEnergyKwh, 145 + 5 / 9);
        assert.deepEqual(station.horizonInventory, { full: 0, pending: 1, charging: 0 });
      }
    });
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

test(
  'cross-station returns fill earlier gaps and separate source identities retain their own capacity',
  { timeout: 180000 },
  async (t) => {
    const { request } = await startVehicleEnergyApplication(t, {
      extraDistances: sharedPowerDistances,
    });
    const model = await sharedPowerFixture(request, { perStation: 1, endMinute: 920 });
    let network = stationNetworkInputs(model.scenario.context.stationNetwork);
    network.stationTypes[0].swapMinutes = 100;
    network.stationTypes.push({
      ...network.stationTypes[0],
      id: undefined,
      name: '快速站型',
      swapMinutes: 6,
    });
    await model.save('/station-network', 'PUT', { network });
    network = stationNetworkInputs(model.scenario.context.stationNetwork);
    network.fixedLayout[1].stationTypeId = network.stationTypes[1].id;
    await model.save('/station-network', 'PUT', { network });
    const filled = await model.startSharedPower();
    const [slow, fast] = filled.result.stationTurnover.stations;
    assert.equal(slow.swaps[0].arrivalMinute, 556);
    assert.equal(fast.swaps[0].arrivalMinute, 556);
    near(slow.charges[0].startMinute, 656);
    // The slow station has already reserved 656..728 7/9. A global release cursor would
    // incorrectly postpone this later-processed return instead of using 562..634 7/9.
    near(fast.charges[0].startMinute, 562);
    near(fast.charges[0].endMinute, 634 + 7 / 9);
    assert.deepEqual(fast.charges[0].waitReasons, []);
    near(filled.result.sharedPower.sources[0].peakPowerKw, 120);

    await t.test(
      'two different adopted sources with the same name may charge simultaneously',
      async () => {
        const projectPath = `/api/projects/${model.project.id}/power-connection-points`;
        const current = (await request(projectPath)).body;
        const { projectId, originalLongitude, originalLatitude, ...oldPoint } = current.points[0];
        void projectId;
        const added = await request(projectPath, 'PUT', {
          expectedRevision: current.revision,
          points: [
            { ...oldPoint, longitude: originalLongitude, latitude: originalLatitude },
            {
              name: '共享验收电源',
              longitude: 123,
              latitude: 31.2,
              coordinateSystem: 'GCJ-02',
              availableCapacityKw: 120,
              capacitySource: '第二份独立供电容量',
              connectionNotes: '独立源',
            },
          ],
        });
        assert.equal(added.status, 200, JSON.stringify(added.body));
        network = stationNetworkInputs(model.scenario.context.stationNetwork);
        network.powerSources.push({ sourcePointId: added.body.points[1].id });
        network.stationTypes[0].swapMinutes = 6;
        await model.save('/station-network', 'PUT', { network });
        network = stationNetworkInputs(model.scenario.context.stationNetwork);
        network.sites[1].connection.powerSourceId =
          model.scenario.context.stationNetwork.powerSources[1].id;
        await model.save('/station-network', 'PUT', { network });
        network = stationNetworkInputs(model.scenario.context.stationNetwork);
        network.sites[1].connection.confirmed = true;
        await model.save('/station-network', 'PUT', { network });
        const separate = await model.startSharedPower();
        assert.equal(separate.result.sharedPower.sources.length, 2);
        for (const source of separate.result.sharedPower.sources) {
          assert.equal(source.powerSourceName, '共享验收电源');
          near(source.peakPowerKw, 120);
          near(source.gridEnergyKwh, 145 + 5 / 9);
        }
        for (const station of separate.result.stationTurnover.stations)
          near(station.charges[0].startMinute, 562);
      },
    );
  },
);
