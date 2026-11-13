import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startVehicleEnergyApplication } from './helpers/vehicle-energy-fixture.mjs';
import { repeatableFixture } from './helpers/repeatable-day-fixture.mjs';

import { financeInput } from './helpers/operating-cashflows-fixture.mjs';
test(
  'operating prices persist explicit business boundary, sources and nulls through guarded input APIs',
  { timeout: 180000 },
  async (t) => {
    const { request } = await startVehicleEnergyApplication(t);
    const model = await repeatableFixture(request);
    const input = financeInput();
    input.years[0].lines[0].rate = null;
    const save = await request(`${model.path}/operating-cashflows`, 'PUT', {
      expectedRevision: model.scenario.revision,
      input,
    });
    assert.equal(save.status, 200, JSON.stringify(save.body));
    assert.deepEqual(save.body.context.operatingCashflows, input);
    assert.equal(save.body.inputVersion, model.scenario.inputVersion + 1);
    assert.deepEqual((await request(model.path)).body, save.body);
    const same = await request(`${model.path}/operating-cashflows`, 'PUT', {
      expectedRevision: save.body.revision,
      input,
    });
    assert.deepEqual(same.body, save.body);
    const invalid = structuredClone(input);
    invalid.years[0].lines[1].rate = '0.0000001';
    assert.equal(
      (
        await request(`${model.path}/operating-cashflows`, 'PUT', {
          expectedRevision: save.body.revision,
          input: invalid,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(`${model.path}/operating-cashflows`, 'PUT', {
          expectedRevision: model.scenario.revision,
          input,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await request(model.path, 'PATCH', {
          expectedRevision: save.body.revision,
          context: {
            ...save.body.context,
            operatingCashflows: { ...input, boundary: 'station-only' },
          },
        })
      ).status,
      400,
    );
    assert.deepEqual((await request(model.path)).body, save.body);
  },
);

test(
  'annual operating ledgers charge actual saturated transport and tariff intersections, cancelling internal settlements',
  { timeout: 240000 },
  async (t) => {
    const { request } = await startVehicleEnergyApplication(t);
    const model = await repeatableFixture(request);
    const demandId = model.scenario.context.transportDemands[0].id;
    await model.save('/annual-transport', 'PUT', {
      years: [
        { year: 2030, operatingDays: 1, demands: [{ demandId, dailyTonnes: 10 }] },
        { year: 2031, operatingDays: 2, demands: [{ demandId, dailyTonnes: 10 }] },
        { year: 2032, operatingDays: 1, demands: [{ demandId, dailyTonnes: 20 }] },
        { year: 2033, operatingDays: 0, demands: [{ demandId, dailyTonnes: 10 }] },
      ],
    });
    await model.prepare();
    const started = await request(`${model.path}/annual-transport`, 'POST', {
      expectedRevision: model.scenario.revision,
    });
    const { waitDailyTransportTask } = await import('./helpers/daily-transport-fixture.mjs');
    const source = await waitDailyTransportTask(request, model.path, started.body.task.taskId);
    const input = financeInput();
    input.years = [2030, 2031, 2032, 2033].map((year) => {
      const row = financeInput(year).years[0];
      row.lines[0].rate = year === 2030 ? '100' : '200';
      row.lines.push({
        id: 'loaded',
        name: '载荷计量核对',
        flow: 'transport-cost',
        basis: 'tonne-km',
        rate: '0',
        source: '明确零价',
        stationId: null,
      });
      row.lines.push({
        id: 'empty',
        name: '空驶核对',
        flow: 'transport-cost',
        basis: 'empty-km',
        rate: '0',
        source: '已含车辆运行费',
        stationId: null,
      });
      row.electricity = [
        {
          powerSourceId: model.scenario.context.stationNetwork.powerSources[0].id,
          payer: 'station',
          windows: [
            { startMinute: 0, endMinute: 600, rate: '1', source: '电价合同早段' },
            { startMinute: 600, endMinute: 660, rate: '2', source: '电价合同中段' },
            { startMinute: 660, endMinute: 0, rate: '3', source: '电价合同跨午夜段' },
          ],
        },
      ];
      return row;
    });
    // Financial-only changes advance the input version; POST explicitly adopts the same physical snapshot.
    await model.save('/operating-cashflows', 'PUT', { input });
    const calculate = () =>
      request(`${model.path}/operating-cashflows`, 'POST', {
        expectedRevision: model.scenario.revision,
        sourceTaskId: source.taskId,
      });
    const response = await calculate();
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const result = response.body;
    assert.equal(result.complete, true);
    assert.equal(result.economicStatus, 'not-ready');
    assert.equal(result.sourceInputVersion, source.inputVersion);
    assert.equal(result.inputVersion, model.scenario.inputVersion);
    assert.deepEqual(
      result.years.map((y) => [y.year, y.incomeCents, y.expenseCents, y.balanceCents]),
      [
        [2030, 100000, 108067, -8067],
        [2031, 400000, 213133, 186867],
        [2032, 200000, 108067, 91933],
        [2033, 0, 3000, -3000],
      ],
    );
    const first = result.years[0];
    assert.deepEqual(
      first.lines.filter((l) => ['loaded', 'empty'].includes(l.id)).map((l) => [l.id, l.quantity]),
      [
        ['loaded', 1400],
        ['empty', 46],
      ],
    );
    assert.equal(first.lines.find((l) => l.id === 'swap').treatment, 'eliminated');
    assert.deepEqual(
      first.electricity.map((e) => [e.startMinute, e.endMinute, e.amountCents]),
      [
        [0, 600, 7600],
        [600, 660, 24000],
        [660, 0, 54867],
      ],
    );
    assert.equal(first.electricityTotalCents, 86467);
    input.boundary = 'station-only';
    await model.save('/operating-cashflows', 'PUT', { input });
    const station = (await calculate()).body;
    assert.deepEqual(
      station.years.map((y) => [y.incomeCents, y.expenseCents, y.balanceCents]),
      [
        [2000, 89467, -87467],
        [4000, 175933, -171933],
        [2000, 89467, -87467],
        [0, 3000, -3000],
      ],
    );
    assert.equal(station.years[0].lines.find((l) => l.id === 'freight').treatment, 'excluded');
    const history = (await request(`${model.path}/operating-cashflows`)).body;
    assert.equal(history.results.length, 2);
    assert.deepEqual(
      (await request(`${model.path}/operating-cashflows/${result.id}`)).body,
      result,
    );
    assert.equal(history.results.find((r) => r.id === result.id).inputVersion, result.inputVersion);
  },
);

test(
  'missing prices stay unknown, zero and half-cent rates stay explicit, and invalid tariff batches are atomic',
  { timeout: 240000 },
  async (t) => {
    const { request } = await startVehicleEnergyApplication(t);
    const model = await repeatableFixture(request);
    const demandId = model.scenario.context.transportDemands[0].id;
    await model.save('/annual-transport', 'PUT', {
      years: [{ year: 2030, operatingDays: 1, demands: [{ demandId, dailyTonnes: 10 }] }],
    });
    await model.prepare();
    const launch = await request(`${model.path}/annual-transport`, 'POST', {
      expectedRevision: model.scenario.revision,
    });
    const { waitDailyTransportTask } = await import('./helpers/daily-transport-fixture.mjs');
    const source = await waitDailyTransportTask(request, model.path, launch.body.task.taskId);
    const input = financeInput();
    const powerSourceId = model.scenario.context.stationNetwork.powerSources[0].id;
    input.years[0].electricity = [
      {
        powerSourceId,
        payer: 'station',
        windows: [{ startMinute: 0, endMinute: 1440, rate: '0', source: '合同免费供电' }],
      },
    ];
    input.years[0].lines[0].rate = null;
    await model.save('/operating-cashflows', 'PUT', { input });
    const calculate = () =>
      request(`${model.path}/operating-cashflows`, 'POST', {
        expectedRevision: model.scenario.revision,
        sourceTaskId: source.taskId,
      });
    const unknown = (await calculate()).body;
    assert.equal(unknown.complete, false);
    assert.equal(unknown.years[0].incomeCents, null);
    assert.match(unknown.years[0].issues.join(' '), /运费.*单价/);
    input.years[0].lines[0].rate = '0';
    input.years[0].lines[1].rate = '0';
    input.years[0].lines[3].rate = '0.005';
    input.years[0].lines.push({
      id: 'second-half',
      name: '第二项半分',
      flow: 'station-cost',
      basis: 'year',
      rate: '0.015',
      source: '精度独立案例',
      stationId: null,
    });
    await model.save('/operating-cashflows', 'PUT', { input });
    const rounded = (await calculate()).body;
    assert.equal(rounded.complete, true);
    assert.deepEqual(
      [rounded.years[0].incomeCents, rounded.years[0].expenseCents, rounded.years[0].balanceCents],
      [0, 3, -3],
    );
    assert.deepEqual(
      rounded.years[0].lines.filter((l) => l.basis === 'year').map((l) => l.amountCents),
      [1, 2],
    );
    const invalid = structuredClone(input);
    invalid.years[0].electricity[0].windows.push({
      startMinute: 600,
      endMinute: 700,
      rate: '1',
      source: '重复窗口',
    });
    assert.equal(
      (
        await request(`${model.path}/operating-cashflows`, 'PUT', {
          expectedRevision: model.scenario.revision,
          input: invalid,
        })
      ).status,
      400,
    );
    invalid.years[0].electricity = [];
    invalid.years[0].stationCostMode = 'station-types';
    assert.equal(
      (
        await request(`${model.path}/operating-cashflows`, 'PUT', {
          expectedRevision: model.scenario.revision,
          input: invalid,
        })
      ).status,
      400,
    );
    assert.deepEqual((await request(model.path)).body, model.scenario);
    input.years[0].lines[0].source = '';
    await model.save('/operating-cashflows', 'PUT', { input });
    assert.match((await calculate()).body.years[0].issues.join(' '), /运费.*来源/);
    input.years[0].lines[0].source = '零价依据';
    input.years[0].lines[0].rate = '999999999999.999999';
    await model.save('/operating-cashflows', 'PUT', { input });
    const overflow = (await calculate()).body;
    // Use a fixed fee within input range but make quantity*rate exceed the supported cents range.
    input.years[0].lines[0].basis = 'tonne-km';
    await model.save('/operating-cashflows', 'PUT', { input });
    const exceeded = (await calculate()).body;
    assert.equal(overflow.complete, true);
    assert.equal(exceeded.complete, false);
    assert.equal(exceeded.years[0].balanceCents, null);
    assert.match(exceeded.years[0].issues.join(' '), /超出/);
    input.years[0].lines[0].rate = '1';
    input.years[0].electricity[0].windows = [
      { startMinute: 0, endMinute: 600, rate: '1', source: '不完整窗口' },
    ];
    await model.save('/operating-cashflows', 'PUT', { input });
    assert.match((await calculate()).body.years[0].issues.join(' '), /电价覆盖/);
  },
);

test(
  'versioned operating history survives freeze, copy, input comparison, cross-project guards and restart',
  { timeout: 240000 },
  async (t) => {
    const { app, request } = await startVehicleEnergyApplication(t);
    const model = await repeatableFixture(request);
    const demandId = model.scenario.context.transportDemands[0].id;
    await model.save('/annual-transport', 'PUT', {
      years: [{ year: 2030, operatingDays: 1, demands: [{ demandId, dailyTonnes: 10 }] }],
    });
    await model.prepare();
    const launched = await request(`${model.path}/annual-transport`, 'POST', {
      expectedRevision: model.scenario.revision,
    });
    const { waitDailyTransportTask } = await import('./helpers/daily-transport-fixture.mjs');
    const source = await waitDailyTransportTask(request, model.path, launched.body.task.taskId);
    const input = financeInput();
    input.years[0].electricity = [
      {
        powerSourceId: model.scenario.context.stationNetwork.powerSources[0].id,
        payer: 'station',
        windows: [{ startMinute: 0, endMinute: 1440, rate: '1', source: '电价合同' }],
      },
    ];
    await model.save('/operating-cashflows', 'PUT', { input });
    const original = (
      await request(`${model.path}/operating-cashflows`, 'POST', {
        expectedRevision: model.scenario.revision,
        sourceTaskId: source.taskId,
      })
    ).body;
    assert.equal(original.complete, true);
    const frozen = await request(`${model.path}/freeze`, 'POST', {
      expectedRevision: model.scenario.revision,
    });
    assert.equal(frozen.status, 200);
    for (const [method, body] of [
      ['PUT', { input }],
      ['POST', { sourceTaskId: source.taskId }],
    ])
      assert.equal(
        (
          await request(`${model.path}/operating-cashflows`, method, {
            expectedRevision: frozen.body.revision,
            ...body,
          })
        ).status,
        409,
      );
    const copy = (
      await request(`${model.path}/copy`, 'POST', {
        expectedRevision: frozen.body.revision,
        name: '运营收支副本',
      })
    ).body;
    const copyPath = `/api/projects/${model.project.id}/scenarios/${copy.id}`;
    assert.deepEqual(copy.context.operatingCashflows, input);
    assert.deepEqual((await request(`${copyPath}/operating-cashflows`)).body.results, []);
    assert.equal(
      (
        await request(`${copyPath}/operating-cashflows`, 'POST', {
          expectedRevision: copy.revision,
          sourceTaskId: source.taskId,
        })
      ).status,
      404,
    );
    const modified = structuredClone(input);
    modified.boundary = 'station-only';
    modified.years[0].lines[0].rate = '125';
    const changed = (
      await request(`${copyPath}/operating-cashflows`, 'PUT', {
        expectedRevision: copy.revision,
        input: modified,
      })
    ).body;
    const compared = (
      await request(
        `/api/projects/${model.project.id}/scenarios/compare?left=${model.scenario.id}&right=${copy.id}`,
      )
    ).body;
    assert.deepEqual(
      compared.differences
        .filter((d) => d.path === 'operatingCashflows.boundary')
        .map((d) => [d.left, d.right]),
      [['integrated', 'station-only']],
    );
    assert.deepEqual(
      compared.differences
        .filter((d) => d.path === 'operatingCashflows.years[2030].lines[freight].rate')
        .map((d) => [d.left, d.right]),
      [['100', '125']],
    );
    assert.equal(changed.inputVersion, 2);
    const other = (await request('/api/projects', 'POST', { name: '其他归属' })).body;
    assert.equal(
      (
        await request(
          `/api/projects/${other.id}/scenarios/${model.scenario.id}/operating-cashflows/${original.id}`,
        )
      ).status,
      404,
    );
    assert.equal((await request(`${copyPath}/operating-cashflows/${original.id}`)).status, 404);
    await app.stop();
    const { startApplication, jsonRequest } = await import('./helpers/application.mjs');
    const reopened = await startApplication(
      { HAULPATH_TEST_MODE: '1', AMAP_JS_KEY: '', AMAP_JS_SECURITY_CODE: '' },
      app.directory,
    );
    try {
      assert.deepEqual(
        (await jsonRequest(reopened.baseUrl, `${model.path}/operating-cashflows/${original.id}`))
          .body,
        original,
      );
    } finally {
      await reopened.stop();
    }
  },
);

test(
  'shared-source purchases are priced once through station allocations and old evidence rejects physical changes',
  { timeout: 240000 },
  async (t) => {
    const { sharedPowerFixture, sharedPowerDistances } =
      await import('./helpers/shared-power-fixture.mjs');
    const { operationInputs } = await import('./helpers/daily-transport-fixture.mjs');
    const { request } = await startVehicleEnergyApplication(t, {
      extraDistances: sharedPowerDistances,
    });
    const model = await sharedPowerFixture(request, { perStation: 1, endMinute: 760 });
    const operations = operationInputs(model.scenario.context.operations);
    operations.battery.capacityKwh = 500;
    await model.save('/operations', 'PUT', { operations });
    await model.saveStationType({ refreshBattery: true });
    const demands = model.scenario.context.transportDemands.map((d) => ({
      demandId: d.id,
      dailyTonnes: 10,
    }));
    await model.save('/annual-transport', 'PUT', {
      years: [{ year: 2030, operatingDays: 1, demands }],
    });
    await model.prepare();
    const launch = await request(`${model.path}/annual-transport`, 'POST', {
      expectedRevision: model.scenario.revision,
    });
    const { waitDailyTransportTask } = await import('./helpers/daily-transport-fixture.mjs');
    const source = await waitDailyTransportTask(request, model.path, launch.body.task.taskId);
    const input = financeInput();
    input.years[0].electricity = [
      {
        powerSourceId: model.scenario.context.stationNetwork.powerSources[0].id,
        payer: 'station',
        windows: [{ startMinute: 0, endMinute: 1440, rate: '1', source: '同源电价合同' }],
      },
    ];
    const [first, second] = model.scenario.context.stationNetwork.fixedLayout;
    input.years[0].lines[2].stationId = first.siteId;
    input.years[0].lines.push({
      ...input.years[0].lines[2],
      id: 'second-swap',
      stationId: second.siteId,
      rate: '30',
    });
    await model.save('/operating-cashflows', 'PUT', { input });
    const calculate = () =>
      request(`${model.path}/operating-cashflows`, 'POST', {
        expectedRevision: model.scenario.revision,
        sourceTaskId: source.taskId,
      });
    const integrated = (await calculate()).body;
    assert.equal(integrated.complete, true, JSON.stringify(integrated));
    assert.equal(integrated.years[0].electricityTotalCents, 75778);
    assert.deepEqual(
      integrated.years[0].electricity.map((e) => e.amountCents).sort(),
      [37889, 37889],
    );
    assert.equal(new Set(integrated.years[0].electricity.map((e) => e.powerSourceId)).size, 1);
    input.boundary = 'station-only';
    await model.save('/operating-cashflows', 'PUT', { input });
    const station = (await calculate()).body;
    assert.equal(station.years[0].incomeCents, 5000);
    assert.equal(station.years[0].expenseCents, 78778);
    const oldVersion = model.scenario.inputVersion;
    // An explicit physical year/day change cannot silently reuse the previous task.
    await model.save('/annual-transport', 'PUT', {
      years: [{ year: 2030, operatingDays: 2, demands }],
    });
    assert.ok(model.scenario.inputVersion > oldVersion);
    assert.equal((await calculate()).status, 409);
    assert.deepEqual(
      (await request(`${model.path}/operating-cashflows/${integrated.id}`)).body,
      integrated,
    );
  },
);

test(
  'unverified years retain unknown cashflows while independently checked lower-demand years remain readable',
  { timeout: 240000 },
  async (t) => {
    const { request } = await startVehicleEnergyApplication(t);
    const model = await repeatableFixture(request);
    const { operationInputs, waitDailyTransportTask } =
      await import('./helpers/daily-transport-fixture.mjs');
    const operations = operationInputs(model.scenario.context.operations);
    operations.battery.capacityKwh = 300;
    await model.save('/operations', 'PUT', { operations });
    await model.saveStationType({ refreshBattery: true });
    const demandId = model.scenario.context.transportDemands[0].id;
    await model.save('/annual-transport', 'PUT', {
      years: [
        { year: 2030, operatingDays: 1, demands: [{ demandId, dailyTonnes: 1 }] },
        { year: 2031, operatingDays: 1, demands: [{ demandId, dailyTonnes: 10 }] },
      ],
    });
    await model.prepare();
    const launch = await request(`${model.path}/annual-transport`, 'POST', {
      expectedRevision: model.scenario.revision,
    });
    const source = await waitDailyTransportTask(request, model.path, launch.body.task.taskId);
    const input = financeInput();
    input.years.push(financeInput(2031).years[0]);
    for (const year of input.years)
      year.electricity = [
        {
          powerSourceId: model.scenario.context.stationNetwork.powerSources[0].id,
          payer: 'external',
          windows: [],
        },
      ];
    await model.save('/operating-cashflows', 'PUT', { input });
    const response = await request(`${model.path}/operating-cashflows`, 'POST', {
      expectedRevision: model.scenario.revision,
      sourceTaskId: source.taskId,
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.complete, false);
    assert.equal(response.body.years[0].complete, true);
    assert.equal(response.body.years[0].incomeCents, 10000);
    assert.equal(response.body.years[1].incomeCents, null);
    assert.equal(response.body.years[1].expenseCents, null);
    assert.equal(response.body.years[1].balanceCents, null);
    assert.match(response.body.years[1].issues.join(' '), /证据/);
    assert.match(response.body.issues.join(' '), /未形成完整多年/);
  },
);

test(
  'twenty annual ledgers include both midnight purchase fragments and use station-type costs without duplication',
  { timeout: 240000 },
  async (t) => {
    const { request } = await startVehicleEnergyApplication(t);
    const model = await repeatableFixture(request, { startMinute: 1320, endMinute: 1520 });
    await model.saveStationType({ annualOperatingCost: 0 });
    const demandId = model.scenario.context.transportDemands[0].id;
    const years = Array.from({ length: 20 }, (_, i) => ({
      year: 2030 + i,
      operatingDays: i === 19 ? 0 : i + 1,
      demands: [{ demandId, dailyTonnes: 10 }],
    }));
    await model.save('/annual-transport', 'PUT', { years });
    await model.prepare();
    const launch = await request(`${model.path}/annual-transport`, 'POST', {
      expectedRevision: model.scenario.revision,
    });
    const { waitDailyTransportTask } = await import('./helpers/daily-transport-fixture.mjs');
    const source = await waitDailyTransportTask(request, model.path, launch.body.task.taskId);
    const input = financeInput();
    input.years = years.map((y) => {
      const row = financeInput(y.year).years[0];
      row.stationCostMode = 'station-types';
      row.lines = row.lines.filter((l) => l.flow !== 'station-cost');
      row.electricity = [
        {
          powerSourceId: model.scenario.context.stationNetwork.powerSources[0].id,
          payer: 'station',
          windows: [
            { startMinute: 1380, endMinute: 60, rate: '2', source: '跨午夜电价合同' },
            { startMinute: 60, endMinute: 1380, rate: '1', source: '其余时段合同' },
          ],
        },
      ];
      return row;
    });
    await model.save('/operating-cashflows', 'PUT', { input });
    const response = await request(`${model.path}/operating-cashflows`, 'POST', {
      expectedRevision: model.scenario.revision,
      sourceTaskId: source.taskId,
    });
    assert.equal(response.status, 201);
    assert.equal(response.body.complete, true, JSON.stringify(response.body));
    assert.equal(response.body.years.length, 20);
    assert.deepEqual(
      response.body.years[0].electricity.map((e) => [e.quantityKwh, e.amountCents]),
      [
        [196, 39200],
        [182.888889, 18289],
      ],
    );
    assert.deepEqual(
      response.body.years.slice(0, 2).map((y) => [y.incomeCents, y.expenseCents]),
      [
        [100000, 76089],
        [200000, 152178],
      ],
    );
    const zero = response.body.years[19];
    assert.deepEqual([zero.incomeCents, zero.expenseCents, zero.balanceCents], [0, 0, 0]);
    assert.equal(
      response.body.years[0].lines.filter((l) => l.id.startsWith('station-type:')).length,
      1,
    );
  },
);
