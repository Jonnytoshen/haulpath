import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApplication, jsonRequest } from './helpers/application.mjs';

test('projects and incomplete route drafts survive a local service restart', async () => {
  let application = await startApplication();
  const directory = application.directory;
  try {
    const created = await jsonRequest(application.baseUrl, '/api/projects', 'POST', { name: '长三角项目' });
    assert.equal(created.status, 201);
    assert.equal(created.body.name, '长三角项目');
    const route = await jsonRequest(application.baseUrl, `/api/projects/${created.body.id}/routes`, 'POST', { name: '上海仓—南京客户' });
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
  } finally {
    await application.stop();
    await application.cleanup();
  }
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
