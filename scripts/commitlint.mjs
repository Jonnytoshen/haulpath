import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const args = process.argv.slice(2);
const require = createRequire(import.meta.url);

// commitlint drops blank --edit messages before running any configured rule.
// Guard that one input gap, then delegate all validation to the real CLI.
function option(names) {
  let result;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const name = names.find((candidate) => arg === candidate || arg.startsWith(`${candidate}=`));
    if (!name) continue;
    result = arg === name
      ? (args[index + 1] && !args[index + 1].startsWith('-') ? args[index + 1] : '')
      : arg.slice(name.length + 1);
  }
  return result;
}

try {
  const cwd = resolve(option(['--cwd', '-d']) || process.cwd());
  const edit = option(['--edit', '-e']);
  if (edit !== undefined) {
    const git = (...gitArgs) => spawnSync('git', gitArgs, { cwd, encoding: 'utf8' });
    const path = edit || git('rev-parse', '--git-path', 'COMMIT_EDITMSG').stdout.trim();
    const message = readFileSync(resolve(cwd, path), 'utf8');
    const comment = git('config', '--get', 'core.commentChar').stdout.trim() || '#';
    const content = message.split(/\r?\n/).filter((line) => !line.startsWith(comment)).join('\n');
    if (!content.trim()) {
      console.error('✖ commit message must not be empty; add type(scope): summary [project-message-empty]');
      process.exit(3);
    }
  }
  const pkgPath = require.resolve('@commitlint/cli/package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const result = spawnSync(process.execPath, [resolve(dirname(pkgPath), pkg.bin.commitlint), ...args], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
} catch (error) {
  console.error(`✖ unable to read or validate commit message: ${error.message}`);
  process.exit(1);
}
