// ServiceNow TOTP challenge helpers for Basic authentication (issue #402).
//
// The flow mirrors the platform's own login page, as implemented by
// @servicenow/sdk-cli 4.13.0's UISession:
//
//   1. POST /angular.do?sysparm_type=view_form.login  → JSON { status:
//      'mfa_code_required' } with a session cookie but no authenticated user.
//   2. GET  /validate_multifactor_auth_code.do        → HTML form holding
//      sysparm_ck and sysparm_process_nonce.
//   3. POST /validate_mfa_code.do                     → 302 on success; 200 with
//      x-mfa_token: invalid when the code is rejected.
//   4. POST /angular.do?sysparm_type=get_user         → session user token.
//
// The wire shape is observed from that reference client, not verified here
// against a live MFA-enabled instance (none is available in this workspace).
// Only the exact challenge marker enters MFA. Once recognized, failures
// must remain terminal; callers may not fall back to Basic headers.
//
// Codes are ephemeral: these helpers return them only to the caller's request
// body. Nothing in this module logs, caches, or persists a code.

export const MFA_REQUIRED_STATUS = 'mfa_code_required';
export const MFA_INVALID_TOKEN_HEADER_VALUE = 'invalid';

/** Read the login endpoint's JSON body without trusting its content type. */
export function parseLoginStatus(body) {
  if (typeof body !== 'string' || body.trim() === '') return null;
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const status = typeof parsed.status === 'string' ? parsed.status : '';
  const message = typeof parsed.message === 'string' ? parsed.message : '';
  return { status, message };
}

/**
 * Extract the hidden anti-CSRF and nonce fields from the MFA validation page.
 * Accepts either attribute order so a form-layout change does not break login.
 */
export function extractMfaFormTokens(html) {
  const text = String(html ?? '');
  const read = (name) => {
    const pattern = new RegExp(
      `name=["']${name}["'][^>]*value=["']([^"']+)["']|value=["']([^"']+)["'][^>]*name=["']${name}["']`,
      'i',
    );
    const match = text.match(pattern);
    return match ? (match[1] ?? match[2] ?? '') : '';
  };
  return { csrf: read('sysparm_ck'), processNonce: read('sysparm_process_nonce') };
}

/** The TOTP verification form body the platform page posts. */
export function buildMfaVerificationBody({ csrf, processNonce, code }) {
  return new URLSearchParams({
    sysparm_ck: csrf,
    sysparm_process_nonce: processNonce,
    sys_action: 'sysverb_validate_mfa_code',
    sys_mfa_check_remembered_browser: 'false',
    // Browser-fingerprint fields are only used for "remember this device";
    // JSN authenticates one session at a time, so they stay empty.
    bfp: '',
    bfp_hash: '',
    sys_web_authentication_successful: 'false',
    sys_web_authentication_response: '',
    sys_web_authn_registration_successful: 'false',
    sys_web_authn_registration_skipped: 'false',
    sys_mfa_factor_validate: 'TOTP',
    sys_show_works_with_sn_enabled: 'true',
    mfa_factor: 'mfa_TOTP_div',
    txtResponse: code,
    txtResponse_email: '',
    txtResponse_sms: '',
  });
}

/** Trim human separators and require six decimal digits. */
export function normalizeTotpCode(value) {
  const digits = String(value ?? '').replace(/[\s-]/g, '');
  return /^\d{6}$/.test(digits) ? digits : '';
}
