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

test('Docker acceptance explains native and two-architecture modes without requiring an engine', () => {
  const result = spawnSync(process.execPath, ['scripts/test-docker.mjs', '--help'], {
    env: { ...process.env, PATH: '' }, encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--matrix/);
  assert.match(result.stdout, /--platform linux\/amd64/);
  assert.match(result.stdout, /--core/);
});

test('Docker acceptance rejects an unsupported target before starting any containers', () => {
  const result = spawnSync(process.execPath, ['scripts/test-docker.mjs', '--platform', 'linux/riscv64', '--core'], {
    env: { ...process.env, PATH: '' }, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /目标架构仅支持 linux\/amd64 或 linux\/arm64/);
});
