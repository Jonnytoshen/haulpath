// Browser globals below are evaluated inside Playwright callbacks.
/* global document */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';
import { startApplication, jsonRequest } from './helpers/application.mjs';
import { replaceAmapSDK } from './helpers/amap-browser.mjs';

const noMap = { AMAP_JS_KEY: '', AMAP_JS_SECURITY_CODE: '', AMAP_WEB_SERVICE_KEY: '' };
const regionOf = (page) => page.getByRole('region', { name: '项目电源接入点', exact: true });
const powerPath = (project) => `/api/projects/${project.id}/power-connection-points`;
async function openResources(page, baseUrl, project) {
  await page.goto(baseUrl);
  await page
    .getByRole('button', { name: project.name, exact: true, includeHidden: true })
    .waitFor({ state: 'attached' });
  const expand = page.getByRole('button', { name: '展开项目与线路', exact: true });
  if (await expand.isVisible()) await expand.click();
  await page.getByRole('button', { name: project.name, exact: true }).click();
  if (await expand.isVisible()) await expand.click();
  await page.getByRole('button', { name: '电源接入点', exact: true }).click();
  await regionOf(page).waitFor();
}
async function addForm(page, name, { system = 'GCJ-02', capacity = '', source = '' } = {}) {
  await regionOf(page).getByRole('button', { name: '添加电源点', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '添加电源点', exact: true });
  await dialog.getByLabel('电源点名称', { exact: true }).fill(name);
  await dialog.getByLabel('原始经度', { exact: true }).fill('121.47');
  await dialog.getByLabel('原始纬度', { exact: true }).fill('31.23');
  await dialog.getByLabel('坐标系', { exact: true }).selectOption(system);
  await dialog.getByLabel('可用容量（kW）', { exact: true }).fill(capacity);
  await dialog.getByLabel('容量来源', { exact: true }).fill(source);
  await dialog.getByLabel('接入资料说明', { exact: true }).fill('须由站址明确确认接电关系');
  await dialog.getByRole('button', { name: '添加到草稿', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}
async function save(page, project, expectedStatus = 200) {
  const response = page.waitForResponse(
    (entry) => entry.url().endsWith(powerPath(project)) && entry.request().method() === 'PUT',
  );
  await regionOf(page).getByRole('button', { name: '保存电源资料', exact: true }).click();
  const result = await response;
  assert.equal(result.status(), expectedStatus);
  if (expectedStatus === 200)
    await regionOf(page)
      .getByRole('status')
      .filter({ hasText: /已保存/ })
      .waitFor();
  else await regionOf(page).getByRole('alert').waitFor();
  return result.json();
}
const launch = () =>
  chromium.launch({ channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || 'chrome', headless: true });

test(
  'without map configuration, forms and checked paste save twenty power points and reopen from SQLite on mobile',
  { timeout: 180000 },
  async () => {
    let app = await startApplication(noMap);
    const directory = app.directory;
    const browser = await launch();
    const request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
    try {
      const project = (await request('/api/projects', 'POST', { name: '无地图电源验收' })).body;
      const scenario = (
        await request(`/api/projects/${project.id}/scenarios`, 'POST', { name: '资源独立草案' })
      ).body;
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await openResources(page, app.baseUrl, project);
      await addForm(page, '容量待核实');
      assert.match(await regionOf(page).innerText(), /缺少可用容量|待补资料/);
      assert.equal(
        (await request(powerPath(project))).body.points.length,
        0,
        'form edits remain a local draft until explicit save',
      );
      await regionOf(page).getByRole('button', { name: '批量粘贴电源点', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '批量粘贴电源点', exact: true });
      const paste = dialog.getByLabel('粘贴电源点表格', { exact: true });
      const row = (index, capacity = 600 + index) =>
        [
          `电源 ${index}`,
          121 + index / 100,
          31 + index / 100,
          'GCJ-02',
          capacity,
          '供电容量书面资料',
          '接电方案待确认',
        ].join('\t');
      await paste.fill(`${row(1)}\n${row(2, -1)}`);
      await dialog.getByRole('button', { name: '校验粘贴内容', exact: true }).click();
      assert.match(await dialog.innerText(), /第 2 行|第2行|2.*容量/);
      assert.equal(
        await dialog.getByRole('button', { name: '加入草稿', exact: true }).isEnabled(),
        false,
      );
      assert.equal((await request(powerPath(project))).body.points.length, 0);
      await paste.fill(
        Array.from({ length: 19 }, (_, index) =>
          row(index + 1, index === 0 ? 0 : 601 + index),
        ).join('\n'),
      );
      await dialog.getByRole('button', { name: '校验粘贴内容', exact: true }).click();
      await dialog.getByRole('button', { name: '加入草稿', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      assert.equal((await request(powerPath(project))).body.points.length, 0);
      const saved = await save(page, project);
      assert.equal(saved.points.length, 20);
      assert.equal(saved.points[0].availableCapacityKw, null);
      assert.equal(saved.points[0].capacitySource, '');
      assert.equal(saved.points[1].availableCapacityKw, 0);
      assert.match(await regionOf(page).innerText(), /当前不可供电/);
      assert.equal(saved.points[19].availableCapacityKw, 619);
      assert.equal(saved.points[19].capacitySource, '供电容量书面资料');
      assert.deepEqual(
        (await request(`/api/projects/${project.id}/scenarios/${scenario.id}`)).body,
        scenario,
      );
      assert.match(await regionOf(page).innerText(), /基础资料齐备/);
      assert.match(await regionOf(page).innerText(), /缺少容量来源|待补资料/);
      await page.close();
      await app.stop();
      const database = new Database(join(directory, 'test.sqlite'), { readonly: true });
      try {
        const persisted = database
          .prepare('SELECT payload FROM project_power_connection_points WHERE project_id = ?')
          .get(project.id);
        assert.deepEqual(JSON.parse(persisted.payload), saved);
      } finally {
        database.close();
      }
      app = await startApplication(noMap, directory);
      const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
      mobile.on('pageerror', (error) => errors.push(error.message));
      await openResources(mobile, app.baseUrl, project);
      await regionOf(mobile)
        .getByRole('button', { name: '编辑电源点 容量待核实', exact: true })
        .click();
      const edit = mobile.getByRole('dialog', { name: '编辑电源点', exact: true });
      assert.equal(await edit.getByLabel('原始经度', { exact: true }).inputValue(), '121.47');
      assert.equal(await edit.getByLabel('可用容量（kW）', { exact: true }).inputValue(), '');
      await edit.getByLabel('可用容量（kW）', { exact: true }).fill('850');
      await edit.getByLabel('容量来源', { exact: true }).fill('供电方确认资料');
      await edit.getByRole('button', { name: '更新草稿', exact: true }).click();
      await edit.waitFor({ state: 'hidden' });
      const updated = await save(mobile, project);
      assert.equal(updated.points[0].id, saved.points[0].id);
      assert.equal(updated.points[0].availableCapacityKw, 850);
      assert.equal(updated.points[0].capacitySource, '供电方确认资料');
      assert.equal(
        await mobile.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
        true,
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await app.stop();
      await app.cleanup();
    }
  },
);

test(
  'browser WGS84 power entry preserves original and normalized coordinates and failed conversions keep saved resources',
  { timeout: 120000 },
  async () => {
    let fail = false;
    const upstream = createServer((_request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify(
          fail
            ? { status: '0', info: 'conversion failed' }
            : { status: '1', locations: '121.476,31.236' },
        ),
      );
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const app = await startApplication({
      ...noMap,
      HAULPATH_TEST_MODE: '1',
      AMAP_WEB_SERVICE_KEY: 'power-browser-key',
      AMAP_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
    });
    const browser = await launch();
    const request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
    try {
      const project = (await request('/api/projects', 'POST', { name: 'GPS电源验收' })).body;
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      await openResources(page, app.baseUrl, project);
      await addForm(page, 'GPS电源', {
        system: 'WGS84',
        capacity: '1200',
        source: 'GPS现场记录与供电书面资料',
      });
      const saved = await save(page, project);
      assert.equal(saved.points[0].coordinateSystem, 'WGS84');
      assert.equal(saved.points[0].originalLongitude, 121.47);
      assert.equal(saved.points[0].originalLatitude, 31.23);
      assert.equal(saved.points[0].longitude, 121.476);
      assert.equal(saved.points[0].latitude, 31.236);
      assert.equal(saved.points[0].availableCapacityKw, 1200);
      assert.match(await regionOf(page).innerText(), /121\.476/);
      fail = true;
      await addForm(page, '本批转换失败', {
        system: 'WGS84',
        capacity: '900',
        source: '待复核GPS资料',
      });
      await save(page, project, 502);
      assert.match(await regionOf(page).innerText(), /失败|转换|高德/);
      assert.match(await regionOf(page).innerText(), /本批转换失败/);
      assert.deepEqual((await request(powerPath(project))).body, saved);
    } finally {
      await browser.close();
      await app.stop();
      await app.cleanup();
      await new Promise((resolve) => upstream.close(resolve));
    }
  },
);

test(
  'map-selected power coordinates remain an independent project resource with explicit capacity evidence',
  { timeout: 120000 },
  async () => {
    const app = await startApplication({
      AMAP_JS_KEY: 'power-map-key',
      AMAP_JS_SECURITY_CODE: 'power-map-code',
      AMAP_WEB_SERVICE_KEY: '',
    });
    const browser = await launch();
    const request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
    try {
      const project = (await request('/api/projects', 'POST', { name: '地图电源验收' })).body;
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      await replaceAmapSDK(page);
      await openResources(page, app.baseUrl, project);
      await regionOf(page).getByRole('button', { name: '展开选点地图', exact: true }).click();
      const canvas = regionOf(page).locator('[data-sdk-map="ready"]');
      await canvas.waitFor();
      await canvas.click({ position: { x: 40, y: 180 } });
      const dialog = page.getByRole('dialog', { name: '添加电源点', exact: true });
      await dialog.waitFor();
      assert.equal(await dialog.getByLabel('原始经度', { exact: true }).inputValue(), '119.2');
      assert.equal(await dialog.getByLabel('原始纬度', { exact: true }).inputValue(), '32.1');
      assert.equal(await dialog.getByLabel('坐标系', { exact: true }).inputValue(), 'GCJ-02');
      assert.equal(await dialog.getByLabel('可用容量（kW）', { exact: true }).inputValue(), '');
      assert.equal(await dialog.getByLabel('容量来源', { exact: true }).inputValue(), '');
      await dialog.getByLabel('电源点名称', { exact: true }).fill('现场核对电源');
      await dialog.getByLabel('可用容量（kW）', { exact: true }).fill('700');
      await dialog.getByLabel('容量来源', { exact: true }).fill('供电接入资料');
      await dialog.getByRole('button', { name: '添加到草稿', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      const saved = await save(page, project);
      assert.equal(saved.points[0].source, 'map');
      assert.equal(saved.points[0].originalLongitude, 119.2);
      assert.equal(saved.points[0].longitude, 119.2);
      assert.equal(saved.points[0].availableCapacityKw, 700);
      assert.equal(saved.points[0].capacitySource, '供电接入资料');
      assert.equal((await request(`/api/projects/${project.id}/points`)).body.length, 0);
      assert.equal((await request(`/api/projects/${project.id}/scenarios`)).body.length, 0);
    } finally {
      await browser.close();
      await app.stop();
      await app.cleanup();
    }
  },
);

test(
  'resource, project and route navigation preserve unconfirmed power drafts and wait for real saves',
  { timeout: 180000 },
  async () => {
    const app = await startApplication(noMap);
    const browser = await launch();
    const request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
    let releasePut = () => {};
    try {
      const project = (await request('/api/projects', 'POST', { name: '电源离开保护项目' })).body;
      const otherProject = (await request('/api/projects', 'POST', { name: '另一项目' })).body;
      const route = (
        await request(`/api/projects/${project.id}/routes`, 'POST', {
          name: '可打开的独立线路',
          points: [],
        })
      ).body;
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      const prompts = [];
      let acceptPrompt = false;
      page.on('dialog', async (dialog) => {
        prompts.push({ type: dialog.type(), message: dialog.message() });
        if (acceptPrompt) await dialog.accept();
        else await dialog.dismiss();
      });
      await openResources(page, app.baseUrl, project);
      const scenarios = () => page.getByRole('button', { name: '规划方案', exact: true });
      const projectButton = (item) => page.getByRole('button', { name: item.name, exact: true });
      const routeButton = () =>
        page
          .getByRole('region', { name: '项目线路', exact: true })
          .locator('.route-item')
          .filter({ has: page.getByText(route.name, { exact: true }) });
      async function assertDraftRetained(name) {
        assert.equal(await regionOf(page).isVisible(), true);
        assert.match(await regionOf(page).innerText(), new RegExp(name));
        assert.equal(await projectButton(project).getAttribute('aria-pressed'), 'true');
        assert.equal(
          await page
            .getByRole('button', { name: '电源接入点', exact: true })
            .getAttribute('aria-pressed'),
          'true',
        );
        assert.equal(await page.getByRole('region', { name: '线路编辑', exact: true }).count(), 0);
        assert.deepEqual((await request(powerPath(project))).body.points, []);
      }
      await addForm(page, '取消离开后仍在的草稿');
      for (const action of [
        () => scenarios().click(),
        () => projectButton(otherProject).click(),
        () => routeButton().click(),
      ]) {
        const before = prompts.length;
        await action();
        assert.equal(prompts.length, before + 1);
        assert.equal(prompts.at(-1).type, 'confirm');
        assert.match(prompts.at(-1).message, /未保存|放弃/);
        await assertDraftRetained('取消离开后仍在的草稿');
      }

      acceptPrompt = true;
      await scenarios().click();
      await regionOf(page).waitFor({ state: 'hidden' });
      assert.equal(await scenarios().getAttribute('aria-pressed'), 'true');
      await page.getByRole('button', { name: '电源接入点', exact: true }).click();
      await regionOf(page)
        .getByRole('heading', { name: '还没有电源接入点', exact: true })
        .waitFor();
      await addForm(page, '明确放弃再切项目');
      const beforeProjectLeave = prompts.length;
      await projectButton(otherProject).click();
      await regionOf(page).waitFor({ state: 'hidden' });
      assert.equal(prompts.length, beforeProjectLeave + 1);
      assert.equal(await projectButton(otherProject).getAttribute('aria-pressed'), 'true');
      await projectButton(project).click();
      await page.getByRole('button', { name: '电源接入点', exact: true }).click();
      await regionOf(page)
        .getByRole('heading', { name: '还没有电源接入点', exact: true })
        .waitFor();
      await addForm(page, '明确放弃再打开线路');
      const beforeRouteLeave = prompts.length;
      await routeButton().click();
      await page.getByRole('region', { name: '线路编辑', exact: true }).waitFor();
      await page.getByRole('heading', { name: route.name, exact: true }).waitFor();
      assert.equal(prompts.length, beforeRouteLeave + 1);
      assert.deepEqual((await request(powerPath(project))).body.points, []);

      await page.getByRole('button', { name: '电源接入点', exact: true }).click();
      await regionOf(page)
        .getByRole('heading', { name: '还没有电源接入点', exact: true })
        .waitFor();
      await addForm(page, '等待真实保存的电源', { capacity: '725', source: '供电方容量确认资料' });
      let markPaused;
      const paused = new Promise((resolve) => {
        markPaused = resolve;
      });
      const putGate = new Promise((resolve) => {
        releasePut = resolve;
      });
      await page.route(`**${powerPath(project)}`, async (intercepted) => {
        if (intercepted.request().method() === 'PUT') {
          markPaused();
          await putGate;
        }
        await intercepted.continue();
      });
      const saveResponse = page.waitForResponse(
        (response) =>
          response.url().endsWith(powerPath(project)) && response.request().method() === 'PUT',
      );
      await regionOf(page).getByRole('button', { name: '保存电源资料', exact: true }).click();
      await paused;
      const beforeSavingNavigation = prompts.length;
      for (const action of [
        () => scenarios().click(),
        () => projectButton(otherProject).click(),
        () => routeButton().click(),
      ]) {
        await action();
        await assertDraftRetained('等待真实保存的电源');
        assert.match(await regionOf(page).getByRole('status').innerText(), /正在保存/);
      }
      assert.equal(
        prompts.length,
        beforeSavingNavigation,
        'saving cannot be discarded through a navigation prompt',
      );
      releasePut();
      const response = await saveResponse;
      assert.equal(response.status(), 200);
      const saved = await response.json();
      await regionOf(page)
        .getByRole('status')
        .filter({ hasText: /已保存/ })
        .waitFor();
      assert.equal(saved.points.length, 1);
      assert.equal(saved.points[0].name, '等待真实保存的电源');
      assert.equal(saved.points[0].availableCapacityKw, 725);
      assert.deepEqual((await request(powerPath(project))).body, saved);
      const database = new Database(join(app.directory, 'test.sqlite'), { readonly: true });
      try {
        const persisted = database
          .prepare('SELECT payload FROM project_power_connection_points WHERE project_id = ?')
          .get(project.id);
        assert.deepEqual(JSON.parse(persisted.payload), saved);
      } finally {
        database.close();
      }
      await page.unroute(`**${powerPath(project)}`);
      await scenarios().click();
      await regionOf(page).waitFor({ state: 'hidden' });
      assert.equal(await scenarios().getAttribute('aria-pressed'), 'true');
      assert.equal(
        prompts.length,
        beforeSavingNavigation,
        'a successful save permits leaving without confirmation',
      );
    } finally {
      releasePut();
      await browser.close();
      await app.stop();
      await app.cleanup();
    }
  },
);
