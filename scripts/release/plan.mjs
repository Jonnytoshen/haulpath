import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import semver from 'semver';
import { probeVersion } from './nx.mjs';
export const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const channels = ['alpha', 'beta', 'rc', 'stable'];
const core = (v) => `${semver.major(v)}.${semver.minor(v)}.${semver.patch(v)}`;
export function parseReleaseArgs(argv) {
  const options = { dryRun: false, firstRelease: false, channel: 'stable' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run' || arg === '--first-release') {
      const key = arg === '--dry-run' ? 'dryRun' : 'firstRelease';
      if (options[key]) throw new Error(`Duplicate option: ${arg}`);
      options[key] = true;
    } else if (arg === '--channel' || arg.startsWith('--channel=')) {
      if (options.channelSet) throw new Error('Duplicate channel');
      options.channel = arg === '--channel' ? argv[++i] : arg.slice(10);
      options.channelSet = true;
      if (!channels.includes(options.channel)) throw new Error('Channel must be stable, alpha, beta or rc');
    } else if (!options.specifier && (['patch', 'minor', 'major'].includes(arg) || (semver.valid(arg) === arg && !semver.prerelease(arg) && !semver.parse(arg).build.length))) options.specifier = arg;
    else throw new Error(`Invalid release argument: ${arg}`);
  }
  if (options.firstRelease && (options.specifier || options.channel !== 'stable')) throw new Error('First release only establishes stable 0.1.0');
  return options;
}
export async function createReleasePlan(options) {
  const head = git('rev-parse', 'HEAD');
  const allTags = git('tag').split('\n');
  const versions = git('tag', '--merged', 'HEAD').split('\n').filter(t => /^v/.test(t) && semver.valid(t.slice(1)) === t.slice(1)).map(t => t.slice(1));
  const stable = versions.filter(v => !semver.prerelease(v)).sort(semver.rcompare)[0];
  const common = { head, channel: options.channel, firstRelease: options.firstRelease, stableTag: stable && `v${stable}` };
  if (options.firstRelease) {
    if (allTags.some(t => /^v/.test(t) && semver.valid(t.slice(1))) || JSON.parse(readFileSync('package.json')).version !== '0.1.0') throw new Error('First release requires untagged version 0.1.0');
    return { ...common, version: '0.1.0', tag: 'v0.1.0' };
  }
  if (!stable) throw new Error('No stable baseline; use --first-release --dry-run first');
  const automatic = await probeVersion();
  const minimum = automatic ?? stable;
  const explicit = options.specifier && (semver.valid(options.specifier) || semver.inc(stable, options.specifier));
  if (explicit && semver.lt(explicit, minimum)) throw new Error(`Explicit target is below automatic minimum ${minimum}`);
  const candidate = versions.filter(v => semver.prerelease(v) && semver.gt(v, stable)).sort(semver.rcompare)[0];
  if (explicit && candidate && semver.lt(explicit, core(candidate))) throw new Error('Explicit target is below existing candidate minimum');
  let version = explicit ?? automatic;
  if (candidate || options.channel !== 'stable') {
    const targetCore = [minimum, explicit, candidate && core(candidate)].filter(Boolean).sort(semver.rcompare)[0];
    const sameCore = candidate && targetCore === core(candidate);
    const previousChannel = candidate && semver.prerelease(candidate)[0];
    if (sameCore && channels.indexOf(options.channel) < channels.indexOf(previousChannel)) throw new Error('Candidate channel cannot move backward');
    if (options.channel === 'stable') {
      if (candidate && !sameCore) throw new Error(`Automatic minimum ${minimum} exceeds candidate; release a new candidate first`);
      version = targetCore;
    } else if (sameCore && previousChannel === options.channel) {
      const newChanges = await probeVersion(previousChannel);
      if (!newChanges && !explicit) return { ...common, skipped: true };
      version = `${targetCore}-${options.channel}.${Number(semver.prerelease(candidate)[1]) + 1}`;
    } else {
      if (!candidate && !automatic && !explicit) return { ...common, skipped: true };
      version = `${targetCore}-${options.channel}.0`;
    }
  }
  if (!version) return { ...common, skipped: true };
  if (semver.lte(version, stable)) throw new Error('Target must exceed stable baseline');
  if (allTags.includes(`v${version}`)) throw new Error(`Target tag v${version} already exists`);
  return { ...common, version, tag: `v${version}` };
}
