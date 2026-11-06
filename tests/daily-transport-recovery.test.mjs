import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { startApplication, jsonRequest } from './helpers/application.mjs';
import { prepareNextCommand } from '../scripts/next-command.mjs';
import { roadResponse } from './helpers/directed-road-fixture.mjs';
import {
  dailyTransportFixture,
  makeLongTransportWorkload,
  waitDailyTransportTask,
} from './helpers/daily-transport-fixture.mjs';

const run = promisify(execFile);

test(
  'production interruption and online backup restore preserve completed results and mark real CPU tasks interrupted',
  { timeout: 180000 },
  async () => {
    const build = prepareNextCommand('build');
    await run(build.file, build.args, {
      cwd: build.cwd,
      env: { ...build.env, NEXT_TELEMETRY_DISABLED: '1' },
      maxBuffer: 5_000_000,
    });
    const directory = await mkdtemp(join(tmpdir(), 'haulpath-transport-recovery-'));
    const dataDirectory = join(directory, 'data');
    const backup = join(directory, 'running.sqlite');
    const upstream = createServer((request, response) =>
      roadResponse(new URL(request.url, 'http://127.0.0.1'), response, '10000'),
    );
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const environment = {
      HAULPATH_TEST_MODE: '1',
      AMAP_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
      AMAP_WEB_SERVICE_KEY: 'transport-recovery-test',
      AMAP_JS_KEY: '',
      AMAP_JS_SECURITY_CODE: '',
    };
    let app;
    let browser;
    try {
      app = await startApplication(environment, dataDirectory, { mode: 'start' });
      const request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
      const fixture = await dailyTransportFixture(request);
      const completedStart = await request(`${fixture.path}/daily-transport`, 'POST', {
        expectedRevision: fixture.scenario.revision,
      });
      const complete = await waitDailyTransportTask(
        request,
        fixture.path,
        completedStart.body.task.taskId,
      );
      await makeLongTransportWorkload(request, fixture);
      // Give the long workload demand beyond all finite windows; a real Worker stays busy until killed.
      fixture.scenario = (
        await request(`${fixture.path}/demands`, 'PUT', {
          expectedRevision: fixture.scenario.revision,
          demands: fixture.scenario.context.transportDemands.map((demand) => ({
            ...demand,
            dailyTonnes: 1e9,
          })),
        })
      ).body;
      const roadStart = await request(`${fixture.path}/roads`, 'POST', {
        expectedRevision: fixture.scenario.revision,
      });
      const { waitRoadTask } = await import('./helpers/directed-road-fixture.mjs');
      await waitRoadTask(request, fixture.path, roadStart.body.task.taskId, 'completed');
      const launch = await request(`${fixture.path}/daily-transport`, 'POST', {
        expectedRevision: fixture.scenario.revision,
      });
      const taskPath = `${fixture.path}/daily-transport/${launch.body.task.taskId}`;
      const running = (await request(taskPath)).body;
      assert.equal(running.status, 'running');
      assert.deepEqual(
        (await request(`${fixture.path}/daily-transport`)).body.resultTask,
        complete,
      );
      assert.equal(
        (await request(taskPath)).body.status,
        'running',
        'ordinary reads must not recover live work',
      );
      await run('sqlite3', [
        '-noinit',
        '-readonly',
        join(dataDirectory, 'test.sqlite'),
        `.backup '${backup}'`,
      ]);
      await app.stop('SIGKILL');
      browser = await chromium.launch({
        channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || 'chrome',
        headless: true,
      });
      const page = await browser.newPage();
      for (const restore of [false, true]) {
        const target = restore ? join(directory, 'restored') : dataDirectory;
        if (restore) {
          await app.stop();
          await mkdir(target);
          await copyFile(backup, join(target, 'test.sqlite'));
        }
        app = await startApplication(environment, target, { mode: 'start' });
        const recovered = (await request(taskPath)).body;
        assert.equal(recovered.status, 'interrupted');
        assert.match(recovered.error, /中断/);
        assert.deepEqual(recovered.snapshot, running.snapshot);
        assert.equal(recovered.result, null);
        assert.deepEqual(
          (await request(`${fixture.path}/daily-transport/${complete.taskId}`)).body,
          complete,
        );
        assert.deepEqual(
          (await request(`${fixture.path}/daily-transport`)).body.resultTask,
          complete,
        );
        await page.goto(app.baseUrl);
        const expand = page.getByRole('button', { name: '展开项目与线路', exact: true });
        if (await expand.isVisible()) await expand.click();
        await page.getByRole('button', { name: fixture.project.name, exact: true }).click();
        if (await expand.isVisible()) await expand.click();
        await page.getByRole('button', { name: '规划方案', exact: true }).click();
        await page
          .getByRole('button', { name: `打开规划方案 ${fixture.scenario.name}`, exact: true })
          .click();
        await page.getByRole('button', { name: '每日计划', exact: true }).click();
        await page.getByText(recovered.error, { exact: true }).waitFor();
        assert.equal(
          (await request(taskPath)).body.status,
          'interrupted',
          'opening the page cannot restart work',
        );
        // Explicit retry owns another id, then user may stop it; interrupted history remains immutable.
        const retry = await request(`${fixture.path}/daily-transport`, 'POST', {
          expectedRevision: fixture.scenario.revision,
        });
        assert.equal(retry.status, 202);
        assert.notEqual(retry.body.task.taskId, recovered.taskId);
        await request(`${fixture.path}/daily-transport/${retry.body.task.taskId}/stop`, 'POST');
        assert.equal(
          (await request(`${fixture.path}/daily-transport/${retry.body.task.taskId}`)).body.status,
          'stopped',
        );
        assert.deepEqual((await request(taskPath)).body, recovered);
        await app.stop();
      }
    } catch (error) {
      throw new Error(`${error.message}\n${app?.logs() ?? ''}`, { cause: error });
    } finally {
      await browser?.close();
      await app?.stop();
      upstream.closeAllConnections();
      await new Promise((resolve) => upstream.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
