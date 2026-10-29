import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { createDockerApplication, docker } from './helpers/application.mjs';
import { jsonRequest } from '../helpers/application.mjs';

test('a new non-root Docker instance is healthy without map credentials and serves a complete page', { timeout: 1200000 }, async () => {
  const app = await createDockerApplication();
  try {
    const id = await app.containerId();
    const inspected = JSON.parse((await docker(['inspect', id])).stdout)[0];
    assert.equal(inspected.State.Health.Status, 'healthy');
    assert.deepEqual(inspected.NetworkSettings.Ports['3000/tcp'].map(({ HostIp }) => HostIp), ['127.0.0.1']);
    assert.notEqual((await app.exec(['id', '-u'])).stdout.trim(), '0');
    const created = await jsonRequest(app.baseUrl, '/api/projects', 'POST', { name: '容器首次写入项目' });
    assert.equal(created.status, 201);
    assert.deepEqual((await jsonRequest(app.baseUrl, '/api/projects')).body.map(({ name }) => name), ['容器首次写入项目']);
    const project = created.body;
    const configuration = (await jsonRequest(app.baseUrl, '/api/config')).body;
    assert.equal(configuration.mapKey, '');
    assert.equal(configuration.webServiceConfigured, false);
    const coordinates = await jsonRequest(app.baseUrl, '/api/coordinates', 'POST', { points: [
      { name: '无凭证 GCJ-02 点位', longitude: 121.47, latitude: 31.23, source: 'manual' },
    ] });
    assert.equal(coordinates.status, 200);
    assert.equal(coordinates.body[0].coordinateSystem, 'GCJ-02');
    const library = await jsonRequest(app.baseUrl, `/api/projects/${project.id}/points`, 'POST', { points: coordinates.body });
    assert.equal(library.status, 201);
    const draft = await jsonRequest(app.baseUrl, `/api/projects/${project.id}/routes`, 'POST', { name: '无凭证线路草稿', points: library.body });
    assert.equal(draft.status, 201);
    const exported = await fetch(`${app.baseUrl}/api/projects/${project.id}/export`);
    assert.equal(exported.status, 200);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(Buffer.from(await exported.arrayBuffer()));
    assert.deepEqual(book.worksheets.map(({ name }) => name), ['线路总览', '区间明细']);
    assert.equal(book.getWorksheet('线路总览').getCell('C3').value, '无凭证线路草稿');
    assert.equal(book.getWorksheet('线路总览').getCell('G3').value, null);
    assert.equal(book.getWorksheet('线路总览').getCell('J3').value, '未规划');
    assert.equal(book.getWorksheet('区间明细').rowCount, 2);
    const html = await (await fetch(app.baseUrl)).text();
    const script = html.match(/src="([^\"]*\/_next\/static\/[^\"]+\.js[^\"]*)"/);
    assert.ok(script, 'the application page references a built client script');
    assert.equal((await fetch(new URL(script[1].replaceAll('&amp;', '&'), app.baseUrl))).status, 200);
    const brand = await fetch(`${app.baseUrl}/brand/haulpath-mark.svg`);
    assert.equal(brand.status, 200);
    assert.match(await brand.text(), /<svg/);
    const icon = await fetch(`${app.baseUrl}/icon.svg`);
    assert.equal(icon.status, 200);
    assert.match(await icon.text(), /<svg/);
  } finally {
    await app.cleanup();
  }
});
