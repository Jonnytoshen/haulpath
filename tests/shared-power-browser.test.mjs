/* global document */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { openDailyPlan, waitDailyTransportTask } from './helpers/daily-transport-fixture.mjs';
import { sharedPowerFixture, sharedPowerDistances } from './helpers/shared-power-fixture.mjs';
import { startVehicleEnergyApplication } from './helpers/vehicle-energy-fixture.mjs';

test(
  'daily plan starts shared charging and exposes source, station, and time-resolved purchase ledgers',
  { timeout: 180000 },
  async (t) => {
    const { app, request } = await startVehicleEnergyApplication(t, {
      extraDistances: sharedPowerDistances,
    });
    const model = await sharedPowerFixture(request, { endMinute: 920 });
    await model.prepare();
    const browser = await chromium.launch({
      channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || 'chrome',
      headless: true,
    });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const region = await openDailyPlan(page, app.baseUrl, model.project, model.scenario);
    const response = page.waitForResponse(
      (res) =>
        res.url().endsWith(`${model.path}/daily-transport`) && res.request().method() === 'POST',
    );
    await region
      .getByRole('button', { name: '生成共享电源试算', exact: true })
      .click({ timeout: 5000 });
    const started = await response;
    assert.equal(started.status(), 202, await started.text());
    assert.equal(started.request().postDataJSON().config.stage, 'shared-power');
    const task = await waitDailyTransportTask(
      request,
      model.path,
      (await started.json()).task.taskId,
    );
    const ledger = region.getByRole('region', { name: '共享电源账目', exact: true });
    await ledger.waitFor();
    assert.match(await region.innerText(), /共享电源校核通过/);
    assert.match(await region.innerText(), /24 小时周期尚未校核/);
    assert.match(await ledger.innerText(), /共享验收电源/);
    assert.match(await ledger.innerText(), /582\.222/);
    await ledger
      .getByRole('table', { name: '电源下各站占用', exact: true })
      .getByText('第二换电站', { exact: true })
      .waitFor();
    await ledger
      .getByRole('table', { name: '分时购电与功率', exact: true })
      .getByText(/09:22/)
      .first()
      .waitFor();
    const stations = region.getByRole('region', { name: '站内周转账目', exact: true });
    await stations.getByLabel('站址', { exact: true }).selectOption({ label: '第二换电站' });
    await stations.getByText(/^恒功率充电（/).click();
    await stations
      .getByRole('table', { name: '恒功率充电', exact: true })
      .getByText(/共享电源功率占用/)
      .waitFor();
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
      assert.ok(
        await ledger.getByRole('table', { name: '分时购电与功率', exact: true }).isVisible(),
      );
    }
    await model.saveStationType({ chargeWindows: [{ startMinute: 562, endMinute: 660 }] });
    await model.prepare();
    await page.setViewportSize({ width: 1440, height: 1000 });
    const changed = await openDailyPlan(page, app.baseUrl, model.project, model.scenario);
    const failedResponse = page.waitForResponse(
      (res) =>
        res.url().endsWith(`${model.path}/daily-transport`) && res.request().method() === 'POST',
    );
    await changed.getByRole('button', { name: '生成共享电源试算', exact: true }).click();
    const failedStart = await failedResponse;
    assert.equal(failedStart.status(), 202);
    await waitDailyTransportTask(
      request,
      model.path,
      (await failedStart.json()).task.taskId,
      'failed',
    );
    await changed
      .getByRole('status')
      .filter({ hasText: /共享电源.*充电窗口/ })
      .waitFor();
    await changed.getByText(/这是旧输入版本的保存结果/).waitFor();
    await page.reload();
    const reopened = await openDailyPlan(page, app.baseUrl, model.project, model.scenario);
    await reopened.getByRole('region', { name: '共享电源账目', exact: true }).waitFor();
    assert.deepEqual((await request(`${model.path}/daily-transport`)).body.resultTask, task);
    assert.deepEqual(errors, []);
  },
);
