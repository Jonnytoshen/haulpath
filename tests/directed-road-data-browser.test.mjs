// Browser globals below are evaluated inside Playwright callbacks.
/* global document */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { startApplication, jsonRequest } from './helpers/application.mjs';
import { roadResponse, waitRoadTask } from './helpers/directed-road-fixture.mjs';

const noMap = { AMAP_JS_KEY: '', AMAP_JS_SECURITY_CODE: '', AMAP_WEB_SERVICE_KEY: '' };
const launch = () =>
  chromium.launch({ channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || 'chrome', headless: true });

export async function openRoadScenario(page, baseUrl, project, scenario) {
  await page.goto(baseUrl);
  const expand = page.getByRole('button', { name: '展开项目与线路', exact: true });
  if (await expand.isVisible()) await expand.click();
  await page.getByRole('button', { name: project.name, exact: true }).click();
  if (await expand.isVisible()) await expand.click();
  await page.getByRole('button', { name: '规划方案', exact: true }).click();
  await page.getByRole('button', { name: `打开规划方案 ${scenario.name}`, exact: true }).click();
}

const point = (id, name, longitude, latitude) => ({
  id,
  name,
  longitude,
  latitude,
  originalLongitude: longitude,
  originalLatitude: latitude,
  coordinateSystem: 'GCJ-02',
  source: 'manual',
});

test(
  'closing a page preserves preparation, asymmetric roads are readable, and stopping retains reusable progress',
  { timeout: 150000 },
  async () => {
    let release = () => {};
    let gate = new Promise((resolve) => {
      release = resolve;
    });
    const calls = [];
    const upstream = createServer(async (incoming, response) => {
      const url = new URL(incoming.url, 'http://127.0.0.1');
      calls.push(url);
      await gate;
      roadResponse(
        url,
        response,
        url.searchParams.get('origin') === '121.470000,31.230000' ? '1001' : '2002',
      );
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const app = await startApplication({
      ...noMap,
      HAULPATH_TEST_MODE: '1',
      AMAP_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
      AMAP_WEB_SERVICE_KEY: 'browser-roads-boundary',
    });
    const browser = await launch();
    try {
      const request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
      const { project, scenario, path } = await fixture(request, '道路离页与停止验收');
      let page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await openRoadScenario(page, app.baseUrl, project, scenario);
      let region = page.getByRole('region', { name: '方案有向道路资料', exact: true });
      const startedResponse = page.waitForResponse(
        (entry) => entry.url().endsWith(`${path}/roads`) && entry.request().method() === 'POST',
      );
      await region.getByRole('button', { name: '准备缺失道路', exact: true }).click();
      const started = await (await startedResponse).json();
      assert.ok(started.task.taskId);
      await region.getByRole('button', { name: '停止道路准备', exact: true }).waitFor();
      await page.close();
      release();
      await waitRoadTask(request, path, started.task.taskId, 'completed');
      page = await browser.newPage({ viewport: { width: 768, height: 1024 } });
      page.on('pageerror', (error) => errors.push(error.message));
      await openRoadScenario(page, app.baseUrl, project, scenario);
      region = page.getByRole('region', { name: '方案有向道路资料', exact: true });
      await region.getByText('道路矩阵完整就绪', { exact: true }).waitFor();
      await region.getByText('核对有向道路（2 条）', { exact: true }).click();
      assert.match(await region.innerText(), /港区 → 堆场/);
      assert.match(await region.innerText(), /堆场 → 港区/);
      assert.match(await region.innerText(), /1\.001 km/);
      assert.match(await region.innerText(), /2\.002 km/);
      assert.match(await region.innerText(), /1,001 米/);
      assert.doesNotMatch(
        await page.getByRole('region', { name: '方案运输循环', exact: true }).innerText(),
        /缺少.*有向区间的有效道路资料/,
      );
      const reusedResponse = page.waitForResponse(
        (entry) => entry.url().endsWith(`${path}/roads`) && entry.request().method() === 'POST',
      );
      await region.getByRole('button', { name: '复用道路并核对', exact: true }).click();
      const reused = await (await reusedResponse).json();
      await waitRoadTask(request, path, reused.task.taskId, 'completed');
      assert.equal(calls.length, 2);
      const cycle = scenario.context.transportCycles[0];
      const changed = (
        await request(`${path}/cycles/${cycle.id}`, 'PATCH', {
          expectedRevision: scenario.revision,
          strategy: 36,
        })
      ).body;
      await page.getByRole('button', { name: '刷新规划方案', exact: true }).click();
      await region.getByText('道路资料待完善', { exact: true }).waitFor();
      gate = new Promise((resolve) => {
        release = resolve;
      });
      const pendingResponse = page.waitForResponse(
        (entry) => entry.url().endsWith(`${path}/roads`) && entry.request().method() === 'POST',
      );
      await region.getByRole('button', { name: '准备缺失道路', exact: true }).click();
      const pending = await (await pendingResponse).json();
      await region.getByRole('button', { name: '停止道路准备', exact: true }).click();
      await region.getByText('已停止', { exact: true }).waitFor();
      release();
      assert.equal((await request(`${path}/roads/${pending.task.taskId}`)).body.status, 'stopped');
      assert.equal((await request(path)).body.inputVersion, changed.inputVersion);
      const retriedResponse = page.waitForResponse(
        (entry) => entry.url().endsWith(`${path}/roads`) && entry.request().method() === 'POST',
      );
      await region.getByRole('button', { name: '准备缺失道路', exact: true }).click();
      const retried = await (await retriedResponse).json();
      await waitRoadTask(request, path, retried.task.taskId, 'completed');
      await region.getByText('道路矩阵完整就绪', { exact: true }).waitFor();
      assert.deepEqual(errors, []);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
        true,
      );
    } finally {
      release();
      await browser.close();
      await app.stop();
      await app.cleanup();
      upstream.closeAllConnections();
      await new Promise((resolve) => upstream.close(resolve));
    }
  },
);

async function fixture(request, name = '道路资料浏览器验收') {
  const project = (await request('/api/projects', 'POST', { name })).body;
  const route = (
    await request(`/api/projects/${project.id}/routes`, 'POST', {
      name: '港区往返',
      strategy: 35,
      points: [
        point('a', '港区', 121.47, 31.23),
        point('b', '堆场', 121.6, 31.3),
        point('a-return', '港区', 121.47, 31.23),
      ],
    })
  ).body;
  let scenario = (
    await request(`/api/projects/${project.id}/scenarios`, 'POST', { name: '道路准备草案' })
  ).body;
  const path = `/api/projects/${project.id}/scenarios/${scenario.id}`;
  scenario = (
    await request(`${path}/cycles`, 'POST', {
      sourceRouteId: route.id,
      expectedRevision: scenario.revision,
    })
  ).body;
  return { project, scenario, path };
}

test(
  'road preparation shows a persistent configuration failure and never labels an unfinished matrix ready',
  { timeout: 150000 },
  async () => {
    const app = await startApplication(noMap);
    const browser = await launch();
    try {
      const request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
      const { project, scenario, path } = await fixture(request);
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await openRoadScenario(page, app.baseUrl, project, scenario);
      const region = page.getByRole('region', { name: '方案有向道路资料', exact: true });
      await region.waitFor();
      assert.equal(await region.getByLabel('跨线接续驾车偏好', { exact: true }).inputValue(), '32');
      const response = page.waitForResponse(
        (entry) => entry.url().endsWith(`${path}/roads`) && entry.request().method() === 'POST',
      );
      await region.getByRole('button', { name: '准备缺失道路', exact: true }).click();
      assert.equal((await response).status(), 202);
      await region.getByText(/缺少高德 Web 服务 Key/).waitFor();
      assert.match(await region.innerText(), /准备失败/);
      assert.doesNotMatch(await region.innerText(), /完整就绪/);
      assert.match(await region.innerText(), /未校验重卡限高、限重及货车限行/);
      const view = (await request(`${path}/roads`)).body;
      assert.equal(view.task.status, 'failed');
      await page.reload();
      const expand = page.getByRole('button', { name: '展开项目与线路', exact: true });
      if (await expand.isVisible()) await expand.click();
      await page.getByRole('button', { name: '规划方案', exact: true }).click();
      await page
        .getByRole('button', { name: `打开规划方案 ${scenario.name}`, exact: true })
        .click();
      await region.getByText(/缺少高德 Web 服务 Key/).waitFor();
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
        true,
      );
    } finally {
      await browser.close();
      await app.stop();
      await app.cleanup();
    }
  },
);

test(
  'continuation preference saves only in the scenario and remains readable after freezing, copying and comparison',
  { timeout: 150000 },
  async () => {
    const app = await startApplication(noMap);
    const browser = await launch();
    try {
      const request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
      const { project, scenario, path } = await fixture(request, '道路偏好版本验收');
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      await openRoadScenario(page, app.baseUrl, project, scenario);
      const region = page.getByRole('region', { name: '方案有向道路资料', exact: true });
      const savedResponse = page.waitForResponse(
        (entry) =>
          entry.url().endsWith(`${path}/road-settings`) && entry.request().method() === 'PUT',
      );
      await region.getByLabel('跨线接续驾车偏好', { exact: true }).selectOption('36');
      const saved = await (await savedResponse).json();
      assert.equal(saved.inputVersion, scenario.inputVersion + 1);
      assert.equal(saved.context.roadSettings.continuationStrategy, 36);
      assert.equal(saved.context.transportCycles[0].strategy, 35);
      const inherited = (
        await request(`/api/projects/${project.id}/routes`, 'POST', { name: '核对项目记忆' })
      ).body;
      assert.equal(inherited.strategy, 35);
      await page.getByRole('button', { name: '冻结规划方案', exact: true }).click();
      const freezing = page.getByRole('dialog', { name: '冻结规划方案', exact: true });
      await freezing.getByRole('button', { name: '冻结版本', exact: true }).click();
      await freezing.waitFor({ state: 'hidden' });
      assert.equal(await region.getByLabel('跨线接续驾车偏好', { exact: true }).isEnabled(), false);
      assert.equal(
        await region.getByRole('button', { name: '准备缺失道路', exact: true }).isEnabled(),
        false,
      );
      assert.match(await region.innerText(), /冻结版本只读/);
      const frozen = (await request(path)).body;
      const copied = (
        await request(`${path}/copy`, 'POST', {
          expectedRevision: frozen.revision,
          name: '道路偏好新草案',
        })
      ).body;
      assert.deepEqual(copied.context.roadSettings, frozen.context.roadSettings);
      await page.getByRole('button', { name: '刷新规划方案', exact: true }).click();
      await page.getByRole('button', { name: `打开规划方案 ${copied.name}`, exact: true }).click();
      const copyPath = `/api/projects/${project.id}/scenarios/${copied.id}`;
      const changedResponse = page.waitForResponse(
        (entry) =>
          entry.url().endsWith(`${copyPath}/road-settings`) && entry.request().method() === 'PUT',
      );
      await region.getByLabel('跨线接续驾车偏好', { exact: true }).selectOption('32');
      assert.equal((await changedResponse).status(), 200);
      await page.getByRole('button', { name: '比较输入版本', exact: true }).click();
      const comparison = page.getByRole('dialog', { name: '比较输入版本', exact: true });
      await comparison.getByLabel('左侧版本', { exact: true }).selectOption(frozen.id);
      await comparison.getByLabel('右侧版本', { exact: true }).selectOption(copied.id);
      await comparison.getByRole('button', { name: '查看输入差异', exact: true }).click();
      await comparison.getByText(/跨线接续驾车偏好/).waitFor();
      assert.match(await comparison.innerText(), /少收费/);
      assert.match(await comparison.innerText(), /高德推荐/);
      assert.deepEqual((await request(path)).body, frozen);
    } finally {
      await browser.close();
      await app.stop();
      await app.cleanup();
    }
  },
);
