import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('Docker acceptance reports a missing Docker command as failure instead of skipping tests', () => {
  const result = spawnSync(process.execPath, ['scripts/test-docker.mjs'], {
    env: { ...process.env, PATH: '' }, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Docker 命令不可用/);
  assert.doesNotMatch(result.stdout, /pass|跳过|skipped/);
});
