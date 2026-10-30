import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, symlinkSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { copyReleaseWorkspace, releaseFixtureEnvironment } from './helpers/release-workspace.mjs';
const root = resolve(import.meta.dirname, '..');
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'haulpath-publish-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, 'repo'); mkdirSync(dir);
  for (const file of ['scripts', 'nx.json', 'commitlint.config.mjs', '.husky']) cpSync(join(root, file), join(dir, file), { recursive: true });
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
  copyReleaseWorkspace(root, dir);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json')));
  pkg.version = '0.1.0';
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n.nx/\n');
  const environment = releaseFixtureEnvironment({ CI: 'true', NODE_OPTIONS: '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });
  for (const key of Object.keys(environment)) if (/^(https?|all|no)_proxy$/i.test(key) || /^GIT_SSH/i.test(key)) delete environment[key];
  const git = (...args) => { const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: environment }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git('init', '-b', 'main'); git('config', 'user.name', 'Release test'); git('config', 'user.email', 'release@example.invalid'); git('config', 'commit.gpgsign', 'false');
  git('config', 'push.autoSetupRemote', 'true'); git('config', 'tag.gpgsign', 'false');
  let n = 0;
  const commit = (message) => { writeFileSync(join(dir, 'change.txt'), String(++n)); git('add', '.'); git('commit', '-m', message); };
  commit('feat(route): preserve point order');
  git('init', '--bare', join(base, 'remote.git'));
  {
    git('remote', 'add', 'origin', 'git@github.com:example/haulpath.git');
    const ssh = join(base, 'ssh.cjs');
    writeFileSync(ssh, `const { spawnSync } = require('node:child_process');
const operation = new Map([["git-upload-pack 'example/haulpath.git'", 'upload-pack'], ["git-receive-pack 'example/haulpath.git'", 'receive-pack']]).get(process.argv.at(-1));
if (process.argv.at(-2) !== 'git@github.com' || !operation) process.exit(64);
const result = spawnSync('git', [operation, ${JSON.stringify(join(base, 'remote.git'))}], { stdio: 'inherit' });
process.exit(result.status ?? 1);
`);
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    git('config', 'core.sshCommand', `${quote(process.execPath)} ${quote(ssh)}`);
    git('config', 'ssh.variant', 'ssh');
    writeFileSync(join(base, 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  }
  const preload = join(base, 'api.mjs');
  writeFileSync(preload, `import fs from 'node:fs';
globalThis.fetch = async (input, options = {}) => {
  const url = String(input);
  const method = options.method ?? 'GET';
  if (url.startsWith('https://ungh.cc/')) {
    if (url !== 'https://ungh.cc/users/find/release@example.invalid') throw new Error('Unexpected author lookup: ' + url);
    fs.appendFileSync(${JSON.stringify(join(base, 'author-requests'))}, url + '\\n');
    return new Response(JSON.stringify({ user: { username: 'release-test' } }), { status: 200 });
  }
  if (!url.startsWith('https://api.github.com/repos/example/haulpath/')) throw new Error('Unexpected external request: ' + url);
  const body = options.body ? JSON.parse(options.body) : undefined;
  fs.appendFileSync(${JSON.stringify(join(base, 'requests'))}, JSON.stringify({ url, method, body }) + '\\n');
  if (method === 'GET' && url.includes('/releases/tags/')) {
    const data = process.env.API_EXISTING ? { id: 123, body: 'Manually edited release notes', html_url: 'https://github.com/example/haulpath/releases/tag/v0.1.0' } : { message: 'Not Found' };
    return new Response(JSON.stringify(data), { status: process.env.API_EXISTING ? 200 : 404 });
  }
  if ((method === 'POST' && url.endsWith('/releases')) || (method === 'PATCH' && url.endsWith('/releases/123'))) {
    const data = process.env.API_FAIL ? { message: 'Fixture GitHub unavailable' } : { id: 123, html_url: 'https://github.com/example/haulpath/releases/tag/' + body.tag_name };
    return new Response(JSON.stringify(data), { status: process.env.API_FAIL ? 503 : method === 'POST' ? 201 : 200 });
  }
  throw new Error('Unexpected GitHub request: ' + method + ' ' + url);
};
`);
  const cli = (args, extra = {}) => {
    const childEnvironment = { ...environment, GITHUB_TOKEN: 'fixture-secret-token', GH_TOKEN: '', ...extra, NODE_OPTIONS: `--import=${preload}`, PATH: `${base}${delimiter}${environment.PATH}` };
    for (const key of Object.keys(childEnvironment)) if (/^(https?|all|no)_proxy$/i.test(key) || /^GIT_SSH/i.test(key)) delete childEnvironment[key];
    return spawnSync('pnpm', ['run', 'release', ...args], { cwd: dir, encoding: 'utf8', timeout: 60000, env: childEnvironment });
  };
  const requests = () => existsSync(join(base, 'requests')) ? readFileSync(join(base, 'requests'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { dir, base, git, commit, cli, requests };
}

test('native dry-run leaves files and refs untouched while allowing GitHub GET requests', (t) => {
  const f = fixture(t); const before = f.git('show-ref', '--head');
  const r = f.cli(['0.1.0', '--first-release', '--dry-run']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /preserve point order/);
  assert.match(r.stdout, /- Release test @release-test/);
  assert.equal(f.git('show-ref', '--head'), before);
  assert.equal(f.git('status', '--porcelain'), '');
  assert.equal(existsSync(join(f.dir, 'CHANGELOG.md')), false);
  assert.equal(f.git('ls-remote', 'origin'), '');
  assert.ok(f.requests().some((request) => request.method === 'GET'));
  assert.ok(f.requests().every((request) => request.method === 'GET'));
});

test('native release commits the root version and changelog, follows annotated tags and skips registry publishing', (t) => {
  const f = fixture(t); f.git('tag', '-a', 'local-annotated-tag', '-m', 'Local annotated tag');
  const r = f.cli(['0.1.0', '--first-release']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(f.git('log', '-1', '--format=%s'), 'chore: release v0.1.0');
  assert.equal(f.git('cat-file', '-t', 'v0.1.0'), 'tag');
  assert.equal(f.git('status', '--porcelain'), '');
  assert.equal(JSON.parse(f.git('show', 'v0.1.0:package.json')).version, '0.1.0');
  assert.match(f.git('show', 'v0.1.0:CHANGELOG.md'), /preserve point order/);
  for (const project of ['apps/web', 'packages/domain']) {
    assert.equal(Object.hasOwn(JSON.parse(f.git('show', `v0.1.0:${project}/package.json`)), 'version'), false);
    assert.equal(existsSync(join(f.dir, project, 'CHANGELOG.md')), false);
  }
  const remote = f.git('ls-remote', 'origin');
  assert.match(remote, /refs\/heads\/main/);
  assert.match(remote, /refs\/tags\/v0\.1\.0/);
  assert.match(remote, /refs\/tags\/local-annotated-tag/);
  const posts = f.requests().filter((request) => request.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.tag_name, 'v0.1.0');
  assert.equal(posts[0].body.prerelease, false);
  assert.equal(posts[0].body.make_latest, 'legacy');
  assert.match(posts[0].body.body, /preserve point order/);
  assert.match(r.stdout, /Skipped publishing packages/);
});

test('native author mentions appear in local, tagged and published changelogs', (t) => {
  const f = fixture(t);
  f.commit('feat(route): support saved return trips\n\nCo-authored-by: Noreply Author <123+noreply-author@users.noreply.github.com>');
  const r = f.cli(['0.1.0', '--first-release'], { GIT_SSH_COMMAND: 'false', GIT_SSH: 'unavailable-test-ssh', GIT_SSH_VARIANT: 'plink' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const published = f.requests().find((request) => request.method === 'POST').body.body;
  for (const notes of [readFileSync(join(f.dir, 'CHANGELOG.md'), 'utf8'), f.git('show', 'v0.1.0:CHANGELOG.md'), published]) {
    assert.match(notes, /- Release test @release-test/);
    assert.match(notes, /- Noreply Author @noreply-author/);
    assert.equal(notes.split('- Release test @release-test').length - 1, 1);
  }
  assert.equal(readFileSync(join(f.base, 'author-requests'), 'utf8').trim(), 'https://ungh.cc/users/find/release@example.invalid');
});

test('native release runs commit-msg, skips pre-push and preserves SSH signing', (t) => {
  const f = fixture(t); const key = join(f.base, 'signing-key');
  const keygen = spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', key], { encoding: 'utf8' });
  assert.equal(keygen.status, 0, keygen.stderr);
  f.git('config', 'gpg.format', 'ssh'); f.git('config', 'user.signingkey', key); f.git('config', 'commit.gpgsign', 'true');
  const hooks = join(f.base, 'hooks'); mkdirSync(hooks);
  writeFileSync(join(hooks, 'commit-msg'), '#!/bin/sh\npnpm run commitlint --edit "$1" || exit $?\nmkdir -p .nx\nprintf "checked\\n" >> .nx/hook\n', { mode: 0o755 });
  writeFileSync(join(hooks, 'pre-push'), '#!/bin/sh\nexit 71\n', { mode: 0o755 });
  f.git('config', 'core.hooksPath', hooks);
  const r = f.cli(['0.1.0', '--first-release']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(f.git('cat-file', '-p', 'HEAD'), /gpgsig -----BEGIN SSH SIGNATURE-----/);
  assert.equal(readFileSync(join(f.dir, '.nx/hook'), 'utf8'), 'checked\n');
  assert.equal(f.git('config', '--get', 'commit.gpgsign'), 'true');
  assert.match(f.git('ls-remote', 'origin'), /refs\/tags\/v0\.1\.0/);
});

test('native signing failure preserves signing settings without creating a tag or pushing', (t) => {
  const f = fixture(t); const key = join(f.base, 'missing-key');
  f.git('config', 'gpg.format', 'ssh'); f.git('config', 'user.signingkey', key); f.git('config', 'commit.gpgsign', 'true');
  const head = f.git('rev-parse', 'HEAD'); const r = f.cli(['0.1.0', '--first-release']);
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.equal(f.git('rev-parse', 'HEAD'), head); assert.equal(f.git('tag'), '');
  assert.equal(f.git('config', '--get', 'commit.gpgsign'), 'true');
  assert.equal(f.git('config', '--get', 'user.signingkey'), key);
  assert.equal(f.git('ls-remote', 'origin'), '', r.stdout + r.stderr);
  assert.ok(f.requests().every((request) => request.method === 'GET'));
});

test('native GitHub API failure retains the already pushed release commit and tag', (t) => {
  const f = fixture(t); const r = f.cli(['0.1.0', '--first-release'], { API_FAIL: '1' });
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /Fixture GitHub unavailable/);
  assert.equal(f.git('log', '-1', '--format=%s'), 'chore: release v0.1.0');
  const head = f.git('rev-parse', 'HEAD');
  assert.equal(f.git('rev-parse', 'v0.1.0^{commit}'), head);
  assert.equal(f.git('ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0], head);
  assert.equal(f.git('ls-remote', 'origin', 'refs/tags/v0.1.0^{}').split(/\s/)[0], head);
  assert.equal(f.git('status', '--porcelain'), '');
  assert.equal(f.requests().filter((request) => request.method === 'POST').length, 1);
  assert.doesNotMatch(r.stdout + r.stderr, /fixture-secret-token/);
});

test('native preid creates a prerelease and explicit stable target publishes the candidate changes', (t) => {
  const f = fixture(t); let r = f.cli(['0.1.0', '--first-release']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  f.commit('fix(route): retain candidate input');
  r = f.cli(['--preid=rc']); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(f.git('show', 'v0.1.1-rc.0:package.json')).version, '0.1.1-rc.0');
  r = f.cli(['0.1.1']); assert.equal(r.status, 0, r.stdout + r.stderr);
  const posts = f.requests().filter((request) => request.method === 'POST');
  assert.equal(posts.length, 3);
  assert.equal(posts[1].body.tag_name, 'v0.1.1-rc.0'); assert.equal(posts[1].body.prerelease, true);
  assert.equal(posts[1].body.make_latest, 'legacy');
  assert.equal(posts[2].body.tag_name, 'v0.1.1'); assert.equal(posts[2].body.prerelease, false);
  assert.match(posts[2].body.body, /retain candidate input/);
  assert.doesNotMatch(posts[2].body.body, /preserve point order/);
});
