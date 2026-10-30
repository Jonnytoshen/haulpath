import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { callerEnvironment, snapshotVariable } from './workspace-environment.mjs';

const require = createRequire(import.meta.url);
export const workspaceRoot = resolve(import.meta.dirname, '..');
export const applicationRoot = resolve(workspaceRoot, 'apps/web');
const applicationRequire = createRequire(resolve(applicationRoot, 'package.json'));

// Shared with real-application tests, which spawn this Next CLI directly so the
// production process they SIGKILL is the service rather than a task launcher.
export function prepareNextCommand(command, args = [], environment = process.env) {
  const previousEnvironment = process.env;
  let prepared;
  try {
    process.env = callerEnvironment(environment);
    process.env.NODE_ENV ??= command === 'dev' ? 'development' : 'production';
    // Each preparation has an independent initialEnv, including repeated test
    // starts with different overrides. Next itself starts in a fresh process.
    delete require.cache[require.resolve('@next/env')];
    require('@next/env').loadEnvConfig(workspaceRoot, command === 'dev');
    prepared = { ...process.env };
  } finally {
    process.env = previousEnvironment;
  }
  delete prepared[snapshotVariable];
  prepared.HAULPATH_DB_PATH = resolve(workspaceRoot, prepared.HAULPATH_DB_PATH || 'data/haulpath.sqlite');
  const defaults = command === 'dev' || command === 'start' ? ['--hostname', '127.0.0.1'] : command === 'build' ? ['--webpack'] : [];
  return { file: process.execPath, args: [applicationRequire.resolve('next/dist/bin/next'), command, applicationRoot, ...defaults, ...args], cwd: workspaceRoot, env: prepared };
}

export function applicationDependency(name) {
  return applicationRequire.resolve(name);
}
