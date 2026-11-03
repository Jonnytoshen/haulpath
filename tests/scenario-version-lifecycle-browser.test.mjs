// Browser globals below are evaluated inside Playwright callbacks.
/* global document */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startApplication, jsonRequest } from './helpers/application.mjs';

const environment = { AMAP_JS_KEY: '', AMAP_JS_SECURITY_CODE: '', AMAP_WEB_SERVICE_KEY: '' };
const launch = () =>
  chromium.launch({ channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || 'chrome', headless: true });
const collectionPath = (project) => `/api/projects/${project.id}/scenarios`;

async function fixture(request, projectName = '版本生命周期验收') {
  const project = (await request('/api/projects', 'POST', { name: projectName })).body;
  const points = (
    await request('/api/coordinates', 'POST', {
      points: [
        { name: '港口', longitude: 121.47, latitude: 31.23, source: 'manual' },
        { name: '料场', longitude: 121.6, latitude: 31.3, source: 'manual' },
        { name: '港口', longitude: 121.47, latitude: 31.23, source: 'manual' },
      ],
    })
  ).body;
  const route = (
    await request(`/api/projects/${project.id}/routes`, 'POST', {
      name: '港口料场往返',
      points,
      strategy: 34,
    })
  ).body;
  let scenario = (await request(collectionPath(project), 'POST', { name: '首期决策依据' })).body;
  const path = `${collectionPath(project)}/${scenario.id}`;
  scenario = (
    await request(`${path}/cycles`, 'POST', {
      expectedRevision: scenario.revision,
      sourceRouteId: route.id,
    })
  ).body;
  const cycle = scenario.context.transportCycles[0];
  scenario = (
    await request(`${path}/cycles/${cycle.id}`, 'PATCH', {
      expectedRevision: scenario.revision,
      confirmed: true,
    })
  ).body;
  scenario = (
    await request(`${path}/demands`, 'PUT', {
      expectedRevision: scenario.revision,
      demands: [
        {
          cycleId: cycle.id,
          loadingPositionId: cycle.positions[0].id,
          unloadingPositionId: cycle.positions[1].id,
          dailyTonnes: 120,
        },
      ],
    })
  ).body;
  assert.equal(scenario.context.transportDemands[0].dailyTonnes, 120);
  scenario = (
    await request(`${path}/operations`, 'PUT', {
      expectedRevision: scenario.revision,
      operations: {
        battery: {
          capacityKwh: 400,
          chargePowerKw: 200,
          chargeEfficiency: 0.9,
          source: '版本验收电池资料',
        },
        vehicleGroups: [],
        measuredSegments: [],
      },
    })
  ).body;
  assert.equal(scenario.context.operations.battery.capacityKwh, 400);
  const powers = (
    await request(`/api/projects/${project.id}/power-connection-points`, 'PUT', {
      expectedRevision: 1,
      points: [
        {
          name: '港东共享电源',
          longitude: 121.5,
          latitude: 31.25,
          coordinateSystem: 'GCJ-02',
          availableCapacityKw: 1200,
          capacitySource: '版本验收供电答复',
          connectionNotes: '接电工程条件待另行确认',
        },
      ],
    })
  ).body;
  scenario = (
    await request(`${path}/station-network`, 'PUT', {
      expectedRevision: scenario.revision,
      network: {
        stationTypes: [
          {
            name: '双工位候选站型',
            bays: 2,
            swapMinutes: 6,
            batteryInventory: 8,
            chargingSlots: 4,
            chargePowerKw: 480,
            serviceWindows: [{ startMinute: 360, endMinute: 1320 }],
            chargeWindows: [{ startMinute: 1320, endMinute: 1800 }],
            investment: null,
            annualOperatingCost: null,
            source: '版本验收设备台账',
          },
        ],
        sites: [
          {
            name: '港东候选场地',
            longitude: 121.48,
            latitude: 31.24,
            coordinateSystem: 'GCJ-02',
            siteNotes: '场地道路条件待踏勘',
            siteConfirmed: false,
            connection: null,
          },
        ],
        powerSources: [{ sourcePointId: powers.points[0].id }],
        fixedLayout: [],
      },
    })
  ).body;
  assert.equal(scenario.context.stationNetwork.stationTypes[0].chargePowerKw, 480);
  return { project, route, scenario, cycle, path };
}

async function openScenario(page, baseUrl, project, scenario) {
  await page.goto(baseUrl);
  const expand = page.getByRole('button', { name: '展开项目与线路', exact: true });
  if (await expand.isVisible()) await expand.click();
  await page.getByRole('button', { name: project.name, exact: true }).click();
  if (await expand.isVisible()) await expand.click();
  await page.getByRole('button', { name: '规划方案', exact: true }).click();
  await page.getByRole('button', { name: `打开规划方案 ${scenario.name}`, exact: true }).click();
  await page
    .getByRole('region', { name: '当前规划方案', exact: true })
    .getByRole('heading', { name: scenario.name, exact: true })
    .waitFor();
}

async function freeze(page) {
  await page.getByRole('button', { name: '冻结规划方案', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '冻结规划方案', exact: true });
  await dialog.getByRole('button', { name: '冻结版本', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}

async function copyDraft(page, name) {
  await page.getByRole('button', { name: '复制为新草案', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '复制为新草案', exact: true });
  await dialog.getByLabel('草案名称', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: '复制草案', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page
    .getByRole('region', { name: '当前规划方案', exact: true })
    .getByRole('heading', { name, exact: true })
    .waitFor();
}

test(
  'frozen decision inputs stay readable while an independent copied draft survives a SQLite restart',
  { timeout: 180000 },
  async () => {
    let app = await startApplication(environment);
    const directory = app.directory;
    const browser = await launch();
    const errors = [];
    try {
      const request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
      const { project, scenario, path } = await fixture(request);
      let page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      page.on('pageerror', (failure) => errors.push(failure.message));
      await openScenario(page, app.baseUrl, project, scenario);
      await freeze(page);
      const frozen = (await request(path)).body;
      assert.equal(frozen.status, 'frozen');
      assert.deepEqual(frozen.context, scenario.context);
      assert.equal(frozen.inputVersion, scenario.inputVersion);
      const current = page.getByRole('region', { name: '当前规划方案', exact: true });
      assert.match(await current.innerText(), /已冻结/);
      for (const name of [
        '重命名规划方案',
        '删除规划方案',
        '从线路建立循环',
        '编辑循环',
        '维护运输需求',
        '维护车辆与运营模板',
        '维护人工固定站网',
      ]) {
        const control = current.getByRole('button', { name, exact: true });
        if (await control.count()) assert.equal(await control.isDisabled(), true, name);
      }
      assert.match(
        await page.getByRole('region', { name: '方案运输需求', exact: true }).innerText(),
        /120/,
      );
      assert.match(
        await page.getByRole('region', { name: '方案车辆与运营模板', exact: true }).innerText(),
        /400/,
      );
      assert.match(await current.innerText(), /港口.*料场/s);
      const frozenInputs = current.locator('details').filter({ hasText: '查看已冻结输入' });
      await frozenInputs.locator('summary').click();
      const preserved = await frozenInputs.innerText();
      for (const value of [
        '双工位候选站型',
        '港东候选场地',
        '港东共享电源',
        '场地道路条件待踏勘',
        '版本验收设备台账',
        '480',
        '400',
      ])
        assert.ok(preserved.includes(value), `frozen inputs include ${value}`);
      await frozenInputs.locator('summary').click();
      await copyDraft(page, '下一轮独立草案');
      let copied = (await request(collectionPath(project))).body.find(
        (item) => item.name === '下一轮独立草案',
      );
      assert.ok(copied);
      assert.notEqual(copied.id, frozen.id);
      assert.equal(copied.status, 'draft');
      assert.equal(copied.projectId, project.id);
      assert.deepEqual(copied.context, frozen.context);
      assert.match(await current.innerText(), /首期决策依据/);
      const demandEditor = current.getByRole('button', { name: '维护运输需求', exact: true });
      assert.equal(await demandEditor.isEnabled(), true);
      await demandEditor.click();
      const dialog = page.getByRole('dialog', { name: '维护运输需求', exact: true });
      await dialog.getByLabel('需求 1 日吨数', { exact: true }).fill('135');
      await dialog.getByRole('button', { name: '保存全部需求', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      copied = (await request(`${collectionPath(project)}/${copied.id}`)).body;
      assert.equal(copied.context.transportDemands[0].dailyTonnes, 135);
      assert.deepEqual((await request(path)).body, frozen);
      await page.close();
      await app.stop();
      app = await startApplication(environment, directory);
      page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      page.on('pageerror', (failure) => errors.push(failure.message));
      await openScenario(page, app.baseUrl, project, copied);
      assert.match(
        await page.getByRole('region', { name: '当前规划方案', exact: true }).innerText(),
        /草案/,
      );
      assert.match(
        await page.getByRole('region', { name: '方案运输需求', exact: true }).innerText(),
        /135/,
      );
      assert.deepEqual((await request(`${collectionPath(project)}/${copied.id}`)).body, copied);
      await page.getByRole('button', { name: '返回方案列表', exact: true }).click();
      await page.getByRole('button', { name: `打开规划方案 ${frozen.name}`, exact: true }).click();
      await page
        .getByRole('region', { name: '当前规划方案', exact: true })
        .getByText('已冻结', { exact: true })
        .waitFor();
      assert.deepEqual((await request(path)).body, frozen);
      assert.equal(
        await page.evaluate(
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
  'unsaved and pending edits lock version operations and late comparison responses cannot replace the new selection',
  { timeout: 180000 },
  async () => {
    const app = await startApplication(environment);
    const browser = await launch();
    let releaseSave = () => {};
    let releaseComparison = () => {};
    try {
      const request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
      const { project, scenario, path } = await fixture(request, '版本交互并发保护验收');
      const other = (await request(collectionPath(project), 'POST', { name: '另一份独立草案' }))
        .body;
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      const errors = [];
      page.on('pageerror', (failure) => errors.push(failure.message));
      await openScenario(page, app.baseUrl, project, scenario);
      await page.getByRole('button', { name: '维护运输需求', exact: true }).click();
      const editor = page.getByRole('dialog', { name: '维护运输需求', exact: true });
      await editor.getByLabel('需求 1 日吨数', { exact: true }).fill('145');
      const lockedNames = [
        '新建规划方案',
        '刷新规划方案',
        '冻结规划方案',
        '复制为新草案',
        '比较输入版本',
        '返回方案列表',
        `打开规划方案 ${other.name}`,
      ];
      async function assertVersionOperationsLocked() {
        for (const name of lockedNames) {
          assert.equal(
            await page.getByRole('button', { name, exact: true, includeHidden: true }).isDisabled(),
            true,
            name,
          );
        }
      }
      await assertVersionOperationsLocked();
      await page.keyboard.press('Escape');
      await editor.getByRole('button', { name: '继续编辑', exact: true }).click();
      assert.equal(await editor.getByLabel('需求 1 日吨数', { exact: true }).inputValue(), '145');
      assert.deepEqual((await request(path)).body, scenario);

      let saveEntered;
      const saving = new Promise((resolve) => {
        saveEntered = resolve;
      });
      const saveGate = new Promise((resolve) => {
        releaseSave = resolve;
      });
      await page.route(`**${path}/demands`, async (route) => {
        const response = await route.fetch();
        saveEntered();
        await saveGate;
        await route.fulfill({ response });
      });
      await editor.getByRole('button', { name: '保存全部需求', exact: true }).click();
      await saving;
      assert.equal((await request(path)).body.context.transportDemands[0].dailyTonnes, 145);
      await assertVersionOperationsLocked();
      await page.keyboard.press('Escape');
      await editor.getByRole('button', { name: '关闭对话框', exact: true }).click();
      assert.equal(await editor.isVisible(), true);
      assert.equal(
        await editor.getByRole('button', { name: '保存中…', exact: true }).isDisabled(),
        true,
      );
      releaseSave();
      await editor.waitFor({ state: 'hidden' });
      await page.unroute(`**${path}/demands`);
      assert.deepEqual((await request(`${collectionPath(project)}/${other.id}`)).body, other);

      const latest = (await request(path)).body;
      const same = (
        await request(`${path}/copy`, 'POST', {
          expectedRevision: latest.revision,
          name: '相同输入新草案',
        })
      ).body;
      await page.getByRole('button', { name: '刷新规划方案', exact: true }).click();
      await page.getByRole('button', { name: `打开规划方案 ${same.name}`, exact: true }).waitFor();
      await page.getByRole('button', { name: '比较输入版本', exact: true }).click();
      const comparison = page.getByRole('dialog', { name: '比较输入版本', exact: true });
      await comparison.getByLabel('左侧版本', { exact: true }).selectOption(scenario.id);
      await comparison.getByLabel('右侧版本', { exact: true }).selectOption(other.id);
      let compareEntered;
      let compareSettled;
      const entered = new Promise((resolve) => {
        compareEntered = resolve;
      });
      const settled = new Promise((resolve) => {
        compareSettled = resolve;
      });
      const comparisonGate = new Promise((resolve) => {
        releaseComparison = resolve;
      });
      await page.route(`**${collectionPath(project)}/compare?*`, async (route) => {
        if (new URL(route.request().url()).searchParams.get('right') !== other.id) {
          await route.continue();
          return;
        }
        const response = await route.fetch();
        compareEntered();
        await comparisonGate;
        // Changing a side aborts the old browser request. The real HTTP response
        // may already exist, but delivering it cannot overwrite the new selection.
        await route.fulfill({ response }).catch(() => {});
        compareSettled();
      });
      await comparison.getByRole('button', { name: '查看输入差异', exact: true }).click();
      await entered;
      await comparison.getByLabel('右侧版本', { exact: true }).selectOption(same.id);
      await comparison.getByRole('button', { name: '查看输入差异', exact: true }).click();
      const differences = comparison.locator('[aria-label="输入差异结果"]');
      await differences.getByText('两份版本的输入相同', { exact: true }).waitFor();
      releaseComparison();
      await settled;
      const text = await differences.innerText();
      assert.ok(text.includes(`右侧：${same.name}`));
      assert.equal(text.includes(other.name), false);
      assert.ok(text.includes('两份版本的输入相同'));
      assert.deepEqual(errors, []);
    } finally {
      releaseSave();
      releaseComparison();
      await browser.close();
      await app.stop();
      await app.cleanup();
    }
  },
);

test(
  'shared route changes enter only the chosen draft and appear as readable source, order and parameter differences',
  { timeout: 180000 },
  async () => {
    const app = await startApplication(environment);
    const browser = await launch();
    const errors = [];
    try {
      const request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
      const { project, route, scenario, cycle, path } = await fixture(request, '显式更新版本验收');
      const page = await browser.newPage({ viewport: { width: 768, height: 1024 } });
      page.on('pageerror', (failure) => errors.push(failure.message));
      await openScenario(page, app.baseUrl, project, scenario);
      await freeze(page);
      const frozen = (await request(path)).body;
      await copyDraft(page, '引入资料调整草案');
      const copied = (await request(collectionPath(project))).body.find(
        (item) => item.name === '引入资料调整草案',
      );
      const copyPath = `${collectionPath(project)}/${copied.id}`;
      const [weighbridge] = (
        await request('/api/coordinates', 'POST', {
          points: [{ name: '新增称重场', longitude: 121.53, latitude: 31.27, source: 'manual' }],
        })
      ).body;
      const updatedRoute = (
        await request(`/api/routes/${route.id}?projectId=${project.id}`, 'PATCH', {
          name: '经称重场的新业务顺序',
          strategy: 35,
          points: [route.points[0], weighbridge, route.points[1], route.points[2]],
        })
      ).body;
      assert.equal(updatedRoute.inputVersion, route.inputVersion + 1);
      assert.deepEqual((await request(path)).body, frozen);
      assert.deepEqual((await request(copyPath)).body, copied);
      await page.getByRole('button', { name: '刷新规划方案', exact: true }).click();
      const current = page.getByRole('region', { name: '当前规划方案', exact: true });
      await current.getByRole('heading', { name: copied.name, exact: true }).waitFor();
      const cycles = page.getByRole('region', { name: '方案运输循环', exact: true });
      assert.match(await cycles.innerText(), /港口料场往返/);
      assert.equal(await cycles.getByText('新增称重场', { exact: true }).count(), 0);
      await cycles.getByRole('button', { name: '引入来源线路更新', exact: true }).click();
      const importDialog = page.getByRole('dialog', { name: '引入来源线路更新', exact: true });
      assert.match(await importDialog.innerText(), /移除方案内手工补点并取消循环确认/);
      await importDialog.getByRole('button', { name: '确认引入更新', exact: true }).click();
      await importDialog.waitFor({ state: 'hidden' });
      await cycles.getByRole('heading', { name: updatedRoute.name, exact: true }).waitFor();
      const adopted = (await request(copyPath)).body;
      const adoptedCycle = adopted.context.transportCycles[0];
      assert.equal(adopted.inputVersion, copied.inputVersion + 1);
      assert.equal(adoptedCycle.id, cycle.id);
      assert.equal(adoptedCycle.confirmed, false);
      assert.equal(adoptedCycle.strategy, 35);
      assert.deepEqual(
        adoptedCycle.positions.map((position) => position.point.name),
        ['港口', '新增称重场', '料场', '港口'],
      );
      assert.deepEqual(adopted.context.transportDemands, copied.context.transportDemands);
      assert.deepEqual(adopted.context.operations, copied.context.operations);
      assert.deepEqual((await request(path)).body, frozen);
      assert.deepEqual(
        (await request(`/api/routes/${route.id}?projectId=${project.id}`)).body,
        updatedRoute,
      );
      assert.match(await cycles.innerText(), /待确认/);
      await page.getByRole('button', { name: '比较输入版本', exact: true }).click();
      const comparison = page.getByRole('dialog', { name: '比较输入版本', exact: true });
      await comparison.getByLabel('左侧版本', { exact: true }).selectOption(frozen.id);
      await comparison.getByLabel('右侧版本', { exact: true }).selectOption(copied.id);
      await comparison.getByRole('button', { name: '查看输入差异', exact: true }).click();
      const differences = comparison.locator('[aria-label="输入差异结果"]');
      await differences.waitFor();
      const text = await differences.innerText();
      for (const value of [
        '首期决策依据',
        '引入资料调整草案',
        '新增称重场',
        '业务顺序',
        '来源',
        '高速优先',
        '不走高速',
      ]) {
        assert.ok(text.includes(value), `comparison includes ${value}`);
      }
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
        true,
      );
      await comparison.getByRole('button', { name: '关闭比较', exact: true }).click();
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await app.stop();
      await app.cleanup();
    }
  },
);
