import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { startApplication, jsonRequest } from './helpers/application.mjs';
import { assertOverview, openRouteFromSidebar, goTask } from './helpers/browser-navigation.mjs';

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

async function openPlanner(handleUpstream) {
  const upstream = createServer(handleUpstream ?? ((_request, response) => response.end()));
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const app = await startApplication({ HAULPATH_TEST_MODE: '1', AMAP_JS_KEY: '', AMAP_JS_SECURITY_CODE: '', AMAP_WEB_SERVICE_KEY: 'overview-concurrency-test-key', AMAP_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}` });
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1050 } });
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  const request = async (path, method, body) => { const result = await jsonRequest(app.baseUrl, path, method, body); assert.ok(result.status < 300, JSON.stringify(result)); return result.body; };
  return { app, page, errors, request, async close() { await browser.close(); await app.stop(); await app.cleanup(); await new Promise((resolve) => upstream.close(resolve)); } };
}

async function createPoints(request, names) {
  return request('/api/coordinates', 'POST', { points: names.map((name, index) => ({ name, longitude: 121.47 - index * .1, latitude: 31.23 + index * .1, source: 'manual' })) });
}
function drivingResponse(response, distance) {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ status: '1', route: { paths: [{ distance: String(distance), steps: [{ polyline: '121.47,31.23;121.37,31.33' }] }] } }));
}
const overviewRow = (page, name) => page.getByRole('region', { name: '线路总览', exact: true }).getByRole('row').filter({ has: page.getByRole('button', { name, exact: true }) });

// Existing behavior is checked at the agreed browser → HTTP → SQLite seam; an initial green result is recorded as coverage, not an invented red phase.
test('a delayed planning response cannot finish or replace a newer browser task', { timeout: 120000 }, async () => {
  for (const outcome of ['success', 'failure']) {
    const oldCaptured = deferred(), releaseOld = deferred(), newStarted = deferred(), finishNew = deferred();
    let calls = 0;
    const context = await openPlanner(async (_request, response) => {
      if (++calls === 1) {
        if (outcome === 'failure') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ status: '0', infocode: '10003' })); }
        else drivingResponse(response, 1111);
      } else { newStarted.resolve(); await finishNew.promise; drivingResponse(response, 3333); }
    });
    const { app, page, request } = context;
    try {
      const project = await request('/api/projects', 'POST', { name: `迟到${outcome}项目` });
      const points = await createPoints(request, ['上海仓', '苏州客户']);
      const route = await request(`/api/projects/${project.id}/routes`, 'POST', { name: '新旧任务线路', points });
      await request(`/api/projects/${project.id}/routes`, 'POST', { name: '继续维护的B线路' });
      const planPath = `/api/routes/${route.id}/plan?projectId=${project.id}`;
      let posts = 0;
      await page.route(`**${planPath}`, async (pending) => {
        if (pending.request().method() !== 'POST' || ++posts !== 1) return pending.continue();
        const response = await pending.fetch(); oldCaptured.resolve(); await releaseOld.promise; await pending.fulfill({ response });
      });
      await page.goto(app.baseUrl); await assertOverview(page); await openRouteFromSidebar(page, route.name);
      await goTask(page, '测算线路');
      await page.getByRole('button', { name: '开始规划', exact: true }).click(); await oldCaptured.promise;
      await page.getByLabel('规划偏好', { exact: true }).selectOption('34');
      await page.waitForFunction(() => document.getElementById('strategy')?.value === '34' && !document.getElementById('strategy')?.disabled);
      await page.getByRole('button', { name: '开始规划', exact: true }).click(); await newStarted.promise;
      const delivered = page.waitForEvent('requestfinished', { predicate: (event) => event.method() === 'POST' && event.url().endsWith(planPath) });
      releaseOld.resolve(); await delivered;
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.getByRole('button', { name: '规划中 0/1', exact: true }).isDisabled(), true, `${outcome}: old response cleanup must leave the new task running`);
      assert.equal(await page.getByLabel('规划偏好', { exact: true }).inputValue(), '34');
      assert.deepEqual((await page.getByRole('alert').allTextContents()).filter((text) => text.trim()), []);
      await openRouteFromSidebar(page, '继续维护的B线路');
      await page.getByRole('button', { name: '线路总览', exact: true }).click(); await assertOverview(page);
      const row = overviewRow(page, route.name);
      await row.getByText('规划中 0/1', { exact: true }).waitFor();
      assert.equal(await row.getByRole('cell').nth(3).innerText(), '高速优先');
      finishNew.resolve();
      await row.getByText('已规划', { exact: true }).waitFor();
      assert.equal(await row.getByRole('cell').nth(5).innerText(), '3.333');
      const saved = await request(`/api/routes/${route.id}?projectId=${project.id}`);
      assert.equal(saved.strategy, 34); assert.equal(saved.snapshot.inputVersion, saved.inputVersion); assert.equal(saved.snapshot.totalDistanceMeters, 3333); assert.equal(saved.planning, null);
      await page.getByRole('button', { name: '线路工作台', exact: true }).click();
      await page.getByRole('heading', { name: '继续维护的B线路', exact: true }).waitFor();
      assert.equal(posts, 2); assert.equal(calls, 2); assert.deepEqual(context.errors, []);
    } finally { releaseOld.resolve(); finishNew.resolve(); await context.close(); }
  }
});

test('overview keeps result validity separate from a replan that fails after partial progress', { timeout: 120000 }, async () => {
  for (const state of ['valid', 'stale']) {
    const secondStarted = deferred(), finishRetry = deferred();
    let retry = false, retryCalls = 0;
    const context = await openPlanner(async (_request, response) => {
      if (!retry) return drivingResponse(response, 1001);
      if (++retryCalls === 1) return drivingResponse(response, 7777);
      secondStarted.resolve(); await finishRetry.promise;
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ status: '0', infocode: '10003' }));
    });
    const { app, page, request } = context;
    try {
      const project = await request('/api/projects', 'POST', { name: `动态${state}失败项目` });
      const points = await createPoints(request, ['上海仓', '苏州客户', '南京终点']);
      const route = await request(`/api/projects/${project.id}/routes`, 'POST', { name: '保留完整方案的A线路', points });
      await request(`/api/projects/${project.id}/routes`, 'POST', { name: '不接收A错误的B线路' });
      const previous = await request(`/api/routes/${route.id}/plan?projectId=${project.id}`, 'POST');
      assert.equal(previous.snapshot.totalDistanceMeters, 2002);
      await page.goto(app.baseUrl); await assertOverview(page); await openRouteFromSidebar(page, route.name);
      await goTask(page, '测算线路');
      if (state === 'stale') {
        await page.getByLabel('规划偏好', { exact: true }).selectOption('34');
        await page.waitForFunction(() => document.getElementById('strategy')?.value === '34' && !document.getElementById('strategy')?.disabled);
      }
      retry = true;
      await page.getByRole('button', { name: state === 'valid' ? '重新规划' : '开始规划', exact: true }).click(); await secondStarted.promise;
      await openRouteFromSidebar(page, '不接收A错误的B线路');
      await page.getByRole('button', { name: '线路总览', exact: true }).click(); await assertOverview(page);
      const row = overviewRow(page, route.name);
      await row.getByText('规划中 1/2', { exact: true }).waitFor();
      const time = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(previous.snapshot.calculatedAt));
      const assertResult = async () => {
        await row.getByText(state === 'valid' ? '已规划' : '待重算', { exact: true }).waitFor();
        assert.equal(await row.getByRole('cell').nth(5).innerText(), state === 'valid' ? '2.002' : '—');
        assert.equal(await row.getByRole('cell').nth(6).innerText(), state === 'valid' ? time : '—');
      };
      await assertResult();
      finishRetry.resolve();
      await row.getByText('最近规划失败', { exact: true }).waitFor(); await assertResult();
      assert.equal(await row.getByText('规划中 1/2', { exact: true }).count(), 0);
      const saved = await request(`/api/routes/${route.id}?projectId=${project.id}`);
      assert.deepEqual(saved.snapshot, previous.snapshot); assert.equal(saved.planning.status, 'failed'); assert.equal(saved.planning.completed, 1);
      assert.equal(saved.snapshot.inputVersion === saved.inputVersion, state === 'valid');
      await page.getByRole('button', { name: '线路工作台', exact: true }).click();
      await page.getByRole('heading', { name: '不接收A错误的B线路', exact: true }).waitFor();
      assert.deepEqual((await page.getByRole('alert').allTextContents()).filter((text) => text.trim()), [], 'A failures do not show as errors for selected B');
      assert.equal(retryCalls, 2); assert.deepEqual(context.errors, []);
    } finally { finishRetry.resolve(); await context.close(); }
  }
});

test('overview refresh failure and retry preserve the current comparison and scroll position', { timeout: 120000 }, async () => {
  const context = await openPlanner();
  const { app, page, request } = context;
  const captured = deferred(), release = deferred();
  try {
    const project = await request('/api/projects', 'POST', { name: '保留浏览条件项目' });
    const points = await createPoints(request, Array.from({ length: 20 }, (_, index) => `失败恢复验收点位${index + 1}号客户`));
    const route = await request(`/api/projects/${project.id}/routes`, 'POST', { name: '保留重点线路', points });
    for (let index = 1; index <= 12; index++) await request(`/api/projects/${project.id}/routes`, 'POST', { name: `保留草稿${String(index).padStart(2, '0')}` });
    let planningPosts = 0;
    page.on('request', (event) => { if (event.method() === 'POST' && /\/api\/routes\/[^/]+\/plan\?/.test(event.url())) planningPosts++; });
    await page.goto(app.baseUrl); const overview = await assertOverview(page);
    const search = page.getByLabel('搜索总览线路与点位', { exact: true });
    const status = page.getByLabel('结果状态筛选', { exact: true });
    const sort = page.getByLabel('总览排序', { exact: true });
    await search.fill('保留'); await status.selectOption('未规划'); await sort.selectOption('name-desc');
    await overviewRow(page, route.name).getByRole('button', { name: `展开 ${route.name} 的全部点位`, exact: true }).click();
    await page.setViewportSize({ width: 1280, height: 720 });
    const scroll = page.getByRole('region', { name: '线路总览表格', exact: true });
    await scroll.evaluate(async (element) => { element.scrollTo(120, 180); await new Promise(requestAnimationFrame); });
    const conditions = async () => ({ query: await search.inputValue(), status: await status.inputValue(), sort: await sort.inputValue(), expanded: await overview.getByRole('button', { name: /^收起 保留重点线路.* 的全部点位$/ }).getAttribute('aria-expanded'), position: await scroll.evaluate((element) => ({ left: element.scrollLeft, top: element.scrollTop })) });
    const before = await conditions();
    assert.ok(before.position.left > 0 && before.position.top > 0);
    const beforeNames = await overview.locator('tbody .overview-route-name').allTextContents();
    let failed = false;
    await page.route(`**/api/projects/${project.id}/routes`, async (pending) => {
      if (pending.request().method() !== 'GET' || failed) return pending.continue();
      failed = true; await pending.fetch(); captured.resolve(); await release.promise; await pending.abort('failed');
    });
    await page.getByRole('button', { name: '刷新线路', exact: true }).click(); await captured.promise; release.resolve();
    await page.getByRole('alert').filter({ hasText: '读取项目线路失败' }).waitFor();
    assert.deepEqual(await overview.locator('tbody .overview-route-name').allTextContents(), beforeNames);
    assert.deepEqual(await conditions(), before, 'a failed list read retains comparison controls, expanded points and both scroll offsets');
    await overview.getByText('13 / 13 条线路', { exact: true }).waitFor();
    const updatedName = '保留重点线路已由另一窗口改名';
    await request(`/api/routes/${route.id}?projectId=${project.id}`, 'PATCH', { name: updatedName });
    await page.getByRole('button', { name: '重试读取线路', exact: true }).click();
    await overviewRow(page, updatedName).waitFor();
    await page.getByRole('alert').filter({ hasText: '读取项目线路失败' }).waitFor({ state: 'hidden' });
    assert.deepEqual(await conditions(), before, 'successful retry updates data within the retained comparison');
    assert.deepEqual(await overview.locator('tbody .overview-route-name').allTextContents(), beforeNames.map((name) => name === route.name ? updatedName : name));
    assert.equal(planningPosts, 0); assert.deepEqual(context.errors, []);
  } finally { release.resolve(); await context.close(); }
});

test('planning completion invalidates an older list captured after the local POST began', { timeout: 120000 }, async () => {
  const planArrived = deferred(), releasePlan = deferred(), listArrived = deferred(), releaseList = deferred();
  const context = await openPlanner((_request, response) => drivingResponse(response, 1001));
  const { app, page, request } = context;
  try {
    const project = await request('/api/projects', 'POST', { name: '列表与规划结果竞争项目' });
    const points = await createPoints(request, ['上海仓', '苏州终点']);
    const route = await request(`/api/projects/${project.id}/routes`, 'POST', { name: '规划完成后保留新结果', points });
    await page.goto(app.baseUrl); await assertOverview(page); await openRouteFromSidebar(page, route.name);
    await goTask(page, '测算线路');
    await page.waitForLoadState('networkidle');
    await page.route(`**/api/routes/${route.id}/plan?projectId=${project.id}`, async (pending) => {
      planArrived.resolve(); await releasePlan.promise; await pending.continue();
    });
    let reads = 0;
    await page.route(`**/api/projects/${project.id}/routes`, async (pending) => {
      if (pending.request().method() !== 'GET' || ++reads !== 1) return pending.continue();
      const response = await pending.fetch();
      const captured = (await response.json()).find((item) => item.id === route.id);
      assert.equal(captured.snapshot, null); assert.equal(captured.planning, null);
      listArrived.resolve(); await releaseList.promise; await pending.fulfill({ response });
    });
    await page.getByRole('button', { name: '开始规划', exact: true }).click(); await planArrived.promise;
    await page.getByRole('button', { name: '刷新线路', exact: true }).click(); await listArrived.promise;
    releasePlan.resolve();
    await page.getByText('路线方案已完整保存', { exact: true }).waitFor();
    const sidebarRoute = page.getByRole('region', { name: '项目线路', exact: true }).locator('.route-item').filter({ hasText: route.name });
    await sidebarRoute.getByText('已规划', { exact: true }).waitFor();
    assert.equal((await request(`/api/routes/${route.id}?projectId=${project.id}`)).snapshot.totalDistanceMeters, 1001);
    releaseList.resolve();
    await page.waitForLoadState('networkidle');
    await sidebarRoute.getByText('已规划', { exact: true }).waitFor({ timeout: 3000 });
    await goTask(page, '核对方案');
    assert.match(await page.locator('.result-summary').innerText(), /1\.001/);
    assert.ok(reads >= 2, 'planning completion invalidates the held list and obtains a fresh project read');
    assert.deepEqual(context.errors, []);
  } finally { releasePlan.resolve(); releaseList.resolve(); await context.close(); }
});
