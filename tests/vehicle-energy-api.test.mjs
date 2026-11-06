import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  operationInputs,
  stationNetworkInputs,
  waitDailyTransportTask,
} from './helpers/daily-transport-fixture.mjs';
import {
  startVehicleEnergyApplication,
  vehicleEnergyFixture,
} from './helpers/vehicle-energy-fixture.mjs';

const allowedDetour = { maxExtraMeters: 5000, maxExtraMinutes: 4 };

async function trial(request, model, stage, expectedStatus) {
  await model.prepare();
  const started = await request(`${model.path}/daily-transport`, 'POST', {
    expectedRevision: model.scenario.revision,
    ...(stage ? { config: { stage } } : {}),
  });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const task = await waitDailyTransportTask(request, model.path, started.body.task.taskId, null);
  assert.equal(task.status, expectedStatus ?? 'completed', task.error ?? task.status);
  return task;
}

test(
  'saved detour limits follow the scenario revision, copy, and comparison lifecycle',
  { timeout: 180000 },
  async (t) => {
    const { request } = await startVehicleEnergyApplication(t);
    const model = await vehicleEnergyFixture(request);
    const initial = model.scenario;
    const put = (expectedRevision, swapDetourLimits) =>
      request(`${model.path}/daily-transport`, 'PUT', { expectedRevision, swapDetourLimits });
    const unlimited = { maxExtraMeters: null, maxExtraMinutes: null };
    const alreadyUnlimited = await put(initial.revision, unlimited);
    assert.equal(alreadyUnlimited.status, 200, JSON.stringify(alreadyUnlimited.body));
    assert.equal(alreadyUnlimited.body.inputVersion, initial.inputVersion);

    const save = await put(initial.revision, allowedDetour);
    assert.equal(save.status, 200, JSON.stringify(save.body));
    const saved = save.body;
    assert.equal(saved.inputVersion, initial.inputVersion + 1);
    assert.deepEqual((await request(model.path)).body.context.swapDetourLimits, allowedDetour);
    assert.equal((await put(initial.revision, allowedDetour)).status, 409);
    assert.equal(
      (await put(saved.revision, { maxExtraMeters: -1, maxExtraMinutes: null })).status,
      400,
    );

    const bypass = await request(model.path, 'PATCH', {
      expectedRevision: saved.revision,
      context: { ...saved.context, swapDetourLimits: unlimited },
    });
    assert.equal(bypass.status, 400, JSON.stringify(bypass.body));
    assert.deepEqual((await request(model.path)).body.context.swapDetourLimits, allowedDetour);

    const same = await put(saved.revision, allowedDetour);
    assert.equal(same.status, 200);
    assert.equal(same.body.inputVersion, saved.inputVersion);
    const frozen = await request(`${model.path}/freeze`, 'POST', {
      expectedRevision: same.body.revision,
    });
    assert.equal(frozen.status, 200, JSON.stringify(frozen.body));
    assert.equal(
      (await put(frozen.body.revision, { maxExtraMeters: 0, maxExtraMinutes: null })).status,
      409,
    );
    const copied = await request(`${model.path}/copy`, 'POST', {
      expectedRevision: frozen.body.revision,
      name: '限额调整草案',
    });
    assert.equal(copied.status, 201, JSON.stringify(copied.body));
    assert.deepEqual(copied.body.context.swapDetourLimits, allowedDetour);
    const copiedPath = `${model.collection}/${copied.body.id}`;
    const adjusted = { maxExtraMeters: 0, maxExtraMinutes: null };
    const adjustedCopy = await request(`${copiedPath}/daily-transport`, 'PUT', {
      expectedRevision: copied.body.revision,
      swapDetourLimits: adjusted,
    });
    assert.equal(adjustedCopy.status, 200, JSON.stringify(adjustedCopy.body));
    assert.deepEqual(adjustedCopy.body.context.swapDetourLimits, adjusted);
    const compare = await request(
      `${model.collection}/compare?left=${saved.id}&right=${copied.body.id}`,
    );
    assert.equal(compare.status, 200, JSON.stringify(compare.body));
    assert.equal(compare.body.differences.length, 2);
    assert.ok(
      compare.body.differences.every(({ path }) => path.includes('swapDetourLimits')),
      JSON.stringify(compare.body.differences),
    );
    const cleared = await request(`${copiedPath}/daily-transport`, 'PUT', {
      expectedRevision: adjustedCopy.body.revision,
      swapDetourLimits: unlimited,
    });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.equal(cleared.body.inputVersion, adjustedCopy.body.inputVersion + 1);
    assert.equal(cleared.body.context.swapDetourLimits, undefined);
  },
);

test(
  'real energy Worker verifies a directed swap, measures the return, and retains results after a failed trial',
  { timeout: 180000 },
  async (t) => {
    const { request } = await startVehicleEnergyApplication(t);
    const model = await vehicleEnergyFixture(request);
    await model.save('/daily-transport', 'PUT', { swapDetourLimits: allowedDetour });
    const transport = await trial(request, model);
    assert.equal(transport.result.energyStatus, 'not-checked');
    assert.equal(transport.result.totalCompletedTonnes, 10);
    assert.equal(transport.result.vehicles[0].workingMinutes, 185);

    const checked = await trial(request, model, 'vehicle-energy');
    assert.equal(checked.result.energyStatus, 'checked');
    assert.equal(checked.result.physicalFeasibility, 'not-established');
    assert.equal(checked.result.totalCompletedTonnes, 10);
    assert.deepEqual(checked.snapshot.context.swapDetourLimits, allowedDetour);
    const energy = checked.result.vehicleEnergy;
    assert.equal(energy.swapCount, 1);
    assert.equal(energy.batteryCapacityKwh, 300);
    assert.equal(energy.initialSocPercent, 100);
    assert.equal(energy.replacementSocPercent, 100);
    assert.equal(energy.totalDistanceMeters, 186000);
    assert.deepEqual(
      [
        energy.stationCapacityStatus,
        energy.batteryInventoryStatus,
        energy.sharedPowerStatus,
        energy.periodicityStatus,
      ],
      ['not-checked', 'not-checked', 'not-checked', 'not-checked'],
    );

    const [vehicle] = energy.vehicles;
    assert.equal(vehicle.initialKwh, 300);
    assert.equal(vehicle.safetyKwh, 60);
    assert.equal(vehicle.finalKwh, 90);
    assert.equal(vehicle.consumedKwh, 341);
    assert.equal(vehicle.workingMinutes, 195);
    assert.equal(vehicle.totalDistanceMeters, 186000);
    const evidence = vehicle.events.map(
      ({
        kind,
        startMinute,
        endMinute,
        distanceMeters,
        energyKwh,
        startKwh,
        endKwh,
        energySource,
      }) => [
        kind,
        startMinute,
        endMinute,
        distanceMeters,
        energyKwh,
        startKwh,
        endKwh,
        energySource,
      ],
    );
    // 11 km empty, 60+80 km full, then reverse measured 37 kWh and 13 km empty to base.
    assert.deepEqual(evidence, [
      ['continuation', 480, 491, 11000, 11, 300, 289, 'template'],
      ['loading', 491, 496, 0, 0, 289, 289, 'none'],
      ['station-entry', 496, 556, 60000, 120, 289, 169, 'template'],
      ['swap', 556, 562, 0, 0, 169, 300, 'none'],
      ['station-exit', 562, 642, 80000, 160, 300, 140, 'template'],
      ['unloading', 642, 647, 0, 0, 140, 140, 'none'],
      ['transport', 647, 662, 22000, 37, 140, 103, 'measured'],
      ['return', 662, 675, 13000, 13, 103, 90, 'template'],
    ]);
    const [entry, swap, exit] = vehicle.events.slice(2, 5);
    const site = checked.snapshot.context.stationNetwork.sites[0];
    assert.equal(entry.to.longitude, site.longitude);
    assert.equal(exit.from.longitude, site.longitude);
    assert.deepEqual([entry.loadTonnes, exit.loadTonnes], [10, 10]);
    assert.equal(swap.stationId, site.id);
    assert.equal(swap.detour.extraMeters, 5000);
    assert.equal(swap.detour.extraMinutes, 4);
    assert.equal(swap.detour.serviceStartMinute, 556);
    assert.equal(swap.endSocPercent, 100);
    assert.ok(Math.abs(swap.startSocPercent - 56.3333333333) < 1e-9);
    assert.equal(
      vehicle.events[6].measuredEnergySegmentId,
      checked.snapshot.context.operations.measuredSegments[1].id,
    );
    assert.equal(vehicle.events.at(-1).to.name, '车场');

    await t.test('enabled distance and time limits independently block the same swap', async () => {
      for (const swapDetourLimits of [
        { maxExtraMeters: 4999, maxExtraMinutes: 4 },
        { maxExtraMeters: 5000, maxExtraMinutes: 0 },
      ]) {
        await model.save('/daily-transport', 'PUT', { swapDetourLimits });
        const failed = await trial(request, model, 'vehicle-energy', 'failed');
        assert.equal(failed.result, null);
        assert.match(failed.error, /十吨车/);
        assert.match(failed.error, /装货港.*卸货场/);
        assert.match(failed.error, /绕行.*限额/);
        const view = (await request(`${model.path}/daily-transport`)).body;
        assert.equal(view.task.taskId, failed.taskId);
        assert.deepEqual(view.resultTask, checked);
      }
    });

    await t.test('unsafe arrival cannot be rescued by a full replacement battery', async () => {
      await model.save('/daily-transport', 'PUT', { swapDetourLimits: allowedDetour });
      const originalOperations = operationInputs(model.scenario.context.operations);
      const operations = structuredClone(originalOperations);
      operations.vehicleGroups[0].fullKwhPerKm = 4;
      await model.save('/operations', 'PUT', { operations });
      // The 60 km approach would leave 49 kWh, below the 60 kWh safety floor.
      const failed = await trial(request, model, 'vehicle-energy', 'failed');
      assert.equal(failed.result, null);
      assert.match(failed.error, /十吨车/);
      assert.match(failed.error, /装货港.*卸货场/);
      assert.match(failed.error, /到站.*安全电量|安全电量.*到站/);
      assert.deepEqual((await request(`${model.path}/daily-transport`)).body.resultTask, checked);
      await model.save('/operations', 'PUT', { operations: originalOperations });
    });

    await t.test('the final empty return must retain the safety reserve', async () => {
      const originalOperations = operationInputs(model.scenario.context.operations);
      const operations = structuredClone(originalOperations);
      operations.vehicleGroups[0].safetySocPercent = 32;
      await model.save('/operations', 'PUT', { operations });
      // Unladen return starts at 103 kWh and ends at 90 kWh, below the new 96 kWh floor.
      const unsafeReturn = await trial(request, model, 'vehicle-energy', 'failed');
      assert.match(unsafeReturn.error, /归位.*安全电量/);
      assert.deepEqual((await request(`${model.path}/daily-transport`)).body.resultTask, checked);
      await model.save('/operations', 'PUT', { operations: originalOperations });
    });

    await t.test(
      'calendar waiting consumes the shift but not the driving detour allowance',
      async () => {
        const original = stationNetworkInputs(model.scenario.context.stationNetwork);
        const network = structuredClone(original);
        network.stationTypes[0].serviceWindows = [{ startMinute: 560, endMinute: 1440 }];
        await model.save('/station-network', 'PUT', { network });
        const waited = await trial(request, model, 'vehicle-energy');
        const [vehicle] = waited.result.vehicleEnergy.vehicles;
        const swap = vehicle.events.find((event) => event.kind === 'swap');
        assert.equal(swap.startMinute, 556);
        assert.equal(swap.detour.serviceStartMinute, 560);
        assert.equal(swap.endMinute, 566);
        assert.equal(swap.detour.extraMinutes, 4);
        assert.equal(vehicle.events.at(-1).endMinute, 679);

        network.stationTypes[0].serviceWindows[0].startMinute = 562;
        await model.save('/station-network', 'PUT', { network });
        // Six minutes of waiting would push the return from minute 675 to 681. The shift ends at 680.
        const lateReturn = await trial(request, model, 'vehicle-energy', 'failed');
        assert.match(lateReturn.error, /归位.*班次/);
        assert.deepEqual((await request(`${model.path}/daily-transport`)).body.resultTask, waited);
        await model.save('/station-network', 'PUT', { network: original });
      },
    );

    await t.test(
      'partial direct load interpolates measured energy against the recorded payload',
      async () => {
        await model.save('/demands', 'PUT', {
          demands: model.scenario.context.transportDemands.map((demand) => ({
            ...demand,
            dailyTonnes: 2,
          })),
        });
        const { result } = await trial(request, model, 'vehicle-energy');
        assert.equal(result.totalCompletedTonnes, 2);
        assert.equal(result.vehicleEnergy.swapCount, 0);
        const [partial] = result.vehicleEnergy.vehicles;
        // 20% payload between measured endpoints 125 and 275 kWh gives 155 kWh, not 162 from the template.
        const [direct] = partial.events.filter((event) => event.kind === 'transport');
        assert.equal(direct.loadTonnes, 2);
        assert.equal(direct.energySource, 'measured');
        assert.equal(direct.energyKwh, 155);
        assert.equal(partial.finalKwh, 84);

        const operations = operationInputs(model.scenario.context.operations);
        operations.vehicleGroups[0].payloadTonnes = 20;
        await model.save('/operations', 'PUT', { operations });
        const changed = await trial(request, model, 'vehicle-energy');
        const [updated] = changed.result.vehicleEnergy.vehicles;
        const [fallback] = updated.events.filter((event) => event.kind === 'transport');
        // The measurement was recorded at 10 t. With a 20 t group the 2 t trip uses 1.1 kWh/km.
        assert.equal(fallback.durationSource, 'measured');
        assert.equal(fallback.energySource, 'template');
        assert.ok(Math.abs(fallback.energyKwh - 148.5) < 1e-9);
        assert.ok(Math.abs(updated.finalKwh - 105.5) < 1e-9);
      },
    );
  },
);

test(
  'positive draws below one battery ULP accumulate against the usable reserve',
  { timeout: 180000 },
  async (t) => {
    const { request } = await startVehicleEnergyApplication(t);
    const model = await vehicleEnergyFixture(request);
    await model.save('/daily-transport', 'PUT', {
      swapDetourLimits: { maxExtraMeters: 0, maxExtraMinutes: 0 },
    });
    const operations = operationInputs(model.scenario.context.operations);
    Object.assign(operations.vehicleGroups[0], {
      emptyKwhPerKm: 1e-15,
      fullKwhPerKm: 1e-15,
      safetySocPercent: 99.99999999999999,
    });
    for (const segment of operations.measuredSegments) {
      segment.emptyKwh = 2e-14;
      segment.fullKwh = 2e-14;
    }
    await model.save('/operations', 'PUT', { operations });
    // The four legs total 6.4e-14 kWh, above the representable 5.68e-14 kWh usable reserve.
    // Each draw is individually too small to change 300 kWh when subtracted from it.
    const failed = await trial(request, model, 'vehicle-energy', 'failed');
    assert.equal(failed.result, null);
    assert.match(failed.error, /归位空驶.*安全电量/);
  },
);
