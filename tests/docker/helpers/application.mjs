import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';

const run = promisify(execFile);
export const root = fileURLToPath(new URL('../../../', import.meta.url));

export async function docker(args, { input, ...options } = {}) {
  const promise = run('docker', args, { cwd: root, timeout: 120000, maxBuffer: 20_000_000, ...options });
  if (input !== undefined) promise.child.stdin.end(input);
  return promise;
}

export async function nativePlatform() {
  const { stdout } = await docker(['version', '--format', '{{.Server.Arch}}']);
  const arch = stdout.trim();
  if (!['amd64', 'arm64'].includes(arch)) throw new Error(`Docker 验收暂不支持宿主架构 ${arch}`);
  return `linux/${arch}`;
}

export async function createDockerApplication({
  platform = process.env.HAULPATH_DOCKER_TEST_PLATFORM,
  environment = {}, build = true, restart, autoStart = true,
} = {}) {
  platform ??= await nativePlatform();
  if (!['linux/amd64', 'linux/arm64'].includes(platform)) throw new Error(`不支持的测试平台：${platform}`);
  const projectName = `haulpath-test-${process.pid}-${randomUUID().slice(0, 8)}`;
  const directory = await mkdtemp(join(tmpdir(), `${projectName}-`));
  const environmentFile = join(directory, 'docker.env');
  const overrideFile = join(directory, 'compose.test.json');
  const image = `${projectName}:test`;
  const childEnvironment = {
    ...process.env,
    AMAP_WEB_SERVICE_KEY: '', AMAP_JS_KEY: '', AMAP_JS_SECURITY_CODE: '',
    HAULPATH_PORT: '0', HAULPATH_IMAGE: image,
  };
  let appEnvironment = { ...environment };
  let baseUrl;
  await writeFile(environmentFile, `HAULPATH_IMAGE=${image}\nHAULPATH_PORT=0\nAMAP_WEB_SERVICE_KEY=\nAMAP_JS_KEY=\nAMAP_JS_SECURITY_CODE=\n`);
  async function writeOverride() {
    await writeFile(overrideFile, JSON.stringify({ services: { app: { platform, environment: appEnvironment, ...(restart ? { restart } : {}) } } }));
  }
  await writeOverride();
  const composeArgs = ['compose', '--project-name', projectName, '--env-file', environmentFile, '--file', join(root, 'compose.yaml'), '--file', overrideFile];
  const compose = (args, options = {}) => docker([...composeArgs, ...args], { env: childEnvironment, ...options });
  const containerId = async () => (await compose(['ps', '--all', '--quiet', 'app'])).stdout.trim();
  async function waitReady() {
    const id = await containerId();
    const { stdout } = await docker(['port', id, '3000/tcp']);
    baseUrl = `http://${stdout.trim().split('\n')[0]}`;
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        const response = await fetch(`${baseUrl}/api/projects`, { signal: AbortSignal.timeout(1000) });
        if (response.ok && Array.isArray(await response.json())) return;
      } catch { /* The server or its published port may still be starting. */ }
      await setTimeout(250);
    }
    throw new Error(`容器应用未就绪：\n${(await compose(['logs', '--no-color', 'app'])).stdout}`);
  }
  async function start({ recreate = false } = {}) {
    await compose(['up', '--detach', '--wait', '--wait-timeout', '180', ...(recreate ? ['--force-recreate'] : []), 'app']);
    await waitReady();
  }
  async function cleanup() {
    try { await compose(['down', '--volumes', '--remove-orphans', '--timeout', '10']); }
    finally {
      await docker(['image', 'rm', image]).catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  }
  try {
    if (build) {
      console.log(`构建 Docker 验收镜像：${platform}`);
      await compose(['build', 'app'], { timeout: 900000 });
    }
    if (autoStart) await start();
  } catch (error) {
    await cleanup().catch(() => {});
    throw error;
  }
  return {
    get baseUrl() { return baseUrl; }, directory, projectName, environmentFile, image, platform,
    compose, containerId, start, waitReady, cleanup,
    exec: (args, options = {}) => compose(['exec', '--no-TTY', 'app', ...args], options),
    stop: () => compose(['stop', 'app']),
    async restart() { await compose(['restart', 'app']); await waitReady(); },
    async recreate(nextEnvironment = appEnvironment) {
      appEnvironment = { ...nextEnvironment };
      await writeOverride();
      await start({ recreate: true });
    },
    logs: () => compose(['logs', '--no-color', 'app']),
  };
}
