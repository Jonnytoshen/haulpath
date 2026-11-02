import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import * as prettier from 'prettier';

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

try {
  process.chdir(git('rev-parse', '--show-toplevel').trimEnd());
  const paths = git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z')
    .split('\0')
    .filter(Boolean);
  let failed = false;
  for (const path of paths) {
    const entry = git('ls-files', '--stage', '-z', '--', `:(literal)${path}`).split('\0')[0];
    const [mode, object, stage] = entry.slice(0, entry.indexOf('\t')).split(' ');
    if (stage !== '0' || !['100644', '100755'].includes(mode)) continue;
    const filepath = resolve(path);
    const info = await prettier.getFileInfo(filepath, {
      ignorePath: ['.gitignore', '.prettierignore'],
      withNodeModules: false,
      resolveConfig: true,
    });
    if (info.ignored || !info.inferredParser) continue;
    const config = await prettier.resolveConfig(filepath, { editorconfig: true });
    const content = git('cat-file', 'blob', object);
    if (!(await prettier.check(content, { ...config, filepath }))) {
      console.error(`格式不符合约定：${JSON.stringify(path)}`);
      failed = true;
    }
  }
  if (failed) {
    console.error(
      '请运行 pnpm run format，核对修改后重新暂存所需内容。部分暂存文件请手动核对，不要直接暂存整文件。',
    );
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`暂存区格式检查失败：${error.message}`);
  process.exitCode = 1;
}
