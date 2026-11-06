// Browser globals below are evaluated inside Playwright callbacks.
/* global document */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { startApplication, jsonRequest } from './helpers/application.mjs';
import { roadResponse } from './helpers/directed-road-fixture.mjs';
import {
  dailyTransportFixture,
  waitDailyTransportTask,
} from './helpers/daily-transport-fixture.mjs';

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

test(
  'daily plan survives closing the page and exposes vehicle time, partial loads and unmet demand',
  { timeout: 180000 },
  async () => {
    const upstream = createServer((incoming, response) =>
      roadResponse(new URL(incoming.url, 'http://127.0.0.1'), response, '10000'),
    );
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const app = await startApplication({
      AMAP_JS_KEY: '',
      AMAP_JS_SECURITY_CODE: '',
      HAULPATH_TEST_MODE: '1',
      AMAP_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
      AMAP_WEB_SERVICE_KEY: 'daily-browser-boundary',
    });
    const browser = await chromium.launch({
      channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || 'chrome',
      headless: true,
    });
    try {
      const request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
      const { project, scenario, path } = await dailyTransportFixture(request);
      let page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      let region = await openDailyPlan(page, app.baseUrl, project, scenario);
      const startedResponse = page.waitForResponse(
        (entry) =>
          entry.url().endsWith(`${path}/daily-transport`) && entry.request().method() === 'POST',
      );
      await region.getByRole('button', { name: '生成运输日计划', exact: true }).click();
      const started = await (await startedResponse).json();
      assert.ok(started.task.taskId);
      await page.close();
      await waitDailyTransportTask(request, path, started.task.taskId);
      page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      page.on('pageerror', (error) => errors.push(error.message));
      region = await openDailyPlan(page, app.baseUrl, project, scenario);
      await region.getByRole('heading', { name: '逐车时间轴', exact: true }).waitFor();
      assert.match(await region.innerText(), /补能校核未完成/);
      assert.match(await region.innerText(), /不能据此判断完整物理可行/);
      assert.match(await region.innerText(), /25\.000/);
      assert.match(await region.innerText(), /60\.000/);
      await region.getByText('核对车次与区间载荷', { exact: true }).click();
      const trips = region.getByRole('table', { name: '车次区间载荷', exact: true });
      assert.match(await trips.innerText(), /5\.000/);
      assert.match(await trips.innerText(), /10\.000/);
      const events = region.getByRole('table', { name: '车辆事件明细', exact: true });
      assert.match(await events.innerText(), /装货/);
      assert.match(await events.innerText(), /卸货/);
      assert.match(await events.innerText(), /运输/);
      assert.equal(
        await events.getByText('港区（第 1 位） → 堆场（第 2 位）', { exact: true }).count(),
        3,
      );
      assert.match(await events.innerText(), /08:00/);
      assert.match(await events.innerText(), /10:30/);
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
        true,
      );
      await page.setViewportSize({ width: 768, height: 1024 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
        true,
      );
      const changed = (
        await request(`${path}/demands`, 'PUT', {
          expectedRevision: scenario.revision,
          demands: scenario.context.transportDemands.map((demand) => ({
            ...demand,
            dailyTonnes: 30,
          })),
        })
      ).body;
      await page.getByRole('button', { name: '刷新规划方案', exact: true }).click();
      await region.getByText(/这是旧输入版本的保存结果/).waitFor();
      assert.match(
        await region.getByRole('table', { name: '需求完成量与缺口', exact: true }).innerText(),
        /25\.000/,
      );
      await region.getByLabel('核对已保存任务', { exact: true }).selectOption(started.task.taskId);
      await region
        .getByRole('heading', {
          name: `运输试算结果 · 输入版本 ${scenario.inputVersion}`,
          exact: true,
        })
        .waitFor();
      const frozen = await request(`${path}/freeze`, 'POST', {
        expectedRevision: changed.revision,
      });
      assert.equal(frozen.status, 200);
      await page.getByRole('button', { name: '刷新规划方案', exact: true }).click();
      await region.getByText('冻结版本只读，可复制为新草案调整。', { exact: true }).waitFor();
      assert.equal(
        await region.getByRole('button', { name: '生成运输日计划', exact: true }).isEnabled(),
        false,
      );
      assert.match(await region.innerText(), /25\.000/);
      await page.close();
      const limited = await dailyTransportFixture(request, {
        endMinute: 540,
        name: '工时不足验收',
      });
      page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      page.on('pageerror', (error) => errors.push(error.message));
      region = await openDailyPlan(page, app.baseUrl, limited.project, limited.scenario);
      const response = page.waitForResponse(
        (entry) =>
          entry.url().endsWith(`${limited.path}/daily-transport`) &&
          entry.request().method() === 'POST',
      );
      await region.getByRole('button', { name: '生成运输日计划', exact: true }).click();
      const task = await (await response).json();
      await waitDailyTransportTask(request, limited.path, task.task.taskId);
      await region.getByRole('heading', { name: '完成量与缺口', exact: true }).waitFor();
      const demandTable = region.getByRole('table', { name: '需求完成量与缺口', exact: true });
      assert.match(await demandTable.innerText(), /10\.000/);
      assert.match(await demandTable.innerText(), /15\.000/);
      assert.match(await demandTable.innerText(), /工时|班次|窗口|车队/);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await app.stop();
      await app.cleanup();
      upstream.closeAllConnections();
      await new Promise((resolve) => upstream.close(resolve));
    }
  },
);
