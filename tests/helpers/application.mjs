import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { createServer } from 'node:net';
import { prepareNextCommand } from '../../scripts/next-command.mjs';
import { callerEnvironment } from '../../scripts/workspace-environment.mjs';

export async function startApplication(extraEnvironment = {}, existingDirectory, { mode = 'dev' } = {}) {
  const directory = existingDirectory ?? await mkdtemp(join(tmpdir(), 'haulpath-test-'));
  const port = await new Promise((resolve, reject) => {
    const socket = createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address();
      socket.close(() => resolve(address.port));
    });
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const command = prepareNextCommand(mode, ['--port', String(port)], { ...callerEnvironment(), NEXT_TELEMETRY_DISABLED: '1', HAULPATH_DB_PATH: join(directory, 'test.sqlite'), ...extraEnvironment });
  const server = spawn(command.file, command.args, {
    cwd: command.cwd,
    env: command.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  server.stdout.on('data', (chunk) => { output += chunk; });
  server.stderr.on('data', (chunk) => { output += chunk; });
  async function stop(signal = 'SIGTERM') {
    if (server.exitCode === null && server.signalCode === null) {
      server.kill(signal);
      await new Promise((resolve) => server.once('exit', resolve));
    }
  }
  for (let attempt = 0; attempt < 180; attempt++) {
    if (server.exitCode !== null) throw new Error(`Application exited before readiness:\n${output}`);
    try {
      await fetch(`${baseUrl}/api/projects`, { signal: AbortSignal.timeout(1000) });
      return { baseUrl, directory, stop, cleanup: () => rm(directory, { recursive: true, force: true }), logs: () => output };
    } catch { await setTimeout(250); }
  }
  await stop();
  throw new Error(`Application did not become ready:\n${output}`);
}

export async function jsonRequest(baseUrl, path, method = 'GET', body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
}
