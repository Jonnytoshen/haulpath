import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { callerEnvironment } from '../../scripts/workspace-environment.mjs';

export function copyReleaseWorkspace(root, directory) {
  for (const file of ['pnpm-lock.yaml', 'tsconfig.base.json']) cpSync(join(root, file), join(directory, file));
  writeFileSync(join(directory, 'pnpm-workspace.yaml'), readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8') + '\nverifyDepsBeforeRun: false\n');
  for (const project of ['apps/web', 'packages/domain']) {
    mkdirSync(join(directory, project), { recursive: true });
    cpSync(join(root, project, 'package.json'), join(directory, project, 'package.json'));
    cpSync(join(root, project, 'src'), join(directory, project, 'src'), { recursive: true });
  }
}

export function releaseFixtureEnvironment(extra = {}) {
  const environment = Object.fromEntries(Object.entries(callerEnvironment()).filter(([key]) => !key.startsWith('NX_') && key !== 'HAULPATH_INTERNAL_CALLER_ENV'));
  return { ...environment, NX_DAEMON: 'false', NX_ISOLATE_PLUGINS: 'false', ...extra };
}
