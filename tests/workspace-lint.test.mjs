import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { callerEnvironment } from '../scripts/workspace-environment.mjs';

const root = resolve(import.meta.dirname, '..');

// Exercise the public command, actual project graph and ESLint together while
// keeping application state, credentials and generated output out of the fixture.
test('the public lint command checks all three projects without rewriting their files', { timeout: 120000 }, (t) => {
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
  const fixtures = {
    'scripts/lint-tracer.mjs': 'export const rootTracer = lintRootMissing;\n',
    'packages/domain/src/lint-tracer.ts': 'export const domainTracer: any = 1;\n',
    'apps/web/src/app/page.tsx': 'export default function LintTracer() { return <img src="/fixture.png" alt="Fixture" />; }\n',
  };
  for (const [file, content] of Object.entries(fixtures)) {
    mkdirSync(join(directory, file, '..'), { recursive: true });
    writeFileSync(join(directory, file), content);
  }
  const environment = Object.fromEntries(Object.entries(callerEnvironment()).filter(([key]) => !key.startsWith('NX_') && !key.startsWith('HAULPATH_') && !key.startsWith('AMAP_') && key !== 'NODE_TEST_CONTEXT'));
  Object.assign(environment, { NX_DAEMON: 'false', NX_ISOLATE_PLUGINS: 'false', NX_TUI: 'false', NX_NO_CLOUD: 'true', FORCE_COLOR: '0' });
  const result = spawnSync('pnpm', ['lint', '--skip-nx-cache'], { cwd: directory, env: environment, encoding: 'utf8', timeout: 90000 });
  assert.ifError(result.error);
  const output = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0, output);
  assert.match(output, /lintRootMissing.*no-undef|no-undef.*lintRootMissing/s);
  assert.match(output, /@typescript-eslint\/no-explicit-any/);
  assert.match(output, /@next\/next\/no-img-element/);
  for (const [file, content] of Object.entries(fixtures)) assert.equal(readFileSync(join(directory, file), 'utf8'), content);
});
