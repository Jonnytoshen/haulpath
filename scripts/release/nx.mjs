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

export async function writeRelease(plan) {
  const config = releaseConfig();
  config.git = { ...config.git, commit: true, tag: true, push: false, commitMessage: 'chore: release v{version}' };
  config.changelog.workspaceChangelog.createRelease = false;
  const client = new ReleaseClient(config, true);
  // Use only local version/changelog APIs: the registry publisher is never called.
  const result = await client.releaseVersion({ specifier: plan.version, firstRelease: plan.firstRelease,
    dryRun: false, stageChanges: true, gitCommit: false, gitTag: false, gitPush: false, skipPublish: true });
  if (result.workspaceVersion !== plan.version) throw new Error('Nx version differs from frozen release plan');
  await client.releaseChangelog({ version: plan.version, versionData: result.projectsVersionData,
    releaseGraph: result.releaseGraph, firstRelease: plan.firstRelease, from: plan.stableTag ?? undefined,
    to: plan.head, dryRun: false, stageChanges: true, gitCommit: true, gitTag: true, gitPush: false,
    gitCommitMessage: 'chore: release v{version}', createRelease: false, skipPublish: true });
}
