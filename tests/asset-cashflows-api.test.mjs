import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assetInput, startAssetApplication } from './helpers/asset-cashflows-fixture.mjs';

test(
  'independent asset ledger charges new capital once and tracks replacements, residuals and working capital changes',
  { timeout: 180000 },
  async (t) => {
    const { request, path, scenario } = await startAssetApplication(t);
    const saved = await request(`${path}/asset-cashflows`, 'PUT', {
      expectedRevision: scenario.revision,
      input: assetInput(),
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.context.annualTransport, undefined);
    assert.equal(saved.body.context.operatingCashflows, undefined);
    const result = await request(`${path}/asset-cashflows`, 'POST', {
      expectedRevision: saved.body.revision,
    });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(result.body.complete, true, JSON.stringify(result.body.issues));
    assert.equal(result.body.economicStatus, 'not-ready');
    assert.deepEqual(
      result.body.years.map((y) => [y.year, y.outflowCents, y.inflowCents, y.balanceCents]),
      [
        [2030, 110000, 0, -110000],
        [2031, 42000, 5000, -37000],
        [2032, 0, 20000, 20000],
      ],
    );
    assert.equal(result.body.assets.find((a) => a.name === '已有车辆').historicalCostCents, 500000);
    assert.equal(
      (await request(`${path}/asset-cashflows/${result.body.id}`)).body.id,
      result.body.id,
    );
    assert.equal((await request(`${path}/asset-cashflows`)).body.results.length, 1);
  },
);

test(
  'asset event overrides replace base amounts with sources, preserve boundary ownership and round cents independently',
  { timeout: 180000 },
  async (t) => {
    const { request, path, scenario } = await startAssetApplication(t);
    let saved = (
      await request(`${path}/asset-cashflows`, 'PUT', {
        expectedRevision: scenario.revision,
        input: assetInput(),
      })
    ).body;
    const input = saved.context.assetCashflows;
    const battery = input.assets[0];
    const vehicle = input.assets[1];
    vehicle.replacements = [{ year: 2031, amount: '300', disposal: '10', source: '车辆更换合同' }];
    input.overrides = [
      {
        assetId: battery.id,
        year: 2031,
        kind: 'replacement',
        amount: '350',
        reason: '采用特殊年度合同价替代400',
        source: '合同修订2',
      },
    ];
    const save = async () => {
      const r = await request(`${path}/asset-cashflows`, 'PUT', {
        expectedRevision: saved.revision,
        input,
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      saved = r.body;
    };
    const calculate = async () => {
      const r = await request(`${path}/asset-cashflows`, 'POST', {
        expectedRevision: saved.revision,
      });
      assert.equal(r.status, 201);
      return r.body;
    };
    await save();
    const combined = await calculate();
    assert.deepEqual(
      [
        combined.years[1].replacementCents,
        combined.years[1].disposalCents,
        combined.years[1].balanceCents,
      ],
      [65000, 6000, -61000],
    );
    assert.equal(
      combined.years[1].events.find((e) => e.kind === 'replacement' && e.assetId === battery.id)
        .override.reason,
      input.overrides[0].reason,
    );
    input.boundary = 'station-only';
    await save();
    const station = await calculate();
    assert.deepEqual(
      [station.years[1].replacementCents, station.years[1].balanceCents],
      [35000, -32000],
    );
    assert.equal(station.years[1].events.find((e) => e.assetId === vehicle.id).included, false);
    battery.amount = '0.005';
    input.assets.push({
      ...battery,
      id: '',
      name: '第二项半分',
      amount: '0.015',
      replacements: [],
      residual: { year: 2032, amount: '0', source: '零' },
    });
    await save();
    const rounded = await calculate();
    assert.equal(rounded.years[0].investmentCents, 3);
    assert.equal(
      (await request(`${path}/asset-cashflows/${combined.id}`)).body.input.boundary,
      'integrated',
    );
  },
);

test(
  'asset input validates atomic batches, revisions, identities, freeze/copy, stale links and missing data without zero filling',
  { timeout: 180000 },
  async (t) => {
    const { request, path, scenario, collection } = await startAssetApplication(t);
    const savedResponse = await request(`${path}/asset-cashflows`, 'PUT', {
      expectedRevision: scenario.revision,
      input: assetInput(),
    });
    assert.equal(savedResponse.status, 200);
    const saved = savedResponse.body;
    const input = saved.context.assetCashflows;
    const put = (value, revision = saved.revision) =>
      request(`${path}/asset-cashflows`, 'PUT', { expectedRevision: revision, input: value });
    assert.deepEqual((await put(input)).body, saved);
    for (const modify of [
      (i) => {
        i.assets[0].amount = '-1';
      },
      (i) => {
        i.assets[0].amount = '1e3';
      },
      (i) => {
        i.assets[0].amount = '0.0000001';
      },
      (i) => {
        i.assets[1].id = 'foreign-id';
      },
      (i) => {
        i.assets.push(i.assets[0]);
      },
      (i) => {
        i.years.push(2030);
      },
      (i) => {
        i.workingCapital[0].years.push(i.workingCapital[0].years[0]);
      },
      (i) => {
        i.overrides.push({
          assetId: i.assets[0].id,
          year: 2031,
          kind: 'replacement',
          amount: '0',
          reason: '',
          source: '修订',
        });
      },
      (i) => {
        i.assets[0].siteId = 'foreign-site';
      },
    ]) {
      const invalid = structuredClone(input);
      modify(invalid);
      assert.equal((await put(invalid)).status, 400, JSON.stringify(invalid));
      assert.deepEqual((await request(path)).body, saved);
    }
    assert.equal((await put(input, scenario.revision)).status, 409);
    assert.equal(
      (
        await request(path, 'PATCH', {
          expectedRevision: saved.revision,
          context: { ...saved.context, assetCashflows: { ...input, boundary: 'station-only' } },
        })
      ).status,
      400,
    );
    const otherProject = (await request('/api/projects', 'POST', { name: '隔离' })).body;
    assert.equal(
      (await request(`/api/projects/${otherProject.id}/scenarios/${saved.id}/asset-cashflows`))
        .status,
      404,
    );
    const unknown = structuredClone(input);
    unknown.assets[0].amount = null;
    unknown.workingCapital[0].years[1].balance = null;
    const changed = await put(unknown);
    assert.equal(changed.status, 200);
    const missing = (
      await request(`${path}/asset-cashflows`, 'POST', { expectedRevision: changed.body.revision })
    ).body;
    assert.equal(missing.complete, false);
    assert.equal(missing.years[0].outflowCents, null);
    assert.equal(missing.years[2].workingCapital[0].releaseCents, null);
    const frozen = await request(`${path}/freeze`, 'POST', {
      expectedRevision: changed.body.revision,
    });
    assert.equal(frozen.status, 200, JSON.stringify(frozen));
    assert.equal((await put(unknown, frozen.body.revision)).status, 409);
    assert.equal(
      (await request(`${path}/asset-cashflows`, 'POST', { expectedRevision: frozen.body.revision }))
        .status,
      409,
    );
    const copy = await request(`${path}/copy`, 'POST', {
      name: '独立副本',
      expectedRevision: frozen.body.revision,
    });
    assert.equal(copy.status, 201);
    assert.deepEqual(copy.body.context.assetCashflows, unknown);
    assert.equal(
      (await request(`${collection}/${copy.body.id}/asset-cashflows`)).body.results.length,
      0,
    );
    assert.equal(
      (await request(`${collection}/${copy.body.id}/asset-cashflows/${missing.id}`)).status,
      404,
    );
    const copiedInput = structuredClone(copy.body.context.assetCashflows);
    copiedInput.assets[0].amount = '2000';
    const copied = await request(`${collection}/${copy.body.id}/asset-cashflows`, 'PUT', {
      expectedRevision: copy.body.revision,
      input: copiedInput,
    });
    assert.equal(copied.status, 200);
    const comparison = await request(
      `${collection}/compare?left=${saved.id}&right=${copy.body.id}`,
    );
    assert.equal(comparison.status, 200);
    assert.ok(
      comparison.body.differences.some(
        (d) => d.section === '资产与资本收付' && d.path.includes('amount'),
      ),
    );
  },
);

test(
  'station budget reconciliation splits batteries and connection once and financial edits preserve adoptable physical evidence',
  { timeout: 240000 },
  async (t) => {
    const { startVehicleEnergyApplication } = await import('./helpers/vehicle-energy-fixture.mjs');
    const { repeatableFixture } = await import('./helpers/repeatable-day-fixture.mjs');
    const { stationNetworkInputs, waitDailyTransportTask } =
      await import('./helpers/daily-transport-fixture.mjs');
    const { financeInput } = await import('./helpers/operating-cashflows-fixture.mjs');
    const { request } = await startVehicleEnergyApplication(t);
    const model = await repeatableFixture(request);
    const network = stationNetworkInputs(model.scenario.context.stationNetwork);
    network.stationTypes[0].investment = 1000;
    network.sites[0].connection.connectionInvestment = 200;
    network.constraints = {
      maxInvestment: 1200,
      maxStations: 1,
      requiredSiteIds: [],
      excludedSiteIds: [],
    };
    await model.save('/station-network', 'PUT', { network });
    const reconfirmed = stationNetworkInputs(model.scenario.context.stationNetwork);
    reconfirmed.sites[0].connection.confirmed = true;
    await model.save('/station-network', 'PUT', { network: reconfirmed });
    const demandId = model.scenario.context.transportDemands[0].id;
    await model.save('/annual-transport', 'PUT', {
      years: [2030, 2031, 2032].map((year) => ({
        year,
        operatingDays: 1,
        demands: [{ demandId, dailyTonnes: 10 }],
      })),
    });
    await model.prepare();
    const started = await request(`${model.path}/annual-transport`, 'POST', {
      expectedRevision: model.scenario.revision,
    });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const source = await waitDailyTransportTask(request, model.path, started.body.task.taskId);
    assert.equal(source.annualResult.complete, true);
    assert.equal(source.annualResult.years[1].reusedFromYear, 2030);
    const input = assetInput();
    input.assets = [input.assets[0]];
    const battery = input.assets[0];
    battery.amount = '300';
    battery.siteId = network.sites[0].id;
    battery.budgetBucket = 'station';
    input.assets.push(
      {
        ...battery,
        name: '站房设备',
        category: 'station',
        amount: '700',
        replacements: [],
        residual: { year: 2032, amount: '0', source: '零' },
      },
      {
        ...battery,
        name: '接电工程',
        category: 'connection',
        budgetBucket: 'connection',
        amount: '200',
        replacements: [],
        residual: { year: 2032, amount: '0', source: '零' },
      },
    );
    await model.save('/asset-cashflows', 'PUT', { input });
    const calc = await request(`${model.path}/asset-cashflows`, 'POST', {
      expectedRevision: model.scenario.revision,
    });
    assert.equal(calc.body.complete, true, JSON.stringify(calc.body));
    assert.equal(calc.body.years[0].investmentCents, 120000);
    assert.equal(calc.body.years[0].outflowCents, 130000);
    assert.deepEqual(
      calc.body.reconciliation.map((r) => [r.budgetCents, r.classifiedCents, r.differenceCents]),
      [
        [100000, 100000, 0],
        [20000, 20000, 0],
      ],
    );
    const operating = financeInput();
    operating.years = [2030, 2031, 2032].map((year) => ({
      ...structuredClone(operating.years[0]),
      year,
      electricity: [
        {
          powerSourceId: network.powerSources[0].id,
          payer: 'station',
          windows: [{ startMinute: 0, endMinute: 1440, rate: '1', source: '电价' }],
        },
      ],
    }));
    await model.save('/operating-cashflows', 'PUT', { input: operating });
    const adopted = await request(`${model.path}/operating-cashflows`, 'POST', {
      expectedRevision: model.scenario.revision,
      sourceTaskId: source.taskId,
    });
    assert.equal(adopted.status, 201, JSON.stringify(adopted.body));
    assert.equal(adopted.body.complete, true);
    assert.equal(adopted.body.sourceInputVersion, source.inputVersion);
    assert.deepEqual(
      (await request(`${model.path}/annual-transport/${source.taskId}`)).body,
      source,
    );
    const duplicate = structuredClone(model.scenario.context.assetCashflows);
    duplicate.assets[0].amount = '1000';
    await model.save('/asset-cashflows', 'PUT', { input: duplicate });
    const mismatch = (
      await request(`${model.path}/asset-cashflows`, 'POST', {
        expectedRevision: model.scenario.revision,
      })
    ).body;
    assert.equal(mismatch.complete, false);
    assert.equal(mismatch.reconciliation[0].differenceCents, 70000);
    assert.equal(mismatch.years[0].outflowCents, null);
    // Asset correction cannot relax the existing physical hard budget.
    const changedNetwork = stationNetworkInputs(model.scenario.context.stationNetwork);
    changedNetwork.stationTypes[0].investment = 1700;
    await model.save('/station-network', 'PUT', { network: changedNetwork });
    const refused = await request(`${model.path}/operating-cashflows`, 'POST', {
      expectedRevision: model.scenario.revision,
      sourceTaskId: source.taskId,
    });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /物理输入/);
  },
);

test(
  'asset unknowns, overflow, stale override targets and unrecovered final working capital remain explicit',
  { timeout: 180000 },
  async (t) => {
    const { request, path, scenario } = await startAssetApplication(t);
    let saved = (
      await request(`${path}/asset-cashflows`, 'PUT', {
        expectedRevision: scenario.revision,
        input: assetInput(),
      })
    ).body;
    const input = saved.context.assetCashflows;
    input.workingCapital[0].years[2].balance = '120';
    input.assets[0].replacements[0].amount = '999999999999';
    // Per-line amounts remain safe but 101 distinct rows overflow the aggregate.
    input.assets = Array.from({ length: 101 }, (_, i) => ({
      ...structuredClone(input.assets[0]),
      id: i ? '' : input.assets[0].id,
      name: `资产${i}`,
      amount: '999999999999',
    }));
    saved = (
      await request(`${path}/asset-cashflows`, 'PUT', { expectedRevision: saved.revision, input })
    ).body;
    const result = (
      await request(`${path}/asset-cashflows`, 'POST', { expectedRevision: saved.revision })
    ).body;
    assert.equal(result.complete, false);
    assert.equal(result.years[0].outflowCents, null);
    assert.match(result.years[0].issues.join('；'), /超出/);
    assert.equal(result.years[2].workingCapital[0].releaseCents, 0);
    const stale = structuredClone(saved.context.assetCashflows);
    stale.assets = stale.assets.slice(0, 1);
    stale.assets[0].amount = '1000';
    stale.assets[0].replacements = [];
    stale.overrides = [
      {
        assetId: stale.assets[0].id,
        year: 2031,
        kind: 'replacement',
        amount: '0',
        reason: '目标被移除',
        source: '修订',
      },
    ];
    const stored = await request(`${path}/asset-cashflows`, 'PUT', {
      expectedRevision: saved.revision,
      input: stale,
    });
    assert.equal(stored.status, 200);
    const missing = (
      await request(`${path}/asset-cashflows`, 'POST', { expectedRevision: stored.body.revision })
    ).body;
    assert.equal(missing.complete, false);
    assert.match(missing.issues.join('；'), /覆盖目标失效/);
    assert.equal(missing.years[1].outflowCents, null);
  },
);
