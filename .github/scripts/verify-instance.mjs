#!/usr/bin/env node
// Bounded, noninteractive read through the real CLI. Never publish raw output.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { environmentOAuth } from './oauth-environment.mjs';

export async function refreshAndVerify(env = process.env, options = {}) {
  if (!['pdi', 'vendor-1', 'vendor-2'].includes(env.JSN_VERIFY_TARGET) || env.JSN_VERIFY_ENABLED !== 'true') return verifyInstance(env, options);
  try {
    const auth = await environmentOAuth(env, options);
    return { ...verifyInstance({ ...env, SERVICENOW_OAUTH_TOKEN: auth.accessToken }, options), authSource: auth.source };
  } catch (error) {
    return { ok: false, target: env.JSN_VERIFY_TARGET, status: ['invalid_url', 'not_configured', 'authentication_failed'].includes(error.message) ? error.message : 'unavailable' };
  }
}

export function verifyInstance(env = process.env, { allowLocal = false } = {}) {
  const target = env.JSN_VERIFY_TARGET;
  const failure = (status) => ({ ok: false, target: ['pdi', 'vendor-1', 'vendor-2'].includes(target) ? target : null, status });
  if (!['pdi', 'vendor-1', 'vendor-2'].includes(target)) return failure('invalid_target');
  if (env.JSN_VERIFY_ENABLED !== 'true') return failure('disabled');
  if (!env.SERVICENOW_INSTANCE_URL || !env.SERVICENOW_OAUTH_TOKEN) return failure('not_configured');
  let url;
  try { url = new URL(env.SERVICENOW_INSTANCE_URL); } catch { return failure('invalid_url'); }
  if ((url.protocol !== 'https:' && !(allowLocal && url.protocol === 'http:' && url.hostname === '127.0.0.1')) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return failure('invalid_url');
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'jsn-verify-'));
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../cli/bin/jsn.js', import.meta.url)), 'records', 'list', '--table', 'sys_db_object', '--query', 'name=incident', '--columns', 'name', '--limit', '1', '--no-count', '--json'], {
      cwd: scratch, encoding: 'utf8', timeout: 45000, maxBuffer: 1024 * 1024,
      env: { PATH: env.PATH || '', HOME: scratch, XDG_CONFIG_HOME: scratch, XDG_CACHE_HOME: scratch, TMPDIR: scratch,
        SERVICENOW_INSTANCE_URL: url.origin, SERVICENOW_OAUTH_TOKEN: env.SERVICENOW_OAUTH_TOKEN,
        ...(env.JSN_ALWAYS_WARM_SESSION === '0' ? { JSN_ALWAYS_WARM_SESSION: '0' } : {}),
        JSN_NO_VERSION_CHECK: '1', JSN_NO_SKILL_CHECK: '1', CI: 'true', NO_COLOR: '1' },
    });
    if (result.error) return failure('unavailable');
    let output;
    try { output = JSON.parse(result.stdout); } catch { return failure(result.status === 0 ? 'invalid_response' : 'unavailable'); }
    if (!output || typeof output !== 'object') return failure('invalid_response');
    if (result.status !== 0 || output.ok !== true) {
      const code = String(output.code || '');
      return failure(code === 'auth_error' ? 'authentication_failed' : code === 'network_error' ? 'unavailable' : 'provider_failed');
    }
    const records = output.data?.records;
    if (!Array.isArray(records) || records.length > 1) return failure('invalid_response');
    // An empty result can mean ACL filtering, not a successful verification.
    if (records.length !== 1 || records[0]?.name !== 'incident') return failure('verification_failed');
    return { ok: true, target, status: 'passed', checks: 1, records: records.length };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await refreshAndVerify();
  console.log(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 1;
}
