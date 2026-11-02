// Browser globals are evaluated inside Playwright callbacks.
/* global document */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startApplication, jsonRequest } from './helpers/application.mjs';

const environment = { AMAP_JS_KEY: '', AMAP_JS_SECURITY_CODE: '', AMAP_WEB_SERVICE_KEY: '' };

async function openScenario(page, project, scenario, baseUrl) {
  await page.goto(baseUrl);
  const expand = page.getByRole('button', { name: '展开项目与线路', exact: true });
  if (await expand.isVisible()) await expand.click();
  await page.getByRole('button', { name: project.name, exact: true }).click();
  if (await expand.isVisible()) await expand.click();
  await page.getByRole('button', { name: '规划方案', exact: true }).click();
  await page.getByRole('button', { name: `打开规划方案 ${scenario.name}`, exact: true }).click();
}

async function importRoute(page, name) {
  await page.getByRole('button', { name: '从线路建立循环', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '从线路建立运输循环', exact: true });
  await dialog.getByLabel('来源线路', { exact: true }).selectOption({ label: name });
  await dialog.getByRole('button', { name: '引入线路快照', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}

test(
  'an open source route becomes an independently confirmed and persisted transport cycle',
  { timeout: 150000 },
  async () => {
    let app = await startApplication(environment);
    const directory = app.directory;
    const browser = await chromium.launch({
      channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || 'chrome',
      headless: true,
    });
    const errors = [];
    try {
      let request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
      const project = (await request('/api/projects', 'POST', { name: '港区循环验收' })).body;
      const points = (
        await request('/api/coordinates', 'POST', {
          points: [
            { name: '港区', longitude: 121.47, latitude: 31.23, source: 'manual' },
            { name: '料场', longitude: 121.6, latitude: 31.3, source: 'manual' },
          ],
        })
      ).body;
      const route = (
        await request(`/api/projects/${project.id}/routes`, 'POST', {
          name: '港区至料场',
          points,
          strategy: 43,
        })
      ).body;
      const scenarioPath = `/api/projects/${project.id}/scenarios`;
      const scenario = (await request(scenarioPath, 'POST', { name: '首期循环' })).body;
      const itemPath = `${scenarioPath}/${scenario.id}`;
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      page.on('pageerror', (error) => errors.push(error.message));
      await openScenario(page, project, scenario, app.baseUrl);
      await importRoute(page, route.name);
      const cycle = page.getByRole('region', { name: `运输循环 ${route.name}`, exact: true });
      await cycle.waitFor();
      assert.match(await cycle.innerText(), /未闭合/);
      assert.match(await cycle.innerText(), /道路/);
      await cycle.getByRole('button', { name: '编辑循环', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '编辑运输循环', exact: true });
      await dialog.getByRole('button', { name: '追加起点作为回程终点', exact: true }).click();
      await dialog.getByLabel('已核对业务点位顺序与闭合回程', { exact: true }).check();
      await dialog.getByRole('button', { name: '保存循环', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      assert.match(await cycle.innerText(), /已确认/);
      const saved = (await request(itemPath)).body;
      const savedCycle = saved.context.transportCycles[0];
      assert.equal(savedCycle.positions.length, 3);
      assert.equal(savedCycle.confirmed, true);
      assert.notEqual(savedCycle.positions[0].id, savedCycle.positions[2].id);
      assert.equal(savedCycle.strategy, 43);
      assert.deepEqual(
        (await request(`/api/routes/${route.id}?projectId=${project.id}`)).body,
        route,
      );
      await page.close();
      await app.stop();
      app = await startApplication(environment, directory);
      request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
      const reopened = await browser.newPage({ viewport: { width: 390, height: 844 } });
      reopened.on('pageerror', (error) => errors.push(error.message));
      await openScenario(reopened, project, scenario, app.baseUrl);
      const persisted = reopened.getByRole('region', {
        name: `运输循环 ${route.name}`,
        exact: true,
      });
      await persisted.waitFor();
      assert.match(await persisted.innerText(), /已确认/);
      assert.deepEqual((await request(itemPath)).body.context.transportCycles[0], savedCycle);
      assert.equal(
        await reopened.evaluate(
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
  'closed cycles preserve repeated occurrences while return order and source changes stay independent',
  { timeout: 120000 },
  async () => {
    const app = await startApplication(environment);
    const browser = await chromium.launch({
      channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || 'chrome',
      headless: true,
    });
    try {
      const request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
      const project = (await request('/api/projects', 'POST', { name: '闭合顺序验收' })).body;
      const points = (
        await request('/api/coordinates', 'POST', {
          points: [
            { name: '同名地点', longitude: 121.47, latitude: 31.23, source: 'manual' },
            { name: '同名地点', longitude: 121.6, latitude: 31.3, source: 'manual' },
            { name: '同名地点', longitude: 121.7, latitude: 31.4, source: 'manual' },
            { name: '同名地点', longitude: 121.47, latitude: 31.23, source: 'manual' },
          ],
        })
      ).body;
      const route = (
        await request(`/api/projects/${project.id}/routes`, 'POST', {
          name: '原始闭合线路',
          points,
          strategy: 34,
        })
      ).body;
      const scenario = (
        await request(`/api/projects/${project.id}/scenarios`, 'POST', { name: '顺序草案' })
      ).body;
      const path = `/api/projects/${project.id}/scenarios/${scenario.id}`;
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      await openScenario(page, project, scenario, app.baseUrl);
      await importRoute(page, route.name);
      let saved = (await request(path)).body.context.transportCycles[0];
      const originalIds = saved.positions.map((position) => position.id);
      assert.equal(new Set(originalIds).size, 4);
      const cycle = page.getByRole('region', { name: `运输循环 ${route.name}`, exact: true });
      assert.match(await cycle.innerText(), /待确认/);
      await request(`/api/routes/${route.id}?projectId=${project.id}`, 'PATCH', {
        name: '源线路后续变更',
        points: points.slice(0, 2),
        strategy: 35,
      });
      await page.reload();
      await openScenario(page, project, scenario, app.baseUrl);
      assert.match(await cycle.innerText(), /原始闭合线路/);
      await cycle.getByRole('button', { name: '编辑循环', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '编辑运输循环', exact: true });
      assert.equal(
        await dialog.getByRole('button', { name: '上移点位 3', exact: true }).count(),
        1,
      );
      await dialog.getByRole('button', { name: '上移点位 3', exact: true }).click();
      await dialog.getByLabel('循环规划偏好', { exact: true }).selectOption('43');
      await dialog.getByLabel('已核对业务点位顺序与闭合回程', { exact: true }).check();
      await dialog.getByRole('button', { name: '保存循环', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      saved = (await request(path)).body.context.transportCycles[0];
      assert.deepEqual(
        saved.positions.map((position) => position.id),
        [originalIds[0], originalIds[2], originalIds[1], originalIds[3]],
      );
      assert.equal(saved.confirmed, true);
      assert.equal(saved.strategy, 43);
      assert.deepEqual(saved.source.points, points);
      assert.equal(saved.source.strategy, 34);
      assert.equal(
        (await request(`/api/routes/${route.id}?projectId=${project.id}`)).body.strategy,
        35,
      );
      await cycle.getByRole('button', { name: '编辑循环', exact: true }).click();
      await dialog.getByRole('button', { name: '移除点位 4', exact: true }).click();
      await dialog.getByLabel('新增点位名称', { exact: true }).fill('回程核对点');
      await dialog.getByLabel('新增点位经度', { exact: true }).fill('121.55');
      await dialog.getByLabel('新增点位纬度', { exact: true }).fill('31.25');
      await dialog.getByRole('button', { name: '追加业务点位', exact: true }).click();
      await dialog.getByRole('button', { name: '追加起点作为回程终点', exact: true }).click();
      await dialog.getByLabel('已核对业务点位顺序与闭合回程', { exact: true }).check();
      await dialog.getByRole('button', { name: '保存循环', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      saved = (await request(path)).body.context.transportCycles[0];
      assert.equal(saved.positions.length, 5);
      assert.equal(saved.positions[3].point.name, '回程核对点');
      assert.equal(saved.positions[3].point.coordinateSystem, 'GCJ-02');
      assert.equal(new Set(saved.positions.map((position) => position.id)).size, 5);
      await cycle.getByRole('button', { name: '删除循环', exact: true }).click();
      await page.getByRole('button', { name: '确认删除循环', exact: true }).click();
      await page.getByText('还没有运输循环。', { exact: false }).waitFor();
      assert.deepEqual((await request(path)).body.context.transportCycles, []);
      assert.equal((await request(`/api/routes/${route.id}?projectId=${project.id}`)).status, 200);
    } finally {
      await browser.close();
      await app.stop();
      await app.cleanup();
    }
  },
);
