import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDockerApplication, docker } from './helpers/application.mjs';
import { jsonRequest } from '../helpers/application.mjs';

test('manual Compose upgrade preserves an old image and data through a failed build and tag rollback', { timeout: 1200000 }, async () => {
  const app = await createDockerApplication();
  // Aliases exercise deployment image selection, not a database schema migration.
  const oldImage = `${app.projectName}:before-upgrade`;
  const newImage = `${app.projectName}:after-upgrade`;
  const environment = (image) => ({
    ...process.env, HAULPATH_IMAGE: image, HAULPATH_PORT: '0',
    AMAP_WEB_SERVICE_KEY: '', AMAP_JS_KEY: '', AMAP_JS_SECURITY_CODE: '',
  });
  const inspect = async () => JSON.parse((await docker(['inspect', await app.containerId()])).stdout)[0];
  const switchTo = async (image) => {
    await app.stop();
    assert.equal((await inspect()).State.Running, false, 'the old instance stops before another starts');
    await app.compose(['up', '--detach', '--wait', '--wait-timeout', '180', '--no-build', '--force-recreate', 'app'], { env: environment(image) });
    await app.waitReady();
    assert.equal((await inspect()).Config.Image, image);
  };
  try {
    const project = (await jsonRequest(app.baseUrl, '/api/projects', 'POST', { name: '升级回退保留项目' })).body;
    await docker(['image', 'tag', app.image, oldImage]);
    await switchTo(oldImage);
    const old = await inspect();
    const failureFile = join(app.directory, 'failed-build.json');
    await writeFile(failureFile, JSON.stringify({ services: { app: { build: {
      context: app.directory, target: 'runtime',
      dockerfile_inline: 'FROM scratch AS runtime\nRUN ["/haulpath-intentional-build-failure"]\n',
    } } } }));
    await assert.rejects(app.compose(['--file', failureFile, 'build', 'app'], { env: environment(newImage) }), /haulpath-intentional-build-failure/);
    assert.equal(await app.containerId(), old.Id);
    assert.equal((await inspect()).State.Running, true);
    assert.deepEqual((await jsonRequest(app.baseUrl, '/api/projects')).body, [project]);
    assert.equal(JSON.parse((await docker(['image', 'inspect', oldImage])).stdout)[0].Id, old.Image);

    await docker(['image', 'tag', app.image, newImage]);
    await switchTo(newImage);
    const upgraded = await inspect();
    assert.notEqual(upgraded.Id, old.Id);
    assert.deepEqual((await jsonRequest(app.baseUrl, '/api/projects')).body, [project]);
    await switchTo(oldImage);
    const rolledBack = await inspect();
    assert.notEqual(rolledBack.Id, upgraded.Id);
    assert.equal(rolledBack.Image, old.Image);
    assert.deepEqual((await jsonRequest(app.baseUrl, '/api/projects')).body, [project]);
  } finally {
    try { await app.cleanup(); }
    finally { await docker(['image', 'rm', oldImage, newImage]).catch(() => {}); }
  }
});
