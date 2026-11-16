import { execFileSync } from 'node:child_process';

// Read the executable, not a nearby manifest or a moving registry dist-tag.
export function parseTestedVersion(stdout) {
  let result;
  try { result = JSON.parse(stdout); } catch { throw Error('Candidate version must be JSON'); }
  const version = result?.data?.version;
  if (result.ok !== true || typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw Error('Candidate version is invalid');
  return version;
}

export function testedVersion(cliPath) {
  const stdout = execFileSync(process.execPath, [cliPath, 'version', '--json'], {
    encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', JSN_NO_PROMPTS: '1' },
  });
  return parseTestedVersion(stdout);
}

export function checkoutIdentity(provenance, harnessSHA) {
  return `Tested artifact: checkout. CLI ${provenance.version}. Source commit: ${provenance.sourceSHA}. Harness commit: ${harnessSHA}. npm channel: not tested.`;
}
