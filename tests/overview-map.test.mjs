import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { startApplication, jsonRequest } from './helpers/application.mjs';
import { replaceAmapSDK } from './helpers/amap-browser.mjs';

async function openMapOverview() {
  const calls = [];
  const upstream = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1'); calls.push(url);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ status: '1', route: { paths: [{ distance: '1234', steps: [{ polyline: `${url.searchParams.get('origin')};${url.searchParams.get('destination')}` }] }] } }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const app = await startApplication({ HAULPATH_TEST_MODE: '1', AMAP_JS_KEY: 'overview-map-test-key', AMAP_JS_SECURITY_CODE: 'overview-map-test-code', AMAP_WEB_SERVICE_KEY: 'overview-map-service-key', AMAP_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}` });
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await replaceAmapSDK(page);
  const request = async (path, method, body) => { const result = await jsonRequest(app.baseUrl, path, method, body); assert.ok(result.status < 300, JSON.stringify(result)); return result.body; };
  return { app, page, errors, calls, request, async close() { await browser.close(); await app.stop(); await app.cleanup(); await new Promise((resolve) => upstream.close(resolve)); } };
}

// Agreed seam: browser → real application HTTP → temporary SQLite; only AMap is replaced.
test('overview map previews stored routes without opening the workbench or planning again', { timeout: 120000 }, async () => {
  const context = await openMapOverview();
  const { app, page, request } = context;
  try {
    const project = await request('/api/projects', 'POST', { name: '地图总览项目' });
    const points = await request('/api/coordinates', 'POST', { points: [
      { name: '上海仓', longitude: 121.47, latitude: 31.23, source: 'manual' },
      { name: '南京客户', longitude: 118.79, latitude: 32.06, source: 'manual' },
      { name: '合肥客户', longitude: 117.22, latitude: 31.82, source: 'manual' },
    ] });
    const first = await request(`/api/projects/${project.id}/routes`, 'POST', { name: '沪宁往返', points: [points[0], points[1], points[0]], strategy: 43 });
    const planned = await request(`/api/routes/${first.id}/plan?projectId=${project.id}`, 'POST');
    const second = await request(`/api/projects/${project.id}/routes`, 'POST', { name: '沪合线路', points: [points[0], points[2]] });
    await request(`/api/routes/${second.id}/plan?projectId=${project.id}`, 'POST');
    await request(`/api/projects/${project.id}/routes`, 'POST', { name: '零点草稿' });
    const baseline = context.calls.length;
    await page.goto(app.baseUrl);
    const overview = page.getByRole('region', { name: '线路总览', exact: true });
    await overview.getByRole('columnheader', { name: '线路名称', exact: true }).waitFor();
    await overview.getByRole('button', { name: '地图', exact: true }).click({ timeout: 3000 });
    const map = page.getByRole('region', { name: '线路总览地图', exact: true });
    await map.locator('[data-sdk-map="ready"]').waitFor();
    const paths = await map.locator('[data-sdk-polyline]').evaluateAll((elements) => elements.map((element) => JSON.parse(element.dataset.sdkPolyline)));
    for (const leg of planned.snapshot.legs) assert.ok(paths.some((path) => JSON.stringify(path) === JSON.stringify(leg.polyline)));
    assert.equal(await map.locator('[data-sdk-marker]').count(), 0, 'initial project view does not select a route');
    const list = overview.getByRole('region', { name: '地图线路列表', exact: true });
    await list.getByRole('button', { name: '预览 沪宁往返', exact: true }).click();
    const summary = overview.getByRole('region', { name: '所选线路摘要', exact: true });
    await summary.getByRole('heading', { name: '沪宁往返', exact: true }).waitFor();
    assert.match(await summary.innerText(), /上海仓 → 南京客户 → 上海仓/);
    assert.match(await summary.innerText(), /躲避拥堵＋少收费＋不走高速/);
    assert.match(await summary.innerText(), /2\.468/);
    assert.match(await summary.innerText(), /北京时间/);
    assert.equal(await map.locator('[data-sdk-marker]').count(), 3);
    assert.equal(await page.getByRole('region', { name: '线路编辑', exact: true }).count(), 0);
    await summary.getByRole('button', { name: '打开线路', exact: true }).click();
    await page.getByRole('heading', { name: '沪宁往返', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '编排点位', exact: true }).getAttribute('aria-pressed'), 'true');
    await page.getByRole('button', { name: '线路总览', exact: true }).click();
    await summary.getByRole('heading', { name: '沪宁往返', exact: true }).waitFor();
    assert.equal(context.calls.length, baseline);
    assert.deepEqual(context.errors, []);
  } finally { await context.close(); }
});

test('map selection, shared filters and camera restoration follow explicit browsing actions', { timeout: 120000 }, async () => {
  const context = await openMapOverview();
  const { app, page, request } = context;
  try {
    const project = await request('/api/projects', 'POST', { name: '视野恢复项目' });
    const points = await request('/api/coordinates', 'POST', { points: [
      { name: '上海仓', longitude: 121.47, latitude: 31.23, source: 'manual' },
      { name: '南京客户', longitude: 118.79, latitude: 32.06, source: 'manual' },
    ] });
    const planned = await request(`/api/projects/${project.id}/routes`, 'POST', { name: '有效线路', points });
    await request(`/api/routes/${planned.id}/plan?projectId=${project.id}`, 'POST');
    await request(`/api/projects/${project.id}/routes`, 'POST', { name: '单点草稿', points: points.slice(0, 1) });
    await request(`/api/projects/${project.id}/routes`, 'POST', { name: '零点草稿' });
    const otherProject = await request('/api/projects', 'POST', { name: '另一个项目' });
    await request(`/api/projects/${otherProject.id}/routes`, 'POST', { name: '另一项目草稿' });
    await page.goto(app.baseUrl);
    const overview = page.getByRole('region', { name: '线路总览', exact: true });
    await overview.getByRole('button', { name: '地图', exact: true }).click();
    const map = overview.getByRole('region', { name: '线路总览地图', exact: true });
    const canvas = map.locator('[data-sdk-map="ready"]');
    await canvas.waitFor();
    await page.waitForFunction(() => !!document.querySelector('[data-sdk-fit-count]'));
    const list = overview.getByRole('region', { name: '地图线路列表', exact: true });
    const summary = overview.getByRole('region', { name: '所选线路摘要', exact: true });
    const originalColor = await map.locator('[data-sdk-polyline]').evaluate((element) => JSON.parse(element.dataset.sdkOptions).strokeColor);
    await list.getByRole('button', { name: '预览 有效线路', exact: true }).focus();
    await page.keyboard.press('Enter');
    await summary.getByRole('heading', { name: '有效线路', exact: true }).waitFor();
    assert.equal(await map.locator('[data-sdk-polyline]').evaluate((element) => JSON.parse(element.dataset.sdkOptions).strokeColor), originalColor);
    await canvas.evaluate((element) => element.__sdkMap.setZoomAndCenter(12, [120, 30]));
    const fitCount = await canvas.getAttribute('data-sdk-fit-count');
    await page.getByLabel('总览排序', { exact: true }).selectOption('name-desc');
    assert.equal(await canvas.getAttribute('data-sdk-center'), '[120,30]');
    assert.equal(await canvas.getAttribute('data-sdk-fit-count'), fitCount);
    await page.getByRole('button', { name: '刷新线路', exact: true }).click();
    assert.equal(await canvas.getAttribute('data-sdk-center'), '[120,30]');
    await list.getByRole('button', { name: '预览 零点草稿', exact: true }).click();
    await summary.getByRole('heading', { name: '零点草稿', exact: true }).waitFor();
    assert.equal(await canvas.getAttribute('data-sdk-center'), '[120,30]');
    assert.equal(await map.locator('[data-sdk-marker]').count(), 0);
    await list.getByRole('button', { name: '预览 单点草稿', exact: true }).click();
    assert.equal(await map.locator('[data-sdk-marker]').count(), 1);
    await canvas.evaluate((element) => element.__sdkMap.setZoomAndCenter(11, [119, 29]));
    await overview.getByRole('button', { name: '表格', exact: true }).click();
    assert.equal(await map.count(), 0, 'hidden map does not retain an SDK instance');
    await overview.getByRole('button', { name: '地图', exact: true }).click();
    await canvas.waitFor();
    assert.equal(await canvas.getAttribute('data-sdk-center'), '[119,29]');
    assert.equal(await canvas.getAttribute('data-sdk-zoom'), '11');
    await overview.getByRole('button', { name: '表格', exact: true }).click();
    await page.getByLabel('搜索总览线路与点位', { exact: true }).fill('有效');
    await overview.getByRole('button', { name: '地图', exact: true }).click();
    await canvas.waitFor();
    await page.waitForFunction(() => document.querySelector('[data-sdk-map="ready"]')?.dataset.sdkCenter !== '[119,29]');
    assert.equal(await summary.count(), 0, 'filtered selection is cleared');
    assert.equal(await list.getByRole('button').count(), 1);
    assert.equal(await map.locator('[data-sdk-polyline]').evaluate((element) => JSON.parse(element.dataset.sdkOptions).strokeColor), originalColor);
    await map.getByText('1 条有效方案 · 色标对应线路，颜色可能重复', { exact: true }).waitFor();
    await page.getByRole('button', { name: otherProject.name, exact: true }).click();
    await overview.getByRole('columnheader', { name: '线路名称', exact: true }).waitFor();
    assert.equal(await page.getByLabel('搜索总览线路与点位', { exact: true }).inputValue(), '');
    await page.getByRole('button', { name: project.name, exact: true }).click();
    await overview.getByRole('columnheader', { name: '线路名称', exact: true }).waitFor();
    assert.equal(await overview.getByRole('button', { name: '表格', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.deepEqual(context.errors, []);
  } finally { await context.close(); }
});
