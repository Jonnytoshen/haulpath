// Browser globals are evaluated inside Playwright callbacks.
/* global document, window */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startApplication, jsonRequest } from './helpers/application.mjs';
import { assertOverview, openRouteFromSidebar } from './helpers/browser-navigation.mjs';

const environment = { AMAP_JS_KEY: '', AMAP_JS_SECURITY_CODE: '', AMAP_WEB_SERVICE_KEY: '' };
const scenarios = (projectId) => `/api/projects/${projectId}/scenarios`;

async function selectProject(page, name) {
  await page.getByRole('button', { name, exact: true }).click();
}
async function openScenarios(page) {
  const expand = page.getByRole('button', { name: '展开项目与线路', exact: true });
  if (await expand.isVisible()) await expand.click();
  assert.equal(await page.getByRole('button', { name: '规划方案', exact: true }).count(), 1);
  await page.getByRole('button', { name: '规划方案', exact: true }).click();
  await page.getByRole('region', { name: '项目规划方案', exact: true }).waitFor();
}
async function createScenario(page, name) {
  await page.getByRole('button', { name: '新建规划方案', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建规划方案', exact: true });
  await dialog.getByLabel('方案名称', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: '创建方案', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page
    .getByRole('region', { name: '当前规划方案', exact: true })
    .getByRole('heading', { name, exact: true })
    .waitFor();
}

test(
  'scenario workbench creates, reopens, renames and deletes persisted drafts while routes and library remain usable',
  { timeout: 180000 },
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
      const project = (await request('/api/projects', 'POST', { name: '换电规划项目' })).body;
      const route = (
        await request(`/api/projects/${project.id}/routes`, 'POST', {
          name: '保留的运输线路',
          strategy: 43,
        })
      ).body;
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(app.baseUrl);
      await selectProject(page, project.name);
      await assertOverview(page);
      await openScenarios(page);
      await createScenario(page, '北区首期草案');
      const current = page.getByRole('region', { name: '当前规划方案', exact: true });
      assert.match(await current.innerText(), /输入版本\s*1/);
      assert.match(
        await page.getByRole('region', { name: '项目规划方案', exact: true }).innerText(),
        /换电规划项目/,
      );
      const saved = (await request(scenarios(project.id))).body[0];
      assert.equal(saved.name, '北区首期草案');
      assert.equal(saved.inputVersion, 1);
      await createScenario(page, '南区备选草案');
      await page.getByRole('button', { name: '打开规划方案 北区首期草案', exact: true }).click();
      await current.getByRole('heading', { name: saved.name, exact: true }).waitFor();
      await page.getByRole('button', { name: '重命名规划方案', exact: true }).click();
      let dialog = page.getByRole('dialog', { name: '重命名规划方案', exact: true });
      await dialog.getByLabel('方案名称', { exact: true }).fill('北区审阅草案');
      await dialog.getByRole('button', { name: '保存名称', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      await current.getByRole('heading', { name: '北区审阅草案', exact: true }).waitFor();
      assert.equal((await request(`${scenarios(project.id)}/${saved.id}`)).body.inputVersion, 1);
      await openRouteFromSidebar(page, route.name);
      await page.getByRole('button', { name: '管理点位库', exact: true }).click();
      await page.getByRole('region', { name: '项目点位库', exact: true }).waitFor();
      assert.deepEqual(
        (await request(`/api/routes/${route.id}?projectId=${project.id}`)).body,
        route,
      );
      await page.close();
      await app.stop();
      app = await startApplication(environment, directory);
      request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
      const newContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const reopened = await newContext.newPage();
      reopened.on('pageerror', (error) => errors.push(error.message));
      await reopened.goto(app.baseUrl);
      // A new browser context has no local state: reopen the same server-owned draft.
      const expand = reopened.getByRole('button', { name: '展开项目与线路', exact: true });
      if (await expand.isVisible()) await expand.click();
      await selectProject(reopened, project.name);
      await openScenarios(reopened);
      await reopened
        .getByRole('button', { name: '打开规划方案 北区审阅草案', exact: true })
        .click();
      await reopened
        .getByRole('region', { name: '当前规划方案', exact: true })
        .getByRole('heading', { name: '北区审阅草案', exact: true })
        .waitFor();
      assert.equal(
        await reopened.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
        true,
      );
      await reopened.getByRole('button', { name: '删除规划方案', exact: true }).click();
      dialog = reopened.getByRole('dialog', { name: '删除规划方案', exact: true });
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
      assert.equal((await request(`${scenarios(project.id)}/${saved.id}`)).status, 200);
      await reopened.getByRole('button', { name: '删除规划方案', exact: true }).click();
      await dialog.getByRole('button', { name: '确认删除方案', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      assert.equal((await request(`${scenarios(project.id)}/${saved.id}`)).status, 404);
      assert.deepEqual(
        (await request(scenarios(project.id))).body.map((item) => item.name),
        ['南区备选草案'],
      );
      assert.deepEqual(errors, []);
      await newContext.close();
    } finally {
      await browser.close();
      await app.stop();
      await app.cleanup();
    }
  },
);

test(
  'scenario stale saves and deletes require reloading, and project switching clears the selected draft',
  { timeout: 120000 },
  async () => {
    const app = await startApplication(environment);
    const browser = await chromium.launch({
      channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || 'chrome',
      headless: true,
    });
    try {
      const request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
      const project = (await request('/api/projects', 'POST', { name: '并发草案项目' })).body;
      const other = (await request('/api/projects', 'POST', { name: '隔离草案项目' })).body;
      let scenario = (await request(scenarios(project.id), 'POST', { name: '原始草案' })).body;
      const itemPath = `${scenarios(project.id)}/${scenario.id}`;
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      await page.goto(app.baseUrl);
      await selectProject(page, project.name);
      await openScenarios(page);
      await page.getByRole('button', { name: '打开规划方案 原始草案', exact: true }).click();
      const current = page.getByRole('region', { name: '当前规划方案', exact: true });
      await current.getByRole('heading', { name: '原始草案', exact: true }).waitFor();
      scenario = (
        await request(itemPath, 'PATCH', {
          name: '另一窗口已保存',
          expectedRevision: scenario.revision,
        })
      ).body;
      await page.getByRole('button', { name: '重命名规划方案', exact: true }).click();
      let dialog = page.getByRole('dialog', { name: '重命名规划方案', exact: true });
      await dialog.getByLabel('方案名称', { exact: true }).fill('过时窗口的编辑');
      const failedSave = page.waitForResponse(
        (response) => response.url().endsWith(itemPath) && response.request().method() === 'PATCH',
      );
      await dialog.getByRole('button', { name: '保存名称', exact: true }).click();
      assert.equal((await failedSave).status(), 409);
      assert.equal(
        await dialog.getByLabel('方案名称', { exact: true }).inputValue(),
        '过时窗口的编辑',
      );
      assert.equal((await request(itemPath)).body.name, '另一窗口已保存');
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
      await page.getByRole('button', { name: '刷新规划方案', exact: true }).click();
      await current.getByRole('heading', { name: '另一窗口已保存', exact: true }).waitFor();
      scenario = (
        await request(itemPath, 'PATCH', {
          name: '再次从另一窗口保存',
          expectedRevision: scenario.revision,
        })
      ).body;
      await page.getByRole('button', { name: '删除规划方案', exact: true }).click();
      dialog = page.getByRole('dialog', { name: '删除规划方案', exact: true });
      const failedDelete = page.waitForResponse(
        (response) => response.url().includes(itemPath) && response.request().method() === 'DELETE',
      );
      await dialog.getByRole('button', { name: '确认删除方案', exact: true }).click();
      assert.equal((await failedDelete).status(), 409);
      assert.equal((await request(itemPath)).body.name, scenario.name);
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
      await selectProject(page, other.name);
      await assertOverview(page);
      await openScenarios(page);
      await page.getByRole('heading', { name: '还没有规划方案', exact: true }).waitFor();
      assert.equal(
        await page.getByRole('region', { name: '当前规划方案', exact: true }).count(),
        0,
      );
      await selectProject(page, project.name);
      await openScenarios(page);
      await page
        .getByRole('button', { name: `打开规划方案 ${scenario.name}`, exact: true })
        .click();
      await current.getByRole('heading', { name: scenario.name, exact: true }).waitFor();
    } finally {
      await browser.close();
      await app.stop();
      await app.cleanup();
    }
  },
);

test(
  'long scenario lists and detail actions remain reachable in short desktop viewports',
  { timeout: 120000 },
  async () => {
    const app = await startApplication(environment);
    const browser = await chromium.launch({
      channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || 'chrome',
      headless: true,
    });
    try {
      const request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
      const project = (await request('/api/projects', 'POST', { name: '多草案项目' })).body;
      for (let number = 1; number <= 30; number++) {
        const created = await request(scenarios(project.id), 'POST', {
          name: `运输草案 ${number}`,
        });
        assert.equal(created.status, 201);
      }
      const page = await browser.newPage({ viewport: { width: 1440, height: 700 } });
      await page.goto(app.baseUrl);
      await selectProject(page, project.name);
      await openScenarios(page);
      const last = page.getByRole('button', { name: '打开规划方案 运输草案 30', exact: true });
      await last.waitFor();
      await last.scrollIntoViewIfNeeded();
      const newDraft = page.getByRole('button', { name: '新建规划方案', exact: true });
      const insideViewport = (locator) =>
        locator.evaluate((element) => {
          const box = element.getBoundingClientRect();
          return box.top >= 0 && box.bottom <= window.innerHeight;
        });
      assert.equal(
        await insideViewport(last),
        true,
        'the last persisted draft can be scrolled into view',
      );
      assert.equal(
        await insideViewport(newDraft),
        true,
        'creating a draft remains available while scrolling the list',
      );
      await last.click();
      const detail = page.getByRole('region', { name: '当前规划方案', exact: true });
      await detail.getByRole('heading', { name: '运输草案 30', exact: true }).waitFor();
      const rename = detail.getByRole('button', { name: '重命名规划方案', exact: true });
      await rename.scrollIntoViewIfNeeded();
      assert.equal(await insideViewport(rename), true);
      await rename.click();
      await page
        .getByRole('dialog', { name: '重命名规划方案', exact: true })
        .getByRole('button', { name: '取消', exact: true })
        .click();
      await page.setViewportSize({ width: 1024, height: 600 });
      await page.getByRole('button', { name: '返回方案列表', exact: true }).click();
      await last.scrollIntoViewIfNeeded();
      assert.equal(await insideViewport(last), true);
      assert.equal(await insideViewport(newDraft), true);
      await last.click();
      await detail.getByRole('heading', { name: '运输草案 30', exact: true }).waitFor();
      await rename.scrollIntoViewIfNeeded();
      assert.equal(await insideViewport(rename), true);
      assert.equal(await insideViewport(newDraft), true);
    } finally {
      await browser.close();
      await app.stop();
      await app.cleanup();
    }
  },
);
