import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { callerEnvironment } from '../scripts/workspace-environment.mjs';

const root = resolve(import.meta.dirname, '..');
const cacheReport = /read the output from the cache|\[(?:local|remote) cache\]/i;
const projects = ['haulpath', '@haulpath/domain', '@haulpath/web'];

// Exercise the public command, actual project graph and ESLint together while
// keeping application state, credentials and generated output out of the fixture.
function workspace(t) {
  const directory = mkdtempSync(join(tmpdir(), 'haulpath-workspace-lint-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const file of ['package.json', 'nx.json', 'pnpm-lock.yaml', '.gitignore', 'scripts']) cpSync(join(root, file), join(directory, file), { recursive: true });
  writeFileSync(join(directory, 'pnpm-workspace.yaml'), readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8') + '\nverifyDepsBeforeRun: false\n');
  for (const project of ['', 'apps/web', 'packages/domain']) {
    const destination = join(directory, project);
    mkdirSync(destination, { recursive: true });
    if (project) {
      cpSync(join(root, project, 'package.json'), join(destination, 'package.json'));
      symlinkSync(join(root, project, 'node_modules'), join(destination, 'node_modules'), 'dir');
    }
    cpSync(join(root, project, 'eslint.config.mjs'), join(destination, 'eslint.config.mjs'));
  }
  cpSync(join(root, 'eslint.shared.mjs'), join(directory, 'eslint.shared.mjs'));
  symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
  function write(file, content) {
    mkdirSync(join(directory, file, '..'), { recursive: true });
    writeFileSync(join(directory, file), content);
  }
  write('scripts/lint-tracer.mjs', 'export const rootTracer = 1;\n');
  write('tests/lint-tracer.mjs', 'export const testTracer = 1;\n');
  write('packages/domain/src/lint-tracer.ts', 'export const domainTracer: number = 1;\n');
  write('apps/web/src/app/page.tsx', 'export default function LintTracer() { return <p>Fixture</p>; }\n');
  const environment = Object.fromEntries(Object.entries(callerEnvironment()).filter(([key]) => !key.startsWith('NX_') && !key.startsWith('HAULPATH_') && !key.startsWith('AMAP_') && key !== 'NODE_TEST_CONTEXT'));
  Object.assign(environment, { NX_DAEMON: 'false', NX_ISOLATE_PLUGINS: 'false', NX_TUI: 'false', NX_NO_CLOUD: 'true', FORCE_COLOR: '0' });
  function run(args, { success = true, cached } = {}) {
    const result = spawnSync('pnpm', args, { cwd: directory, env: environment, encoding: 'utf8', timeout: 90000 });
    assert.ifError(result.error);
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.status === 0, success, output);
    if (cached !== undefined) assert.equal(cacheReport.test(output), cached, output);
    return output;
  }
  function lint(project, options = {}) {
    return run(['exec', 'nx', 'run', `${project}:lint`, '--output-style=static'], options);
  }
  return { directory, write, run, lint };
}

test('the public lint command checks all three projects without rewriting their files', { timeout: 120000 }, (t) => {
  const { directory, write, run } = workspace(t);
  const fixtures = {
    'scripts/lint-tracer.mjs': 'export const rootTracer = lintRootMissing;\n',
    'packages/domain/src/lint-tracer.ts': 'export const domainTracer: any = 1;\n',
    'apps/web/src/app/page.tsx': 'export default function LintTracer() { return <img src="/fixture.png" alt="Fixture" />; }\n',
  };
  for (const [file, content] of Object.entries(fixtures)) write(file, content);
  const output = run(['lint', '--skip-nx-cache'], { success: false });
  assert.match(output, /lintRootMissing.*no-undef|no-undef.*lintRootMissing/s);
  assert.match(output, /@typescript-eslint\/no-explicit-any/);
  assert.match(output, /@next\/next\/no-img-element/);
  for (const [file, content] of Object.entries(fixtures)) assert.equal(readFileSync(join(directory, file), 'utf8'), content);
});

test('lint works before type generation and each project only checks its own maintenance code', { timeout: 120000 }, (t) => {
  const { directory, write, run, lint } = workspace(t);
  run(['lint', '--skip-nx-cache']);
  for (const project of projects) lint(project);
  assert.equal(existsSync(join(directory, 'apps/web/.next')), false);
  assert.equal(existsSync(join(directory, 'apps/web/next-env.d.ts')), false);

  write('packages/domain/src/lint-tracer.ts', 'export const domainTracer: any = 1;\n');
  lint('haulpath');
  lint('@haulpath/web');
  assert.match(lint('@haulpath/domain', { success: false }), /@typescript-eslint\/no-explicit-any/);
  write('packages/domain/src/lint-tracer.ts', 'export const domainTracer: number = 1;\n');

  write('maintenance.config.mjs', 'export const maintenanceTracer = missingConfigurationValue;\n');
  assert.match(lint('haulpath', { success: false }), /missingConfigurationValue/);
  lint('@haulpath/domain');
  lint('@haulpath/web');
});

test('warning-only diagnostics fail both the public command and every independent lint task', { timeout: 120000 }, (t) => {
  const { directory, write, run, lint } = workspace(t);
  // A real warning-level rule exercises the CLI threshold even for presets
  // whose built-in recommended diagnostics are all errors.
  for (const project of ['', 'packages/domain', 'apps/web']) {
    const config = join(project, 'eslint.config.mjs');
    cpSync(join(directory, config), join(directory, project, 'eslint.baseline.mjs'));
    write(config, "import baseline from './eslint.baseline.mjs';\nconst config = [...baseline, { rules: { 'no-console': 'warn' } }];\nexport default config;\n");
  }
  write('scripts/lint-tracer.mjs', "console.log('Root warning');\n");
  write('packages/domain/src/lint-tracer.ts', "console.log('Domain warning');\n");
  write('apps/web/src/lint-tracer.ts', "console.log('Web warning');\n");
  for (const project of projects) {
    const output = lint(project, { success: false });
    assert.match(output, /no-console/);
    assert.match(output, /ESLint found too many warnings/);
  }
  assert.match(run(['lint', '--skip-nx-cache'], { success: false }), /ESLint found too many warnings/);
});

test('lint ignores generated and local material while still checking maintained tests', { timeout: 120000 }, (t) => {
  const { write, run } = workspace(t);
  for (const project of ['', 'apps/web', 'packages/domain']) {
    for (const output of ['.next', 'dist', 'out', 'coverage', 'test-results', '.scratch', 'data', 'backups']) {
      write(join(project, output, 'invalid.ts'), 'This is deliberately invalid TypeScript !!\n');
    }
    write(join(project, 'next-env.d.ts'), 'This generated declaration is deliberately invalid !!\n');
  }
  write('scripts/.scratch/invalid.mjs', 'This local script is deliberately invalid !!\n');
  run(['lint', '--skip-nx-cache']);
  write('tests/lint-tracer.mjs', 'export const testTracer = missingTestValue;\n');
  assert.match(run(['lint', '--skip-nx-cache'], { success: false }), /missingTestValue/);
});

test('lint caches identical inputs and invalidates source, shared rules, project configuration and dependency changes', { timeout: 180000 }, (t) => {
  const { directory, write, lint } = workspace(t);
  lint('@haulpath/domain', { cached: false });
  lint('@haulpath/domain', { cached: true });
  const inputs = [
    ['packages/domain/src/lint-tracer.ts', (value) => value + '\nexport const anotherTracer = 2;\n'],
    ['eslint.config.mjs', (value) => value + '\n// Root lint configuration changed.\n'],
    ['eslint.shared.mjs', (value) => value + '\n// Shared lint rules changed.\n'],
    ['packages/domain/eslint.config.mjs', (value) => value + '\n// Domain lint configuration changed.\n'],
    ['packages/domain/package.json', (value) => JSON.stringify({ ...JSON.parse(value), description: 'Domain lint dependency change' }, null, 2)],
    ['package.json', (value) => JSON.stringify({ ...JSON.parse(value), description: 'Root lint dependency change' }, null, 2)],
    ['pnpm-lock.yaml', (value) => value + '\n# Full lockfile changed.\n'],
  ];
  for (const [file, change] of inputs) {
    const original = readFileSync(join(directory, file), 'utf8');
    write(file, change(original));
    lint('@haulpath/domain', { cached: false });
    lint('@haulpath/domain', { cached: true });
    write(file, original);
    lint('@haulpath/domain', { cached: true });
  }
  write('packages/domain/src/lint-tracer.ts', 'export const domainTracer: any = 1;\n');
  assert.match(lint('@haulpath/domain', { cached: false, success: false }), /@typescript-eslint\/no-explicit-any/);
});

test('explicit repair executes again for identical broken input and still rejects unfixable problems', { timeout: 120000 }, (t) => {
  const { directory, write, run } = workspace(t);
  const fixtures = [
    ['scripts/lint-tracer.mjs',
      'export function rootTracer(flag) { if (!!flag) return 1; return 0; }\n',
      'export function rootTracer(flag) { if (flag) return 1; return 0; }\n'],
    ['packages/domain/src/lint-tracer.ts',
      'export function domainTracer(flag: boolean) { if (!!flag) return 1; return 0; }\n',
      'export function domainTracer(flag: boolean) { if (flag) return 1; return 0; }\n'],
    ['apps/web/src/app/page.tsx',
      'export default function LintTracer({ flag }: { flag: boolean }) { if (!!flag) return <p>Fixture</p>; return null; }\n',
      'export default function LintTracer({ flag }: { flag: boolean }) { if (flag) return <p>Fixture</p>; return null; }\n'],
  ];
  for (let invocation = 1; invocation <= 2; invocation++) {
    for (const [file, broken] of fixtures) write(file, broken);
    const output = run(['lint:fix']);
    assert.doesNotMatch(output, cacheReport);
    for (const [file, , repaired] of fixtures) assert.equal(readFileSync(join(directory, file), 'utf8'), repaired);
    run(['lint']);
  }
  write('scripts/lint-tracer.mjs', 'export const rootTracer = missingUnfixableValue;\n');
  assert.match(run(['lint:fix'], { success: false }), /missingUnfixableValue/);
  assert.equal(readFileSync(join(directory, 'scripts/lint-tracer.mjs'), 'utf8'), 'export const rootTracer = missingUnfixableValue;\n');
});
