// Role elevation (`security_admin` and friends) is ServiceNow session state.
// The platform's elevated_role_dialog UI page calls GlideSecurityManager
// enableElevatedRole/disableElevatedRole for the caller's HTTP session, and
// every request on that session inherits it. It is not a credential property,
// so a per-request credential cannot carry it and no REST read can prove it.
// These hints exist so a 403 on an authoring write names that boundary instead
// of sending operators looking for an ACL that may not be the cause.

// Session-bound credential methods whose HTTP session can hold elevation.
const SESSION_AUTH_METHODS = new Set(['gck']);

export function authMethodCarriesSession(authMethod) {
  return SESSION_AUTH_METHODS.has(String(authMethod || '').toLowerCase());
}

export function elevationHint(authMethod) {
  if (!authMethod) return '';
  const method = String(authMethod).toLowerCase();
  if (authMethodCarriesSession(method)) {
    return 'Role elevation (for example security_admin) belongs to the browser session, so JSN only inherits elevation that was active in the exact session you captured. Elevate in ServiceNow, then recapture that session with jsn auth login --gck.';
  }
  return `Role elevation (for example security_admin) is session state held by the instance, not part of the ${method} credential JSN sends, so JSN cannot carry it. Elevate in the browser and capture that session with jsn auth login --gck, or confirm the write in ServiceNow.`;
}
