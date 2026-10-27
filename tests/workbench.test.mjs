import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startApplication, jsonRequest } from './helpers/application.mjs';
import { assertOverview, openRouteFromSidebar, goTask } from './helpers/browser-navigation.mjs';

async function openWorkbench(environment = {}) {
  const app = await startApplication({ AMAP_JS_KEY: '', AMAP_JS_SECURITY_CODE: '', AMAP_WEB_SERVICE_KEY: '', ...environment });
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1050 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return { app, browser, page, errors, async close() { await browser.close(); await app.stop(); await app.cleanup(); } };
}

async function describedText(locator) {
  return locator.evaluate((element) => (element.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent?.trim() ?? '').join(' '));
}

async function createProject(page, name) {
  await page.getByRole('button', { name: '新建项目', exact: true }).click();
  await page.getByLabel('项目名称', { exact: true }).fill(name);
  await page.getByRole('button', { name: '创建项目', exact: true }).click();
  await page.getByRole('heading', { name, exact: true }).waitFor();
  await assertOverview(page);
}
async function createRoute(page, name) {
  await page.getByRole('region', { name: '项目线路', exact: true }).getByRole('button', { name: '新建线路', exact: true }).click();
  await page.getByLabel('线路名称', { exact: true }).fill(name);
  await page.getByRole('button', { name: '创建线路', exact: true }).click();
  await page.getByRole('heading', { name, exact: true }).waitFor();
}

test('planner selects grouped preferences with descriptions, keyboard focus and failed-save recovery', { timeout: 120000 }, async () => {
  const context = await openWorkbench();
  const { page, app } = context;
  const request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
  try {
    await page.goto(app.baseUrl);
    await createProject(page, '规划偏好项目');
    await createRoute(page, '偏好草稿');
    await goTask(page, '测算线路');
    const select = page.getByLabel('规划偏好', { exact: true });
    assert.deepEqual(await select.locator('optgroup').evaluateAll((groups) => groups.map((group) => ({
      label: group.label, options: Array.from(group.children).map((option) => [option.value, option.textContent]),
    }))), [
      { label: '常用偏好', options: [['32', '高德推荐'], ['33', '躲避拥堵'], ['34', '高速优先'], ['35', '不走高速'], ['36', '少收费'], ['37', '大路优先'], ['38', '速度最快']] },
      { label: '组合偏好', options: [['39', '躲避拥堵＋高速优先'], ['40', '躲避拥堵＋不走高速'], ['41', '躲避拥堵＋少收费'], ['42', '少收费＋不走高速'], ['43', '躲避拥堵＋少收费＋不走高速'], ['44', '躲避拥堵＋大路优先'], ['45', '躲避拥堵＋速度最快']] },
      { label: '其他策略', options: [['0', '速度优先'], ['1', '费用优先'], ['2', '常规最快']] },
    ]);
    assert.equal(await select.locator('option').count(), 17);
    assert.match(await describedText(select), /高德地图 App 默认/);
    await select.focus();
    assert.equal(await select.evaluate((element) => element === document.activeElement), true);
    await select.press('Tab');
    assert.equal(await select.evaluate((element) => element === document.activeElement), false);
    for (const [value, description] of [['33', /拥堵/], ['0', /只返回一条路线.*不一定距离最短/], ['1', /只返回一条.*不走收费路段/], ['2', /只返回一条路线.*综合距离与耗时/], ['43', /躲避拥堵、少收费与不走高速/]]) {
      await Promise.all([
        page.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().includes('/api/routes/')),
        select.selectOption(value),
      ]);
      await page.waitForFunction((expected) => document.getElementById('strategy')?.value === expected && !document.getElementById('strategy')?.disabled, value);
      assert.match(await describedText(select), description);
    }
    const project = (await request('/api/projects')).body[0];
    const route = (await request(`/api/projects/${project.id}/routes`)).body[0];
    const path = `/api/routes/${route.id}?projectId=${project.id}`;
    assert.equal(route.strategy, 43);
    assert.equal((await request(path, 'PATCH', { strategy: 44, expectedVersion: route.inputVersion })).status, 200);
    await select.selectOption('45');
    await page.getByRole('alert').filter({ hasText: '线路已被更新' }).waitFor();
    assert.equal(await select.inputValue(), '43', 'failed saves must retain the last preference shown before the attempt');
    assert.match(await describedText(select), /躲避拥堵、少收费与不走高速/);
    assert.equal((await request(path)).body.strategy, 44, 'the stale browser must not overwrite the actual saved preference');
    await page.reload();
    await assertOverview(page);
    await openRouteFromSidebar(page, '偏好草稿');
    await page.getByRole('heading', { name: '偏好草稿', exact: true }).waitFor();
    await goTask(page, '测算线路');
    assert.equal(await select.inputValue(), '44');
    assert.deepEqual(context.errors, []);
  } finally { await context.close(); }
});

// This verifies integrated public behavior; a direct green result is not a bug-fix red phase.
test('new route drafts inherit project preferences after viewing old routes, reloading and opening another browser context', { timeout: 120000 }, async () => {
  const context = await openWorkbench();
  const { page, app, browser } = context;
  let otherBrowserContext;
  try {
    await page.goto(app.baseUrl);
    await createProject(page, '偏好继承项目');
    await createRoute(page, '原有推荐线路');
    await goTask(page, '测算线路');
    assert.equal(await page.getByLabel('规划偏好', { exact: true }).inputValue(), '32');
    await createRoute(page, '主动选择组合线路');
    await goTask(page, '测算线路');
    await Promise.all([
      page.waitForResponse((response) => response.request().method() === 'PATCH' && response.url().includes('/api/routes/') && response.ok()),
      page.getByLabel('规划偏好', { exact: true }).selectOption('43'),
    ]);
    await page.waitForFunction(() => document.getElementById('strategy')?.value === '43' && !document.getElementById('strategy')?.disabled);

    await page.getByRole('region', { name: '项目线路', exact: true }).locator('.route-item').filter({ has: page.getByText('原有推荐线路', { exact: true }) }).click();
    await page.getByRole('heading', { name: '原有推荐线路', exact: true }).waitFor();
    await goTask(page, '测算线路');
    assert.equal(await page.getByLabel('规划偏好', { exact: true }).inputValue(), '32', 'viewing an old route must retain its own preference');
    await createRoute(page, '查看旧线后继承');
    await goTask(page, '测算线路');
    assert.equal(await page.getByLabel('规划偏好', { exact: true }).inputValue(), '43');

    await page.reload();
    await assertOverview(page);
    await openRouteFromSidebar(page, '原有推荐线路');
    await page.getByRole('heading', { name: '原有推荐线路', exact: true }).waitFor();
    await goTask(page, '测算线路');
    assert.equal(await page.getByLabel('规划偏好', { exact: true }).inputValue(), '32');
    await createRoute(page, '刷新后继承');
    await goTask(page, '测算线路');
    assert.equal(await page.getByLabel('规划偏好', { exact: true }).inputValue(), '43');

    otherBrowserContext = await browser.newContext({ viewport: { width: 1600, height: 1050 } });
    const otherPage = await otherBrowserContext.newPage();
    otherPage.on('pageerror', (error) => context.errors.push(error.message));
    await otherPage.goto(app.baseUrl);
    await assertOverview(otherPage);
    await openRouteFromSidebar(otherPage, '原有推荐线路');
    await otherPage.getByRole('heading', { name: '原有推荐线路', exact: true }).waitFor();
    await goTask(otherPage, '测算线路');
    assert.equal(await otherPage.getByLabel('规划偏好', { exact: true }).inputValue(), '32');
    await createRoute(otherPage, '新浏览器上下文继承');
    await goTask(otherPage, '测算线路');
    assert.equal(await otherPage.getByLabel('规划偏好', { exact: true }).inputValue(), '43');

    await createProject(otherPage, '独立偏好项目');
    await createRoute(otherPage, '独立项目初始线路');
    await goTask(otherPage, '测算线路');
    assert.equal(await otherPage.getByLabel('规划偏好', { exact: true }).inputValue(), '32');
    await otherPage.getByRole('button', { name: '偏好继承项目', exact: true }).click();
    await assertOverview(otherPage);
    await openRouteFromSidebar(otherPage, '原有推荐线路');
    await otherPage.getByRole('heading', { name: '原有推荐线路', exact: true }).waitFor();
    await createRoute(otherPage, '切回项目后继承');
    await goTask(otherPage, '测算线路');
    assert.equal(await otherPage.getByLabel('规划偏好', { exact: true }).inputValue(), '43');
    assert.deepEqual(context.errors, []);
  } finally { await otherBrowserContext?.close(); await context.close(); }
});

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
    await assertOverview(page);
    await gate.ready;
    const create = page.getByRole('region', { name: '项目线路', exact: true }).getByRole('button', { name: '新建线路', exact: true });
    assert.equal(await create.isDisabled(), true, 'new routes must wait until project routes and points are loaded');
    await page.getByRole('button', { name: '管理点位库', exact: false }).click();
    assert.equal(await page.getByRole('button', { name: '添加点位', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '导入表格', exact: true }).isDisabled(), true);
    gate.release(); gate = null;
    await page.locator('.route-item-name').filter({ hasText: '原有线路' }).waitFor();
    await page.getByRole('button', { name: '线路总览', exact: true }).click();
    await createRoute(page, '新建线路');
    assert.deepEqual(await page.locator('.route-item-name').allTextContents(), ['原有线路', '新建线路']);
    assert.match(await page.getByRole('button', { name: '管理点位库', exact: true }).innerText(), /1/);
    assert.equal((await request(`/api/projects/${project.id}/routes`)).body.length, 2);
    assert.equal((await request(`/api/projects/${project.id}/points`)).body.length, 1);
    await page.getByRole('button', { name: '第二项目', exact: true }).click();
    await assertOverview(page);
    await openRouteFromSidebar(page, '第二项目线路');
    await page.getByRole('heading', { name: '第二项目线路', exact: true }).waitFor();
    gate = deliveryGate();
    await page.getByRole('button', { name: '加载中的项目', exact: true }).click();
    await gate.ready;
    await page.getByRole('button', { name: '第二项目', exact: true }).click();
    await assertOverview(page);
    await openRouteFromSidebar(page, '第二项目线路');
    await page.getByRole('heading', { name: '第二项目线路', exact: true }).waitFor();
    const late = gate; gate = null; late.release();
    await page.waitForResponse((response) => response.url().endsWith(`/api/projects/${project.id}/points`));
    assert.deepEqual(await page.locator('.route-item-name').allTextContents(), ['第二项目线路']);
    assert.match(await page.getByRole('button', { name: '管理点位库', exact: true }).innerText(), /2/);
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
    await assertOverview(page);
    await openRouteFromSidebar(page, '上海仓—南京客户');
    await page.getByRole('heading', { name: '上海仓—南京客户', exact: true }).waitFor();
    await goTask(page, '测算线路');
    await page.getByRole('heading', { name: '配置高德地图，查看真实线路', exact: true }).waitFor();
    assert.equal(await page.getByText('未校验重卡限高、限重及货车限行', { exact: true }).count(), 1);
    await page.getByRole('button', { name: '重命名', exact: true }).click();
    await page.getByLabel('线路名称', { exact: true }).fill('往返线路草稿');
    await page.getByRole('button', { name: '保存名称', exact: true }).click();
    await page.getByRole('heading', { name: '往返线路草稿', exact: true }).waitFor();
    await page.getByRole('button', { name: '线路总览', exact: true }).click();
    await page.getByRole('button', { name: '重命名项目', exact: true }).click();
    await page.getByLabel('项目名称', { exact: true }).fill('长三角正式项目');
    await page.getByRole('button', { name: '保存名称', exact: true }).click();
    await page.getByRole('button', { name: '长三角正式项目', exact: true }).waitFor();
    await page.getByRole('heading', { name: '长三角正式项目', exact: true }).waitFor();
    await createProject(page, '另一个项目');
    assert.equal(await page.getByRole('heading', { name: '往返线路草稿', exact: true }).count(), 0);
    await page.getByRole('button', { name: '长三角正式项目', exact: true }).click();
    await assertOverview(page);
    await openRouteFromSidebar(page, '往返线路草稿');
    await page.getByRole('heading', { name: '往返线路草稿', exact: true }).waitFor();
    await page.getByRole('button', { name: '删除', exact: true }).click();
    await page.getByRole('button', { name: '确认删除', exact: true }).click();
    const emptyOverview = await assertOverview(page);
    await emptyOverview.getByText('还没有线路', { exact: true }).waitFor();
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
    await assertOverview(page);
    await openRouteFromSidebar(page, '上海日常线路');
    await page.getByRole('heading', { name: '上海日常线路', exact: true }).waitFor();
    await goTask(page, '测算线路');
    await page.getByRole('heading', { name: '配置高德地图，查看真实线路', exact: true }).waitFor();
    assert.equal((await request('/api/config')).body.webServiceConfigured, true, 'server-side planning remains available without a JS map key');

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
    await goTask(page, '测算线路');
    assert.equal(await page.getByRole('button', { name: '开始规划', exact: true }).isDisabled(), true);
    await goTask(page, '编排点位');
    await page.getByRole('button', { name: '从点位库选择', exact: true }).click();
    const library = page.locator('.library-panel');
    assert.ok((await library.innerText()).includes('华东回程'), 'library selection identifies its destination route');
    await library.getByText('已添加 1 个点位', { exact: true }).waitFor();
    await library.getByRole('button', { name: '将 苏州客户 选入当前线路', exact: true }).click();
    await library.getByText('已添加 2 个点位', { exact: true }).waitFor();
    assert.equal(await library.isVisible(), true, 'selecting a point keeps the library open for the next point');
    await library.getByRole('button', { name: '将 南京终点 选入当前线路', exact: true }).click();
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
      assert.ok(within(await editorScroll.locator('.point-card').nth(index).boundingBox(), editorBounds), `point ${index + 1} must be fully visible in the 1280x720 editor: ${JSON.stringify({ point: await editorScroll.locator('.point-card').nth(index).boundingBox(), editor: editorBounds })}`);
    }
    const desktopViewport = { x: 0, y: 0, width: 1280, height: 720 };
    const addPointButton = page.getByRole('button', { name: '手动添加点位', exact: true });
    assert.ok(within(await addPointButton.boundingBox(), desktopViewport), 'the add-point action remains within the desktop viewport');
    await editorScroll.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    assert.ok(await editorScroll.evaluate((element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 1), 'the full point list can be reached within its editor');
    assert.ok(within(await addPointButton.boundingBox(), desktopViewport), 'the add-point action remains visible after scrolling the point list');
    await goTask(page, '测算线路');
    assert.ok(within(await page.getByRole('button', { name: '开始规划', exact: true }).boundingBox(), desktopViewport), 'planning remains within the desktop viewport in its task');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '开始规划', exact: true }).click();
    await page.getByText('路线方案已完整保存', { exact: true }).waitFor();
    assert.deepEqual(planningRequests, [[[121.47, 31.23], [120.58, 31.3]], [[120.58, 31.3], [118.79, 32.06]]]);
    assert.equal(await page.getByRole('button', { name: '测算线路', exact: true }).getAttribute('aria-pressed'), 'true', 'completion leaves the chosen task in place');
    await goTask(page, '核对方案');
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
    await assertOverview(page);
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
  const context = await openWorkbench({ AMAP_WEB_SERVICE_KEY: 'test-web-key' });
  const { page, app } = context;
  const request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
  const libraryDeletes = [];
  page.on('request', (event) => { if (event.method() === 'DELETE' && /\/api\/projects\/[^/]+\/points\/[^/?]+/.test(event.url())) libraryDeletes.push(event.url()); });
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
    await goTask(page, '测算线路');
    await page.getByRole('button', { name: '开始规划', exact: true }).click();
    await page.getByRole('alert').getByText('第 1、2 个点位坐标完全相同，请调整后规划。', { exact: true }).waitFor();
    await goTask(page, '编排点位');
    await page.getByRole('button', { name: '删除点位 2', exact: true }).click();
    await page.getByRole('button', { name: '从点位库选择', exact: true }).click();
    await page.getByRole('button', { name: '添加点位', exact: true }).click();
    const addLibrary = page.getByRole('dialog', { name: '添加点位', exact: true });
    await addLibrary.getByLabel('点位名称', { exact: true }).fill('苏州客户');
    await addLibrary.getByLabel('经度', { exact: true }).fill('120.58');
    await addLibrary.getByLabel('纬度', { exact: true }).fill('31.3');
    await addLibrary.getByRole('button', { name: '确认保存点位', exact: true }).click();
    await addLibrary.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '将 苏州客户 选入当前线路', exact: true }).click();
    await page.getByText('点位已复制到线路，之后独立维护', { exact: true }).waitFor();
    await page.getByRole('button', { name: '编辑点库点位 苏州客户', exact: true }).click();
    const editLibrary = page.getByRole('dialog', { name: '编辑点位', exact: true });
    await editLibrary.getByLabel('点位名称', { exact: true }).fill('苏州客户新名称');
    await editLibrary.getByRole('button', { name: '确认保存点位', exact: true }).click();
    await editLibrary.waitFor({ state: 'hidden' });
    const deleteLibrary = page.getByRole('button', { name: '删除点库点位 苏州客户新名称', exact: true });
    await deleteLibrary.click();
    const deleteDialog = page.getByRole('dialog', { name: '删除点库点位', exact: true });
    assert.ok((await deleteDialog.innerText()).includes('苏州客户新名称'), 'permanent deletion identifies the specific library point');
    assert.match(await deleteDialog.innerText(), /线路.*副本.*(?:不受影响|保留)/);
    assert.equal(await describedText(deleteDialog), '永久删除点库点位，已选入线路的副本保留。此操作无法撤销。', 'the dialog description explains permanent deletion rather than asking for form input');
    await deleteDialog.getByRole('button', { name: '取消', exact: true }).click();
    await deleteDialog.waitFor({ state: 'hidden' });
    await page.waitForFunction((button) => document.activeElement === button, await deleteLibrary.elementHandle());
    assert.equal(await deleteLibrary.evaluate((button) => document.activeElement === button), true, 'cancelling deletion returns keyboard focus to the point-specific trigger');
    assert.equal(libraryDeletes.length, 0, 'cancelling permanent deletion must not issue a DELETE');
    assert.equal(await deleteLibrary.isVisible(), true);
    const project = (await request('/api/projects')).body.find((item) => item.name === '点位维护项目');
    assert.deepEqual((await request(`/api/projects/${project.id}/points`)).body.map((point) => point.name), ['苏州客户新名称']);
    await deleteLibrary.click();
    await deleteDialog.getByRole('button', { name: '确认删除点位', exact: true }).click();
    await deleteDialog.waitFor({ state: 'hidden' });
    await page.getByText('已删除点库点位，线路副本保留', { exact: true }).waitFor();
    assert.equal(libraryDeletes.length, 1);
    assert.deepEqual((await request(`/api/projects/${project.id}/points`)).body, []);
    await page.getByRole('button', { name: '返回线路点位', exact: true }).click();
    assert.deepEqual(await points.locator('strong').allTextContents(), ['上海仓', '南京客户', '苏州客户']);
    await page.reload();
    await assertOverview(page);
    await openRouteFromSidebar(page, '上海往返');
    await page.getByRole('heading', { name: '上海往返', exact: true }).waitFor();
    assert.deepEqual(await points.locator('strong').allTextContents(), ['上海仓', '南京客户', '苏州客户']);
    await goTask(page, '核对方案');
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

test('removed route points preserve later edits, selection boundaries, and concurrent updates', { timeout: 120000 }, async () => {
  const context = await openWorkbench();
  const { page, app } = context;
  const request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
  try {
    const project = (await request('/api/projects', 'POST', { name: '撤销维护项目' })).body;
    const points = (await request('/api/coordinates', 'POST', { points: [
      { name: '上海仓', longitude: 121.47, latitude: 31.23, source: 'manual' },
      { name: '南京客户', longitude: 118.79, latitude: 32.06, source: 'manual' },
      { name: '上海返回', longitude: 121.47, latitude: 31.23, source: 'manual' },
    ] })).body;
    const original = (await request(`/api/projects/${project.id}/routes`, 'POST', { name: '撤销点位线路' })).body;
    const routePath = `/api/routes/${original.id}?projectId=${project.id}`;
    await request(routePath, 'PATCH', { points });
    await request(`/api/projects/${project.id}/routes`, 'POST', { name: '另一条线路' });
    const other = (await request('/api/projects', 'POST', { name: '另一个撤销项目' })).body;
    await request(`/api/projects/${other.id}/routes`, 'POST', { name: '其他项目线路' });
    await page.goto(app.baseUrl);
    await assertOverview(page);
    await openRouteFromSidebar(page, '撤销点位线路');
    await page.getByRole('heading', { name: '撤销点位线路', exact: true }).waitFor();
    const ordered = page.getByLabel('有序点位', { exact: true });
    const undo = page.getByRole('button', { name: '撤销移除', exact: true });
    await page.getByRole('button', { name: '删除点位 2', exact: true }).click();
    await page.getByText('已移除点位 南京客户', { exact: true }).waitFor();
    assert.deepEqual(await ordered.locator('strong').allTextContents(), ['上海仓', '上海返回']);
    await page.getByRole('button', { name: '编辑点位 上海仓', exact: true }).click();
    const edit = page.getByRole('dialog', { name: '编辑点位', exact: true });
    await edit.getByLabel('点位名称', { exact: true }).fill('上海仓新名称');
    await edit.getByLabel('经度', { exact: true }).fill('121.48');
    await edit.getByRole('button', { name: '确认保存点位', exact: true }).click();
    await edit.waitFor({ state: 'hidden' });
    await goTask(page, '测算线路');
    await page.getByLabel('规划偏好', { exact: true }).selectOption('34');
    await goTask(page, '编排点位');
    await addPoint(page, '杭州新增点', 120.15, 30.28);
    assert.equal(await undo.isVisible(), true, 'later edits keep the removal available to undo');
    await undo.click();
    await ordered.getByText('南京客户', { exact: true }).waitFor();
    assert.deepEqual(await ordered.locator('strong').allTextContents(), ['上海仓新名称', '南京客户', '上海返回', '杭州新增点']);
    await goTask(page, '测算线路');
    assert.equal(await page.getByLabel('规划偏好', { exact: true }).inputValue(), '34');
    const restored = (await request(routePath)).body;
    assert.deepEqual(restored.points.map((point) => point.name), ['上海仓新名称', '南京客户', '上海返回', '杭州新增点']);
    assert.equal(restored.points[0].longitude, 121.48);
    assert.equal(restored.points[0].originalLongitude, 121.48);
    assert.deepEqual(restored.points[1], points[1], 'undo restores the removed point with its stable identity and coordinates');
    assert.equal(restored.strategy, 34);
    assert.equal(await undo.count(), 0, 'an undo is consumed once');

    await goTask(page, '编排点位');
    await page.getByRole('button', { name: '删除点位 2', exact: true }).click();
    await page.getByText('已移除点位 南京客户', { exact: true }).waitFor();
    await page.getByRole('region', { name: '项目线路', exact: true }).getByRole('button').filter({ hasText: '另一条线路' }).click();
    await page.getByRole('heading', { name: '另一条线路', exact: true }).waitFor();
    assert.equal(await undo.count(), 0);
    await page.getByRole('region', { name: '项目线路', exact: true }).getByRole('button').filter({ hasText: '撤销点位线路' }).click();
    await page.getByRole('heading', { name: '撤销点位线路', exact: true }).waitFor();
    assert.equal(await undo.count(), 0, 'returning to a route must not revive an old undo');
    assert.deepEqual(await ordered.locator('strong').allTextContents(), ['上海仓新名称', '上海返回', '杭州新增点']);
    await page.getByRole('button', { name: '删除点位 1', exact: true }).click();
    await page.getByText('已移除点位 上海仓新名称', { exact: true }).waitFor();
    await page.getByRole('button', { name: '另一个撤销项目', exact: true }).click();
    await assertOverview(page);
    await openRouteFromSidebar(page, '其他项目线路');
    await page.getByRole('heading', { name: '其他项目线路', exact: true }).waitFor();
    assert.equal(await undo.count(), 0, 'an undo must not apply to a different project');
    await page.getByRole('button', { name: '撤销维护项目', exact: true }).click();
    await assertOverview(page);
    await openRouteFromSidebar(page, '撤销点位线路');
    await page.getByRole('heading', { name: '撤销点位线路', exact: true }).waitFor();
    assert.equal(await undo.count(), 0);
    assert.deepEqual((await request(routePath)).body.points.map((point) => point.name), ['上海返回', '杭州新增点']);

    await page.getByRole('button', { name: '删除点位 1', exact: true }).click();
    await page.getByText('已移除点位 上海返回', { exact: true }).waitFor();
    const current = (await request(routePath)).body;
    const concurrent = await request(routePath, 'PATCH', { expectedVersion: current.inputVersion, strategy: 36, points: current.points.map((point) => ({ ...point, name: '杭州并发更新' })) });
    assert.equal(concurrent.status, 200);
    const rejectedUndo = page.waitForResponse((response) => response.request().method() === 'PATCH' && response.url() === `${app.baseUrl}${routePath}`);
    await undo.click();
    assert.equal((await rejectedUndo).status(), 409, 'a stale undo must use the normal optimistic version check');
    await page.getByRole('alert').getByText('线路已被更新，请重新加载后编辑', { exact: true }).waitFor();
    assert.equal(await undo.isVisible(), true, 'a rejected undo retains the recovery entry');
    assert.deepEqual((await request(routePath)).body, concurrent.body, 'a conflicting undo must not overwrite any concurrent input');
    assert.deepEqual(context.errors, []);
  } finally { await context.close(); }
});

test('planning waits for configuration and offers local help without posting when the web service is missing', { timeout: 120000 }, async () => {
  const context = await openWorkbench();
  const { page, app } = context;
  const request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
  let releaseConfig;
  const heldConfig = new Promise((resolve) => { releaseConfig = resolve; });
  const planningPosts = [];
  page.on('request', (event) => { if (event.method() === 'POST' && /\/api\/routes\/[^/]+\/plan\?/.test(event.url())) planningPosts.push(event.url()); });
  try {
    const project = (await request('/api/projects', 'POST', { name: '配置检查项目' })).body;
    const route = (await request(`/api/projects/${project.id}/routes`, 'POST', { name: '等待配置线路' })).body;
    const points = (await request('/api/coordinates', 'POST', { points: [
      { name: '上海起点', longitude: 121.47, latitude: 31.23, source: 'manual' },
      { name: '南京终点', longitude: 118.79, latitude: 32.06, source: 'manual' },
    ] })).body;
    const routePath = `/api/routes/${route.id}?projectId=${project.id}`;
    await request(routePath, 'PATCH', { points });
    await page.route('**/api/config', async (route) => {
      const response = await route.fetch();
      await heldConfig;
      await route.fulfill({ response });
    });
    await page.goto(app.baseUrl);
    await assertOverview(page);
    await openRouteFromSidebar(page, '等待配置线路');
    await page.getByRole('heading', { name: '等待配置线路', exact: true }).waitFor();
    await goTask(page, '测算线路');
    const planning = page.getByRole('button', { name: '开始规划', exact: true });
    const controls = page.locator('.planning-controls');
    await controls.getByText('正在读取测算配置…', { exact: true }).waitFor();
    assert.equal(await planning.isDisabled(), true, 'planning waits for the real configuration response');
    await planning.evaluate((button) => button.click());
    assert.equal(planningPosts.length, 0);
    const receivedConfig = page.waitForResponse((response) => response.url().endsWith('/api/config'));
    releaseConfig();
    await receivedConfig;
    const help = controls.getByRole('button', { name: '查看测算配置', exact: true });
    await help.waitFor();
    await controls.getByText('配置 Web 服务后可测算', { exact: true }).waitFor();
    assert.equal(await planning.isDisabled(), true, 'two valid points do not enable planning without a Web service key');
    await planning.evaluate((button) => button.click());
    await help.click();
    const dialog = page.getByRole('dialog', { name: '测算配置帮助', exact: true });
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /AMAP_WEB_SERVICE_KEY/);
    assert.equal(await describedText(dialog), '查看本机测算与地图配置方法。', 'help has an informational accessible description');
    assert.equal(await dialog.getByRole('textbox').count(), 0, 'configuration help does not collect or save API credentials');
    await dialog.getByRole('button', { name: '我知道了', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.waitForFunction((button) => document.activeElement === button, await help.elementHandle());
    assert.equal(await help.evaluate((button) => document.activeElement === button), true, 'closing configuration help returns keyboard focus to its trigger');
    await help.click();
    await dialog.waitFor();
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    await page.waitForFunction((button) => document.activeElement === button, await help.elementHandle());
    assert.equal(planningPosts.length, 0, 'configuration loading and missing-key actions issue no planning POST');
    assert.equal((await request(routePath)).body.planning, null, 'blocked planning leaves saved route state untouched');
    assert.deepEqual(context.errors, []);
  } finally { releaseConfig(); await context.close(); }
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
    await goTask(page, '测算线路');
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
    await goTask(page, '编排点位');
    assert.deepEqual(await page.getByLabel('有序点位', {exact:true}).locator('strong').allTextContents(), ['上海搜索仓', '南京搜索客户', '地图选点']);
    await goTask(page, '测算线路');
    await page.getByRole('button', { name: '开始规划', exact: true }).click();
    await page.getByRole('progressbar', { name: '区间规划进度', exact: true }).waitFor();
    await page.getByText('路线方案已完整保存', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-sdk-polyline]').count(), 2);
    await goTask(page, '核对方案');
    assert.ok((await page.getByRole('region',{name:'路线方案',exact:true}).innerText()).includes('3.003'));
    assert.equal(planningCalls, 2);
    await page.getByRole('button', {name:'重命名',exact:true}).click();
    await page.getByLabel('线路名称',{exact:true}).fill('多点改名');
    await page.getByRole('button',{name:'保存名称',exact:true}).click();
    await page.getByRole('heading',{name:'多点改名',exact:true}).waitFor();
    assert.equal(await page.locator('[data-sdk-polyline]').count(), 2);
    await goTask(page, '测算线路');
    await page.getByLabel('规划偏好',{exact:true}).selectOption('34');
    await page.getByText('点位或偏好已变更，请重新规划。最近成功方案已保留。',{exact:true}).waitFor();
    assert.equal(await page.locator('[data-sdk-polyline]').count(), 0);
    await goTask(page, '核对方案');
    assert.ok(!(await page.getByRole('region',{name:'路线方案',exact:true}).innerText()).includes('3.003'));
    fail = true;
    await goTask(page, '测算线路');
    await page.getByRole('button',{name:'开始规划',exact:true}).click();
    await page.locator('.planning-error').waitFor();
    assert.equal(await page.getByRole('button',{name:'开始规划',exact:true}).isEnabled(), true);
    assert.equal(await page.locator('[data-sdk-polyline]').count(), 0);
    const callsBeforeReload = planningCalls;
    await page.reload();
    await assertOverview(page);
    await openRouteFromSidebar(page, '多点改名');
    await page.getByRole('heading',{name:'多点改名',exact:true}).waitFor();
    await goTask(page, '测算线路');
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
    await assertOverview(page);
    await page.getByRole('button', { name: '管理点位库', exact: false }).click();
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
    await goTask(page, '测算线路');
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
    await goTask(page, '测算线路');
    await page.waitForTimeout(1100);
    assert.equal(await page.getByRole('button',{name:'迟到地点 上海市',exact:true}).count(), 0);
    assert.equal(await search.inputValue(), '');
    assert.equal(await page.locator('[data-sdk-map="ready"]').count(), 1);
    await page.getByRole('button', { name: '线路总览', exact: true }).click();
    await page.getByRole('button',{name:'删除项目',exact:true}).click();
    await page.getByRole('button',{name:'确认删除',exact:true}).click();
    await page.getByRole('heading',{name:'从一个项目，规划下一程',exact:true}).waitFor();
    assert.equal(await page.locator('[data-sdk-map="ready"]').count(), 0);
    await createProject(page, '重新打开地图');
    assert.equal(await page.locator('[data-sdk-map="ready"]').count(), 0, 'an empty project opens its overview before mounting a map');
    await createRoute(page, '重新打开的地图线路');
    await goTask(page, '测算线路');
    await page.getByRole('textbox',{name:'搜索地点',exact:true}).waitFor();
    assert.equal(await page.locator('[data-sdk-map="ready"]').count(), 1);
    assert.deepEqual(context.errors, []);
  } finally { await context.close(); }
});

test('an empty project can prepare its point library before creating and arranging a route', { timeout: 120000 }, async () => {
  const context = await openWorkbench();
  const { page, app } = context;
  const routeRequests = [];
  page.on('request', (event) => { if (/\/api\/routes\//.test(event.url())) routeRequests.push(event.method()); });
  try {
    await page.goto(app.baseUrl);
    await createProject(page, '先整理项目资料');
    await page.getByRole('button', { name: '管理点位库', exact: true }).click();
    const library = page.getByRole('region', { name: '项目点位库', exact: true });
    await library.waitFor();
    assert.equal(await page.getByRole('region', { name: '线路编辑', exact: true }).count(), 0);
    assert.equal(await page.getByRole('region', { name: '地图预览', exact: true }).count(), 0);
    assert.equal(await page.getByRole('region', { name: '路线方案', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '返回线路点位', exact: true }).count(), 0);
    await library.getByRole('button', { name: '添加点位', exact: true }).click();
    const pointDialog = page.getByRole('dialog', { name: '添加点位', exact: true });
    await pointDialog.getByLabel('点位名称', { exact: true }).fill('先建上海仓');
    await pointDialog.getByLabel('经度', { exact: true }).fill('121.47');
    await pointDialog.getByLabel('纬度', { exact: true }).fill('31.23');
    await pointDialog.getByRole('button', { name: '确认保存点位', exact: true }).click();
    await pointDialog.waitFor({ state: 'hidden' });
    await library.getByRole('button', { name: '导入表格', exact: true }).click();
    const importing = page.getByRole('dialog', { name: '导入项目点位', exact: true });
    await importing.getByLabel('选择点位表格', { exact: true }).setInputFiles({ name: '常用点.csv', mimeType: 'text/csv', buffer: Buffer.from('名称,经度,纬度\n先建苏州客户,120.58,31.3\n') });
    await importing.getByLabel('工作表', { exact: true }).waitFor();
    await importing.getByRole('button', { name: '预览并校验', exact: true }).click();
    await importing.getByText('1 行有效', { exact: true }).waitFor();
    assert.deepEqual(await library.locator('.library-point strong').allTextContents(), ['先建上海仓'], 'import preview does not write project resources');
    await importing.getByRole('button', { name: '确认导入 1 行', exact: true }).click();
    await importing.waitFor({ state: 'hidden' });
    assert.deepEqual(await library.locator('.library-point strong').allTextContents(), ['先建上海仓', '先建苏州客户']);
    assert.equal(await library.getByRole('button', { name: /选入当前线路$/ }).count(), 0, 'management has no implicit route destination');
    const project = (await jsonRequest(app.baseUrl, '/api/projects')).body[0];
    assert.deepEqual((await jsonRequest(app.baseUrl, `/api/projects/${project.id}/routes`)).body, []);
    assert.equal((await jsonRequest(app.baseUrl, `/api/projects/${project.id}/points`)).body.length, 2);
    assert.deepEqual(routeRequests, [], 'preparing an empty project library does not select or mutate a route');

    await createRoute(page, '资料整理后的第一条线路');
    assert.equal(await page.getByRole('button', { name: '编排点位', exact: true }).getAttribute('aria-pressed'), 'true');
    await page.getByRole('button', { name: '从点位库选择', exact: true }).click();
    await library.getByText('资料整理后的第一条线路', { exact: true }).waitFor();
    for (const name of ['先建上海仓', '先建苏州客户']) {
      await library.getByRole('button', { name: `将 ${name} 选入当前线路`, exact: true }).click();
      await page.getByText('点位已复制到线路，之后独立维护', { exact: true }).waitFor();
    }
    await library.getByText('已添加 2 个点位', { exact: true }).waitFor();
    await library.getByRole('button', { name: '返回线路点位', exact: true }).click();
    assert.deepEqual(await page.getByLabel('有序点位', { exact: true }).locator('strong').allTextContents(), ['先建上海仓', '先建苏州客户']);
    const saved = (await jsonRequest(app.baseUrl, `/api/projects/${project.id}/routes`)).body[0];
    assert.deepEqual(saved.points.map((point) => point.name), ['先建上海仓', '先建苏州客户']);
    assert.equal(saved.snapshot, null);
    assert.deepEqual(context.errors, []);
  } finally { await context.close(); }
});

test('library selection stays bound to its route and is cleared by resource management or a project change', { timeout: 120000 }, async () => {
  const context = await openWorkbench();
  const { page, app } = context;
  const request = async (path, method, body) => {
    const result = await jsonRequest(app.baseUrl, path, method, body);
    assert.ok(result.status < 300, JSON.stringify(result));
    return result.body;
  };
  const planningPosts = [];
  page.on('request', (event) => { if (event.method() === 'POST' && /\/api\/routes\/[^/]+\/plan\?/.test(event.url())) planningPosts.push(event.url()); });
  try {
    const project = await request('/api/projects', 'POST', { name: '明确选点目标的项目' });
    const points = await request('/api/coordinates', 'POST', { points: [
      { name: '目标上海仓', longitude: 121.47, latitude: 31.23, source: 'manual' },
      { name: '目标苏州客户', longitude: 120.58, latitude: 31.3, source: 'manual' },
    ] });
    await request(`/api/projects/${project.id}/points`, 'POST', { points });
    const routeA = await request(`/api/projects/${project.id}/routes`, 'POST', { name: '选点目标 A' });
    const routeB = await request(`/api/projects/${project.id}/routes`, 'POST', { name: '选点目标 B' });
    const other = await request('/api/projects', 'POST', { name: '另一个资源项目' });
    await request(`/api/projects/${other.id}/points`, 'POST', { points: [{ ...points[0], name: '其他项目专属仓' }] });
    await page.goto(app.baseUrl);
    await assertOverview(page);
    await openRouteFromSidebar(page, routeA.name);
    await page.getByRole('button', { name: '从点位库选择', exact: true }).click();
    const library = page.getByRole('region', { name: '项目点位库', exact: true });
    await library.getByText(routeA.name, { exact: true }).waitFor();
    for (const [index, name] of ['目标上海仓', '目标苏州客户'].entries()) {
      await library.getByRole('button', { name: `将 ${name} 选入当前线路`, exact: true }).click();
      await library.getByText(`已添加 ${index + 1} 个点位`, { exact: true }).waitFor();
    }
    await page.getByRole('button', { name: '管理点位库', exact: true }).click();
    assert.equal(await library.getByRole('button', { name: /选入当前线路$/ }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '返回线路点位', exact: true }).count(), 0);
    assert.equal(await page.getByRole('region', { name: '项目线路', exact: true }).locator('.route-item[aria-pressed="true"]').count(), 0, 'resource management has no active route');
    await page.getByRole('button', { name: '线路工作台', exact: true }).click();
    await page.getByRole('heading', { name: routeA.name, exact: true }).waitFor();
    assert.deepEqual(await page.getByLabel('有序点位', { exact: true }).locator('strong').allTextContents(), ['目标上海仓', '目标苏州客户']);
    await openRouteFromSidebar(page, routeB.name);
    await page.getByRole('button', { name: '从点位库选择', exact: true }).click();
    await library.getByText(routeB.name, { exact: true }).waitFor();
    await library.getByText('已添加 0 个点位', { exact: true }).waitFor();
    await library.getByRole('button', { name: '将 目标苏州客户 选入当前线路', exact: true }).click();
    await library.getByText('已添加 1 个点位', { exact: true }).waitFor();
    await page.getByRole('button', { name: other.name, exact: true }).click();
    await assertOverview(page);
    await page.getByRole('button', { name: '管理点位库', exact: true }).click();
    assert.deepEqual(await library.locator('.library-point strong').allTextContents(), ['其他项目专属仓']);
    assert.equal(await library.getByRole('button', { name: /选入当前线路$/ }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '返回线路点位', exact: true }).count(), 0, 'a project switch clears the old selection destination');
    await page.getByRole('button', { name: project.name, exact: true }).click();
    await assertOverview(page);
    await page.getByRole('button', { name: '管理点位库', exact: true }).click();
    assert.equal(await library.getByRole('button', { name: /选入当前线路$/ }).count(), 0, 'returning to the project does not revive a selection mode');
    const savedA = await request(`/api/routes/${routeA.id}?projectId=${project.id}`);
    const savedB = await request(`/api/routes/${routeB.id}?projectId=${project.id}`);
    assert.deepEqual(savedA.points.map((point) => point.name), ['目标上海仓', '目标苏州客户']);
    assert.deepEqual(savedB.points.map((point) => point.name), ['目标苏州客户']);
    assert.deepEqual((await request(`/api/projects/${other.id}/routes`)), []);
    assert.equal(planningPosts.length, 0);
    assert.deepEqual(context.errors, []);
  } finally { await context.close(); }
});
