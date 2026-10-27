import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { startApplication, jsonRequest } from './helpers/application.mjs';
import { assertOverview, openRouteFromSidebar, goTask } from './helpers/browser-navigation.mjs';

// Only the Amap service boundary is controlled; every project, point and route uses real application HTTP and SQLite.
test('project library management preserves an existing route and its valid complete result', { timeout: 120000 }, async () => {
  const drivingRequests = [];
  const upstream = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    drivingRequests.push(url);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ status: '1', route: { paths: [{ distance: '1234', steps: [{ polyline: `${url.searchParams.get('origin')};${url.searchParams.get('destination')}` }] }] } }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  let app, browser;
  try {
    app = await startApplication({
      HAULPATH_TEST_MODE: '1', AMAP_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
      AMAP_WEB_SERVICE_KEY: 'resource-test-key', AMAP_JS_KEY: '', AMAP_JS_SECURITY_CODE: '',
    });
    const request = async (path, method, body) => {
      const result = await jsonRequest(app.baseUrl, path, method, body);
      assert.ok(result.status < 300, JSON.stringify(result));
      return result.body;
    };
    const project = await request('/api/projects', 'POST', { name: '项目资源独立维护' });
    const coordinates = await request('/api/coordinates', 'POST', { points: [
      { name: '上海仓', longitude: 121.47, latitude: 31.23, source: 'manual' },
      { name: '苏州客户', longitude: 120.58, latitude: 31.3, source: 'manual' },
    ] });
    const library = await request(`/api/projects/${project.id}/points`, 'POST', { points: coordinates });
    const route = await request(`/api/projects/${project.id}/routes`, 'POST', {
      name: '已有有效方案的线路 A', strategy: 34,
      points: library.map((point) => ({ ...point, id: randomUUID(), source: 'library' })),
    });
    const routePath = `/api/routes/${route.id}?projectId=${project.id}`;
    const original = await request(`/api/routes/${route.id}/plan?projectId=${project.id}`, 'POST');
    assert.equal(original.snapshot.totalDistanceMeters, 1234);
    assert.equal(original.snapshot.inputVersion, original.inputVersion);
    const callsBeforeBrowsing = drivingRequests.length;

    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1050 } });
    const errors = [], browserPlanningRequests = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (event) => {
      if (event.method() === 'POST' && /\/api\/routes\/[^/]+\/plan\?/.test(event.url())) browserPlanningRequests.push(event.url());
    });
    await page.goto(app.baseUrl);
    await assertOverview(page);
    await openRouteFromSidebar(page, route.name);
    await page.getByRole('button', { name: '管理点位库', exact: false }).click();
    const resources = page.getByRole('region', { name: '项目点位库', exact: true });
    await resources.waitFor();
    assert.equal(await page.getByRole('region', { name: '线路编辑', exact: true, includeHidden: true }).count(), 0);
    assert.equal(await page.getByRole('region', { name: '高德地图', exact: true, includeHidden: true }).count(), 0);
    assert.equal(await page.getByRole('region', { name: '路线方案', exact: true, includeHidden: true }).count(), 0);
    assert.equal(await resources.getByRole('button', { name: /^将 .+ 选入当前线路$/ }).count(), 0, 'project resources do not retain the last route as an implicit selection target');

    await resources.getByRole('button', { name: `编辑点库点位 ${library[0].name}`, exact: true }).click();
    const edit = page.getByRole('dialog', { name: '编辑点位', exact: true });
    await edit.getByLabel('点位名称', { exact: true }).fill('上海仓新资料');
    await edit.getByLabel('经度', { exact: true }).fill('121.48');
    await edit.getByRole('button', { name: '确认保存点位', exact: true }).click();
    await edit.waitFor({ state: 'hidden' });
    await resources.getByRole('button', { name: '编辑点库点位 上海仓新资料', exact: true }).waitFor();
    assert.deepEqual(await request(routePath), original, 'editing project resources leaves all saved route inputs and its complete result unchanged');

    await resources.getByRole('button', { name: `删除点库点位 ${library[1].name}`, exact: true }).click();
    const deletion = page.getByRole('dialog', { name: '删除点库点位', exact: true });
    await deletion.getByRole('button', { name: '确认删除点位', exact: true }).click();
    await deletion.waitFor({ state: 'hidden' });
    const savedLibrary = await request(`/api/projects/${project.id}/points`);
    assert.deepEqual(savedLibrary.map((point) => point.name), ['上海仓新资料']);
    assert.equal(savedLibrary[0].longitude, 121.48);
    assert.deepEqual(await request(routePath), original, 'deleting a library point does not remove its route copy or invalidate the result');

    await openRouteFromSidebar(page, route.name);
    assert.equal(await page.getByRole('button', { name: '编排点位', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.deepEqual(await page.getByLabel('有序点位', { exact: true }).locator('strong').allTextContents(), ['上海仓', '苏州客户']);
    await goTask(page, '测算线路');
    assert.equal(await page.getByLabel('规划偏好', { exact: true }).inputValue(), '34');
    assert.equal(await page.getByRole('button', { name: '重新规划', exact: true }).isEnabled(), true);
    await goTask(page, '核对方案');
    assert.match(await page.getByRole('region', { name: '路线方案', exact: true }).innerText(), /1\.234/);
    assert.deepEqual(await request(routePath), original);
    assert.equal(drivingRequests.length, callsBeforeBrowsing, 'opening, managing resources and reviewing a saved route never calculate automatically');
    assert.deepEqual(browserPlanningRequests, []);
    assert.deepEqual(errors, []);

    const extraCoordinates = await request('/api/coordinates', 'POST', { points: Array.from({ length: 12 }, (_, index) => ({
      name: `长库选点 ${String(index + 1).padStart(2, '0')}`, longitude: 121 + index / 100, latitude: 31 + index / 100, source: 'manual',
    })) });
    const extraPoints = await request(`/api/projects/${project.id}/points`, 'POST', { points: extraCoordinates });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await assertOverview(page);
    await openRouteFromSidebar(page, route.name);
    await page.getByRole('button', { name: '从点位库选择', exact: true }).click();
    const context = resources.locator('.library-context');
    const targetName = context.getByText(route.name, { exact: true });
    const selectedCount = context.getByText('已添加 2 个点位', { exact: true });
    const returnButton = context.getByRole('button', { name: '返回线路点位', exact: true });
    await selectedCount.waitFor();
    const list = resources.getByRole('list', { name: '项目点位资料', exact: true });
    assert.equal(await list.getByRole('listitem').count(), 13);
    await page.evaluate(async () => { window.scrollTo(0, document.documentElement.scrollHeight); await new Promise(requestAnimationFrame); });
    await list.evaluate(async (element) => { element.scrollTop = element.scrollHeight; await new Promise(requestAnimationFrame); });
    assert.ok(await page.evaluate(() => window.scrollY > 0), 'the narrow viewport has reached the bottom of the page');
    assert.ok(await list.evaluate((element) => element.scrollTop > 0 && element.scrollTop + element.clientHeight >= element.scrollHeight - 1), 'the long point library has reached its final item');
    async function assertInViewport(locator, message) {
      const bounds = await locator.boundingBox();
      assert.ok(bounds && bounds.x >= -1 && bounds.y >= -1 && bounds.x + bounds.width <= 391 && bounds.y + bounds.height <= 845, `${message}: ${JSON.stringify(bounds)}`);
    }
    await assertInViewport(targetName, 'the destination route stays visible while browsing a long library');
    await assertInViewport(selectedCount, 'the current point count stays visible while browsing a long library');
    await assertInViewport(returnButton, 'returning to the route stays available at the end of the list');
    const lastPoint = extraPoints.at(-1);
    const lastSelect = list.getByRole('button', { name: `将 ${lastPoint.name} 选入当前线路`, exact: true });
    await assertInViewport(lastSelect, 'the final point selection action remains within the viewport');
    assert.equal(await lastSelect.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      return hit === element || element.contains(hit);
    }), true, 'the persistent route context does not cover the final point selection action');
    await lastSelect.click();
    await context.getByText('已添加 3 个点位', { exact: true }).waitFor();
    await assertInViewport(targetName, 'the destination remains visible after adding the last point');
    await assertInViewport(context.getByText('已添加 3 个点位', { exact: true }), 'the persistent point count updates immediately');
    await assertInViewport(returnButton, 'the return action remains visible after selecting the last point');
    await returnButton.click();
    await page.getByRole('heading', { name: route.name, exact: true }).waitFor();
    assert.deepEqual(await page.getByLabel('有序点位', { exact: true }).locator('strong').allTextContents(), ['上海仓', '苏州客户', lastPoint.name]);
    assert.equal((await request(routePath)).points.length, 3);
    assert.equal(drivingRequests.length, callsBeforeBrowsing, 'selecting a point still requires a manual recalculation');
    assert.deepEqual(browserPlanningRequests, []);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await app?.stop();
    await app?.cleanup();
    await new Promise((resolve) => upstream.close(resolve));
  }
});
