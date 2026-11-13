/* global document */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { openDailyPlan, waitDailyTransportTask } from './helpers/daily-transport-fixture.mjs';
import { repeatableFixture } from './helpers/repeatable-day-fixture.mjs';
import { startVehicleEnergyApplication } from './helpers/vehicle-energy-fixture.mjs';
import { financeInput } from './helpers/operating-cashflows-fixture.mjs';

test(
  'operating cashflows edit, preview, adopt evidence and reopen traceable history through the real workbench',
  { timeout: 240000 },
  async (t) => {
    const { app, request } = await startVehicleEnergyApplication(t, {
      mode: process.env.HAULPATH_CASHFLOW_TEST_MODE || 'dev',
    });
    const model = await repeatableFixture(request);
    const demandId = model.scenario.context.transportDemands[0].id;
    await model.save('/annual-transport', 'PUT', {
      years: [{ year: 2030, operatingDays: 1, demands: [{ demandId, dailyTonnes: 10 }] }],
    });
    await model.prepare();
    const launch = await request(`${model.path}/annual-transport`, 'POST', {
      expectedRevision: model.scenario.revision,
    });
    const source = await waitDailyTransportTask(request, model.path, launch.body.task.taskId);
    const browser = await chromium.launch({
      channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || 'chrome',
      headless: true,
    });
    t.after(() => browser.close());
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await openDailyPlan(page, app.baseUrl, model.project, model.scenario);
      const qa = process.env.HAULPATH_CASHFLOW_QA_DIR;
      if (qa) {
        await mkdir(qa, { recursive: true });
        await page.screenshot({ path: `${qa}/incumbent.png`, fullPage: true });
      }
      await page.getByRole('button', { name: '运营收支', exact: true }).click({ timeout: 15000 });
      const region = page.getByRole('region', { name: '方案年度运营收支', exact: true });
      await region.getByRole('button', { name: '编辑运营收支', exact: true }).click();
      await region.getByLabel('业务边界', { exact: true }).selectOption('integrated');
      await region
        .getByLabel('2030 年收支范围依据', { exact: true })
        .fill('合同和预算已列全部运营收支');
      await region.getByLabel('2030 年站点运维口径', { exact: true }).selectOption('annual-lines');
      await region.getByRole('button', { name: '添加 2030 年收支项目', exact: true }).click();
      await region.getByLabel('2030 年明细 1 名称', { exact: true }).fill('运费草稿');
      await region
        .getByLabel('2030 年明细 1 归属', { exact: true })
        .selectOption('transport-revenue');
      await region.getByLabel('2030 年明细 1 计费单位', { exact: true }).selectOption('tonne');
      await region.getByLabel('2030 年明细 1 单价（元）', { exact: true }).fill('100');
      await region.getByLabel('2030 年明细 1 来源', { exact: true }).fill('运输合同');
      await region.getByRole('button', { name: '批量粘贴收支', exact: true }).click();
      const rows = financeInput()
        .years[0].lines.map((l) =>
          [2030, l.id, l.name, l.flow, l.basis, l.rate, l.source, l.stationId ?? ''].join('\t'),
        )
        .join('\n');
      await region
        .getByLabel('收支粘贴内容', { exact: true })
        .fill(rows.replace('\t100\t', '\t-1\t'));
      await region.getByRole('button', { name: '预览收支粘贴', exact: true }).click();
      assert.match(await region.getByRole('alert').innerText(), /非负/);
      await region.getByLabel('收支粘贴内容', { exact: true }).fill(rows);
      await region.getByRole('button', { name: '预览收支粘贴', exact: true }).click();
      assert.match(
        await region.getByRole('region', { name: '收支粘贴预览' }).innerText(),
        /内部换电/,
      );
      await region.getByLabel('2030 年收支范围依据', { exact: true }).fill('更新后的范围依据');
      await region.getByRole('button', { name: '采用收支预览', exact: true }).click();
      await region.getByRole('button', { name: '批量粘贴电价', exact: true }).click();
      const powerId = model.scenario.context.stationNetwork.powerSources[0].id;
      await region.getByLabel('电价粘贴内容', { exact: true }).fill(
        [
          [2030, powerId, 'station', 0, 600, '1', '电价合同早段'],
          [2030, powerId, 'station', 600, 660, '2', '电价合同中段'],
          [2030, powerId, 'station', 660, 0, '3', '电价合同跨午夜段'],
        ]
          .map((r) => r.join('\t'))
          .join('\n'),
      );
      await region.getByRole('button', { name: '预览电价粘贴', exact: true }).click();
      await region.getByRole('button', { name: '采用电价预览', exact: true }).click();
      const savedResponse = page.waitForResponse(
        (r) =>
          r.url().endsWith(`${model.path}/operating-cashflows`) && r.request().method() === 'PUT',
      );
      await region.getByRole('button', { name: '保存运营收支', exact: true }).click();
      assert.equal((await savedResponse).status(), 200);
      const saved = (await request(model.path)).body;
      assert.equal(saved.context.operatingCashflows.years[0].lines.length, 4);
      assert.equal(saved.context.operatingCashflows.years[0].scopeSource, '更新后的范围依据');
      await region.getByLabel('采用的年度任务', { exact: true }).selectOption(source.taskId);
      const calculated = page.waitForResponse(
        (r) =>
          r.url().endsWith(`${model.path}/operating-cashflows`) && r.request().method() === 'POST',
      );
      await region.getByRole('button', { name: '核对运营收支', exact: true }).click();
      assert.equal((await calculated).status(), 201);
      const summary = region.getByRole('table', { name: '逐年运营收支汇总', exact: true });
      await summary.waitFor();
      assert.match(await summary.innerText(), /-80\.67/);
      assert.match(await region.innerText(), /内部抵销/);
      assert.match(await region.innerText(), /未校核税费、投资及融资/);
      await region.getByRole('button', { name: '编辑运营收支', exact: true }).click();
      await region.getByLabel('业务边界', { exact: true }).selectOption('station-only');
      await region.getByRole('button', { name: '保存运营收支', exact: true }).click();
      await region.getByText('历史输入版本', { exact: false }).first().waitFor();
      await region.getByRole('button', { name: '核对运营收支', exact: true }).click();
      await page.getByText('-874.67', { exact: true }).first().waitFor();
      const finalScenario = (await request(model.path)).body;
      for (const [width, height] of [
        [1440, 1000],
        [768, 1024],
        [390, 844],
      ]) {
        await page.setViewportSize({ width, height });
        await region
          .getByRole('heading', { name: '年度运营收支', exact: true })
          .scrollIntoViewIfNeeded();
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          ),
          true,
        );
        if (qa) {
          await page.screenshot({ path: `${qa}/cashflows-${width}.png`, fullPage: true });
          await summary.scrollIntoViewIfNeeded();
          await page.screenshot({ path: `${qa}/results-${width}.png`, fullPage: true });
          await region.getByRole('button', { name: '编辑运营收支', exact: true }).click();
          await region.getByLabel('2030 年收支范围依据', { exact: true }).scrollIntoViewIfNeeded();
          await page.screenshot({ path: `${qa}/editor-${width}.png`, fullPage: true });
          await region.getByRole('button', { name: '取消编辑', exact: true }).click();
        }
      }
      await page.reload();
      await openDailyPlan(page, app.baseUrl, model.project, finalScenario);
      await page.getByRole('button', { name: '运营收支', exact: true }).click();
      await region.getByRole('table', { name: '逐年运营收支汇总', exact: true }).waitFor();
      assert.match(await region.innerText(), /仅站方/);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  },
);
