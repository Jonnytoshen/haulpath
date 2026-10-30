import { spawn } from 'node:child_process';
import { constants } from 'node:os';

export function runProcess(file, args, options = {}) {
  const child = spawn(file, args, { stdio: 'inherit', ...options });
  const handlers = new Map(['SIGINT', 'SIGTERM'].map((signal) => {
    const handler = () => child.kill(signal);
    process.on(signal, handler);
    return [signal, handler];
  }));
  child.once('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    for (const [name, handler] of handlers) process.removeListener(name, handler);
    process.exitCode = code ?? 128 + (constants.signals[signal] ?? 1);
  });
  return child;
}
