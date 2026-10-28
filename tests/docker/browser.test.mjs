import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import ExcelJS from 'exceljs';
import { createDockerApplication, docker } from './helpers/application.mjs';
import { jsonRequest } from '../helpers/application.mjs';
import { assertOverview, openRouteFromSidebar, goTask } from '../helpers/browser-navigation.mjs';
import { replaceAmapSDK } from '../helpers/amap-browser.mjs';
import { amapEnvironment, injectAmap } from './helpers/amap.mjs';

test('a browser imports and exports a complete route and manually retries an interrupted Docker plan', { timeout: 1200000 }, async () => {
  // The interruption is observed before manual restart; production keeps unless-stopped.
  const app = await createDockerApplication({ environment: amapEnvironment, restart: 'no' });
  let browser;
  try {
    let upstream = await injectAmap(app);
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1050 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await replaceAmapSDK(page);
    await page.goto(app.baseUrl);
    await page.getByRole('button', { name: '新建项目', exact: true }).click();
    await page.getByLabel('项目名称', { exact: true }).fill('Docker 浏览器闭环');
    await page.getByRole('button', { name: '创建项目', exact: true }).click();
    await assertOverview(page);
    await page.getByRole('region', { name: '项目线路', exact: true }).getByRole('button', { name: '新建线路', exact: true }).click();
    await page.getByLabel('线路名称', { exact: true }).fill('Docker 三站送货');
    await page.getByRole('button', { name: '创建线路', exact: true }).click();
    await page.getByRole('heading', { name: 'Docker 三站送货', exact: true }).waitFor();
    await page.getByRole('button', { name: '从点位库选择', exact: true }).click();
    await page.getByRole('button', { name: '导入点位', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '导入项目点位', exact: true });
    await dialog.getByLabel('选择点位文件', { exact: true }).setInputFiles({
      name: 'docker-points.csv', mimeType: 'text/csv',
      buffer: Buffer.from('名称,经度,纬度\n上海仓,121.47,31.23\n苏州客户,120.58,31.3\n南京客户,118.79,32.06\n'),
    });
    await dialog.getByLabel('工作表', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: '预览并校验', exact: true }).click();
    await dialog.getByText('3 行有效', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: '确认导入 3 行', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    for (const name of ['上海仓', '苏州客户', '南京客户']) {
      await page.locator('.library-point').filter({ has: page.getByText(name, { exact: true }) })
        .getByRole('button', { name: `将 ${name} 选入当前线路`, exact: true }).click();
      await page.getByText('点位已复制到线路，之后独立维护', { exact: true }).waitFor();
    }
    await page.getByRole('button', { name: '返回线路点位', exact: true }).click();
    assert.deepEqual(await page.getByLabel('有序点位', { exact: true }).locator('strong').allTextContents(), ['上海仓', '苏州客户', '南京客户']);
    await goTask(page, '测算线路');
    await page.locator('[data-sdk-map="ready"]').waitFor();
    await page.getByRole('button', { name: '开始规划', exact: true }).click();
    await page.getByText('路线方案已完整保存', { exact: true }).waitFor();
    assert.equal(await page.locator('[data-sdk-polyline]').count(), 2);
    await goTask(page, '核对方案');
    assert.match(await page.getByRole('region', { name: '路线方案', exact: true }).innerText(), /2\.468/);
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出当前线路', exact: true }).click();
    const book = new ExcelJS.Workbook();
    await book.xlsx.readFile(await (await downloading).path());
    assert.deepEqual(book.worksheets.map(({ name }) => name), ['线路总览', '区间明细']);
    assert.equal(book.getWorksheet('线路总览').getCell('G3').value, 2.468);
    assert.equal(book.getWorksheet('线路总览').getCell('G3').numFmt, '0.000');
    assert.equal(book.getWorksheet('区间明细').getCell('H4').value, 2.468);

    const request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
    const project = (await request('/api/projects')).body[0];
    const route = (await request(`/api/projects/${project.id}/routes`)).body[0];
    const routePath = `/api/routes/${route.id}?projectId=${project.id}`;
    const previous = route.snapshot;
    assert.equal(previous.totalDistanceMeters, 2468);
    assert.deepEqual((await upstream.state()).driving.map(({ strategy }) => strategy), ['32', '32']);
    await upstream.holdAfter(2);
    await goTask(page, '测算线路');
    await page.getByRole('button', { name: '重新规划', exact: true }).click();
    await page.getByRole('button', { name: '规划中 1/2', exact: true }).waitFor();
    const running = (await request(routePath)).body;
    assert.equal(running.planning.status, 'running');
    assert.equal(running.planning.completed, 1);
    assert.deepEqual(running.snapshot, previous);
    assert.equal((await upstream.state()).held, 1);
    await page.reload();
    await assertOverview(page);
    await openRouteFromSidebar(page, route.name);
    await goTask(page, '测算线路');
    const runningButton = page.getByRole('button', { name: '规划中 1/2', exact: true });
    await runningButton.waitFor();
    assert.equal(await runningButton.isDisabled(), true);
    assert.equal((await request(routePath)).body.planning.taskId, running.planning.taskId);

    await docker(['kill', '--signal', 'KILL', await app.containerId()]);
    await app.start();
    upstream = await injectAmap(app);
    const recovered = (await request(routePath)).body;
    assert.equal(recovered.planning.status, 'failed');
    assert.match(recovered.planning.error, /中断.*重新规划/);
    assert.equal(recovered.planning.taskId, running.planning.taskId);
    assert.equal(recovered.planning.completed, 1);
    assert.equal(recovered.planning.total, 2);
    assert.equal(recovered.inputVersion, running.inputVersion);
    assert.deepEqual(recovered.points, running.points);
    assert.deepEqual(recovered.snapshot, previous);
    await page.goto(app.baseUrl);
    await assertOverview(page);
    await openRouteFromSidebar(page, route.name);
    await goTask(page, '测算线路');
    await page.getByText(recovered.planning.error, { exact: true }).waitFor();
    const retry = page.getByRole('button', { name: '重新规划', exact: true });
    assert.equal(await retry.isEnabled(), true);
    assert.equal((await upstream.state()).driving.length, 0, 'reopening the recovered route does not recalculate');
    await retry.click();
    await page.getByText('路线方案已完整保存', { exact: true }).waitFor();
    const retried = (await request(routePath)).body;
    assert.equal(retried.planning, null);
    assert.equal(retried.snapshot.totalDistanceMeters, 2468);
    assert.equal((await upstream.state()).driving.length, 2);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await app.cleanup();
  }
});
