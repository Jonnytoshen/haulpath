import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

if (process.argv.includes('--help')) {
  console.log(`Docker 验收：默认执行原生架构完整套件。
  --matrix                 顺序执行 linux/amd64 和 linux/arm64 核心验收
  --platform linux/amd64   指定单个目标架构（也支持 linux/arm64）
  --core                   仅执行核心运行、HTTP、导出和持久化验收
其他参数交给 Node 测试入口，例如 --test-name-pattern。`);
  process.exit(0);
}

try {
  const nodeArguments = [];
  let matrix = false;
  let core = false;
  let platform = process.env.HAULPATH_DOCKER_TEST_PLATFORM;
  let explicitPlatform = false;
  for (let index = 2; index < process.argv.length; index++) {
    const argument = process.argv[index];
    if (argument === '--matrix') matrix = true;
    else if (argument === '--core') core = true;
    else if (argument === '--platform') { platform = process.argv[++index]; explicitPlatform = true; }
    else nodeArguments.push(argument);
  }
  if ((explicitPlatform || platform) && !['linux/amd64', 'linux/arm64'].includes(platform)) {
    throw new Error('目标架构仅支持 linux/amd64 或 linux/arm64。');
  }
  if (matrix && explicitPlatform) throw new Error('--matrix 与 --platform 不能同时使用。');
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
    .filter((name) => name.endsWith('.test.mjs') && (!(core || matrix) || ['runtime.test.mjs', 'core.test.mjs'].includes(name)))
    .sort().map((name) => `tests/docker/${name}`);
  let child;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child?.kill(signal));
  for (const target of matrix ? ['linux/amd64', 'linux/arm64'] : [platform]) {
    console.log(`执行 ${target ?? '原生架构'} ${core || matrix ? '核心' : '完整'} Docker 验收`);
    const environment = { ...process.env };
    if (target) environment.HAULPATH_DOCKER_TEST_PLATFORM = target;
    const code = await new Promise((resolve, reject) => {
      child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...nodeArguments, ...files], {
        cwd: root, stdio: 'inherit', env: environment,
      });
      child.once('error', reject);
      child.once('exit', (value) => resolve(value ?? 1));
    });
    if (code !== 0) { process.exitCode = code; break; }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
