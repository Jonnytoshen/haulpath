import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startApplication, jsonRequest } from './helpers/application.mjs';
import { assertOverview, openRouteFromSidebar } from './helpers/browser-navigation.mjs';

async function openWorkbench(environment = {}) {
  const app = await startApplication({ AMAP_JS_KEY: '', AMAP_JS_SECURITY_CODE: '', AMAP_WEB_SERVICE_KEY: '', ...environment });
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || 'chrome', headless: true });
  const browserContext = await browser.newContext({ viewport: { width: 1600, height: 1050 } });
  const page = await browserContext.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return { app, browser, page, errors, async close() { await browser.close(); await app.stop(); await app.cleanup(); } };
}


test('planning completion updates a route after the planner opens another route', { timeout: 120000 }, async () => {
  const { createServer } = await import('node:http');
  let finishPlanning;
  let planningStarted;
  const started = new Promise((resolve) => { planningStarted = resolve; });
  const finish = new Promise((resolve) => { finishPlanning = resolve; });
  const upstream = createServer(async (_req, res) => {
    planningStarted();
    await finish;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: '1', route: { paths: [{ distance: '1001', steps: [{ polyline: '121.47,31.23;120.58,31.3' }] }] } }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  let context;
  try {
    context = await openWorkbench({ HAULPATH_TEST_MODE: '1', AMAP_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}`, AMAP_WEB_SERVICE_KEY: 'test-web-key' });
    const { page, app } = context;
    const request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
    const project = (await request('/api/projects', 'POST', { name: '切线规划项目' })).body;
    const routeA = (await request(`/api/projects/${project.id}/routes`, 'POST', { name: '规划中的线路 A' })).body;
    await request(`/api/projects/${project.id}/routes`, 'POST', { name: '继续编辑的线路 B' });
    const points = (await request('/api/coordinates', 'POST', { points: [
      { name: '上海起点', longitude: 121.47, latitude: 31.23, source: 'manual' },
      { name: '苏州终点', longitude: 120.58, latitude: 31.3, source: 'manual' },
    ] })).body;
    await request(`/api/routes/${routeA.id}?projectId=${project.id}`, 'PATCH', { points, expectedVersion: routeA.inputVersion });
    await page.goto(app.baseUrl);
    await assertOverview(page);
    await openRouteFromSidebar(page, routeA.name);
    await page.getByRole('heading', { name: routeA.name, exact: true }).waitFor();
    await page.getByRole('button', { name: '开始规划', exact: true }).click();
    await started;
    await page.getByRole('region', { name: '项目线路', exact: true }).locator('.route-item').filter({ hasText: '继续编辑的线路 B' }).click();
    await page.getByRole('heading', { name: '继续编辑的线路 B', exact: true }).waitFor();
    await page.getByRole('button', { name: '线路总览', exact: true }).click();
    const overview = await assertOverview(page);
    const rowA = overview.getByRole('row').filter({ has: page.getByRole('button', { name: routeA.name, exact: true }) });
    await rowA.getByText('规划中 0/1', { exact: true }).waitFor();
    await page.getByRole('button', { name: '线路工作台', exact: true }).click();
    await page.getByRole('heading', { name: '继续编辑的线路 B', exact: true }).waitFor();
    finishPlanning();
    await page.getByRole('region', { name: '项目线路', exact: true }).locator('.route-item').filter({ hasText: routeA.name }).getByText('已规划', { exact: true }).waitFor({ timeout: 10000 });
    assert.equal(await page.getByRole('heading', { name: '继续编辑的线路 B', exact: true }).isVisible(), true);
    assert.equal(await page.getByText('路线方案已完整保存', { exact: true }).count(), 0, 'completion on another route does not show a success notice for the current route');
    await page.getByRole('button', { name: '线路总览', exact: true }).click();
    await rowA.getByText('已规划', { exact: true }).waitFor();
    assert.equal(await rowA.getByRole('cell').nth(5).innerText(), '1.001');
    await page.getByRole('button', { name: '线路工作台', exact: true }).click();
    await page.getByRole('heading', { name: '继续编辑的线路 B', exact: true }).waitFor();
    assert.deepEqual(context.errors, []);
  } finally {
    finishPlanning();
    if (context) await context.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test('project refresh preserves saved routes when an older list response arrives', { timeout: 120000 }, async () => {
  const context = await openWorkbench();
  const { page, app } = context;
  let release;
  try {
    const project = (await jsonRequest(app.baseUrl, '/api/projects', 'POST', { name: '刷新与保存项目' })).body;
    await jsonRequest(app.baseUrl, `/api/projects/${project.id}/routes`, 'POST', { name: '保存前的线路' });
    await page.goto(app.baseUrl);
    await assertOverview(page);
    await openRouteFromSidebar(page, '保存前的线路');
    await page.getByRole('heading', { name: '保存前的线路', exact: true }).waitFor();
    let started;
    const ready = new Promise((resolve) => { started = resolve; });
    const held = new Promise((resolve) => { release = resolve; });
    let delayed = false;
    await page.route(`**/api/projects/${project.id}/routes`, async (pending) => {
      if (pending.request().method() !== 'GET' || delayed) return pending.continue();
      delayed = true;
      const response = await pending.fetch();
      started();
      await held;
      await pending.fulfill({ response });
    });
    await page.getByRole('button', { name: '刷新线路', exact: true }).click({ timeout: 5000 });
    await ready;
    await page.getByRole('button', { name: '重命名', exact: true }).click();
    await page.getByLabel('线路名称', { exact: true }).fill('已经保存的新名称');
    await page.getByRole('button', { name: '保存名称', exact: true }).click();
    await page.getByRole('heading', { name: '已经保存的新名称', exact: true }).waitFor();
    release();
    await page.waitForLoadState('networkidle');
    assert.deepEqual(await page.locator('.route-item-name').allTextContents(), ['已经保存的新名称']);
    assert.equal(await page.getByRole('heading', { name: '已经保存的新名称', exact: true }).isVisible(), true);
    assert.deepEqual(context.errors, []);
  } finally { release?.(); await context.close(); }
});

// These extend the verified refresh seam through real HTTP responses and UI writes.
test('delayed project refresh cannot remove a new route, revive a deleted route or restore a saved preference', { timeout: 120000 }, async () => {
  const context = await openWorkbench();
  const { page, app } = context;
  let release;
  try {
    const project = (await jsonRequest(app.baseUrl, '/api/projects', 'POST', { name: '写入竞争项目' })).body;
    const first = (await jsonRequest(app.baseUrl, `/api/projects/${project.id}/routes`, 'POST', { name: '已有线路' })).body;
    await page.goto(app.baseUrl);
    await assertOverview(page);
    await openRouteFromSidebar(page, first.name);
    await page.getByRole('heading', { name: first.name, exact: true }).waitFor();
    for (const action of ['preference', 'create', 'delete']) {
      let started;
      const ready = new Promise((resolve) => { started = resolve; });
      const held = new Promise((resolve) => { release = resolve; });
      let delayed = false;
      const pattern = `**/api/projects/${project.id}/routes`;
      await page.route(pattern, async (pending) => {
        if (pending.request().method() !== 'GET' || delayed) return pending.continue();
        delayed = true;
        const response = await pending.fetch(); started(); await held; await pending.fulfill({ response });
      });
      await page.getByRole('button', { name: '刷新线路', exact: true }).click(); await ready;
      if (action === 'preference') {
        await page.getByLabel('规划偏好', { exact: true }).selectOption('43');
        await page.waitForFunction(() => document.getElementById('strategy')?.value === '43' && !document.getElementById('strategy')?.disabled);
      } else if (action === 'create') {
        await page.getByRole('region', { name: '项目线路', exact: true }).getByRole('button', { name: '新建线路', exact: true }).click();
        await page.getByLabel('线路名称', { exact: true }).fill('刚创建的线路');
        await page.getByRole('button', { name: '创建线路', exact: true }).click();
        await page.getByRole('heading', { name: '刚创建的线路', exact: true }).waitFor();
      } else {
        await page.getByRole('region', { name: '线路编辑', exact: true }).getByRole('button', { name: '删除', exact: true }).click();
        await page.getByRole('button', { name: '确认删除', exact: true }).click();
        await page.getByRole('heading', { name: first.name, exact: true }).waitFor();
      }
      release(); await page.waitForLoadState('networkidle'); await page.unroute(pattern);
      const saved = (await jsonRequest(app.baseUrl, `/api/projects/${project.id}/routes`)).body;
      assert.deepEqual(await page.locator('.route-item-name').allTextContents(), saved.map((item) => item.name));
      assert.equal(saved.find((item) => item.id === first.id).strategy, 43);
      assert.equal(await page.getByLabel('规划偏好', { exact: true }).inputValue(), '43');
    }
    assert.deepEqual(context.errors, []);
  } finally { release?.(); await context.close(); }
});

test('returning to a project creates a new session that ignores old reads and errors', { timeout: 120000 }, async () => {
  const context = await openWorkbench();
  const { page, app } = context;
  let release;
  try {
    const projectA = (await jsonRequest(app.baseUrl, '/api/projects', 'POST', { name: '会话项目 A' })).body;
    const routeA = (await jsonRequest(app.baseUrl, `/api/projects/${projectA.id}/routes`, 'POST', { name: '会话 A 原名称' })).body;
    const projectB = (await jsonRequest(app.baseUrl, '/api/projects', 'POST', { name: '会话项目 B' })).body;
    await jsonRequest(app.baseUrl, `/api/projects/${projectB.id}/routes`, 'POST', { name: '会话 B 线路' });
    await page.goto(app.baseUrl);
    await assertOverview(page);
    await openRouteFromSidebar(page, routeA.name);
    await page.getByRole('heading', { name: routeA.name, exact: true }).waitFor();
    for (const outcome of ['success', 'error']) {
      let started;
      const ready = new Promise((resolve) => { started = resolve; });
      const held = new Promise((resolve) => { release = resolve; });
      let delayed = false;
      const pattern = `**/api/projects/${projectA.id}/routes`;
      await page.route(pattern, async (pending) => {
        if (pending.request().method() !== 'GET' || delayed) return pending.continue();
        delayed = true;
        const response = await pending.fetch(); started(); await held;
        if (outcome === 'error') await pending.abort('failed');
        else await pending.fulfill({ response });
      });
      await page.getByRole('button', { name: '刷新线路', exact: true }).click(); await ready;
      await page.getByRole('button', { name: projectB.name, exact: true }).click();
      await assertOverview(page);
      await openRouteFromSidebar(page, '会话 B 线路');
      await page.getByRole('heading', { name: '会话 B 线路', exact: true }).waitFor();
      const name = `会话 A 已保存 ${outcome}`;
      await jsonRequest(app.baseUrl, `/api/routes/${routeA.id}?projectId=${projectA.id}`, 'PATCH', { name });
      await page.getByRole('button', { name: projectA.name, exact: true }).click();
      await assertOverview(page);
      await openRouteFromSidebar(page, name);
      await page.getByRole('heading', { name, exact: true }).waitFor();
      release(); await page.waitForLoadState('networkidle'); await page.unroute(pattern);
      assert.deepEqual(await page.locator('.route-item-name').allTextContents(), [name]);
      assert.deepEqual((await page.getByRole('alert').allTextContents()).filter((text) => text.trim()), [], 'old project errors do not appear in the new session');
    }
    assert.deepEqual(context.errors, []);
  } finally { release?.(); await context.close(); }
});

test('running project refreshes stay serial, retain data on network failure and stop after completion', { timeout: 120000 }, async () => {
  const { createServer } = await import('node:http');
  let finishPlanning, planningStarted;
  const started = new Promise((resolve) => { planningStarted = resolve; });
  const finish = new Promise((resolve) => { finishPlanning = resolve; });
  const upstream = createServer(async (_req, res) => {
    planningStarted(); await finish;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: '1', route: { paths: [{ distance: '1001', steps: [{ polyline: '121.47,31.23;120.58,31.3' }] }] } }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  let context, release;
  try {
    context = await openWorkbench({ HAULPATH_TEST_MODE: '1', AMAP_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}`, AMAP_WEB_SERVICE_KEY: 'test-web-key' });
    const { page, app } = context;
    const project = (await jsonRequest(app.baseUrl, '/api/projects', 'POST', { name: '持续刷新项目' })).body;
    const routeA = (await jsonRequest(app.baseUrl, `/api/projects/${project.id}/routes`, 'POST', { name: '持续规划 A' })).body;
    await jsonRequest(app.baseUrl, `/api/projects/${project.id}/routes`, 'POST', { name: '保持选中 B' });
    const points = (await jsonRequest(app.baseUrl, '/api/coordinates', 'POST', { points: [
      { name: '上海', longitude: 121.47, latitude: 31.23, source: 'manual' },
      { name: '苏州', longitude: 120.58, latitude: 31.3, source: 'manual' },
    ] })).body;
    await jsonRequest(app.baseUrl, `/api/routes/${routeA.id}?projectId=${project.id}`, 'PATCH', { points, expectedVersion: routeA.inputVersion });
    await page.goto(app.baseUrl);
    await assertOverview(page);
    await openRouteFromSidebar(page, routeA.name);
    await page.getByRole('heading', { name: routeA.name, exact: true }).waitFor();
    let reads = 0, ready;
    const arrived = new Promise((resolve) => { ready = resolve; });
    const held = new Promise((resolve) => { release = resolve; });
    await page.route(`**/api/projects/${project.id}/routes`, async (pending) => {
      if (pending.request().method() !== 'GET') return pending.continue();
      reads++;
      if (reads !== 1) return pending.continue();
      await pending.fetch(); ready(); await held; await pending.abort('failed');
    });
    await page.getByRole('button', { name: '开始规划', exact: true }).click(); await started;
    await page.getByRole('region', { name: '项目线路', exact: true }).locator('.route-item').filter({ hasText: '保持选中 B' }).click();
    await arrived;
    await page.waitForTimeout(1250);
    assert.equal(reads, 1, 'a slow running-task refresh is not overlapped by another list read');
    release();
    await page.getByRole('alert').filter({ hasText: '读取项目线路失败' }).waitFor();
    assert.deepEqual(await page.locator('.route-item-name').allTextContents(), ['持续规划 A', '保持选中 B']);
    assert.equal(await page.getByRole('heading', { name: '保持选中 B', exact: true }).isVisible(), true);
    await page.waitForResponse((response) => response.url().endsWith(`/api/projects/${project.id}/routes`) && response.ok());
    await page.getByRole('alert').filter({ hasText: '读取项目线路失败' }).waitFor({ state: 'hidden' });
    finishPlanning();
    await page.locator('.route-item').filter({ hasText: routeA.name }).getByText('已规划', { exact: true }).waitFor();
    await page.waitForLoadState('networkidle');
    const completedReads = reads;
    await page.waitForTimeout(1250);
    assert.equal(reads, completedReads, 'a project without a running task stops timer reads');
    assert.equal(await page.getByRole('heading', { name: '保持选中 B', exact: true }).isVisible(), true);
    assert.deepEqual(context.errors, []);
  } finally {
    release?.(); finishPlanning();
    if (context) await context.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test('first list failure offers retry and native window focus refreshes saved project data', { timeout: 120000 }, async () => {
  const context = await openWorkbench();
  const { page, app } = context;
  let other;
  try {
    const project = (await jsonRequest(app.baseUrl, '/api/projects', 'POST', { name: '重试与聚焦项目' })).body;
    const route = (await jsonRequest(app.baseUrl, `/api/projects/${project.id}/routes`, 'POST', { name: '聚焦前名称' })).body;
    let first = true;
    await page.route(`**/api/projects/${project.id}/routes`, async (pending) => {
      if (first && pending.request().method() === 'GET') { first = false; return pending.abort('failed'); }
      return pending.continue();
    });
    await page.goto(app.baseUrl);
    await page.getByRole('alert').filter({ hasText: '读取项目线路失败' }).waitFor();
    assert.equal(await page.getByText('还没有线路', { exact: true }).count(), 0, 'failed initial loading is not an empty project');
    await page.getByRole('button', { name: '重试读取线路', exact: true }).click();
    await assertOverview(page);
    await openRouteFromSidebar(page, route.name);
    await page.getByRole('heading', { name: route.name, exact: true }).waitFor();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    other = await page.context().newPage(); await other.bringToFront();
    await page.waitForFunction(() => !document.hasFocus());
    await jsonRequest(app.baseUrl, `/api/routes/${route.id}?projectId=${project.id}`, 'PATCH', { name: '重新聚焦后名称' });
    await page.bringToFront();
    await page.getByRole('heading', { name: '重新聚焦后名称', exact: true }).waitFor();
    assert.deepEqual(await page.locator('.route-item-name').allTextContents(), ['重新聚焦后名称']);
    assert.deepEqual(context.errors, []);
  } finally { await other?.close(); await context.close(); }
});
