import { test } from 'node:test';
import assert from 'node:assert/strict';
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
    const html = await (await fetch(app.baseUrl)).text();
    const script = html.match(/src="([^\"]*\/_next\/static\/[^\"]+\.js[^\"]*)"/);
    assert.ok(script, 'the application page references a built client script');
    assert.equal((await fetch(new URL(script[1].replaceAll('&amp;', '&'), app.baseUrl))).status, 200);
    const brand = await fetch(`${app.baseUrl}/brand/haulpath-mark.svg`);
    assert.equal(brand.status, 200);
    assert.match(await brand.text(), /<svg/);
  } finally {
    await app.cleanup();
  }
});
