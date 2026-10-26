import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { startApplication, jsonRequest } from './helpers/application.mjs';

test('projects and incomplete route drafts survive a local service restart', async () => {
  let application = await startApplication();
  const directory = application.directory;
  try {
    const created = await jsonRequest(application.baseUrl, '/api/projects', 'POST', { name: '长三角项目' });
    assert.equal(created.status, 201);
    assert.equal(created.body.name, '长三角项目');
    const route = await jsonRequest(application.baseUrl, `/api/projects/${created.body.id}/routes`, 'POST', { name: '上海仓—南京客户', strategy: 0 });
    assert.equal(route.status, 201);
    assert.deepEqual(route.body.points, []);
    assert.equal(route.body.inputVersion, 1);
    await application.stop();
    application = await startApplication({}, directory);
    const recovered = await jsonRequest(application.baseUrl, `/api/routes/${route.body.id}?projectId=${created.body.id}`);
    assert.equal(recovered.status, 200);
    assert.equal(recovered.body.name, '上海仓—南京客户');
    assert.deepEqual(recovered.body.points, []);
    assert.equal(recovered.body.snapshot, null);
    assert.equal(recovered.body.strategy, 0);
    const inherited = await jsonRequest(application.baseUrl, `/api/projects/${created.body.id}/routes`, 'POST', { name: '重启后继承偏好' });
    assert.equal(inherited.body.strategy, 0);
  } finally {
    await application.stop();
    await application.cleanup();
  }
});

test('projects remember explicit route preferences independently through ordinary edits and deletion', async () => {
  const application = await startApplication();
  const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);
  try {
    const project = (await request('/api/projects', 'POST', { name: '偏好记忆项目' })).body;
    const other = (await request('/api/projects', 'POST', { name: '另一偏好项目' })).body;
    const create = async (projectId, input) => {
      const result = await request(`/api/projects/${projectId}/routes`, 'POST', input);
      assert.equal(result.status, 201);
      return result.body;
    };
    const original = await create(project.id, { name: '默认线路' });
    assert.equal(original.strategy, 32);
    const selected = await create(project.id, { name: '显式零策略', strategy: 0 });
    assert.equal(selected.strategy, 0);
    assert.equal((await create(project.id, { name: '继承零策略' })).strategy, 0);
    const otherRoute = await create(other.id, { name: '另一项目的选择', strategy: 34 });
    assert.equal(otherRoute.strategy, 34);
    const selectedPath = `/api/routes/${selected.id}?projectId=${project.id}`;
    const changed = await request(selectedPath, 'PATCH', { strategy: 43, expectedVersion: selected.inputVersion });
    assert.equal(changed.status, 200);
    assert.equal((await create(project.id, { name: '继承组合偏好' })).strategy, 43);
    const originalPath = `/api/routes/${original.id}?projectId=${project.id}`;
    const same = await request(originalPath, 'PATCH', { strategy: 32, expectedVersion: original.inputVersion });
    assert.equal(same.status, 200);
    assert.equal(same.body.inputVersion, original.inputVersion);
    assert.equal((await create(project.id, { name: '同值显式选择后继承' })).strategy, 32);
    await request(selectedPath, 'PATCH', { name: '仅改名' });
    await request(selectedPath, 'PATCH', { points: [] });
    await request(selectedPath);
    await fetch(`${application.baseUrl}/api/projects/${project.id}/export`);
    assert.equal((await create(project.id, { name: '非偏好操作后继承' })).strategy, 32);
    assert.equal((await create(other.id, { name: '另一项目继续继承' })).strategy, 34);
    assert.deepEqual((await request(`/api/projects/${project.id}`)).body, project, 'internal preference memory must not change public project fields');
    await request(selectedPath, 'PATCH', { strategy: 0 });
    assert.equal((await request(selectedPath, 'DELETE')).status, 204);
    assert.equal((await create(project.id, { name: '删除最近选择的线路后继承' })).strategy, 0);
    for (const route of (await request(`/api/projects/${project.id}/routes`)).body) {
      assert.equal((await request(`/api/routes/${route.id}?projectId=${project.id}`, 'DELETE')).status, 204);
    }
    assert.equal((await create(project.id, { name: '删空后创建' })).strategy, 0);
    await request(`/api/projects/${project.id}`, 'DELETE');
    const replacement = (await request('/api/projects', 'POST', { name: '同名新项目' })).body;
    assert.equal((await create(replacement.id, { name: '新项目仍默认推荐' })).strategy, 32);
  } finally { await application.stop(); await application.cleanup(); }
});

test('failed route saves leave project preference memory and saved inputs untouched', async () => {
  const application = await startApplication();
  const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);
  try {
    const project = (await request('/api/projects', 'POST', { name: '原子偏好项目' })).body;
    const other = (await request('/api/projects', 'POST', { name: '归属校验项目' })).body;
    const route = (await request(`/api/projects/${project.id}/routes`, 'POST', { name: '已保存线路', strategy: 43 })).body;
    const path = `/api/routes/${route.id}?projectId=${project.id}`;
    const invalidSaves = [
      [`/api/projects/${project.id}/routes`, 'POST', { name: ' ', strategy: 0 }, 400],
      [`/api/projects/${project.id}/routes`, 'POST', { name: '无效点位', points: [{}], strategy: 0 }, 400],
      [`/api/projects/${project.id}/routes`, 'POST', { name: '无效策略', strategy: '0' }, 400],
      [path, 'PATCH', { name: ' ', strategy: 0 }, 400],
      [path, 'PATCH', { points: [{}], strategy: 0 }, 400],
      [path, 'PATCH', { strategy: null }, 400],
      [path, 'PATCH', { strategy: 0, expectedVersion: route.inputVersion + 1 }, 409],
      [`/api/routes/${route.id}?projectId=${other.id}`, 'PATCH', { strategy: 0 }, 404],
    ];
    for (const [url, method, body, status] of invalidSaves) {
      assert.equal((await request(url, method, body)).status, status);
      assert.deepEqual((await request(path)).body, route);
      const probe = await request(`/api/projects/${project.id}/routes`, 'POST', { name: '失败后继承' });
      assert.equal(probe.status, 201);
      assert.equal(probe.body.strategy, 43, 'failed saves must not change the next route preference');
      await request(`/api/routes/${probe.body.id}?projectId=${project.id}`, 'DELETE');
      assert.equal((await request(`/api/projects/${project.id}/routes`)).body.length, 1);
    }
    const foreignDefault = await request(`/api/projects/${other.id}/routes`, 'POST', { name: '归属错误不改另一项目' });
    assert.equal(foreignDefault.body.strategy, 32);
  } finally { await application.stop(); await application.cleanup(); }
});

test('schema one upgrades preserve existing routes and snapshots and initialize preference memory only once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'haulpath-schema-one-'));
  const database = new Database(join(directory, 'test.sqlite'));
  const time = '2026-10-25T00:00:00.000Z';
  const project = { id: 'old-project', name: '升级前项目', createdAt: time, updatedAt: time };
  const from = { id: 'old-a', name: '上海仓', longitude: 121.47, latitude: 31.23, originalLongitude: 121.47, originalLatitude: 31.23, coordinateSystem: 'GCJ-02', source: 'manual' };
  const to = { ...from, id: 'old-b', name: '南京客户', longitude: 118.79, latitude: 32.06, originalLongitude: 118.79, originalLatitude: 32.06 };
  const snapshot = { inputVersion: 1, points: [from, to], strategy: 36, legs: [{ index: 1, from, to, distanceMeters: 1001, polyline: [[121.47, 31.23], [118.79, 32.06]] }], totalDistanceMeters: 1001, calculatedAt: time };
  const route = { id: 'old-route', projectId: project.id, name: '已有成功线路', points: [from, to], strategy: 36, inputVersion: 1, snapshot, planning: null, createdAt: time, updatedAt: time };
  const interrupted = { ...route, id: 'old-running-route', name: '升级前中断任务', inputVersion: 2, planning: { taskId: 'old-task', inputVersion: 2, status: 'running', completed: 0, total: 1 } };
  // This fixture intentionally represents the released schema, independent of the current migration code.
  database.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE routes (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, payload TEXT NOT NULL);
    CREATE INDEX routes_project ON routes(project_id);
    CREATE TABLE points (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, payload TEXT NOT NULL);
    CREATE INDEX points_project ON points(project_id);
    PRAGMA user_version = 1;`);
  database.prepare('INSERT INTO projects VALUES (?, ?, ?, ?)').run(project.id, project.name, time, time);
  database.prepare('INSERT INTO routes VALUES (?, ?, ?)').run(route.id, project.id, JSON.stringify(route));
  database.prepare('INSERT INTO routes VALUES (?, ?, ?)').run(interrupted.id, project.id, JSON.stringify(interrupted));
  database.close();
  let application;
  try {
    application = await startApplication({}, directory);
    const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);
    assert.deepEqual((await request('/api/projects')).body, [project]);
    assert.deepEqual((await request(`/api/routes/${route.id}?projectId=${project.id}`)).body, route);
    const recovered = (await request(`/api/routes/${interrupted.id}?projectId=${project.id}`)).body;
    assert.equal(recovered.inputVersion, interrupted.inputVersion);
    assert.deepEqual(recovered.points, interrupted.points);
    assert.deepEqual(recovered.snapshot, snapshot);
    assert.equal(recovered.strategy, 36);
    assert.deepEqual({ ...recovered.planning, status: 'running', error: undefined }, { ...interrupted.planning, error: undefined });
    assert.equal(recovered.planning.status, 'failed');
    assert.match(recovered.planning.error, /中断.*重新规划/);
    assert.equal((await request(`/api/projects/${project.id}/routes`, 'POST', { name: '升级后首次创建' })).body.strategy, 32);
    const selected = await request(`/api/projects/${project.id}/routes`, 'POST', { name: '升级后主动选择', strategy: 0 });
    assert.equal(selected.status, 201);
    await application.stop();
    application = await startApplication({}, directory);
    assert.deepEqual((await request(`/api/routes/${route.id}?projectId=${project.id}`)).body, route);
    assert.equal((await request(`/api/projects/${project.id}/routes`, 'POST', { name: '再次启动仍继承' })).body.strategy, 0);
  } finally { await application?.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('a newer database schema is refused without changing its records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'haulpath-future-schema-'));
  const path = join(directory, 'test.sqlite');
  const database = new Database(path);
  database.exec("CREATE TABLE future_data (value TEXT NOT NULL); INSERT INTO future_data VALUES ('preserve-me'); PRAGMA user_version = 3;");
  database.close();
  let application;
  try {
    application = await startApplication({}, directory);
    assert.equal((await jsonRequest(application.baseUrl, '/api/projects')).status, 500);
    assert.match(application.logs(), /数据库版本比当前应用更新/);
    await application.stop();
    const preserved = new Database(path, { readonly: true });
    try {
      assert.equal(preserved.pragma('user_version', { simple: true }), 3);
      assert.deepEqual(preserved.prepare('SELECT value FROM future_data').all(), [{ value: 'preserve-me' }]);
    } finally { preserved.close(); }
  } finally { await application?.stop(); await rm(directory, { recursive: true, force: true }); }
});

test('route editing keeps point order, protects project ownership and rejects stale input', async () => {
  const application = await startApplication();
  const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);
  try {
    const project = (await request('/api/projects', 'POST', { name: '线路项目' })).body;
    const other = (await request('/api/projects', 'POST', { name: '另一项目' })).body;
    const route = (await request(`/api/projects/${project.id}/routes`, 'POST', { name: '往返草稿' })).body;
    const path = `/api/routes/${route.id}?projectId=${project.id}`;
    const renamed = await request(path, 'PATCH', { name: '返程线路', expectedVersion: 1 });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.inputVersion, 1);
    const point = { id: 'a', name: '上海仓', longitude: 121.47, latitude: 31.23, originalLongitude: 121.47, originalLatitude: 31.23, coordinateSystem: 'GCJ-02', source: 'manual' };
    const second = { ...point, id: 'b', name: '南京客户', longitude: 118.79, latitude: 32.06, originalLongitude: 118.79, originalLatitude: 32.06 };
    const updated = await request(path, 'PATCH', { points: [point, second, { ...point, id: 'c' }], strategy: 34, expectedVersion: 1 });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.inputVersion, 2);
    assert.deepEqual(updated.body.points.map((item) => item.name), ['上海仓', '南京客户', '上海仓']);
    assert.equal(updated.body.strategy, 34);
    const stale = await request(path, 'PATCH', { points: [], expectedVersion: 1 });
    assert.equal(stale.status, 409);
    assert.equal((await request(path)).body.points.length, 3);
    assert.equal((await request(`/api/routes/${route.id}?projectId=${other.id}`)).status, 404);
    assert.equal((await request(`/api/routes/${route.id}?projectId=${other.id}`, 'DELETE')).status, 404);
    assert.equal((await request(path, 'PATCH', { strategy: 999 })).status, 400);
    assert.equal((await request(path, 'PATCH', { points: [{ ...point, latitude: 91 }] })).status, 400);
    assert.equal((await request('/api/projects', 'POST', { name: ' ' })).status, 400);
    assert.equal((await request(path, 'DELETE')).status, 204);
    assert.equal((await request(path)).status, 404);
  } finally { await application.stop(); await application.cleanup(); }
});

test('project point libraries remain independent from saved route copies and delete with their project', async () => {
  const application = await startApplication();
  const request = (path, method, body) => jsonRequest(application.baseUrl, path, method, body);
  try {
    const project = (await request('/api/projects', 'POST', { name: '点库项目' })).body;
    const other = (await request('/api/projects', 'POST', { name: '独立项目' })).body;
    const point = { id: 'input-id', name: '上海仓', longitude: 121.47, latitude: 31.23, originalLongitude: 121.47, originalLatitude: 31.23, coordinateSystem: 'GCJ-02', source: 'manual' };
    const added = await request(`/api/projects/${project.id}/points`, 'POST', { points: [point] });
    assert.equal(added.status, 201);
    assert.notEqual(added.body[0].id, 'input-id');
    const libraryPoint = added.body[0];
    const route = (await request(`/api/projects/${project.id}/routes`, 'POST', { name: '单点草稿', points: [libraryPoint] })).body;
    assert.equal(route.points.length, 1);
    assert.equal((await request(`/api/projects/${other.id}/points`)).body.length, 0);
    assert.equal((await request(`/api/projects/${other.id}/points/${libraryPoint.id}`, 'PATCH', { name: '错误项目' })).status, 404);
    assert.equal((await request(`/api/projects/${project.id}/points/${libraryPoint.id}`, 'PATCH', { name: '仓库新名称' })).status, 200);
    const savedRoute = (await request(`/api/routes/${route.id}?projectId=${project.id}`)).body;
    assert.equal(savedRoute.points[0].name, '上海仓');
    assert.equal((await request(`/api/projects/${project.id}/points/${libraryPoint.id}`, 'DELETE')).status, 204);
    assert.equal((await request(`/api/routes/${route.id}?projectId=${project.id}`)).body.points[0].name, '上海仓');
    const duplicateImport = await request(`/api/projects/${project.id}/points`, 'POST', { points: [point, point] });
    assert.equal(duplicateImport.body.length, 2);
    assert.notEqual(duplicateImport.body[0].id, duplicateImport.body[1].id);
    const invalidBatch = await request(`/api/projects/${project.id}/points`, 'POST', { points: [point, { ...point, name: '' }] });
    assert.equal(invalidBatch.status, 400);
    assert.equal((await request(`/api/projects/${project.id}/points`)).body.length, 2);
    const renamed = await request(`/api/projects/${project.id}`, 'PATCH', { name: '项目新名称' });
    assert.equal(renamed.body.name, '项目新名称');
    assert.equal((await request(`/api/projects/${project.id}`, 'DELETE')).status, 204);
    assert.equal((await request(`/api/projects/${project.id}/routes`)).status, 404);
    assert.equal((await request(`/api/projects/${project.id}/points`)).status, 404);
    assert.equal((await request(`/api/routes/${route.id}?projectId=${other.id}`)).status, 404);
    assert.equal((await request('/api/projects')).body.length, 1);
  } finally { await application.stop(); await application.cleanup(); }
});
