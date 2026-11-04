// ServiceNow Store application discovery, inspection and explicit lifecycle
// operations.
//
// Wire contract
// -------------
// The App Client REST surface used here is the one documented by the App
// Client application itself (sn_appclient) and implemented by the reference
// Store CLI named in issue #400 (sonisoft-cnanda/now-sdk-ext-cli):
//
//   POST /api/sn_appclient/appmanager/apps?tab_context=…&search_key=…
//        &sysparm_limit=…&sysparm_offset=…   -> result.apps[]
//   GET  /api/sn_appclient/appmanager/app/{app_sys_id} -> result.app_info_on_instance
//   GET  /api/sn_appclient/appmanager/app/install?app_id=…&version=…
//   GET  /api/sn_appclient/appmanager/app/update?app_id=…&version=…
//   GET  /api/sn_cicd/progress/{tracker_id} -> result{status,percent_complete,…}
//
// This contract has NOT been verified against a live Store-entitled instance
// from this repository: there is no such instance in CI and no way to obtain
// one. Discovery/inspection is implemented and tested against a mock
// transport; install/update are declared mutations behind the same contract
// and are labelled unverified in the PR. A maintainer with a Store-entitled
// instance must confirm the endpoints, the required roles, and the version
// list shape before treating the mutation path as proven.
//
// The search endpoint is POST-shaped (an empty JSON body), but performs no
// mutation. Read-only profiles may use it; `install`/`update` remain the only
// declared mutation subcommands.

import { AppError, errAPI, errAmbiguous, errNotFoundHint, errUsage, errUsageHint } from './errors.js';
import { isSysId, unwrapSysId } from './resolve-record.js';

/** Store tab contexts, as named by the App Client. */
export const STORE_TABS = {
  available: 'available_for_you',
  installed: 'installed',
  updates: 'updates',
};

const APPS_PATH = '/api/sn_appclient/appmanager/apps';
const APP_PATH = '/api/sn_appclient/appmanager/app';
const INSTALL_PATH = '/api/sn_appclient/appmanager/app/install';
const UPDATE_PATH = '/api/sn_appclient/appmanager/app/update';
const PROGRESS_PATH = '/api/sn_cicd/progress';

const INSTALLED_FIELDS = 'sys_id,name,scope,version,active,latest_version,install_date,update_date';
const MAX_VERSION_ATTEMPTS = 6;
const DEFAULT_VERIFY_INTERVAL_MS = 2000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Platform booleans arrive as true/false, 'true'/'false', or 1/0. */
export const storeFlag = value => value === true || value === 'true' || value === 1 || value === '1';

/** Unwrap a raw or display-valued field. */
export function storeText(record, field) {
  const value = record?.[field];
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return String(value.value ?? value.display_value ?? '');
  return String(value);
}

export function boundedLimit(value = 20) {
  if (!Number.isInteger(value) || value < 1 || value > 200) throw errUsage('--limit must be an integer from 1 to 200.');
  return value;
}

export function boundedOffset(value = 0) {
  if (!Number.isInteger(value) || value < 0) throw errUsage('--offset must be a nonnegative integer.');
  return value;
}

export function boundedTimeout(value = 1800) {
  if (!Number.isFinite(value) || value < 1 || value > 14400) throw errUsage('--timeout must be from 1 to 14400 seconds.');
  return Math.round(value);
}

export function boundedPoll(value = 5) {
  if (!Number.isFinite(value) || value < 0 || value > 300) throw errUsage('--poll-interval must be from 0 to 300 seconds.');
  return Math.round(value);
}

function requireIdentifier(value) {
  const text = String(value ?? '').trim();
  if (!text) throw errUsage('Provide a Store application by name, scope, or 32-character sys_id.');
  return text;
}

/**
 * The list endpoint ships `indicators` as a JSON-encoded string; the detail
 * endpoint ships the same entries as a real array. Both carry the platform's
 * own reason an application is unavailable here (for example
 * `not_available_for_instance_type` -> "Unavailable for Instance" on a
 * developer instance), which is the only place that reason appears.
 */
export function parseIndicators(value) {
  if (value === undefined || value === null || value === '') return [];
  const raw = typeof value === 'string' ? (() => { try { return JSON.parse(value); } catch { return []; } })() : value;
  if (!Array.isArray(raw)) return [];
  return raw.filter(item => item && typeof item === 'object').map(item => ({
    id: storeText(item, 'id') || null,
    type: storeText(item, 'type') || null,
    message: storeText(item, 'message') || null,
    tooltip: storeText(item, 'tooltip') || null,
  }));
}

/** Reasons the platform gave for blocking an application here. */
export function blockingIndicators(indicators) {
  return parseIndicators(indicators).filter(item => item.type === 'error');
}

/**
 * One row from the Store list, reduced to stable, documented fields.
 *
 * The list payload (POST /appmanager/apps) is NOT the detail payload: it has no
 * `isInstalled`, `can_install_or_upgrade`, `is_store_app`, `isAppstorePlugin`,
 * `price_type` or `needs_app_engine_licensing`. The installed marker on a list
 * row is a non-empty `version` (an available row reports `version: null`), and
 * the update marker is `update_available` ("1"). Reading the detail spellings
 * off a list row reported every installed application as not installed.
 */
export function summarizeApplication(app) {
  const version = storeText(app, 'version');
  const indicators = parseIndicators(app?.indicators);
  const blockedFlag = app?.block_install === undefined ? null : storeFlag(app.block_install);
  // The list payload always carries `indicators` (an empty array when nothing
  // blocks the app); only a payload without the key leaves the answer unknown.
  const indicatorsReported = app?.indicators !== undefined && app?.indicators !== null;
  return {
    sys_id: storeText(app, 'sys_id'),
    name: storeText(app, 'name'),
    scope: storeText(app, 'scope'),
    vendor: storeText(app, 'vendor'),
    source: storeText(app, 'source'),
    version: version || null,
    latest_version: storeText(app, 'latest_version') || storeText(app, 'latest_version_display') || null,
    installed: storeFlag(app?.isInstalled) || Boolean(version),
    update_available: storeFlag(app?.isInstalledAndUpdateAvailable) || storeFlag(app?.update_available),
    installable: app?.can_install_or_upgrade === undefined ? null : storeFlag(app.can_install_or_upgrade),
    is_store_app: app?.is_store_app === undefined ? null : storeFlag(app.is_store_app),
    is_plugin: app?.isAppstorePlugin === undefined ? null : storeFlag(app.isAppstorePlugin),
    price_type: storeText(app, 'price_type') || null,
    needs_app_engine_licensing: app?.needs_app_engine_licensing === undefined ? null : storeFlag(app.needs_app_engine_licensing),
    blocked: blockedFlag === null && !indicatorsReported ? null : Boolean(blockedFlag) || blockingIndicators(indicators).length > 0,
    indicators,
    short_description: storeText(app, 'short_description') || null,
  };
}

/**
 * List or search Store applications in one tab context.
 *
 * A 2xx body without `result.apps` is a malformed envelope — an unavailable
 * source, never an empty catalogue.
 */
export async function listApplications(sdk, { tab = 'available', term, limit = 20, offset = 0 } = {}) {
  if (!Object.hasOwn(STORE_TABS, tab)) throw errUsage(`--tab must be one of ${Object.keys(STORE_TABS).join(', ')}.`);
  boundedLimit(limit);
  boundedOffset(offset);
  const searchKey = term === undefined || term === null ? '' : String(term).trim();
  const params = new URLSearchParams({
    tab_context: STORE_TABS[tab],
    sysparm_limit: String(limit),
    sysparm_offset: String(offset),
  });
  if (searchKey) params.set('search_key', searchKey);
  const response = await sdk.request(`${sdk.baseURL}${APPS_PATH}?${params}`, { method: 'POST', body: '{}' });
  const apps = response?.result?.apps;
  if (!Array.isArray(apps)) {
    throw new AppError('store_response_malformed',
      'The Store application list returned no apps array. This is an unavailable source, not an empty catalogue.',
      'Confirm this instance exposes the ServiceNow Store App Client API (sn_appclient) and that this account may use it.');
  }
  const rows = apps.filter(Boolean);
  return {
    tab,
    tab_context: STORE_TABS[tab],
    term: searchKey || null,
    count: rows.length,
    limit,
    offset,
    page_full: rows.length === limit,
    apps: rows.map(summarizeApplication),
  };
}

/** Full App Client detail for one app, or null when the client has no record. */
export async function applicationDetail(sdk, sysId) {
  const response = await sdk.request(`${sdk.baseURL}${APP_PATH}/${encodeURIComponent(sysId)}`, { method: 'GET' });
  const detail = response?.result?.app_info_on_instance;
  return detail && typeof detail === 'object' ? detail : null;
}

function versionList(detail) {
  const raw = detail?.versions;
  if (!Array.isArray(raw)) return [];
  return raw
    .map(item => (typeof item === 'string' ? item : storeText(item, 'version') || storeText(item, 'version_display') || storeText(item, 'name')))
    .map(item => String(item).trim())
    .filter(Boolean);
}

function detailName(detail, record, fallback) {
  return storeText(detail, 'name') || storeText(record, 'name') || fallback || '';
}

/**
 * Resolve a human identifier to a Store app sys_id.
 *
 * Order: sys_id, installed/known `sys_store_app` scope, `sys_store_app` name,
 * then the Store search endpoint (exact name or scope only). A company
 * application-repository app is refused explicitly rather than treated as a
 * Store app.
 */
export async function resolveApplication(sdk, identifier) {
  const raw = requireIdentifier(identifier);
  if (isSysId(raw)) {
    const sysId = raw.toLowerCase();
    let record = null;
    try {
      record = await sdk.get('sys_store_app', sysId);
    } catch (error) {
      if (error?.status !== 403 && error?.status !== 404) throw error;
    }
    return { sys_id: sysId, record, summary: null, matched_by: 'sys_id' };
  }
  if (/[\^=\n\r]/.test(raw)) {
    throw errUsage('The identifier contains characters reserved by encoded queries; pass the application sys_id instead.');
  }
  for (const field of ['scope', 'name']) {
    const rows = await sdk.listStrict('sys_store_app', {
      sysparm_query: `${field}=${raw}`,
      sysparm_fields: INSTALLED_FIELDS,
      sysparm_limit: '2',
      sysparm_display_value: 'false',
    });
    if (rows.length > 1) {
      throw errAmbiguous('store applications', rows.map(row => `${storeText(row, 'name')} (${storeText(row, 'scope')})`));
    }
    if (rows.length === 1) return { sys_id: unwrapSysId(rows[0]), record: rows[0], summary: null, matched_by: field };
  }
  const found = await listApplications(sdk, { tab: 'available', term: raw, limit: 25, offset: 0 });
  const wanted = raw.toLowerCase();
  const matches = found.apps.filter(app => app.name.toLowerCase() === wanted || app.scope.toLowerCase() === wanted);
  if (matches.length > 1) {
    throw errAmbiguous('store applications', matches.map(app => `${app.name} (${app.scope}) ${app.sys_id}`));
  }
  if (matches.length === 1) return { sys_id: matches[0].sys_id, record: null, summary: matches[0], matched_by: 'store_search' };
  const company = await sdk.list('sys_app', {
    sysparm_query: `scope=${raw}`, sysparm_fields: 'sys_id,name,scope', sysparm_limit: '1',
  }).catch(() => []);
  if (company.length) {
    throw new AppError('store_not_store_app',
      `"${raw}" is not a ServiceNow Store application.`,
      'It matches a company/application-repository application (sys_app). jsn store handles ServiceNow Store applications only; '
      + 'use `jsn records list --table sys_app` to inspect that one.');
  }
  throw errNotFoundHint('store application', raw,
    `Search the Store for it: jsn store search "${raw}". Only exact name or scope matches are resolved here; pass the sys_id from a search result if several applications share a name.`);
}

/**
 * Inspection view: installed state, available versions, entitlement flags,
 * dependencies and compatibility data where the platform exposes them.
 */
export async function showApplication(sdk, identifier) {
  const target = await resolveApplication(sdk, identifier);
  let detail = null;
  let detailUnavailable = null;
  try {
    detail = await applicationDetail(sdk, target.sys_id);
  } catch (error) {
    if (error?.status === 403) detailUnavailable = 'forbidden';
    else if (error?.status === 404) detailUnavailable = 'not_found';
    else throw error;
  }
  if (!detail && !target.record && !target.summary && detailUnavailable) {
    throw errNotFoundHint('store application', identifier,
      'Neither the Store App Client nor the store application table returned this application. Check the identifier and this account\'s Store access.');
  }
  const record = target.record;
  const installedFromDetail = Boolean(detail) && storeFlag(detail.isInstalled);
  const installedFromRecord = !detail && record && storeText(record, 'version') && storeText(record, 'install_date');
  const installed = installedFromDetail || installedFromRecord;
  const installedVersion = storeText(detail, 'version') || (installedFromRecord ? storeText(record, 'version') : '');
  const latestVersion = storeText(detail, 'latest_version') || storeText(detail, 'latest_version_display') || storeText(record, 'latest_version');
  const versions = versionList(detail);
  const indicators = Array.isArray(detail?.indicators) ? detail.indicators : parseIndicators(detail?.indicators);
  const blocked = blockingIndicators(indicators);
  const notes = [];
  if (!detail) {
    notes.push('Store App Client detail is unavailable, so entitlement, dependency and compatibility data could not be read.');
  } else {
    if (detail.can_install_or_upgrade === undefined) notes.push('The Store client did not report whether this application can be installed by this account.');
    else if (!storeFlag(detail.can_install_or_upgrade)) notes.push('The Store client reports this application cannot be installed or upgraded by this account. The platform does not say whether entitlement, licensing, or compatibility is the cause.');
    if (storeFlag(detail.block_install) || blocked.length) {
      const reasons = blocked.map(item => item.message || item.tooltip).filter(Boolean).join('; ');
      notes.push(`The Store client blocks this application on this instance${reasons ? `: ${reasons}` : ' (block_install=true)'}. A blocked application is refused before any install or update request is sent.`);
    }
    if (!versions.length) notes.push('No version list was returned; requested versions cannot be checked locally against the Store catalogue.');
    notes.push('Compatibility and entitlement output is reported exactly as the platform supplies it; jsn does not infer purchase authorization or accept commercial terms.');
  }
  return {
    sys_id: target.sys_id,
    name: detailName(detail, record, target.summary?.name),
    scope: storeText(detail, 'scope') || storeText(record, 'scope') || target.summary?.scope || '',
    vendor: storeText(detail, 'vendor') || target.summary?.vendor || null,
    source: storeText(detail, 'source') || target.summary?.source || null,
    matched_by: target.matched_by,
    is_store_app: detail?.is_store_app === undefined ? target.summary?.is_store_app ?? null : storeFlag(detail.is_store_app),
    is_plugin: detail?.isAppstorePlugin === undefined ? target.summary?.is_plugin ?? null : storeFlag(detail.isAppstorePlugin),
    installed: installed ? {
      version: installedVersion || null,
      active: detail?.active === undefined && record?.active === undefined ? null : storeFlag(detail?.active ?? record?.active),
      install_date: storeText(detail, 'install_date') || storeText(record, 'install_date') || null,
      update_date: storeText(detail, 'update_date') || storeText(record, 'update_date') || null,
    } : null,
    available: detail ? {
      latest_version: latestVersion || null,
      update_available: storeFlag(detail.isInstalledAndUpdateAvailable),
      versions: versions.length ? versions : null,
      compatibilities: detail.compatibilities ?? null,
    } : null,
    entitlement: detail ? {
      can_install_or_upgrade: detail.can_install_or_upgrade === undefined ? null : storeFlag(detail.can_install_or_upgrade),
      can_install_or_upgrade_customization: detail.can_install_or_upgrade_customization === undefined
        ? null : storeFlag(detail.can_install_or_upgrade_customization),
      needs_app_engine_licensing: storeFlag(detail.needs_app_engine_licensing),
      price_type: storeText(detail, 'price_type') || null,
      subscription_applicable: storeFlag(detail.isSubscriptionApplicable),
    } : null,
    dependencies: detail?.dependencies ?? null,
    indicators,
    blocked: detail ? Boolean(storeFlag(detail.block_install) || blocked.length) : null,
    customization_available: storeFlag(detail?.isCustomizationUpdateAvailable),
    detail_unavailable: detailUnavailable,
    notes,
  };
}

function assertOfferedVersion(detail, wanted, name) {
  const offered = versionList(detail);
  if (offered.length && !offered.includes(wanted)) {
    throw new AppError('store_version_unavailable',
      `${name || 'This application'} does not offer version ${wanted}.`,
      `Versions the Store reported: ${offered.join(', ')}. Pass one of those with --version.`);
  }
  return offered;
}

function assertInstallable(detail, verb, name) {
  if (!detail) return false;
  const blocked = blockingIndicators(detail.indicators);
  if (storeFlag(detail.block_install) || blocked.length) {
    const reasons = blocked.map(item => item.message || item.tooltip).filter(Boolean).join('; ');
    const flag = storeFlag(detail.block_install) ? 'block_install=true' : `indicator ${blocked.map(item => item.id).filter(Boolean).join(', ')}`;
    throw new AppError('store_app_not_installable',
      `The Store client blocks ${verb === 'install' ? 'installing' : 'updating'} ${name || 'this application'} on this instance${reasons ? `: ${reasons}` : '.'}`,
      `Reported flags: ${flag}. This is the platform's own refusal for this instance; `
      + 'an application can report can_install_or_upgrade=true and still be blocked here '
      + '(for example not_available_for_instance_type on a developer instance). '
      + `Run jsn store show ${name || '<application>'} to see the reported indicators, entitlement and compatibility fields.`);
  }
  if (detail.can_install_or_upgrade !== undefined && !storeFlag(detail.can_install_or_upgrade)) {
    throw new AppError('store_app_not_installable',
      `The Store client reports ${name || 'this application'} cannot be ${verb === 'install' ? 'installed' : 'updated'} by this account.`,
      'Reported flags: can_install_or_upgrade=false. '
      + 'The platform does not distinguish entitlement, licensing and compatibility as the cause, and jsn does not infer authorization to buy an application or accept commercial terms. '
      + `Run jsn store show ${name || '<application>'} to see the entitlement and compatibility fields before asking a Store administrator.`);
  }
  return true;
}

async function resolvedForMutation(sdk, identifier) {
  const target = await resolveApplication(sdk, identifier);
  let detail = null;
  let detailUnavailable = null;
  try {
    detail = await applicationDetail(sdk, target.sys_id);
  } catch (error) {
    if (error?.status === 403) detailUnavailable = 'forbidden';
    else if (error?.status === 404) detailUnavailable = 'not_found';
    else throw error;
  }
  if (!detail && !target.record && !target.summary) {
    throw errNotFoundHint('store application', identifier,
      'Neither the Store App Client nor the store application table returned this application. Search for it first: jsn store search "<term>".');
  }
  return { target, detail, detailUnavailable };
}

/** Resolve an exact app and version and describe the intended install. */
export async function prepareInstall(sdk, identifier, { version, demoData = false } = {}) {
  const { target, detail, detailUnavailable } = await resolvedForMutation(sdk, identifier);
  const wanted = String(version ?? '').trim();
  if (!wanted) {
    throw errUsageHint('Provide the exact version to install with --version.',
      'jsn store show <app> reports the versions the Store returned; jsn never picks one for you.');
  }
  const app = {
    sys_id: target.sys_id,
    name: detailName(detail, target.record, target.summary?.name),
    scope: storeText(detail, 'scope') || storeText(target.record, 'scope') || target.summary?.scope || '',
    vendor: storeText(detail, 'vendor') || target.summary?.vendor || null,
  };
  const installedVersion = storeFlag(detail?.isInstalled)
    ? storeText(detail, 'version')
    : (storeText(target.record, 'install_date') ? storeText(target.record, 'version') : '');
  if (storeFlag(detail?.isInstalled) || installedVersion) {
    throw new AppError('store_already_installed',
      `${app.name || app.sys_id} is already installed${installedVersion ? ` at version ${installedVersion}` : ''}.`,
      `Use an explicit update instead: jsn store update ${app.scope || app.sys_id} --version ${wanted}`);
  }
  const versions = assertOfferedVersion(detail, wanted, app.name);
  const installable = assertInstallable(detail, 'install', app.name);
  return {
    operation: 'install',
    app,
    requested_version: wanted,
    demo_data: Boolean(demoData),
    installed_version: null,
    versions: versions.length ? versions : null,
    installable_checked: installable,
    detail_unavailable: detailUnavailable,
  };
}

/** Resolve an installed app and the exact version to update it to. */
export async function prepareUpdate(sdk, identifier, { version } = {}) {
  const { target, detail, detailUnavailable } = await resolvedForMutation(sdk, identifier);
  const app = {
    sys_id: target.sys_id,
    name: detailName(detail, target.record, target.summary?.name),
    scope: storeText(detail, 'scope') || storeText(target.record, 'scope') || target.summary?.scope || '',
    vendor: storeText(detail, 'vendor') || target.summary?.vendor || null,
  };
  const installedVersion = storeFlag(detail?.isInstalled)
    ? storeText(detail, 'version')
    : (storeText(target.record, 'install_date') ? storeText(target.record, 'version') : '');
  if (!storeFlag(detail?.isInstalled) && !installedVersion) {
    throw new AppError('store_not_installed',
      `${app.name || app.sys_id} is not installed on this instance.`,
      `Install an exact version first: jsn store install ${app.scope || app.sys_id} --version <version>`);
  }
  const wanted = String(version ?? '').trim()
    || storeText(detail, 'latest_version')
    || storeText(detail, 'latest_version_display')
    || '';
  const versions = versionList(detail);
  if (!wanted) {
    throw errUsageHint('Provide the exact version to update to with --version.',
      versions.length ? `Versions the Store reported: ${versions.join(', ')}.` : 'The Store returned no latest version or version list to choose from.');
  }
  if (wanted === installedVersion) {
    throw new AppError('store_version_unchanged',
      `${app.name || app.sys_id} is already at version ${wanted}.`,
      `Pick a different target version${versions.length ? `: ${versions.join(', ')}` : ''}.`);
  }
  assertOfferedVersion(detail, wanted, app.name);
  const installable = assertInstallable(detail, 'update', app.name);
  return {
    operation: 'update',
    app,
    requested_version: wanted,
    from_version: installedVersion || null,
    demo_data: false,
    versions: versions.length ? versions : null,
    installable_checked: installable,
    detail_unavailable: detailUnavailable,
  };
}

/** Submit the resolved operation and require a usable tracker id back. */
export async function dispatchOperation(sdk, plan) {
  const path = plan.operation === 'update' ? UPDATE_PATH : INSTALL_PATH;
  const params = new URLSearchParams({ app_id: plan.app.sys_id, version: plan.requested_version });
  if (plan.operation === 'install') params.set('load_demo_data', String(Boolean(plan.demo_data)));
  const response = await sdk.request(`${sdk.baseURL}${path}?${params}`, { method: 'GET' });
  const result = response?.result;
  if (!result || typeof result !== 'object') {
    throw errAPI(200, `The ${plan.operation} request returned no result, so the application state is unknown. Inspect the application before retrying.`);
  }
  const tracker = result.tracker_id || result.trackerId || result.links?.progress?.id;
  if (!isSysId(String(tracker ?? ''))) {
    throw new AppError('store_tracker_missing',
      `The ${plan.operation} submission was accepted but returned no tracker id. This is not a completed installation.`,
      'Inspect the application and its install/upgrade history before retrying; do not resubmit automatically.');
  }
  return {
    tracker_id: String(tracker),
    submitted_at: new Date().toISOString(),
    provider_message: storeText(result, 'message') || null,
  };
}

/** Read one progress tracker. Terminal is not the same as successful. */
export async function operationStatus(sdk, trackerId) {
  const id = String(trackerId ?? '').trim();
  if (!isSysId(id)) throw errUsage('Use the full 32-character tracker id reported by jsn store install/update.');
  const response = await sdk.request(`${sdk.baseURL}${PROGRESS_PATH}/${encodeURIComponent(id)}`, { method: 'GET' });
  const result = response?.result;
  if (!result || typeof result !== 'object') {
    throw new AppError('store_progress_unavailable',
      `Progress tracker ${id} returned no result.`,
      'The operation may still be running. Re-read the tracker before starting another operation; jsn never resubmits automatically.');
  }
  const percent = Number(result.percent_complete);
  const status = storeText(result, 'status');
  const error = storeText(result, 'error');
  const label = storeText(result, 'status_label');
  const message = storeText(result, 'status_message');
  // The tracker's own detail line names the operation and the exact app and
  // version it acted on; it is the only place a failed submission says what it
  // tried to do.
  const detail = storeText(result, 'status_detail');
  const terminal = (Number.isFinite(percent) && percent >= 100) || status === '3' || Boolean(error);
  return {
    tracker_id: id,
    status,
    status_label: label || null,
    status_message: message || null,
    status_detail: detail || null,
    percent_complete: Number.isFinite(percent) ? percent : null,
    error: error || null,
    terminal,
    succeeded: terminal && !error && status !== '3',
  };
}

/**
 * Poll a tracker until it is terminal or the wait expires.
 *
 * An expired wait means the operation is still on the instance: the result
 * keeps the tracker id and says so, and nothing is cancelled or resubmitted.
 */
export async function waitForOperation(sdk, trackerId, {
  pollIntervalMs = 5000, timeoutMs = 1800_000, onProgress, now = Date.now, wait = sleep,
} = {}) {
  const startedAt = now();
  let progress = await operationStatus(sdk, trackerId);
  onProgress?.(progress);
  while (!progress.terminal && now() - startedAt < timeoutMs) {
    const remaining = timeoutMs - (now() - startedAt);
    await wait(Math.max(0, Math.min(pollIntervalMs, remaining)));
    progress = await operationStatus(sdk, trackerId);
    onProgress?.(progress);
  }
  return { ...progress, wait_timed_out: !progress.terminal };
}

/**
 * Read the installed record back after a reported success. A reported success
 * is not a completed installation until the instance shows the version.
 *
 * verified: true  — readback shows the requested version
 * verified: false — readback shows a different version (or no record)
 * verified: null  — the record could not be read, so nothing is claimed
 */
export async function verifyInstalledVersion(sdk, { sys_id: sysId }, expectedVersion, {
  attempts = MAX_VERSION_ATTEMPTS, intervalMs = DEFAULT_VERIFY_INTERVAL_MS, wait = sleep,
} = {}) {
  let record = null;
  let readable = false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      record = await sdk.get('sys_store_app', sysId);
      readable = true;
    } catch (error) {
      if (error?.status !== 403 && error?.status !== 404) throw error;
      readable = false;
      record = null;
    }
    if (readable && record && storeText(record, 'version') === expectedVersion) break;
    if (attempt < attempts - 1 && intervalMs > 0) await wait(intervalMs);
  }
  if (!readable) {
    return { verified: null, expected_version: expectedVersion, installed_version: null, source: 'sys_store_app', reason: 'readback_unavailable' };
  }
  const installed = storeText(record, 'version');
  return {
    verified: Boolean(record) && installed === expectedVersion,
    expected_version: expectedVersion,
    installed_version: installed || null,
    active: record ? storeFlag(record.active) : null,
    source: 'sys_store_app',
    reason: !record ? 'record_missing' : (installed === expectedVersion ? 'version_confirmed' : 'version_mismatch'),
  };
}
