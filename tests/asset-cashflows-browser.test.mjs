/* global document, window, getComputedStyle */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { openDailyPlan } from './helpers/daily-transport-fixture.mjs';
import { startAssetApplication } from './helpers/asset-cashflows-fixture.mjs';

test(
  'asset forms and TSV preview publish independent multi-year capital cashflows and reopen versioned history',
  { timeout: 240000 },
  async (t) => {
    const { app, request, path, project, scenario } = await startAssetApplication(t, {
      mode: process.env.HAULPATH_ASSET_TEST_MODE || 'dev',
    });
    const browser = await chromium.launch({
      channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || 'chrome',
      headless: true,
    });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openDailyPlan(page, app.baseUrl, project, scenario);
    const qa = process.env.HAULPATH_ASSET_QA_DIR;
    if (qa) {
      await mkdir(qa, { recursive: true });
      await page.screenshot({ path: `${qa}/incumbent.png`, fullPage: true });
    }
    await page.getByRole('button', { name: '资产与资金', exact: true }).click();
    const region = page.getByRole('region', { name: '方案资产与资本收付', exact: true });
    await region.getByRole('button', { name: '编辑资产与资金', exact: true }).click();
    await region.getByLabel('资产业务边界', { exact: true }).selectOption('integrated');
    await region.getByLabel('初始建设年份', { exact: true }).fill('2030');
    await region
      .getByLabel('资产评价年份（用顿号或逗号分隔）', { exact: true })
      .fill('2030、2031、2032');
    await region
      .getByLabel('全部资产及营运资金范围依据', { exact: true })
      .fill('固定规模资产和资金安排，无其他项目');
    await region.getByRole('button', { name: '添加分类资产', exact: true }).click();
    await region.getByLabel('资产 1 名称', { exact: true }).fill('周转电池');
    await region.getByLabel('资产 1 分类', { exact: true }).selectOption('battery');
    await region.getByLabel('资产 1 归属', { exact: true }).selectOption('station');
    await region.getByLabel('资产 1 取得方式', { exact: true }).selectOption('new');
    await region.getByLabel('资产 1 取得金额（元）', { exact: true }).fill('1000');
    await region.getByLabel('资产 1 投运年份', { exact: true }).fill('2030');
    await region.getByLabel('资产 1 来源', { exact: true }).fill('电池报价');
    await region.getByLabel('资产 1 范围说明', { exact: true }).fill('周转电池，不含其他资产');
    await region.getByRole('button', { name: '添加资产 1 更换', exact: true }).click();
    await region.getByLabel('资产 1 更换 1 年份', { exact: true }).fill('2031');
    await region.getByLabel('资产 1 更换 1 投资（元）', { exact: true }).fill('400');
    await region.getByLabel('资产 1 更换 1 旧件回收（元）', { exact: true }).fill('50');
    await region.getByLabel('资产 1 更换 1 来源', { exact: true }).fill('更换及回收合同');
    await region.getByRole('button', { name: '填写资产 1 末期残值', exact: true }).click();
    await region.getByLabel('资产 1 残值年份', { exact: true }).fill('2032');
    await region.getByLabel('资产 1 残值（元）', { exact: true }).fill('80');
    await region.getByLabel('资产 1 残值来源', { exact: true }).fill('末期残值估价');
    await region.getByText('批量粘贴资产或营运资金', { exact: true }).click();
    await region.getByLabel('资产资金粘贴内容', { exact: true }).fill('非法\t资料');
    await region.getByRole('button', { name: '预览资产资金粘贴', exact: true }).click();
    assert.match(await region.getByRole('alert').innerText(), /13列/);
    await region
      .getByLabel('资产资金粘贴内容', { exact: true })
      .fill(
        [
          '未完成设备',
          'other',
          'station',
          'new',
          '',
          '',
          '',
          '草稿待补齐',
          '',
          '',
          '',
          '',
          '',
        ].join('\t'),
      );
    await region.getByRole('button', { name: '预览资产资金粘贴', exact: true }).click();
    await region
      .getByRole('region', { name: '资产资金粘贴预览' })
      .waitFor({ state: 'visible', timeout: 3000 });
    await region
      .getByLabel('资产资金粘贴内容', { exact: true })
      .fill(
        [
          '错误站点',
          'station',
          'station',
          'new',
          '100',
          '2030',
          '报价',
          '站点',
          '',
          '',
          '2032',
          '0',
          '零',
        ].join('\t'),
      );
    await region.getByRole('button', { name: '预览资产资金粘贴', exact: true }).click();
    assert.match(await region.getByRole('alert').innerText(), /关联固定布局站址/);
    assert.equal(
      await region.getByRole('button', { name: '采用资产资金预览', exact: true }).count(),
      0,
    );

    await region
      .getByLabel('资产资金粘贴内容', { exact: true })
      .fill(
        [
          '已有车辆',
          'vehicle',
          'transport',
          'existing',
          '5000',
          '2025',
          '历史合同',
          '已有资产不重复投入',
          '',
          '',
          '2032',
          '0',
          '无残值',
        ].join('\t'),
      );
    await region.getByRole('button', { name: '预览资产资金粘贴', exact: true }).click();
    assert.match(
      await region.getByRole('region', { name: '资产资金粘贴预览' }).innerText(),
      /已有车辆/,
    );
    await region
      .getByLabel('全部资产及营运资金范围依据', { exact: true })
      .fill('采用预览前的最新范围：全部资产和营运资金已列明');
    await region.getByRole('button', { name: '采用资产资金预览', exact: true }).click();
    await region.getByLabel('粘贴资料类型', { exact: true }).selectOption('working');
    await region.getByLabel('资产资金粘贴内容', { exact: true }).fill(
      [
        ['station', '0', '无期初占用', 2030, '100', '首年占用'],
        ['station', '0', '无期初占用', 2031, '120', '补充20'],
        ['station', '0', '无期初占用', 2032, '0', '显式释放120'],
      ]
        .map((r) => r.join('\t'))
        .join('\n'),
    );
    await region.getByRole('button', { name: '预览资产资金粘贴', exact: true }).click();
    await region.getByRole('button', { name: '采用资产资金预览', exact: true }).click();
    if (qa) {
      await region.evaluate((element) => {
        for (let current = element.parentElement; current; current = current.parentElement)
          current.scrollTop = 0;
        window.scrollTo(0, 0);
      });
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${qa}/editor-desktop.png`, fullPage: true });
      await region.getByLabel('资产 1 取得金额（元）', { exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${qa}/asset-fields-desktop.png`, fullPage: true });
    }
    const saving = page.waitForResponse(
      (r) => r.url().endsWith(`${path}/asset-cashflows`) && r.request().method() === 'PUT',
    );
    await region.getByRole('button', { name: '保存资产与资金', exact: true }).click();
    assert.equal((await saving).status(), 200);
    const saved = (await request(path)).body;
    assert.equal(saved.context.assetCashflows.assets.length, 2);
    assert.equal(
      saved.context.assetCashflows.scopeSource,
      '采用预览前的最新范围：全部资产和营运资金已列明',
    );
    const calculating = page.waitForResponse(
      (r) => r.url().endsWith(`${path}/asset-cashflows`) && r.request().method() === 'POST',
    );
    await region.getByRole('button', { name: '核对资本收付', exact: true }).click();
    const result = await (await calculating).json();
    assert.equal(result.complete, true, JSON.stringify(result));
    assert.deepEqual(
      result.years.map((y) => [y.outflowCents, y.inflowCents, y.balanceCents]),
      [
        [110000, 0, -110000],
        [42000, 5000, -37000],
        [0, 20000, 20000],
      ],
    );
    assert.match(
      await region.getByRole('table', { name: '逐年资本收付汇总' }).innerText(),
      /-1,100.00/,
    );
    const initialCell = region
      .getByRole('table', { name: '逐年资本收付汇总' })
      .getByRole('cell', { name: '1,000.00', exact: true });
    assert.equal(await initialCell.evaluate((el) => getComputedStyle(el).textAlign), 'right');
    await region.getByRole('button', { name: '核对 2032 年资本', exact: true }).click();
    assert.match(
      await region.getByRole('table', { name: '2032 年营运资金' }).innerText(),
      /120.00/,
    );
    if (qa) {
      for (const [width, height, name] of [
        [1440, 1000, 'desktop'],
        [1024, 768, 'compact'],
        [390, 844, 'mobile'],
      ]) {
        await page.setViewportSize({ width, height });
        await region.evaluate((element) => {
          for (let current = element.parentElement; current; current = current.parentElement)
            current.scrollTop = 0;
          window.scrollTo(0, 0);
        });
        await page.waitForTimeout(150);
        await page.screenshot({ path: `${qa}/result-${name}.png`, fullPage: false });
        await region.getByRole('table', { name: '逐年资本收付汇总' }).scrollIntoViewIfNeeded();
        await page.waitForTimeout(150);
        await page.screenshot({ path: `${qa}/ledger-${name}.png`, fullPage: false });
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
          ),
          true,
        );
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    await region.getByRole('button', { name: '编辑资产与资金', exact: true }).click();
    assert.equal(
      await page.getByRole('button', { name: '年度能力', exact: true }).isDisabled(),
      true,
    );
    await region.getByRole('button', { name: '添加年度替代', exact: true }).click();
    await region
      .getByLabel('覆盖 1 资产', { exact: true })
      .selectOption(saved.context.assetCashflows.assets[0].id);
    await region.getByLabel('覆盖 1 年份', { exact: true }).fill('2031');
    await region.getByLabel('覆盖 1 金额（元）', { exact: true }).fill('350');
    await region.getByLabel('覆盖 1 原因', { exact: true }).fill('替代年度合同价');
    await region.getByLabel('覆盖 1 来源', { exact: true }).fill('合同修订');
    await region.getByRole('button', { name: '保存资产与资金', exact: true }).click();
    await region.getByRole('button', { name: '核对资本收付', exact: true }).click();
    await region.getByRole('button', { name: '核对 2031 年资本', exact: true }).click();
    assert.match(
      await region.getByRole('table', { name: '2031 年资产收付' }).innerText(),
      /350.00/,
    );
    assert.match(
      await region.getByRole('table', { name: '2031 年资产收付' }).innerText(),
      /替代年度合同价/,
    );
    await region.getByLabel('历史资产账目', { exact: true }).selectOption(result.id);
    assert.match(
      await region.getByRole('region', { name: '资本收付结果' }).innerText(),
      /历史输入版本/,
    );
    await page.reload();
    await openDailyPlan(page, app.baseUrl, project, scenario);
    await page.getByRole('button', { name: '资产与资金', exact: true }).click();
    await region.getByLabel('历史资产账目', { exact: true }).waitFor({ state: 'visible' });
    assert.equal(
      await region.getByLabel('历史资产账目', { exact: true }).locator('option').count(),
      2,
    );
    assert.deepEqual(errors, []);
  },
);
