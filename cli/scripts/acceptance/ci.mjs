import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { validateProjection, publishResults } from './publish.mjs';
import { HARNESS_SHA } from './prepare.mjs';
import { instanceConfiguration, producerEnvironment } from './config.mjs';

export async function runAndPublish({ run, file, publicFile, url, token, publish = publishResults, expectedSHA }) {
  let code = 1;
  try { code = await run(); } catch { /* Still upload an already saved partial run. */ }
  let payload;
  try {
    payload = validateProjection(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (payload.provenance.sourceSHA !== expectedSHA || payload.provenance.sourceDirty) throw new Error();
    fs.writeFileSync(publicFile, JSON.stringify(payload), { flag: 'wx', mode: 0o600 });
  } catch {
    console.error('No valid candidate projection; nothing published');
    return 1;
  }
  let outcome;
  try { outcome = await publish({ file: publicFile, url, token }); }
  catch { outcome = { ok: false, result: 'refused' }; }
  console.log(JSON.stringify({ suiteExit: code, publication: outcome.result, httpStatus: outcome.httpStatus ?? 0, complete: payload.summary.complete, missingCount: payload.summary.missingCount, harnessSHA: HARNESS_SHA }));
  return code !== 0 ? code : !outcome.ok ? 1 : payload.summary.complete ? 0 : 2;
}

export async function seedProfile(privateRoot, input) {
  const configHome = path.join(privateRoot, 'config');
  const configDir = path.join(configHome, 'servicenow');
  fs.mkdirSync(path.join(configDir, 'credentials'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ auth_method: 'oauth', default_profile: 'acceptance-ci', profiles: { 'acceptance-ci': input.profile } }), { mode: 0o600 });
  const { credKey } = await import('../../src/auth/credential-store.js');
  fs.writeFileSync(path.join(configDir, 'credentials', `${credKey(input.profile.instance_url, input.profile.username)}.json`), JSON.stringify(input.credentials), { mode: 0o600 });
  return configHome;
}

export async function main() {
  const root = process.cwd();
  const input = instanceConfiguration(process.env);
  const { mode, host } = input;
  const privateRoot = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || process.env.TMPDIR, 'jsn-acceptance-'));
  fs.chmodSync(privateRoot, 0o700);
  try {
    const configHome = await seedProfile(privateRoot, input);
    const output = path.join(privateRoot, 'run');
    const env = producerEnvironment(process.env, privateRoot, configHome);
    const args = ['cli/scripts/acceptance/run.mjs', '--profile', 'acceptance-ci', '--expected-host', host.origin, '--mode', mode, '--output-dir', output];
    if (mode === 'pdi') args.push('--full', '--allow-writes');
    else {
      // Explicitly label the automatic read-only lane as a subset on /results.
      // Select every existing readonly scenario, not a hand-picked passing set.
      for (const name of ['read-only', 'read-only-catalog', 'resources', 'workflows', 'auth']) {
        const module = await import(pathToFileURL(path.join(root, `cli/test/acceptance/${name}.mjs`)).href);
        for (const scenario of module.scenarios) if (scenario.modes.includes('readonly')) args.push('--scenario', scenario.id);
      }
    }
    return await runAndPublish({
      run: () => spawnSync(process.execPath, args, { cwd: root, env, stdio: 'ignore' }).status ?? 1,
      file: path.join(output, 'public-summary.json'), publicFile: path.join(root, 'acceptance-public.json'),
      url: process.env.JSN_ACCEPTANCE_INGEST_URL, token: process.env.JSN_ACCEPTANCE_INGEST_TOKEN,
      expectedSHA: process.env.GITHUB_SHA,
    });
  } finally { fs.rmSync(privateRoot, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(() => { console.error('Acceptance configuration or execution refused; no private data logged'); process.exitCode = 1; });
}
