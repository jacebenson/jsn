import fs from 'node:fs';
import { adaptCatalog } from './catalog-v2.mjs';
import { environmentOAuth } from '../oauth-environment.mjs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateProjection, publishResults } from './publish.mjs';
import { HARNESS_SHA } from './prepare.mjs';
import { checkoutIdentity } from './tested-version.mjs';
import { instanceConfiguration, producerEnvironment } from './config.mjs';

export async function runAndPublish({ run, file, publicFile, url, token, publish = publishResults, expectedSHA, evidenceFile }) {
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
  let executedCount = 0;
  try {
    const evidence = fs.readFileSync(evidenceFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    executedCount = new Set(evidence.filter(e => e.runKey === payload.runKey && payload.results.some(r => r.id === e.id && ['passed', 'failed', 'failed-timeout'].includes(r.status))).map(e => e.id)).size;
  } catch { /* No authenticated scenario evidence cannot qualify. */ }
  let outcome;
  try { outcome = await publish({ file: publicFile, url, token }); }
  catch { outcome = { ok: false, result: 'refused' }; }
  console.log(JSON.stringify({ suiteExit: code, publication: outcome.result, httpStatus: outcome.httpStatus ?? 0, complete: payload.summary.complete, missingCount: payload.summary.missingCount, harnessSHA: HARNESS_SHA }));
  const delivered = executedCount > 0 && outcome.ok === true;
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `delivered=${delivered}\nrun_key=${payload.runKey}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${process.env.ACCEPTANCE_TARGET} delivery: ${delivered ? 'verified' : 'FAILED'}\nAuthenticated executed scenarios: ${executedCount}. Suite exit: ${code}. Complete: ${payload.summary.complete}. Missing: ${payload.summary.missingCount}. Counts: ${JSON.stringify(payload.summary.counts)}. Publication: ${outcome.result}.\n${checkoutIdentity(payload.provenance, HARNESS_SHA)}\nRun: /results/${payload.runKey}\n`);
  return delivered ? 0 : 1;
}

export async function seedProfile(privateRoot, input) {
  const configHome = path.join(privateRoot, 'config');
  const configDir = path.join(configHome, 'servicenow');
  // Non-secret isolated profile configuration only. The refreshed access token is
  // never written to a credential file (the CLI refuses plaintext file-store
  // credentials); it stays in process environment/memory and the adapter bridge
  // (execute.mjs) hands it to the pinned producer's coordinator children.
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ auth_method: 'oauth', default_profile: 'acceptance-ci', profiles: { 'acceptance-ci': input.profile } }), { mode: 0o600 });
  return configHome;
}

export async function main() {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const input = instanceConfiguration(process.env);
  const { mode, host } = input;
  const auth = await environmentOAuth(process.env);
  console.log(JSON.stringify({ authSource: auth.source }));
  const privateRoot = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || process.env.TMPDIR, 'jsn-acceptance-'));
  fs.chmodSync(privateRoot, 0o700);
  try {
    const configHome = await seedProfile(privateRoot, input);
    const output = path.join(privateRoot, 'run');
    // Compose the allowlisted producer environment with the freshly refreshed
    // token only; an ambient/stale SERVICENOW_OAUTH_TOKEN was never forwarded.
    const env = { ...producerEnvironment(process.env, privateRoot, configHome), SERVICENOW_OAUTH_TOKEN: auth.accessToken };
    const args = [path.join(root, '.github/scripts/acceptance/execute.mjs'), '--profile', 'acceptance-ci', '--expected-host', host.origin, '--mode', mode, '--output-dir', output];
    if (mode === 'pdi') args.push('--full', '--allow-writes');
    else {
      // Explicitly label the automatic read-only lane as a subset on /results.
      // Select every existing readonly scenario, not a hand-picked passing set.
      for (const name of ['read-only', 'read-only-catalog', 'resources', 'workflows', 'auth']) {
        const module = await import(pathToFileURL(path.join(root, `cli/test/acceptance/${name}.mjs`)).href);
        for (const scenario of adaptCatalog(module.scenarios)) if (scenario.modes.includes('readonly')) args.push('--scenario', scenario.id);
      }
    }
    return await runAndPublish({
      run: () => spawnSync(process.execPath, args, { cwd: root, env, stdio: 'ignore' }).status ?? 1,
      file: path.join(output, 'public-summary.json'), publicFile: path.join(root, 'acceptance-public.json'),
      url: process.env.JSN_ACCEPTANCE_INGEST_URL, token: process.env.JSN_ACCEPTANCE_INGEST_TOKEN,
      expectedSHA: process.env.GITHUB_SHA, evidenceFile: path.join(output, 'executed.jsonl'),
    });
  } finally { fs.rmSync(privateRoot, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(() => { console.error('Acceptance configuration or execution refused; no private data logged'); process.exitCode = 1; });
}
