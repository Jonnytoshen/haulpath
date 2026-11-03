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
        { name: '同名作业点', longitude: 121.47, latitude: 31.23, source: 'manual' },
        { name: '同名作业点', longitude: 121.6, latitude: 31.3, source: 'manual' },
        { name: '同名作业点', longitude: 121.47, latitude: 31.23, source: 'manual' },
      ],
    })
  ).body;
  const route = (
    await request(`/api/projects/${project.id}/routes`, 'POST', { name: '港区往返', points })
  ).body;
  let scenario = (
    await request(`/api/projects/${project.id}/scenarios`, 'POST', { name: '车队与运营草案' })
  ).body;
  const path = `/api/projects/${project.id}/scenarios/${scenario.id}`;
  scenario = (
    await request(`${path}/cycles`, 'POST', {
      sourceRouteId: route.id,
      expectedRevision: scenario.revision,
    })
  ).body;
  const cycle = scenario.context.transportCycles[0];
  scenario = (
    await request(`${path}/cycles/${cycle.id}`, 'PATCH', {
      expectedRevision: scenario.revision,
      confirmed: true,
    })
  ).body;
  return { project, scenario, path, cycle };
}

async function openScenario(page, baseUrl, project, scenario) {
  await page.goto(baseUrl);
  const expand = page.getByRole('button', { name: '展开项目与线路', exact: true });
  if (await expand.isVisible()) await expand.click();
  await page.getByRole('button', { name: project.name, exact: true }).click();
  if (await expand.isVisible()) await expand.click();
  await page.getByRole('button', { name: '规划方案', exact: true }).click();
  await page.getByRole('button', { name: `打开规划方案 ${scenario.name}`, exact: true }).click();
  await page.getByRole('region', { name: '方案车辆与运营模板', exact: true }).waitFor();
}
async function edit(page) {
  await page.getByRole('button', { name: '维护车辆与运营模板', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '维护车辆与运营模板', exact: true });
  await dialog.waitFor();
  return dialog;
}
async function save(dialog) {
  await dialog.getByRole('button', { name: '保存全部运营资料', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}
async function fillGroup(dialog, cycle) {
  await dialog.getByRole('button', { name: '新增车辆组', exact: true }).click();
  await dialog.getByLabel('车辆组 1 车型名称', { exact: true }).fill('港区牵引车');
  await dialog.getByLabel('车辆组 1 当日数量上限', { exact: true }).fill('2');
  await dialog.getByLabel('车辆组 1 基准循环', { exact: true }).selectOption(cycle.id);
  for (const [field, value] of Object.entries({
    载重: '40',
    业务速度: '30',
    空载能耗: '1',
    满载能耗: '2',
    安全电量: '20',
    班次: '22:00-次日02:00',
    装货耗时: '10',
    卸货耗时: '15',
    参数来源: '验收参数，用户确认',
  }))
    await dialog.getByLabel(`车辆组 1 ${field}`, { exact: true }).fill(value);
}

test(
  'fleet forms and measured overrides survive SQLite restart with stable planned vehicles',
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
      const { project, scenario, cycle, path } = await fixture(request, '车辆表单验收');
      let page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      page.on('pageerror', (error) => errors.push(error.message));
      await openScenario(page, app.baseUrl, project, scenario);
      const region = page.getByRole('region', { name: '方案车辆与运营模板', exact: true });
      assert.match(await region.innerText(), /待配置|未配置/);
      let dialog = await edit(page);
      await dialog.getByLabel('电池容量（kWh）', { exact: true }).fill('400');
      await dialog.getByLabel('等效充电功率（kW）', { exact: true }).fill('200');
      await dialog.getByLabel('充电效率（0–1）', { exact: true }).fill('0.9');
      await dialog.getByLabel('电池参数来源', { exact: true }).fill('验收电池资料');
      await fillGroup(dialog, cycle);
      await save(dialog);
      let saved = (await request(path)).body;
      const group = saved.context.operations.vehicleGroups[0];
      assert.equal(group.count, 2);
      assert.deepEqual(group.shifts, [{ startMinute: 1320, endMinute: 1560 }]);
      assert.equal(group.vehicleIds.length, 2);
      assert.equal(saved.context.operations.battery.capacityKwh, 400);
      dialog = await edit(page);
      await dialog.getByRole('button', { name: '新增区间实测', exact: true }).click();
      await dialog.getByLabel('实测 1 车辆组', { exact: true }).selectOption(group.id);
      await dialog.getByLabel('实测 1 所属循环', { exact: true }).selectOption(cycle.id);
      await dialog.getByLabel('实测 1 有向区间', { exact: true }).selectOption('0');
      await dialog.getByLabel('实测 1 行驶时间', { exact: true }).fill('25');
      await dialog.getByLabel('实测 1 空载耗电', { exact: true }).fill('8');
      await dialog.getByLabel('实测 1 满载耗电', { exact: true }).fill('14');
      await dialog.getByLabel('实测 1 来源说明', { exact: true }).fill('往返首区间实测记录');
      await save(dialog);
      saved = (await request(path)).body;
      assert.deepEqual(saved.context.operations.vehicleGroups[0].vehicleIds, group.vehicleIds);
      assert.equal(saved.context.operations.measuredSegments[0].durationMinutes, 25);
      assert.equal(
        saved.context.operations.measuredSegments[0].fromPositionId,
        cycle.positions[0].id,
      );
      assert.equal(
        saved.context.operations.measuredSegments[0].toPositionId,
        cycle.positions[1].id,
      );
      assert.match(await region.innerText(), /实测/);
      assert.match(await region.innerText(), /模板/);
      await page.close();
      await app.stop();
      app = await startApplication(environment, directory);
      page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      page.on('pageerror', (error) => errors.push(error.message));
      await openScenario(page, app.baseUrl, project, saved);
      assert.deepEqual((await request(path)).body, saved);
      dialog = await edit(page);
      assert.equal(await dialog.getByLabel('电池容量（kWh）', { exact: true }).inputValue(), '400');
      assert.equal(await dialog.getByLabel('实测 1 行驶时间', { exact: true }).inputValue(), '25');
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
        true,
      );
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await app.stop();
      await app.cleanup();
    }
  },
);

test(
  'atomic paste maintains fifty vehicles and stale edits remain recoverable after cycle invalidation',
  { timeout: 180000 },
  async () => {
    const app = await startApplication(environment);
    const browser = await chromium.launch({
      channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || 'chrome',
      headless: true,
    });
    try {
      const request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
      const { project, scenario, cycle, path } = await fixture(request, '批量车队验收');
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      await openScenario(page, app.baseUrl, project, scenario);
      let dialog = await edit(page);
      await dialog.getByText('批量粘贴车辆组', { exact: true }).click();
      const row = (name, count) =>
        [name, count, 1, 40, 30, 1, 2, 20, '06:00-18:00', 10, 15, '批量验收资料'].join('\t');
      const paste = dialog.getByLabel('批量车辆组', { exact: true });
      await paste.fill(`${row('甲型车', 30)}\n${row('乙型车', -1)}`);
      await dialog.getByRole('button', { name: '校验车辆组粘贴', exact: true }).click();
      assert.match(await dialog.innerText(), /第 2 行|第2行|第 2|2.*数量/);
      assert.equal(
        await dialog.getByRole('button', { name: '加入车辆组草稿', exact: true }).count(),
        0,
      );
      assert.equal((await request(path)).body.context.operations, undefined);
      await paste.fill(`${row('甲型车', 30)}\n${row('乙型车', 20)}`);
      await dialog.getByRole('button', { name: '校验车辆组粘贴', exact: true }).click();
      await dialog.getByRole('button', { name: '加入车辆组草稿', exact: true }).click();
      await save(dialog);
      let saved = (await request(path)).body;
      const operations = saved.context.operations;
      assert.equal(
        operations.vehicleGroups.reduce((sum, group) => sum + group.count, 0),
        50,
      );
      assert.equal(new Set(operations.vehicleGroups.flatMap((group) => group.vehicleIds)).size, 50);
      const region = page.getByRole('region', { name: '方案车辆与运营模板', exact: true });
      assert.match(await region.innerText(), /50/);
      await region.getByText('待补或待修复资料（4 项）', { exact: true }).click();
      assert.match(await region.innerText(), /电池.*待配置|电池.*缺失/);
      dialog = await edit(page);
      await dialog.getByText('批量粘贴区间实测', { exact: true }).click();
      const measuredPaste = dialog.getByLabel('批量区间实测', { exact: true });
      await measuredPaste.fill(
        '1\t1\t1\t2\t25\t8\t14\t首区间现场实测\n1\t1\t2\t1\t25\t8\t14\t方向错误',
      );
      await dialog.getByRole('button', { name: '校验实测粘贴', exact: true }).click();
      assert.match(await dialog.innerText(), /有向相邻|第 2 行/);
      assert.equal((await request(path)).body.context.operations.measuredSegments.length, 0);
      await measuredPaste.fill('1\t1\t1\t2\t25\t8\t14\t首区间现场实测');
      await dialog.getByRole('button', { name: '校验实测粘贴', exact: true }).click();
      await dialog.getByRole('button', { name: '加入实测草稿', exact: true }).click();
      await save(dialog);
      saved = (await request(path)).body;
      assert.equal(saved.context.operations.measuredSegments[0].source, '首区间现场实测');
      const originalIds = saved.context.operations.vehicleGroups.flatMap(
        (group) => group.vehicleIds,
      );
      dialog = await edit(page);
      await dialog.getByLabel('车辆组 1 业务速度', { exact: true }).fill('45');
      const renamed = await request(path, 'PATCH', {
        expectedRevision: saved.revision,
        name: '另一窗口已保存',
      });
      assert.equal(renamed.status, 200);
      const response = page.waitForResponse(
        (r) => r.url().endsWith(`${path}/operations`) && r.request().method() === 'PUT',
      );
      await dialog.getByRole('button', { name: '保存全部运营资料', exact: true }).click();
      assert.equal((await response).status(), 409);
      assert.equal(
        await dialog.getByLabel('车辆组 1 业务速度', { exact: true }).inputValue(),
        '45',
      );
      assert.match(await dialog.getByRole('alert').innerText(), /本次填写已保留/);
      assert.deepEqual((await request(path)).body, renamed.body);
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
      await dialog.getByRole('button', { name: '放弃修改', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      const changed = await request(`${path}/cycles/${cycle.id}`, 'PATCH', {
        expectedRevision: renamed.body.revision,
        strategy: 33,
      });
      assert.equal(changed.status, 200);
      await page.getByRole('button', { name: '刷新规划方案', exact: true }).click();
      await page.getByRole('heading', { name: '另一窗口已保存', exact: true }).waitFor();
      assert.match(await region.innerText(), /实测.*偏好已改变|实测.*重新确认/);
      assert.deepEqual(
        (await request(path)).body.context.operations.vehicleGroups.flatMap(
          (group) => group.vehicleIds,
        ),
        originalIds,
      );
      dialog = await edit(page);
      await dialog.getByLabel('实测 1 重新确认实测依据', { exact: true }).check();
      await save(dialog);
      saved = (await request(path)).body;
      assert.equal(saved.context.operations.measuredSegments[0].basis.strategy, 33);
      const deleted = await request(
        `${path}/cycles/${cycle.id}?expectedRevision=${saved.revision}`,
        'DELETE',
      );
      assert.equal(deleted.status, 200);
      await page.getByRole('button', { name: '刷新规划方案', exact: true }).click();
      await page.getByText('还没有运输循环。', { exact: false }).waitFor();
      assert.match(await region.innerText(), /循环已删除|循环.*不存在/);
      assert.deepEqual((await request(path)).body.context.operations, saved.context.operations);
    } finally {
      await browser.close();
      await app.stop();
      await app.cleanup();
    }
  },
);
