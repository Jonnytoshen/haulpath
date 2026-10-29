import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import ExcelJS from 'exceljs';
import { startApplication, jsonRequest } from './helpers/application.mjs';
import { replaceAmapSDK, amapBrowserScript } from './helpers/amap-browser.mjs';
import { assertOverview, goTask } from './helpers/browser-navigation.mjs';

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const overview = (page) => page.getByRole('region', { name: '线路总览', exact: true });
const summary = (page) => overview(page).getByRole('region', { name: '所选线路摘要', exact: true });
const list = (page) => overview(page).getByRole('region', { name: '地图线路列表', exact: true });
const canvas = (page) => overview(page).getByRole('region', { name: '线路总览地图', exact: true }).locator('[data-sdk-map="ready"]');
const preview = (page, name) => list(page).getByRole('button', { name: `预览 ${name}`, exact: true });
const routePath = (route) => `/api/routes/${route.id}?projectId=${route.projectId}`;
const planPath = (route) => `/api/routes/${route.id}/plan?projectId=${route.projectId}`;

function drivingResponse(response, url, distance = 1234) {
  const from = url.searchParams.get('origin').split(',').map(Number);
  const to = url.searchParams.get('destination').split(',').map(Number);
  const bend = [(from[0] + to[0]) / 2 + 0.017, (from[1] + to[1]) / 2 + 0.031];
  const polyline = [from, bend, to].map((point) => point.join(',')).join(';');
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ status: '1', route: { paths: [
    { distance: String(distance), steps: [{ polyline }] },
    { distance: '999999', steps: [{ polyline: '110,20;111,21' }] },
  ] } }));
}

async function openMap({ environment = {}, sdk = {}, handleUpstream } = {}) {
  const calls = [];
  const upstream = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1'); calls.push(url);
    if (handleUpstream) await handleUpstream(url, response, calls.length);
    else drivingResponse(response, url);
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const env = { HAULPATH_TEST_MODE: '1', AMAP_JS_KEY: 'acceptance-js-key', AMAP_JS_SECURITY_CODE: 'acceptance-js-code', AMAP_WEB_SERVICE_KEY: 'acceptance-web-key', AMAP_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}`, ...environment };
  let app = await startApplication(env);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  const sdkState = await replaceAmapSDK(page, sdk);
  const request = async (path, method, body) => { const result = await jsonRequest(app.baseUrl, path, method, body); assert.ok(result.status < 300, JSON.stringify(result)); return result.body; };
  return { get app() { return app; }, page, browser, calls, errors, sdkState, request,
    async restart(extra) { await app.stop(); app = await startApplication({ ...env, ...extra }, app.directory); },
    async close() { await browser.close(); await app.stop(); await app.cleanup(); await new Promise((resolve) => upstream.close(resolve)); },
  };
}

async function pointsFor(request, count = 3, offset = 0, prefix = '验收点') {
  return request('/api/coordinates', 'POST', { points: Array.from({ length: count }, (_, index) => ({
    name: `${prefix}${index + 1}`, longitude: 116 + offset + index * 0.03, latitude: 30 + offset / 3 + index * 0.02, source: 'manual',
  })) });
}
async function addRoute(context, project, name, points, planned = true) {
  const route = await context.request(`/api/projects/${project.id}/routes`, 'POST', { name, points });
  return planned ? context.request(planPath(route), 'POST') : route;
}
async function enterMap(context) {
  await context.page.goto(context.app.baseUrl); await assertOverview(context.page);
  await overview(context.page).getByRole('button', { name: '地图', exact: true }).click();
}
async function camera(page) { return canvas(page).evaluate((element) => ({ center: JSON.parse(element.dataset.sdkCenter), zoom: Number(element.dataset.sdkZoom) })); }
async function setCamera(page, center = [120, 28], zoom = 11) { await canvas(page).evaluate((element, value) => element.__sdkMap.setZoomAndCenter(value.zoom, value.center), { center, zoom }); }
async function refresh(page) {
  const response = page.waitForResponse((item) => item.request().method() === 'GET' && /\/api\/projects\/[^/]+\/routes$/.test(item.url()));
  await page.getByRole('button', { name: '刷新线路', exact: true }).click(); await response;
}
async function sdkLines(page) { return canvas(page).locator('[data-sdk-polyline]').evaluateAll((elements) => elements.map((element) => JSON.parse(element.dataset.sdkOptions))); }
async function expectPaths(page, routes) {
  const edges = (lines) => lines.flatMap((line) => line.path.slice(1).flatMap((to, index) => {
    const from = line.path[index];
    return JSON.stringify(from) === JSON.stringify(to) ? [] : [JSON.stringify([line.id, from, to])];
  })).sort();
  const expected = edges(routes.flatMap((route) => route.snapshot.legs.map((leg) => ({ id: route.id, path: leg.polyline }))));
  await page.waitForFunction((ids) => ids.every((id) => Array.from(document.querySelectorAll('[data-sdk-polyline]')).some((element) => JSON.parse(element.dataset.sdkOptions).extData.routeId === id)), routes.map((route) => route.id));
  const lines = await sdkLines(page);
  assert.deepEqual(edges(lines.map((line) => ({ id: line.extData.routeId, path: line.path }))), expected, 'the SDK receives all saved path edges and no invented connections, independently of overlay splitting');
}

// Confirmed seam: real browser → public HTTP → temporary SQLite; only external AMap boundaries are replaced.
test('missing map keys and SDK retry preserve usable route previews and persisted plans', { timeout: 120000 }, async () => {
  for (const missingKey of [true, false]) {
    const context = await openMap({ environment: missingKey ? { AMAP_JS_KEY: '' } : {}, sdk: { failures: missingKey ? 0 : 1 } });
    const { page, request } = context;
    try {
      const project = await request('/api/projects', 'POST', { name: '地图降级项目' });
      const points = await pointsFor(request, 20, 0, '很长的仓库与客户点位名称');
      const route = await addRoute(context, project, '可核对线路', points);
      const baseline = context.calls.length;
      if (!missingKey) await context.restart({ AMAP_WEB_SERVICE_KEY: '' });
      await enterMap(context);
      await preview(page, route.name).click();
      await summary(page).getByRole('heading', { name: route.name, exact: true }).waitFor();
      await summary(page).getByRole('button', { name: `展开 ${route.name} 的全部点位`, exact: true }).click();
      await page.getByLabel('搜索总览线路与点位', { exact: true }).fill('  可核对  ');
      await page.getByLabel('结果状态筛选', { exact: true }).selectOption('已规划');
      assert.match(await summary(page).innerText(), /23\.446/);
      if (missingKey) {
        await overview(page).getByRole('heading', { name: '配置高德地图，查看真实线路', exact: true }).waitFor();
        assert.equal(await canvas(page).count(), 0); assert.equal(context.sdkState.requests, 0);
      } else {
        await overview(page).getByRole('heading', { name: '暂时无法加载地图', exact: true }).waitFor();
        await overview(page).getByRole('button', { name: '重新加载地图', exact: true }).click();
        await canvas(page).waitFor(); await expectPaths(page, [route]);
        assert.equal(context.sdkState.requests, 2);
        assert.equal(await canvas(page).count(), 1);
        assert.equal(await canvas(page).locator('[data-sdk-marker]').count(), 20);
      }
      assert.equal(await page.getByLabel('搜索总览线路与点位', { exact: true }).inputValue(), '  可核对  ');
      assert.equal(await summary(page).getByRole('button', { name: `收起 ${route.name} 的全部点位`, exact: true }).getAttribute('aria-expanded'), 'true');
      await summary(page).getByRole('button', { name: '打开线路', exact: true }).click();
      await page.getByRole('region', { name: '线路编辑', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: '编排点位', exact: true }).getAttribute('aria-pressed'), 'true');
      assert.equal(context.calls.length, baseline);
      assert.deepEqual((await request(routePath(route))).snapshot, route.snapshot);
      assert.deepEqual(context.errors, []);
    } finally { await context.close(); }
  }
});

test('refresh replaces stale selected geometry and clears deleted or filtered previews without moving the camera', { timeout: 120000 }, async () => {
  const context = await openMap();
  const { page, request } = context;
  try {
    const project = await request('/api/projects', 'POST', { name: '失效与删除项目' });
    const points = await pointsFor(request);
    const selected = await addRoute(context, project, '被更新线路', points);
    const other = await addRoute(context, project, '保留线路', await pointsFor(request, 2, 2));
    const baseline = context.calls.length;
    await enterMap(context); await canvas(page).waitFor(); await expectPaths(page, [selected, other]);
    await canvas(page).locator('[data-sdk-polyline]').first().dispatchEvent('click');
    await summary(page).getByRole('heading', { name: selected.name, exact: true }).waitFor();
    assert.equal(await preview(page, selected.name).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByRole('region', { name: '线路编辑', exact: true }).count(), 0);
    const beforeLine = (await sdkLines(page)).find((line) => line.extData.routeId === selected.id);
    assert.equal(beforeLine.zIndex > (await sdkLines(page)).find((line) => line.extData.routeId === other.id).zIndex, true);
    await setCamera(page); const before = await camera(page);
    const retainedMap = await canvas(page).elementHandle();
    const renamed = await request(routePath(selected), 'PATCH', { strategy: 34, points: [points[2], points[0]] });
    await refresh(page);
    await summary(page).getByText('待重算', { exact: true }).waitFor();
    assert.deepEqual((await sdkLines(page)).map((line) => line.extData.routeId), [other.id]);
    assert.deepEqual(await canvas(page).locator('[data-sdk-marker]').evaluateAll((elements) => elements.map((element) => JSON.parse(element.dataset.sdkMarker))), renamed.points.map((point) => [point.longitude, point.latitude]));
    assert.match(await summary(page).innerText(), /高速优先/);
    assert.equal(await summary(page).locator('dd').filter({ hasText: /^—$/ }).count(), 2, 'stale distance and time stay empty');
    assert.deepEqual(await camera(page), before);
    assert.equal(await retainedMap.evaluate((element) => element === document.querySelector('[data-sdk-map="ready"]')), true, 'ordinary data refresh preserves the current SDK instance');
    await request(routePath(selected), 'DELETE'); await refresh(page);
    await summary(page).waitFor({ state: 'hidden' });
    assert.equal(await canvas(page).locator('[data-sdk-marker]').count(), 0);
    assert.deepEqual(await camera(page), before);
    await expectPaths(page, [other]);
    await preview(page, other.name).click();
    await page.getByLabel('搜索总览线路与点位', { exact: true }).fill('不存在');
    await overview(page).getByRole('heading', { name: '没有匹配的线路', exact: true }).waitFor();
    assert.equal(await summary(page).count(), 0);
    assert.equal(await page.locator('[data-sdk-polyline], [data-sdk-marker]').count(), 0);
    await overview(page).getByRole('button', { name: '清除搜索和筛选', exact: true }).click();
    await canvas(page).waitFor(); await expectPaths(page, [other]);
    assert.equal(await summary(page).count(), 0);
    assert.equal(context.calls.length, baseline); assert.deepEqual(context.errors, []);
  } finally { await context.close(); }
});

test('a partial replan and its failure keep the previous valid complete map and browsing view', { timeout: 120000 }, async () => {
  const secondLeg = deferred(), finish = deferred();
  const context = await openMap({ handleUpstream: async (url, response, call) => {
    if (call === 4) { secondLeg.resolve(); await finish.promise; response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ status: '0', infocode: '10003' })); }
    else drivingResponse(response, url, call > 2 ? 7777 : 1234);
  } });
  const { page, request } = context;
  try {
    const project = await request('/api/projects', 'POST', { name: '完整方案保留项目' });
    const route = await addRoute(context, project, '失败仍可核对', await pointsFor(request));
    await enterMap(context); await canvas(page).waitFor(); await preview(page, route.name).click();
    await setCamera(page, [118, 27], 10); const before = await camera(page);
    await summary(page).getByRole('button', { name: '打开线路', exact: true }).click();
    await goTask(page, '测算线路');
    await page.getByRole('button', { name: '重新规划', exact: true }).click();
    await secondLeg.promise;
    await page.getByRole('button', { name: '线路总览', exact: true }).click();
    await canvas(page).waitFor();
    await summary(page).getByText('规划中 1/2', { exact: true }).waitFor();
    await expectPaths(page, [route]);
    assert.match(await summary(page).innerText(), /2\.468/);
    assert.deepEqual(await camera(page), before);
    const retained = await canvas(page).elementHandle();
    finish.resolve();
    await summary(page).getByText('最近规划失败', { exact: true }).waitFor();
    await expectPaths(page, [route]);
    assert.match(await summary(page).innerText(), /已规划/);
    assert.match(await summary(page).innerText(), /2\.468/);
    assert.deepEqual(await camera(page), before);
    assert.equal(await retained.evaluate((element) => element === document.querySelector('[data-sdk-map="ready"]')), true);
    const saved = await request(routePath(route));
    assert.deepEqual(saved.snapshot, route.snapshot); assert.equal(saved.planning.status, 'failed');
    assert.equal(context.calls.length, 4); assert.deepEqual(context.errors, []);
  } finally { finish.resolve(); await context.close(); }
});

test('late SDK loading and disposed map clicks cannot mount or select an earlier project', { timeout: 120000 }, async () => {
  const context = await openMap();
  const { page, request } = context;
  const scriptArrived = deferred(), release = deferred();
  try {
    const projectA = await request('/api/projects', 'POST', { name: 'SDK会话 A' });
    const routeA = await addRoute(context, projectA, 'A项目方案', await pointsFor(request, 2));
    const projectB = await request('/api/projects', 'POST', { name: 'SDK会话 B' });
    const routeB = await addRoute(context, projectB, 'B项目方案', await pointsFor(request, 2, 3));
    await page.route('https://webapi.amap.com/maps?**', async (pending) => {
      scriptArrived.resolve(); await release.promise;
      await pending.fulfill({ status: 200, contentType: 'application/javascript', body: amapBrowserScript });
    });
    await enterMap(context); await scriptArrived.promise;
    await page.getByRole('button', { name: projectB.name, exact: true }).click(); await assertOverview(page);
    await overview(page).getByRole('button', { name: '地图', exact: true }).click();
    await preview(page, routeB.name).waitFor();
    release.resolve(); await canvas(page).waitFor(); await expectPaths(page, [routeB]);
    assert.equal(await page.locator('[data-sdk-map="ready"]').count(), 1);
    assert.equal(await summary(page).count(), 0);
    const discardedLine = await canvas(page).locator('[data-sdk-polyline]').first().elementHandle();
    await page.getByRole('button', { name: projectA.name, exact: true }).click(); await assertOverview(page);
    assert.equal(await page.locator('[data-sdk-map="ready"]').count(), 0);
    await overview(page).getByRole('button', { name: '地图', exact: true }).click();
    await canvas(page).waitFor(); await expectPaths(page, [routeA]);
    await discardedLine.dispatchEvent('click');
    assert.equal(await summary(page).count(), 0, 'disposed SDK overlays cannot select into another project session');
    await canvas(page).locator('[data-sdk-polyline]').first().dispatchEvent('click');
    await summary(page).getByRole('heading', { name: routeA.name, exact: true }).waitFor();
    assert.equal(await preview(page, routeA.name).getAttribute('aria-pressed'), 'true');
    assert.deepEqual(context.errors, []);
  } finally { release.resolve(); await context.close(); }
});

test('new project sessions ignore late reads and errors while failed refresh keeps the current map', { timeout: 120000 }, async () => {
  const context = await openMap();
  const { page, request } = context;
  let release;
  try {
    const projectA = await request('/api/projects', 'POST', { name: '读取会话 A' });
    let routeA = await addRoute(context, projectA, '会话A原方案', await pointsFor(request, 2));
    const projectB = await request('/api/projects', 'POST', { name: '读取会话 B' });
    const routeB = await addRoute(context, projectB, '会话B方案', await pointsFor(request, 2, 2));
    await enterMap(context); await canvas(page).waitFor();
    for (const outcome of ['success', 'error']) {
      const captured = deferred(), finish = deferred(), delivered = deferred(); release = finish.resolve;
      const pattern = `**/api/projects/${projectA.id}/routes`;
      let held = false;
      await page.route(pattern, async (pending) => {
        if (pending.request().method() !== 'GET' || held) return pending.continue();
        held = true; const response = await pending.fetch(); captured.resolve(); await finish.promise;
        if (outcome === 'error') await pending.abort('failed'); else await pending.fulfill({ response });
        delivered.resolve();
      });
      await preview(page, routeA.name).click(); await setCamera(page);
      await page.getByRole('button', { name: '刷新线路', exact: true }).click(); await captured.promise;
      await page.getByRole('button', { name: projectB.name, exact: true }).click(); await assertOverview(page);
      await overview(page).getByRole('button', { name: '地图', exact: true }).click();
      await canvas(page).waitFor(); await expectPaths(page, [routeB]);
      routeA = await request(routePath(routeA), 'PATCH', { name: `会话A最新${outcome}`, points: await pointsFor(request, 2, outcome === 'success' ? 4 : 5) });
      routeA = await request(planPath(routeA), 'POST');
      await page.getByRole('button', { name: projectA.name, exact: true }).click(); await assertOverview(page);
      assert.equal(await overview(page).getByRole('button', { name: '表格', exact: true }).getAttribute('aria-pressed'), 'true');
      assert.equal(await page.getByLabel('搜索总览线路与点位', { exact: true }).inputValue(), '');
      await overview(page).getByRole('button', { name: '地图', exact: true }).click();
      await canvas(page).waitFor(); await expectPaths(page, [routeA]);
      assert.equal(await summary(page).count(), 0);
      await preview(page, routeA.name).click(); await setCamera(page, [117, 26], 12); const before = await camera(page);
      finish.resolve(); await delivered.promise; await page.unroute(pattern);
      await expectPaths(page, [routeA]); assert.deepEqual(await camera(page), before);
      assert.deepEqual((await page.getByRole('alert').allTextContents()).filter((text) => text.trim()), []);
    }
    const before = await camera(page);
    const pattern = `**/api/projects/${projectA.id}/routes`;
    await page.route(pattern, (pending) => pending.request().method() === 'GET' ? pending.abort('failed') : pending.continue());
    await page.getByRole('button', { name: '刷新线路', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '读取项目线路失败' }).waitFor();
    await expectPaths(page, [routeA]); assert.deepEqual(await camera(page), before);
    await summary(page).getByRole('heading', { name: routeA.name, exact: true }).waitFor();
    await page.unroute(pattern); await refresh(page);
    await page.getByRole('alert').filter({ hasText: '读取项目线路失败' }).waitFor({ state: 'hidden' });
    assert.deepEqual(await camera(page), before); assert.deepEqual(context.errors, []);
  } finally { release?.(); await context.close(); }
});

test('one hundred complete twenty-point plans remain identifiable, read-only and fully exported', { timeout: 180000 }, async (t) => {
  const context = await openMap();
  const { page, request } = context;
  try {
    const project = await request('/api/projects', 'POST', { name: '百条有效方案项目' });
    const otherProject = await request('/api/projects', 'POST', { name: '配色会话对照项目' });
    await addRoute(context, otherProject, '另一项目草稿', [], false);
    const common = await pointsFor(request, 20, 0, '重合客户');
    const routes = [];
    for (let index = 0; index < 100; index++) {
      const name = index < 2 ? '同名重合线路' : `空间线路${String(index + 1).padStart(3, '0')}`;
      const points = index < 2 ? common : await pointsFor(request, 20, 0.2 + (index % 10) * 0.4 + Math.floor(index / 10) * 0.07, `线路${index + 1}客户`);
      if (index === 2) points[19] = points[0];
      routes.push(await addRoute(context, project, name, points));
    }
    assert.equal(context.calls.length, 1900, 'all 100 plans are produced by 19 real application leg requests each');
    const persisted = await request(`/api/projects/${project.id}/routes`);
    assert.equal(persisted.length, 100);
    assert.ok(persisted.every((route) => route.points.length === 20 && route.snapshot?.inputVersion === route.inputVersion && route.snapshot.totalDistanceMeters === 23446));
    const writes = [];
    page.on('request', (event) => { if (new URL(event.url()).pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(event.method())) writes.push(`${event.method()} ${new URL(event.url()).pathname}`); });
    const started = performance.now();
    await enterMap(context); await canvas(page).waitFor(); await expectPaths(page, routes);
    const readyMs = Math.round(performance.now() - started);
    assert.equal(await list(page).getByRole('button').count(), 100);
    assert.equal(await canvas(page).locator('[data-sdk-marker]').count(), 0);
    const colors = new Map((await sdkLines(page)).map((line) => [line.extData.routeId, line.strokeColor]));
    assert.equal(colors.size, 100); assert.ok(new Set(colors.values()).size <= 8 && new Set(colors.values()).size > 1);
    const overlap = preview(page, '同名重合线路');
    for (let index = 0; index < 2; index++) {
      await overlap.nth(index).click();
      await summary(page).getByRole('heading', { name: '同名重合线路', exact: true }).waitFor();
      const selected = (await sdkLines(page)).filter((line) => line.extData.routeId === routes[index].id);
      const rest = (await sdkLines(page)).filter((line) => line.extData.routeId !== routes[index].id);
      assert.ok(selected.every((line) => line.strokeColor === colors.get(routes[index].id) && line.strokeWeight > rest[0].strokeWeight && line.zIndex > rest[0].zIndex));
      const rgb = colors.get(routes[index].id).match(/\w\w/g).map((part) => parseInt(part, 16));
      assert.equal(await overlap.nth(index).locator('.overview-route-color').evaluate((element) => getComputedStyle(element).backgroundColor), `rgb(${rgb.join(', ')})`);
      const opened = page.waitForRequest((event) => event.method() === 'GET' && event.url().endsWith(routePath(routes[index])));
      await summary(page).getByRole('button', { name: '打开线路', exact: true }).click(); await opened;
      await page.getByRole('region', { name: '线路编辑', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: '编排点位', exact: true }).getAttribute('aria-pressed'), 'true');
      await page.getByRole('button', { name: '线路总览', exact: true }).click(); await canvas(page).waitFor();
    }
    const roundtrip = routes[2];
    await preview(page, roundtrip.name).focus(); await page.keyboard.press('Enter');
    await summary(page).getByRole('heading', { name: roundtrip.name, exact: true }).waitFor();
    assert.equal(await canvas(page).locator('[data-sdk-marker]').count(), 20);
    const positions = await canvas(page).locator('[data-sdk-marker]').evaluateAll((elements) => elements.map((element) => JSON.parse(element.dataset.sdkMarker)));
    assert.deepEqual(positions[0], positions[19]);
    const expand = summary(page).getByRole('button', { name: `展开 ${roundtrip.name} 的全部点位`, exact: true });
    await expand.focus(); await page.keyboard.press('Enter');
    assert.equal(await summary(page).getByRole('button', { name: `收起 ${roundtrip.name} 的全部点位`, exact: true }).getAttribute('aria-expanded'), 'true');
    await setCamera(page, [119, 28], 11); const remembered = await camera(page);
    for (const sort of ['created', 'name-asc', 'name-desc', 'distance-asc', 'distance-desc', 'time-asc', 'time-desc']) {
      await page.getByLabel('总览排序', { exact: true }).selectOption(sort);
      assert.deepEqual(await camera(page), remembered);
      assert.equal(await preview(page, roundtrip.name).getAttribute('aria-pressed'), 'true');
      assert.ok((await sdkLines(page)).every((line) => line.strokeColor === colors.get(line.extData.routeId)));
    }
    await page.getByLabel('总览排序', { exact: true }).selectOption('created');
    await list(page).evaluate(async (element) => { element.scrollTo(0, 330); await new Promise(requestAnimationFrame); });
    const scrollTop = await list(page).evaluate((element) => element.scrollTop); assert.ok(scrollTop > 0);
    await overview(page).getByRole('button', { name: '表格', exact: true }).click();
    await overview(page).getByRole('button', { name: '地图', exact: true }).click(); await canvas(page).waitFor();
    assert.deepEqual(await camera(page), remembered);
    assert.ok(Math.abs(await list(page).evaluate((element) => element.scrollTop) - scrollTop) <= 1);
    await summary(page).getByRole('button', { name: '打开线路', exact: true }).click();
    await page.getByRole('region', { name: '线路编辑', exact: true }).waitFor();
    await page.getByRole('button', { name: '线路总览', exact: true }).click(); await canvas(page).waitFor();
    assert.deepEqual(await camera(page), remembered);
    assert.ok(Math.abs(await list(page).evaluate((element) => element.scrollTop) - scrollTop) <= 1);
    await page.getByRole('button', { name: '管理点位库', exact: true }).click();
    await page.getByRole('region', { name: '项目点位库', exact: true }).waitFor();
    assert.equal(await page.locator('[data-sdk-map="ready"]').count(), 0);
    await page.getByRole('button', { name: '线路总览', exact: true }).click(); await canvas(page).waitFor();
    assert.deepEqual(await camera(page), remembered);
    assert.ok(Math.abs(await list(page).evaluate((element) => element.scrollTop) - scrollTop) <= 1);
    const renamed = await request(routePath(roundtrip), 'PATCH', { name: '已改名往返线路' });
    await refresh(page); await summary(page).getByRole('heading', { name: renamed.name, exact: true }).waitFor();
    assert.deepEqual(await camera(page), remembered);
    assert.ok((await sdkLines(page)).every((line) => line.strokeColor === colors.get(line.extData.routeId)));
    await page.getByLabel('搜索总览线路与点位', { exact: true }).fill('  线路100客户20  ');
    await overview(page).getByText('1 / 100 条线路', { exact: true }).waitFor();
    await preview(page, routes[99].name).click(); await expectPaths(page, [routes[99]]);
    await page.getByLabel('结果状态筛选', { exact: true }).selectOption('已规划');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出项目', exact: true }).click();
    const file = await download; const book = new ExcelJS.Workbook(); await book.xlsx.readFile(await file.path());
    assert.deepEqual(book.worksheets.map((sheet) => sheet.name), ['线路总览', '区间明细']);
    const exported = book.getWorksheet('线路总览'), details = book.getWorksheet('区间明细');
    assert.equal(exported.rowCount, 102); assert.equal(details.rowCount, 1902);
    const ids = new Set();
    for (let row = 3; row <= exported.rowCount; row++) {
      ids.add(exported.getCell(row, 2).value);
      assert.equal(exported.getCell(row, 7).value, 23.446); assert.equal(typeof exported.getCell(row, 7).value, 'number');
      assert.equal(exported.getCell(row, 10).value, '已规划'); assert.match(exported.getCell(row, 9).value, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    }
    assert.deepEqual(ids, new Set(routes.map((route) => route.id)));
    const counts = new Map();
    for (let row = 3; row <= details.rowCount; row++) {
      const id = details.getCell(row, 2).value; counts.set(id, (counts.get(id) ?? 0) + 1);
      assert.equal(details.getCell(row, 7).value, 1.234);
      if (details.getCell(row, 4).value === 19) assert.equal(details.getCell(row, 8).value, 23.446);
    }
    assert.equal(counts.size, 100); assert.ok([...counts.values()].every((count) => count === 19));
    await overview(page).getByRole('button', { name: '查看全部', exact: true }).click();
    assert.equal(await summary(page).count(), 0);
    assert.equal(await page.getByLabel('搜索总览线路与点位', { exact: true }).inputValue(), '  线路100客户20  ');
    await expectPaths(page, [routes[99]]);
    await page.getByRole('button', { name: otherProject.name, exact: true }).click(); await assertOverview(page);
    await page.getByRole('button', { name: project.name, exact: true }).click(); await assertOverview(page);
    assert.equal(await overview(page).getByRole('button', { name: '表格', exact: true }).getAttribute('aria-pressed'), 'true');
    await overview(page).getByRole('button', { name: '地图', exact: true }).click(); await canvas(page).waitFor();
    await expectPaths(page, routes);
    assert.ok((await sdkLines(page)).every((line) => line.strokeColor === colors.get(line.extData.routeId)));
    await page.reload(); await assertOverview(page);
    assert.equal(await overview(page).getByRole('button', { name: '表格', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('[data-sdk-map="ready"]').count(), 0);
    assert.deepEqual(writes, []); assert.equal(context.calls.length, 1900);
    const after = await request(`/api/projects/${project.id}/routes`);
    assert.deepEqual(after, persisted.map((route) => route.id === renamed.id ? renamed : route));
    assert.deepEqual(context.errors, []);
    t.diagnostic(`overview-map-load ${JSON.stringify({ routes: 100, pointsPerRoute: 20, upstreamBaseline: 1900, browserUpstreamAdded: 0, browserWrites: writes.length, overviewRows: 100, detailRows: 1900, readyMs })}`);
  } finally { await context.close(); }
});

test('explicit range changes include selected draft points and empty schemes use the national view', { timeout: 120000 }, async () => {
  const context = await openMap();
  const { page, request } = context;
  try {
    const project = await request('/api/projects', 'POST', { name: '草稿范围项目' });
    const draft = await addRoute(context, project, '共同草稿', await pointsFor(request, 2), false);
    const planned = await addRoute(context, project, '共同方案', await pointsFor(request, 2, 4));
    await enterMap(context); await canvas(page).waitFor(); await expectPaths(page, [planned]);
    await preview(page, draft.name).click();
    await summary(page).getByRole('heading', { name: draft.name, exact: true }).waitFor();
    await setCamera(page);
    await page.getByLabel('搜索总览线路与点位', { exact: true }).fill('共同');
    const fit = await canvas(page).evaluate((element) => JSON.parse(element.dataset.sdkFitView));
    assert.deepEqual(fit.filter((item) => item.position).map((item) => item.position), draft.points.map((point) => [point.longitude, point.latitude]));
    assert.ok(fit.some((item) => item.path && item.extData.routeId === planned.id));
    assert.equal(await preview(page, draft.name).getAttribute('aria-pressed'), 'true');
    await page.getByLabel('结果状态筛选', { exact: true }).selectOption('未规划');
    assert.equal(await canvas(page).locator('[data-sdk-polyline]').count(), 0);
    assert.equal(await canvas(page).locator('[data-sdk-marker]').count(), 2);
    await overview(page).getByRole('button', { name: '查看全部', exact: true }).click();
    assert.deepEqual(await camera(page), { center: [112.5, 33], zoom: 5 });
    assert.equal(await summary(page).count(), 0);
    assert.equal(await canvas(page).locator('[data-sdk-marker], [data-sdk-polyline]').count(), 0);
    await setCamera(page); const before = await camera(page);
    await refresh(page); assert.deepEqual(await camera(page), before, 'an ordinary empty-result refresh does not reset a user view');
    assert.equal(context.calls.length, 1); assert.deepEqual(context.errors, []);
  } finally { await context.close(); }
});
