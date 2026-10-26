import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import ExcelJS from 'exceljs';
import { chromium } from 'playwright';
import { startApplication, jsonRequest } from './helpers/application.mjs';

async function openOverview(environment = {}) {
  const app = await startApplication({ AMAP_JS_KEY: '', AMAP_JS_SECURITY_CODE: '', AMAP_WEB_SERVICE_KEY: '', ...environment });
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1050 } });
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  const request = async (path, method, body) => { const result = await jsonRequest(app.baseUrl, path, method, body); assert.ok(result.status < 300, JSON.stringify(result)); return result.body; };
  return { app, page, browser, errors, request, async close() { await browser.close(); await app.stop(); await app.cleanup(); } };
}

// Agreed seam: real browser → application HTTP → temporary SQLite; no internal replacements.
test('projects open in route overview and users explicitly resume or create a route workbench', { timeout: 120000 }, async () => {
  const context = await openOverview();
  const { app, page, request } = context;
  try {
    const project = await request('/api/projects', 'POST', { name: '总览导航项目' });
    await request(`/api/projects/${project.id}/routes`, 'POST', { name: '首条草稿' });
    await request(`/api/projects/${project.id}/routes`, 'POST', { name: '最近编辑线路' });
    const empty = await request('/api/projects', 'POST', { name: '空项目' });
    await page.goto(app.baseUrl);
    const overview = page.getByRole('region', { name: '线路总览', exact: true });
    await overview.waitFor({ timeout: 8000 });
    assert.equal(await page.getByRole('region', { name: '线路编辑', exact: true }).count(), 0);
    await overview.getByRole('columnheader', { name: '线路名称', exact: true }).waitFor();
    assert.deepEqual(await overview.getByRole('columnheader').allTextContents(), ['线路名称', '有序点位', '点位数', '规划偏好', '状态', '总里程（km）', '有效结果时间 · 北京时间']);
    assert.equal(await page.getByText('未校验重卡限高、限重及货车限行', { exact: true }).count(), 1);
    await overview.getByRole('button', { name: '最近编辑线路', exact: true }).click();
    await page.getByRole('heading', { name: '最近编辑线路', exact: true }).waitFor();
    await page.getByRole('button', { name: '从点位库选择', exact: true }).click();
    await page.getByRole('region', { name: '项目线路', exact: true }).locator('.route-item').filter({ has: page.getByText('最近编辑线路', { exact: true }) }).click();
    assert.equal(await page.getByRole('region', { name: '线路编辑', exact: true }).evaluate((element) => document.activeElement === element), true, 'reopening the same route from its library restores main-content focus');
    await page.getByRole('button', { name: '线路总览', exact: true }).click();
    await overview.waitFor();
    await page.getByRole('button', { name: '线路工作台', exact: true }).click();
    await page.getByRole('heading', { name: '最近编辑线路', exact: true }).waitFor();
    await page.reload();
    await overview.waitFor();
    assert.equal(await page.getByRole('region', { name: '线路编辑', exact: true }).count(), 0);
    await page.getByRole('button', { name: '线路工作台', exact: true }).click();
    await page.getByRole('heading', { name: '首条草稿', exact: true }).waitFor();
    await page.getByRole('button', { name: '空项目', exact: true }).click();
    await overview.getByText('还没有线路', { exact: true }).waitFor();
    await overview.getByRole('button', { name: '新建线路', exact: true }).click();
    await page.getByLabel('线路名称', { exact: true }).fill('空项目新线路');
    await page.getByRole('button', { name: '创建线路', exact: true }).click();
    await page.getByRole('heading', { name: '空项目新线路', exact: true }).waitFor();
    assert.equal((await request(`/api/projects/${empty.id}/routes`))[0].name, '空项目新线路');
    await page.getByRole('button', { name: project.name, exact: true }).click();
    await overview.waitFor();
    assert.equal(await page.getByRole('region', { name: '线路编辑', exact: true }).count(), 0);
    assert.deepEqual(context.errors, []);
  } finally { await context.close(); }
});

async function planningFixture() {
  let fail = false;
  const requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1'); requests.push(url);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(fail ? { status: '0', infocode: '10003' } : { status: '1', route: { paths: [{ distance: url.searchParams.get('strategy') === '43' ? '10001' : '1234', steps: [{ polyline: `${url.searchParams.get('origin')};${url.searchParams.get('destination')}` }] }] } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { requests, fail: () => { fail = true; }, environment: { HAULPATH_TEST_MODE: '1', AMAP_WEB_SERVICE_KEY: 'overview-test-key', AMAP_API_BASE_URL: `http://127.0.0.1:${server.address().port}` }, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function createPoints(request, names) {
  return request('/api/coordinates', 'POST', { points: names.map((name, index) => ({ name, longitude: 121.47 - index * .1, latitude: 31.23 + index * .1, source: 'manual' })) });
}

function overviewRow(page, name) {
  return page.getByRole('region', { name: '线路总览', exact: true }).getByRole('row').filter({ has: page.getByRole('button', { name, exact: true }) });
}

test('overview compares current inputs and valid results while filtered project export keeps every route', { timeout: 120000 }, async () => {
  const upstream = await planningFixture();
  const context = await openOverview(upstream.environment);
  const { app, page, request } = context;
  try {
    const project = await request('/api/projects', 'POST', { name: '混合资料' });
    const points = await createPoints(request, ['Alpha仓', '南京客户', '返程仓']);
    const path = `/api/projects/${project.id}/routes`;
    await request(path, 'POST', { name: '零点草稿' });
    await request(path, 'POST', { name: '同名安排', points: points.slice(0, 1) });
    const roundtrip = await request(path, 'POST', { name: '同名安排', points: [points[0], points[1], points[0]], strategy: 43 });
    const successful = await request(`/api/routes/${roundtrip.id}/plan?projectId=${project.id}`, 'POST');
    const stale = await request(path, 'POST', { name: '待重算安排', points: points.slice(0, 2) });
    await request(`/api/routes/${stale.id}/plan?projectId=${project.id}`, 'POST');
    await request(`/api/routes/${stale.id}?projectId=${project.id}`, 'PATCH', { strategy: 34 });
    const retry = await request(path, 'POST', { name: '原结果重算失败', points: points.slice(0, 2) });
    const previous = await request(`/api/routes/${retry.id}/plan?projectId=${project.id}`, 'POST');
    upstream.fail();
    assert.equal((await jsonRequest(app.baseUrl, `/api/routes/${retry.id}/plan?projectId=${project.id}`, 'POST')).status, 502);
    const callsBefore = upstream.requests.length;
    await page.goto(app.baseUrl);
    const overview = page.getByRole('region', { name: '线路总览', exact: true });
    await overviewRow(page, '原结果重算失败').waitFor();
    const failed = overviewRow(page, '原结果重算失败');
    await failed.getByText('最近规划失败', { exact: true }).waitFor({ timeout: 6000 });
    assert.match(await failed.innerText(), /已规划/);
    assert.equal(await failed.getByRole('cell').nth(5).innerText(), '1.234');
    const time = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    assert.equal(await failed.getByRole('cell').nth(6).innerText(), time.format(new Date(previous.snapshot.calculatedAt)));
    const outdated = overviewRow(page, '待重算安排');
    assert.match(await outdated.innerText(), /待重算/);
    assert.equal(await outdated.getByRole('cell').nth(5).innerText(), '—');
    assert.equal(await outdated.getByRole('cell').nth(6).innerText(), '—');
    assert.equal(await overviewRow(page, '零点草稿').getByRole('cell').nth(1).innerText(), '尚未添加点位');
    const sameName = overview.getByRole('row').filter({ has: page.getByRole('button', { name: '同名安排', exact: true }) });
    assert.equal(await sameName.count(), 2);
    assert.equal(await sameName.nth(0).getByRole('cell').nth(1).innerText(), 'Alpha仓');
    assert.equal(await sameName.nth(1).getByRole('cell').nth(1).innerText(), 'Alpha仓 → 南京客户 → Alpha仓');
    assert.equal(await sameName.nth(1).getByRole('cell').nth(3).innerText(), '躲避拥堵＋少收费＋不走高速');
    assert.equal(await sameName.nth(1).getByRole('cell').nth(5).innerText(), '20.002');
    const open = page.waitForRequest((event) => event.method() === 'GET' && event.url() === `${app.baseUrl}/api/routes/${roundtrip.id}?projectId=${project.id}`);
    await sameName.nth(1).getByRole('button', { name: '同名安排', exact: true }).click(); await open;
    assert.deepEqual(await page.getByLabel('有序点位', { exact: true }).locator('strong').allTextContents(), ['Alpha仓', '南京客户', 'Alpha仓']);
    await page.getByRole('button', { name: '线路总览', exact: true }).click();
    await page.getByLabel('搜索总览线路与点位', { exact: true }).fill('  ALPHA  ');
    await page.getByLabel('结果状态筛选', { exact: true }).selectOption('已规划');
    await overview.getByText('2 / 5 条线路', { exact: true }).waitFor();
    await page.getByLabel('搜索总览线路与点位', { exact: true }).fill('原结果');
    await overview.getByText('1 / 5 条线路', { exact: true }).waitFor();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出项目', exact: true }).click();
    const book = new ExcelJS.Workbook(); await book.xlsx.readFile(await (await download).path());
    assert.deepEqual(book.worksheets.map((sheet) => sheet.name), ['线路总览', '区间明细']);
    assert.equal(book.getWorksheet('线路总览').rowCount, 7);
    assert.equal(book.getWorksheet('区间明细').rowCount, 5);
    assert.equal(book.getWorksheet('线路总览').getCell('G5').value, successful.snapshot.totalDistanceMeters / 1000);
    assert.equal(upstream.requests.length, callsBefore, 'browsing, opening and exporting must not calculate');
    assert.deepEqual(context.errors, []);
  } finally { await context.close(); await upstream.close(); }
});

test('overview finds any point and sorts valid values with missing results always last', { timeout: 120000 }, async () => {
  const upstream = await planningFixture();
  const context = await openOverview(upstream.environment);
  const { app, page, request } = context;
  try {
    const project = await request('/api/projects', 'POST', { name: '查找排序' });
    const points = await createPoints(request, ['DeepDepot', '客户']);
    const path = `/api/projects/${project.id}/routes`;
    for (const [name, strategy] of [['成都后建', 32], ['北京先行', 43], ['上海同里程', 32]]) {
      const route = await request(path, 'POST', { name, strategy, points });
      await request(`/api/routes/${route.id}/plan?projectId=${project.id}`, 'POST');
    }
    await request(path, 'POST', { name: '阿坝空值' });
    const stale = await request(path, 'POST', { name: '广州待重算', points });
    await request(`/api/routes/${stale.id}/plan?projectId=${project.id}`, 'POST');
    await request(`/api/routes/${stale.id}?projectId=${project.id}`, 'PATCH', { strategy: 36 });
    const before = upstream.requests.length;
    await page.goto(app.baseUrl);
    const overview = page.getByRole('region', { name: '线路总览', exact: true });
    await overviewRow(page, '广州待重算').waitFor();
    const names = () => overview.locator('tbody .overview-route-name').allTextContents();
    assert.deepEqual(await names(), ['成都后建', '北京先行', '上海同里程', '阿坝空值', '广州待重算']);
    const sort = page.getByLabel('总览排序', { exact: true });
    await sort.waitFor({ timeout: 6000 });
    for (const [value, expected] of [
      ['name-asc', ['阿坝空值', '北京先行', '成都后建', '广州待重算', '上海同里程']],
      ['name-desc', ['上海同里程', '广州待重算', '成都后建', '北京先行', '阿坝空值']],
      ['distance-asc', ['成都后建', '上海同里程', '北京先行', '阿坝空值', '广州待重算']],
      ['distance-desc', ['北京先行', '成都后建', '上海同里程', '阿坝空值', '广州待重算']],
      ['time-asc', ['成都后建', '北京先行', '上海同里程', '阿坝空值', '广州待重算']],
      ['time-desc', ['上海同里程', '北京先行', '成都后建', '阿坝空值', '广州待重算']],
      ['created', ['成都后建', '北京先行', '上海同里程', '阿坝空值', '广州待重算']],
    ]) { await sort.selectOption(value); assert.deepEqual(await names(), expected, value); }
    await page.getByLabel('搜索线路', { exact: true }).fill('阿坝');
    assert.equal(await overview.locator('tbody tr').count(), 5, 'sidebar search is independent');
    const search = page.getByLabel('搜索总览线路与点位', { exact: true });
    await search.fill('  deepDEPOT  ');
    await page.getByLabel('结果状态筛选', { exact: true }).selectOption('已规划');
    await overview.getByText('3 / 5 条线路', { exact: true }).waitFor();
    assert.deepEqual(await page.locator('.route-item-name').allTextContents(), ['阿坝空值']);
    await search.fill('不存在');
    await overview.getByText('没有匹配的线路', { exact: true }).waitFor();
    await overview.getByRole('button', { name: '清除搜索和筛选', exact: true }).click();
    await overview.getByText('5 / 5 条线路', { exact: true }).waitFor();
    assert.equal(await search.inputValue(), '');
    assert.equal(await page.getByLabel('结果状态筛选', { exact: true }).inputValue(), 'all');
    assert.equal(upstream.requests.length, before);
    assert.deepEqual(context.errors, []);
  } finally { await context.close(); await upstream.close(); }
});

test('overview expands long points with keyboard and restores browsing conditions and both scroll positions', { timeout: 120000 }, async () => {
  const context = await openOverview();
  const { app, page, request } = context;
  try {
    const project = await request('/api/projects', 'POST', { name: '浏览恢复项目' });
    const other = await request('/api/projects', 'POST', { name: '另一浏览项目' });
    const points = await createPoints(request, Array.from({ length: 20 }, (_, index) => index === 19 ? '隐藏DEPOT20' : `恢复验收点位${index + 1}号客户`));
    const path = `/api/projects/${project.id}/routes`;
    await request(path, 'POST', { name: '恢复重点线路', points, strategy: 43 });
    for (let index = 1; index <= 24; index++) await request(path, 'POST', { name: `恢复线路${String(index).padStart(2, '0')}` });
    await page.goto(app.baseUrl);
    const overview = page.getByRole('region', { name: '线路总览', exact: true });
    const row = overviewRow(page, '恢复重点线路'); await row.waitFor();
    const expand = row.getByRole('button', { name: '展开 恢复重点线路 的全部点位', exact: true });
    await expand.waitFor({ timeout: 6000 });
    assert.equal(await expand.getAttribute('aria-expanded'), 'false');
    const collapsed = await row.getByRole('cell').nth(1).boundingBox();
    await expand.focus(); await page.keyboard.press('Enter');
    const collapse = row.getByRole('button', { name: '收起 恢复重点线路 的全部点位', exact: true });
    assert.equal(await collapse.getAttribute('aria-expanded'), 'true');
    assert.ok((await row.getByRole('cell').nth(1).boundingBox()).height > collapsed.height + 20);
    const search = page.getByLabel('搜索总览线路与点位', { exact: true });
    await search.fill('  depot20 ');
    await overview.getByText('1 / 25 条线路', { exact: true }).waitFor();
    await search.fill('恢复');
    await page.getByLabel('结果状态筛选', { exact: true }).selectOption('未规划');
    await page.getByLabel('总览排序', { exact: true }).selectOption('name-desc');
    await page.setViewportSize({ width: 1280, height: 720 });
    const scroll = page.getByRole('region', { name: '线路总览表格', exact: true });
    const headerTop = (await scroll.getByRole('columnheader').first().boundingBox()).y;
    await scroll.evaluate(async (element) => { element.scrollTo(140, 220); await new Promise(requestAnimationFrame); });
    const before = await scroll.evaluate((element) => ({ left: element.scrollLeft, top: element.scrollTop }));
    assert.ok(before.left > 0 && before.top > 0);
    assert.ok(Math.abs((await scroll.getByRole('columnheader').first().boundingBox()).y - headerTop) <= 1, 'the header stays fixed while the table scrolls');
    await page.getByRole('region', { name: '项目线路', exact: true }).locator('.route-item').filter({ has: page.getByText('恢复线路12', { exact: true }) }).click();
    await page.getByRole('heading', { name: '恢复线路12', exact: true }).waitFor();
    assert.equal(await page.getByRole('link', { name: '跳到线路编辑', exact: true }).getAttribute('href'), '#line-editor');
    await page.getByRole('button', { name: '线路总览', exact: true }).focus(); await page.keyboard.press('Enter');
    await overview.waitFor();
    assert.equal(await search.inputValue(), '恢复');
    assert.equal(await page.getByLabel('结果状态筛选', { exact: true }).inputValue(), '未规划');
    assert.equal(await page.getByLabel('总览排序', { exact: true }).inputValue(), 'name-desc');
    assert.equal(await collapse.getAttribute('aria-expanded'), 'true');
    assert.deepEqual(await scroll.evaluate((element) => ({ left: element.scrollLeft, top: element.scrollTop })), before);
    assert.equal(await overview.evaluate((element) => document.activeElement === element), true);
    const skip = page.getByRole('link', { name: '跳到线路总览', exact: true });
    assert.equal(await skip.getAttribute('href'), '#route-overview');
    await skip.focus(); await page.keyboard.press('Enter');
    assert.equal(await overview.evaluate((element) => document.activeElement === element), true);
    await page.getByRole('button', { name: other.name, exact: true }).click();
    await overview.getByText('还没有线路', { exact: true }).waitFor();
    await page.getByRole('button', { name: project.name, exact: true }).click();
    await row.waitFor();
    assert.equal(await search.inputValue(), '');
    assert.equal(await page.getByLabel('结果状态筛选', { exact: true }).inputValue(), 'all');
    assert.equal(await page.getByLabel('总览排序', { exact: true }).inputValue(), 'created');
    assert.equal(await expand.getAttribute('aria-expanded'), 'false');
    assert.deepEqual(await scroll.evaluate((element) => ({ left: element.scrollLeft, top: element.scrollTop })), { left: 0, top: 0 });
    await search.fill('depot20');
    await page.reload(); await row.waitFor();
    assert.equal(await search.inputValue(), '');
    await page.setViewportSize({ width: 390, height: 844 });
    await scroll.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
    const dimensions = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, page: document.documentElement.scrollWidth }));
    assert.ok(dimensions.page <= dimensions.viewport + 1, 'the narrow page does not overflow horizontally');
    assert.ok(await scroll.evaluate((element) => element.scrollWidth > element.clientWidth && element.scrollLeft > 0), 'all seven columns are reachable within the table');
    assert.deepEqual(context.errors, []);
  } finally { await context.close(); }
});
