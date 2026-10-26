import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import ExcelJS from 'exceljs';
import { startApplication, jsonRequest } from './helpers/application.mjs';
import { replaceAmapSDK } from './helpers/amap-browser.mjs';

async function amapFixture(delay = 30) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    requests.push(url);
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname !== '/v5/direction/driving') { response.writeHead(404).end(); return; }
    await new Promise((resolve) => setTimeout(resolve, delay));
    const distance = url.searchParams.get('strategy') === '43' ? '2345' : '1234';
    const polyline = `${url.searchParams.get('origin')};${url.searchParams.get('destination')}`;
    response.end(JSON.stringify({ status: '1', route: { paths: [
      { distance, steps: [{ polyline }] }, { distance: '999999', steps: [{ polyline }] },
    ] } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    requests,
    environment: { HAULPATH_TEST_MODE: '1', AMAP_API_BASE_URL: `http://127.0.0.1:${server.address().port}`, AMAP_WEB_SERVICE_KEY: 'acceptance-test-key', AMAP_JS_KEY: 'acceptance-js-key', AMAP_JS_SECURITY_CODE: 'acceptance-js-secret' },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function browserPage(browser) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1050 } });
  await replaceAmapSDK(page);
  return page;
}
async function createProject(page, name) {
  await page.getByRole('button', { name: '新建项目', exact: true }).click();
  await page.getByLabel('项目名称', { exact: true }).fill(name);
  await page.getByRole('button', { name: '创建项目', exact: true }).click();
  await page.getByRole('heading', { name, exact: true }).waitFor();
}
async function createRoute(page, name) {
  await page.getByRole('region', { name: '项目线路', exact: true }).getByRole('button', { name: '新建线路', exact: true }).click();
  await page.getByLabel('线路名称', { exact: true }).fill(name);
  await page.getByRole('button', { name: '创建线路', exact: true }).click();
  await page.getByRole('heading', { name, exact: true }).waitFor();
}
async function downloadedWorkbook(page, button) {
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: button, exact: true }).click();
  const file = await download;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(await file.path());
  return workbook;
}

// This adds coverage for existing public behavior; a direct green result is not a bug-fix red phase.
test('planner imports points, plans, invalidates, successfully replans and downloads the current complete result', { timeout: 120000 }, async () => {
  const upstream = await amapFixture();
  const app = await startApplication(upstream.environment);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || 'chrome', headless: true });
  try {
    const page = await browserPage(browser);
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(app.baseUrl);
    await createProject(page, '完整行前测算');
    await createRoute(page, '三站送货');
    await page.getByRole('button', { name: '从点位库选择', exact: true }).click();
    await page.getByRole('button', { name: '导入表格', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '导入项目点位', exact: true });
    await dialog.getByLabel('选择点位表格', { exact: true }).setInputFiles({
      name: '送货点.csv', mimeType: 'text/csv', buffer: Buffer.from('名称,经度,纬度\n上海仓,121.47,31.23\n苏州客户,120.58,31.3\n南京客户,118.79,32.06\n'),
    });
    await dialog.getByLabel('工作表', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: '预览并校验', exact: true }).click();
    await dialog.getByText('3 行有效', { exact: true }).waitFor();
    assert.equal(await page.locator('.library-point').count(), 0);
    await dialog.getByRole('button', { name: '确认导入 3 行', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    for (const name of ['上海仓', '苏州客户', '南京客户']) {
      await page.locator('.library-point').filter({ has: page.getByText(name, { exact: true }) }).getByRole('button', { name: `将 ${name} 选入当前线路`, exact: true }).click();
      await page.getByText('点位已复制到线路，之后独立维护', { exact: true }).waitFor();
    }
    await page.getByRole('button', { name: '线路点位', exact: true }).click();
    assert.deepEqual(await page.getByLabel('有序点位', { exact: true }).locator('strong').allTextContents(), ['上海仓', '苏州客户', '南京客户']);
    await page.getByRole('button', { name: '开始规划', exact: true }).click();
    await page.getByText('路线方案已完整保存', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-sdk-polyline]').count(), 2);
    assert.match(await page.getByRole('region', { name: '路线方案', exact: true }).innerText(), /2\.468/);
    await page.getByLabel('规划偏好', { exact: true }).selectOption('43');
    await page.getByText('点位或偏好已变更，请重新规划。最近成功方案已保留。', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-sdk-polyline]').count(), 0);
    assert.doesNotMatch(await page.getByRole('region', { name: '路线方案', exact: true }).innerText(), /2\.468/);
    await page.getByRole('button', { name: '开始规划', exact: true }).click();
    await page.getByText('路线方案已完整保存', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-sdk-polyline]').count(), 2);
    assert.match(await page.getByRole('region', { name: '路线方案', exact: true }).innerText(), /4\.690/);
    const book = await downloadedWorkbook(page, '导出当前线路');
    assert.deepEqual(book.worksheets.map((sheet) => sheet.name), ['线路总览', '区间明细']);
    assert.equal(book.getWorksheet('线路总览').getCell('G3').value, 4.69);
    assert.equal(book.getWorksheet('线路总览').getCell('G3').numFmt, '0.000');
    assert.equal(book.getWorksheet('线路总览').getCell('H3').value, '躲避拥堵＋少收费＋不走高速');
    assert.equal(book.getWorksheet('区间明细').rowCount, 4);
    assert.equal(book.getWorksheet('区间明细').getCell('H4').value, 4.69);
    assert.deepEqual(upstream.requests.map((url) => url.searchParams.get('strategy')), ['32', '32', '43', '43']);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await app.stop(); await app.cleanup(); await upstream.close(); }
});

test('a project supports 1000 imported points, 100 routes and a 20 point plan across a service restart', { timeout: 180000 }, async (context) => {
  const upstream = await amapFixture();
  let app = await startApplication(upstream.environment);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || 'chrome', headless: true });
  const metrics = {};
  try {
    let page = await browserPage(browser);
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(app.baseUrl);
    await createProject(page, '代表规模项目');
    await page.getByRole('button', { name: /项目点位库 0/, exact: true }).click();
    await page.getByRole('button', { name: '导入表格', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '导入项目点位', exact: true });
    const rows = Array.from({ length: 1000 }, (_, index) => [`验收点${String(index + 1).padStart(4, '0')}`, (121 + index / 10000).toFixed(4), (31 + index / 100000).toFixed(5)].join(','));
    await dialog.getByLabel('选择点位表格', { exact: true }).setInputFiles({ name: '千点.csv', mimeType: 'text/csv', buffer: Buffer.from(['名称,经度,纬度', ...rows].join('\n')) });
    await dialog.getByLabel('工作表', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: '预览并校验', exact: true }).click();
    await dialog.getByText('1000 行有效', { exact: true }).waitFor();
    let started = performance.now();
    await dialog.getByRole('button', { name: '确认导入 1000 行', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    metrics.importConfirmationMs = Math.round(performance.now() - started);
    assert.equal(await page.locator('.library-point').count(), 1000);
    await page.getByLabel('搜索点位库', { exact: true }).fill('验收点1000');
    assert.deepEqual(await page.locator('.library-point strong').allTextContents(), ['验收点1000']);
    const request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
    const project = (await request('/api/projects')).body[0];
    const library = (await request(`/api/projects/${project.id}/points`)).body;
    assert.equal(library.length, 1000);
    const route = (await request(`/api/projects/${project.id}/routes`, 'POST', { name: '20点验收线路', points: library.slice(0, 20) })).body;
    for (let index = 1; index < 100; index++) {
      const result = await request(`/api/projects/${project.id}/routes`, 'POST', { name: `背景线路${index}` });
      assert.equal(result.status, 201);
    }
    started = performance.now();
    const [routes, points] = await Promise.all([request(`/api/projects/${project.id}/routes`), request(`/api/projects/${project.id}/points`)]);
    metrics.readRoutesAndPointsMs = Math.round(performance.now() - started);
    assert.equal(routes.body.length, 100); assert.equal(points.body.length, 1000);
    started = performance.now();
    await page.reload();
    await page.getByRole('heading', { name: '20点验收线路', exact: true }).waitFor();
    await page.locator('[data-sdk-cluster="1000"]').waitFor({ state: 'attached' });
    metrics.pageReadyMs = Math.round(performance.now() - started);
    assert.equal(await page.locator('.route-item').count(), 100);
    assert.equal(await page.locator('[data-sdk-marker]').count(), 20);
    const names = library.slice(0, 20).map((point) => point.name);
    const orderedPoints = page.getByLabel('有序点位', { exact: true }).locator('strong');
    assert.deepEqual(await orderedPoints.allTextContents(), names);
    await page.getByRole('button', { name: '上移点位 20', exact: true }).click();
    await page.getByText('点位顺序已保存', { exact: true }).waitFor();
    assert.equal((await orderedPoints.allTextContents())[18], '验收点0020');
    await page.getByRole('button', { name: '下移点位 19', exact: true }).click();
    await page.getByText('点位顺序已保存', { exact: true }).waitFor();
    assert.deepEqual(await orderedPoints.allTextContents(), names);
    started = performance.now();
    await page.getByRole('button', { name: '开始规划', exact: true }).click();
    await page.getByRole('progressbar', { name: '区间规划进度', exact: true }).waitFor();
    await page.getByText('路线方案已完整保存', { exact: true }).waitFor();
    metrics.plan20PointsMs = Math.round(performance.now() - started);
    assert.equal(upstream.requests.length, 19);
    assert.equal(await page.locator('[data-sdk-polyline]').count(), 19);
    assert.match(await page.getByRole('region', { name: '路线方案', exact: true }).innerText(), /23\.446/);
    started = performance.now();
    const book = await downloadedWorkbook(page, '导出项目');
    metrics.export100RoutesMs = Math.round(performance.now() - started);
    assert.equal(book.getWorksheet('线路总览').rowCount, 102);
    assert.equal(book.getWorksheet('线路总览').getCell('G3').value, 23.446);
    assert.equal(book.getWorksheet('区间明细').rowCount, 21);
    assert.equal(book.getWorksheet('区间明细').getCell('H21').value, 23.446);
    const saved = (await request(`/api/routes/${route.id}?projectId=${project.id}`)).body;
    assert.equal(saved.snapshot.totalDistanceMeters, 23446);
    await page.close();
    await app.stop();
    app = await startApplication(upstream.environment, app.directory);
    assert.equal((await request(`/api/projects/${project.id}/routes`)).body.length, 100);
    assert.equal((await request(`/api/projects/${project.id}/points`)).body.length, 1000);
    assert.deepEqual((await request(`/api/routes/${route.id}?projectId=${project.id}`)).body.snapshot, saved.snapshot);
    page = await browserPage(browser);
    await page.goto(app.baseUrl);
    await page.getByRole('heading', { name: '20点验收线路', exact: true }).waitFor();
    await page.locator('[data-sdk-cluster="1000"]').waitFor({ state: 'attached' });
    assert.equal(await page.locator('[data-sdk-polyline]').count(), 19);
    assert.equal(await page.locator('.route-item').count(), 100);
    assert.equal(upstream.requests.length, 19);
    assert.deepEqual(errors, []);
    context.diagnostic(`representative-load ${JSON.stringify(metrics)}`);
  } finally { await browser.close(); await app.stop(); await app.cleanup(); await upstream.close(); }
});
