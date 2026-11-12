import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { prepareNextCommand } from '../scripts/next-command.mjs';
import { startApplication, jsonRequest } from './helpers/application.mjs';
import { startVehicleEnergyApplication } from './helpers/vehicle-energy-fixture.mjs';
import { repeatableFixture } from './helpers/repeatable-day-fixture.mjs';
import { openDailyPlan } from './helpers/daily-transport-fixture.mjs';
import { setTimeout as delay } from 'node:timers/promises';
const run = promisify(execFile);

test(
  'production annual candidates survive page close, SIGKILL and online SQLite backup restore',
  { timeout: 240000 },
  async (t) => {
    const build = prepareNextCommand('build');
    await run(build.file, build.args, {
      cwd: build.cwd,
      env: { ...build.env, NEXT_TELEMETRY_DISABLED: '1' },
      maxBuffer: 5000000,
    });
    const initial = await startVehicleEnergyApplication(t, { mode: 'start' });
    let app = initial.app;
    const request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
    const model = await repeatableFixture(request, {
      count: 9,
      bays: 9,
      batteryInventory: 9,
      chargePowerKw: 720,
    });
    const demands = model.scenario.context.transportDemands.map((d) => ({
      demandId: d.id,
      dailyTonnes: 90,
    }));
    await model.save('/annual-transport', 'PUT', {
      years: [
        { year: 2030, operatingDays: 300, demands },
        { year: 2031, operatingDays: 200, demands },
      ],
    });
    await model.prepare();
    const browser = await chromium.launch({
      channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || 'chrome',
      headless: true,
    });
    const backupDir = await mkdtemp(join(tmpdir(), 'haulpath-annual-backup-'));
    t.after(async () => {
      await browser.close();
      await app.stop();
      await rm(backupDir, { recursive: true, force: true });
    });
    const page = await browser.newPage();
    await openDailyPlan(page, app.baseUrl, model.project, model.scenario);
    await page.getByRole('button', { name: '年度能力', exact: true }).click();
    const region = page.getByRole('region', { name: '方案年度运输能力', exact: true });
    const response = page.waitForResponse(
      (r) => r.url().endsWith(`${model.path}/annual-transport`) && r.request().method() === 'POST',
    );
    await region.getByRole('button', { name: '逐年校核运输能力', exact: true }).click();
    const launch = await response;
    assert.equal(launch.status(), 202);
    const id = (await launch.json()).task.taskId;
    const taskPath = `${model.path}/annual-transport/${id}`;
    for (let n = 0; ; n++) {
      assert.ok(n < 300, '未保存完整年度周期候选');
      const summary = (await request(`${taskPath}?summary=1`)).body;
      if (summary.annualProgress.validatedYears > 0) break;
      await delay(50);
    }
    const held = (await request(taskPath)).body;
    assert.equal(held.status, 'running');
    assert.equal(held.annualResult.years[0].evidence.validation.valid, true);
    await page.close();
    assert.equal((await request(taskPath)).body.status, 'running');
    const backup = join(backupDir, 'running.sqlite');
    await run('sqlite3', [
      '-noinit',
      '-readonly',
      join(app.directory, 'test.sqlite'),
      `.backup '${backup}'`,
    ]);
    await app.stop('SIGKILL');
    const restoreDir = join(backupDir, 'restored');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(restoreDir);
    await copyFile(backup, join(restoreDir, 'test.sqlite'));
    app = await startApplication(
      { HAULPATH_TEST_MODE: '1', AMAP_JS_KEY: '', AMAP_JS_SECURITY_CODE: '' },
      restoreDir,
      { mode: 'start' },
    );
    const restored = (await request(taskPath)).body;
    assert.equal(restored.status, 'interrupted');
    assert.equal(restored.annualResult.years[0].evidence.totalCompletedTonnes, 90);
    assert.deepEqual(restored.snapshot, held.snapshot);
    const continued = await request(`${taskPath}/continue`, 'POST', {
      expectedRevision: model.scenario.revision,
    });
    assert.equal(continued.status, 202, JSON.stringify(continued.body));
    const nextId = continued.body.task.taskId;
    for (let n = 0; ; n++) {
      assert.ok(n < 300, '续算未保留年度候选');
      const next = (await request(`${model.path}/annual-transport/${nextId}`)).body;
      if (next.annualResult?.years[0]?.evidence) {
        assert.equal(next.annualResult.years[0].evidence.totalCompletedTonnes, 90);
        assert.equal(next.continuedFromTaskId, id);
        break;
      }
      await delay(50);
    }
    await request(`${model.path}/annual-transport/${nextId}/stop`, 'POST');
    assert.deepEqual((await request(taskPath)).body.annualResult, restored.annualResult);
  },
);
