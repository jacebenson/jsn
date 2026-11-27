// Install a native app package on an instance through the platform's own
// upload processor — then prove the result by reading it back.
//
// The contract is the one the official SDK's app-client connector uses, not a
// guess:
//
//   GET  {instance}/upload.do?sysparm_target=sys_app
//        The upload form page. Its hidden sysparm_ck input is the CSRF token,
//        scraped exactly as the update-set XML upload scrapes its own page.
//
//   POST {instance}/sn_appclient_upload_processor.do?<params>
//        multipart: upload_type=file, load_demo=<true|false>,
//        sysparm_ck=<token>, attachFile=<zip> as <scope>_<version>.zip
//        headers: Cookie + X-UserToken: <token>
//
//   GET  {instance}/api/sn_cicd/progress/<executionTracker>
//        The same tracker endpoint preview/commit use; polled to a terminal
//        state by waitForCicdProgress().
//
// Three rules are contracts, not conveniences:
//
//  * A redirect is never followed and never means success. The processor
//    answers 3xx only when the session/auth disagrees with the request. The SDK
//    transport already refuses redirects (`fetch(..., { redirect: 'error' })`),
//    so a 3xx surfaces as a fetch failure whose cause says "unexpected
//    redirect"; both that shape and a status-carrying error are classified as
//    a hard failure that says the app was not installed.
//  * The only success signal is a JSON body carrying `executionTracker`. A 200
//    with HTML (a login page is the classic case), an empty body, or JSON with
//    no tracker is a failure — never "install started".
//  * The tracker's own verdict decides. A tracker that reports unsuccessful is
//    a failed install even though the upload answered 200.
//
// "Uploaded" is not "installed", and "installed" is not "installed correctly":
// after the tracker goes terminal the caller re-reads the sys_app row and every
// packaged record and compares them with what the package carried. A
// disagreement is a failed deploy, listed field by field, never a warning.

import { AppError, CodeAPI, CodeUsage } from './errors.js';
import {
  buildPackageZip, packageAppSysId, recordVerificationFields, scopeVerificationFields,
} from './app-build-package.js';
import { isSuccessfulProgress, waitForCicdProgress } from './update-set-apply.js';
import { parseUploadFormCSRF } from './sdk.js';

export const UPLOAD_PROCESSOR = '/sn_appclient_upload_processor.do';
export const UPLOAD_FORM_PATH = '/upload.do?sysparm_target=sys_app';

/**
 * The processor's query string, in the order the connector sends it.
 *
 * `sysparm_register_scope=true` is only sent when the scope does not exist on
 * the instance yet: it tells the platform to create the scope record alongside
 * the app. Sending it for a scope that already exists asks the platform to
 * register a second one.
 *
 * @param {{app: object, registerScope: boolean}} input
 * @returns {URLSearchParams}
 */
export function uploadQueryParams({ app, registerScope }) {
  const params = new URLSearchParams();
  params.set('sysparm_track_fluent_install', 'true');
  params.set('sysparm_async_fluent_install', 'true');
  params.set('sysparm_request_type', 'custom_app');
  params.set('sysparm_fluent_scope_id', packageAppSysId(app));
  params.set('sysparm_fluent_scope_name', String(app.scope));
  params.set('sysparm_fluent_app_version', String(app.version));
  if (registerScope === true) params.set('sysparm_register_scope', 'true');
  return params;
}

/**
 * The multipart body. Field names and the attachment filename are the
 * connector's contract (`<scope>_<version>.zip`).
 *
 * @param {{app: object, zip: Buffer|Uint8Array, csrf: string, demoData?: boolean}} input
 * @returns {FormData}
 */
export function uploadForm({ app, zip, csrf, demoData = false }) {
  const form = new FormData();
  form.set('upload_type', 'file');
  form.set('load_demo', demoData === true ? 'true' : 'false');
  form.set('sysparm_ck', csrf);
  form.set('attachFile', new Blob([zip], { type: 'application/zip' }), `${app.scope}_${app.version}.zip`);
  return form;
}

/**
 * The tracker id from an upload response body, or '' when the body is not a
 * JSON install response.
 *
 * Only `executionTracker` counts. A body that parses as JSON but carries
 * something else (a redirect notice, an error envelope) is not an install.
 *
 * @param {string} body
 * @returns {string}
 */
export function executionTrackerFrom(body) {
  let payload;
  try {
    payload = JSON.parse(String(body ?? ''));
  } catch {
    return '';
  }
  if (!payload || typeof payload !== 'object') return '';
  // The connector reads it at the top level; accept the `result` envelope the
  // table/CICD APIs use without accepting any other key.
  for (const candidate of [payload, payload.result, payload.result?.result]) {
    if (!candidate || typeof candidate !== 'object') continue;
    const value = candidate.executionTracker;
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

/** A short, non-echoing description of a body that carried no tracker. */
function describeBody(body) {
  const text = String(body ?? '');
  if (!text.trim()) return 'an empty body';
  const size = `${Buffer.byteLength(text, 'utf8')} bytes`;
  return /^\s*</.test(text)
    ? `an HTML document (${size}: a login or error page, not an install response)`
    : `a body without an executionTracker (${size})`;
}

/**
 * Whether a transport error is the refusal-to-follow-a-redirect failure.
 *
 * The SDK forces `redirect: 'error'`, so undici rejects with a TypeError whose
 * cause is "unexpected redirect" and there is no status to read. An error that
 * does carry a 3xx status is the same condition.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isRedirectFailure(error) {
  const status = Number(error?.status);
  if (status >= 300 && status < 400) return true;
  const cause = error?.cause?.message || error?.cause || '';
  return /unexpected redirect|redirect(?:ed)? mode/i.test(String(cause));
}

function notInstalled(message, hint, cause = null) {
  return new AppError(CodeAPI, message, hint, 0, cause);
}

/**
 * Start the install and return its tracker id.
 *
 * Every rejection here happens before the platform has been asked to install
 * anything, so the message can say so plainly.
 *
 * @param {{sdk: object, project: object, zip: Buffer, demoData?: boolean}} input
 * @returns {Promise<{tracker: string}>}
 */
async function startInstall({ sdk, project, zip, demoData = false }) {
  const app = project.app;
  const cookies = await sdk._warmSession();

  const formURL = `${sdk.baseURL}${UPLOAD_FORM_PATH}`;
  const html = await sdk.rawRequest(formURL, { method: 'GET', headers: cookies ? { Cookie: cookies } : {} });
  const csrf = parseUploadFormCSRF(html);
  if (!csrf) {
    throw new AppError(
      CodeUsage,
      'The app upload form is unavailable; nothing was uploaded. Check admin access and session authentication.',
      'Installing a custom app needs an authenticated UI session and the admin role. Re-authenticate (jsn auth login) and re-run.',
      0,
    );
  }

  const scopeRows = await sdk.list('sys_scope', new URLSearchParams({
    sysparm_query: `scope=${app.scope}`,
    sysparm_fields: 'sys_id',
    sysparm_limit: '1',
    sysparm_display_value: 'false',
  }));
  // `global` always exists and is never registered by an install.
  const registerScope = app.scope !== 'global' && !(Array.isArray(scopeRows) && scopeRows.length > 0);

  const params = uploadQueryParams({ app, registerScope });
  const endpoint = `${sdk.baseURL}${UPLOAD_PROCESSOR}?${params.toString()}`;
  let body;
  try {
    body = await sdk.rawRequest(endpoint, {
      method: 'POST',
      body: uploadForm({ app, zip, csrf, demoData }),
      headers: {
        ...(cookies ? { Cookie: cookies } : {}),
        'X-UserToken': csrf,
        Referer: formURL,
      },
    });
  } catch (error) {
    if (isRedirectFailure(error)) {
      throw notInstalled(
        `The app install endpoint answered with a redirect instead of an install tracker: the app was not installed.\n`
        + 'This processor never redirects on success — a redirect means the request was not accepted as an authenticated install (session or CSRF conflict).',
        'Re-authenticate this profile (jsn auth login), confirm the account still has the admin role, then re-run: jsn app deploy --dir <project> --yes',
        error,
      );
    }
    throw error;
  }

  const tracker = executionTrackerFrom(body);
  if (!tracker) {
    throw notInstalled(
      `The app install was not started: the upload processor answered with ${describeBody(body)}.\n`
      + 'Nothing is treated as installed without an executionTracker.',
      'Check that the account can install custom apps (admin role) and that the instance is not serving a login page. Re-authenticate with jsn auth login and re-run.',
    );
  }
  return { tracker };
}

/**
 * Poll the install tracker to a terminal state and judge its verdict.
 *
 * @param {object} sdk
 * @param {string} tracker
 * @param {object} [options] — waitForCicdProgress seams (timeoutMs, pollMs, wait, now)
 * @returns {Promise<object>} the terminal normalized progress
 */
export async function awaitInstall(sdk, tracker, options = {}) {
  // The tracker is the same sn_cicd progress endpoint preview/commit poll, so
  // the waiting is the same code. Only the label a human reads differs.
  const progress = await waitForCicdProgress(sdk, {
    result: { links: { progress: { id: tracker } } },
  }, { ...options, operation: 'app install', inspectHint: 'Application Manager → Installed apps' });

  if (!isSuccessfulProgress(progress)) {
    const detail = progress.message ? `: ${progress.message}` : '';
    throw notInstalled(
      `The app install did not succeed (${progress.label}${progress.percent_complete ? `, ${progress.percent_complete}%` : ''})${detail}.\n`
      + 'The upload was accepted, but the install tracker reports a failure, so the app is not deployed.',
      'Inspect Application Manager → Installed apps (and the instance log) before retrying. jsn does not repeat the install.',
    );
  }
  return progress;
}

/** Raw text of a field that may be a string or a {value, display_value} object. */
function rawText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if (value.value !== null && value.value !== undefined) return String(value.value);
    if (value.display_value !== null && value.display_value !== undefined) return String(value.display_value);
    return '';
  }
  return String(value);
}

/**
 * Compare one field the package carried with what the instance stored.
 *
 * Code fields are compared as bytes: the package writes a script verbatim (CRLF
 * and BOM included), so anything the instance changed is a real difference, not
 * a formatting nicety.
 */
function compareField({ table, sysId, field, actual }) {
  if (field.code) {
    const uploaded = Buffer.from(field.value, 'utf8');
    const stored = Buffer.from(actual, 'utf8');
    if (uploaded.equals(stored)) return null;
    const limit = Math.min(uploaded.length, stored.length);
    let offset = 0;
    while (offset < limit && uploaded[offset] === stored[offset]) offset += 1;
    return `${table}/${sysId} ${field.name}: stored script is not the uploaded script `
      + `(uploaded ${uploaded.length} bytes, stored ${stored.length} bytes, first difference at byte ${offset})`;
  }
  if (field.value !== actual) {
    return `${table}/${sysId} ${field.name}: uploaded ${JSON.stringify(field.value)}, instance has ${JSON.stringify(actual)}`;
  }
  return null;
}

/** Fetch one row by sys_id with raw (not display) values. */
async function readRow(sdk, table, sysId, fieldNames) {
  const rows = await sdk.list(table, new URLSearchParams({
    sysparm_query: `sys_id=${sysId}`,
    sysparm_fields: fieldNames.join(','),
    sysparm_limit: '1',
    sysparm_display_value: 'false',
  }));
  return Array.isArray(rows) ? rows : [];
}

/**
 * Read back everything the package installed and compare it field by field.
 *
 * Returns every disagreement rather than stopping at the first: an operator
 * fixing a project needs the whole list, and a deploy that reports "1 of 7
 * verified" without saying which six failed is not actionable.
 *
 * @param {{sdk: object, project: object}} input
 * @returns {Promise<{app_verified: boolean, verified: number, total: number, mismatches: string[]}>}
 */
export async function verifyInstall({ sdk, project }) {
  const app = project.app;
  const appSysId = packageAppSysId(app);
  const mismatches = [];

  const scopeFields = scopeVerificationFields(project);
  const rows = await sdk.list('sys_app', new URLSearchParams({
    sysparm_query: `scope=${app.scope}`,
    sysparm_fields: scopeFields.map(field => field.name).join(','),
    sysparm_limit: '2',
    sysparm_display_value: 'false',
  }));
  const appRows = Array.isArray(rows) ? rows : [];
  let appVerified = false;
  if (appRows.length !== 1) {
    mismatches.push(`sys_app: expected exactly one row for scope ${app.scope}, the instance returned ${appRows.length}`);
  } else if (rawText(appRows[0].sys_id) !== appSysId) {
    mismatches.push(`sys_app: uploaded sys_id ${appSysId}, the scope ${app.scope} belongs to ${rawText(appRows[0].sys_id) || '(no sys_id)'}`);
  } else {
    appVerified = true;
    for (const field of scopeFields.filter(entry => entry.verify !== false)) {
      const difference = compareField({ table: 'sys_app', sysId: appSysId, field, actual: rawText(appRows[0][field.name]) });
      if (difference) mismatches.push(difference);
    }
  }

  let verified = 0;
  for (const record of project.records) {
    const fields = recordVerificationFields(record, app);
    const found = await readRow(sdk, record.table, record.sys_id, fields.map(field => field.name));
    if (found.length !== 1) {
      mismatches.push(`${record.table}/${record.sys_id}: expected exactly one record, the instance returned ${found.length}`);
      continue;
    }
    const differences = [];
    for (const field of fields) {
      const difference = compareField({
        table: record.table, sysId: record.sys_id, field, actual: rawText(found[0][field.name]),
      });
      if (difference) differences.push(difference);
    }
    if (differences.length) mismatches.push(...differences);
    else verified += 1;
  }

  return { app_verified: appVerified, verified, total: project.records.length, mismatches };
}

/**
 * Build, upload, wait for the tracker, then verify the instance.
 *
 * @param {object} input
 * @param {object} input.sdk — SDKClient (or a fake with the same transport seam)
 * @param {object} input.project — from readAppProject()
 * @param {{entries: Array, inventory: string, zip: Buffer}} [input.built] — from
 *   buildPackageZip(); built here when omitted
 * @param {boolean} [input.demoData]
 * @param {object} [input.options] — build clock, tracker seams, rerun hint
 * @returns {Promise<object>} the deploy report
 */
export async function deployAppPackage({
  sdk, project, built = null, demoData = false, options = {},
}) {
  const app = project.app;
  // A build failure throws here, before the first request: nothing is uploaded.
  const artifact = built ?? buildPackageZip(project, { now: options.now });
  const appSysId = packageAppSysId(app);

  const { tracker } = await startInstall({ sdk, project: { app }, zip: artifact.zip, demoData });
  const progress = await awaitInstall(sdk, tracker, options.tracker);

  const verification = await verifyInstall({ sdk, project });
  if (verification.mismatches.length) {
    const listed = verification.mismatches.map(line => `  - ${line}`).join('\n');
    const error = new AppError(
      CodeAPI,
      `The app installed, but the instance does not hold what was uploaded: `
      + `${verification.verified} of ${verification.total} records verified, `
      + `${verification.mismatches.length} disagreement(s).\n${listed}\n`
      + 'This deploy failed: jsn never reports a mismatched install as deployed.',
      `Inspect the installed app (sys_app ${appSysId}, scope ${app.scope}) and re-run: ${options.rerun || 'jsn app deploy --dir <project> --yes'}`,
      0,
    );
    error.report = { ...verification, tracker, app_sys_id: appSysId };
    throw error;
  }

  return {
    app: app.name,
    scope: app.scope,
    version: app.version,
    sys_id: appSysId,
    backend: 'package',
    uploaded: true,
    demo_data: demoData === true,
    bytes: artifact.zip.length,
    entries: artifact.entries.length,
    tracker: {
      id: tracker,
      status: progress.status,
      label: progress.label,
      percent_complete: progress.percent_complete,
      message: progress.message,
    },
    app_verified: verification.app_verified,
    records: { verified: verification.verified, total: verification.total },
    written_to_instance: true,
  };
}
