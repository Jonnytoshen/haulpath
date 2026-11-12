/* global document, HTMLElement */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { openDailyPlan, waitDailyTransportTask } from './helpers/daily-transport-fixture.mjs';
import { repeatableFixture } from './helpers/repeatable-day-fixture.mjs';
import { startVehicleEnergyApplication } from './helpers/vehicle-energy-fixture.mjs';

test(
  'annual capacity can be edited, evaluated and inspected by year through the real page',
  { timeout: 240000 },
  async (t) => {
    const { app, request } = await startVehicleEnergyApplication(t, {
      mode: process.env.HAULPATH_ANNUAL_TEST_MODE || 'dev',
    });
    const model = await repeatableFixture(request);
    await model.prepare();
    const browser = await chromium.launch({
      channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || 'chrome',
      headless: true,
    });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await openDailyPlan(page, app.baseUrl, model.project, model.scenario);
    await page.getByRole('button', { name: '年度能力', exact: true }).click();
    const region = page.getByRole('region', { name: '方案年度运输能力', exact: true });
    await region.getByRole('button', { name: '编辑年度输入', exact: true }).click();
    await region.getByRole('button', { name: '添加评价年份', exact: true }).click();
    await region.getByLabel('第 1 行年份', { exact: true }).fill('2030');
    await region.getByLabel('第 1 行运营天数', { exact: true }).fill('300');
    await region.getByLabel('第 1 行需求 1 日吨数', { exact: true }).fill('10');
    await region.getByRole('button', { name: '添加评价年份', exact: true }).click();
    await region.getByLabel('第 2 行年份', { exact: true }).fill('2031');
    await region.getByLabel('第 2 行运营天数', { exact: true }).fill('200');
    await region.getByLabel('第 2 行需求 1 日吨数', { exact: true }).fill('20');
    const save = page.waitForResponse(
      (r) => r.url().endsWith(`${model.path}/annual-transport`) && r.request().method() === 'PUT',
    );
    await region.getByRole('button', { name: '保存年度输入', exact: true }).click();
    assert.equal((await save).status(), 200);
    // A new input version requires explicit road adoption even when every road is reusable.
    const saved = (await request(model.path)).body;
    await request(`${model.path}/roads`, 'POST', { expectedRevision: saved.revision });
    const { waitRoadTask } = await import('./helpers/directed-road-fixture.mjs');
    const roads = (await request(`${model.path}/roads`)).body;
    await waitRoadTask(request, model.path, roads.task.taskId, 'completed');
    await region.getByRole('button', { name: '刷新年度状态', exact: true }).click();
    const launch = page.waitForResponse(
      (r) => r.url().endsWith(`${model.path}/annual-transport`) && r.request().method() === 'POST',
    );
    await region.getByRole('button', { name: '逐年校核运输能力', exact: true }).click();
    const response = await launch;
    assert.equal(response.status(), 202, await response.text());
    await waitDailyTransportTask(request, model.path, (await response.json()).task.taskId);
    await region.getByRole('button', { name: '核对 2031 年', exact: true }).click();
    await region.getByRole('region', { name: '24 小时周期账目', exact: true }).waitFor();
    const summary = region.getByRole('table', { name: '逐年运输能力汇总', exact: true });
    assert.match(await summary.innerText(), /3,000/);
    assert.match(await summary.innerText(), /50%/);
    assert.match(await region.innerText(), /经济校核尚未就绪/);
    const qa = process.env.HAULPATH_ANNUAL_QA_DIR;
    if (qa) await mkdir(qa, { recursive: true });
    for (const [width, height] of [
      [1440, 1000],
      [768, 1024],
      [390, 844],
    ]) {
      await page.setViewportSize({ width, height });
      await summary.scrollIntoViewIfNeeded();
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
        true,
      );
      if (qa) {
        await page.evaluate(() => {
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        });
        await page.screenshot({ path: `${qa}/annual-${width}.png`, fullPage: true });
        await region
          .getByRole('heading', { name: '年度运输能力', exact: true })
          .scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${qa}/inputs-${width}.png`, fullPage: true });
      }
    }
    await page.reload();
    await openDailyPlan(page, app.baseUrl, model.project, saved);
    await page.getByRole('button', { name: '年度能力', exact: true }).click();
    await region.getByRole('table', { name: '逐年运输能力汇总', exact: true }).waitFor();
    assert.deepEqual(errors, []);
    await browser.close();
  },
);
