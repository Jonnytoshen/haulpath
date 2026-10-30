import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, symlinkSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { copyReleaseWorkspace, releaseFixtureEnvironment } from './helpers/release-workspace.mjs';
const root = resolve(import.meta.dirname, '..');
function fixture(t, version = '0.1.0') {
  const dir = mkdtempSync(join(tmpdir(), 'haulpath-release-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(root, 'scripts'), join(dir, 'scripts'), { recursive: true });
  if (existsSync(join(root, 'nx.json'))) cpSync(join(root, 'nx.json'), join(dir, 'nx.json'));
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
  copyReleaseWorkspace(root, dir);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json')));
  pkg.version = version;
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n.nx/\n');
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  git('init', '-b', 'main'); git('config', 'user.name', 'Release test');
  git('config', 'user.email', 'release@example.invalid'); git('config', 'commit.gpgsign', 'false');
  let change = 0;
  const commit = (message) => { writeFileSync(join(dir, 'change.txt'), String(++change)); git('add', '.'); git('commit', '--allow-empty', '-m', message); };
  commit('feat(route): preserve point order');
  const cli = (...args) => spawnSync(process.execPath, ['scripts/release.mjs', ...args], {
    cwd: dir, encoding: 'utf8', timeout: 60000, env: releaseFixtureEnvironment({ GITHUB_TOKEN: '', GH_TOKEN: '' }),
  });
  return { dir, git, commit, cli };
}
test('first release previews 0.1.0 and history without writing files or refs', (t) => {
  const f = fixture(t); const before = f.git('show-ref', '--head');
  const r = f.cli('--first-release', '--dry-run');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /0\.1\.0/); assert.match(r.stdout, /preserve point order/);
  assert.match(r.stdout, /Preview/); assert.equal(f.git('status', '--porcelain'), '');
  assert.equal(f.git('show-ref', '--head'), before);
});
test('automatic releases use the stable tag and include domain scopes', (t) => {
  const f = fixture(t); f.git('tag', 'v0.1.0'); f.commit('feat(route): add return trips');
  const r = f.cli('--dry-run'); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Preview: 0\.1\.1 \(v0\.1\.1\)/);
});
test('maintenance changes skip automatically and explicit versions respect cumulative minimum', (t) => {
  const f = fixture(t); f.git('tag', 'v0.1.0'); f.commit('docs: explain route input');
  let r = f.cli('--dry-run'); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /Skipped/);
  r = f.cli('minor', '--dry-run'); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /Preview: 0\.2\.0/);
  f.commit('refactor(storage): change snapshots\n\nBREAKING CHANGE: replace snapshot layout\n\nRun the migration before opening old files.');
  r = f.cli('patch', '--dry-run'); assert.notEqual(r.status, 0); assert.match(r.stderr, /minimum/);
});
test('candidate channels start at zero, advance without changes, and cannot regress', (t) => {
  const f = fixture(t); f.git('tag', 'v0.1.0'); f.commit('fix(planning): preserve snapshots');
  let r = f.cli('--channel', 'alpha', '--dry-run'); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /Preview: 0\.1\.1-alpha\.0/);
  f.git('tag', 'v0.1.1-alpha.0');
  r = f.cli('--channel', 'alpha', '--dry-run'); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /Skipped/);
  r = f.cli('--channel', 'rc', '--dry-run'); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /Preview: 0\.1\.1-rc\.0/);
  f.git('tag', 'v0.1.1-rc.0');
  r = f.cli('--channel', 'beta', '--dry-run'); assert.notEqual(r.status, 0); assert.match(r.stderr, /backward/);
  r = f.cli('--dry-run'); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /Preview: 0\.1\.1 \(v0\.1\.1\)/); assert.match(r.stdout, /preserve snapshots/);
});
test('new candidate changes increase the number while cumulative breaking changes do not repeatedly raise its core', (t) => {
  const f = fixture(t); f.git('tag', 'v0.1.0');
  f.commit('docs(storage): migrate snapshots\n\nBREAKING CHANGE: replace snapshots\n\n## Migration\n\nRun migration before opening existing files.');
  let r = f.cli('--channel=beta', '--dry-run'); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /Preview: 0\.2\.0-beta\.0/);
  f.git('tag', 'v0.2.0-beta.0'); f.commit('fix(map): restore markers');
  r = f.cli('--channel=beta', '--dry-run'); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /Preview: 0\.2\.0-beta\.1/);
  assert.match(r.stdout, /Run migration before opening existing files/);
  assert.doesNotMatch(r.stdout, /M\tchange\.txt/);
  f.git('tag', 'v0.2.0-beta.1');
  r = f.cli('--dry-run'); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /Preview: 0\.2\.0 \(v0\.2\.0\)/);
});
test('a reserved higher candidate core survives maintenance and later fixes', (t) => {
  const f = fixture(t); f.git('tag', 'v0.1.0'); f.commit('fix(route): restore input'); f.git('tag', 'v0.8.0-rc.0');
  f.commit('docs: explain input');
  let r = f.cli('--channel', 'rc', '--dry-run'); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /Skipped/);
  f.commit('perf(planning): cache route input');
  r = f.cli('--channel', 'rc', '--dry-run'); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /Preview: 0\.8\.0-rc\.1/);
  r = f.cli('0.2.0', '--channel', 'rc', '--dry-run'); assert.notEqual(r.status, 0); assert.match(r.stderr, /candidate minimum/);
});
test('a raised minimum requires a new candidate before promotion', (t) => {
  const f = fixture(t, '1.0.0'); f.git('tag', 'v1.0.0'); f.commit('fix(map): restore markers'); f.git('tag', 'v1.0.1-rc.0');
  f.commit('feat(route): add route templates');
  let r = f.cli('--dry-run'); assert.notEqual(r.status, 0); assert.match(r.stderr, /new candidate first/);
  r = f.cli('--channel', 'alpha', '--dry-run'); assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /Preview: 1\.1\.0-alpha\.0/);
});
test('invalid parameters and repeated first releases fail before writes', (t) => {
  const f = fixture(t);
  for (const args of [['--publish'], ['--channel', 'preview'], ['--first-release', 'minor'], ['1.0.0-beta.1'], ['--dry-run', '--dry-run']]) {
    const r = f.cli(...args, ...(args.includes('--dry-run') ? [] : ['--dry-run'])); assert.notEqual(r.status, 0, args.join(' '));
  }
  f.git('tag', 'v0.1.0'); const r = f.cli('--first-release', '--dry-run'); assert.notEqual(r.status, 0);
  assert.equal(f.git('status', '--porcelain'), '');
});
test('preview rejects a target tag already present outside main history', (t) => {
  const f = fixture(t); f.git('tag', 'v0.1.0'); f.git('checkout', '-b', 'other');
  f.commit('fix(route): alternate input'); f.git('tag', 'v0.1.1'); f.git('checkout', 'main');
  f.commit('fix(route): restore input'); const r = f.cli('--dry-run');
  assert.notEqual(r.status, 0); assert.match(r.stderr, /already exists/);
});
test('the English changelog includes every allowed type and keeps migration paragraphs', (t) => {
  const f = fixture(t); f.git('tag', 'v0.1.0');
  for (const type of ['feat', 'fix', 'perf', 'refactor', 'docs', 'build', 'ci', 'test', 'chore', 'style', 'revert']) f.commit(`${type}: describe ${type} changes`);
  const r = f.cli('--dry-run'); assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const heading of ['Features', 'Bug Fixes', 'Performance Improvements', 'Code Refactoring', 'Documentation', 'Build System', 'Continuous Integration', 'Tests', 'Chores', 'Styles', 'Reverts']) assert.ok(r.stdout.includes(`### ${heading}`), heading);
});
test('Nx native revert pairing omits reverted entries while retaining its version decision', (t) => {
  const f = fixture(t); f.git('tag', 'v0.1.0'); f.commit('feat(route): add temporary route template');
  const original = f.git('rev-parse', 'HEAD');
  f.git('revert', '--no-commit', original);
  f.git('commit', '-m', `revert(route): remove temporary route template\n\nThis reverts commit ${original}.\n\nRemove the incomplete template.`);
  const r = f.cli('--dry-run'); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Preview: 0\.1\.1/); assert.doesNotMatch(r.stdout, /add temporary route template/);
});
