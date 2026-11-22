import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('./windows-credential-store.ps1', import.meta.url));
const reasons = {
  unsupported: 'Windows PowerShell 5.1 or PowerShell 7+ on Windows is required.',
  capability: 'PowerShell FullLanguage, Add-Type and the Windows Credential Manager native API must be permitted by system policy.',
  policy: 'PowerShell execution policy explicitly restricts embedded credential operations. Ask your administrator for an approved storage route; no alternate host or plaintext fallback is selected automatically.',
  oversized: 'Credential exceeds the Windows Credential Manager single-entry limit (2560 UTF-8 bytes); existing credentials were not replaced.',
  native: 'Windows Credential Manager operation failed; check vault access and system policy.',
};
const stages = new Set([
  'host_check', 'language_mode', 'machine_policy_query', 'user_policy_query',
  'process_policy_query', 'current_user_policy_query', 'local_machine_policy_query',
  'input_encoding', 'output_encoding', 'native_compilation', 'request_decode',
  'native_read', 'native_write', 'native_delete',
]);
function failure(reason, stage) {
  const safeStage = stages.has(stage) ? stage : undefined;
  const diagnostic = safeStage ? ` Stage: ${safeStage}.` : '';
  const error = new Error(`Secure credential storage unavailable or readback failed. ${reason}${diagnostic} Existing plaintext credentials are preserved. No plaintext fallback is enabled automatically.`);
  error.code = 'credential_storage_error';
  if (safeStage) error.storageStage = safeStage;
  return error;
}

// A process boundary injectable for offline tests; production never accepts a
// script/executable override from configuration or credential content.
export function windowsCredentialOperation(operation, key, value, run = execFileSync) {
  if (!['read', 'write', 'delete'].includes(operation)) throw failure(reasons.native);
  if (operation === 'write' && Buffer.byteLength(value, 'utf8') > 2560) throw failure(reasons.oversized);
  const input = JSON.stringify({ operation, target: `servicenow-cli:${key}`, username: key, value });
  let command;
  try {
    // Trusted installed code only. Command text is identical for every request;
    // neither request data nor a caller-supplied script path enters the source.
    // EncodedCommand is UTF-16LE on both supported PowerShell hosts.
    command = Buffer.from(readFileSync(helper, 'utf8'), 'utf16le').toString('base64');
  } catch { throw failure(reasons.capability); }
  for (const executable of ['powershell.exe', 'pwsh.exe']) {
    let output;
    try {
      output = run(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', command], {
        input, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024,
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      // Never expose child stdout/stderr, exception message or input. In
      // particular policy/parser errors can quote the source or request.
      if (error.code === 'ENOENT') continue;
      throw failure(reasons.capability);
    }
    let response;
    try { response = JSON.parse(output.replace(/^\uFEFF/, '')); }
    catch { throw failure(reasons.capability); }
    // Only an explicit unsupported host/version (or ENOENT above) permits
    // discovery of another host. Never retry policy/capability/native denial.
    if (response?.status === 'error' && response.reason === 'unsupported') continue;
    if (response?.status === 'missing' && operation !== 'write') return null;
    if (response?.status !== 'ok') throw failure(reasons[response?.reason] || reasons.native, response?.stage);
    if (operation === 'read') {
      if (typeof response.value !== 'string') throw failure(reasons.native);
      return response.value;
    }
    return true;
  }
  throw failure(reasons.unsupported);
}

// Go v1 used normalizeURL(instance), not the sanitized file name. Only
// username-less legacy profiles may consult that identity: never borrow an
// instance-wide credential for a different named account.
export function legacyWindowsKey(instance) {
  const trimmed = instance.replace(/\/$/, '');
  return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
}
