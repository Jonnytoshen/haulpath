import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startVehicleEnergyApplication } from './helpers/vehicle-energy-fixture.mjs';
import { repeatableFixture } from './helpers/repeatable-day-fixture.mjs';

test(
  'annual inputs persist explicit years, days and demand identities without replacing legacy annual data',
  { timeout: 180000 },
  async (t) => {
    const { request } = await startVehicleEnergyApplication(t);
    const model = await repeatableFixture(request);
    const demands = model.scenario.context.transportDemands.map((d) => ({
      demandId: d.id,
      dailyTonnes: d.dailyTonnes,
    }));
    const years = [
      { year: 2030, operatingDays: 300, demands },
      { year: 2031, operatingDays: 280, demands: demands.map((d) => ({ ...d, dailyTonnes: 20 })) },
    ];
    const saved = await request(`${model.path}/annual-transport`, 'PUT', {
      expectedRevision: model.scenario.revision,
      years,
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(saved.body.context.annualTransport, years);
    assert.deepEqual(saved.body.context.annual, []);
    assert.equal(saved.body.inputVersion, model.scenario.inputVersion + 1);
    const same = await request(`${model.path}/annual-transport`, 'PUT', {
      expectedRevision: saved.body.revision,
      years,
    });
    assert.deepEqual(same.body, saved.body);
    assert.deepEqual((await request(model.path)).body, saved.body);
    const duplicate = await request(`${model.path}/annual-transport`, 'PUT', {
      expectedRevision: saved.body.revision,
      years: [years[0], years[0]],
    });
    assert.equal(duplicate.status, 400);
    const bypass = await request(model.path, 'PATCH', {
      expectedRevision: saved.body.revision,
      context: { ...saved.body.context, annualTransport: [] },
    });
    assert.equal(bypass.status, 400);
    assert.deepEqual((await request(model.path)).body, saved.body);
  },
);

test(
  'each growth year rechecks fixed capacity and publishes actual annual ledgers, reusing only equivalent days',
  { timeout: 240000 },
  async (t) => {
    const { request } = await startVehicleEnergyApplication(t);
    const model = await repeatableFixture(request);
    const demandId = model.scenario.context.transportDemands[0].id;
    const years = [
      { year: 2030, operatingDays: 300, demands: [{ demandId, dailyTonnes: 5 }] },
      { year: 2031, operatingDays: 300, demands: [{ demandId, dailyTonnes: 10 }] },
      { year: 2032, operatingDays: 300, demands: [{ demandId, dailyTonnes: 20 }] },
      { year: 2033, operatingDays: 200, demands: [{ demandId, dailyTonnes: 10 }] },
    ];
    await model.save('/annual-transport', 'PUT', { years });
    await model.prepare();
    const started = await request(`${model.path}/annual-transport`, 'POST', {
      expectedRevision: model.scenario.revision,
    });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const { waitDailyTransportTask } = await import('./helpers/daily-transport-fixture.mjs');
    const task = await waitDailyTransportTask(request, model.path, started.body.task.taskId);
    const result = task.annualResult;
    assert.equal(task.result, null);
    assert.equal(result.complete, true);
    assert.equal(result.economicStatus, 'not-ready');
    assert.deepEqual(
      result.years.map((y) => [
        y.year,
        y.dailyCompletedTonnes,
        y.targetTonnes,
        y.completedTonnes,
        y.missingTonnes,
        y.completionRate,
      ]),
      [
        [2030, 5, 1500, 1500, 0, 1],
        [2031, 10, 3000, 3000, 0, 1],
        [2032, 10, 6000, 3000, 3000, 0.5],
        [2033, 10, 2000, 2000, 0, 1],
      ],
    );
    assert.equal(result.totalCompletedTonnes, 9500);
    assert.equal(result.years[0].reusedFromYear, null);
    assert.equal(result.years[1].reusedFromYear, null);
    assert.equal(result.years[2].reusedFromYear, null);
    assert.equal(result.years[3].reusedFromYear, 2031);
    for (const year of result.years) {
      assert.equal(year.evidence.validation.valid, true);
      assert.deepEqual(year.evidence.periodicity.initial, year.evidence.periodicity.final);
      assert.equal(year.evidence.vehicleEnergy.vehicles.length, 1);
      assert.equal(year.annualSwapCount, year.operatingDays);
      assert.equal(year.annualDistanceMeters, 186000 * year.operatingDays);
    }
    assert.ok(Math.abs(result.years[0].annualGridEnergyKwh - 90333.33333333333) < 1e-6);
    assert.ok(Math.abs(result.years[1].annualGridEnergyKwh - 113666.66666666667) < 1e-6);
    assert.match(result.years[2].bottlenecks.join(' '), /班次|运力|时间/);
    const view = (await request(`${model.path}/annual-transport`)).body;
    assert.deepEqual(view.resultTask, task);
    assert.equal((await request(`${model.path}/daily-transport`)).body.resultTask, null);
  },
);

test(
  'annual input guards keep old evidence, freeze and copy inputs, and reject cross-project access',
  { timeout: 240000 },
  async (t) => {
    const { request } = await startVehicleEnergyApplication(t);
    const model = await repeatableFixture(request);
    const demands = model.scenario.context.transportDemands.map((d) => ({
      demandId: d.id,
      dailyTonnes: 10,
    }));
    const years = [{ year: 2030, operatingDays: 300, demands }];
    await model.save('/annual-transport', 'PUT', { years });
    await model.prepare();
    const launch = await request(`${model.path}/annual-transport`, 'POST', {
      expectedRevision: model.scenario.revision,
    });
    const { waitDailyTransportTask } = await import('./helpers/daily-transport-fixture.mjs');
    const original = await waitDailyTransportTask(request, model.path, launch.body.task.taskId);
    for (const bad of [
      [{ ...years[0], operatingDays: -1 }],
      [{ ...years[0], operatingDays: null }],
      [{ ...years[0], year: 2030.5 }],
      [{ ...years[0], demands: [] }],
      [{ ...years[0], demands: [{ demandId: 'unknown', dailyTonnes: 10 }] }],
      [{ ...years[0], demands: [{ demandId: demands[0].demandId, dailyTonnes: 0 }] }],
    ]) {
      assert.equal(
        (
          await request(`${model.path}/annual-transport`, 'PUT', {
            expectedRevision: model.scenario.revision,
            years: bad,
          })
        ).status,
        400,
      );
    }
    await model.save('/annual-transport', 'PUT', { years: [{ ...years[0], operatingDays: 0 }] });
    assert.deepEqual((await request(`${model.path}/annual-transport`)).body.resultTask, original);
    assert.equal(
      (
        await request(`${model.path}/annual-transport/${original.taskId}/continue`, 'POST', {
          expectedRevision: model.scenario.revision,
        })
      ).status,
      409,
    );
    const other = (await request('/api/projects', 'POST', { name: '其他项目' })).body;
    assert.equal(
      (await request(`/api/projects/${other.id}/scenarios/${model.scenario.id}/annual-transport`))
        .status,
      404,
    );
    const frozen = await request(`${model.path}/freeze`, 'POST', {
      expectedRevision: model.scenario.revision,
    });
    assert.equal(frozen.status, 200);
    assert.equal(
      (
        await request(`${model.path}/annual-transport`, 'PUT', {
          expectedRevision: frozen.body.revision,
          years,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await request(`${model.path}/annual-transport`, 'POST', {
          expectedRevision: frozen.body.revision,
        })
      ).status,
      409,
    );
    const copy = await request(`${model.path}/copy`, 'POST', {
      expectedRevision: frozen.body.revision,
      name: '年度复制',
    });
    assert.equal(copy.status, 201, JSON.stringify(copy.body));
    assert.deepEqual(copy.body.context.annualTransport, frozen.body.context.annualTransport);
    assert.equal(
      (
        await request(
          `/api/projects/${model.project.id}/scenarios/${copy.body.id}/annual-transport`,
        )
      ).body.resultTask,
      null,
    );
    const copyPath = `/api/projects/${model.project.id}/scenarios/${copy.body.id}`;
    const changed = await request(`${copyPath}/annual-transport`, 'PUT', {
      expectedRevision: copy.body.revision,
      years: [{ ...years[0], operatingDays: 100 }],
    });
    assert.equal(changed.status, 200);
    const compared = await request(
      `/api/projects/${model.project.id}/scenarios/compare?left=${model.scenario.id}&right=${copy.body.id}`,
    );
    assert.equal(compared.status, 200);
    assert.deepEqual(
      compared.body.differences
        .filter((d) => d.path === 'annualTransport[2030].operatingDays')
        .map((d) => [d.left, d.right]),
      [[0, 100]],
    );
  },
);

test(
  'annual publication retains stopped candidates, shares the transport queue and rejects late old-version results',
  { timeout: 240000 },
  async (t) => {
    const { request } = await startVehicleEnergyApplication(t);
    const model = await repeatableFixture(request, {
      count: 9,
      bays: 9,
      batteryInventory: 9,
      chargePowerKw: 720,
    });
    const demandId = model.scenario.context.transportDemands[0].id;
    await model.save('/annual-transport', 'PUT', {
      years: [
        { year: 2030, operatingDays: 300, demands: [{ demandId, dailyTonnes: 90 }] },
        { year: 2031, operatingDays: 300, demands: [{ demandId, dailyTonnes: 91 }] },
      ],
    });
    await model.prepare();
    const started = await request(`${model.path}/annual-transport`, 'POST', {
      expectedRevision: model.scenario.revision,
    });
    const id = started.body.task.taskId;
    const { setTimeout: delay } = await import('node:timers/promises');
    const until = async (predicate) => {
      for (let attempt = 0; attempt < 300; attempt++) {
        const task = (await request(`${model.path}/annual-transport/${id}?summary=1`)).body;
        if (predicate(task)) return task;
        await delay(50);
      }
      assert.fail('年度进度未在时限内到达预期状态');
    };
    await until((task) => task.status === 'running' && task.annualProgress.validatedYears > 0);
    const held = (await request(`${model.path}/annual-transport/${id}`)).body;
    assert.equal(held.annualResult.years[0].evidence.totalCompletedTonnes, 90);
    const queuedModel = await repeatableFixture(request);
    await queuedModel.prepare();
    const queued = await request(`${queuedModel.path}/daily-transport`, 'POST', {
      expectedRevision: queuedModel.scenario.revision,
    });
    assert.equal(queued.body.task.status, 'queued');
    await request(`${queuedModel.path}/daily-transport/${queued.body.task.taskId}/stop`, 'POST');
    const stopped = await request(`${model.path}/annual-transport/${id}/stop`, 'POST');
    assert.equal(stopped.body.task.status, 'stopped');
    const retained = stopped.body.resultTask;
    assert.equal(retained.annualResult.years[0].evidence.totalCompletedTonnes, 90);
    const continued = await request(`${model.path}/annual-transport/${id}/continue`, 'POST', {
      expectedRevision: model.scenario.revision,
    });
    assert.equal(continued.status, 202, JSON.stringify(continued.body));
    const nextId = continued.body.task.taskId;
    const next = (await request(`${model.path}/annual-transport/${nextId}`)).body;
    assert.notEqual(next.taskId, id);
    assert.equal(next.continuedFromTaskId, id);
    assert.deepEqual(next.snapshot, held.snapshot);
    await model.save('/annual-transport', 'PUT', {
      years: [{ year: 2030, operatingDays: 200, demands: [{ demandId, dailyTonnes: 90 }] }],
    });
    await delay(500);
    const superseded = (await request(`${model.path}/annual-transport/${nextId}`)).body;
    assert.equal(superseded.status, 'superseded');
    const frozenResult = superseded.annualResult;
    await delay(300);
    assert.deepEqual(
      (await request(`${model.path}/annual-transport/${nextId}`)).body.annualResult,
      frozenResult,
    );
    assert.deepEqual((await request(`${model.path}/annual-transport/${id}`)).body, retained);
  },
);

test(
  'twenty equivalent representative days scale annual quantities independently and survive restart',
  { timeout: 240000 },
  async (t) => {
    const { app, request } = await startVehicleEnergyApplication(t);
    const model = await repeatableFixture(request);
    const demands = model.scenario.context.transportDemands.map((d) => ({
      demandId: d.id,
      dailyTonnes: 10,
    }));
    const years = Array.from({ length: 20 }, (_, i) => ({
      year: 2030 + i,
      operatingDays: i === 19 ? 0 : 300,
      demands,
    }));
    await model.save('/annual-transport', 'PUT', { years });
    await model.prepare();
    const start = await request(`${model.path}/annual-transport`, 'POST', {
      expectedRevision: model.scenario.revision,
    });
    const { waitDailyTransportTask } = await import('./helpers/daily-transport-fixture.mjs');
    const task = await waitDailyTransportTask(request, model.path, start.body.task.taskId);
    assert.equal(task.annualResult.years.length, 20);
    assert.equal(task.annualResult.totalCompletedTonnes, 57000);
    assert.equal(task.annualResult.years[19].completedTonnes, 0);
    assert.equal(task.annualResult.years[19].annualGridEnergyKwh, 0);
    assert.equal(task.annualResult.years[19].reusedFromYear, 2030);
    const resumed = await request(
      `${model.path}/annual-transport/${task.taskId}/continue`,
      'POST',
      { expectedRevision: model.scenario.revision },
    );
    const replayed = await waitDailyTransportTask(request, model.path, resumed.body.task.taskId);
    assert.deepEqual(
      replayed.annualResult.years.map((y) => y.evidence),
      task.annualResult.years.map((y) => y.evidence),
    );
    await app.stop();
    const { startApplication, jsonRequest } = await import('./helpers/application.mjs');
    const reopened = await startApplication(
      { HAULPATH_TEST_MODE: '1', AMAP_JS_KEY: '', AMAP_JS_SECURITY_CODE: '' },
      app.directory,
    );
    try {
      assert.deepEqual(
        (await jsonRequest(reopened.baseUrl, `${model.path}/annual-transport/${task.taskId}`)).body,
        task,
      );
    } finally {
      await reopened.stop();
    }
  },
);

test(
  'equal total tonnes with different demand identities cannot reuse another year allocation',
  { timeout: 180000 },
  async (t) => {
    const { request } = await startVehicleEnergyApplication(t);
    const model = await repeatableFixture(request);
    const demand = model.scenario.context.transportDemands[0];
    await model.save('/demands', 'PUT', {
      demands: [
        demand,
        {
          cycleId: demand.cycleId,
          loadingPositionId: demand.loadingPositionId,
          unloadingPositionId: demand.unloadingPositionId,
          dailyTonnes: 1,
        },
      ],
    });
    const [a, b] = model.scenario.context.transportDemands;
    await model.save('/annual-transport', 'PUT', {
      years: [
        {
          year: 2030,
          operatingDays: 300,
          demands: [
            { demandId: a.id, dailyTonnes: 2 },
            { demandId: b.id, dailyTonnes: 8 },
          ],
        },
        {
          year: 2031,
          operatingDays: 300,
          demands: [
            { demandId: a.id, dailyTonnes: 8 },
            { demandId: b.id, dailyTonnes: 2 },
          ],
        },
      ],
    });
    await model.prepare();
    const start = await request(`${model.path}/annual-transport`, 'POST', {
      expectedRevision: model.scenario.revision,
    });
    const { waitDailyTransportTask } = await import('./helpers/daily-transport-fixture.mjs');
    const task = await waitDailyTransportTask(request, model.path, start.body.task.taskId);
    assert.deepEqual(
      task.annualResult.years.map((y) => y.reusedFromYear),
      [null, null],
    );
    assert.deepEqual(
      task.annualResult.years[0].evidence.demands.map((d) => d.completedTonnes),
      [2, 8],
    );
    assert.deepEqual(
      task.annualResult.years[1].evidence.demands.map((d) => d.completedTonnes),
      [8, 2],
    );
  },
);

test(
  'an unclosed high-demand year stays unknown without borrowing a lower-demand periodic account',
  { timeout: 240000 },
  async (t) => {
    const { request } = await startVehicleEnergyApplication(t);
    const model = await repeatableFixture(request);
    const { operationInputs } = await import('./helpers/daily-transport-fixture.mjs');
    const operations = operationInputs(model.scenario.context.operations);
    operations.battery.capacityKwh = 300;
    await model.save('/operations', 'PUT', { operations });
    await model.saveStationType({ refreshBattery: true });
    const demandId = model.scenario.context.transportDemands[0].id;
    await model.save('/annual-transport', 'PUT', {
      years: [
        { year: 2030, operatingDays: 300, demands: [{ demandId, dailyTonnes: 1 }] },
        { year: 2031, operatingDays: 300, demands: [{ demandId, dailyTonnes: 10 }] },
      ],
    });
    await model.prepare();
    const start = await request(`${model.path}/annual-transport`, 'POST', {
      expectedRevision: model.scenario.revision,
    });
    const { waitDailyTransportTask } = await import('./helpers/daily-transport-fixture.mjs');
    const task = await waitDailyTransportTask(request, model.path, start.body.task.taskId);
    assert.equal(task.annualResult.years[0].status, 'checked');
    assert.equal(task.annualResult.years[1].status, 'not-found');
    assert.equal(task.annualResult.years[1].completedTonnes, null);
    assert.equal(task.annualResult.years[1].evidence, null);
    assert.equal(task.annualResult.complete, false);
    assert.match(task.annualResult.years[1].bottlenecks.join(' '), /不证明全局无解/);
    assert.equal(task.annualResult.totalCompletedTonnes, 300);
  },
);

test(
  'a queued annual continuation retains upstream evidence when stopped and continued again before Worker start',
  { timeout: 240000 },
  async (t) => {
    const { request } = await startVehicleEnergyApplication(t);
    const model = await repeatableFixture(request);
    const demands = model.scenario.context.transportDemands.map((d) => ({
      demandId: d.id,
      dailyTonnes: 10,
    }));
    await model.save('/annual-transport', 'PUT', {
      years: [{ year: 2030, operatingDays: 300, demands }],
    });
    await model.prepare();
    const start = await request(`${model.path}/annual-transport`, 'POST', {
      expectedRevision: model.scenario.revision,
    });
    const { waitDailyTransportTask } = await import('./helpers/daily-transport-fixture.mjs');
    const source = await waitDailyTransportTask(request, model.path, start.body.task.taskId);
    const blocker = await repeatableFixture(request, {
      count: 9,
      bays: 9,
      batteryInventory: 9,
      chargePowerKw: 720,
    });
    await blocker.prepare();
    const blocked = await request(`${blocker.path}/daily-transport`, 'POST', {
      expectedRevision: blocker.scenario.revision,
      config: { stage: 'repeatable-day' },
    });
    const { waitSearch } = await import('./helpers/daily-search-fixture.mjs');
    await waitSearch(
      request,
      blocker,
      blocked.body.task.taskId,
      (task) => task.status === 'running',
    );
    const next = await request(`${model.path}/annual-transport/${source.taskId}/continue`, 'POST', {
      expectedRevision: model.scenario.revision,
    });
    const nextId = next.body.task.taskId;
    assert.equal(next.body.task.status, 'queued');
    const nextDetail = (await request(`${model.path}/annual-transport/${nextId}`)).body;
    assert.deepEqual(
      nextDetail.annualResult.years[0].evidence,
      source.annualResult.years[0].evidence,
    );
    assert.equal(nextDetail.annualResult.complete, false);
    await request(`${model.path}/annual-transport/${nextId}/stop`, 'POST');
    const again = await request(`${model.path}/annual-transport/${nextId}/continue`, 'POST', {
      expectedRevision: model.scenario.revision,
    });
    const againId = again.body.task.taskId;
    assert.equal(again.body.task.status, 'queued');
    const againDetail = (await request(`${model.path}/annual-transport/${againId}`)).body;
    assert.deepEqual(
      againDetail.annualResult.years[0].evidence,
      source.annualResult.years[0].evidence,
    );
    assert.equal(againDetail.continuedFromTaskId, nextId);
    await request(`${model.path}/annual-transport/${againId}/stop`, 'POST');
    await request(`${blocker.path}/daily-transport/${blocked.body.task.taskId}/stop`, 'POST');
  },
);
