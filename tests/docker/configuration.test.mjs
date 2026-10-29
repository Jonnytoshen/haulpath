import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);

test('Compose keeps a personal instance on host loopback with a persistent data directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'haulpath-compose-config-'));
  const environmentFile = join(directory, 'docker.env');
  await writeFile(environmentFile, 'HAULPATH_PORT=32109\nAMAP_WEB_SERVICE_KEY=\nAMAP_JS_KEY=\nAMAP_JS_SECURITY_CODE=\n');
  try {
    const environment = { ...process.env, HAULPATH_PORT: '32109', AMAP_WEB_SERVICE_KEY: '', AMAP_JS_KEY: '', AMAP_JS_SECURITY_CODE: '' };
    delete environment.COMPOSE_PROJECT_NAME;
    const { stdout } = await run('docker', ['compose', '--file', 'compose.yaml', '--env-file', environmentFile, 'config', '--format', 'json'], {
      env: environment,
    });
    const configuration = JSON.parse(stdout);
    const app = configuration.services.app;
    assert.equal(configuration.name, 'haulpath');
    assert.equal(app.restart, 'unless-stopped');
    assert.equal(app.init, true);
    assert.deepEqual(app.ports.map(({ host_ip, published, target }) => ({ host_ip, published, target })), [
      { host_ip: '127.0.0.1', published: '32109', target: 3000 },
    ]);
    assert.equal(app.environment.HOSTNAME, '0.0.0.0');
    assert.equal(app.environment.HAULPATH_DB_PATH, '/app/data/haulpath.sqlite');
    assert.deepEqual(app.volumes.map(({ type, source, target }) => ({ type, source, target })), [
      { type: 'volume', source: 'data', target: '/app/data' },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
