import assert from 'node:assert/strict';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
function repository(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'haulpath format '));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  for (const name of [
    'package.json',
    'scripts',
    'commitlint.config.mjs',
    '.prettierrc.json',
    '.prettierignore',
    '.gitignore',
  ])
    cpSync(join(root, name), join(cwd, name), { recursive: true });
  symlinkSync(join(root, 'node_modules'), join(cwd, 'node_modules'), 'dir');
  writeFileSync(join(cwd, 'pnpm-workspace.yaml'), 'verifyDepsBeforeRun: false\n');
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    HUSKY: '1',
    NX_DAEMON: 'false',
  };
  for (const name of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_CONFIG',
    'GIT_CONFIG_COUNT',
  ])
    delete env[name];
  const run = (command, args) => {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 30_000 });
    assert.ifError(result.error);
    return { ...result, output: `${result.stdout}${result.stderr}` };
  };
  const git = (...args) => {
    const result = run('git', args);
    assert.equal(result.status, 0, result.output);
    return result.stdout;
  };
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Format Test');
  git('config', 'user.email', 'format@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  return {
    cwd,
    run,
    git,
    write: (name, value) => writeFileSync(join(cwd, name), value),
    check: () => run('pnpm', ['run', 'format:staged']),
  };
}

test('the staged command rejects unformatted index content without changing it', (t) => {
  const repo = repository(t);
  repo.write('example.js', 'const value={name:"hello"}\n');
  repo.git('add', 'example.js');
  const before = repo.git('show', ':example.js');
  const result = repo.check();
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /example\.js/);
  assert.equal(repo.git('show', ':example.js'), before);
  assert.equal(readFileSync(join(repo.cwd, 'example.js'), 'utf8'), before);
});

test('the staged command follows index content in both partial-staging directions', (t) => {
  const repo = repository(t);
  const good = "const value = { name: 'hello' };\n";
  const bad = 'const value={name:"hello"}\n';
  repo.write('partial.js', good);
  repo.git('add', 'partial.js');
  repo.write('partial.js', bad);
  assert.equal(repo.check().status, 0);
  assert.equal(readFileSync(join(repo.cwd, 'partial.js'), 'utf8'), bad);
  repo.git('add', 'partial.js');
  repo.write('partial.js', good);
  assert.notEqual(repo.check().status, 0);
  assert.equal(repo.git('show', ':partial.js'), bad);
  assert.equal(readFileSync(join(repo.cwd, 'partial.js'), 'utf8'), good);
});

test('installed hooks reject bad formatting and retain commit-message validation', (t) => {
  const repo = repository(t);
  cpSync(join(root, '.husky'), join(repo.cwd, '.husky'), { recursive: true });
  const prepare = repo.run('pnpm', ['run', 'prepare']);
  assert.equal(prepare.status, 0, prepare.output);
  repo.write('example.js', 'const x=1\n');
  repo.git('add', 'example.js');
  let result = repo.run('git', ['commit', '-m', 'build(tooling): add example']);
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /example\.js/);
  repo.write('example.js', 'const x = 1;\n');
  repo.git('add', 'example.js');
  result = repo.run('git', ['commit', '-m', 'invalid message']);
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /subject-empty|type-empty/);
  repo.git('commit', '-m', 'build(tooling): add example');
  rmSync(join(repo.cwd, '.husky/_'), { recursive: true, force: true });
  assert.equal(repo.run('pnpm', ['run', 'prepare']).status, 0);
  repo.write('example.js', 'const x=2\n');
  repo.git('add', 'example.js');
  assert.notEqual(repo.run('git', ['commit', '--amend', '--no-edit']).status, 0);
});

test('staged files remain checkable when missing or replaced by a symlink in the worktree', (t) => {
  const repo = repository(t);
  repo.write('missing.js', 'const value=1\n');
  repo.write('link.js', 'const value=2\n');
  repo.git('add', 'missing.js', 'link.js');
  rmSync(join(repo.cwd, 'missing.js'));
  rmSync(join(repo.cwd, 'link.js'));
  symlinkSync('missing-target', join(repo.cwd, 'link.js'));
  const result = repo.check();
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /missing\.js/);
  assert.match(result.output, /link\.js/);
});

test('full Nx commands check, repair and produce an idempotent result', (t) => {
  const repo = repository(t);
  repo.write('nx.json', '{}\n');
  repo.write('example.js', 'const value={name:"hello"}\n');
  let result = repo.run('pnpm', ['run', 'format:check']);
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /example\.js/);
  result = repo.run('pnpm', ['run', 'format']);
  assert.equal(result.status, 0, result.output);
  assert.equal(
    readFileSync(join(repo.cwd, 'example.js'), 'utf8'),
    "const value = { name: 'hello' };\n",
  );
  assert.equal(repo.run('pnpm', ['run', 'format:check']).status, 0);
  repo.git('add', '.');
  const before = repo.git('write-tree');
  assert.equal(repo.run('pnpm', ['run', 'format']).status, 0);
  repo.git('add', '.');
  assert.equal(repo.git('write-tree'), before);
});

test('ignored and unsupported staged files and non-regular index entries do not block commits', (t) => {
  const repo = repository(t);
  assert.equal(repo.check().status, 0);
  mkdirSync(join(repo.cwd, 'tests/fixtures'), { recursive: true });
  mkdirSync(join(repo.cwd, 'apps/web/public/brand'), { recursive: true });
  for (const path of [
    'tests/fixtures/input.json',
    'CHANGELOG.md',
    'pnpm-lock.yaml',
    'apps/web/public/brand/logo.svg',
    'unknown.binary',
  ])
    repo.write(path, 'unformatted {\n');
  symlinkSync('absent', join(repo.cwd, 'symbolic.js'));
  repo.git(
    'add',
    'tests/fixtures/input.json',
    'CHANGELOG.md',
    'pnpm-lock.yaml',
    'apps/web/public/brand/logo.svg',
    'unknown.binary',
    'symbolic.js',
  );
  const result = repo.check();
  assert.equal(result.status, 0, result.output);
});

test('renames and unusual paths are checked, and deletion-only changes pass', (t) => {
  const repo = repository(t);
  repo.write('old.js', 'const value = 1;\n');
  repo.git('add', 'old.js');
  repo.git('-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'build(tooling): create file');
  const name = '中文 空格 [x]\nfile.js';
  repo.git('mv', 'old.js', name);
  repo.write(name, 'const value=1\n');
  repo.git('add', name);
  const result = repo.check();
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /中文 空格/);
  repo.git('rm', '-f', name);
  assert.equal(repo.check().status, 0);
});

test('invalid formatter configuration fails instead of reporting success', (t) => {
  const repo = repository(t);
  repo.write('example.js', 'const value = 1;\n');
  repo.git('add', 'example.js');
  repo.write('.prettierrc.json', '{ invalid');
  const result = repo.check();
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /暂存区格式检查失败/);
});
