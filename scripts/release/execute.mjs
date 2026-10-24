import { spawnSync } from 'node:child_process';
import { writeRelease } from './nx.mjs';
import { github, repository, taggedRelease } from './github.mjs';
import { preflightGit } from './remote.mjs';
import { redact } from './output.mjs';
import { git } from './plan.mjs';
function command(file, args) {
  const result = spawnSync(file, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.stdout) process.stdout.write(redact(result.stdout));
  if (result.stderr) process.stderr.write(redact(result.stderr));
  if (result.error || result.status !== 0) throw new Error(`${file} ${args.join(' ')} failed`);
}
export async function executeRelease(plan) {
  let stage = 'preflight';
  let pushed = false;
  const completed = [];
  try {
    if (git('branch', '--show-current') !== 'main' || git('status', '--porcelain')) throw new Error('Release requires a clean main worktree');
    const api = github(repository());
    preflightGit(plan);
    await api.preflight();
    completed.push('Git/API preflight');
    stage = 'quality gates';
    const history = ['run', 'commitlint', ...(plan.stableTag ? ['--from', plan.stableTag] : []), '--to', plan.head];
    command('pnpm', history);
    completed.push('commit history validation');
    for (const gate of ['typecheck', 'build', 'test']) {
      console.log(`Running quality gate: ${gate}`);
      command('pnpm', ['run', gate]);
      completed.push(gate);
    }
    if (git('rev-parse', 'HEAD') !== plan.head || git('status', '--porcelain')) throw new Error('HEAD or worktree changed during quality gates');
    stage = 'local Nx version/changelog/commit/tag';
    await writeRelease(plan);
    const release = taggedRelease(plan.tag);
    completed.push(`local release commit and ${plan.tag}`);
    stage = 'atomic push';
    command('git', ['-c', 'push.followTags=false', 'push', '--atomic', 'origin', 'refs/heads/main:refs/heads/main', `refs/tags/${plan.tag}:refs/tags/${plan.tag}`]);
    pushed = true;
    completed.push('main and target tag atomic push');
    stage = 'GitHub Release';
    const result = await api.publish(plan.tag, release.notes);
    completed.push('GitHub Release');
    console.log(`Published ${plan.tag}: ${result.url}\nCompleted: ${completed.join(', ')}.`);
  } catch (error) {
    let state = `Failed stage: ${stage}. Completed: ${completed.join(', ') || 'none'}.`;
    if (pushed) state += ` Main and ${plan.tag} were pushed. Run: pnpm run release:resume ${plan.tag}`;
    else if (stage === 'atomic push') state += ` Local release commit and ${plan.tag} retained. Check remote refs, then run: git -c push.followTags=false push --atomic origin refs/heads/main:refs/heads/main refs/tags/${plan.tag}:refs/tags/${plan.tag}; then pnpm run release:resume ${plan.tag}`;
    else if (stage.startsWith('local Nx')) state += ` Inspect git status, HEAD and refs/tags/${plan.tag}; local changes may remain. Resolve the failed commit/signing/tag step before any push; do not rerun release blindly.`;
    else state += ' No release files, commits or tags were generated.';
    throw new Error(`${error.message}\n${state}`);
  }
}
