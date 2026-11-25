#!/usr/bin/env bash
set -euo pipefail
# Locate the checkout from this script, not the caller's working directory.
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
env_file="${HERMES_HOME:-$HOME/.hermes}/.env"
args=()
explicit_env=false
while (($#)); do
  if [[ "$1" == --env-file ]]; then
    if [[ $# -lt 2 || "$2" == --* || "$explicit_env" == true ]]; then
      printf '%s\n' 'options: --env-file requires one file' >&2; exit 1
    fi
    env_file="$2"; explicit_env=true; shift 2
  else
    args+=("$1"); shift
  fi
done
node_args=()
if [[ -f "$env_file" ]]; then
  node_args+=("--env-file=$env_file")
elif [[ "$explicit_env" == true ]]; then
  printf '%s\n' 'options: explicit env file does not exist' >&2; exit 1
fi
# Node parses dotenv; never source private configuration as shell commands.
exec node "${node_args[@]}" --input-type=module - "$root" "${args[@]}" <<'NODE'
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [root, ...args] = process.argv.slice(2);
try {
  if (args.includes('--help')) {
    console.log('Usage: ./.github/scripts/test-instance.sh --profile NAME [--version EXACT] [--dry-run] [--readonly] [--plan] [--env-file FILE]');
    console.log('Default: full READWRITE suite and publish. --readonly selects GET-only checks. --dry-run skips publication ONLY, NOT provider writes. --plan exports scope without provider calls.');
    process.exit(0);
  }
  const forwarded = []; let dry = false; let profile; let readonly = false; let plan = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--readonly' && !readonly) { readonly = true; continue; }
    if (args[i] === '--plan' && !plan) { plan = true; continue; }
    if (args[i] === '--dry-run' && !dry) { dry = true; continue; }
    if (!['--profile', '--version'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw Error('options: use --profile NAME [--version EXACT] [--dry-run]');
    const key = args[i], value = args[++i];
    if (forwarded.includes(key)) throw Error('options: duplicate option');
    forwarded.push(key, value);
    if (key === '--profile') profile = value;
  }
  if (!profile) throw Error('options: --profile NAME is required');
  const { parseOptions, main } = await import(pathToFileURL(path.join(root, '.github/scripts/run-acceptance.mjs')));
  // Keep config discovery stable when invoked from another working directory.
  process.chdir(root);
  const { loadConfig } = await import(pathToFileURL(path.join(root, 'cli/src/config.js')));
  const profiles = loadConfig().profiles || {};
  const aliasKey = `JSN_TEST_PROFILE_${profile.toUpperCase().replaceAll('-', '_')}`;
  const resolved = Object.hasOwn(profiles, profile) ? profile : process.env[aliasKey];
  if (!resolved || !Object.hasOwn(profiles, resolved)) {
    const names = Object.keys(profiles).filter(name => /^[a-zA-Z0-9_-]+$/.test(name));
    throw Error(`profile: selected name is not a configured local profile; use --profile with an existing name${names.length ? ` (${names.join(', ')})` : ''}, or set ${aliasKey} to that local profile in the env file`);
  }
  forwarded[forwarded.indexOf('--profile') + 1] = resolved;
  forwarded.push('--target', profile, '--mode', readonly ? 'readonly' : 'full');
  if (plan) forwarded.push('--plan');
  if (!dry && !plan) forwarded.push('--publish');
  parseOptions(forwarded); // Exact version and target validation before provider calls.
  if (!dry && !plan) {
    if (!process.env.JSN_ACCEPTANCE_INGEST_TOKEN || !process.env.JSN_ACCEPTANCE_INGEST_URL) throw Error('publication: set JSN_ACCEPTANCE_INGEST_URL and JSN_ACCEPTANCE_INGEST_TOKEN, or opt into --dry-run');
    let url; try { url = new URL(process.env.JSN_ACCEPTANCE_INGEST_URL); } catch { throw Error('publication: invalid ingest URL'); }
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash || url.pathname !== '/api/acceptance/runs') throw Error('publication: use an HTTPS /api/acceptance/runs endpoint (HTTP allowed only on loopback), without credentials, query or fragment');
    if (process.env.JSN_ACCEPTANCE_INGEST_TOKEN.length < 32) throw Error('publication: ingest token must contain at least 32 characters');
  }
  console.log(plan ? 'PLAN ONLY: no provider calls or publication.' : readonly ? 'READONLY: GET-only provider checks.' : 'WARNING: FULL READWRITE selected target; creates run-owned fixtures, restores session context, retains unsupported capture/flow graphs.');
  console.log(dry ? '--dry-run skips publication ONLY; selected provider tests still execute (including full-mode writes).' : plan ? 'Publication skipped.' : 'Publication enabled.');
  process.exitCode = await main(forwarded);
} catch (error) {
  console.error(/^(options|profile|publication|mode|output|auth|npm artifact|profile\/auth|harness preparation|candidate version|readonly suite|report schema|output permission):/.test(error.message) ? error.message : 'options: invalid arguments or acceptance runner unavailable; use --help');
  process.exitCode = 1;
}
NODE
