/* global document */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { prepareNextCommand } from '../scripts/next-command.mjs';
import { startApplication, jsonRequest } from './helpers/application.mjs';
import { startVehicleEnergyApplication } from './helpers/vehicle-energy-fixture.mjs';
import { repeatableFixture } from './helpers/repeatable-day-fixture.mjs';
import { waitSearch } from './helpers/daily-search-fixture.mjs';
import { openDailyPlan } from './helpers/daily-transport-fixture.mjs';

const run = promisify(execFile);

test(
  'production search survives page close, SIGKILL and online backup restore; manual continuation retains candidates through the real five-minute timeout',
  { timeout: 600000 },
  async (t) => {
    const build = prepareNextCommand('build');
    await run(build.file, build.args, {
      cwd: build.cwd,
      env: { ...build.env, NEXT_TELEMETRY_DISABLED: '1' },
      maxBuffer: 5_000_000,
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
    await model.prepare();
    const browser = await chromium.launch({
      channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || 'chrome',
      headless: true,
    });
    const backupDir = await mkdtemp(join(tmpdir(), 'haulpath-search-backup-'));
    const errors = [];
    try {
      let page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      page.on('pageerror', (error) => errors.push(error.message));
      let region = await openDailyPlan(page, app.baseUrl, model.project, model.scenario);
      await region.getByText(/道路准备耗时/).waitFor();
      const launchResponse = page.waitForResponse(
        (res) =>
          res.url().endsWith(`${model.path}/daily-transport`) && res.request().method() === 'POST',
      );
      await region.getByRole('button', { name: '校核 24 小时周期', exact: true }).click();
      const launch = await launchResponse;
      assert.equal(launch.status(), 202);
      const id = (await launch.json()).task.taskId;
      const summary = await waitSearch(
        request,
        model,
        id,
        (task) => task.search?.best && task.status === 'running',
      );
      await region.getByText(/最佳完整候选：90\.000 吨/).waitFor();
      const candidate = (await request(`${model.path}/daily-transport/${id}`)).body;
      assert.equal(candidate.result.validation.valid, true);
      assert.equal(candidate.result.totalCompletedTonnes, 90);
      assert.equal(candidate.result.vehicleEnergy.totalDistanceMeters, 1674000);
      assert.ok(summary.elapsedMs > 0);
      const qa = process.env.HAULPATH_SEARCH_QA_DIR;
      if (qa) await mkdir(qa, { recursive: true });
      for (const [width, height] of [
        [1440, 1000],
        [768, 1024],
        [390, 844],
      ]) {
        await page.setViewportSize({ width, height });
        await region.getByRole('region', { name: '完整候选与搜索进度' }).scrollIntoViewIfNeeded();
        assert.ok(
          await region
            .getByRole('button', { name: '停止24 小时周期校核', exact: true })
            .isVisible(),
        );
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          ),
          true,
        );
        if (qa) await page.screenshot({ path: join(qa, `search-${width}.png`), fullPage: true });
      }
      await page.close();
      const afterClose = await waitSearch(
        request,
        model,
        id,
        (task) => task.search.attempts > summary.search.attempts,
      );
      assert.equal(afterClose.status, 'running');
      const backup = join(backupDir, 'running.sqlite');
      await run('sqlite3', [
        '-noinit',
        '-readonly',
        join(app.directory, 'test.sqlite'),
        `.backup '${backup}'`,
      ]);
      await app.stop('SIGKILL');
      for (const restore of [false, true]) {
        const target = restore ? join(backupDir, 'restored') : initial.app.directory;
        if (restore) {
          await mkdir(target);
          await copyFile(backup, join(target, 'test.sqlite'));
        }
        app = await startApplication(
          { HAULPATH_TEST_MODE: '1', AMAP_JS_KEY: '', AMAP_JS_SECURITY_CODE: '' },
          target,
          { mode: 'start' },
        );
        const interrupted = (await request(`${model.path}/daily-transport/${id}`)).body;
        assert.equal(interrupted.status, 'interrupted');
        assert.deepEqual(interrupted.snapshot, candidate.snapshot);
        assert.deepEqual(interrupted.result, candidate.result);
        assert.ok(interrupted.search.best);
        page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        page.on('pageerror', (error) => errors.push(error.message));
        region = await openDailyPlan(page, app.baseUrl, model.project, model.scenario);
        await region.getByText(interrupted.error, { exact: true }).waitFor();
        assert.equal(
          (await request(`${model.path}/daily-transport/${id}`)).body.status,
          'interrupted',
        );
        const resumedResponse = page.waitForResponse(
          (res) => res.url().endsWith(`/${id}/continue`) && res.request().method() === 'POST',
        );
        await region.getByText('试算设置', { exact: true }).click();
        await region.getByRole('spinbutton', { name: '最长试算时间（分钟）' }).fill('5');
        await region.getByRole('button', { name: '继续搜索', exact: true }).click();
        const resumed = await resumedResponse;
        assert.equal(resumed.status(), 202);
        const nextId = (await resumed.json()).task.taskId;
        assert.notEqual(nextId, id);
        const next = (await request(`${model.path}/daily-transport/${nextId}`)).body;
        assert.equal(next.continuedFromTaskId, id);
        assert.deepEqual(next.snapshot, interrupted.snapshot);
        assert.deepEqual(next.result, interrupted.result);
        assert.equal(next.search.best.sourceTaskId, id);
        assert.ok(BigInt(next.search.nextOrder) >= BigInt(interrupted.search.nextOrder));
        if (!restore) {
          await region.getByRole('button', { name: '停止24 小时周期校核', exact: true }).click();
          await region.getByText(/已停止运输试算/).waitFor();
          assert.equal(
            (await request(`${model.path}/daily-transport/${nextId}`)).body.status,
            'stopped',
          );
        } else {
          await page.close();
          const timedOut = await waitSearch(
            request,
            model,
            nextId,
            (task) => task.status === 'timed-out',
            340000,
          );
          assert.equal(timedOut.config.maxRuntimeMs, 300000);
          assert.ok(timedOut.elapsedMs >= 300000);
          const kept = (await request(`${model.path}/daily-transport/${nextId}`)).body;
          assert.deepEqual(kept.result, interrupted.result);
          assert.equal(kept.result.physicalFeasibility, 'feasible');
          assert.equal(
            (await request(`${model.path}/daily-transport`)).body.resultTask.result
              .totalCompletedTonnes,
            90,
          );
          const finalContinue = await request(
            `${model.path}/daily-transport/${nextId}/continue`,
            'POST',
            { expectedRevision: model.scenario.revision },
          );
          assert.equal(finalContinue.status, 202);
          await request(
            `${model.path}/daily-transport/${finalContinue.body.task.taskId}/stop`,
            'POST',
          );
        }
        assert.deepEqual((await request(`${model.path}/daily-transport/${id}`)).body, interrupted);
        await page.close();
        await app.stop();
      }
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await app.stop('SIGKILL');
      await rm(backupDir, { recursive: true, force: true });
    }
  },
);
