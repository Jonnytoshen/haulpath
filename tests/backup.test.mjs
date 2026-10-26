import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rename, copyFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { startApplication, jsonRequest } from './helpers/application.mjs';

const run = promisify(execFile);

test('documented SQLite backup restores projects, library points and a complete route through public HTTP', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'haulpath-restore-'));
  const dataDirectory = join(directory, 'data');
  const archiveDirectory = join(directory, 'before-restore');
  const backupPath = join(directory, 'snapshot.sqlite');
  const upstream = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ status: '1', route: { paths: [{ distance: '1234', steps: [{ polyline: `${url.searchParams.get('origin')};${url.searchParams.get('destination')}` }] }] } }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const environment = { HAULPATH_TEST_MODE: '1', AMAP_API_BASE_URL: `http://127.0.0.1:${upstream.address().port}`, AMAP_WEB_SERVICE_KEY: 'backup-test-key' };
  let app;
  try {
    app = await startApplication(environment, dataDirectory);
    const request = (path, method, body) => jsonRequest(app.baseUrl, path, method, body);
    const project = (await request('/api/projects', 'POST', { name: '已备份项目' })).body;
    const points = (await request('/api/coordinates', 'POST', { points: [
      { name: '上海仓', longitude: 121.47, latitude: 31.23, source: 'manual' },
      { name: '苏州客户', longitude: 120.58, latitude: 31.3, source: 'manual' },
    ] })).body;
    const library = (await request(`/api/projects/${project.id}/points`, 'POST', { points })).body;
    const route = (await request(`/api/projects/${project.id}/routes`, 'POST', { name: '已保存方案', points: library, strategy: 0 })).body;
    const planned = await request(`/api/routes/${route.id}/plan?projectId=${project.id}`, 'POST');
    assert.equal(planned.status, 200);
    assert.equal(planned.body.snapshot.totalDistanceMeters, 1234);
    await access(join(dataDirectory, 'test.sqlite-wal'));
    // The source service remains running. SQLite .backup includes its committed WAL changes.
    await run('sqlite3', ['-noinit', '-readonly', join(dataDirectory, 'test.sqlite'), `.backup '${backupPath}'`]);
    const backupUri = pathToFileURL(backupPath); backupUri.searchParams.set('immutable', '1');
    const { stdout } = await run('sqlite3', ['-noinit', '-readonly', backupUri.href, 'PRAGMA integrity_check;']);
    assert.equal(stdout.trim(), 'ok');
    assert.equal((await request(`/api/routes/${route.id}?projectId=${project.id}`, 'PATCH', { strategy: 43 })).status, 200);
    await request('/api/projects', 'POST', { name: '备份之后的新资料' });
    assert.equal((await request('/api/projects')).body.length, 2);
    await app.stop();
    await rename(dataDirectory, archiveDirectory);
    await mkdir(dataDirectory);
    await copyFile(backupPath, join(dataDirectory, 'restoring.sqlite'));
    await rename(join(dataDirectory, 'restoring.sqlite'), join(dataDirectory, 'test.sqlite'));
    app = await startApplication(environment, dataDirectory);
    const restoredProjects = (await request('/api/projects')).body;
    assert.deepEqual(restoredProjects, [project]);
    assert.deepEqual((await request(`/api/projects/${project.id}/points`)).body, library);
    assert.deepEqual((await request(`/api/routes/${route.id}?projectId=${project.id}`)).body.snapshot, planned.body.snapshot);
    const inherited = await request(`/api/projects/${project.id}/routes`, 'POST', { name: '恢复后继承备份时的偏好' });
    assert.equal(inherited.status, 201);
    assert.equal(inherited.body.strategy, 0);
    await access(join(archiveDirectory, 'test.sqlite'));
  } finally {
    await app?.stop();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
