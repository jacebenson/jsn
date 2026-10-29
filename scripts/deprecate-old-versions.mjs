import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const PACKAGE = '@jacebenson/jsn';
const REGISTRY = 'https://registry.npmjs.org';
const KEEP = 3; // Current release and two releases back, independently per channel.

function versionParts(version, channel) {
  const pattern = channel === 'dev'
    ? /^(\d+)\.(\d+)\.(\d+)-dev\.(\d+)(?:\.(\d+))?$/
    : /^(\d+)\.(\d+)\.(\d+)$/;
  const match = pattern.exec(version);
  return match?.slice(1).map(value => BigInt(value || '0'));
}

export function planDeprecations(metadata, channel, published) {
  if (!['latest', 'dev'].includes(channel)) throw new Error('Channel must be latest or dev');
  if (!versionParts(published, channel)) throw new Error('Published version does not match channel');
  if (metadata['dist-tags']?.[channel] !== published || !metadata.versions?.[published]) {
    throw new Error(`Registry ${channel} tag does not match published version ${published}; refusing deprecation`);
  }
  const versions = Object.keys(metadata.versions).filter(version => versionParts(version, channel));
  versions.sort((a, b) => {
    const left = versionParts(a, channel);
    const right = versionParts(b, channel);
    for (let i = 0; i < left.length; i++) {
      if (left[i] !== right[i]) return left[i] > right[i] ? -1 : 1;
    }
    return 0;
  });
  const supported = versions.slice(0, KEEP);
  if (supported[0] !== published) throw new Error('Published version is not the newest in its channel; refusing deprecation');
  const target = channel === 'dev' ? 'dev' : 'latest';
  const message = `Unsupported JSN version. Only the current release and two previous releases in this channel are supported. Update before reporting an issue: npm install -g ${PACKAGE}@${target}`;
  return {
    channel,
    supported,
    deprecate: versions.slice(KEEP).filter(version => !metadata.versions[version].deprecated),
    message,
  };
}

export function applyDeprecations(plan, run = spawnSync) {
  for (const version of plan.deprecate) {
    // Exact versions only: npm deprecate ranges also match prereleases.
    const result = run('npm', ['deprecate', `${PACKAGE}@${version}`, plan.message, '--registry', REGISTRY], {
      stdio: 'inherit',
      shell: false,
    });
    if (result.error || result.status !== 0) {
      throw new Error(`Deprecation failed for ${version}; previous successful deprecations remain applied`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const channel = args[0];
  if (!['latest', 'dev'].includes(channel) || args.slice(1).some(arg => arg !== '--apply') || args.length > 2) {
    throw new Error('Usage: node scripts/deprecate-old-versions.mjs <latest|dev> [--apply]');
  }
  const apply = args.includes('--apply');
  if (apply && !process.env.NODE_AUTH_TOKEN) throw new Error('Set NPM_TOKEN in GitHub secrets (passed as NODE_AUTH_TOKEN) for npm deprecation');
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const response = await fetch(`${REGISTRY}/${PACKAGE}`, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Could not read npm versions: HTTP ${response.status}`);
  const plan = planDeprecations(await response.json(), channel, pkg.version);
  process.stdout.write(`${JSON.stringify({ apply, ...plan }, null, 2)}\n`);
  if (apply) applyDeprecations(plan);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
