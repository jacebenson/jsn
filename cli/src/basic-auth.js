// Shared rules for ServiceNow's Basic Auth restriction.
//
// The same properties and decision values drive `midservers add`'s single-account
// diagnosis (src/midserver-setup.js) and `jsn users basic-auth`'s instance-wide
// report. This module states the policy reading and the allowed/blocked/unknown
// verdict once for the report and mirrors the MID diagnosis, which still carries
// its own copy of the decision branch. A verdict is what enforcement would do;
// whether enforcement is in effect is reported separately.
//
// Documented behaviour mirrored from the MID diagnosis: web-service-access-only
// accounts are exempt, holding one of glide.authenticate.basic_auth.allowed_roles
// is exempt, and an exception row applies by granting a role or converting the
// account (grant / converted) or revoking Basic Auth API login (no_grant).

export const BASIC_AUTH_PREFIX = 'glide.authenticate.basic_auth.';

const raw = value => (value && typeof value === 'object' ? String(value.value ?? '') : String(value ?? ''));
const bool = value => {
  const text = raw(value);
  if (text === 'true' || text === '1') return true;
  if (text === 'false' || text === '0') return false;
  return null;
};
const list = value => (value === undefined || value === null ? null : String(value).split(',').map(item => item.trim()).filter(Boolean));

/**
 * Read `glide.authenticate.basic_auth.*` properties into switches.
 * Missing properties stay null (unknown) instead of becoming false.
 */
export function basicAuthPolicy(properties) {
  const byName = new Map(properties.map(property => [raw(property.name), raw(property.value)]));
  const value = name => (byName.has(name) ? byName.get(name) : undefined);
  const allowedRoles = value(`${BASIC_AUTH_PREFIX}allowed_roles`);
  const allowedUsers = value(`${BASIC_AUTH_PREFIX}allowed_users`);
  return {
    properties: properties.map(property => ({ name: raw(property.name), value: raw(property.value) })),
    active: bool(value(`${BASIC_AUTH_PREFIX}restriction.active`)),
    enforce: bool(value(`${BASIC_AUTH_PREFIX}restriction.enforce`)),
    enforcement_date: value(`${BASIC_AUTH_PREFIX}restriction.enforcement_date`) || null,
    default_decision_raw: value(`${BASIC_AUTH_PREFIX}restriction.default_decision`) ?? null,
    // A missing allowed_roles property means the exemption cannot be verified.
    allowed_roles: list(allowedRoles),
    allowed_users: list(allowedUsers) ?? [],
    allow_wsao: bool(value(`${BASIC_AUTH_PREFIX}allow_wsao`)),
    allow_snc_external: bool(value(`${BASIC_AUTH_PREFIX}allow_snc_external`)),
  };
}

/**
 * Resolve a decision value or label to its choice value.
 * The default_decision property can hold either form; the verified dev instance
 * stores the label. Unknown values stay unknown.
 */
export function resolveDecision(valueOrLabel, choices = []) {
  if (valueOrLabel === undefined || valueOrLabel === null || valueOrLabel === '') return { value: null, label: null, raw: valueOrLabel ?? null };
  const text = String(valueOrLabel);
  const byValue = choices.find(choice => raw(choice.value) === text);
  const byLabel = byValue || choices.find(choice => raw(choice.label) === text);
  if (!byValue && !byLabel) return { value: null, label: null, raw: text };
  return { value: raw(byLabel.value), label: raw(byLabel.label), raw: text };
}

/**
 * Verdict for one account at enforcement time.
 *
 * @param {object} input
 * @param {{sys_id?: string, user_name?: string, name?: string, active?: boolean|null, web_service_access_only?: boolean|null}|null} input.user
 * @param {string[]} input.roleNames role names the account holds
 * @param {object} input.policy result of basicAuthPolicy()
 * @param {{decision?: string}|null} input.exception the account's Basic Auth exception row, if any
 * @param {Array} input.choices sys_choice rows for sys_user_basic_auth_exception.decision
 * @returns {{verdict: 'allowed'|'blocked'|'unknown', reason: string, decision: object|null}}
 */
export function evaluateBasicAuthAccount({ user, roleNames = [], policy, exception = null, choices = [] }) {
  const unknown = reason => ({ verdict: 'unknown', reason, decision: null });
  if (!user) return unknown('the account record was not readable');
  if (!policy || policy.active === null || policy.enforce === null) return unknown('the Basic Auth restriction switches are not readable');
  if (policy.allowed_roles === null) return unknown('glide.authenticate.basic_auth.allowed_roles is not configured, so the role exemption cannot be verified');

  const decision = exception ? resolveDecision(raw(exception.decision), choices) : null;
  if (user.web_service_access_only === true) {
    return { verdict: 'allowed', reason: 'web service access only account (documented exemption)', decision };
  }
  const heldAllowedRole = policy.allowed_roles.find(role => roleNames.includes(role));
  if (heldAllowedRole) return { verdict: 'allowed', reason: `holds allowed role ${heldAllowedRole}`, decision };
  const userKeys = [user.sys_id, user.user_name].filter(Boolean);
  const listedUser = policy.allowed_users.find(entry => userKeys.includes(entry));
  if (listedUser) return { verdict: 'allowed', reason: 'listed in glide.authenticate.basic_auth.allowed_users', decision };

  if (!exception) return { verdict: 'blocked', reason: 'no exception row and no allowed role or WSAO exemption', decision };
  if (!decision?.value) {
    return unknown(`exception decision ${JSON.stringify(decision?.raw ?? raw(exception.decision))} is not a known choice`);
  }
  if (decision.value === 'grant') return { verdict: 'allowed', reason: 'exception decision grant: Basic Auth API login allowed', decision };
  if (decision.value === 'converted') return { verdict: 'allowed', reason: 'exception decision converted: account uses web service access only', decision };
  if (decision.value === 'no_grant') return { verdict: 'blocked', reason: 'exception decision no_grant: Basic Auth API login revoked', decision };
  if (decision.value === 'global') {
    const fallback = resolveDecision(policy.default_decision_raw, choices);
    if (!fallback.value) return unknown('exception applies the system default, but the default decision is not a known choice');
    if (fallback.value === 'grant') return { verdict: 'allowed', reason: 'system default grants Basic Auth API login', decision: { ...decision, effective: fallback } };
    if (fallback.value === 'converted') return { verdict: 'allowed', reason: 'system default converts the account to web service access only', decision: { ...decision, effective: fallback } };
    if (fallback.value === 'no_grant') return { verdict: 'blocked', reason: 'system default revokes Basic Auth API login', decision: { ...decision, effective: fallback } };
    if (fallback.value === 'global') return unknown('the default decision is itself "apply default"');
    return unknown(`system default decision ${JSON.stringify(fallback.raw)} is not a known choice`);
  }
  return unknown(`exception decision ${JSON.stringify(decision.value)} is not a known choice`);
}
