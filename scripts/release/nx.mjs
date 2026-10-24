import { ReleaseClient } from 'nx/release';
import { readFileSync } from 'node:fs';
export const releaseConfig = () => JSON.parse(readFileSync('nx.json', 'utf8')).release;
export const readOnlyGit = { dryRun: true, stageChanges: false, gitCommit: false, gitTag: false, gitPush: false };
export async function previewChangelog(plan) {
  const client = new ReleaseClient(releaseConfig(), true);
  const result = await client.releaseChangelog({ ...readOnlyGit, version: plan.version,
    firstRelease: plan.firstRelease, from: plan.stableTag ?? undefined, to: 'HEAD', createRelease: false });
  return result.workspaceChangelog?.contents ?? '';
}
export async function probeVersion(preid = '') {
  const config = releaseConfig();
  config.releaseTag.strictPreid = true;
  config.releaseTag.checkAllBranchesWhen = false;
  const client = new ReleaseClient(config, true);
  const result = await client.releaseVersion({ ...readOnlyGit, preid, firstRelease: false });
  return result.workspaceVersion;
}
