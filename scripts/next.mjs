import { applicationDependency, prepareNextCommand } from './next-command.mjs';
import { runProcess } from './process.mjs';

const [command, ...args] = process.argv.slice(2);
const prepared = prepareNextCommand(command === 'typecheck' ? 'typegen' : command, args);
const child = runProcess(prepared.file, prepared.args, prepared);
if (command === 'typecheck') {
  child.once('exit', (code) => {
    if (code === 0) runProcess(process.execPath, [applicationDependency('typescript/bin/tsc'), '--noEmit'], { cwd: new URL('../apps/web/', import.meta.url), env: prepared.env });
  });
}
