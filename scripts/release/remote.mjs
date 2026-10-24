import { git } from './plan.mjs';
export function remoteTag(tag) {
  const lines = git('ls-remote', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`).split('\n').filter(Boolean);
  const refs = new Map(lines.map(line => { const [hash, ref] = line.split(/\s+/); return [ref, hash]; }));
  return refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`);
}
export function preflightGit(plan) {
  if (remoteTag(plan.tag)) throw new Error(`Remote target tag ${plan.tag} already exists`);
  const branch = git('ls-remote', '--heads', 'origin', 'refs/heads/main');
  if (branch) {
    git('fetch', '--no-tags', 'origin', 'refs/heads/main');
    try { git('merge-base', '--is-ancestor', 'FETCH_HEAD', plan.head); }
    catch { throw new Error('Remote main is ahead or diverged; integrate it before releasing'); }
  }
  // Git authentication and server receive permissions are independent of API auth.
  git('-c', 'push.followTags=false', 'push', '--dry-run', '--atomic', 'origin',
    `${plan.head}:refs/heads/main`, `${plan.head}:refs/tags/${plan.tag}`);
}
export function verifyRemoteTag(tag, commit) {
  const remote = remoteTag(tag);
  if (!remote) throw new Error(`Remote tag ${tag} is missing; push main and this tag before release:resume`);
  if (remote !== commit) throw new Error(`Remote tag ${tag} points to a different commit; refusing to publish`);
}
