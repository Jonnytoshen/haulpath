import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { callerEnvironment } from '../scripts/workspace-environment.mjs';

const root = resolve(import.meta.dirname, '..');
const cacheReport = /read the output from the cache|\[(?:local|remote) cache\]/i;

function testEnvironment(overrides = {}) {
  const environment = Object.fromEntries(Object.entries(callerEnvironment()).filter(([key]) => !key.startsWith('NX_') && !key.startsWith('HAULPATH_') && !key.startsWith('AMAP_') && key !== 'NODE_TEST_CONTEXT'));
  return Object.assign(environment, { NX_DAEMON: 'false', NX_ISOLATE_PLUGINS: 'false', NX_TUI: 'false', NX_NO_CLOUD: 'true', FORCE_COLOR: '0' }, overrides);
}

// Keep the CLI, project graph and compiler real. This fixture needs no app
// process, user environment files, database, or separate dependency installation.
function workspace(t) {
  const directory = mkdtempSync(join(tmpdir(), 'haulpath-workspace-cache-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const file of ['.gitignore', 'package.json', 'nx.json', 'pnpm-lock.yaml', 'tsconfig.base.json']) cpSync(join(root, file), join(directory, file));
  writeFileSync(join(directory, 'pnpm-workspace.yaml'), readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8') + '\nverifyDepsBeforeRun: false\n');
  cpSync(join(root, 'packages/domain'), join(directory, 'packages/domain'), { recursive: true, filter: (source) => !source.includes('/node_modules') });
  cpSync(join(root, 'apps/web/package.json'), join(directory, 'apps/web/package.json'), { recursive: true });
  symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
  const environment = testEnvironment({ NX_LOAD_DOT_ENV_FILES: 'false' });
  function check({ cached = false, success = true } = {}) {
    const result = spawnSync('pnpm', ['exec', 'nx', 'run', '@haulpath/domain:typecheck', '--output-style=static'], { cwd: directory, env: environment, encoding: 'utf8', timeout: 60000 });
    assert.ifError(result.error);
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.status === 0, success, output);
    assert.equal(cacheReport.test(output), cached, output);
    return output;
  }
  return { directory, check };
}

test('domain typecheck reuses identical inputs and invalidates source, check configuration, manifest and lockfile changes', { timeout: 120000 }, (t) => {
  const { directory, check } = workspace(t);
  check();
  check({ cached: true });

  const inputs = [
    ['packages/domain/src/index.ts', (value) => value + '\nexport const workspaceCacheTracer: number = 1;\n'],
    ['packages/domain/tsconfig.json', (value) => value.replace('"compilerOptions": {', '"compilerOptions": {\n    "noUnusedLocals": true,')],
    ['tsconfig.base.json', (value) => value.replace('"strict": true', '"strict": true, "noImplicitReturns": true')],
    ['packages/domain/package.json', (value) => JSON.stringify({ ...JSON.parse(value), description: 'Workspace cache regression' }, null, 2)],
    ['pnpm-lock.yaml', (value) => value + '\n# workspace cache regression\n'],
  ];
  for (const [file, change] of inputs) {
    const path = join(directory, file);
    const original = readFileSync(path, 'utf8');
    writeFileSync(path, change(original));
    check();
    check({ cached: true });
    writeFileSync(path, original);
  }

  const source = join(directory, 'packages/domain/src/index.ts');
  const original = readFileSync(source, 'utf8');
  writeFileSync(source, original + '\nexport const invalidCacheTracer: number = "invalid";\n');
  assert.match(check({ success: false }), /TS2322|not assignable to type 'number'/);
  writeFileSync(source, original);
  check({ cached: true });
});

test('the public commit-test command executes again with identical tracked inputs', { timeout: 30000 }, (t) => {
  const { directory } = workspace(t);
  for (const file of ['scripts', 'commitlint.config.mjs', '.husky', 'tests/commits.test.mjs']) cpSync(join(root, file), join(directory, file), { recursive: true });
  const observations = mkdtempSync(join(tmpdir(), 'haulpath-workspace-test-execution-'));
  t.after(() => rmSync(observations, { recursive: true, force: true }));
  const marker = join(observations, 'runs.txt');
  // The marker is outside all task inputs: writing it cannot itself force a
  // cache miss. The existing test suite and public task command remain real.
  const suite = join(directory, 'tests/commits.test.mjs');
  writeFileSync(suite, readFileSync(suite, 'utf8') + `\n(await import('node:fs')).appendFileSync(${JSON.stringify(marker)}, 'executed\\n');\n`);
  const environment = testEnvironment({ NODE_OPTIONS: '--test-name-pattern=the.*public.*command.*accepts' });
  for (let invocation = 1; invocation <= 2; invocation++) {
    const result = spawnSync('pnpm', ['run', 'test:commits'], { cwd: directory, env: environment, encoding: 'utf8', timeout: 60000 });
    assert.ifError(result.error);
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 0, output);
    assert.doesNotMatch(output, cacheReport, output);
    assert.ok(existsSync(marker), output);
    assert.equal(readFileSync(marker, 'utf8'), 'executed\n'.repeat(invocation));
  }
});
