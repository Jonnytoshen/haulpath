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
import { roadFixture, roadResponse, waitRoadTask } from './helpers/directed-road-fixture.mjs';

const run = promisify(execFile);

test(
  'directed roads survive a killed production process and online backup restore without losing their task snapshot',
  { timeout: 180000 },
  async () => {
    // Kill the actual production process; the dev entry may leave its worker alive after SIGKILL.
    const build = prepareNextCommand('build');
    await run(build.file, build.args, {
      cwd: build.cwd,
      env: { ...build.env, NEXT_TELEMETRY_DISABLED: '1' },
      maxBuffer: 5_000_000,
    });
    const directory = await mkdtemp(join(tmpdir(), 'haulpath-road-recovery-'));
    const dataDirectory = join(directory, 'data');
    const backupPath = join(directory, 'running.sqlite');
    const calls = [];
    let holdReturn = true;
    let entered;
    const returnStarted = new Promise((resolve) => {
      entered = resolve;
    });
    const upstream = createServer((request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      calls.push(url);
      const returning = url.searchParams.get('origin') === '121.600000,31.230000';
      if (holdReturn && returning) {
        entered();
        return;
      }
      roadResponse(url, response, returning ? '2002' : '1001');
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const environment = {
      HAULPATH_TEST_MODE: '1',
      AMAP_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
      AMAP_WEB_SERVICE_KEY: 'road-recovery-test-key',
      AMAP_JS_KEY: '',
      AMAP_JS_SECURITY_CODE: '',
    };
    let app;
    let browser;
    try {
      app = await startApplication(environment, dataDirectory, { mode: 'start' });
      const request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
      const fixture = await roadFixture(request, '道路恢复验收');
      const launched = await request(`${fixture.path}/roads`, 'POST', {
        expectedRevision: fixture.scenario.revision,
      });
      assert.equal(launched.status, 202, JSON.stringify(launched.body));
      const taskId = launched.body.task.taskId;
      await Promise.race([
        returnStarted,
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error('回程请求未到达高德边界')), 10000);
          timer.unref();
        }),
      ]);
      const taskPath = `${fixture.path}/roads/${taskId}`;
      const running = (await request(taskPath)).body;
      assert.equal(running.status, 'running');
      assert.equal(running.completed, 1);
      assert.equal(running.total, 2);
      assert.equal(running.roads.length, 1);
      assert.equal(running.roads[0].distanceMeters, 1001);
      assert.deepEqual(running.snapshot.context, fixture.scenario.context);
      assert.equal(running.snapshot.revision, fixture.scenario.revision);
      const liveView = (await request(`${fixture.path}/roads`)).body;
      assert.equal(liveView.currentReady, false);
      assert.equal(liveView.task.status, 'running');
      assert.equal(
        (await request(taskPath)).body.status,
        'running',
        'normal reads must not recover a live task',
      );
      const copied = await request(`${fixture.path}/copy`, 'POST', {
        expectedRevision: fixture.scenario.revision,
        name: '排队恢复副本',
      });
      assert.equal(copied.status, 201, JSON.stringify(copied.body));
      const copyPath = `/api/projects/${fixture.project.id}/scenarios/${copied.body.id}`;
      const queuedResponse = await request(`${copyPath}/roads`, 'POST', {
        expectedRevision: copied.body.revision,
      });
      assert.equal(queuedResponse.status, 202, JSON.stringify(queuedResponse.body));
      const queuedPath = `${copyPath}/roads/${queuedResponse.body.task.taskId}`;
      const queued = (await request(queuedPath)).body;
      assert.equal(queued.status, 'queued');
      assert.equal(queued.completed, 1);
      assert.equal(calls.length, 2, 'another scenario must wait behind the active road task');
      await run('sqlite3', [
        '-noinit',
        '-readonly',
        join(dataDirectory, 'test.sqlite'),
        `.backup '${backupPath}'`,
      ]);
      await app.stop('SIGKILL');
      upstream.closeAllConnections();
      holdReturn = false;
      browser = await chromium.launch({
        channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || 'chrome',
        headless: true,
      });
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      for (const restore of [false, true]) {
        const targetDirectory = restore ? join(directory, 'restored') : dataDirectory;
        if (restore) {
          await app.stop();
          await mkdir(targetDirectory);
          await copyFile(backupPath, join(targetDirectory, 'test.sqlite'));
        }
        const beforeRequests = calls.length;
        app = await startApplication(environment, targetDirectory, { mode: 'start' });
        const recoveredResponse = await request(taskPath);
        assert.equal(recoveredResponse.status, 200, JSON.stringify(recoveredResponse.body));
        const recovered = recoveredResponse.body;
        assert.equal(
          recovered.status,
          'interrupted',
          restore
            ? 'restored running tasks must be interrupted'
            : 'restarted running tasks must be interrupted',
        );
        assert.match(recovered.error, /中断/);
        assert.equal(recovered.taskId, taskId);
        assert.equal(recovered.projectId, fixture.project.id);
        assert.equal(recovered.scenarioId, fixture.scenario.id);
        assert.equal(recovered.inputVersion, fixture.scenario.inputVersion);
        assert.equal(recovered.completed, 1);
        assert.equal(recovered.total, 2);
        assert.deepEqual(recovered.snapshot, running.snapshot);
        assert.deepEqual(recovered.roads, running.roads);
        assert.ok(recovered.finishedAt);
        const recoveredQueue = (await request(queuedPath)).body;
        assert.equal(recoveredQueue.status, 'interrupted');
        assert.equal(recoveredQueue.taskId, queued.taskId);
        assert.equal(recoveredQueue.startedAt, null);
        assert.equal(recoveredQueue.completed, 1);
        assert.deepEqual(recoveredQueue.snapshot, queued.snapshot);
        assert.deepEqual(recoveredQueue.roads, queued.roads);
        assert.deepEqual((await request(fixture.path)).body, fixture.scenario);
        const view = (await request(`${fixture.path}/roads`)).body;
        assert.equal(view.currentReady, false);
        assert.equal(view.completed, 1);
        assert.equal(view.total, 2);
        assert.equal(view.task.status, 'interrupted');
        await page.goto(app.baseUrl);
        const expand = page.getByRole('button', { name: '展开项目与线路', exact: true });
        if (await expand.isVisible()) await expand.click();
        await page.getByRole('button', { name: fixture.project.name, exact: true }).click();
        if (await expand.isVisible()) await expand.click();
        await page.getByRole('button', { name: '规划方案', exact: true }).click();
        await page
          .getByRole('button', { name: `打开规划方案 ${fixture.scenario.name}`, exact: true })
          .click();
        const region = page.getByRole('region', { name: '方案有向道路资料', exact: true });
        await region.getByText(recovered.error, { exact: true }).waitFor();
        assert.equal(
          await region.getByRole('button', { name: '准备缺失道路', exact: true }).isEnabled(),
          true,
        );
        assert.equal(
          calls.length,
          beforeRequests,
          'reopening a saved task must not issue new road requests',
        );
        const retry = await request(`${fixture.path}/roads`, 'POST', {
          expectedRevision: fixture.scenario.revision,
        });
        assert.equal(retry.status, 202, JSON.stringify(retry.body));
        assert.notEqual(retry.body.task.taskId, taskId);
        const completed = await waitRoadTask(
          request,
          fixture.path,
          retry.body.task.taskId,
          'completed',
        );
        assert.equal(completed.completed, 2);
        assert.equal(completed.reused, 1);
        assert.equal(
          calls.length,
          beforeRequests + 1,
          'retry must request only the missing reverse direction',
        );
        assert.equal(calls.at(-1).searchParams.get('origin'), '121.600000,31.230000');
        const ready = (await request(`${fixture.path}/roads`)).body;
        assert.equal(ready.currentReady, true);
        assert.deepEqual(
          ready.roads.map(({ distanceMeters }) => distanceMeters).sort((a, b) => a - b),
          [1001, 2002],
        );
        assert.deepEqual(
          (await request(taskPath)).body,
          recovered,
          'a new task cannot replace interrupted history',
        );
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
