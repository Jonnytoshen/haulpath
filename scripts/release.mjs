import { createReleasePlan, parseReleaseArgs } from './release/plan.mjs';
import { previewChangelog } from './release/nx.mjs';
try {
  const options = parseReleaseArgs(process.argv.slice(2));
  if (!options.dryRun) throw new Error('Actual release execution is not implemented yet; use --dry-run.');
  const plan = await createReleasePlan(options);
  if (plan.skipped) { console.log('Skipped: no effective version changes.'); process.exit(0); }
  const notes = await previewChangelog(plan);
  console.log(`Preview: ${plan.version} (${plan.tag})\n${notes}\nPlan: validate, version, changelog, commit, tag, atomic push main + target tag, GitHub Release. Registry publication is disabled.`);
} catch (error) { console.error(`Release failed: ${error.message}`); process.exitCode = 1; }
