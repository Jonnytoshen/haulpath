/* global document, window */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { openDailyPlan } from './helpers/daily-transport-fixture.mjs';
import { taxFixture } from './helpers/tax-cashflows-fixture.mjs';
test(
  'tax forms and annual TSV produce traceable project cashflows and reopen history',
  { timeout: 240000 },
  async (t) => {
    const m = await taxFixture(t, { mode: process.env.HAULPATH_TAX_TEST_MODE || 'dev' });
    const browser = await chromium.launch({
      channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || 'chrome',
      headless: true,
    });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openDailyPlan(page, m.app.baseUrl, m.project, m.scenario);
    await page.getByRole('button', { name: '税费与现金流', exact: true }).click();
    const region = page.getByRole('region', { name: '方案税费与项目现金流', exact: true });
    await region.getByLabel('采用运营账目', { exact: true }).selectOption(m.operating.id);
    await region.getByLabel('采用资产账目', { exact: true }).selectOption(m.assets.id);
    await region.getByRole('button', { name: '编辑税务规则', exact: true }).click();
    const input = m.input;
    const fill = (label, value) => region.getByLabel(label, { exact: true }).fill(String(value));
    await fill('税务范围依据', input.scopeSource);
    await fill('期初进项留抵（元）', '0');
    await fill('期初留抵来源', input.openingVatSource);
    await fill('亏损结转年数（0为不结转）', 5);
    await fill('亏损结转来源', input.lossSource);
    await region.getByText('批量粘贴年度税务规则', { exact: true }).click();
    await fill('年度税务粘贴内容', '2030\tbroken');
    await region.getByRole('button', { name: '预览年度税务粘贴', exact: true }).click();
    assert.match(await region.getByRole('alert').innerText(), /7列/);
    await fill(
      '年度税务粘贴内容',
      input.years
        .map((y) =>
          [
            y.year,
            y.activity,
            y.incomeTaxRate,
            y.otherTax,
            String(y.otherTaxDeductible),
            y.source,
            y.taxSource,
          ].join('\t'),
        )
        .join('\n'),
    );
    await region.getByRole('button', { name: '预览年度税务粘贴', exact: true }).click();
    await fill('税务范围依据', `${input.scopeSource}；预览期间编辑保留`);
    await region.getByRole('button', { name: '采用年度税务预览', exact: true }).click();
    assert.match(
      await region.getByLabel('税务范围依据', { exact: true }).inputValue(),
      /预览期间编辑保留/,
    );
    await region.getByText(/逐项含税、抵扣及所得税处理 ·/).click();
    for (let i = 0; i < input.rules.length; i++) {
      const r = input.rules[i],
        n = i + 1;
      await region.getByLabel(`规则 ${n} 含税方式`, { exact: true }).selectOption(r.pricing);
      await fill(`规则 ${n} 税率`, r.vatRate);
      await region.getByLabel(`规则 ${n} 进项条件`, { exact: true }).selectOption(r.credit);
      await region.getByLabel(`规则 ${n} 所得税处理`, { exact: true }).selectOption(r.incomeTax);
      await fill(`规则 ${n} 来源`, r.source);
    }
    await region.getByText(/逐项含税、抵扣及所得税处理 ·/).click();
    await region.getByText(/分类直线折旧及历史剩余税基/).click();
    const cats = { battery: '电池', vehicle: '车辆', connection: '接电工程' };
    for (const r of input.depreciation) {
      const c = cats[r.category];
      await fill(`${c} 折旧年数（0为不折旧）`, r.years);
      await fill(`${c} 税务残值率`, r.residualRate);
      await region.getByLabel(`${c} 折旧起算`, { exact: true }).selectOption(r.start);
      await fill(`${c} 折旧来源`, r.source);
    }
    await fill('已有车辆 期初剩余税基（元）', '300');
    await fill('已有车辆 剩余折旧年数', 3);
    await fill('已有车辆 税务残值（元）', '0');
    await fill('已有车辆 历史税基来源', input.historicalAssets[0].source);
    const qa = process.env.HAULPATH_TAX_QA_DIR;
    if (qa) {
      await mkdir(qa, { recursive: true });
      await region.getByLabel('税务范围依据', { exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${qa}/editor-desktop.png`, fullPage: true });
    }
    await region.getByRole('button', { name: '保存税务规则', exact: true }).click();
    await region.getByRole('button', { name: '核对税后项目现金流', exact: true }).click();
    await region.getByText('税后项目现金流完整', { exact: true }).waitFor();
    const summary = region.getByRole('table', { name: '年度税务与项目现金流' });
    assert.match(await summary.innerText(), /-980\.00/);
    assert.match(await summary.innerText(), /1,160\.00/);
    assert.match(await summary.innerText(), /1,470\.00/);
    await region.getByLabel('核对税务年份', { exact: true }).selectOption('2031');
    assert.match(await region.innerText(), /400\.00/);
    {
      for (const [name, width] of [
        ['desktop', 1440],
        ['compact', 1000],
        ['mobile', 390],
      ]) {
        await page.setViewportSize({ width, height: 1000 });
        await region
          .getByRole('heading', { name: '税费与项目现金流', exact: true })
          .scrollIntoViewIfNeeded();
        if (qa) await page.screenshot({ path: `${qa}/result-${name}.png`, fullPage: true });
        await summary.scrollIntoViewIfNeeded();
        if (qa) await page.screenshot({ path: `${qa}/ledger-${name}.png`, fullPage: true });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          true,
        );
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    await page.reload();
    await openDailyPlan(page, m.app.baseUrl, m.project, m.scenario);
    await page.getByRole('button', { name: '税费与现金流', exact: true }).click();
    await region.getByText('税后项目现金流完整', { exact: true }).waitFor();
    await region.getByLabel('采用运营账目', { exact: true }).selectOption(m.operating.id);
    await region.getByLabel('采用资产账目', { exact: true }).selectOption(m.assets.id);
    await region.getByRole('button', { name: '编辑税务规则', exact: true }).click();
    await region.getByText('期初亏损及特殊年度税费替代', { exact: true }).click();
    await region.getByRole('button', { name: '添加税费替代', exact: true }).click();
    await fill('替代 1 年份', 2031);
    await fill('替代 1 金额（元）', '90');
    await fill('替代 1 原因', '特殊所得税核定');
    await fill('替代 1 来源', '人工核定依据');
    await region.getByRole('button', { name: '保存税务规则', exact: true }).click();
    await region.getByRole('button', { name: '核对税后项目现金流', exact: true }).click();
    await region.getByText('税后项目现金流完整', { exact: true }).waitFor();
    await summary.getByRole('cell', { name: '1,170.00', exact: true }).waitFor();
    assert.match(await summary.innerText(), /1,170\.00/);
    const current = (await m.request(m.path)).body;
    const ledgers = (await m.request(`${m.path}/tax-cashflows`)).body.results;
    assert.equal(ledgers.length, 2);
    assert.equal(ledgers[0].inputVersion, current.inputVersion);
    assert.equal(ledgers[0].years[1].payments[1].baseCents, 10000);
    assert.equal(ledgers[0].years[1].payments[1].adoptedCents, 9000);
    assert.deepEqual(errors, []);
  },
);
