import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startAssetApplication } from './helpers/asset-cashflows-fixture.mjs';

import { emptyTaxInput, taxFixture } from './helpers/tax-cashflows-fixture.mjs';
test(
  'tax rules persist unknowns without publishing complete finance through generic context',
  { timeout: 180000 },
  async (t) => {
    const { request, path, scenario } = await startAssetApplication(t);
    const input = emptyTaxInput();
    const saved = await request(`${path}/tax-cashflows`, 'PUT', {
      expectedRevision: scenario.revision,
      input,
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(saved.body.context.taxCashflows, input);
    assert.equal(saved.body.inputVersion, scenario.inputVersion + 1);
    const same = await request(`${path}/tax-cashflows`, 'PUT', {
      expectedRevision: saved.body.revision,
      input,
    });
    assert.deepEqual(same.body, saved.body);
    const view = await request(`${path}/tax-cashflows`);
    assert.equal(view.status, 200);
    assert.match(view.body.issues.join('；'), /税务范围|税率|结转/);
    assert.deepEqual(view.body.results, []);
    const bypass = await request(path, 'PATCH', {
      expectedRevision: saved.body.revision,
      context: { ...saved.body.context, taxCashflows: { ...input, scopeSource: '绕过' } },
    });
    assert.equal(bypass.status, 400);
    assert.deepEqual((await request(path)).body, saved.body);
  },
);

test(
  'three-year tax ledger uses actual cash, historical remaining basis, replacement generations and losses once',
  { timeout: 240000 },
  async (t) => {
    const m = await taxFixture(t);
    await m.save('/tax-cashflows', 'PUT', { input: m.input });
    const result = await m.calculateTax();
    assert.equal(result.complete, true, JSON.stringify(result.issues));
    assert.equal(result.financingStatus, 'not-evaluated');
    assert.deepEqual(
      result.years.map((y) => [
        y.year,
        y.depreciationCents,
        y.taxableBeforeLossCents,
        y.lossUsedCents,
        y.lossClosingCents,
        y.projectCashflowCents,
      ]),
      [
        [2030, 60000, -40000, 0, 40000, -98000],
        [2031, 30000, 80000, 40000, 0, 116000],
        [2032, 30000, 140000, 0, 0, 147000],
      ],
    );
    assert.deepEqual(
      result.years.map((y) => [
        y.openingVatCreditCents,
        y.closingVatCreditCents,
        ...y.payments.map((p) => p.adoptedCents),
      ]),
      [
        [0, 8000, 0, 0, 0],
        [8000, 0, 4000, 10000, 0],
        [0, 0, 17000, 35000, 0],
      ],
    );
    assert.equal(result.operatingResult.id, m.operating.id);
    assert.equal(result.assetResult.id, m.assets.id);
    assert.equal(result.operatingResult.sourceTaskId, m.source.taskId);
    assert.equal((await m.request(`${m.path}/tax-cashflows/${result.id}`)).body.id, result.id);
    assert.deepEqual(
      (await m.request(`${m.path}/annual-transport/${m.source.taskId}`)).body,
      m.source,
    );
  },
);

test(
  'exclusive prices and denied credits affect cash and income basis; zero VAT and not-applicable remain distinct',
  { timeout: 240000 },
  async (t) => {
    const m = await taxFixture(t);
    const input = m.input;
    input.rules.find((r) => r.targetKey === 'operating:2030:freight').pricing = 'exclusive';
    input.rules.find((r) => r.targetKey === 'operating:2030:fixed').credit = 'denied';
    await m.save('/tax-cashflows', 'PUT', { input });
    const result = await m.calculateTax();
    assert.equal(result.complete, true, JSON.stringify(result));
    assert.deepEqual(
      result.years.map((y) => [y.taxableBeforeLossCents, y.projectCashflowCents]),
      [
        [-38000, -88000],
        [80000, 107500],
        [140000, 147000],
      ],
    );
    const freight = result.years[0].lines.find((l) => l.key === 'operating:2030:freight');
    assert.deepEqual(
      [freight.amountCents, freight.netCents, freight.grossCents, freight.vatCents],
      [110000, 110000, 121000, 11000],
    );
    const cost = result.years[0].lines.find((l) => l.key === 'operating:2030:fixed');
    assert.deepEqual([cost.creditCents, cost.incomeBasisCents], [0, 88000]);
    input.rules.forEach((r) => {
      r.pricing = 'not-applicable';
      r.vatRate = null;
      r.credit = 'not-applicable';
    });
    await m.save('/tax-cashflows', 'PUT', { input });
    const exempt = await m.calculateTax();
    assert.equal(exempt.complete, true);
    assert.deepEqual(
      exempt.years.map((y) => y.payments[0].adoptedCents),
      [0, 0, 0],
    );
    input.rules.find((r) => r.targetKey === 'operating:2030:freight').pricing = 'inclusive';
    input.rules.find((r) => r.targetKey === 'operating:2030:freight').vatRate = '0';
    await m.save('/tax-cashflows', 'PUT', { input });
    const zero = await m.calculateTax();
    assert.equal(zero.complete, true);
    assert.equal(zero.years[0].lines[0].rule.vatRate, '0');
    input.rules.find((r) => r.targetKey === 'operating:2030:freight').vatRate = null;
    await m.save('/tax-cashflows', 'PUT', { input });
    const missing = await m.calculateTax();
    assert.equal(missing.complete, false);
    assert.equal(missing.years[0].projectCashflowCents, null);
    assert.equal(missing.years[1].lossClosingCents, null);
  },
);

test(
  'loss expiry, zero carry, tax replacements and noncash depreciation keep independent baselines',
  { timeout: 240000 },
  async (t) => {
    const m = await taxFixture(t),
      input = m.input;
    input.openingLosses = [
      { originYear: 2024, amount: '70', source: '已到期历史亏损' },
      { originYear: 2026, amount: '100', source: '尚可用历史亏损' },
    ];
    input.overrides = [
      { year: 2031, kind: 'income', amount: '70', reason: '专项核定税额', source: '核定材料' },
      { year: 2032, kind: 'other', amount: '10', reason: '年度其他税费修订', source: '税费清单' },
    ];
    await m.save('/tax-cashflows', 'PUT', { input });
    const r = await m.calculateTax();
    assert.equal(r.complete, true);
    assert.deepEqual(
      r.years.map((y) => [
        y.lossOpeningCents,
        y.lossExpiredCents,
        y.lossUsedCents,
        y.lossAddedCents,
        y.lossClosingCents,
      ]),
      [
        [17000, 7000, 0, 40000, 50000],
        [50000, 0, 50000, 0, 0],
        [0, 0, 0, 0, 0],
      ],
    );
    assert.deepEqual(
      r.years[1].payments.map((p) => [p.kind, p.baseCents, p.adoptedCents]),
      [
        ['vat', 4000, 4000],
        ['income', 7500, 7000],
        ['other', 0, 0],
      ],
    );
    assert.equal(r.years[1].projectCashflowCents, 119000);
    assert.equal(r.years[2].taxableBeforeLossCents, 139000);
    assert.equal(r.years[2].projectCashflowCents, 146250);
    input.openingLosses = [];
    input.lossCarryYears = 0;
    input.overrides = [];
    await m.save('/tax-cashflows', 'PUT', { input });
    const noCarry = await m.calculateTax();
    assert.equal(noCarry.complete, true);
    assert.equal(noCarry.years[0].lossAddedCents, 0);
    assert.equal(noCarry.years[0].payments[1].adoptedCents, 0);
    assert.equal(noCarry.years[1].payments[1].adoptedCents, 20000);
    input.depreciation.find((d) => d.category === 'battery').start = 'next-year';
    await m.save('/tax-cashflows', 'PUT', { input });
    const delayed = await m.calculateTax();
    assert.equal(delayed.complete, true);
    assert.equal(delayed.years[0].depreciationCents, 10000);
    assert.equal(delayed.years[1].depreciationCents, 10000);
    assert.equal(
      delayed.years[1].depreciation.find((d) => d.disposalKind === 'disposal').disposedBasisCents,
      100000,
    );
    input.depreciation.find((d) => d.category === 'battery').start = 'service-year';
    input.depreciation.find((d) => d.category === 'battery').residualRate = '0.1';
    await m.save('/tax-cashflows', 'PUT', { input });
    const residual = await m.calculateTax();
    assert.equal(residual.complete, true);
    assert.deepEqual(
      residual.years.map((y) => y.depreciationCents),
      [55000, 28000, 28000],
    );
    assert.equal(
      residual.years[2].depreciation.find((d) => d.name === '周转电池').disposedBasisCents,
      4000,
    );
    assert.equal(residual.years[2].taxableBeforeLossCents, 138000);
  },
);

test(
  'tax input batches are atomic, versioned, isolated, frozen and copied without results; financial changes reuse physical evidence',
  { timeout: 240000 },
  async (t) => {
    const m = await taxFixture(t);
    await m.save('/tax-cashflows', 'PUT', { input: m.input });
    const original = await m.calculateTax();
    const saved = structuredClone(m.scenario);
    const put = (input) =>
      m.request(`${m.path}/tax-cashflows`, 'PUT', { expectedRevision: saved.revision, input });
    for (const mutate of [
      (a) => {
        a.rules[0].vatRate = '0.0000001';
      },
      (a) => {
        a.years.push(a.years[0]);
      },
      (a) => {
        a.overrides = [{ year: 2030, kind: 'income', amount: '2', reason: '', source: '依据' }];
      },
      (a) => {
        a.historicalAssets[0].assetId = 'foreign';
      },
      (a) => {
        a.extra = true;
      },
      (a) => {
        a.openingVatCredit = 0;
      },
    ]) {
      const input = structuredClone(m.input);
      mutate(input);
      assert.equal((await put(input)).status, 400);
      assert.deepEqual((await m.request(m.path)).body, saved);
    }
    assert.equal(
      (
        await m.request(`${m.path}/tax-cashflows`, 'POST', {
          expectedRevision: saved.revision - 1,
          operatingResultId: m.operating.id,
          assetResultId: m.assets.id,
        })
      ).status,
      409,
    );
    const other = (
      await m.request(`/api/projects/${m.project.id}/scenarios`, 'POST', { name: '另一方案' })
    ).body;
    const otherPath = `/api/projects/${m.project.id}/scenarios/${other.id}`;
    assert.equal((await m.request(`${otherPath}/tax-cashflows/${original.id}`)).status, 404);
    await m.request(`${otherPath}/tax-cashflows`, 'PUT', {
      expectedRevision: other.revision,
      input: emptyTaxInput(),
    });
    const otherSaved = (await m.request(otherPath)).body;
    assert.equal(
      (
        await m.request(`${otherPath}/tax-cashflows`, 'POST', {
          expectedRevision: otherSaved.revision,
          operatingResultId: m.operating.id,
          assetResultId: m.assets.id,
        })
      ).status,
      404,
    );
    const tax = structuredClone(m.input);
    tax.years[0].incomeTaxRate = '0.2';
    await m.save('/tax-cashflows', 'PUT', { input: tax });
    const latest = await m.calculateTax();
    assert.equal(latest.complete, true);
    assert.equal(latest.operatingResult.sourceTaskId, m.source.taskId);
    const adopted = await m.request(`${m.path}/operating-cashflows`, 'POST', {
      expectedRevision: m.scenario.revision,
      sourceTaskId: m.source.taskId,
    });
    assert.equal(adopted.status, 201);
    const copied = await m.request(`${m.path}/copy`, 'POST', {
      expectedRevision: m.scenario.revision,
      name: '税务复制',
    });
    assert.equal(copied.status, 201, JSON.stringify(copied.body));
    const copiedPath = `/api/projects/${m.project.id}/scenarios/${copied.body.id}`;
    assert.deepEqual(copied.body.context.taxCashflows, tax);
    assert.deepEqual((await m.request(`${copiedPath}/tax-cashflows`)).body.results, []);
    const changed = structuredClone(tax);
    changed.years[0].incomeTaxRate = '0.3';
    const copiedSaved = await m.request(`${copiedPath}/tax-cashflows`, 'PUT', {
      expectedRevision: copied.body.revision,
      input: changed,
    });
    assert.equal(copiedSaved.status, 200);
    const comparison = await m.request(
      `/api/projects/${m.project.id}/scenarios/compare?left=${saved.id}&right=${copied.body.id}`,
    );
    assert.equal(comparison.status, 200);
    assert.ok(
      comparison.body.differences.some(
        (d) => d.section === '税费与项目现金流' && d.path.includes('incomeTaxRate'),
      ),
    );
    const freeze = await m.request(`${m.path}/freeze`, 'POST', {
      expectedRevision: m.scenario.revision,
    });
    assert.equal(freeze.status, 200);
    assert.equal(
      (
        await m.request(`${m.path}/tax-cashflows`, 'PUT', {
          expectedRevision: freeze.body.revision,
          input: tax,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await m.request(`${m.path}/tax-cashflows`, 'POST', {
          expectedRevision: freeze.body.revision,
          operatingResultId: m.operating.id,
          assetResultId: m.assets.id,
        })
      ).status,
      409,
    );
    assert.deepEqual((await m.request(`${m.path}/tax-cashflows/${original.id}`)).body, original);
  },
);

test(
  'adopted sources reject stale prices, boundary and physical edits while tax rules can use older equivalent ledgers',
  { timeout: 240000 },
  async (t) => {
    const m = await taxFixture(t);
    await m.save('/tax-cashflows', 'PUT', { input: m.input });
    const old = await m.calculateTax();
    const prices = structuredClone(m.scenario.context.operatingCashflows);
    prices.years[0].lines[0].rate = '1200';
    await m.save('/operating-cashflows', 'PUT', { input: prices });
    const post = () =>
      m.request(`${m.path}/tax-cashflows`, 'POST', {
        expectedRevision: m.scenario.revision,
        operatingResultId: m.operating.id,
        assetResultId: m.assets.id,
      });
    assert.equal((await post()).status, 409);
    const op = await m.request(`${m.path}/operating-cashflows`, 'POST', {
      expectedRevision: m.scenario.revision,
      sourceTaskId: m.source.taskId,
    });
    assert.equal(op.status, 201);
    m.operating = op.body;
    const refreshed = await m.calculateTax();
    assert.equal(refreshed.complete, true);
    const network = (await import('./helpers/daily-transport-fixture.mjs')).stationNetworkInputs(
      m.scenario.context.stationNetwork,
    );
    network.stationTypes[0].investment = 1200;
    await m.save('/station-network', 'PUT', { network });
    const refused = await post();
    assert.equal(refused.status, 409);
    assert.deepEqual((await m.request(`${m.path}/tax-cashflows/${old.id}`)).body, old);
    // Boundary changes also require a compatible asset and operating source; no cross-boundary splice.
    prices.boundary = 'station-only';
    await m.save('/operating-cashflows', 'PUT', { input: prices });
    assert.equal((await post()).status, 409);
  },
);

test(
  'construction years require explicit zero-business declarations and do not invent missing operating evidence',
  { timeout: 240000 },
  async (t) => {
    const m = await taxFixture(t);
    const input = structuredClone(m.scenario.context.assetCashflows);
    input.initialYear = 2029;
    input.years.unshift(2029);
    input.assets
      .filter((a) => a.acquisition === 'new')
      .forEach((a) => {
        a.serviceYear = 2029;
      });
    input.workingCapital[0].years.unshift({ year: 2029, balance: '0', source: '建设年无营运占用' });
    await m.save('/asset-cashflows', 'PUT', { input });
    m.assets = (
      await m.request(`${m.path}/asset-cashflows`, 'POST', {
        expectedRevision: m.scenario.revision,
      })
    ).body;
    assert.equal(m.assets.complete, true, JSON.stringify(m.assets));
    const { taxInput } = await import('./helpers/tax-cashflows-fixture.mjs');
    const tax = taxInput(m.operating, m.assets);
    tax.years[0].activity = 'non-operating';
    tax.years[0].source = '首年建设，无经营收付';
    await m.save('/tax-cashflows', 'PUT', { input: tax });
    const result = await m.calculateTax();
    assert.equal(result.complete, true, JSON.stringify(result));
    assert.deepEqual(
      [
        result.years[0].operatingCashflowCents,
        result.years[0].capitalCashflowCents,
        result.years[0].projectCashflowCents,
        result.years[0].lossAddedCents,
      ],
      [0, -110000, -110000, 60000],
    );
    assert.deepEqual(
      result.years.map((y) => [y.period, y.timing]),
      [
        [0, 'year-end'],
        [1, 'year-end'],
        [2, 'year-end'],
        [3, 'year-end'],
      ],
    );
    tax.years[1].activity = 'non-operating';
    await m.save('/tax-cashflows', 'PUT', { input: tax });
    const missing = await m.calculateTax();
    assert.equal(missing.complete, false);
    assert.equal(missing.years[1].projectCashflowCents, null);
    assert.match(missing.years[1].issues.join('；'), /运营/);
  },
);

test(
  'half-cent tax rounding, unknown replacements and aggregate loss overflow do not silently become zero',
  { timeout: 240000 },
  async (t) => {
    const m = await taxFixture(t);
    const prices = structuredClone(m.scenario.context.operatingCashflows);
    prices.years[0].lines[0].rate = '0.005';
    await m.save('/operating-cashflows', 'PUT', { input: prices });
    m.operating = (
      await m.request(`${m.path}/operating-cashflows`, 'POST', {
        expectedRevision: m.scenario.revision,
        sourceTaskId: m.source.taskId,
      })
    ).body;
    const input = m.input;
    const rule = input.rules.find((r) => r.targetKey === 'operating:2030:freight');
    rule.pricing = 'exclusive';
    rule.vatRate = '0.5';
    await m.save('/tax-cashflows', 'PUT', { input });
    const rounded = await m.calculateTax();
    assert.equal(rounded.complete, true);
    const line = rounded.years[0].lines.find((l) => l.key === 'operating:2030:freight');
    assert.deepEqual([line.amountCents, line.vatCents, line.grossCents], [1, 1, 2]);
    input.overrides = [
      { year: 2031, kind: 'income', amount: null, reason: '核定金额尚未知', source: '待确认材料' },
    ];
    await m.save('/tax-cashflows', 'PUT', { input });
    const unknown = await m.calculateTax();
    assert.equal(unknown.complete, false);
    assert.equal(unknown.years[1].projectCashflowCents, null);
    assert.equal(unknown.years[2].lossClosingCents, null);
    input.overrides = [];
    input.lossCarryYears = 9999;
    input.openingLosses = Array.from({ length: 100 }, (_, i) => ({
      originYear: 1900 + i,
      amount: '999999999999',
      source: '大额历史剩余损失',
    }));
    await m.save('/tax-cashflows', 'PUT', { input });
    const overflow = await m.calculateTax();
    assert.equal(overflow.complete, false);
    assert.equal(overflow.years[0].lossOpeningCents, null);
    assert.equal(overflow.years[0].projectCashflowCents, null);
    assert.match(overflow.years[0].issues.join('；'), /超出/);
  },
);

test(
  'station-only tax ledger includes only the station boundary and cannot resurrect eliminated transport rows',
  { timeout: 240000 },
  async (t) => {
    const m = await taxFixture(t);
    const assets = structuredClone(m.scenario.context.assetCashflows);
    assets.boundary = 'station-only';
    await m.save('/asset-cashflows', 'PUT', { input: assets });
    const prices = structuredClone(m.scenario.context.operatingCashflows);
    prices.boundary = 'station-only';
    await m.save('/operating-cashflows', 'PUT', { input: prices });
    m.assets = (
      await m.request(`${m.path}/asset-cashflows`, 'POST', {
        expectedRevision: m.scenario.revision,
      })
    ).body;
    m.operating = (
      await m.request(`${m.path}/operating-cashflows`, 'POST', {
        expectedRevision: m.scenario.revision,
        sourceTaskId: m.source.taskId,
      })
    ).body;
    const { taxInput } = await import('./helpers/tax-cashflows-fixture.mjs');
    const tax = taxInput(m.operating, m.assets);
    tax.historicalAssets.forEach((h) =>
      Object.assign(h, {
        openingBasis: null,
        remainingYears: null,
        residualBasis: null,
        source: '',
      }),
    );
    Object.assign(
      tax.depreciation.find((d) => d.category === 'vehicle'),
      { years: null, residualRate: null, start: null, source: '' },
    );
    await m.save('/tax-cashflows', 'PUT', { input: tax });
    const r = await m.calculateTax();
    assert.equal(r.complete, true, JSON.stringify(r));
    assert.equal(r.years[0].projectCashflowCents, -206000);
    assert.equal(
      r.years[0].lines.some((l) => l.key === 'operating:2030:freight'),
      false,
    );
    assert.equal(
      r.years[0].lines.some((l) => l.key === 'operating:2030:swap'),
      true,
    );
    assert.equal(
      r.years[0].depreciation.some((d) => d.name === '已有车辆'),
      false,
    );
  },
);

test(
  'calendar gaps remain unknown instead of treating nonadjacent fiscal rows as continuous loss and credit carry',
  { timeout: 240000 },
  async (t) => {
    const m = await taxFixture(t);
    const years = structuredClone(m.scenario.context.annualTransport).filter(
      (y) => y.year !== 2031,
    );
    await m.save('/annual-transport', 'PUT', { years });
    await m.prepare();
    const started = await m.request(`${m.path}/annual-transport`, 'POST', {
      expectedRevision: m.scenario.revision,
    });
    const { waitDailyTransportTask } = await import('./helpers/daily-transport-fixture.mjs');
    m.source = await waitDailyTransportTask(m.request, m.path, started.body.task.taskId);
    const assets = structuredClone(m.scenario.context.assetCashflows);
    assets.years = [2030, 2032];
    assets.assets.forEach((a) => {
      a.replacements = [];
    });
    assets.workingCapital.forEach((w) => {
      w.years = w.years.filter((y) => y.year !== 2031);
    });
    await m.save('/asset-cashflows', 'PUT', { input: assets });
    const prices = structuredClone(m.scenario.context.operatingCashflows);
    prices.years = prices.years.filter((y) => y.year !== 2031);
    await m.save('/operating-cashflows', 'PUT', { input: prices });
    m.assets = (
      await m.request(`${m.path}/asset-cashflows`, 'POST', {
        expectedRevision: m.scenario.revision,
      })
    ).body;
    assert.equal(m.assets.complete, true);
    m.operating = (
      await m.request(`${m.path}/operating-cashflows`, 'POST', {
        expectedRevision: m.scenario.revision,
        sourceTaskId: m.source.taskId,
      })
    ).body;
    assert.equal(m.operating.complete, true);
    const { taxInput } = await import('./helpers/tax-cashflows-fixture.mjs');
    await m.save('/tax-cashflows', 'PUT', { input: taxInput(m.operating, m.assets) });
    const result = await m.calculateTax();
    assert.equal(result.complete, false);
    assert.match(result.issues.join('；'), /空档/);
    assert.deepEqual(
      result.years.map((y) => [y.period, y.projectCashflowCents, y.lossClosingCents]),
      [
        [0, null, null],
        [2, null, null],
      ],
    );
  },
);

test(
  'tax rule drafts support more than 1000 annual tariff targets and enforce the documented byte resource limit atomically',
  { timeout: 180000 },
  async (t) => {
    const { request, path, scenario } = await startAssetApplication(t);
    const input = emptyTaxInput();
    input.rules = Array.from({ length: 1200 }, (_, i) => ({
      targetKey: `electricity:${2030 + Math.floor(i / 60)}:power-${Math.floor(i / 3) % 20}:site-${Math.floor(i / 3) % 20}:${(i % 3) * 480}:${((i % 3) + 1) * 480}`,
      pricing: null,
      vatRate: null,
      credit: null,
      incomeTax: null,
      source: '',
    }));
    const saved = await request(`${path}/tax-cashflows`, 'PUT', {
      expectedRevision: scenario.revision,
      input,
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.context.taxCashflows.rules.length, 1200);
    assert.equal((await request(path)).body.context.taxCashflows.rules.length, 1200);
    const oversized = structuredClone(input);
    oversized.scopeSource = 'x'.repeat(8 * 1024 * 1024 + 1);
    const refused = await request(`${path}/tax-cashflows`, 'PUT', {
      expectedRevision: saved.body.revision,
      input: oversized,
    });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /8 MiB/);
    assert.deepEqual((await request(path)).body, saved.body);
  },
);
