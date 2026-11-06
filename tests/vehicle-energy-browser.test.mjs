// Browser globals below are evaluated inside Playwright callbacks.
/* global document */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { operationInputs, waitDailyTransportTask } from './helpers/daily-transport-fixture.mjs';
import { waitRoadTask } from './helpers/directed-road-fixture.mjs';
import {
  startVehicleEnergyApplication,
  vehicleEnergyFixture,
} from './helpers/vehicle-energy-fixture.mjs';

async function openDailyPlan(page, baseUrl, project, scenario) {
  await page.goto(baseUrl);
  const expand = page.getByRole('button', { name: '展开项目与线路', exact: true });
  if (await expand.isVisible()) await expand.click();
  await page.getByRole('button', { name: project.name, exact: true }).click();
  if (await expand.isVisible()) await expand.click();
  await page.getByRole('button', { name: '规划方案', exact: true }).click();
  await page.getByRole('button', { name: `打开规划方案 ${scenario.name}`, exact: true }).click();
  await page.getByRole('button', { name: '每日计划', exact: true }).click();
  return page.getByRole('region', { name: '方案每日运输计划', exact: true });
}

async function prepare(request, path, revision) {
  const prepared = await request(`${path}/roads`, 'POST', { expectedRevision: revision });
  assert.equal(prepared.status, 202, JSON.stringify(prepared.body));
  await waitRoadTask(request, path, prepared.body.task.taskId, 'completed');
}

test(
  'daily plan shows checked swap evidence and preserves it when a later vehicle cannot reach the station',
  { timeout: 180000 },
  async (t) => {
    const { app, request } = await startVehicleEnergyApplication(t);
    const model = await vehicleEnergyFixture(request);
    const browser = await chromium.launch({
      channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || 'chrome',
      headless: true,
    });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let region = await openDailyPlan(page, app.baseUrl, model.project, model.scenario);
    const dailyTransportEndpoint = `${model.path}/daily-transport`;
    const responseFor = (method) =>
      page.waitForResponse(
        (response) =>
          response.url().endsWith(dailyTransportEndpoint) && response.request().method() === method,
      );

    await region
      .getByText(/^换电绕行限额/)
      .first()
      .click();
    await region.getByLabel('最多额外里程（km）', { exact: true }).fill('5');
    await region.getByLabel('最多额外行驶时间（分钟）', { exact: true }).fill('4');
    const savedResponse = responseFor('PUT');
    await region.getByRole('button', { name: '保存绕行限额', exact: true }).click();
    const saved = await savedResponse;
    assert.equal(saved.status(), 200, await saved.text());
    assert.deepEqual((await saved.json()).context.swapDetourLimits, {
      maxExtraMeters: 5000,
      maxExtraMinutes: 4,
    });

    // Limit edits change the input version. Adopt the same directed roads for that version.
    const scenario = (await request(model.path)).body;
    await prepare(request, model.path, scenario.revision);
    region = await openDailyPlan(page, app.baseUrl, model.project, scenario);

    async function startEnergy() {
      const response = responseFor('POST');
      await region.getByRole('button', { name: '生成车辆电量试算', exact: true }).click();
      const started = await response;
      assert.equal(started.status(), 202, await started.text());
      return waitDailyTransportTask(request, model.path, (await started.json()).task.taskId, null);
    }
    const checked = await startEnergy();
    assert.equal(checked.status, 'completed', checked.error ?? checked.status);
    assert.equal(checked.result.energyStatus, 'checked');

    await region.getByRole('heading', { name: /^车辆电量试算结果 · 输入版本/ }).waitFor();
    assert.match(await region.innerText(), /车辆电量校核通过/);
    assert.match(await region.innerText(), /工位.*库存.*共享电源.*周期.*尚未校核/);
    assert.match(await region.innerText(), /不能据此判断完整物理可行/);
    const events = region.getByRole('table', { name: '车辆事件明细', exact: true });
    const swap = events.getByRole('row').filter({ has: page.getByText('换电', { exact: true }) });
    await swap.waitFor();
    assert.match(await swap.innerText(), /人工确认换电站/);
    assert.match(await swap.innerText(), /09:16/);
    assert.match(await swap.innerText(), /09:22/);
    assert.match(await swap.innerText(), /56\.333\s*%[\s\S]*100\s*%/);
    const last = events
      .getByRole('row')
      .filter({ has: page.getByText('归位空驶', { exact: true }) });
    assert.match(await last.innerText(), /11:15/);
    assert.match(await last.innerText(), /30\s*%/);

    for (const [width, height] of [
      [768, 1024],
      [390, 844],
    ]) {
      await page.setViewportSize({ width, height });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
        true,
      );
    }
    const operations = operationInputs(scenario.context.operations);
    operations.vehicleGroups[0].fullKwhPerKm = 5;
    const update = await request(`${model.path}/operations`, 'PUT', {
      expectedRevision: scenario.revision,
      operations,
    });
    assert.equal(update.status, 200, JSON.stringify(update.body));
    await prepare(request, model.path, update.body.revision);
    await page.setViewportSize({ width: 1440, height: 1000 });
    region = await openDailyPlan(page, app.baseUrl, model.project, update.body);
    const failed = await startEnergy();
    assert.equal(failed.status, 'failed', failed.error ?? failed.status);
    await region.getByText(/十吨车.*装货港.*卸货场.*无法到站.*安全电量/).waitFor();
    await region.getByText(/这是旧输入版本的保存结果/).waitFor();
    await region
      .getByRole('heading', { name: `车辆电量试算结果 · 输入版本 ${checked.inputVersion}` })
      .waitFor();
    await swap.waitFor();
    assert.deepEqual(errors, []);
  },
);
