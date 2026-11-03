// Browser globals below are evaluated inside Playwright callbacks.
/* global document */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startApplication, jsonRequest } from './helpers/application.mjs';
import { replaceAmapSDK } from './helpers/amap-browser.mjs';

const noMap = { AMAP_JS_KEY: '', AMAP_JS_SECURITY_CODE: '', AMAP_WEB_SERVICE_KEY: '' };
const launch = () =>
  chromium.launch({ channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || 'chrome', headless: true });
export async function openStationScenario(page, baseUrl, project, scenario) {
  await page.goto(baseUrl);
  const expand = page.getByRole('button', { name: '展开项目与线路', exact: true });
  if (await expand.isVisible()) await expand.click();
  await page.getByRole('button', { name: project.name, exact: true }).click();
  if (await expand.isVisible()) await expand.click();
  await page.getByRole('button', { name: '规划方案', exact: true }).click();
  await page.getByRole('button', { name: `打开规划方案 ${scenario.name}`, exact: true }).click();
}
async function edit(page) {
  await page.getByRole('button', { name: '维护人工固定站网', exact: true }).click();
  return page.getByRole('dialog', { name: '维护人工固定站网', exact: true });
}
async function save(dialog) {
  await dialog.getByRole('button', { name: '保存全部站网资料', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}

test(
  'without map configuration, candidate form saves a draft and reopens its original coordinates after SQLite restart',
  { timeout: 150000 },
  async () => {
    let app = await startApplication(noMap);
    const directory = app.directory;
    const browser = await launch();
    try {
      const request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
      const project = (await request('/api/projects', 'POST', { name: '人工站网验收' })).body;
      const scenario = (
        await request(`/api/projects/${project.id}/scenarios`, 'POST', { name: '场地草案' })
      ).body;
      let page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      await openStationScenario(page, app.baseUrl, project, scenario);
      let dialog = await edit(page);
      await dialog.getByRole('button', { name: '新增候选站址', exact: true }).click();
      await dialog.getByLabel('站址 1 名称', { exact: true }).fill('港区候选场地');
      await dialog.getByLabel('站址 1 原始经度', { exact: true }).fill('121.47');
      await dialog.getByLabel('站址 1 原始纬度', { exact: true }).fill('31.23');
      await dialog.getByLabel('站址 1 场地条件说明', { exact: true }).fill('现场待确认');
      await save(dialog);
      const path = `/api/projects/${project.id}/scenarios/${scenario.id}`;
      const saved = (await request(path)).body.context.stationNetwork;
      assert.equal(saved.sites.length, 1);
      assert.equal(saved.sites[0].siteConfirmed, false);
      assert.equal(saved.sites[0].connection, null);
      await page.close();
      await app.stop();
      app = await startApplication(noMap, directory);
      page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await openStationScenario(page, app.baseUrl, project, scenario);
      dialog = await edit(page);
      assert.equal(
        await dialog.getByLabel('站址 1 名称', { exact: true }).inputValue(),
        '港区候选场地',
      );
      assert.equal(
        await dialog.getByLabel('站址 1 原始经度', { exact: true }).inputValue(),
        '121.47',
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
        true,
      );
    } finally {
      await browser.close();
      await app.stop();
      await app.cleanup();
    }
  },
);

async function baseFixture(request, name) {
  const project = (await request('/api/projects', 'POST', { name })).body;
  const power = (
    await request(`/api/projects/${project.id}/power-connection-points`, 'PUT', {
      expectedRevision: 1,
      points: [
        {
          name: '港区共享电源',
          longitude: 121.5,
          latitude: 31.3,
          coordinateSystem: 'GCJ-02',
          availableCapacityKw: 600,
          capacitySource: '供电方书面资料',
          connectionNotes: '异地接电须核实',
        },
      ],
    })
  ).body;
  let scenario = (
    await request(`/api/projects/${project.id}/scenarios`, 'POST', { name: '人工固定布局' })
  ).body;
  const path = `/api/projects/${project.id}/scenarios/${scenario.id}`;
  scenario = (
    await request(`${path}/operations`, 'PUT', {
      expectedRevision: scenario.revision,
      operations: {
        battery: {
          capacityKwh: 400,
          chargePowerKw: 200,
          chargeEfficiency: 0.9,
          source: '统一电池资料',
        },
        vehicleGroups: [],
        measuredSegments: [],
      },
    })
  ).body;
  return { project, scenario, path, power };
}
async function tab(dialog, name) {
  await dialog
    .getByRole('navigation', { name: '站网资料分区' })
    .getByRole('button', { name, exact: true })
    .click();
}
async function fillSite(dialog, name = '港区候选场地') {
  await dialog.getByRole('button', { name: '新增候选站址', exact: true }).click();
  for (const [label, value] of [
    ['名称', name],
    ['原始经度', '121.47'],
    ['原始纬度', '31.23'],
    ['场地条件说明', '现场已核实通行与建设条件'],
  ])
    await dialog.getByLabel(`站址 1 ${label}`, { exact: true }).fill(value);
}
async function fillType(dialog) {
  await tab(dialog, '站型');
  await dialog.getByRole('button', { name: '新增站型', exact: true }).click();
  for (const [label, value] of [
    ['名称', '双工位换电站'],
    ['换电工位（个）', '2'],
    ['换电时间（分钟）', '6'],
    ['电池库存（块）', '8'],
    ['充电位（个）', '4'],
    ['站内总充电功率上限（kW）', '400'],
    ['服务窗口', '00:00-次日00:00'],
    ['充电窗口', '22:00-次日06:00'],
    ['参数来源', '设备参数书面资料'],
  ])
    await dialog.getByLabel(`站型 1 ${label}`, { exact: true }).fill(value);
}

test(
  'forms confirm a fixed layout with missing prices and preserve independent supply snapshots until explicit refresh',
  { timeout: 180000 },
  async () => {
    const app = await startApplication(noMap);
    const browser = await launch();
    try {
      const request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
      const { project, scenario, path, power } = await baseFixture(request, '固定布局确认验收');
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      const errors = [];
      page.on('pageerror', (failure) => errors.push(failure.message));
      await openStationScenario(page, app.baseUrl, project, scenario);
      let dialog = await edit(page);
      await fillSite(dialog);
      await fillType(dialog);
      await save(dialog);
      dialog = await edit(page);
      await tab(dialog, '电源快照');
      await dialog.getByLabel('选择项目电源', { exact: true }).selectOption(power.points[0].id);
      await dialog.getByRole('button', { name: '引入电源快照', exact: true }).click();
      await save(dialog);
      let saved = (await request(path)).body;
      const powerId = saved.context.stationNetwork.powerSources[0].id;
      dialog = await edit(page);
      await dialog.getByLabel('站址 1 确认场地', { exact: true }).check();
      await dialog.getByLabel('站址 1 接电电源', { exact: true }).selectOption(powerId);
      await dialog.getByLabel('站址 1 可用功率（kW）', { exact: true }).fill('400');
      await dialog
        .getByLabel('站址 1 接电确认依据', { exact: true })
        .fill('供电方确认可接此场地，接电投资待补');
      await save(dialog);
      dialog = await edit(page);
      await dialog.getByLabel('站址 1 确认接电关系', { exact: true }).check();
      await save(dialog);
      saved = (await request(path)).body;
      assert.equal(saved.context.stationNetwork.sites[0].siteConfirmed, true);
      assert.equal(saved.context.stationNetwork.sites[0].connection.confirmed, true);
      dialog = await edit(page);
      await tab(dialog, '固定布局');
      await dialog
        .getByLabel('固定布局 港区候选场地 站型', { exact: true })
        .selectOption(saved.context.stationNetwork.stationTypes[0].id);
      await save(dialog);
      const selected = (await request(path)).body;
      assert.equal(selected.context.stationNetwork.fixedLayout.length, 1);
      assert.equal(selected.context.stationNetwork.stationTypes[0].investment, null);
      assert.equal(selected.context.stationNetwork.sites[0].connection.connectionInvestment, null);
      const region = page.getByRole('region', { name: '方案人工固定站网', exact: true });
      assert.match(await region.innerText(), /财务价格待补/);
      const source = power.points[0];
      await request(`/api/projects/${project.id}/power-connection-points`, 'PUT', {
        expectedRevision: power.revision,
        points: [
          {
            id: source.id,
            name: source.name,
            longitude: source.originalLongitude,
            latitude: source.originalLatitude,
            coordinateSystem: source.coordinateSystem,
            availableCapacityKw: 900,
            capacitySource: source.capacitySource,
            connectionNotes: source.connectionNotes,
          },
        ],
      });
      assert.deepEqual(
        (await request(path)).body,
        selected,
        'project source edits cannot silently change a saved scenario',
      );
      await page.reload();
      await page.getByRole('button', { name: '规划方案', exact: true }).click();
      await page
        .getByRole('button', { name: `打开规划方案 ${scenario.name}`, exact: true })
        .click();
      dialog = await edit(page);
      await tab(dialog, '电源快照');
      assert.equal(
        await dialog.getByLabel('电源 1 可用容量（kW）', { exact: true }).inputValue(),
        '600',
      );
      await dialog.getByLabel('电源 1 显式引入更新', { exact: true }).check();
      await save(dialog);
      saved = (await request(path)).body;
      assert.equal(saved.context.stationNetwork.powerSources[0].point.availableCapacityKw, 900);
      assert.equal(saved.context.stationNetwork.sites[0].connection.confirmed, false);
      assert.equal(
        saved.context.stationNetwork.fixedLayout.length,
        1,
        'invalidated fixed layout remains visible for repair',
      );
      assert.match(await region.innerText(), /站网资料待完善/);
      dialog = await edit(page);
      await dialog.getByLabel('站址 1 确认接电关系', { exact: true }).check();
      await save(dialog);
      dialog = await edit(page);
      await tab(dialog, '电源快照');
      await dialog.getByLabel('电源 1 可用容量（kW）', { exact: true }).fill('750');
      await save(dialog);
      saved = (await request(path)).body;
      assert.equal(saved.context.stationNetwork.sites[0].connection.confirmed, false);
      assert.equal(
        (await request(`/api/projects/${project.id}/power-connection-points`)).body.points[0]
          .availableCapacityKw,
        900,
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
  'checked batch paste reports row errors and unsaved station edits require an explicit discard',
  { timeout: 120000 },
  async () => {
    const app = await startApplication(noMap);
    const browser = await launch();
    try {
      const request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
      const { project, scenario, path } = await baseFixture(request, '批量站网验收');
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await openStationScenario(page, app.baseUrl, project, scenario);
      let dialog = await edit(page);
      await dialog.getByText('批量粘贴候选站址', { exact: true }).click();
      const paste = dialog.getByLabel('粘贴站网表格', { exact: true });
      await paste.fill(
        '场地甲\t121.47\t31.23\tGCJ-02\t现场资料\n场地乙\t999\t31.2\tGCJ-02\t现场资料',
      );
      await dialog.getByRole('button', { name: '校验粘贴内容', exact: true }).click();
      assert.match(await dialog.innerText(), /第 2 行.*原始经度/);
      assert.equal(
        await dialog.getByRole('button', { name: '加入站网草稿', exact: true }).isEnabled(),
        false,
      );
      await paste.fill(
        '场地甲\t121.47\t31.23\tGCJ-02\t现场资料\n场地乙\t121.6\t31.2\tGCJ-02\t现场资料',
      );
      await dialog.getByRole('button', { name: '校验粘贴内容', exact: true }).click();
      await dialog.getByRole('button', { name: '加入站网草稿', exact: true }).click();
      await save(dialog);
      assert.equal((await request(path)).body.context.stationNetwork.sites.length, 2);
      dialog = await edit(page);
      await tab(dialog, '站型');
      await dialog.getByText('批量粘贴站型', { exact: true }).click();
      await dialog
        .getByLabel('粘贴站网表格', { exact: true })
        .fill(
          [
            '错误站型',
            '0',
            '6',
            '8',
            '4',
            '400',
            '00:00-次日00:00',
            '22:00-次日02:00;01:00-03:00',
            '',
            '',
            '资料',
          ].join('\t'),
        );
      await dialog.getByRole('button', { name: '校验粘贴内容', exact: true }).click();
      assert.match(await dialog.innerText(), /第 1 行.*换电工位/);
      await dialog.getByRole('button', { name: '关闭', exact: true }).click();
      await dialog.getByRole('button', { name: '继续编辑', exact: true }).click();
      assert.equal(await dialog.isVisible(), true);
      await dialog.getByRole('button', { name: '关闭', exact: true }).click();
      await dialog.getByRole('button', { name: '放弃站网草稿', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      assert.equal((await request(path)).body.context.stationNetwork.stationTypes.length, 0);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
        true,
      );
    } finally {
      await browser.close();
      await app.stop();
      await app.cleanup();
    }
  },
);

test(
  'map search and explicit candidate movement keep edits local and clear site confirmation without submitting the station editor',
  { timeout: 150000 },
  async () => {
    const app = await startApplication({
      ...noMap,
      AMAP_JS_KEY: 'station-map-key',
      AMAP_JS_SECURITY_CODE: 'station-map-code',
    });
    const browser = await launch();
    try {
      const request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
      const { project, scenario, path } = await baseFixture(request, '地图候选验收');
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      await replaceAmapSDK(page);
      const errors = [],
        writes = [];
      page.on('pageerror', (failure) => errors.push(failure.message));
      page.on('console', (entry) => {
        if (
          entry.type() === 'error' &&
          /hydration|nested|descendant.*form|<form>/i.test(entry.text())
        )
          errors.push(entry.text());
      });
      page.on('request', (entry) => {
        if (entry.method() === 'PUT' && entry.url().endsWith('/station-network'))
          writes.push(entry.url());
      });
      await openStationScenario(page, app.baseUrl, project, scenario);
      let dialog = await edit(page);
      await dialog.locator('[data-sdk-map="ready"]').waitFor();
      await dialog.getByLabel('搜索地点', { exact: true }).fill('上海港区');
      await dialog
        .locator('.search-results')
        .getByRole('button')
        .filter({ hasText: '上海搜索仓' })
        .click();
      assert.equal(await dialog.isVisible(), true);
      assert.equal(
        await dialog.getByLabel('站址 1 名称', { exact: true }).inputValue(),
        '上海搜索仓',
      );
      assert.equal(writes.length, 0, 'map search choice must not submit the station editor');
      assert.equal((await request(path)).body.context.stationNetwork, undefined);
      await dialog.getByLabel('站址 1 场地条件说明', { exact: true }).fill('现场建设条件确认');
      await save(dialog);
      dialog = await edit(page);
      await dialog.getByLabel('站址 1 确认场地', { exact: true }).check();
      await save(dialog);
      assert.equal((await request(path)).body.context.stationNetwork.sites[0].siteConfirmed, true);
      dialog = await edit(page);
      await dialog.locator('[data-sdk-map="ready"]').waitFor();
      await dialog.getByRole('button', { name: '地图点位 上海搜索仓', exact: true }).click();
      await dialog.locator('[data-sdk-map="ready"]').click({ position: { x: 160, y: 180 } });
      assert.equal(
        await dialog.getByLabel('站址 1 原始经度', { exact: true }).inputValue(),
        '119.2',
      );
      assert.equal(
        await dialog.getByLabel('站址 1 坐标系', { exact: true }).inputValue(),
        'GCJ-02',
      );
      assert.equal(await dialog.getByLabel('站址 1 确认场地', { exact: true }).isChecked(), false);
      assert.equal(writes.length, 2, 'map movement remains a draft until explicit save');
      await save(dialog);
      const site = (await request(path)).body.context.stationNetwork.sites[0];
      assert.equal(site.originalLongitude, 119.2);
      assert.equal(site.longitude, 119.2);
      assert.equal(site.siteConfirmed, false);
      assert.equal(site.source, 'map');
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await app.stop();
      await app.cleanup();
    }
  },
);

test(
  'pending saves cannot close or navigate away, and revision conflicts keep local station drafts available for repair',
  { timeout: 150000 },
  async () => {
    const app = await startApplication(noMap);
    const browser = await launch();
    let releasePut = () => {};
    try {
      const request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
      const { project, scenario, path } = await baseFixture(request, '站网保存保护验收');
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      await openStationScenario(page, app.baseUrl, project, scenario);
      let dialog = await edit(page);
      await fillSite(dialog, '等待保存的站址');
      await page.keyboard.press('Escape');
      await dialog.getByRole('button', { name: '继续编辑', exact: true }).click();
      assert.equal(
        await dialog.getByLabel('站址 1 名称', { exact: true }).inputValue(),
        '等待保存的站址',
      );
      let entered;
      const held = new Promise((resolve) => {
        releasePut = resolve;
      });
      const started = new Promise((resolve) => {
        entered = resolve;
      });
      await page.route(`**${path}/station-network`, async (route) => {
        entered();
        await held;
        await route.continue();
      });
      const response = page.waitForResponse(
        (entry) =>
          entry.url().endsWith(`${path}/station-network`) && entry.request().method() === 'PUT',
      );
      await dialog.getByRole('button', { name: '保存全部站网资料', exact: true }).click();
      await started;
      await page.keyboard.press('Escape');
      await dialog.getByRole('button', { name: '关闭对话框', exact: true }).click();
      await page.mouse.click(4, 4);
      assert.equal(await dialog.isVisible(), true);
      assert.equal(
        await dialog.getByRole('button', { name: '正在保存…', exact: true }).isEnabled(),
        false,
      );
      assert.equal(
        await dialog.getByLabel('站址 1 名称', { exact: true }).inputValue(),
        '等待保存的站址',
      );
      releasePut();
      assert.equal((await response).status(), 200);
      await dialog.waitFor({ state: 'hidden' });
      await page.unroute(`**${path}/station-network`);
      await page.getByRole('button', { name: '电源接入点', exact: true }).click();
      await page.getByRole('region', { name: '项目电源接入点', exact: true }).waitFor();
      await page.getByRole('button', { name: '规划方案', exact: true }).click();
      await page
        .getByRole('button', { name: `打开规划方案 ${scenario.name}`, exact: true })
        .click();
      dialog = await edit(page);
      await dialog.getByLabel('站址 1 名称', { exact: true }).fill('冲突时保留的本地草稿');
      const latest = (await request(path)).body;
      assert.equal(
        (await request(path, 'PATCH', { name: '服务端已更新', expectedRevision: latest.revision }))
          .status,
        200,
      );
      const rejected = page.waitForResponse(
        (entry) =>
          entry.url().endsWith(`${path}/station-network`) && entry.request().method() === 'PUT',
      );
      await dialog.getByRole('button', { name: '保存全部站网资料', exact: true }).click();
      assert.equal((await rejected).status(), 409);
      await dialog.getByRole('alert').waitFor();
      assert.equal(
        await dialog.getByLabel('站址 1 名称', { exact: true }).inputValue(),
        '冲突时保留的本地草稿',
      );
      assert.equal(
        (await request(path)).body.context.stationNetwork.sites[0].name,
        '等待保存的站址',
      );
      await dialog.getByRole('button', { name: '关闭', exact: true }).click();
      await dialog.getByRole('button', { name: '放弃站网草稿', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: '刷新规划方案', exact: true }).click();
      await page
        .getByRole('button', { name: '维护人工固定站网', exact: true })
        .waitFor({ state: 'visible' });
    } finally {
      releasePut();
      await browser.close();
      await app.stop();
      await app.cleanup();
    }
  },
);
