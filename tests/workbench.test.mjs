import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startApplication, jsonRequest } from './helpers/application.mjs';

async function openWorkbench(environment = {}) {
  const app = await startApplication({ AMAP_JS_KEY: '', AMAP_JS_SECURITY_CODE: '', AMAP_WEB_SERVICE_KEY: '', ...environment });
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1050 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return { app, browser, page, errors, async close() { await browser.close(); await app.stop(); await app.cleanup(); } };
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

test('project loading blocks dependent writes and late responses cannot replace another project', { timeout: 120000 }, async () => {
  const context = await openWorkbench();
  const { page, app } = context;
  const request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
  function deliveryGate() {
    let release, started;
    return { delivered: 0, ready: new Promise((resolve) => { started = resolve; }), held: new Promise((resolve) => { release = resolve; }), release: () => release(), started: () => started() };
  }
  let gate = deliveryGate();
  try {
    const project = (await request('/api/projects', 'POST', { name: '加载中的项目' })).body;
    await request(`/api/projects/${project.id}/routes`, 'POST', { name: '原有线路' });
    const points = (await request('/api/coordinates', 'POST', { points: [{ name: '原有点位', longitude: 121.47, latitude: 31.23, source: 'manual' }] })).body;
    await request(`/api/projects/${project.id}/points`, 'POST', { points });
    const other = (await request('/api/projects', 'POST', { name: '第二项目' })).body;
    await request(`/api/projects/${other.id}/routes`, 'POST', { name: '第二项目线路' });
    await request(`/api/projects/${other.id}/points`, 'POST', { points: [points[0], points[0]] });
    await page.route(new RegExp(`/api/projects/${project.id}/(routes|points)$`), async (route) => {
      const pending = gate;
      if (route.request().method() !== 'GET' || !pending) return route.continue();
      // Delay delivery of actual application responses; do not replace their data or persist through a side channel.
      const response = await route.fetch();
      if (++pending.delivered === 2) pending.started();
      await pending.held;
      await route.fulfill({ response });
    });
    await page.goto(app.baseUrl);
    await gate.ready;
    const create = page.getByRole('region', { name: '项目线路', exact: true }).getByRole('button', { name: '新建线路', exact: true });
    assert.equal(await create.isDisabled(), true, 'new routes must wait until project routes and points are loaded');
    await page.getByRole('button', { name: '管理点位库', exact: false }).click();
    assert.equal(await page.getByRole('button', { name: '添加点位', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '导入表格', exact: true }).isDisabled(), true);
    gate.release(); gate = null;
    await page.locator('.route-item-name').filter({ hasText: '原有线路' }).waitFor();
    await page.getByRole('button', { name: '线路点位', exact: true }).click();
    await createRoute(page, '新建线路');
    assert.deepEqual(await page.locator('.route-item-name').allTextContents(), ['原有线路', '新建线路']);
    assert.match(await page.locator('.project-summary strong').innerText(), /1\s*个点位/);
    assert.equal((await request(`/api/projects/${project.id}/routes`)).body.length, 2);
    assert.equal((await request(`/api/projects/${project.id}/points`)).body.length, 1);
    await page.getByRole('button', { name: '第二项目', exact: true }).click();
    await page.getByRole('heading', { name: '第二项目线路', exact: true }).waitFor();
    gate = deliveryGate();
    await page.getByRole('button', { name: '加载中的项目', exact: true }).click();
    await gate.ready;
    await page.getByRole('button', { name: '第二项目', exact: true }).click();
    await page.getByRole('heading', { name: '第二项目线路', exact: true }).waitFor();
    const late = gate; gate = null; late.release();
    await page.waitForResponse((response) => response.url().endsWith(`/api/projects/${project.id}/points`));
    assert.deepEqual(await page.locator('.route-item-name').allTextContents(), ['第二项目线路']);
    assert.match(await page.locator('.project-summary strong').innerText(), /2\s*个点位/);
    assert.deepEqual(context.errors, []);
  } finally { gate?.release(); await context.close(); }
});

test('planner creates and renames projects and route drafts, then reopens saved data', { timeout: 120000 }, async () => {
  const context = await openWorkbench();
  const { page } = context;
  try {
    await page.goto(context.app.baseUrl);
    await createProject(page, '长三角运输');
    await createRoute(page, '上海仓—南京客户');
    await page.reload();
    await page.getByRole('heading', { name: '上海仓—南京客户', exact: true }).waitFor();
    await page.getByRole('heading', { name: '配置高德地图，查看真实线路', exact: true }).waitFor();
    assert.equal(await page.getByText('未校验重卡限高、限重及货车限行', { exact: true }).count(), 1);
    await page.getByRole('button', { name: '重命名', exact: true }).click();
    await page.getByLabel('线路名称', { exact: true }).fill('往返线路草稿');
    await page.getByRole('button', { name: '保存名称', exact: true }).click();
    await page.getByRole('heading', { name: '往返线路草稿', exact: true }).waitFor();
    await page.getByRole('button', { name: '重命名项目', exact: true }).click();
    await page.getByLabel('项目名称', { exact: true }).fill('长三角正式项目');
    await page.getByRole('button', { name: '保存名称', exact: true }).click();
    await page.getByRole('heading', { name: '长三角正式项目', exact: true }).waitFor();
    await createProject(page, '另一个项目');
    assert.equal(await page.getByRole('heading', { name: '往返线路草稿', exact: true }).count(), 0);
    await page.getByRole('button', { name: '长三角正式项目', exact: true }).click();
    await page.getByRole('heading', { name: '往返线路草稿', exact: true }).waitFor();
    await page.getByRole('region', { name: '线路编辑', exact: true }).getByRole('button', { name: '删除', exact: true }).click();
    await page.getByRole('button', { name: '确认删除', exact: true }).click();
    await page.getByText('选择一条线路开始编辑', { exact: true }).waitFor();
    await page.getByRole('button', { name: '删除项目', exact: true }).click();
    await page.getByRole('button', { name: '确认删除', exact: true }).click();
    await page.getByRole('heading', { name: '另一个项目', exact: true }).waitFor();
    assert.deepEqual(context.errors, []);
  } finally { await context.close(); }
});

async function addPoint(page, name, longitude, latitude) {
  await page.getByRole('button', { name: '手动添加点位', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '添加点位', exact: true });
  await dialog.getByLabel('点位名称', { exact: true }).fill(name);
  await dialog.getByLabel('经度', { exact: true }).fill(String(longitude));
  await dialog.getByLabel('纬度', { exact: true }).fill(String(latitude));
  await dialog.getByRole('button', { name: '确认保存点位', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}

test('route filtering and mobile navigation support point selection through planning and export', { timeout: 120000 }, async () => {
  const { createServer } = await import('node:http');
  const planningRequests = [];
  const upstream = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    planningRequests.push(['origin', 'destination'].map((key) => url.searchParams.get(key).split(',').map(Number)));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: '1', route: { paths: [{ distance: planningRequests.length === 1 ? '1001' : '2002', steps: [{ polyline: `${url.searchParams.get('origin')};${url.searchParams.get('destination')}` }] }] } }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  let context;
  try {
    context = await openWorkbench({ HAULPATH_TEST_MODE: '1', AMAP_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}`, AMAP_WEB_SERVICE_KEY: 'test-web-key' });
    const { page, app } = context;
    const request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
    const project = (await request('/api/projects', 'POST', { name: '华东线路项目' })).body;
    await request(`/api/projects/${project.id}/routes`, 'POST', { name: '上海日常线路' });
    await request(`/api/projects/${project.id}/routes`, 'POST', { name: '华东回程' });
    const points = (await request('/api/coordinates', 'POST', { points: [
      { name: '苏州客户', longitude: 120.58, latitude: 31.3, source: 'manual' },
      { name: '南京终点', longitude: 118.79, latitude: 32.06, source: 'manual' },
    ] })).body;
    await request(`/api/projects/${project.id}/points`, 'POST', { points });
    await page.goto(app.baseUrl);
    await page.getByRole('heading', { name: '上海日常线路', exact: true }).waitFor();

    const search = page.getByRole('textbox', { name: '搜索线路', exact: true });
    await search.fill('回程');
    assert.deepEqual(await page.locator('.route-item-name').allTextContents(), ['华东回程']);
    await search.fill('不存在的线路');
    assert.equal(await page.locator('.route-item-name').count(), 0);
    await page.getByRole('button', { name: '清除筛选', exact: true }).click();
    assert.equal(await search.inputValue(), '');
    assert.deepEqual(await page.locator('.route-item-name').allTextContents(), ['上海日常线路', '华东回程']);

    async function assertNoHorizontalOverflow(state) {
      const dimensions = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
      assert.ok(dimensions.content <= dimensions.viewport + 1, `${state}: page width ${dimensions.content} exceeds viewport ${dimensions.viewport}`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '展开项目与线路', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '华东线路项目', exact: true }).isVisible(), true);
    assert.equal(await search.isVisible(), true, 'route filtering remains reachable in mobile navigation');
    await assertNoHorizontalOverflow('expanded mobile navigation');
    await page.getByRole('region', { name: '项目线路', exact: true }).getByRole('button').filter({ hasText: '华东回程' }).click();
    const collapseNavigation = page.getByRole('button', { name: '收起项目与线路', exact: true });
    if (await collapseNavigation.isVisible()) await collapseNavigation.click();
    assert.equal(await page.getByRole('heading', { name: '华东回程', exact: true }).isVisible(), true);
    await assertNoHorizontalOverflow('mobile route editor');

    await addPoint(page, '上海起点', 121.47, 31.23);
    await page.getByText('再添加一个点位，即可开始规划。', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '开始规划', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: '从点位库选择', exact: true }).click();
    const library = page.locator('.library-panel');
    assert.ok((await library.innerText()).includes('华东回程'), 'library selection identifies its destination route');
    await library.getByText('已添加 1 个点位', { exact: true }).waitFor();
    await library.locator('.library-point').filter({ hasText: '苏州客户' }).getByRole('button', { name: '选入线路', exact: true }).click();
    await library.getByText('已添加 2 个点位', { exact: true }).waitFor();
    assert.equal(await library.isVisible(), true, 'selecting a point keeps the library open for the next point');
    await library.locator('.library-point').filter({ hasText: '南京终点' }).getByRole('button', { name: '选入线路', exact: true }).click();
    await library.getByText('已添加 3 个点位', { exact: true }).waitFor();
    await assertNoHorizontalOverflow('mobile library selection');
    await page.getByRole('button', { name: '返回线路点位', exact: true }).click();
    assert.deepEqual(await page.getByLabel('有序点位', { exact: true }).locator('strong').allTextContents(), ['上海起点', '苏州客户', '南京终点']);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.evaluate(() => window.scrollTo(0, 0));
    const editorScroll = page.locator('.editor-scroll');
    await editorScroll.evaluate((element) => { element.scrollTop = 0; });
    const editorBounds = await editorScroll.boundingBox();
    const within = (inner, outer) => inner && outer && inner.x >= outer.x - 1 && inner.y >= outer.y - 1 && inner.x + inner.width <= outer.x + outer.width + 1 && inner.y + inner.height <= outer.y + outer.height + 1;
    for (const index of [0, 1]) {
      assert.ok(within(await editorScroll.locator('.point-card').nth(index).boundingBox(), editorBounds), `point ${index + 1} must be fully visible in the 1280x720 editor`);
    }
    const desktopViewport = { x: 0, y: 0, width: 1280, height: 720 };
    const addPointButton = page.getByRole('button', { name: '手动添加点位', exact: true });
    assert.ok(within(await addPointButton.boundingBox(), desktopViewport), 'the add-point action remains within the desktop viewport');
    assert.ok(within(await page.getByRole('button', { name: '开始规划', exact: true }).boundingBox(), desktopViewport), 'planning remains within the desktop viewport');
    await editorScroll.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    assert.ok(await editorScroll.evaluate((element) => element.scrollTop > 0), 'the point editor has been scrolled to its bottom');
    assert.ok(within(await addPointButton.boundingBox(), desktopViewport), 'the add-point action remains visible after scrolling the point list');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '开始规划', exact: true }).click();
    await page.getByText('路线方案已完整保存', { exact: true }).waitFor();
    assert.deepEqual(planningRequests, [[[121.47, 31.23], [120.58, 31.3]], [[120.58, 31.3], [118.79, 32.06]]]);
    assert.ok((await page.getByRole('region', { name: '路线方案', exact: true }).innerText()).includes('3.003'));
    await assertNoHorizontalOverflow('mobile planning results');

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出当前线路', exact: true }).click();
    const file = await download;
    const { default: ExcelJS } = await import('exceljs');
    const book = new ExcelJS.Workbook();
    await book.xlsx.readFile(await file.path());
    assert.deepEqual(book.worksheets.map((sheet) => sheet.name), ['线路总览', '区间明细']);
    assert.equal(book.getWorksheet('线路总览').getCell('C3').value, '华东回程');
    assert.equal(book.getWorksheet('线路总览').getCell('F3').value, '上海起点 → 苏州客户 → 南京终点');
    assert.equal(book.getWorksheet('线路总览').getCell('G3').value, 3.003);
    assert.equal(book.getWorksheet('区间明细').rowCount, 4);
    assert.equal(book.getWorksheet('区间明细').getCell('H4').value, 3.003);
    await page.reload();
    await page.getByRole('button', { name: '展开项目与线路', exact: true }).click();
    await page.getByRole('region', { name: '项目线路', exact: true }).getByRole('button').filter({ hasText: '华东回程' }).click();
    const collapseAfterReload = page.getByRole('button', { name: '收起项目与线路', exact: true });
    if (await collapseAfterReload.isVisible()) await collapseAfterReload.click();
    assert.deepEqual(await page.getByLabel('有序点位', { exact: true }).locator('strong').allTextContents(), ['上海起点', '苏州客户', '南京终点']);
    assert.equal(planningRequests.length, 2, 'reopening a saved route does not automatically plan again');
    assert.deepEqual(context.errors, []);
  } finally {
    if (context) await context.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test('planner edits ordered points, reuses an independent project library copy, and downloads a workbook', { timeout: 120000 }, async () => {
  const context = await openWorkbench();
  const { page } = context;
  try {
    await page.goto(context.app.baseUrl);
    await createProject(page, '点位维护项目');
    await createRoute(page, '上海往返');
    await addPoint(page, '上海仓', 121.47, 31.23);
    await addPoint(page, '南京客户', 118.79, 32.06);
    await addPoint(page, '上海返回', 121.47, 31.23);
    const points = page.getByLabel('有序点位', { exact: true });
    assert.deepEqual(await points.locator('strong').allTextContents(), ['上海仓', '南京客户', '上海返回']);
    await page.getByRole('button', { name: '上移点位 3', exact: true }).click();
    await page.getByText('点位顺序已保存', { exact: true }).waitFor();
    assert.deepEqual(await points.locator('strong').allTextContents(), ['上海仓', '上海返回', '南京客户']);
    await page.getByRole('button', { name: '开始规划', exact: true }).click();
    await page.getByRole('alert').getByText('第 1、2 个点位坐标完全相同，请调整后规划。', { exact: true }).waitFor();
    await page.getByRole('button', { name: '删除点位 2', exact: true }).click();
    await page.getByRole('button', { name: '从点位库选择', exact: true }).click();
    await page.getByRole('button', { name: '添加点位', exact: true }).click();
    const addLibrary = page.getByRole('dialog', { name: '添加点位', exact: true });
    await addLibrary.getByLabel('点位名称', { exact: true }).fill('苏州客户');
    await addLibrary.getByLabel('经度', { exact: true }).fill('120.58');
    await addLibrary.getByLabel('纬度', { exact: true }).fill('31.3');
    await addLibrary.getByRole('button', { name: '确认保存点位', exact: true }).click();
    await addLibrary.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '选入线路', exact: true }).click();
    await page.getByText('点位已复制到线路，之后独立维护', { exact: true }).waitFor();
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    const editLibrary = page.getByRole('dialog', { name: '编辑点位', exact: true });
    await editLibrary.getByLabel('点位名称', { exact: true }).fill('苏州客户新名称');
    await editLibrary.getByRole('button', { name: '确认保存点位', exact: true }).click();
    await editLibrary.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '删除', exact: true }).click();
    await page.getByText('已删除点库点位，线路副本保留', { exact: true }).waitFor();
    await page.getByRole('button', { name: '线路点位', exact: true }).click();
    assert.deepEqual(await points.locator('strong').allTextContents(), ['上海仓', '南京客户', '苏州客户']);
    await page.reload();
    await page.getByRole('heading', { name: '上海往返', exact: true }).waitFor();
    assert.deepEqual(await points.locator('strong').allTextContents(), ['上海仓', '南京客户', '苏州客户']);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出当前线路', exact: true }).click();
    const file = await download;
    const { default: ExcelJS } = await import('exceljs');
    const book = new ExcelJS.Workbook(); await book.xlsx.readFile(await file.path());
    assert.deepEqual(book.worksheets.map((sheet) => sheet.name), ['线路总览', '区间明细']);
    assert.ok(JSON.stringify(book.getWorksheet('线路总览').getSheetValues()).includes('苏州客户'));
    assert.deepEqual(context.errors, []);
  } finally { await context.close(); }
});

test('map search and clicks produce confirmed points, and planning results become stale after editing', { timeout: 120000 }, async () => {
  const { createServer } = await import('node:http');
  const { replaceAmapSDK } = await import('./helpers/amap-browser.mjs');
  let fail = false;
  let planningCalls = 0;
  const upstream = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname.includes('coordinate')) { res.end(JSON.stringify({status:'1',locations:'120.6,31.4'})); return; }
    planningCalls++;
    await new Promise((resolve) => setTimeout(resolve, 350));
    if (fail) { res.end(JSON.stringify({status:'0',infocode:'10003'})); return; }
    const distance = planningCalls % 2 ? '1001' : '2002';
    res.end(JSON.stringify({ status: '1', route: { paths: [{ distance, steps: [{ polyline: `${url.searchParams.get('origin')};${url.searchParams.get('destination')}` }] }] } }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const context = await openWorkbench({ HAULPATH_TEST_MODE: '1', AMAP_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}`, AMAP_WEB_SERVICE_KEY: 'test-web-key', AMAP_JS_KEY: 'test-js-key', AMAP_JS_SECURITY_CODE: 'test-security-secret' });
  const { page } = context;
  try {
    await replaceAmapSDK(page);
    await page.goto(context.app.baseUrl);
    await createProject(page, '地图规划项目');
    await createRoute(page, '多点实测');
    await page.getByRole('textbox', { name: '搜索地点', exact: true }).fill('上海');
    await page.getByRole('button', { name: '上海搜索仓 上海市', exact: true }).click();
    const confirm = page.getByRole('dialog', { name: '确认地图点位', exact: true });
    await confirm.getByRole('button', { name: '确认保存点位', exact: true }).click();
    await confirm.waitFor({ state: 'hidden' });
    await page.getByRole('textbox', { name: '搜索地点', exact: true }).fill('南京');
    await page.getByRole('button', { name: '搜索', exact: true }).click();
    await page.getByRole('button', { name: '南京搜索客户', exact: true }).click();
    await confirm.getByRole('button', { name: '确认保存点位', exact: true }).click();
    await confirm.waitFor({ state: 'hidden' });
    await page.getByRole('region', { name: '高德地图', exact: true }).click({position:{x:400,y:250}});
    await confirm.getByLabel('点位名称', { exact: true }).fill('地图选点');
    await confirm.getByRole('button', { name: '确认保存点位', exact: true }).click();
    await confirm.waitFor({ state: 'hidden' });
    assert.deepEqual(await page.getByLabel('有序点位', {exact:true}).locator('strong').allTextContents(), ['上海搜索仓', '南京搜索客户', '地图选点']);
    await page.getByRole('button', { name: '开始规划', exact: true }).click();
    await page.getByRole('progressbar', { name: '区间规划进度', exact: true }).waitFor();
    await page.getByText('路线方案已完整保存', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-sdk-polyline]').count(), 2);
    assert.ok((await page.getByRole('region',{name:'路线方案',exact:true}).innerText()).includes('3.003'));
    assert.equal(planningCalls, 2);
    await page.getByRole('button', {name:'重命名',exact:true}).click();
    await page.getByLabel('线路名称',{exact:true}).fill('多点改名');
    await page.getByRole('button',{name:'保存名称',exact:true}).click();
    await page.getByRole('heading',{name:'多点改名',exact:true}).waitFor();
    assert.equal(await page.locator('[data-sdk-polyline]').count(), 2);
    await page.getByLabel('规划偏好',{exact:true}).selectOption('34');
    await page.getByText('点位或偏好已变更，请重新规划。最近成功方案已保留。',{exact:true}).waitFor();
    assert.equal(await page.locator('[data-sdk-polyline]').count(), 0);
    assert.ok(!(await page.getByRole('region',{name:'路线方案',exact:true}).innerText()).includes('3.003'));
    fail = true;
    await page.getByRole('button',{name:'开始规划',exact:true}).click();
    await page.locator('.planning-error').waitFor();
    assert.equal(await page.getByRole('button',{name:'开始规划',exact:true}).isEnabled(), true);
    assert.equal(await page.locator('[data-sdk-polyline]').count(), 0);
    const callsBeforeReload = planningCalls;
    await page.reload();
    await page.getByRole('heading',{name:'多点改名',exact:true}).waitFor();
    assert.equal(planningCalls, callsBeforeReload);
    assert.equal(await page.locator('[data-sdk-polyline]').count(), 0);
    assert.deepEqual(context.errors, []);
  } finally { await context.close(); await new Promise((resolve)=>upstream.close(resolve)); }
});

test('planner maps Excel columns, reviews original error rows, and confirms only selected valid points', { timeout: 120000 }, async () => {
  const context = await openWorkbench();
  const { page } = context;
  try {
    await page.goto(context.app.baseUrl);
    await createProject(page, '导入项目');
    await createRoute(page, '导入点位线路');
    await page.getByRole('button', { name: '从点位库选择', exact: true }).click();
    await page.getByRole('button', { name: '导入表格', exact: true }).click();
    const { default: ExcelJS } = await import('exceljs');
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('说明').addRows([['说明'], ['请使用业务点位工作表']]);
    workbook.addWorksheet('业务点位').addRows([['东经', '北纬', '站点'], [121.47, 31.23, '上海导入仓'], ['bad', 32, '无效点'], [118.79, 32.06, '南京导入客户']]);
    const dialog = page.getByRole('dialog', { name: '导入项目点位', exact: true });
    await dialog.getByLabel('选择点位表格', {exact:true}).setInputFiles({ name: '点位.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(await workbook.xlsx.writeBuffer()) });
    await dialog.getByLabel('工作表', {exact:true}).selectOption('业务点位');
    await dialog.getByLabel('名称列', {exact:true}).selectOption('2');
    await dialog.getByLabel('经度列', {exact:true}).selectOption('0');
    await dialog.getByLabel('纬度列', {exact:true}).selectOption('1');
    await dialog.getByRole('button', {name:'预览并校验',exact:true}).click();
    await dialog.getByText('2 行有效', {exact:true}).waitFor();
    assert.equal(await dialog.getByLabel('选择第 3 行', {exact:true}).isDisabled(), true);
    await dialog.getByLabel('选择第 4 行', {exact:true}).uncheck();
    assert.equal(await page.locator('.library-point').count(), 0);
    await dialog.getByRole('button', {name:'确认导入 1 行',exact:true}).click();
    await dialog.waitFor({state:'hidden'});
    assert.deepEqual(await page.locator('.library-point strong').allTextContents(), ['上海导入仓']);
    await page.getByRole('button', {name:'导入表格',exact:true}).click();
    await dialog.getByLabel('选择点位表格',{exact:true}).setInputFiles({name:'新增.csv',mimeType:'text/csv',buffer:Buffer.from('名称,经度,纬度\n苏州CSV客户,120.58,31.3\n')});
    await dialog.getByRole('button',{name:'预览并校验',exact:true}).click();
    await dialog.getByText('1 行有效',{exact:true}).waitFor();
    await dialog.getByRole('button',{name:'确认导入 1 行',exact:true}).click();
    await dialog.waitFor({state:'hidden'});
    assert.deepEqual(await page.locator('.library-point strong').allTextContents(), ['上海导入仓', '苏州CSV客户']);
    await page.reload();
    await page.getByRole('button', {name:/项目点位库 2/}).click();
    assert.deepEqual(await page.locator('.library-point strong').allTextContents(), ['上海导入仓', '苏州CSV客户']);
    assert.deepEqual(context.errors, []);
  } finally { await context.close(); }
});

test('map rejects coordinate-less search suggestions and discards late callbacks when switching routes', { timeout: 120000 }, async () => {
  const { replaceAmapSDK } = await import('./helpers/amap-browser.mjs');
  const context = await openWorkbench({ AMAP_JS_KEY: 'test-js-key', AMAP_JS_SECURITY_CODE: 'test-js-secret' });
  const { page } = context;
  try {
    await replaceAmapSDK(page);
    await page.goto(context.app.baseUrl);
    await createProject(page, '地图生命周期项目');
    await createRoute(page, '原线路');
    const search = page.getByRole('textbox', {name:'搜索地点',exact:true});
    await search.fill('无坐标');
    await page.getByRole('button',{name:'没有具体坐标的地区',exact:true}).click();
    await page.getByText('该提示没有可用坐标，请点击搜索寻找具体地点。',{exact:true}).waitFor();
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(await page.locator('[data-sdk-marker]').count(), 0);
    await search.fill('迟到');
    // The external SDK fixture delivers this autocomplete result after 1 second.
    await page.waitForTimeout(400);
    await createRoute(page, '新线路');
    await page.waitForTimeout(1100);
    assert.equal(await page.getByRole('button',{name:'迟到地点 上海市',exact:true}).count(), 0);
    assert.equal(await search.inputValue(), '');
    assert.equal(await page.locator('[data-sdk-map="ready"]').count(), 1);
    await page.getByRole('button',{name:'删除项目',exact:true}).click();
    await page.getByRole('button',{name:'确认删除',exact:true}).click();
    await page.getByRole('heading',{name:'从一个项目，规划下一程',exact:true}).waitFor();
    assert.equal(await page.locator('[data-sdk-map="ready"]').count(), 0);
    await createProject(page, '重新打开地图');
    await page.getByRole('textbox',{name:'搜索地点',exact:true}).waitFor();
    assert.equal(await page.locator('[data-sdk-map="ready"]').count(), 1);
    assert.deepEqual(context.errors, []);
  } finally { await context.close(); }
});
