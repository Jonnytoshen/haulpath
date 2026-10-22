import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rename, copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { startApplication, jsonRequest } from './helpers/application.mjs';

const run = promisify(execFile);

test('interrupted planning survives a production restart or online backup restore as a retryable failure', { timeout: 150000 }, async () => {
  // A production process is killed directly: dev launches a worker which SIGKILL would leave alive.
  await run(process.execPath, ['node_modules/next/dist/bin/next', 'build', '--webpack'], { env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' }, maxBuffer: 5_000_000 });
  const directory = await mkdtemp(join(tmpdir(), 'zhongtu-planning-recovery-'));
  const dataDirectory = join(directory, 'data');
  const backupPath = join(directory, 'running.sqlite');
  let hold = false;
  let calls = 0;
  let held;
  const secondLegStarted = new Promise((resolve) => { held = resolve; });
  const upstream = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    calls++;
    if (hold && calls === 4) { held(); return; }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ status: '1', route: { paths: [{ distance: hold ? '7777' : '1234', steps: [{ polyline: `${url.searchParams.get('origin')};${url.searchParams.get('destination')}` }] }] } }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const environment = {
    ZHONGTU_TEST_MODE: '1', AMAP_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
    AMAP_WEB_SERVICE_KEY: 'recovery-test-key', AMAP_JS_KEY: '', AMAP_JS_SECURITY_CODE: '',
  };
  let app;
  let browser;
  try {
    app = await startApplication(environment, dataDirectory, { mode: 'start' });
    const request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
    const project = (await request('/api/projects', 'POST', { name: '中断恢复项目' })).body;
    const points = (await request('/api/coordinates', 'POST', { points: [
      { name: '上海仓', longitude: 121.47, latitude: 31.23, source: 'manual' },
      { name: '苏州客户', longitude: 120.58, latitude: 31.3, source: 'manual' },
      { name: '南京客户', longitude: 118.79, latitude: 32.06, source: 'manual' },
    ] })).body;
    const route = (await request(`/api/projects/${project.id}/routes`, 'POST', { name: '可恢复线路', points })).body;
    const routePath = `/api/routes/${route.id}?projectId=${project.id}`;
    const planPath = `/api/routes/${route.id}/plan?projectId=${project.id}`;
    const previous = (await request(planPath, 'POST')).body.snapshot;
    assert.equal(previous.totalDistanceMeters, 2468);
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1050 } });
    await page.goto(app.baseUrl);
    await page.getByRole('heading', { name: route.name, exact: true }).waitFor();
    hold = true;
    await page.getByRole('button', { name: '重新规划', exact: true }).click();
    await secondLegStarted;
    const running = (await request(routePath)).body;
    assert.equal(running.planning.status, 'running');
    assert.equal(running.planning.completed, 1);
    assert.deepEqual(running.snapshot, previous);
    await page.reload();
    const runningButton = page.getByRole('button', { name: '规划中 1/2', exact: true });
    await runningButton.waitFor();
    assert.equal(await runningButton.isDisabled(), true);
    assert.equal((await request(routePath)).body.planning.taskId, running.planning.taskId);
    await run('sqlite3', ['-noinit', '-readonly', join(dataDirectory, 'test.sqlite'), `.backup '${backupPath}'`]);
    await app.stop('SIGKILL');
    upstream.closeAllConnections();
    hold = false;
    for (const restore of [false, true]) {
      if (restore) {
        await app.stop();
        await rename(dataDirectory, join(directory, 'before-restore'));
        await mkdir(dataDirectory);
        await copyFile(backupPath, join(dataDirectory, 'test.sqlite'));
      }
      const beforeRequests = calls;
      app = await startApplication(environment, dataDirectory, { mode: 'start' });
      const recovered = (await request(routePath)).body;
      assert.equal(recovered.planning.status, 'failed', restore ? 'online backup restore must recover the abandoned task' : 'restart must recover the abandoned task');
      assert.match(recovered.planning.error, /中断.*重新规划/);
      assert.equal(recovered.planning.taskId, running.planning.taskId);
      assert.equal(recovered.planning.completed, 1);
      assert.equal(recovered.planning.total, 2);
      assert.equal(recovered.inputVersion, running.inputVersion);
      assert.deepEqual(recovered.points, running.points);
      assert.deepEqual(recovered.snapshot, previous);
      await page.goto(app.baseUrl);
      const retry = page.getByRole('button', { name: '重新规划', exact: true });
      await retry.waitFor();
      assert.equal(await retry.isEnabled(), true);
      await page.getByText(recovered.planning.error, { exact: true }).waitFor();
      assert.equal(calls, beforeRequests, 'reopening the app must not automatically recalculate');
      await retry.click();
      await page.getByText('路线方案已完整保存', { exact: true }).waitFor();
      const retried = (await request(routePath)).body;
      assert.equal(retried.planning, null);
      assert.equal(retried.snapshot.totalDistanceMeters, 2468);
      assert.equal(calls, beforeRequests + 2);
    }
  } finally {
    await browser?.close();
    await app?.stop();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
