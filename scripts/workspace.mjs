import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { callerEnvironment, snapshotVariable } from './workspace-environment.mjs';
import { runProcess } from './process.mjs';

const require = createRequire(import.meta.url);
const [command, ...args] = process.argv.slice(2);
const applicationCommands = ['dev', 'start', 'build', 'typecheck'];
const rootCommands = ['test', 'test:api', 'test:browser', 'test:commits', 'test:release', 'test:workspace'];
if (![...applicationCommands, ...rootCommands].includes(command)) throw new Error(`Unknown workspace command: ${command}`);
const target = `${applicationCommands.includes(command) ? '@haulpath/web' : 'haulpath'}:${command.replaceAll(':', '-')}`;
const originalEnvironment = callerEnvironment();
runProcess(process.execPath, [require.resolve('nx/bin/nx'), 'run', target, '--outputStyle=stream', ...args], {
  cwd: resolve(import.meta.dirname, '..'),
  env: {
    ...process.env,
    NX_LOAD_DOT_ENV_FILES: 'false',
    [snapshotVariable]: Buffer.from(JSON.stringify(originalEnvironment)).toString('base64'),
  },
});
