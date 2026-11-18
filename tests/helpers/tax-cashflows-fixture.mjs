import assert from 'node:assert/strict';
import { startVehicleEnergyApplication } from './vehicle-energy-fixture.mjs';
import { repeatableFixture } from './repeatable-day-fixture.mjs';
import { stationNetworkInputs, waitDailyTransportTask } from './daily-transport-fixture.mjs';
import { assetInput } from './asset-cashflows-fixture.mjs';
import { financeInput } from './operating-cashflows-fixture.mjs';

export function emptyTaxInput() {
  return {
    scopeSource: '',
    openingVatCredit: null,
    openingVatSource: '',
    lossCarryYears: null,
    lossSource: '',
    openingLosses: [],
    years: [],
    rules: [],
    depreciation: [],
    historicalAssets: [],
    overrides: [],
  };
}
export function taxInput(operating, assets) {
  const input = emptyTaxInput();
  Object.assign(input, {
    scopeSource: '独立算例规则适用；其他税费为零，无期初亏损，无其他税种；不代表地区税法',
    openingVatCredit: '0',
    openingVatSource: '期初无留抵',
    lossCarryYears: 5,
    lossSource: '算例约定五年结转',
  });
  input.years = assets.years.map(({ year }) => ({
    year,
    activity: 'operating',
    source: '采用实际年度业务',
    incomeTaxRate: '0.25',
    otherTax: '0',
    otherTaxDeductible: true,
    taxSource: '算例约定非地区法定值',
  }));
  const rule = (targetKey, expense) => ({
    targetKey,
    pricing: 'inclusive',
    vatRate: '0.1',
    credit: expense ? 'allowed' : 'not-applicable',
    incomeTax: 'included',
    source: '算例价税及扣除约定',
  });
  for (const y of operating.years) {
    for (const l of y.lines.filter((l) => l.treatment === 'included'))
      input.rules.push(rule(`operating:${y.year}:${l.id}`, l.direction === 'expense'));
    for (const l of y.electricity.filter((l) => l.treatment === 'included'))
      input.rules.push(
        rule(
          `electricity:${y.year}:${l.powerSourceId}:${l.stationId}:${l.startMinute}:${l.endMinute}`,
          true,
        ),
      );
  }
  for (const y of assets.years)
    for (const e of y.events.filter((e) => e.included))
      input.rules.push(
        rule(
          `capital:${y.year}:${e.assetId}:${e.kind}`,
          ['initial', 'replacement'].includes(e.kind),
        ),
      );
  input.depreciation = ['battery', 'connection', 'vehicle'].map((category) => ({
    category,
    years: category === 'connection' ? 0 : 2,
    residualRate: '0',
    start: 'service-year',
    source: '分类直线折旧约定',
  }));
  input.historicalAssets = assets.input.assets
    .filter((a) => a.acquisition === 'existing')
    .map((a) => ({
      assetId: a.id,
      openingBasis: '300',
      remainingYears: 3,
      residualBasis: '0',
      source: '显式确认期初剩余税基；非历史原值',
    }));
  return input;
}
export async function taxFixture(t, options = {}) {
  const startedApplication = await startVehicleEnergyApplication(t, options);
  const app = startedApplication.app;
  const request = async (...args) => {
    try {
      return await startedApplication.request(...args);
    } catch (error) {
      throw new Error(`Tax fixture request failed: ${args[0]}\n${app.logs()}`, { cause: error });
    }
  };
  const model = await repeatableFixture(request);
  const network = stationNetworkInputs(model.scenario.context.stationNetwork);
  network.stationTypes[0].investment = 1100;
  network.sites[0].connection.connectionInvestment = 0;
  await model.save('/station-network', 'PUT', { network });
  const confirmed = stationNetworkInputs(model.scenario.context.stationNetwork);
  confirmed.sites[0].connection.confirmed = true;
  await model.save('/station-network', 'PUT', { network: confirmed });
  const demandId = model.scenario.context.transportDemands[0].id;
  await model.save('/annual-transport', 'PUT', {
    years: [2030, 2031, 2032].map((year) => ({
      year,
      operatingDays: 1,
      demands: [{ demandId, dailyTonnes: 10 }],
    })),
  });
  await model.prepare();
  const start = await request(`${model.path}/annual-transport`, 'POST', {
    expectedRevision: model.scenario.revision,
  });
  assert.equal(start.status, 202, JSON.stringify(start.body));
  const source = await waitDailyTransportTask(request, model.path, start.body.task.taskId);
  assert.equal(source.annualResult.complete, true);
  const input = assetInput();
  input.assets = input.assets.slice(0, 2);
  const battery = input.assets[0];
  Object.assign(battery, {
    amount: '1100',
    siteId: network.sites[0].id,
    budgetBucket: 'station',
    replacements: [{ year: 2031, amount: '440', disposal: '110', source: '更换及回收合同' }],
    residual: { year: 2032, amount: '220', source: '末年回收' },
  });
  input.assets.push({
    ...structuredClone(battery),
    name: '零接电工程',
    category: 'connection',
    budgetBucket: 'connection',
    amount: '0',
    replacements: [],
    residual: { year: 2032, amount: '0', source: '明确零' },
  });
  await model.save('/asset-cashflows', 'PUT', { input });
  const assets = (
    await request(`${model.path}/asset-cashflows`, 'POST', {
      expectedRevision: model.scenario.revision,
    })
  ).body;
  assert.equal(assets.complete, true, JSON.stringify(assets));
  const prices = financeInput();
  prices.years = [2030, 2031, 2032].map((year, i) => {
    const row = financeInput(year).years[0];
    row.lines[0].basis = 'year';
    row.lines[0].rate = i ? '2200' : '1100';
    row.lines[1].rate = '0';
    row.lines[3].rate = i ? '550' : '880';
    row.electricity = [
      {
        powerSourceId: network.powerSources[0].id,
        payer: 'station',
        windows: [{ startMinute: 0, endMinute: 1440, rate: '0', source: '电费已纳入年度费用' }],
      },
    ];
    return row;
  });
  await model.save('/operating-cashflows', 'PUT', { input: prices });
  const operating = (
    await request(`${model.path}/operating-cashflows`, 'POST', {
      expectedRevision: model.scenario.revision,
      sourceTaskId: source.taskId,
    })
  ).body;
  assert.equal(operating.complete, true, JSON.stringify(operating));
  return Object.assign(model, {
    request,
    app,
    source,
    operating,
    assets,
    input: taxInput(operating, assets),
    async calculateTax() {
      const r = await request(`${model.path}/tax-cashflows`, 'POST', {
        expectedRevision: model.scenario.revision,
        operatingResultId: this.operating.id,
        assetResultId: this.assets.id,
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      return r.body;
    },
  });
}
