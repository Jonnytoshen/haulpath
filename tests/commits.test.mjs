import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    ...options,
  });
  assert.ifError(result.error);
  return { ...result, output: `${result.stdout}${result.stderr}` };
}

function lint(message, args = [], cwd = root) {
  return run('pnpm', ['run', 'commitlint', ...args], { input: message, cwd });
}

function accepts(message) {
  const result = lint(message);
  assert.equal(result.status, 0, result.output);
}

test('the public command accepts a valid Angular-style message', () => {
  accepts('build(git): enforce angular-style commit messages\n');
});

function rejects(message, hint) {
  const result = lint(message);
  assert.notEqual(result.status, 0, `Unexpectedly accepted ${JSON.stringify(message)}\n${result.output}`);
  if (hint) assert.match(result.output, hint);
}

test('scope must be one exact value from the project vocabulary', () => {
  for (const scope of ['unknown', 'Route', 'route/point', 'route\\point', 'route,point']) {
    rejects(`feat(${scope}): add a point\n`, /scope/);
  }
});

test('headers require exact punctuation, spacing, and a lowercase English summary start', () => {
  for (const message of [
    'feat:  add a point', 'feat(): add a point', ' feat: add a point',
    'feat: add a point ', 'feat: add a point\t', 'feat( route): add a point',
    'feat(route ): add a point', 'feat:add a point', 'feat : add a point',
    'feat: Add a point', 'feat: 添加点位', 'feat: add a point.', 'feat: ',
  ]) rejects(`${message}\n`, /header|subject|scope/);
  accepts('feat(storage): add SQLite support\n');
});

test('generated and temporary messages receive no exemptions', () => {
  for (const message of [
    'Merge branch main', 'Revert "feat: add a point"', 'v1.2.3',
    'WIP: add a point', 'fixup! feat: add a point', 'squash! feat: add a point',
    'amend! feat: add a point', 'feat: wip add a point', 'feat: fixup! add a point',
    'feat: squash! add a point', 'feat: amend! add a point',
  ]) rejects(`${message}\n`);
  accepts('docs(git): explain temporary commits\n\nDiscuss WIP, fixup!, squash!, and amend! here.\n');
});

test('ordinary bodies are optional, bilingual, short, or arbitrarily long', () => {
  for (const body of ['', '简短说明', 'Explain why.', 'a'.repeat(180)]) {
    accepts(`docs(git): explain commit history${body ? `\n\n${body}` : ''}\n`);
  }
  accepts(`docs(git): explain references\n\nFixes #${'1'.repeat(180)}\n`);
});

test('missing blank lines before a body or footer are errors', () => {
  for (const message of [
    'fix(route): preserve point order\nExplain the change.\n',
    'fix(route): preserve point order\n\nExplain the change.\nFixes #123\n',
    'fix(route): preserve point order\nFixes #123\n',
  ]) {
    const result = lint(message);
    assert.equal(result.status, 3, result.output);
    assert.match(result.output, /blank/);
  }
  accepts('fix(route): preserve point order\n\nExplain the change.\n\nFixes #123\n');
});

test('breaking changes require one exact footer marker, a summary, and separated migration text', () => {
  for (const suffix of [
    'BREAKING CHANGE: change storage layout\n',
    'BREAKING CHANGE: \n\nRun the migration.\n',
    'BREAKING CHANGE: change storage layout\nRun the migration.\n',
    'BREAKING-CHANGE: change storage layout\n\nRun the migration.\n',
    'BREAKING CHANGE: change storage layout\n\n   \n',
    'BREAKING CHANGE: change storage layout\n\n# Run the migration.\n',
    'BREAKING CHANGE: change storage layout\n\nRefs: #123\n',
  ]) rejects(`feat(storage): change storage layout\n\n${suffix}`, /breaking|BREAKING/);
  rejects('feat!: change storage layout\n');
  rejects('feat(storage)!: change storage layout\n');
  accepts(`feat(storage): change storage layout\n\nExplain why.\n\nBREAKING CHANGE: change the schema\n\n执行迁移：${'迁'.repeat(120)}\n`);
});

const revertedSha = '0123456789abcdef0123456789abcdef01234567';

test('revert commits include an exact full SHA record and an independent reason', () => {
  for (const body of [
    '', 'Restore the previous behavior.', `This reverts commit ${revertedSha}.`,
    `This reverts commit ${revertedSha.slice(0, 7)}.\n\nRestore behavior.`,
    `This reverts commit ${'a'.repeat(41)}.\n\nRestore behavior.`,
    `This reverts commit ${'z'.repeat(40)}.\n\nRestore behavior.`,
    `This reverts commit ${revertedSha}\n\nRestore behavior.`,
    `Reason: This reverts commit ${revertedSha}.\n\nRestore behavior.`,
    `This reverts commit ${revertedSha}.\n\n# Restore behavior.`,
    `This reverts commit ${revertedSha}.\n\nRefs: #123`,
  ]) rejects(`revert(route): restore point order\n\n${body}\n`, /revert/);
  for (const scope of ['', '(route)']) {
    accepts(`revert${scope}: restore point order\n\nThis reverts commit ${revertedSha}.\n\n恢复原有顺序，修正本次回归。\n`);
  }
});

function repository(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'zhongtu commit '));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  for (const name of ['package.json', 'commitlint.config.mjs', 'scripts']) {
    cpSync(join(root, name), join(cwd, name), { recursive: true });
  }
  mkdirSync(join(cwd, '.husky'));
  const hook = join(root, '.husky/commit-msg');
  try { cpSync(hook, join(cwd, '.husky/commit-msg')); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  symlinkSync(join(root, 'node_modules'), join(cwd, 'node_modules'), 'dir');
  writeFileSync(join(cwd, 'pnpm-workspace.yaml'), 'verifyDepsBeforeRun: false\n');
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    HUSKY: '1', HUSKY_SKIP_HOOKS: '' };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CONFIG', 'GIT_CONFIG_COUNT']) delete env[name];
  const git = (...args) => run('git', args, { cwd, env });
  const ok = (...args) => {
    const result = git(...args);
    assert.equal(result.status, 0, result.output);
    return result.stdout.trim();
  };
  ok('init', '--initial-branch=main');
  ok('config', 'user.name', 'Commit Rules Test');
  ok('config', 'user.email', 'commit-rules@example.invalid');
  ok('config', 'commit.gpgsign', 'false');
  const prepare = () => {
    const result = run('pnpm', ['run', 'prepare'], { cwd, env });
    assert.equal(result.status, 0, result.output);
  };
  prepare();
  return { cwd, env, git, ok, prepare };
}

test('prepare installs a hook that blocks invalid commits and amendments, and repairs removal', (t) => {
  const repo = repository(t);
  const attempt = repo.git('commit', '--allow-empty', '-m', 'invalid message');
  assert.notEqual(attempt.status, 0, attempt.output);
  assert.notEqual(repo.git('rev-parse', '--verify', 'HEAD').status, 0);
  repo.ok('commit', '--allow-empty', '-m', 'build(git): establish commit rules');
  const before = repo.ok('rev-parse', 'HEAD');
  const amend = repo.git('commit', '--amend', '--allow-empty', '-m', 'invalid amendment');
  assert.notEqual(amend.status, 0, amend.output);
  assert.equal(repo.ok('rev-parse', 'HEAD'), before);
  repo.ok('commit', '--amend', '--allow-empty', '-m', 'build(git): establish strict commit rules');
  assert.notEqual(repo.ok('rev-parse', 'HEAD'), before);
  rmSync(join(repo.cwd, '.husky/_'), { recursive: true });
  repo.prepare();
  const repaired = repo.git('commit', '--allow-empty', '-m', 'invalid message after repair');
  assert.notEqual(repaired.status, 0, repaired.output);
});

test('the declared types, optional scopes, and full-header length boundaries are enforced', () => {
  for (const type of ['build', 'ci', 'docs', 'feat', 'fix', 'perf', 'refactor', 'test', 'chore', 'style']) {
    accepts(`${type}: describe one complete change\n`);
  }
  for (const scope of ['project', 'route', 'point', 'planning', 'map', 'import', 'export', 'storage', 'ui', 'git', 'deps', 'tooling']) {
    accepts(`feat(${scope}): describe one complete change\n`);
  }
  for (const type of ['feature', 'Fix', 'maintenance']) rejects(`${type}: describe one change\n`, /type|header/);
  accepts(`feat: ${'a'.repeat(94)}\n`);
  rejects(`feat: ${'a'.repeat(95)}\n`, /header-max-length/);
});

test('stdin and message files including paths with spaces reach the same rules', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'zhongtu message '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'commit message.txt');
  for (const message of [
    'feat(point): add SQLite support\n', 'feat:  add a point\n',
    'feat: add a point \n', ' feat: add a point\n', 'feat(route/point): add a point\n',
    'fixup! feat: add a point\n', '', '   \n\t\n', '# Only a comment.\n',
  ]) {
    writeFileSync(path, message);
    const stdinResult = lint(message);
    const fileResult = lint(undefined, ['--edit', path]);
    assert.equal(fileResult.status === 0, stdinResult.status === 0, `${JSON.stringify(message)}\n${fileResult.output}`);
  }
});

test('a real merge must replace the generated title with a project-formatted message', (t) => {
  const repo = repository(t);
  repo.ok('commit', '--allow-empty', '-m', 'build(git): establish a base');
  repo.ok('switch', '-c', 'feature');
  repo.ok('commit', '--allow-empty', '-m', 'feat(route): preserve point order');
  repo.ok('switch', 'main');
  repo.ok('commit', '--allow-empty', '-m', 'docs(route): explain point order');
  const before = repo.ok('rev-parse', 'HEAD');
  const generated = repo.git('merge', '--no-ff', '--no-edit', 'feature');
  assert.notEqual(generated.status, 0, generated.output);
  assert.equal(repo.ok('rev-parse', 'HEAD'), before);
  repo.ok('commit', '-m', 'chore(git): integrate point order changes');
  assert.equal(repo.ok('rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3);
});

test('revert --no-commit uses the hook when creating the documented ordinary commit', (t) => {
  const repo = repository(t);
  writeFileSync(join(repo.cwd, 'example.txt'), 'original\n');
  repo.ok('add', 'example.txt');
  repo.ok('commit', '-m', 'feat(route): record original point order');
  writeFileSync(join(repo.cwd, 'example.txt'), 'changed\n');
  repo.ok('add', 'example.txt');
  repo.ok('commit', '-m', 'fix(route): change point order');
  const target = repo.ok('rev-parse', 'HEAD');
  repo.ok('revert', '--no-commit', target);
  const invalid = repo.git('commit', '-m', 'revert(route): restore original point order');
  assert.notEqual(invalid.status, 0, invalid.output);
  assert.equal(repo.ok('rev-parse', 'HEAD'), target);
  repo.ok('commit', '-m', 'revert(route): restore original point order', '-m',
    `This reverts commit ${target}.\n\nRestore the intended point order after a regression.`);
  assert.equal(readFileSync(join(repo.cwd, 'example.txt'), 'utf8'), 'original\n');
  const saved = repo.ok('log', '-1', '--format=%B');
  accepts(saved);
});

test('edit aliases, equals syntax, and default paths preserve empty-file protection', (t) => {
  const repo = repository(t);
  const path = join(repo.cwd, 'commit message.txt');
  const defaultPath = join(repo.cwd, repo.ok('rev-parse', '--git-path', 'COMMIT_EDITMSG'));
  for (const message of ['feat(point): preserve point names\n', '   \n', '# Only a comment.\n']) {
    writeFileSync(path, message);
    writeFileSync(defaultPath, message);
    for (const args of [
      ['-e', path], [`--edit=${path}`], [`-e=${path}`], ['--edit', '--verbose'], ['-e'],
    ]) {
      const result = run('pnpm', ['run', 'commitlint', ...args], { cwd: repo.cwd, env: repo.env });
      assert.equal(result.status === 0, message.startsWith('feat'), result.output);
    }
  }
});

test('range validation checks every included commit and follows from-exclusive to-inclusive boundaries', (t) => {
  const repo = repository(t);
  const unchecked = (message) => repo.ok('-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-m', message);
  unchecked('invalid baseline marker');
  const baseline = repo.ok('rev-parse', 'HEAD');
  unchecked('feat(point): preserve point names');
  const valid = repo.ok('rev-parse', 'HEAD');
  unchecked('invalid middle marker');
  const middle = repo.ok('rev-parse', 'HEAD');
  unchecked('docs(point): explain point names');
  const latest = repo.ok('rev-parse', 'HEAD');
  const range = (from, to) => run('pnpm', ['run', 'commitlint', '--from', from, '--to', to], { cwd: repo.cwd, env: repo.env });
  const excludesBaseline = range(baseline, valid);
  assert.equal(excludesBaseline.status, 0, excludesBaseline.output);
  const includesMiddle = range(baseline, latest);
  assert.notEqual(includesMiddle.status, 0, includesMiddle.output);
  assert.match(includesMiddle.output, /invalid middle marker/);
  assert.doesNotMatch(includesMiddle.output, /invalid baseline marker/);
  const includesEnd = range(valid, middle);
  assert.notEqual(includesEnd.status, 0, includesEnd.output);
  const excludesStart = range(middle, latest);
  assert.equal(excludesStart.status, 0, excludesStart.output);
});

test('independent checks discover the generated message from a direct git revert', (t) => {
  const repo = repository(t);
  writeFileSync(join(repo.cwd, 'example.txt'), 'original\n');
  repo.ok('add', 'example.txt');
  repo.ok('commit', '-m', 'feat(route): record original point order');
  writeFileSync(join(repo.cwd, 'example.txt'), 'changed\n');
  repo.ok('add', 'example.txt');
  repo.ok('commit', '-m', 'fix(route): change point order');
  const target = repo.ok('rev-parse', 'HEAD');
  const reverted = repo.git('revert', '--no-edit', target);
  if (reverted.status !== 0) {
    assert.match(reverted.output, /commitlint|project-header/);
    assert.equal(repo.ok('rev-parse', 'HEAD'), target);
    return;
  }
  const saved = repo.ok('log', '-1', '--format=%B');
  rejects(saved);
  const result = run('pnpm', ['run', 'commitlint', '--from', target, '--to', 'HEAD'], { cwd: repo.cwd, env: repo.env });
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /Revert/);
});

test('Git comment cleanup cannot remove the only explanation after the hook accepts', (t) => {
  const repo = repository(t);
  repo.ok('config', 'core.editor', 'true');
  const path = join(repo.cwd, 'commit message.txt');
  for (const message of [
    `revert(route): restore point order\n\nThis reverts commit ${revertedSha}.\n\n# Only a commented reason.\n`,
    'feat(storage): change storage layout\n\nBREAKING CHANGE: change the schema\n\n# Only commented migration steps.\n',
  ]) {
    writeFileSync(path, message);
    const result = repo.git('commit', '--edit', '--allow-empty', '-F', path);
    assert.notEqual(result.status, 0, result.output);
    assert.notEqual(repo.git('rev-parse', '--verify', 'HEAD').status, 0);
  }
  writeFileSync(path, `revert(route): restore point order\n\nThis reverts commit ${revertedSha}.\n\nRestore intended ordering.\n# Git removes this note.\n`);
  repo.ok('commit', '--edit', '--allow-empty', '-F', path);
  const saved = repo.ok('log', '-1', '--format=%B');
  assert.doesNotMatch(saved, /Git removes/);
  accepts(saved);
});

test('the configured Git comment character cannot hide the only required explanation', (t) => {
  const repo = repository(t);
  repo.ok('config', 'core.editor', 'true');
  repo.ok('config', 'core.commentChar', ';');
  const path = join(repo.cwd, 'commit message.txt');
  for (const message of [
    `revert(route): restore point order\n\nThis reverts commit ${revertedSha}.\n\n; Only a commented reason.\n`,
    'feat(storage): change storage layout\n\nBREAKING CHANGE: change the schema\n\n; Only commented migration steps.\n',
  ]) {
    writeFileSync(path, message);
    const result = repo.git('commit', '--edit', '--allow-empty', '-F', path);
    assert.notEqual(result.status, 0, result.output);
    assert.notEqual(repo.git('rev-parse', '--verify', 'HEAD').status, 0);
  }
});
