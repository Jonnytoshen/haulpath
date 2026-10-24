import { protectOutput } from './release/output.mjs';
import { github, repository, taggedRelease } from './release/github.mjs';
import { verifyRemoteTag } from './release/remote.mjs';
protectOutput();
try {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const tags = args.filter(arg => arg !== '--dry-run');
  if (tags.length !== 1 || args.length !== 1 + Number(dryRun)) throw new Error('Usage: release:resume <target-tag> [--dry-run]');
  const tag = tags[0];
  const release = taggedRelease(tag);
  verifyRemoteTag(tag, release.commit);
  const repo = repository();
  if (dryRun) console.log(`Preview resume: ${tag}\n${release.notes}\nPlan: create missing GitHub Release only; keep existing releases unchanged.`);
  else {
    const api = github(repo);
    await api.preflight();
    const result = await api.publish(tag, release.notes);
    console.log(`${result.existing ? 'Existing Release retained' : 'Published'} ${tag}: ${result.url}`);
  }
} catch (error) { console.error(`Release resume failed: ${error.message}`); process.exitCode = 1; }
