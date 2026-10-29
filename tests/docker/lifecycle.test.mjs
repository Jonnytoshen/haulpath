import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { createDockerApplication, docker } from './helpers/application.mjs';
import { jsonRequest } from '../helpers/application.mjs';

test('Docker restarts a crashed service, respects an explicit stop and rejects database readiness failures', { timeout: 1200000 }, async () => {
  const app = await createDockerApplication();
  try {
    const project = (await jsonRequest(app.baseUrl, '/api/projects', 'POST', { name: '崩溃重启保留资料' })).body;
    const id = await app.containerId();
    const inspect = async () => JSON.parse((await docker(['inspect', await app.containerId()])).stdout)[0];
    const previous = await inspect();
    assert.equal(previous.HostConfig.RestartPolicy.Name, 'unless-stopped');
    // Kill the service child of Docker init. Docker kill/stop would count as a manual stop.
    const crash = `const {readFileSync}=require('node:fs'); const children=readFileSync('/proc/1/task/1/children','utf8').trim().split(/\\s+/).map(Number).filter(pid=>pid>1&&pid!==process.pid); if(children.length!==1) throw new Error('expected one service child'); process.kill(children[0],'SIGKILL');`;
    await app.exec(['node', '--eval', crash]).catch(() => {});
    let restarted;
    for (let attempt = 0; attempt < 80; attempt++) {
      restarted = await inspect();
      if (restarted.RestartCount > previous.RestartCount && restarted.State.Running) break;
      await setTimeout(250);
    }
    assert.ok(restarted.RestartCount > previous.RestartCount, 'a process crash triggers Docker restart policy');
    assert.equal(await app.containerId(), id);
    await app.waitReady();
    assert.deepEqual((await jsonRequest(app.baseUrl, '/api/projects')).body, [project]);
    await app.stop();
    await setTimeout(1500);
    const stopped = await inspect();
    assert.equal(stopped.State.Running, false);
    assert.equal(stopped.RestartCount, restarted.RestartCount);
    await app.start();
    assert.deepEqual((await jsonRequest(app.baseUrl, '/api/projects')).body, [project]);

    // A test-only override supplies an unwritable database path; production fixes it to the data volume.
    await assert.rejects(app.recreate({ HAULPATH_DB_PATH: '/proc/haulpath-unavailable.sqlite' }), /unhealthy/);
    assert.equal((await inspect()).State.Health.Status, 'unhealthy');
  } finally { await app.cleanup(); }
});
