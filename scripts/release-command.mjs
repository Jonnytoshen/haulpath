import { resolve } from 'node:path';
import { callerEnvironment } from './workspace-environment.mjs';
import { runProcess } from './process.mjs';

const [command, ...args] = process.argv.slice(2);
const scripts = { release: 'release.mjs', 'release:resume': 'release-resume.mjs' };
if (!scripts[command]) throw new Error(`Unknown release command: ${command}`);
// Nx prepends its Node directory to PATH. Restore the original caller's package
// manager and environment before a release launches its own public quality gates.
runProcess(process.execPath, [resolve(import.meta.dirname, scripts[command]), ...args], {
  cwd: resolve(import.meta.dirname, '..'),
  env: callerEnvironment(),
});
