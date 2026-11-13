import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { startApplication, jsonRequest } from './helpers/application.mjs';

test('scenario drafts preserve their project and input context through restart', async () => {
  let application = await startApplication();
  const directory = application.directory;
  const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);
  try {
    const project = (await request('/api/projects', 'POST', { name: '换电规划项目' })).body;
    const collection = `/api/projects/${project.id}/scenarios`;
    const response = await fetch(`${application.baseUrl}${collection}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '港区站网草案' }),
    });
    assert.equal(response.status, 201);
    const created = { status: response.status, body: await response.json() };
    assert.equal(created.status, 201);
    assert.equal(created.body.projectId, project.id);
    assert.equal(created.body.name, '港区站网草案');
    assert.equal(created.body.status, 'draft');
    assert.equal(created.body.inputVersion, 1);
    assert.equal(created.body.revision, 1);
    assert.deepEqual(created.body.context, {
      schemaVersion: 1,
      resources: {},
      annual: [],
      results: [],
    });
    assert.deepEqual((await request(collection)).body, [created.body]);
    await application.stop();
    const fresh = new Database(join(directory, 'test.sqlite'), { readonly: true });
    try {
      assert.equal(fresh.pragma('user_version', { simple: true }), 7);
    } finally {
      fresh.close();
    }
    application = await startApplication({}, directory);
    assert.deepEqual((await request(`${collection}/${created.body.id}`)).body, created.body);
  } finally {
    await application.stop();
    await application.cleanup();
  }
});

test('scenario saves check revisions, preserve extensible inputs and reject partial or foreign writes', async () => {
  const application = await startApplication();
  const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);
  try {
    const project = (await request('/api/projects', 'POST', { name: '方案归属项目' })).body;
    const other = (await request('/api/projects', 'POST', { name: '另一方案项目' })).body;
    const collection = `/api/projects/${project.id}/scenarios`;
    assert.equal((await request(collection, 'POST', { name: ' ', inputVersion: 99 })).status, 400);
    assert.deepEqual((await request(collection)).body, []);
    const original = (await request(collection, 'POST', { name: '原草案' })).body;
    const path = `${collection}/${original.id}`;
    const context = {
      schemaVersion: 1,
      resources: { notes: { source: '现场资料', tags: ['待核对', null], confirmed: false } },
      annual: [{ year: 2030, assumptions: { note: '尚未测算' } }],
      results: [],
    };
    const saved = await request(path, 'PATCH', {
      name: '已补充资料',
      context,
      expectedRevision: original.revision,
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.inputVersion, 2);
    assert.equal(saved.body.revision, 2);
    assert.deepEqual(saved.body.context, context);
    const renamed = await request(path, 'PATCH', { name: '仅改名', expectedRevision: 2 });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.inputVersion, 2);
    assert.equal(renamed.body.revision, 3);
    assert.deepEqual(renamed.body.context, context);
    const invalid = [
      [{ name: '缺少并发版本' }, 400],
      [{ name: '错误类型', expectedRevision: '3' }, 400],
      [{ name: '非整数', expectedRevision: 1.5 }, 400],
      [{ name: '不安全整数', expectedRevision: 9007199254740992 }, 400],
      [{ name: '迟到编辑', expectedRevision: 2 }, 409],
      [{ name: ' ', expectedRevision: 3 }, 400],
      [{ name: '半成品', context: { ...context, schemaVersion: 2 }, expectedRevision: 3 }, 400],
      [{ name: '半成品', context: { ...context, resources: [] }, expectedRevision: 3 }, 400],
      [{ name: '半成品', context: { ...context, annual: [null] }, expectedRevision: 3 }, 400],
      [{ name: '半成品', context: { ...context, results: {} }, expectedRevision: 3 }, 400],
      [{ name: '越权覆盖', projectId: other.id, expectedRevision: 3 }, 400],
      [{ name: '越权覆盖', inputVersion: 99, expectedRevision: 3 }, 400],
      [{ name: '越权覆盖', status: 'frozen', expectedRevision: 3 }, 400],
    ];
    for (const [body, expectedStatus] of invalid) {
      assert.equal((await request(path, 'PATCH', body)).status, expectedStatus);
      assert.deepEqual((await request(path)).body, renamed.body);
    }
    const foreign = `/api/projects/${other.id}/scenarios/${original.id}`;
    assert.equal((await request(foreign)).status, 404);
    assert.equal(
      (await request(foreign, 'PATCH', { name: '跨项目', expectedRevision: 3 })).status,
      404,
    );
    assert.equal((await request(`${foreign}?expectedRevision=3`, 'DELETE')).status, 404);
    assert.deepEqual((await request(`/api/projects/${other.id}/scenarios`)).body, []);
    assert.equal((await request(path, 'DELETE')).status, 400);
    assert.equal((await request(`${path}?expectedRevision=2`, 'DELETE')).status, 409);
    assert.deepEqual((await request(path)).body, renamed.body);
    const concurrent = await Promise.all([
      request(path, 'PATCH', { name: '并发甲', expectedRevision: 3 }),
      request(path, 'PATCH', { name: '并发乙', expectedRevision: 3 }),
    ]);
    assert.deepEqual(concurrent.map((result) => result.status).sort(), [200, 409]);
    const winner = concurrent.find((result) => result.status === 200).body;
    assert.equal(winner.revision, 4);
    assert.deepEqual((await request(path)).body, winner);
    assert.equal((await request(`${path}?expectedRevision=4`, 'DELETE')).status, 204);
    assert.equal((await request(path)).status, 404);
    assert.deepEqual((await request(collection)).body, []);
    const cascade = (await request(collection, 'POST', { name: '随项目删除' })).body;
    await request(`/api/projects/${project.id}`, 'DELETE');
    assert.equal((await request(`${collection}/${cascade.id}`)).status, 404);
  } finally {
    await application.stop();
    await application.cleanup();
  }
});

test('schema two upgrades preserve routes, point library and remembered preferences while adding scenario storage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'haulpath-schema-two-'));
  const databasePath = join(directory, 'test.sqlite');
  const database = new Database(databasePath);
  const time = '2026-11-01T00:00:00.000Z';
  const project = {
    id: 'schema-two-project',
    name: '已有资料项目',
    createdAt: time,
    updatedAt: time,
  };
  const point = {
    id: 'existing-point',
    name: '港区',
    longitude: 121.47,
    latitude: 31.23,
    originalLongitude: 121.47,
    originalLatitude: 31.23,
    coordinateSystem: 'GCJ-02',
    source: 'manual',
  };
  const route = {
    id: 'existing-route',
    projectId: project.id,
    name: '待完善线路',
    points: [point],
    strategy: 0,
    inputVersion: 7,
    snapshot: null,
    planning: null,
    createdAt: time,
    updatedAt: time,
  };
  // Literal released schema two fixture, independent of current migration implementation.
  database.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_strategy INTEGER NOT NULL DEFAULT 32);
    CREATE TABLE routes (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, payload TEXT NOT NULL);
    CREATE INDEX routes_project ON routes(project_id);
    CREATE TABLE points (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, payload TEXT NOT NULL);
    CREATE INDEX points_project ON points(project_id);
    PRAGMA user_version = 2;`);
  database
    .prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?)')
    .run(project.id, project.name, time, time, 43);
  database
    .prepare('INSERT INTO routes VALUES (?, ?, ?)')
    .run(route.id, project.id, JSON.stringify(route));
  database
    .prepare('INSERT INTO points VALUES (?, ?, ?)')
    .run(point.id, project.id, JSON.stringify(point));
  database.close();
  let application;
  try {
    application = await startApplication({}, directory);
    const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);
    assert.deepEqual((await request('/api/projects')).body, [project]);
    assert.deepEqual(
      (await request(`/api/routes/${route.id}?projectId=${project.id}`)).body,
      route,
    );
    assert.deepEqual((await request(`/api/projects/${project.id}/points`)).body, [point]);
    const created = await request(`/api/projects/${project.id}/scenarios`, 'POST', {
      name: '升级后的草案',
    });
    assert.equal(created.status, 201);
    assert.equal(
      (await request(`/api/projects/${project.id}/routes`, 'POST', { name: '继承偏好' })).body
        .strategy,
      43,
    );
    await application.stop();
    const migrated = new Database(databasePath, { readonly: true });
    try {
      assert.equal(migrated.pragma('user_version', { simple: true }), 7);
    } finally {
      migrated.close();
    }
    application = await startApplication({}, directory);
    assert.deepEqual(
      (await request(`/api/projects/${project.id}/scenarios/${created.body.id}`)).body,
      created.body,
    );
    assert.deepEqual(
      (await request(`/api/routes/${route.id}?projectId=${project.id}`)).body,
      route,
    );
  } finally {
    await application?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
