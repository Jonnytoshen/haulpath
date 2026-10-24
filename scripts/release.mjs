import { protectOutput } from './release/output.mjs';
protectOutput();
import { createReleasePlan, parseReleaseArgs, git } from './release/plan.mjs';
import { executeRelease } from './release/execute.mjs';
import { previewChangelog } from './release/nx.mjs';
try {
  const options = parseReleaseArgs(process.argv.slice(2));
  if (!options.dryRun && (git('branch', '--show-current') !== 'main' || git('status', '--porcelain'))) throw new Error('Release requires a clean main worktree');
  const plan = await createReleasePlan(options);
  if (plan.skipped) { console.log('Skipped: no effective version changes.'); process.exit(0); }
  if (!options.dryRun) { await executeRelease(plan); process.exit(0); }
  const notes = await previewChangelog(plan);
  console.log(`Preview: ${plan.version} (${plan.tag})\n${notes}\nPlan: validate, version, changelog, commit, tag, atomic push main + target tag, GitHub Release. Registry publication is disabled.`);
} catch (error) { console.error(`Release failed: ${error.message}`); process.exitCode = 1; }
