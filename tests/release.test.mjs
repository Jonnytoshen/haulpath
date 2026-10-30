import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { copyReleaseWorkspace, releaseFixtureEnvironment } from './helpers/release-workspace.mjs';

const root = resolve(import.meta.dirname, '..');
function fixture(t, version = '1.0.0') {
  const dir = mkdtempSync(join(tmpdir(), 'haulpath-release-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
  copyReleaseWorkspace(root, dir);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json')));
  pkg.version = version;
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  const config = JSON.parse(readFileSync(join(root, 'nx.json')));
  // Local version/changelog previews need no GitHub transport; remote publication
  // is exercised separately using the unmodified repository release config.
  config.release.changelog.workspaceChangelog.createRelease = false;
  config.release.git.push = false;
  writeFileSync(join(dir, 'nx.json'), JSON.stringify(config, null, 2) + '\n');
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n.nx/\n');
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  git('init', '-b', 'main');
  git('config', 'user.name', 'Release test');
  git('config', 'user.email', 'release@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  let change = 0;
  for (const project of ['apps/web', 'packages/domain']) writeFileSync(join(dir, project, 'src/release-fixture.ts'), 'export const releaseFixture = true;\n');
  const commit = (message, file = 'change.txt') => {
    writeFileSync(join(dir, file), `// release fixture change ${++change}\n`);
    git('add', '.'); git('commit', '-m', message);
  };
  commit('feat(route): preserve point order');
  const cli = (...args) => {
    const result = spawnSync('pnpm', ['run', 'release', ...args], {
      cwd: dir, encoding: 'utf8', timeout: 60000,
      env: releaseFixtureEnvironment({ GITHUB_TOKEN: '', GH_TOKEN: '', CI: 'true' }),
    });
    assert.ifError(result.error);
    return result;
  };
  return { dir, git, commit, cli };
}
function preview(f, version, ...args) {
  const before = f.git('show-ref', '--head');
  const r = f.cli(...args, '--dry-run');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  if (version) assert.ok(r.stdout.includes(version), r.stdout);
  assert.equal(f.git('show-ref', '--head'), before);
  assert.equal(f.git('status', '--porcelain'), '');
  return r.stdout;
}
function assertPrivateChildren(f) {
  for (const project of ['apps/web', 'packages/domain']) {
    const pkg = JSON.parse(readFileSync(join(f.dir, project, 'package.json')));
    assert.equal(pkg.private, true);
    assert.equal(Object.hasOwn(pkg, 'version'), false);
    assert.equal(existsSync(join(f.dir, project, 'CHANGELOG.md')), false);
  }
}

test('public release accepts native preminor and preid without any release scripts', (t) => {
  const f = fixture(t);
  f.git('tag', 'v1.0.0'); f.commit('fix(route): retain route input');
  const output = preview(f, '1.1.0-beta.0', 'preminor', '--preid=beta');
  assert.match(output, /retain route input/);
  assert.equal(existsSync(join(f.dir, 'scripts')), false);
});
test('first release accepts an explicit version and previews without writing files or refs', (t) => {
  const f = fixture(t, '0.1.0');
  const output = preview(f, '0.1.0', '0.1.0', '--first-release');
  assert.match(output, /preserve point order/);
  assertPrivateChildren(f);
});
test('native changelog preserves multiline migration guidance and stops before unrelated Markdown sections', (t) => {
  const f = fixture(t); f.git('tag', 'v1.0.0');
  f.commit('refactor(storage): replace snapshot layout\n\nBREAKING CHANGE: replace snapshots\n\nBack up existing project data before upgrading.\n\n- Run the snapshot migration.\n- Reopen the saved projects.\n\n## Related issues\n\nReviewer-only details must stay out of release notes.');
  const output = preview(f, '2.0.0');
  for (const text of ['Breaking Changes', 'Back up existing project data before upgrading', '- Run the snapshot migration.', '- Reopen the saved projects.']) assert.ok(output.includes(text), text);
  assert.doesNotMatch(output, /Related issues|Reviewer-only details/);
});
for (const [project, label] of [['packages/domain', 'domain'], ['apps/web', 'web']]) {
  for (const [type, version] of [['feat', '1.1.0'], ['fix', '1.0.1'], ['refactor', '2.0.0']]) {
    test(`a ${label}-only ${type} participates in the single product release`, (t) => {
      const f = fixture(t); f.git('tag', 'v1.0.0');
      const file = `${project}/src/release-fixture.ts`;
      const summary = `preserve ${label} ${type} behavior`;
      f.commit(`${type}(planning): ${summary}${type === 'refactor' ? '\n\nBREAKING CHANGE: replace saved planning input\n\nRun the migration before opening saved projects.' : ''}`, file);
      assert.equal(f.git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'), file);
      assert.ok(preview(f, version).includes(summary));
      assert.equal(JSON.parse(readFileSync(join(f.dir, 'package.json'))).version, '1.0.0');
      assertPrivateChildren(f);
    });
  }
  test(`a ${label}-only maintenance change waits for an explicit release`, (t) => {
    const f = fixture(t); f.git('tag', 'v1.0.0');
    f.commit(`docs(planning): explain ${label} planning input`, `${project}/src/release-fixture.ts`);
    assert.match(preview(f), /No changes detected|No changes|Skipping|skipping/);
    assert.ok(preview(f, '1.0.1', 'patch').includes(`explain ${label} planning input`));
  });
}
test('zero-major adjustment applies to native automatic and manual relative versions', (t) => {
  const f = fixture(t, '0.1.0'); f.git('tag', 'v0.1.0'); f.commit('feat(route): add return trips');
  preview(f, '0.1.1');
  preview(f, '0.2.0', 'major');
});
test('native explicit versions replace the former custom cumulative minimum check', (t) => {
  const f = fixture(t); f.git('tag', 'v1.0.0');
  f.commit('refactor(storage): replace snapshots\n\nBREAKING CHANGE: replace snapshot format\n\nMigrate saved snapshots before opening projects.');
  assert.match(preview(f, '1.0.1', '1.0.1'), /Migrate saved snapshots/);
});
test('the changelog prefixes every allowed conventional commit heading with an icon', (t) => {
  const f = fixture(t); f.git('tag', 'v1.0.0');
  for (const type of ['feat', 'fix', 'perf', 'refactor', 'docs', 'build', 'ci', 'test', 'chore', 'style', 'revert']) f.commit(`${type}: describe ${type} changes`);
  const output = preview(f, '1.1.0');
  for (const heading of ['🚀 Features', '🐛 Bug Fixes', '⚡ Performance Improvements', '♻️ Code Refactoring', '📚 Documentation', '📦 Build System', '🔧 Continuous Integration', '🧪 Tests', '🧹 Chores', '🎨 Styles', '⏪ Reverts']) assert.ok(output.includes(`### ${heading}`), heading);
});
test('Nx native revert pairing omits reverted entries while retaining its version decision', (t) => {
  const f = fixture(t); f.git('tag', 'v1.0.0'); f.commit('feat(route): add temporary route template');
  const original = f.git('rev-parse', 'HEAD');
  f.git('revert', '--no-commit', original);
  f.git('commit', '-m', `revert(route): remove temporary route template\n\nThis reverts commit ${original}.\n\nRemove the incomplete template.`);
  assert.doesNotMatch(preview(f, '1.1.0'), /add temporary route template/);
});
