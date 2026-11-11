/* global document */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { openDailyPlan, waitDailyTransportTask } from './helpers/daily-transport-fixture.mjs';
import { repeatableFixture } from './helpers/repeatable-day-fixture.mjs';
import { startVehicleEnergyApplication } from './helpers/vehicle-energy-fixture.mjs';

test(
  'daily plan publishes a periodic candidate, explains cross-boundary states, and retains it after a failed retry',
  { timeout: 180000 },
  async (t) => {
    const { app, request } = await startVehicleEnergyApplication(t, {
      mode: process.env.HAULPATH_PERIODIC_TEST_MODE || 'dev',
    });
    const model = await repeatableFixture(request, { startMinute: 1320, endMinute: 1520 });
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
    await region.getByRole('button', { name: '校核 24 小时周期', exact: true }).click();
    const started = await response;
    assert.equal(started.status(), 202, await started.text());
    const task = await waitDailyTransportTask(
      request,
      model.path,
      (await started.json()).task.taskId,
    );
    const ledger = region.getByRole('region', { name: '24 小时周期账目', exact: true });
    await ledger.waitFor();
    assert.match(await region.innerText(), /周期闭合，完整物理校核通过/);
    assert.doesNotMatch(await region.innerText(), /周期尚未校核|首日出发与换入电池均按满电/);
    assert.match(await ledger.innerText(), /424/);
    assert.match(await ledger.innerText(), /227\.4/);
    assert.match(await ledger.innerText(), /378\.889/);
    assert.match(await ledger.innerText(), /151\.444/);
    await region.getByText(/^恒功率充电（/).click();
    await region
      .getByRole('table', { name: '恒功率充电', exact: true })
      .getByText(/前日 23:22/)
      .first()
      .waitFor();
    if (process.env.HAULPATH_PERIODIC_QA_DIR)
      await mkdir(process.env.HAULPATH_PERIODIC_QA_DIR, { recursive: true });
    for (const [width, height] of [
      [1440, 1000],
      [768, 1024],
      [390, 844],
    ]) {
      await page.setViewportSize({ width, height });
      await ledger.scrollIntoViewIfNeeded();
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
        true,
      );
      assert.ok(await ledger.getByRole('table', { name: '周期站内初末态' }).isVisible());
      if (process.env.HAULPATH_PERIODIC_QA_DIR) {
        await ledger.screenshot({
          path: `${process.env.HAULPATH_PERIODIC_QA_DIR}/ledger-${width}.png`,
        });
        await page.screenshot({
          path: `${process.env.HAULPATH_PERIODIC_QA_DIR}/periodic-${width}.png`,
          fullPage: true,
        });
      }
    }
    await model.saveStationType({ chargeWindows: [{ startMinute: 90, endMinute: 100 }] });
    await model.prepare();
    const changed = await openDailyPlan(page, app.baseUrl, model.project, model.scenario);
    const failResponse = page.waitForResponse(
      (res) =>
        res.url().endsWith(`${model.path}/daily-transport`) && res.request().method() === 'POST',
    );
    await changed.getByRole('button', { name: '校核 24 小时周期', exact: true }).click();
    const failStart = await failResponse;
    assert.equal(failStart.status(), 202);
    await waitDailyTransportTask(
      request,
      model.path,
      (await failStart.json()).task.taskId,
      'failed',
    );
    await changed
      .getByRole('status')
      .filter({ hasText: /未找到闭合.*不证明全局无解/ })
      .waitFor();
    await changed.getByText(/这是旧输入版本的保存结果/).waitFor();
    await page.reload();
    const reopened = await openDailyPlan(page, app.baseUrl, model.project, model.scenario);
    await reopened.getByRole('region', { name: '24 小时周期账目', exact: true }).waitFor();
    assert.deepEqual((await request(`${model.path}/daily-transport`)).body.resultTask, task);
    assert.deepEqual(errors, []);
  },
);
