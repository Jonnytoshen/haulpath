import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { callerEnvironment } from '../scripts/workspace-environment.mjs';

const root = resolve(import.meta.dirname, '..');

// One isolated dependency clone serves all root-command cases. No user dotenv,
// database, build output, or credentials are copied into this workspace.
test('root commands preserve environment, database, process and uncached execution behavior', { timeout: 300000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'haulpath-workspace-runtime-'));
  let server;
  let output = '';
  let baseUrl;
  const environment = Object.fromEntries(Object.entries(callerEnvironment()).filter(([key]) => !key.startsWith('NX_') && !key.startsWith('AMAP_') && !key.startsWith('HAULPATH_') && key !== 'NODE_ENV' && key !== '__NEXT_PROCESSED_ENV'));
  Object.assign(environment, { NEXT_TELEMETRY_DISABLED: '1', NX_DAEMON: 'false', NX_ISOLATE_PLUGINS: 'false', NX_TUI: 'false', NX_NO_CLOUD: 'true', FORCE_COLOR: '0' });

  async function stop(signal = 'SIGTERM') {
    if (!server) return;
    try {
      if (server.exitCode === null && server.signalCode === null) {
        const exited = new Promise((resolve) => server.once('exit', resolve));
        server.kill(signal);
        const controller = new AbortController();
        try {
          await Promise.race([exited, delay(15000, undefined, { signal: controller.signal }).then(() => { throw new Error(`Root command did not stop:\n${output}`); })]);
        } finally { controller.abort(); }
      }
      await assert.rejects(fetch(`${baseUrl}/api/projects`, { signal: AbortSignal.timeout(1000) }), 'termination must stop the actual service');
    } catch (error) {
      // A broken launcher must fail the assertion without leaving its real
      // service running. Forced cleanup never counts as successful shutdown.
      try {
        if (process.platform !== 'win32') process.kill(-server.pid, 'SIGKILL');
        else server.kill('SIGKILL');
      } catch (cleanupError) {
        if (cleanupError.code !== 'ESRCH') throw new AggregateError([error, cleanupError], 'Root command and forced cleanup failed');
      }
      throw error;
    }
  }

  async function start(mode = 'dev', overrides = {}) {
    const socket = createServer();
    await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
    const port = socket.address().port;
    await new Promise((resolve) => socket.close(resolve));
    baseUrl = `http://127.0.0.1:${port}`;
    output = '';
    server = spawn('pnpm', ['run', mode, '--port', String(port)], { cwd: directory, env: { ...environment, ...overrides }, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
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

  async function project(name) {
    const response = await fetch(`${baseUrl}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    assert.equal(response.status, 201);
    return response.json();
  }

  function run(command, { success = true, overrides = {} } = {}) {
    const result = spawnSync('pnpm', ['run', command], { cwd: directory, env: { ...environment, ...overrides }, encoding: 'utf8', timeout: 120000 });
    assert.ifError(result.error);
    const logs = `${result.stdout}${result.stderr}`;
    assert.equal(result.status === 0, success, logs);
    assert.doesNotMatch(logs, new RegExp(`@haulpath/web:${command}[^\\r\\n]*\\[[^\\r\\n]*cache`, 'i'), logs);
    return logs;
  }

  try {
    for (const file of ['.gitignore', 'package.json', 'nx.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'scripts', 'commitlint.config.mjs', '.husky']) await cp(join(root, file), join(directory, file), { recursive: true });
    for (const path of ['apps/web', 'packages/domain']) {
      await cp(join(root, path), join(directory, path), { recursive: true, filter: (source) => !source.includes('/node_modules') && !source.includes('/.next') && !source.endsWith('.tsbuildinfo') && basename(source) !== '.env' && !basename(source).startsWith('.env.') && !/\.(?:sqlite3?|db)(?:-|$)/.test(basename(source)) });
      await cp(join(root, path, 'node_modules'), join(directory, path, 'node_modules'), { recursive: true, verbatimSymlinks: true });
    }
    await cp(join(root, 'node_modules'), join(directory, 'node_modules'), { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
    await appendFile(join(directory, 'pnpm-workspace.yaml'), '\nverifyDepsBeforeRun: false\n');
    const files = {
      '.env': 'AMAP_JS_KEY=base-file\nAMAP_WEB_SERVICE_KEY=base-web\n',
      '.env.local': 'AMAP_JS_KEY=local-file\nAMAP_WEB_SERVICE_KEY=local-web\n',
      '.env.development': 'AMAP_JS_KEY=development-file\n',
      '.env.development.local': 'AMAP_JS_KEY=development-local\nAMAP_WEB_SERVICE_KEY=\nHAULPATH_DB_FOLDER=runtime-data\nHAULPATH_DB_PATH=$HAULPATH_DB_FOLDER/working.sqlite\n',
      '.env.production': 'AMAP_JS_KEY=production-file\n',
      '.env.production.local': 'HAULPATH_MAP_PREFIX=production\nAMAP_JS_KEY=$HAULPATH_MAP_PREFIX-local\nAMAP_WEB_SERVICE_KEY=\n',
    };
    for (const [name, content] of Object.entries(files)) await writeFile(join(directory, name), content);
    const environmentPage = join(directory, 'apps/web/src/app/workspace-environment');
    await mkdir(environmentPage, { recursive: true });
    await writeFile(join(environmentPage, 'page.tsx'), `export const dynamic = 'force-static';
export default function EnvironmentPage() { return <p>{process.env.AMAP_JS_KEY}</p>; }
`);

    await t.test('dev preserves an explicit value equal to base dotenv, expansion and persisted relative database across SIGTERM restart', async () => {
      assert.deepEqual(await start('dev', { AMAP_JS_KEY: 'base-file' }), { mapKey: 'base-file', securityProxyPath: '/_AMapService', webServiceConfigured: false });
      const saved = await project('根目录持久项目');
      await stop();
      assert.ok((await readFile(join(directory, 'runtime-data/working.sqlite'))).byteLength > 0);
      await assert.rejects(readFile(join(directory, 'apps/web/runtime-data/working.sqlite')));
      assert.equal((await start('dev', { AMAP_JS_KEY: 'base-file' })).mapKey, 'base-file');
      const projects = await (await fetch(`${baseUrl}/api/projects`)).json();
      assert.equal(projects[0].id, saved.id);
      assert.equal(projects[0].name, '根目录持久项目');
      await stop();
    });

    await t.test('dev loads mode-local, local, mode and base files in Next priority order', async () => {
      for (const [key, remove] of [['development-local', '.env.development.local'], ['local-file', '.env.local'], ['development-file', '.env.development'], ['base-file', null]]) {
        assert.equal((await start()).mapKey, key);
        await stop();
        if (remove) await rm(join(directory, remove));
      }
    });

    await t.test('root default database and explicit shell values survive SIGINT restart', async () => {
      assert.deepEqual(await start('dev', { AMAP_JS_KEY: 'shell-key', AMAP_WEB_SERVICE_KEY: '' }), { mapKey: 'shell-key', securityProxyPath: '/_AMapService', webServiceConfigured: false });
      const saved = await project('默认库项目');
      await stop('SIGINT');
      assert.ok((await readFile(join(directory, 'data/haulpath.sqlite'))).byteLength > 0);
      await assert.rejects(readFile(join(directory, 'apps/web/data/haulpath.sqlite')));
      await start();
      assert.ok((await (await fetch(`${baseUrl}/api/projects`)).json()).some((item) => item.id === saved.id));
      await stop();
    });

    await t.test('root web typecheck executes repeatedly and reports new application type errors', async () => {
      run('typecheck');
      run('typecheck');
      const source = join(directory, 'apps/web/src/workspace-typecheck-tracer.ts');
      await writeFile(source, 'export const invalid: number = "invalid";\n');
      assert.match(run('typecheck', { success: false }), /TS2322|not assignable to type 'number'/);
      await rm(source);
    });

    await t.test('root webpack build executes twice and production runtime follows root dotenv and explicit absolute database paths', async () => {
      for (const name of ['.env.local', '.env.production']) await writeFile(join(directory, name), files[name]);
      assert.match(run('build'), /webpack|Creating an optimized production build/);
      assert.match(run('build'), /webpack|Creating an optimized production build/);
      assert.deepEqual(await start('start'), { mapKey: 'production-local', securityProxyPath: '/_AMapService', webServiceConfigured: false });
      const builtPage = await fetch(`${baseUrl}/workspace-environment`);
      assert.equal(builtPage.status, 200);
      assert.match(await builtPage.text(), /production-local/, 'static page must have loaded the root production environment during build');
      const defaultProject = (await (await fetch(`${baseUrl}/api/projects`)).json()).find((item) => item.name === '默认库项目');
      assert.ok(defaultProject, 'production start must reopen the root default database');
      await stop();
      await rm(join(directory, '.env.production.local'));
      assert.equal((await start('start')).mapKey, 'local-file');
      await stop();
      await rm(join(directory, '.env.local'));
      assert.equal((await start('start')).mapKey, 'production-file');
      await stop();
      await rm(join(directory, '.env.production'));
      assert.equal((await start('start')).mapKey, 'base-file');
      await stop();
      const absoluteDatabase = join(directory, 'absolute-data/custom.sqlite');
      assert.equal((await start('start', { AMAP_JS_KEY: 'base-file', HAULPATH_DB_PATH: absoluteDatabase })).mapKey, 'base-file');
      assert.deepEqual(await (await fetch(`${baseUrl}/api/projects`)).json(), []);
      const saved = await project('绝对库项目');
      await stop();
      await start('start', { HAULPATH_DB_PATH: absoluteDatabase });
      assert.equal((await (await fetch(`${baseUrl}/api/projects`)).json())[0].id, saved.id);
      await stop();
      assert.ok((await readFile(absoluteDatabase)).byteLength > 0);
    });
  } finally {
    try { await stop(); } finally { await rm(directory, { recursive: true, force: true }); }
  }
});
