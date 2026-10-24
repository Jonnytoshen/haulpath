import semver from 'semver';
import { git } from './plan.mjs';
export function repository() {
  const origin = git('config', '--get', 'remote.origin.url');
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(origin);
  if (!match) throw new Error('origin must use a GitHub repository URL without embedded credentials');
  let pushUrls;
  try { pushUrls = git('config', '--get-all', 'remote.origin.pushurl'); } catch { /* origin URL is the push default */ }
  if (pushUrls && pushUrls !== origin) throw new Error('origin push URL must match its GitHub fetch URL');
  return `${match[1]}/${match[2]}`;
}
export function github(repo) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) throw new Error('GitHub API authentication requires GITHUB_TOKEN or GH_TOKEN; Git push authentication is separate');
  async function request(path, body, missing = false) {
    let response;
    try { response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
      method: body ? 'POST' : 'GET', redirect: 'error',
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version':'2026-03-10', 'Content-Type':'application/json', 'User-Agent':'HaulPath-release' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000),
    }); } catch { throw new Error('GitHub API request failed; check connectivity and API authentication'); }
    if (missing && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub API request failed (HTTP ${response.status}); check API authentication and repository permissions`);
    try { return await response.json(); } catch { throw new Error('GitHub API returned invalid JSON'); }
  }
  return {
    async preflight() { const data = await request(''); if (data.permissions?.push === false) throw new Error('GitHub API token lacks repository write permission'); },
    async publish(tag, notes) {
      const existing = await request(`/releases/tags/${encodeURIComponent(tag)}`, undefined, true);
      if (existing) return { existing: true, url: existing.html_url };
      const prerelease = Boolean(semver.prerelease(tag.slice(1)));
      const latest = prerelease ? null : await request('/releases/latest', undefined, true);
      const latestVersion = latest?.tag_name?.replace(/^v/, '');
      const makeLatest = !prerelease && (!semver.valid(latestVersion) || semver.gte(tag.slice(1), latestVersion));
      const data = await request('/releases', { tag_name:tag, name:tag, body:notes, draft:false, prerelease, make_latest: makeLatest ? 'true' : 'false' });
      return { url:data.html_url };
    },
  };
}
export function taggedRelease(tag) {
  if (!/^v/.test(tag) || semver.valid(tag.slice(1)) !== tag.slice(1) || semver.parse(tag.slice(1))?.build.length) throw new Error('Target tag must be v followed by a complete release SemVer');
  let pkg, log, commit;
  try {
    commit = git('rev-parse', '--verify', `${tag}^{commit}`);
    pkg = JSON.parse(git('show', `${tag}:package.json`));
    log = git('show', `${tag}:CHANGELOG.md`);
  } catch { throw new Error('Target tag, package version or committed CHANGELOG.md is missing'); }
  if (pkg.version !== tag.slice(1)) throw new Error('Target tag does not match its committed package version');
  const lines = log.split('\n');
  const versionHeading = /^## (?:\[)?(\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?)(?:\](?:\([^\n]*\))?)?(?: \([^\n]*\))?\s*$/;
  const start = lines.findIndex(line => versionHeading.exec(line)?.[1] === pkg.version);
  if (start < 0) throw new Error('Target version entry is missing from committed CHANGELOG.md');
  let end = start + 1;
  while (end < lines.length && !versionHeading.test(lines[end])) end++;
  return { commit, notes: lines.slice(start, end).join('\n').trim() };
}
