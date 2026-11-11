import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitSearch } from './helpers/daily-search-fixture.mjs';
import { repeatableFixture } from './helpers/repeatable-day-fixture.mjs';
import { startVehicleEnergyApplication } from './helpers/vehicle-energy-fixture.mjs';
import { waitDailyTransportTask } from './helpers/daily-transport-fixture.mjs';

test(
  'manual continuation creates another task with pinned roads, candidate provenance and search checkpoint',
  { timeout: 180000 },
  async (t) => {
    const { request } = await startVehicleEnergyApplication(t);
    const model = await repeatableFixture(request);
    const original = await model.startPeriodic();
    const response = await request(
      `${model.path}/daily-transport/${original.taskId}/continue`,
      'POST',
      { expectedRevision: model.scenario.revision },
    );
    assert.equal(response.status, 202, JSON.stringify(response.body));
    const next = await waitDailyTransportTask(request, model.path, response.body.task.taskId);
    assert.notEqual(next.taskId, original.taskId);
    assert.equal(next.continuedFromTaskId, original.taskId);
    assert.deepEqual(next.snapshot, original.snapshot);
    assert.deepEqual(next.result, original.result);
    assert.equal(next.search.best.sourceTaskId, original.taskId);
    assert.equal(next.search.nextOrder, original.search.nextOrder);
    assert.deepEqual(
      (await request(`${model.path}/daily-transport/${original.taskId}`)).body,
      original,
    );
  },
);

test(
  'stopping a running search keeps a complete candidate, queued work can stop, and continuation rejects changed input',
  { timeout: 180000 },
  async (t) => {
    const { request } = await startVehicleEnergyApplication(t);
    const model = await repeatableFixture(request, {
      count: 9,
      bays: 9,
      batteryInventory: 9,
      chargePowerKw: 720,
    });
    await model.prepare();
    const launch = await request(`${model.path}/daily-transport`, 'POST', {
      expectedRevision: model.scenario.revision,
      config: { stage: 'repeatable-day' },
    });
    const id = launch.body.task.taskId;
    const summary = await waitSearch(
      request,
      model,
      id,
      (task) => task.status === 'running' && task.search?.best,
    );
    assert.ok(summary.search.improvements >= 1);
    const running = (await request(`${model.path}/daily-transport/${id}`)).body;
    assert.equal(running.result.physicalFeasibility, 'feasible');
    assert.equal(running.result.totalCompletedTonnes, 90);
    assert.equal(running.result.vehicleEnergy.totalDistanceMeters, 9 * 186000);
    const queuedModel = await repeatableFixture(request);
    await queuedModel.prepare();
    const queued = await request(`${queuedModel.path}/daily-transport`, 'POST', {
      expectedRevision: queuedModel.scenario.revision,
      config: { stage: 'repeatable-day' },
    });
    assert.equal(queued.body.task.status, 'queued');
    await request(`${queuedModel.path}/daily-transport/${queued.body.task.taskId}/stop`, 'POST');
    assert.equal(
      (await request(`${queuedModel.path}/daily-transport/${queued.body.task.taskId}`)).body.result,
      null,
    );
    const stop = await request(`${model.path}/daily-transport/${id}/stop`, 'POST');
    assert.equal(stop.body.task.status, 'stopped');
    assert.deepEqual(stop.body.resultTask.result, running.result);
    const continued = await request(`${model.path}/daily-transport/${id}/continue`, 'POST', {
      expectedRevision: model.scenario.revision,
    });
    assert.equal(continued.status, 202);
    assert.equal(continued.body.task.continuedFromTaskId, id);
    assert.ok(BigInt(continued.body.task.search.nextOrder) >= BigInt(summary.search.nextOrder));
    assert.deepEqual(continued.body.resultTask.result, running.result);
    await request(`${model.path}/daily-transport/${continued.body.task.taskId}/stop`, 'POST');
    await model.save('/demands', 'PUT', {
      demands: model.scenario.context.transportDemands.map((d) => ({ ...d, dailyTonnes: 91 })),
    });
    const stale = await request(`${model.path}/daily-transport/${id}/continue`, 'POST', {
      expectedRevision: model.scenario.revision,
    });
    assert.equal(stale.status, 409);
    assert.deepEqual(
      (await request(`${model.path}/daily-transport`)).body.resultTask.result,
      running.result,
    );
  },
);

test(
  'frozen inputs and deleted projects reject continuation and cannot accept late candidates',
  { timeout: 180000 },
  async (t) => {
    const { request } = await startVehicleEnergyApplication(t);
    for (const action of ['change', 'freeze', 'delete']) {
      const model = await repeatableFixture(request, {
        count: 9,
        bays: 9,
        batteryInventory: 9,
        chargePowerKw: 720,
      });
      await model.prepare();
      const launch = await request(`${model.path}/daily-transport`, 'POST', {
        expectedRevision: model.scenario.revision,
        config: { stage: 'repeatable-day' },
      });
      const id = launch.body.task.taskId;
      await waitSearch(
        request,
        model,
        id,
        (task) => task.search?.best && task.status === 'running',
      );
      const saved = (await request(`${model.path}/daily-transport/${id}`)).body;
      const other = (await request('/api/projects', 'POST', { name: '隔离项目' })).body;
      assert.equal(
        (
          await request(
            `/api/projects/${other.id}/scenarios/${model.scenario.id}/daily-transport/${id}/continue`,
            'POST',
            { expectedRevision: model.scenario.revision },
          )
        ).status,
        404,
      );
      if (action === 'delete') {
        assert.equal((await request(`/api/projects/${model.project.id}`, 'DELETE')).status, 204);
        assert.equal((await request(`${model.path}/daily-transport/${id}`)).status, 404);
        assert.equal(
          (
            await request(`${model.path}/daily-transport/${id}/continue`, 'POST', {
              expectedRevision: model.scenario.revision,
            })
          ).status,
          404,
        );
      } else {
        if (action === 'freeze') {
          assert.equal(
            (
              await request(`${model.path}/freeze`, 'POST', {
                expectedRevision: model.scenario.revision,
              })
            ).status,
            200,
          );
        } else {
          await model.save('/demands', 'PUT', {
            demands: model.scenario.context.transportDemands.map((d) => ({
              ...d,
              dailyTonnes: 91,
            })),
          });
        }
        const superseded = (await request(`${model.path}/daily-transport/${id}`)).body;
        assert.equal(superseded.status, 'superseded');
        assert.deepEqual(superseded.result, saved.result);
        assert.ok(
          [409, 423].includes(
            (
              await request(`${model.path}/daily-transport/${id}/continue`, 'POST', {
                expectedRevision: model.scenario.revision,
              })
            ).status,
          ),
        );
        const replacement = await repeatableFixture(request);
        const finished = await replacement.startPeriodic(); // proves the old Worker released the shared queue
        assert.equal(finished.status, 'completed');
        assert.deepEqual((await request(`${model.path}/daily-transport/${id}`)).body, superseded);
      }
    }
  },
);
