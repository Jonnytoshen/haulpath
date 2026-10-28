import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

try {
  let engine;
  try {
    engine = (await run('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 15000 })).stdout.trim();
  } catch (error) {
    throw new Error(error.code === 'ENOENT'
      ? 'Docker 命令不可用，请先安装 Docker Engine 28+ 或对应 Docker Desktop。'
      : 'Docker Engine 不可用，请启动 Docker 并确认当前连接后重试。');
  }
  if (Number(engine.split('.')[0]) < 28) throw new Error('Docker 验收需要 Docker Engine 28 或更高版本。');
  let compose;
  try {
    compose = (await run('docker', ['compose', 'version', '--short'], { timeout: 15000 })).stdout.trim().replace(/^v/, '');
  } catch {
    throw new Error('Docker Compose 不可用，请安装 Compose 2.30+。');
  }
  const [major, minor] = compose.split('.').map(Number);
  if (major < 2 || (major === 2 && minor < 30)) throw new Error('Docker 验收需要 Compose 2.30 或更高版本。');
  console.log(`Docker Engine ${engine}；Compose ${compose}`);
  const files = (await readdir(new URL('../tests/docker/', import.meta.url)))
    .filter((name) => name.endsWith('.test.mjs')).sort().map((name) => `tests/docker/${name}`);
  const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...process.argv.slice(2), ...files], { cwd: root, stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code) => { process.exitCode = code ?? 1; });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
