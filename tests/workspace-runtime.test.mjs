import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '..');

test('root dev preserves explicit same-value environment, root dotenv expansion and root database across restart and termination', { timeout: 120000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'haulpath-workspace-runtime-'));
  let server;
  let output = '';
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NX_') && !key.startsWith('AMAP_') && !key.startsWith('HAULPATH_') && key !== 'NODE_ENV' && key !== '__NEXT_PROCESSED_ENV'));
  async function stop() {
    if (!server || server.exitCode !== null || server.signalCode !== null) return;
    const exited = new Promise((resolve) => server.once('exit', resolve));
    server.kill('SIGTERM');
    const controller = new AbortController();
    try {
      await Promise.race([exited, delay(15000, undefined, { signal: controller.signal }).then(() => { throw new Error(`Root command did not stop:\n${output}`); })]);
    } finally { controller.abort(); }
  }
  try {
    for (const file of ['package.json', 'nx.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'scripts']) await cp(join(root, file), join(directory, file), { recursive: true });
    for (const path of ['apps/web', 'packages/domain']) {
      await cp(join(root, path), join(directory, path), { recursive: true, filter: (source) => !source.includes('/node_modules') && !source.includes('/.next') && !source.endsWith('.tsbuildinfo') && basename(source) !== '.env' && !basename(source).startsWith('.env.') && !/\.(?:sqlite3?|db)(?:-|$)/.test(basename(source)) });
      await cp(join(root, path, 'node_modules'), join(directory, path, 'node_modules'), { recursive: true, verbatimSymlinks: true });
    }
    await cp(join(root, 'node_modules'), join(directory, 'node_modules'), { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
    await writeFile(join(directory, 'pnpm-workspace.yaml'), (await readFile(join(directory, 'pnpm-workspace.yaml'), 'utf8')) + '\nverifyDepsBeforeRun: false\n');
    await writeFile(join(directory, '.env'), 'AMAP_JS_KEY=base-file\nHAULPATH_DB_PATH=data/haulpath.sqlite\n');
    await writeFile(join(directory, '.env.local'), 'AMAP_JS_KEY=local-file\nAMAP_WEB_SERVICE_KEY=local-web\n');
    await writeFile(join(directory, '.env.development.local'), 'AMAP_JS_KEY=development-file\nAMAP_WEB_SERVICE_KEY=\nHAULPATH_DB_FOLDER=runtime-data\nHAULPATH_DB_PATH=$HAULPATH_DB_FOLDER/working.sqlite\n');
    let baseUrl;
    async function start() {
      const socket = createServer();
      await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
      const port = socket.address().port;
      await new Promise((resolve) => socket.close(resolve));
      baseUrl = `http://127.0.0.1:${port}`;
      output = '';
      server = spawn('pnpm', ['run', 'dev', '--port', String(port)], { cwd: directory, env: { ...environment, AMAP_JS_KEY: 'base-file', NEXT_TELEMETRY_DISABLED: '1', NX_DAEMON: 'false', NX_ISOLATE_PLUGINS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
      server.stdout.on('data', (chunk) => { output += chunk; });
      server.stderr.on('data', (chunk) => { output += chunk; });
      for (let attempt = 0; attempt < 180; attempt++) {
        assert.equal(server.exitCode, null, output);
        try {
          const response = await fetch(`${baseUrl}/api/config`, { signal: AbortSignal.timeout(1000) });
          if (response.ok) return response.json();
        } catch {}
        await delay(250);
      }
      throw new Error(`Root command did not become ready:\n${output}`);
    }
    assert.deepEqual(await start(), { mapKey: 'base-file', securityProxyPath: '/_AMapService', webServiceConfigured: false });
    const project = await (await fetch(`${baseUrl}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '根目录持久项目' }) })).json();
    await stop();
    await assert.rejects(fetch(`${baseUrl}/api/projects`, { signal: AbortSignal.timeout(1000) }), 'termination must stop the actual service');
    const expectedDatabase = await readFile(join(directory, 'runtime-data/working.sqlite'));
    assert.ok(expectedDatabase.byteLength > 0);
    await assert.rejects(readFile(join(directory, 'apps/web/data/haulpath.sqlite')));
    assert.equal((await start()).mapKey, 'base-file');
    const projects = await (await fetch(`${baseUrl}/api/projects`)).json();
    assert.equal(projects[0].id, project.id);
    assert.equal(projects[0].name, '根目录持久项目');
  } finally {
    await stop();
    await rm(directory, { recursive: true, force: true });
  }
});
