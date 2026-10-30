import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { docker, nativePlatform, root } from './helpers/application.mjs';

const run = promisify(execFile);

test('the build stage excludes local configuration, databases, backups and generated files', { timeout: 1200000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'haulpath-test-context-'));
  const image = `haulpath-test-context-${process.pid}-${randomUUID().slice(0, 8)}:test`;
  const sentinels = [
    ...['', 'apps/web/', 'packages/domain/'].flatMap((prefix) => [
      '.env.local', 'src/.env.build-sentinel', 'src/local.sqlite', 'src/local.sqlite-wal',
      'src/local.sqlite-shm', 'src/local.sqlite3', 'src/local.sqlite3-journal',
      'src/local.db', 'src/local.db-wal', 'node_modules/context-sentinel',
      '.next/context-sentinel', 'dist/context-sentinel',
    ].map((relative) => `${prefix}${relative}`)),
    'data/haulpath.sqlite', 'backups/context-sentinel',
    '.scratch/context-sentinel', 'tests/context-sentinel',
  ];
  try {
    const files = (await run('git', ['ls-files', '-z'], { cwd: root })).stdout.split('\0').filter(Boolean);
    for (const relative of files) {
      // Test fixtures never read an operator's credentials or local database, even if accidentally tracked.
      if (relative.split('/').some((part) => part.startsWith('.env')) || /\.(?:sqlite3?|db)(?:-|$)/.test(relative)) continue;
      const target = join(directory, relative);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(root, relative), target);
    }
    for (const relative of sentinels) {
      const target = join(directory, relative);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, 'HAULPATH_CONTEXT_SENTINEL=not-a-real-secret\n');
    }
    await docker(['build', '--platform', await nativePlatform(), '--target', 'build', '--tag', image, '.'], { cwd: directory, timeout: 900000 });
    const check = `const fs=require('node:fs'); const unexpected=${JSON.stringify(sentinels)}.filter(path=>fs.existsSync('/app/'+path)); if(unexpected.length) { console.error(unexpected.join('\\n')); process.exit(1); } console.log('local files absent from build stage');`;
    const result = await docker(['run', '--rm', '--entrypoint', 'node', image, '--eval', check]);
    assert.match(result.stdout, /local files absent from build stage/);
  } finally {
    await docker(['image', 'rm', image]).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
