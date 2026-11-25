// Preview and commit a *retrieved* update set, and read its preview problems.
//
// These are the platform's own steps: retrieving (import) only loads the XML,
// previewing compares it with the target, and committing applies it. ServiceNow
// exposes all three through the CICD Update Set API (sn_cicd):
//
//   POST /api/sn_cicd/update_set/preview/{remote_update_set_id}
//   POST /api/sn_cicd/update_set/commit/{remote_update_set_id}
//   GET  /api/sn_cicd/progress/{progress_id}
//
// The alternate path — calling hidden Ajax processors or scripting
// GlideUpdateManager2 from a background script — is deliberately not used: it
// bypasses the platform's own validation and is not a public contract.
//
// Nothing here resolves, ignores, or skips a preview problem. A human decides
// those in ServiceNow; jsn reports them and refuses to commit while unresolved
// problems remain.
import { AppError, CodeAPI, CodeUsage, errUsage } from './errors.js';

// sn_cicd progress statuses (same vocabulary as commands/atf.js).
const PROGRESS_PENDING = '0';
const PROGRESS_RUNNING = '1';
const PROGRESS_SUCCESSFUL = '2';
const PROGRESS_ERROR = '3';
const PROGRESS_CANCELED = '4';
const TERMINAL_STATUSES = new Set([PROGRESS_SUCCESSFUL, PROGRESS_ERROR, PROGRESS_CANCELED]);

// sys_update_preview_problem.status values that mean a human already decided.
const RESOLVED_PROBLEM_STATUSES = new Set(['ignored', 'skipped', 'skip_collision', 'accepted', 'resolved']);

export const PREVIEW_PROBLEM_TABLE = 'sys_update_preview_problem';
export const DEFAULT_OPERATION_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_POLL_MS = 2000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function text(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    if (value.display_value != null) return String(value.display_value);
    if (value.value != null) return String(value.value);
  }
  return String(value);
}

function statusWord(status) {
  switch (status) {
    case PROGRESS_PENDING: return 'pending';
    case PROGRESS_RUNNING: return 'running';
    case PROGRESS_SUCCESSFUL: return 'successful';
    case PROGRESS_ERROR: return 'failed';
    case PROGRESS_CANCELED: return 'canceled';
    default: return 'unknown';
  }
}

/** Normalize a sn_cicd operation/progress response into one shape. */
export function normalizeProgress(response) {
  const inner = response?.result && typeof response.result === 'object' ? response.result : (response ?? {});
  const status = inner.status == null ? '' : String(inner.status);
  const percent = Number(inner.percent_complete ?? 0);
  // Live progress bodies carry status_message:"" and put the reason in error.
  // An empty string must not mask the real failure text.
  const message = [inner.status_message, inner.status_detail, inner.error]
    .map((value) => text(value).trim())
    .find((value) => value) || '';
  return {
    status,
    label: String(inner.status_label ?? '') || statusWord(status),
    percent_complete: Number.isFinite(percent) ? percent : 0,
    message,
    progress_id: text(inner?.links?.progress?.id ?? inner.progress_id ?? ''),
    result_id: text(inner?.links?.results?.id ?? inner.result_id ?? ''),
    raw: inner,
  };
}

export function isTerminalProgress(progress) {
  if (TERMINAL_STATUSES.has(progress.status)) return true;
  return /^(successful|success|complete|completed|failed|failure|error|canceled|cancelled)$/i.test(progress.label);
}

export function isSuccessfulProgress(progress) {
  if (progress.status === PROGRESS_SUCCESSFUL) return true;
  return /^(successful|success|complete|completed)$/i.test(progress.label);
}

/**
 * Follow GET /api/sn_cicd/progress/{id} until the operation reaches a terminal
 * status or the deadline passes.
 *
 * A response without a progress link cannot be followed; it is returned as-is
 * so the caller can verify the target's own state instead of guessing.
 *
 * @param {object} sdk - SDK client (request + baseURL)
 * @param {object} initial - dispatch response from the operation endpoint
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.pollMs]
 * @param {Function} [options.wait] - sleep seam for tests
 * @param {Function} [options.now] - clock seam for tests
 * @param {Function} [options.onProgress] - called with each normalized update
 * @returns {Promise<object>} the last normalized progress
 */
export async function waitForCicdProgress(sdk, initial, options = {}) {
  const {
    timeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
    pollMs = DEFAULT_POLL_MS,
    wait = sleep,
    now = Date.now,
    onProgress,
  } = options;

  let current = normalizeProgress(initial);
  const deadline = now() + timeoutMs;
  let tracked = Boolean(current.progress_id);

  while (!isTerminalProgress(current)) {
    if (now() >= deadline) {
      throw new AppError(
        CodeAPI,
        `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the update set operation (last status: ${current.label}).\n` +
        'The operation may still be running on the instance. Inspect Retrieved Update Sets before retrying; jsn does not repeat it.',
        '',
        0,
      );
    }
    if (!tracked) return { ...current, tracked };
    await wait(pollMs);
    const response = await sdk.request(`${sdk.baseURL}/api/sn_cicd/progress/${encodeURIComponent(current.progress_id)}`, { method: 'GET' });
    const next = normalizeProgress(response);
    current = {
      ...next,
      progress_id: next.progress_id || current.progress_id,
      result_id: next.result_id || current.result_id,
    };
    tracked = Boolean(current.progress_id);
    if (typeof onProgress === 'function') onProgress(current);
  }
  return { ...current, tracked };
}

function cicdUnavailable(error) {
  if (error?.status === 404) return true;
  if (error?.status === 400 && /Requested URI does not represent any resource/i.test(error.message || '')) return true;
  return false;
}

/**
 * A sn_cicd error body can be an operation result rather than a missing route.
 * Live 404 for an unknown update set:
 *   {"result":{"status":"3","status_label":"Failed","error":"Update set with id ... cannot be found"}}
 * That is a rejected operation, not an absent plugin.
 */
function cicdOperationError(error) {
  const body = error?.message;
  if (typeof body !== 'string') return '';
  // errAPI prefixes the HTTP status, so the JSON envelope may not start the
  // message. Parse from the first brace.
  const start = body.indexOf('{');
  if (start < 0) return '';
  try {
    const result = JSON.parse(body.slice(start))?.result;
    if (result && typeof result === 'object') {
      return text(result.error || result.status_message || result.status_detail).trim();
    }
  } catch { /* not a JSON error envelope */ }
  return '';
}

/**
 * Start a sn_cicd update-set operation and wait for its tracker.
 * @param {object} sdk
 * @param {'preview'|'commit'} operation
 * @param {string} sysID - sys_remote_update_set sys_id
 */
export async function runUpdateSetOperation(sdk, operation, sysID, options = {}) {
  const endpoint = `${sdk.baseURL}/api/sn_cicd/update_set/${operation}/${encodeURIComponent(sysID)}`;
  let response;
  try {
    response = await sdk.request(endpoint, { method: 'POST', body: '{}' });
  } catch (error) {
    if (error?.status === 403) {
      throw new AppError(
        CodeUsage,
        `This account cannot use the CICD Update Set API; no ${operation} was started.`,
        'The account needs the sn_cicd.sys_ci_automation role. Preview and commit the set in ServiceNow instead.',
        403,
        error,
      );
    }
    const platformError = cicdOperationError(error);
    if (platformError) {
      throw new AppError(
        CodeAPI,
        `The CICD API rejected the ${operation}: ${platformError}`,
        `Nothing was ${operation === 'preview' ? 'previewed' : 'committed'}. Inspect the retrieved update set and try again.`,
        error.status || 0,
        error,
      );
    }
    if (cicdUnavailable(error)) {
      throw new AppError(
        CodeUsage,
        `The CICD Update Set API is not available on this instance; no ${operation} was started.`,
        'The sn_cicd plugin (com.glide.continuousdelivery) provides preview/commit. ' +
        'Preview and commit the set in ServiceNow instead: System Update Sets > Retrieved Update Sets.',
        error.status || 0,
        error,
      );
    }
    throw error;
  }

  const final = await waitForCicdProgress(sdk, response, options);
  if (!isSuccessfulProgress(final)) {
    const detail = final.message ? `: ${final.message}` : '';
    throw new AppError(
      CodeAPI,
      `Update set ${operation} did not succeed (${final.label})${detail}`,
      `Inspect Retrieved Update Sets on ${sdk.baseURL} before retrying; jsn does not retry the operation.`,
      0,
    );
  }
  return final;
}

export async function previewUpdateSet(sdk, sysID, options = {}) {
  return runUpdateSetOperation(sdk, 'preview', sysID, options);
}

export async function commitUpdateSet(sdk, sysID, options = {}) {
  return runUpdateSetOperation(sdk, 'commit', sysID, options);
}

/** Normalize a sys_update_preview_problem row without assuming optional fields. */
export function normalizePreviewProblem(record) {
  const status = text(record?.status).toLowerCase();
  return {
    sys_id: text(record?.sys_id),
    type: text(record?.type).toLowerCase(),
    description: text(record?.description) || text(record?.problem) || text(record?.message),
    status,
    resolved: RESOLVED_PROBLEM_STATUSES.has(status),
    missing_item: text(record?.missing_item),
    missing_item_table: text(record?.missing_item_table),
    remote_update: text(record?.remote_update_set),
    available_actions: text(record?.available_actions),
    sys_created_on: text(record?.sys_created_on),
  };
}

/**
 * Read the preview problems recorded for a retrieved update set.
 * @returns {Promise<{problems: object[], count: number, unresolved: object[], truncated: boolean}>}
 */
export async function listPreviewProblems(sdk, sysID, { limit = 500 } = {}) {
  const params = new URLSearchParams();
  params.set('sysparm_query', `remote_update_set=${sysID}^ORDERBYsys_created_on`);
  params.set('sysparm_display_value', 'all');
  params.set('sysparm_limit', String(limit));
  const records = await sdk.listStrict(PREVIEW_PROBLEM_TABLE, params);
  const problems = records.map(normalizePreviewProblem);
  const unresolved = problems.filter((problem) => !problem.resolved);
  return { problems, count: problems.length, unresolved, truncated: problems.length >= limit };
}

/**
 * Refuse to continue while the platform still considers preview problems
 * unresolved. jsn never accepts, skips, or ignores one on the operator's behalf.
 */
export function assertNoUnresolvedProblems({ problems, unresolved, truncated }) {
  if (truncated) {
    throw errUsage('Refusing to commit: the preview problem list is truncated. Unread problems may remain unresolved. Review and commit this set in ServiceNow; jsn cannot establish that every problem is resolved.');
  }
  if (!unresolved.length) return;
  const lines = unresolved.slice(0, 10).map((problem) => {
    const target = problem.missing_item_table
      ? `${problem.missing_item_table}${problem.missing_item ? `/${problem.missing_item}` : ''}`
      : (problem.remote_update || problem.sys_id);
    return `- ${problem.description || '(no description)'} [${target}]`;
  });
  const more = unresolved.length > lines.length ? `\n… and ${unresolved.length - lines.length} more` : '';
  throw errUsage(
    `Refusing to commit: ${unresolved.length} of ${problems.length} preview problem(s) are unresolved.\n` +
    `${lines.join('\n')}${more}\n` +
    'Resolve each problem in ServiceNow (Accept or Skip remote update), then rerun preview. jsn does not resolve problems automatically.',
  );
}
