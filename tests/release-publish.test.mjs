import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, symlinkSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { copyReleaseWorkspace, releaseFixtureEnvironment } from './helpers/release-workspace.mjs';
const root = resolve(import.meta.dirname, '..');
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'haulpath-publish-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, 'repo'); mkdirSync(dir);
  for (const file of ['scripts', 'nx.json', 'commitlint.config.mjs', '.husky', 'pnpm-lock.yaml']) cpSync(join(root, file), join(dir, file), { recursive: true });
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
  copyReleaseWorkspace(root, dir);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json')));
  pkg.version = '0.1.0';
  for (const gate of ['typecheck', 'build', 'test']) pkg.scripts[gate] = `node gate.cjs ${gate}`;
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n.nx/\n');
  writeFileSync(join(dir, 'gate.cjs'), `const fs = require('node:fs'); fs.mkdirSync('.nx',{recursive:true}); fs.appendFileSync('.nx/gates',process.argv[2]+'\\n'); if(process.env.FAIL_GATE===process.argv[2])process.exit(1); if(process.env.DIRTY_GATE===process.argv[2])fs.writeFileSync('unexpected.txt','changed');`);
  const git = (...args) => { const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git('init', '-b', 'main'); git('config', 'user.name', 'Release test'); git('config', 'user.email', 'release@example.invalid'); git('config', 'commit.gpgsign', 'false');
  let n = 0;
  const commit = (message) => { writeFileSync(join(dir, 'change.txt'), String(++n)); git('add', '.'); git('commit', '-m', message); };
  commit('feat(route): preserve point order');
  git('init', '--bare', join(base, 'remote.git')); git('remote', 'add', 'origin', 'https://github.com/example/haulpath.git');
  git('config', `url.${join(base, 'remote.git')}.insteadOf`, 'https://github.com/example/haulpath.git');
  const preload = join(base, 'api.mjs');
  writeFileSync(preload, `import fs from 'node:fs'; globalThis.fetch=async(url,options={})=>{ fs.appendFileSync(${JSON.stringify(join(base,'requests'))},JSON.stringify({url,method:options.method??'GET',body:options.body&&JSON.parse(options.body)})+'\\n'); const fail=process.env.API_FAIL; let status=200, data={permissions:{push:true}}; if(url.endsWith('/releases/latest')){status=process.env.API_LATEST?200:404;data={tag_name:process.env.API_LATEST};} else if(url.includes('/releases/tags/')){status=process.env.API_EXISTING?200:404;data={body:'Manually edited release notes',html_url:'https://github.com/example/haulpath/releases/tag/v0.1.0'};} else if(options.method==='POST'){status=fail?503:201;data={html_url:'https://github.com/example/haulpath/releases/tag/'+JSON.parse(options.body).tag_name};} return new Response(JSON.stringify(data),{status}); };`);
  const cli = (args, env = {}, script = 'scripts/release.mjs') => spawnSync(process.execPath, ['--import', preload, script, ...args], { cwd: dir, encoding: 'utf8', timeout: 60000, env: releaseFixtureEnvironment({ GITHUB_TOKEN:'fixture-secret-token', GH_TOKEN:'', ...env }) });
  return { dir, base, git, commit, cli };
}
test('failed quality gate stops before release writes and preserves the frozen input', (t) => {
  const f = fixture(t); const head = f.git('rev-parse', 'HEAD');
  const r = f.cli(['--first-release'], { FAIL_GATE:'build' });
  assert.notEqual(r.status, 0); assert.match(r.stdout+r.stderr, /build/);
  assert.equal(readFileSync(join(f.dir,'.nx/gates'),'utf8'),'typecheck\nbuild\n');
  assert.equal(f.git('rev-parse','HEAD'),head); assert.equal(f.git('tag'),''); assert.equal(f.git('status','--porcelain'),'');
});
test('first release writes one Nx release commit and annotated tag then pushes only main and that tag', (t) => {
  const f = fixture(t); f.git('tag','-a','private-local-tag','-m','Local-only annotated tag');
  const r = f.cli(['--first-release']);
  assert.equal(r.status,0,r.stdout+r.stderr);
  assert.equal(f.git('log','-1','--format=%s'),'chore: release v0.1.0');
  assert.equal(f.git('cat-file','-t','v0.1.0'),'tag');
  assert.equal(f.git('status','--porcelain'),'');
  assert.equal(f.git('ls-remote','--tags','origin').includes('private-local-tag'),false);
  assert.match(f.git('ls-remote','origin','refs/heads/main','refs/tags/v0.1.0'),/refs\/tags\/v0.1.0/);
  const requests = readFileSync(join(f.base,'requests'),'utf8').trim().split('\n').map(JSON.parse);
  const body = requests.find(r=>r.method==='POST').body;
  assert.equal(body.tag_name,'v0.1.0'); assert.equal(body.prerelease,false); assert.equal(body.make_latest,'true');
  assert.match(body.body,/preserve point order/); assert.match(r.stdout,/Published/);
});
test('preflight rejects missing API credentials and remote tag conflicts before running quality gates', (t) => {
  const f = fixture(t); const head=f.git('rev-parse','HEAD');
  let r=f.cli(['--first-release'],{GITHUB_TOKEN:'',GH_TOKEN:''});
  assert.notEqual(r.status,0); assert.match(r.stderr,/API authentication/);
  assert.equal(f.git('rev-parse','HEAD'),head); assert.equal(f.git('tag'),'');
  f.git('tag','v0.1.0'); f.git('push','origin','refs/tags/v0.1.0'); f.git('tag','-d','v0.1.0');
  r=f.cli(['--first-release']); assert.notEqual(r.status,0); assert.match(r.stderr,/remote.*tag/i);
  assert.equal(f.git('rev-parse','HEAD'),head);
});
test('API failure preserves the published tag and resume uses immutable migration notes after main advances', (t) => {
  const f=fixture(t);
  f.commit('docs(storage): migrate snapshots\n\nBREAKING CHANGE: replace snapshot layout\n\n## Migration\n\n## 9.9.9\n\nKeep this entire migration paragraph.');
  const failed=f.cli(['--first-release'],{API_FAIL:'1'});
  assert.notEqual(failed.status,0); assert.match(failed.stderr,/release:resume v0.1.0/);
  const before=f.git('show-ref');
  const posts=()=>readFileSync(join(f.base,'requests'),'utf8').trim().split('\n').map(JSON.parse).filter(r=>r.method==='POST');
  const original=posts()[0].body.body;
  f.commit('fix(route): advance main after publication'); const current=f.git('show-ref');
  const r=f.cli(['v0.1.0'],{},'scripts/release-resume.mjs');
  assert.equal(r.status,0,r.stdout+r.stderr); assert.equal(f.git('show-ref'),current); assert.notEqual(before,current);
  assert.equal(posts()[1].body.body,original); assert.match(original,/## Migration[\s\S]*Keep this entire migration paragraph/);
});
test('resume keeps existing manual notes and an older stable release cannot claim Latest', (t) => {
  const f=fixture(t); assert.equal(f.cli(['--first-release']).status,0);
  const before=f.git('show-ref');
  let r=f.cli(['v0.1.0'],{API_EXISTING:'1'},'scripts/release-resume.mjs');
  assert.equal(r.status,0,r.stdout+r.stderr); assert.match(r.stdout,/Existing Release retained/);
  r=f.cli(['v0.1.0'],{API_LATEST:'v1.0.0'},'scripts/release-resume.mjs');
  assert.equal(r.status,0,r.stdout+r.stderr);
  const requests=readFileSync(join(f.base,'requests'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(requests.filter(r=>r.method==='POST').length,2);
  assert.equal(requests.filter(r=>r.method==='POST').at(-1).body.make_latest,'false');
  assert.equal(f.git('show-ref'),before);
});
test('post-gate worktree changes stop release without a tag', (t) => {
  const f=fixture(t); const head=f.git('rev-parse','HEAD');
  const r=f.cli(['--first-release'],{DIRTY_GATE:'test'});
  assert.notEqual(r.status,0); assert.match(r.stderr,/changed during quality gates/);
  assert.equal(f.git('rev-parse','HEAD'),head); assert.equal(f.git('tag'),'');
});
test('atomic push failure retains local release and gives a precise push and resume instruction without leaking secrets', (t) => {
  const f=fixture(t);
  writeFileSync(join(f.base,'remote.git/hooks/pre-receive'),'#!/bin/sh\necho fixture-secret-token >&2\nexit 1\n',{mode:0o755});
  const r=f.cli(['--first-release']);
  assert.notEqual(r.status,0); assert.match(r.stderr,/Failed stage: atomic push/); assert.match(r.stderr,/push --atomic origin refs\/heads\/main:refs\/heads\/main refs\/tags\/v0.1.0:refs\/tags\/v0.1.0/);
  assert.doesNotMatch(r.stdout+r.stderr,/fixture-secret-token/);
  assert.equal(f.git('cat-file','-t','v0.1.0'),'tag'); assert.equal(f.git('ls-remote','origin'),'');
  const requests=readFileSync(join(f.base,'requests'),'utf8'); assert.doesNotMatch(requests,/"method":"POST"/);
});
test('release uses the real commit hook and preserves SSH signing for the release commit', (t) => {
  const f=fixture(t); const key=join(f.base,'signing-key');
  const keygen=spawnSync('ssh-keygen',['-t','ed25519','-N','','-f',key],{encoding:'utf8'}); assert.equal(keygen.status,0,keygen.stderr);
  f.git('config','gpg.format','ssh'); f.git('config','user.signingkey',key); f.git('config','commit.gpgsign','true');
  const hook=join(f.base,'hooks');mkdirSync(hook);
  writeFileSync(join(hook,'commit-msg'),'#!/bin/sh\npnpm run commitlint --edit "$1" || exit $?\nprintf "checked\\n" >> .nx/hook\n',{mode:0o755});
  f.git('config','core.hooksPath',hook);
  const r=f.cli(['--first-release']); assert.equal(r.status,0,r.stdout+r.stderr);
  assert.match(f.git('cat-file','-p','HEAD'),/gpgsig -----BEGIN SSH SIGNATURE-----/);
  assert.equal(readFileSync(join(f.dir,'.nx/hook'),'utf8'),'checked\n');
  assert.equal(f.git('config','--get','commit.gpgsign'),'true');
});
test('candidate publication and promotion keep the same core and formal notes cover the full candidate cycle', (t) => {
  const f=fixture(t); let r=f.cli(['--first-release']); assert.equal(r.status,0,r.stdout+r.stderr);
  f.commit('fix(route): retain candidate input');
  r=f.cli(['--channel','rc']); assert.equal(r.status,0,r.stdout+r.stderr);
  assert.equal(JSON.parse(f.git('show','v0.1.1-rc.0:package.json')).version,'0.1.1-rc.0');
  r=f.cli([]); assert.equal(r.status,0,r.stdout+r.stderr);
  assert.equal(JSON.parse(f.git('show','v0.1.1:package.json')).version,'0.1.1');
  const posts=readFileSync(join(f.base,'requests'),'utf8').trim().split('\n').map(JSON.parse).filter(r=>r.method==='POST');
  assert.equal(posts[1].body.prerelease,true); assert.equal(posts[1].body.make_latest,'false');
  assert.match(posts[2].body.body,/retain candidate input/); assert.equal(posts[2].body.prerelease,false);
  assert.doesNotMatch(posts[2].body.body, /preserve point order/);
});
test('resume preview is read-only and rejects a remote tag that points elsewhere', (t) => {
  const f=fixture(t); assert.equal(f.cli(['--first-release']).status,0);
  const before=f.git('show-ref'); const requests=readFileSync(join(f.base,'requests'),'utf8');
  let r=f.cli(['v0.1.0','--dry-run'],{GITHUB_TOKEN:'',GH_TOKEN:''},'scripts/release-resume.mjs');
  assert.equal(r.status,0,r.stdout+r.stderr); assert.match(r.stdout,/Preview resume/);
  assert.equal(readFileSync(join(f.base,'requests'),'utf8'),requests); assert.equal(f.git('show-ref'),before);
  f.commit('docs: advance input after release');
  f.git('push','origin','HEAD:refs/tags/v0.1.0','--force');
  r=f.cli(['v0.1.0'],{},'scripts/release-resume.mjs');
  assert.notEqual(r.status,0); assert.match(r.stderr,/different commit/);
  assert.equal(readFileSync(join(f.base,'requests'),'utf8'),requests);
});
test('a signing failure stops before tag creation and never disables signing', (t) => {
  const f=fixture(t); f.git('config','gpg.format','ssh'); f.git('config','user.signingkey',join(f.base,'missing-key')); f.git('config','commit.gpgsign','true');
  const head=f.git('rev-parse','HEAD'); const r=f.cli(['--first-release']);
  assert.notEqual(r.status,0); assert.match(r.stderr,/Failed stage: local Nx/);
  assert.equal(f.git('rev-parse','HEAD'),head); assert.equal(f.git('tag'),'');
  assert.equal(f.git('config','--get','commit.gpgsign'),'true'); assert.equal(f.git('ls-remote','origin'),'');
});
test('remote divergence and embedded credentials are rejected before release writes', (t) => {
  const f=fixture(t); f.git('push','origin','main'); f.git('checkout','-b','other'); f.commit('docs: explain alternate history');
  f.git('push','origin','HEAD:refs/heads/main'); f.git('checkout','main'); f.commit('fix(route): preserve divergent input');
  let r=f.cli(['--first-release']); assert.notEqual(r.status,0); assert.match(r.stderr,/ahead or diverged/); assert.equal(f.git('tag'),'');
  f.git('remote','set-url','origin','https://user:fixture-secret-token@github.com/example/haulpath.git');
  r=f.cli(['--first-release']); assert.notEqual(r.status,0); assert.match(r.stderr,/without embedded credentials/); assert.doesNotMatch(r.stdout+r.stderr,/fixture-secret-token/);
});
test('explicit release preview never runs fixture gates, Git push hooks or GitHub requests', (t) => {
  const f=fixture(t); const head=f.git('show-ref');
  const r=f.cli(['--first-release','--dry-run']); assert.equal(r.status,0,r.stdout+r.stderr);
  assert.match(r.stdout,/Preview: 0.1.0/); assert.equal(f.git('show-ref'),head); assert.equal(f.git('ls-remote','origin'),'');
  assert.equal(f.git('status','--porcelain'),'');
  assert.equal(existsSync(join(f.base,'requests')),false);
  assert.equal(existsSync(join(f.dir,'.nx/gates')),false);
});
test('actual release rejects a non-main context even when maintenance changes would otherwise skip', (t) => {
  const f=fixture(t); f.git('tag','v0.1.0'); f.git('checkout','-b','maintenance'); f.commit('docs: explain release context');
  const r=f.cli([]); assert.notEqual(r.status,0); assert.match(r.stderr,/clean main/);
});

test('same-HEAD branch switch during gates stops before release writes or remote publication', (t) => {
  const f = fixture(t);
  const gate = join(f.dir, 'gate.cjs');
  writeFileSync(gate, readFileSync(gate, 'utf8') + "\nif(process.argv[2]==='test')require('node:child_process').execFileSync('git',['checkout','-b','release-detour']);\n");
  f.git('add', '.'); f.git('commit', '-m', 'test: simulate concurrent branch change');
  const head = f.git('rev-parse', 'HEAD');
  const r = f.cli(['--first-release']);
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /changed during quality gates/);
  assert.equal(f.git('rev-parse', 'HEAD'), head);
  assert.equal(f.git('rev-parse', 'main'), head);
  assert.equal(f.git('tag'), '');
  assert.equal(f.git('status', '--porcelain'), '');
  assert.equal(existsSync(join(f.dir, 'CHANGELOG.md')), false);
  assert.equal(f.git('ls-remote', 'origin'), '');
  assert.doesNotMatch(readFileSync(join(f.base, 'requests'), 'utf8'), /"method":"POST"/);
});

test('multi-commit first release preserves root features and migration notes in preview and published notes', (t) => {
  const f = fixture(t);
  f.git('commit', '--amend', '-m', 'feat(route): preserve point order\n\nBREAKING CHANGE: require explicit point order\n\nReview point order before importing existing routes.');
  f.commit('fix(map): restore map preview');
  const before = f.git('show-ref', '--head');
  const preview = f.cli(['--first-release', '--dry-run']);
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  for (const text of ['preserve point order', 'restore map preview', 'Review point order before importing existing routes.']) assert.ok(preview.stdout.includes(text), text);
  assert.match(preview.stdout, /Preview: 0\.1\.0/);
  assert.equal(f.git('show-ref', '--head'), before);
  assert.equal(f.git('status', '--porcelain'), '');
  assert.equal(existsSync(join(f.base, 'requests')), false);
  const actual = f.cli(['--first-release']);
  assert.equal(actual.status, 0, actual.stdout + actual.stderr);
  const notes = readFileSync(join(f.base, 'requests'), 'utf8').trim().split('\n').map(JSON.parse).find(r => r.method === 'POST').body.body;
  for (const text of ['preserve point order', 'restore map preview', 'Review point order before importing existing routes.']) assert.ok(notes.includes(text), text);
  assert.equal(f.git('rev-parse', 'main'), f.git('rev-parse', 'v0.1.0^{commit}'));
  assert.equal(f.git('rev-parse', 'main'), f.git('ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0]);
});
