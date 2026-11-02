// Browser globals are evaluated inside Playwright callbacks.
/* global document */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startApplication, jsonRequest } from './helpers/application.mjs';

const environment = { AMAP_JS_KEY: '', AMAP_JS_SECURITY_CODE: '', AMAP_WEB_SERVICE_KEY: '' };

async function fixture(request, name) {
  const project = (await request('/api/projects', 'POST', { name })).body;
  const points = (
    await request('/api/coordinates', 'POST', {
      points: [
        { name: '同名业务点', longitude: 121.47, latitude: 31.23, source: 'manual' },
        { name: '同名业务点', longitude: 121.6, latitude: 31.3, source: 'manual' },
        { name: '同名业务点', longitude: 121.7, latitude: 31.4, source: 'manual' },
        { name: '同名业务点', longitude: 121.47, latitude: 31.23, source: 'manual' },
      ],
    })
  ).body;
  const route = (
    await request(`/api/projects/${project.id}/routes`, 'POST', {
      name: '同名多点往返',
      points,
    })
  ).body;
  const scenario = (
    await request(`/api/projects/${project.id}/scenarios`, 'POST', { name: '混装需求草案' })
  ).body;
  const path = `/api/projects/${project.id}/scenarios/${scenario.id}`;
  let saved = (
    await request(`${path}/cycles`, 'POST', { sourceRouteId: route.id, expectedRevision: 1 })
  ).body;
  const cycle = saved.context.transportCycles[0];
  saved = (
    await request(`${path}/cycles/${cycle.id}`, 'PATCH', {
      expectedRevision: saved.revision,
      confirmed: true,
    })
  ).body;
  return { project, scenario: saved, cycle: saved.context.transportCycles[0], path };
}

async function openScenario(page, baseUrl, project, scenario) {
  await page.goto(baseUrl);
  const expand = page.getByRole('button', { name: '展开项目与线路', exact: true });
  if (await expand.isVisible()) await expand.click();
  await page.getByRole('button', { name: project.name, exact: true }).click();
  if (await expand.isVisible()) await expand.click();
  await page.getByRole('button', { name: '规划方案', exact: true }).click();
  await page.getByRole('button', { name: `打开规划方案 ${scenario.name}`, exact: true }).click();
  await page.getByRole('region', { name: '方案运输需求', exact: true }).waitFor();
}

async function editDemands(page) {
  await page.getByRole('button', { name: '维护运输需求', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '维护运输需求', exact: true });
  await dialog.waitFor();
  return dialog;
}

test(
  'forms and atomic paste preserve same-name occurrences and show explainable daily flows after restart',
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
      const request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
      const { project, scenario, cycle, path } = await fixture(request, '日货流验收');
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      page.on('pageerror', (error) => errors.push(error.message));
      await openScenario(page, app.baseUrl, project, scenario);
      const dialog = await editDemands(page);
      await dialog.getByLabel('需求所属循环', { exact: true }).selectOption(cycle.id);
      await dialog.getByRole('button', { name: '新增需求', exact: true }).click();
      await dialog
        .getByLabel('需求 1 装货位置', { exact: true })
        .selectOption(cycle.positions[2].id);
      await dialog
        .getByLabel('需求 1 卸货位置', { exact: true })
        .selectOption(cycle.positions[1].id);
      await dialog.getByLabel('需求 1 日吨数', { exact: true }).fill('12.5');
      await dialog.getByRole('button', { name: '保存全部需求', exact: true }).click();
      assert.match(await dialog.getByRole('alert').innerText(), /第 1 行/);
      assert.equal((await request(path)).body.context.transportDemands, undefined);
      await dialog
        .getByLabel('需求 1 装货位置', { exact: true })
        .selectOption(cycle.positions[0].id);
      await dialog
        .getByLabel('需求 1 卸货位置', { exact: true })
        .selectOption(cycle.positions[2].id);
      await dialog.getByLabel('需求 1 日吨数', { exact: true }).fill('12.5');
      await dialog.getByText('批量粘贴需求', { exact: true }).click();
      const pasted = dialog.getByLabel('批量需求', { exact: true });
      await pasted.fill('2\t4\t7.25\n3\t2\t9');
      await dialog.getByRole('button', { name: '校验粘贴内容', exact: true }).click();
      assert.match(await dialog.getByRole('alert').innerText(), /第 2 行/);
      assert.equal(await dialog.getByLabel('需求 2 日吨数', { exact: true }).count(), 0);
      assert.equal(
        await dialog.getByRole('button', { name: '加入需求草稿', exact: true }).count(),
        0,
      );
      assert.equal((await request(path)).body.context.transportDemands, undefined);
      await pasted.fill('2\t99\t7.25');
      await dialog.getByRole('button', { name: '校验粘贴内容', exact: true }).click();
      assert.match(await dialog.getByRole('alert').innerText(), /第 1 行/);
      await pasted.fill('2\t4\t0');
      await dialog.getByRole('button', { name: '校验粘贴内容', exact: true }).click();
      assert.match(await dialog.getByRole('alert').innerText(), /第 1 行/);
      await pasted.fill('2\t4\t7.25');
      await dialog.getByRole('button', { name: '校验粘贴内容', exact: true }).click();
      await dialog.getByRole('table', { name: '粘贴需求预览', exact: true }).waitFor();
      await dialog.getByRole('button', { name: '加入需求草稿', exact: true }).click();
      assert.equal(await dialog.getByLabel('需求 2 日吨数', { exact: true }).inputValue(), '7.25');
      assert.equal((await request(path)).body.context.transportDemands, undefined);
      await dialog.getByRole('button', { name: '保存全部需求', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      await page.getByText('运输需求已保存', { exact: true }).waitFor();
      const saved = (await request(path)).body;
      assert.deepEqual(
        saved.context.transportDemands.map(
          ({ loadingPositionId, unloadingPositionId, dailyTonnes }) => [
            loadingPositionId,
            unloadingPositionId,
            dailyTonnes,
          ],
        ),
        [
          [cycle.positions[0].id, cycle.positions[2].id, 12.5],
          [cycle.positions[1].id, cycle.positions[3].id, 7.25],
        ],
      );
      const demandRegion = page.getByRole('region', { name: '方案运输需求', exact: true });
      assert.match(await demandRegion.innerText(), /日需求|每日需求/);
      assert.match(await demandRegion.innerText(), /车次|车辆/);
      const flow = demandRegion.getByRole('table', {
        name: `${cycle.name} 区间日货流`,
        exact: true,
      });
      const rows = flow.getByRole('row');
      assert.equal(await rows.count(), 4);
      for (const [index, value] of ['12.5', '19.75', '7.25'].entries()) {
        assert.equal(
          await rows
            .nth(index + 1)
            .getByRole('cell')
            .nth(0)
            .innerText(),
          value,
        );
      }
      assert.match(await rows.nth(2).getByRole('cell').nth(1).innerText(), /12.5/);
      assert.match(await rows.nth(2).getByRole('cell').nth(1).innerText(), /7.25/);
      await page.close();
      await app.stop();
      app = await startApplication(environment, directory);
      const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
      mobile.on('pageerror', (error) => errors.push(error.message));
      await openScenario(mobile, app.baseUrl, project, scenario);
      assert.deepEqual((await request(path)).body, saved);
      const reopened = await editDemands(mobile);
      assert.equal(
        await reopened.getByLabel('需求 1 日吨数', { exact: true }).inputValue(),
        '12.5',
      );
      assert.equal(
        await reopened.getByLabel('需求 2 日吨数', { exact: true }).inputValue(),
        '7.25',
      );
      assert.equal(
        await reopened.getByLabel('需求 2 卸货位置', { exact: true }).inputValue(),
        cycle.positions[3].id,
      );
      assert.equal(
        await mobile.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
        true,
      );
      await reopened.getByRole('button', { name: '取消', exact: true }).click();
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await app.stop();
      await app.cleanup();
    }
  },
);

test(
  'a hundred pasted demands survive cycle invalidation and stale edits remain reviewable',
  { timeout: 180000 },
  async () => {
    const app = await startApplication(environment);
    const browser = await chromium.launch({
      channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || 'chrome',
      headless: true,
    });
    try {
      const request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
      const { project, scenario, cycle, path } = await fixture(request, '百条需求验收');
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      await openScenario(page, app.baseUrl, project, scenario);
      let dialog = await editDemands(page);
      await dialog.getByLabel('需求所属循环', { exact: true }).selectOption(cycle.id);
      await dialog.getByText('批量粘贴需求', { exact: true }).click();
      await dialog
        .getByLabel('批量需求', { exact: true })
        .fill(Array.from({ length: 100 }, (_, index) => `2\t3\t${index + 0.25}`).join('\n'));
      await dialog.getByRole('button', { name: '校验粘贴内容', exact: true }).click();
      await dialog.getByRole('button', { name: '加入需求草稿', exact: true }).click();
      await dialog.getByLabel('需求 100 日吨数', { exact: true }).waitFor();
      await dialog.getByRole('button', { name: '保存全部需求', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      let saved = (await request(path)).body;
      assert.equal(saved.context.transportDemands.length, 100);
      const demands = saved.context.transportDemands;
      dialog = await editDemands(page);
      await dialog.getByLabel('需求 1 日吨数', { exact: true }).fill('88.75');
      const renamed = await request(path, 'PATCH', {
        expectedRevision: saved.revision,
        name: '另一窗口改名',
      });
      assert.equal(renamed.status, 200);
      const rejected = page.waitForResponse(
        (response) =>
          response.url().endsWith(`${path}/demands`) && response.request().method() === 'PUT',
      );
      await dialog.getByRole('button', { name: '保存全部需求', exact: true }).click();
      assert.equal((await rejected).status(), 409);
      assert.equal(await dialog.getByLabel('需求 1 日吨数', { exact: true }).inputValue(), '88.75');
      assert.deepEqual((await request(path)).body, renamed.body);
      assert.match(await dialog.getByRole('alert').innerText(), /刷新|重新读取|修订|变化/);
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
      await dialog.getByRole('button', { name: '放弃修改', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: '刷新规划方案', exact: true }).click();
      await page.getByRole('heading', { name: '另一窗口改名', exact: true }).waitFor();
      const cycleRegion = page.getByRole('region', { name: `运输循环 ${cycle.name}`, exact: true });
      await cycleRegion.getByRole('button', { name: '编辑循环', exact: true }).click();
      const cycleDialog = page.getByRole('dialog', { name: '编辑运输循环', exact: true });
      await cycleDialog.getByRole('button', { name: '上移点位 3', exact: true }).click();
      await cycleDialog.getByRole('button', { name: '保存循环', exact: true }).click();
      await cycleDialog.waitFor({ state: 'hidden' });
      saved = (await request(path)).body;
      assert.deepEqual(saved.context.transportDemands, demands);
      const demandRegion = page.getByRole('region', { name: '方案运输需求', exact: true });
      assert.match(await demandRegion.innerText(), /装卸倒序|装货位置须排在卸货位置之前/);
      const flow = demandRegion.getByRole('table', {
        name: `${cycle.name} 区间日货流`,
        exact: true,
      });
      const rows = flow.getByRole('row');
      for (let index = 1; index <= 3; index++) {
        assert.equal(await rows.nth(index).getByRole('cell').nth(0).innerText(), '0');
      }
      await cycleRegion.getByRole('button', { name: '删除循环', exact: true }).click();
      await page.getByRole('button', { name: '确认删除循环', exact: true }).click();
      await page.getByText('还没有运输循环。', { exact: false }).waitFor();
      assert.deepEqual((await request(path)).body.context.transportDemands, demands);
      assert.match(await demandRegion.innerText(), /循环.*已删除|循环.*不存在|找不到.*循环/);
    } finally {
      await browser.close();
      await app.stop();
      await app.cleanup();
    }
  },
);
