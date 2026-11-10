// Browser globals below are evaluated inside Playwright callbacks.
/* global document */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { openDailyPlan, waitDailyTransportTask } from './helpers/daily-transport-fixture.mjs';
import { stationTurnoverFixture } from './helpers/station-turnover-fixture.mjs';
import { startVehicleEnergyApplication } from './helpers/vehicle-energy-fixture.mjs';

test(
  'daily plan exposes full-battery recovery and retains the ledger when the service window conflicts',
  { timeout: 180000 },
  async (t) => {
    const { app, request } = await startVehicleEnergyApplication(t);
    const model = await stationTurnoverFixture(request, { bays: 2, batteryInventory: 1 });
    await model.prepare();
    const browser = await chromium.launch({
      channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || 'chrome',
      headless: true,
    });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const endpoint = `${model.path}/daily-transport`;
    let region = await openDailyPlan(page, app.baseUrl, model.project, model.scenario);
    async function startTurnover() {
      const response = page.waitForResponse(
        (res) => res.url().endsWith(endpoint) && res.request().method() === 'POST',
      );
      await region.getByRole('button', { name: '生成站内周转试算', exact: true }).click();
      const started = await response;
      assert.equal(started.status(), 202, await started.text());
      assert.equal(started.request().postDataJSON().config.stage, 'station-turnover');
      return waitDailyTransportTask(request, model.path, (await started.json()).task.taskId, null);
    }

    const checked = await startTurnover();
    assert.equal(checked.status, 'completed', checked.error ?? checked.status);
    const heading = region.getByRole('heading', {
      name: `站内周转试算结果 · 输入版本 ${checked.inputVersion}`,
      exact: true,
    });
    await heading.waitFor();
    const ledger = region.getByRole('region', { name: '站内周转账目', exact: true });
    await ledger.waitFor();
    assert.match(await region.innerText(), /共享电源.*周期.*尚未校核/);
    assert.match(await region.innerText(), /不能据此判断完整物理可行/);
    const swaps = ledger.getByRole('table', { name: '换电与等待', exact: true });
    const waited = swaps.getByRole('row').filter({ hasText: '满电库存不足' });
    await waited.waitFor();
    assert.match(await waited.innerText(), /09:16/);
    assert.match(await waited.innerText(), /10:3[45]/);
    await ledger.getByText(/^恒功率充电（/).click();
    const charges = ledger.getByRole('table', { name: '恒功率充电', exact: true });
    const firstCharge = charges.getByRole('row').filter({ hasText: '09:22' });
    await firstCharge.waitFor();
    const chargeText = await firstCharge.innerText();
    assert.match(chargeText, /120/);
    assert.match(chargeText, /131/);
    assert.match(chargeText, /145\.556/);
    await ledger.getByText(/^库存流水（/).click();
    const inventory = ledger.getByRole('table', { name: '库存流水', exact: true });
    await inventory.getByText('充满入库', { exact: true }).first().waitFor();
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

    // Recharge completes after this new service window has closed.
    await model.saveStationType({ serviceWindows: [{ startMinute: 0, endMinute: 600 }] });
    await model.prepare();
    await page.setViewportSize({ width: 1440, height: 1000 });
    region = await openDailyPlan(page, app.baseUrl, model.project, model.scenario);
    const failed = await startTurnover();
    assert.equal(failed.status, 'failed', failed.error ?? failed.status);
    assert.equal(failed.result, null);
    await region.getByText(/人工确认换电站.*服务窗口/).waitFor();
    await region.getByText(/这是旧输入版本的保存结果/).waitFor();
    await heading.waitFor();
    await waited.waitFor();
    assert.deepEqual((await request(endpoint)).body.resultTask, checked);
    assert.deepEqual(errors, []);
  },
);
