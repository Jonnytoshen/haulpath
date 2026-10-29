import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout } from 'node:timers/promises';
import { root, docker, createDockerApplication } from './helpers/application.mjs';
import { amapEnvironment, injectAmap } from './helpers/amap.mjs';
import { jsonRequest } from '../helpers/application.mjs';

const run = promisify(execFile);
const command = join(root, 'scripts/docker-data.sh');
const maintain = (app, operation, path) => run(command, ['--env-file', app.environmentFile, '--project-name', app.projectName, operation, path], { cwd: root, timeout: 180000, maxBuffer: 20_000_000 });

test('backup refuses an existing host destination before accessing Docker', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'haulpath-backup-preflight-'));
  const target = join(directory, "保留 '历史' 备份.sqlite");
  try {
    await writeFile(target, 'existing backup');
    await assert.rejects(
      run('sh', [command, 'backup', target], { env: { PATH: '/usr/bin:/bin' } }),
      (error) => error.code !== 0 && /目标已存在/.test(error.stderr),
    );
    assert.equal(await readFile(target, 'utf8'), 'existing backup');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('online backup restores complete data and an interrupted plan as a manual retry through public HTTP', { timeout: 1800000 }, async () => {
  const app = await createDockerApplication({ environment: amapEnvironment });
  let replanning;
  try {
    let upstream = await injectAmap(app);
    const project = (await jsonRequest(app.baseUrl, '/api/projects', 'POST', { name: '在线备份资料' })).body;
    const points = (await jsonRequest(app.baseUrl, '/api/coordinates', 'POST', { points: [
      { name: '上海仓', longitude: 121.47, latitude: 31.23, source: 'manual' },
      { name: '苏州客户', longitude: 120.58, latitude: 31.3, source: 'manual' },
      { name: '南京客户', longitude: 118.79, latitude: 32.06, source: 'manual' },
    ] })).body;
    const library = (await jsonRequest(app.baseUrl, `/api/projects/${project.id}/points`, 'POST', { points })).body;
    const route = (await jsonRequest(app.baseUrl, `/api/projects/${project.id}/routes`, 'POST', { name: '完整方案恢复', points: library, strategy: 43 })).body;
    const routePath = `/api/routes/${route.id}?projectId=${project.id}`;
    const planPath = `/api/routes/${route.id}/plan?projectId=${project.id}`;
    const previous = (await jsonRequest(app.baseUrl, planPath, 'POST')).body.snapshot;
    assert.equal(previous.totalDistanceMeters, 4690);
    await upstream.holdAfter(2);
    replanning = jsonRequest(app.baseUrl, planPath, 'POST').catch(() => {});
    let running;
    for (let attempt = 0; attempt < 60; attempt++) {
      running = (await jsonRequest(app.baseUrl, routePath)).body;
      if (running.planning?.completed === 1 && (await upstream.state()).held === 1) break;
      await setTimeout(100);
    }
    assert.equal(running.planning.status, 'running');
    assert.equal(running.planning.completed, 1);
    assert.deepEqual(running.snapshot, previous);
    const target = join(app.directory, "在线 '完整' 备份.sqlite");
    await maintain(app, 'backup', target);
    assert.equal((await readFile(target)).subarray(0, 16).toString(), 'SQLite format 3\0');
    assert.deepEqual((await jsonRequest(app.baseUrl, '/api/projects')).body, [project]);
    const afterBackup = (await jsonRequest(app.baseUrl, routePath)).body;
    assert.equal(afterBackup.planning.status, 'running', 'online SQLite backup must not recover a live task');
    assert.equal(afterBackup.planning.taskId, running.planning.taskId);
    await jsonRequest(app.baseUrl, `/api/projects/${project.id}/routes`, 'POST', { name: '备份之后的偏好记忆', strategy: 0 });
    await jsonRequest(app.baseUrl, '/api/projects', 'POST', { name: '备份之后的新资料' });
    const restored = await maintain(app, 'restore', target);
    assert.match(restored.stderr, /原资料归档为：\/app\/data\/before-restore-/);
    assert.equal((await docker(['inspect', '--format', '{{.State.Running}}', await app.containerId()])).stdout.trim(), 'false');
    await app.start();
    upstream = await injectAmap(app);
    assert.deepEqual((await jsonRequest(app.baseUrl, '/api/projects')).body, [project]);
    assert.deepEqual((await jsonRequest(app.baseUrl, `/api/projects/${project.id}/points`)).body, library);
    const recovered = (await jsonRequest(app.baseUrl, routePath)).body;
    assert.deepEqual(recovered.snapshot, previous);
    assert.deepEqual(recovered.points, running.points);
    assert.equal(recovered.inputVersion, running.inputVersion);
    assert.equal(recovered.planning.status, 'failed');
    assert.match(recovered.planning.error, /中断.*重新规划/);
    assert.equal(recovered.planning.taskId, running.planning.taskId);
    assert.equal(recovered.planning.completed, 1);
    assert.equal(recovered.planning.total, 2);
    const inherited = (await jsonRequest(app.baseUrl, `/api/projects/${project.id}/routes`, 'POST', { name: '恢复后继承偏好' })).body;
    assert.equal(inherited.strategy, 43);
    assert.equal((await upstream.state()).driving.length, 0, 'restoring and reopening must not recalculate');
    assert.equal((await jsonRequest(app.baseUrl, planPath, 'POST')).body.snapshot.totalDistanceMeters, 4690);
    assert.equal((await upstream.state()).driving.length, 2);
  } finally {
    await app.cleanup();
    await replanning;
  }
});

test('restore rejects an unreadable host input before requiring Docker', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'haulpath-restore-preflight-'));
  try {
    const environmentFile = join(directory, 'docker.env');
    await writeFile(environmentFile, 'AMAP_JS_KEY=\n');
    await assert.rejects(
      run('sh', [command, '--env-file', environmentFile, '--project-name', 'haulpath-input-check', 'restore', join(directory, 'missing.sqlite')], { env: { PATH: '/usr/bin:/bin' } }),
      (error) => error.code !== 0 && /输入不存在或不可读/.test(error.stderr),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('restore rejects empty and damaged backups and keeps the stopped application data intact', { timeout: 1800000 }, async () => {
  const app = await createDockerApplication();
  try {
    const project = (await jsonRequest(app.baseUrl, '/api/projects', 'POST', { name: '不可丢失的原资料' })).body;
    await assert.rejects(maintain(app, 'restore', join(app.directory, 'missing.sqlite')));
    assert.deepEqual((await jsonRequest(app.baseUrl, '/api/projects')).body, [project], 'host preflight must preserve the running service');
    const empty = join(app.directory, 'empty.sqlite');
    await writeFile(empty, '');
    await assert.rejects(maintain(app, 'restore', empty));
    assert.equal((await docker(['inspect', '--format', '{{.State.Running}}', await app.containerId()])).stdout.trim(), 'false');
    await app.start();
    assert.deepEqual((await jsonRequest(app.baseUrl, '/api/projects')).body, [project]);
    const complete = join(app.directory, 'complete.sqlite');
    await maintain(app, 'backup', complete);
    const damaged = join(app.directory, 'damaged.sqlite');
    await writeFile(damaged, (await readFile(complete)).subarray(0, 120));
    await assert.rejects(maintain(app, 'restore', damaged));
    assert.equal((await docker(['inspect', '--format', '{{.State.Running}}', await app.containerId()])).stdout.trim(), 'false');
    await app.start();
    assert.deepEqual((await jsonRequest(app.baseUrl, '/api/projects')).body, [project]);
  } finally {
    await app.cleanup();
  }
});

test('restore protects an occupied volume, archives every old database file and prints a reusable startup command', { timeout: 1800000 }, async () => {
  const app = await createDockerApplication({ restart: 'no' });
  let other;
  try {
    const project = (await jsonRequest(app.baseUrl, '/api/projects', 'POST', { name: '占卷保护资料' })).body;
    const backup = join(app.directory, 'before-other.sqlite');
    await maintain(app, 'backup', backup);
    const volume = (await docker(['inspect', '--format', '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Name}}{{end}}{{end}}', await app.containerId()])).stdout.trim();
    other = (await docker(['run', '--detach', '--rm', '--network', 'none', '--no-healthcheck', '--mount', `type=volume,source=${volume},target=/app/data`, app.image])).stdout.trim();
    await assert.rejects(maintain(app, 'restore', backup), (error) => /数据卷仍被运行容器占用/.test(error.stderr));
    assert.equal((await docker(['inspect', '--format', '{{.State.Running}}', await app.containerId()])).stdout.trim(), 'false');
    assert.equal((await docker(['inspect', '--format', '{{.State.Running}}', other])).stdout.trim(), 'true');
    await docker(['rm', '--force', other]);
    other = undefined;
    await app.start();
    assert.deepEqual((await jsonRequest(app.baseUrl, '/api/projects')).body, [project]);
    const frozenId = await app.containerId();
    await docker(['kill', '--signal', 'KILL', frozenId]);
    const beforeDirectory = join(app.directory, 'before-restore-files');
    await mkdir(beforeDirectory);
    await docker(['cp', `${frozenId}:/app/data/.`, beforeDirectory]);
    const databaseFiles = ['haulpath.sqlite', 'haulpath.sqlite-wal', 'haulpath.sqlite-shm'].sort();
    assert.deepEqual((await readdir(beforeDirectory)).sort(), databaseFiles);
    const beforeFiles = await Promise.all(databaseFiles.map((name) => readFile(join(beforeDirectory, name))));
    const environmentName = "runtime 'config' file.env";
    await writeFile(join(app.directory, environmentName), await readFile(app.environmentFile));
    const restored = await run(command, ['--env-file', environmentName, '--project-name', app.projectName, 'restore', backup], { cwd: app.directory, timeout: 180000, maxBuffer: 20_000_000 });
    const archive = restored.stderr.match(/原资料归档为：(\/app\/data\/before-restore-[^\r\n]+)/)?.[1];
    assert.ok(archive);
    const archivedDirectory = join(app.directory, 'archived-files');
    await mkdir(archivedDirectory);
    await docker(['cp', `${frozenId}:${archive}/.`, archivedDirectory]);
    assert.deepEqual((await readdir(archivedDirectory)).sort(), databaseFiles);
    assert.deepEqual(await Promise.all(databaseFiles.map((name) => readFile(join(archivedDirectory, name)))), beforeFiles);
    const startup = restored.stderr.split(/\r?\n/).find((line) => line.startsWith('docker compose '));
    assert.ok(startup, 'the CLI must print a separately executable startup command');
    await run('sh', ['-c', startup], { cwd: app.directory, timeout: 180000, maxBuffer: 20_000_000 });
    await app.waitReady();
    assert.deepEqual((await jsonRequest(app.baseUrl, '/api/projects')).body, [project]);
  } finally {
    if (other) await docker(['rm', '--force', other]).catch(() => {});
    await app.cleanup();
  }
});

test('backup of an absent source leaves neither an empty source database nor a published host file', { timeout: 1800000 }, async () => {
  const app = await createDockerApplication({ autoStart: false });
  try {
    const backup = join(app.directory, 'missing-source.sqlite');
    await assert.rejects(maintain(app, 'backup', backup));
    await assert.rejects(readFile(backup), { code: 'ENOENT' });
    assert.equal((await readdir(app.directory)).some((name) => name.startsWith('.haulpath-backup.')), false);
    const volume = (await docker(['inspect', '--format', '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Name}}{{end}}{{end}}', await app.containerId()])).stdout.trim();
    const files = (await docker(['run', '--rm', '--network', 'none', '--no-healthcheck', '--mount', `type=volume,source=${volume},target=/app/data`, '--entrypoint', 'node', app.image, '-p', 'JSON.stringify(require("node:fs").readdirSync("/app/data"))'])).stdout;
    assert.deepEqual(JSON.parse(files), []);
  } finally {
    await app.cleanup();
  }
});

test('migration includes committed WAL data without changing its source and rejects a used destination', { timeout: 1800000 }, async () => {
  const source = await createDockerApplication({ restart: 'no' });
  let target;
  try {
    const project = (await jsonRequest(source.baseUrl, '/api/projects', 'POST', { name: 'WAL 中的旧项目' })).body;
    await source.compose(['kill', '--signal', 'SIGKILL', 'app']);
    const sourceDirectory = join(source.directory, "WAL 旧,目录:'副本'");
    await mkdir(sourceDirectory);
    await docker(['cp', `${await source.containerId()}:/app/data/.`, sourceDirectory]);
    const names = (await readdir(sourceDirectory)).sort();
    assert.ok(names.includes('haulpath.sqlite-wal'), 'the frozen source must exercise WAL migration');
    const before = await Promise.all(names.map((name) => readFile(join(sourceDirectory, name))));
    target = await createDockerApplication({ autoStart: false, build: false });
    await docker(['tag', source.image, target.image]);
    const original = join(sourceDirectory, 'haulpath.sqlite');
    await maintain(target, 'migrate', original);
    assert.deepEqual((await readdir(sourceDirectory)).sort(), names);
    assert.deepEqual(await Promise.all(names.map((name) => readFile(join(sourceDirectory, name)))), before);
    await target.start();
    assert.deepEqual((await jsonRequest(target.baseUrl, '/api/projects')).body, [project]);
    const added = (await jsonRequest(target.baseUrl, '/api/projects', 'POST', { name: '迁入后继续写入' })).body;
    await assert.rejects(maintain(target, 'migrate', original), (error) => /数据卷仍被运行容器占用/.test(error.stderr));
    assert.deepEqual((await jsonRequest(target.baseUrl, '/api/projects')).body, [project, added], 'migration must not stop a running destination');
    await target.stop();
    await assert.rejects(maintain(target, 'migrate', original), (error) => /已有数据库|拒绝覆盖/.test(error.stderr));
    await target.start();
    assert.deepEqual((await jsonRequest(target.baseUrl, '/api/projects')).body, [project, added]);
  } finally {
    await target?.cleanup();
    await source.cleanup();
  }
});
