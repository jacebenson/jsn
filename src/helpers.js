// Shared helper utilities

import fs from 'node:fs';
import readline from 'node:readline';
import { paginatedSearch } from './paginated-search.js';
import { isTTY, FormatAuto } from './output.js';
import { getActiveProfile } from './config.js';
import { errConfirmationRequired } from './errors.js';

/**
 * Detect whether a human is actually available to answer interactive
 * prompts. Agent tooling (VSCode Copilot, Claude Code, Cursor, etc.)
 * allocates a PTY for subprocesses, so isTTY() returns true even though
 * no one will ever type a response. Those environments set signals that
 * let us fall back to non-interactive behavior instead of hanging:
 *
 *   - JSN_NO_PROMPTS=1        (explicit opt-out, documented for agents)
 *   - CI / NONINTERACTIVE / GITHUB_ACTIONS
 *   - CLAUDE_CODE / COPILOT_* / CURSOR_* agent markers
 *   - TERM=dumb
 *
 * @returns {boolean} true when a human can answer a prompt
 */
export function canPrompt() {
  if (process.env.JSN_NO_PROMPTS === '1') return false;
  if (process.env.CI === 'true' || process.env.CI === '1') return false;
  if (process.env.NONINTERACTIVE === 'true' || process.env.NONINTERACTIVE === '1') return false;
  if (process.env.GITHUB_ACTIONS === 'true') return false;
  if (process.env.TERM === 'dumb') return false;
  const agentMarkers = ['CLAUDE_CODE', 'COPILOT_AGENT', 'VSCODE_AGENT', 'CURSOR_AGENT', 'CODEX_AGENT', 'GITHUB_COPILOT_AGENT'];
  if (agentMarkers.some((m) => process.env[m] === 'true' || process.env[m] === '1')) return false;
  return isTTY(process.stdout) && isTTY(process.stdin);
}

/**
 * Confirm a destructive action before executing.
 *
 * Default posture is ASK: interactive terminals get a y/N prompt;
 * non-interactive invocation (pipes, scripts, AI agents) is rejected
 * unless --force is passed. A profile can opt out entirely with the
 * per-instance `skip_confirmations` flag (set via `auth login
 * --skip-confirmations`).
 *
 * @param {object} app — app instance (reads active profile from app.config)
 * @param {object} argv — parsed args (checks argv.force)
 * @param {string} question — e.g. `Delete incident INC0010001?`
 * @returns {Promise<boolean>} true when the action may proceed
 * @throws when confirmation is required but denied/unavailable
 */
export async function confirmDelete(app, argv, question) {
  const profile = getActiveProfile(app.config);
  if (profile?.skip_confirmations === true) return true;
  if (argv.force) return true;
  if (canPrompt()) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) => {
      rl.question(`${question} (y/N): `, resolve);
    });
    rl.close();
    const response = answer.trim().toLowerCase();
    if (response !== 'y' && response !== 'yes') {
      throw new Error('Deletion cancelled');
    }
    return true;
  }
  // No human available (pipes, scripts, AI agents). Fail fast with a
  // structured error an agent can act on — never hang waiting for stdin.
  const cmd = ['jsn', ...(argv._ || [])].join(' ');
  throw errConfirmationRequired(question, cmd);
}


export function getStringField(record, field) {
  if (!record || typeof record !== 'object') return '';
  const val = record[field];
  if (val == null) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'object') {
    if (val.display_value != null) return String(val.display_value);
    if (val.value != null) return String(val.value);
  }
  return String(val);
}

/**
 * Extract the raw value from a field that may be a string or a
 * {display_value, value} object returned by the Table API.
 * Prefers .value (the raw stored value) over .display_value.
 */
function getRawValue(val) {
  if (val == null) return '';
  if (typeof val === 'object') {
    if (val.value != null) return String(val.value);
    if (val.display_value != null) return String(val.display_value);
    return '';
  }
  return String(val);
}

/**
 * Normalize a value the user supplied in --data for comparison against
 * what the API persisted. Objects like {"value": "<sys_id>"} are unwrapped.
 */
function normalizeSupplied(val) {
  if (val == null) return '';
  if (typeof val === 'object') {
    if (val.value != null) return String(val.value);
    return '';
  }
  return String(val);
}

/**
 * Write-back verification for records create/update.
 *
 * After a mutation, re-GET the record and compare each field supplied in
 * --data against what actually persisted. Surfaces silent server-side
 * drops (inherited references, ACL-restricted fields, IO: prefixed strings,
 * platform quirks) that ServiceNow ignores without erroring.
 *
 * Skips sys_* fields (system-managed, already warned by checkDerivedFields).
 *
 * @returns {Promise<Array<{field: string, sent: string, got: string}>>}
 */
export async function verifyWriteBack(app, table, sysID, sentData) {
  const mismatches = [];
  if (!sysID || !sentData || typeof sentData !== 'object') return mismatches;

  const fields = Object.keys(sentData).filter(f => f !== 'sys_id' && !f.startsWith('sys_'));
  if (fields.length === 0) return mismatches;

  let persisted;
  try {
    const params = new URLSearchParams();
    params.set('sysparm_query', `sys_id=${sysID}`);
    params.set('sysparm_limit', '1');
    params.set('sysparm_display_value', 'all');
    params.set('sysparm_fields', ['sys_id', ...fields].join(','));
    const records = await app.sdk.list(table, params);
    persisted = records[0] || null;
  } catch {
    // Verification GET failed — don't fail the mutation, just report it.
    mismatches.push({ field: '(verify)', sent: '', got: 'write-back check failed (GET error)' });
    return mismatches;
  }

  if (!persisted) {
    mismatches.push({ field: '(verify)', sent: '', got: 'record not found after write' });
    return mismatches;
  }

  for (const field of fields) {
    const sent = normalizeSupplied(sentData[field]);
    const got = getRawValue(persisted[field]);
    if (sent !== got) {
      mismatches.push({ field, sent, got });
    }
  }

  return mismatches;
}

export function formatRecordForDisplay(record, columns) {
  const result = {};

  function extractValue(val) {
    if (val == null) return '';
    if (typeof val === 'string') return val;
    if (typeof val === 'object') {
      if (val.display_value != null && val.display_value !== '') return String(val.display_value);
      if (val.value != null) return String(val.value);
    }
    return String(val);
  }

  if (record.sys_id != null) {
    result.sys_id = extractValue(record.sys_id);
  }

  for (const col of columns) {
    if (record[col] != null) {
      result[col] = extractValue(record[col]);
    } else {
      result[col] = '';
    }
  }
  return result;
}

export function truncateString(str, maxLen) {
  if (!str || str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}

export function isHexString(str) {
  return /^[0-9a-fA-F]+$/.test(str);
}

export function extractProfileName(instanceURL) {
  let name = instanceURL.replace(/^https?:\/\//, '');
  name = name.replace(/\.service-now\.com$/, '');
  name = name.replace(/\.servicenowservices\.com$/, '');
  return name;
}

export function buildQuerySuffix(query) {
  return query ? ` --query "${query}"` : '';
}

/**
 * Resolve sysparm_fields value from user-supplied columns.
 * Returns null when columns includes '*' (signals "fetch all fields"),
 * so callers should omit sysparm_fields and skip formatRecordForDisplay.
 * Otherwise returns the fields string with sys_id prepended.
 */
export function resolveFieldsParam(columns) {
  if (columns.includes('*')) return null;
  return ['sys_id', ...columns].join(',');
}

// ServiceNow encoded-query metacharacters. In sysparm_query, `^` is the
// AND-separator (^OR starts an OR clause), `= < > ~ !` are operators,
// and `,` is used by IN lists. An identifier containing any of these
// silently broadens an exact-match lookup — with sysparm_limit=1 the
// wrong record wins (issue #143 finding #5). Exact-match identifiers
// (numbers, sys_ids, names) never legitimately contain them.
const QUERY_METACHARS = /[\\^=<>~!,]/;

/**
 * Validate that an identifier is safe to use in an exact-match encoded
 * query (field=value). Throws when the value contains characters that
 * would change the query semantics.
 * @param {string} value — identifier (number, sys_id, name)
 */
export function assertSafeExactMatch(value) {
  if (typeof value === 'string' && value.includes('*')) {
    throw new Error(
      'Unsafe identifier for exact-match lookup: contains wildcard (*). ' +
      'Refusing to build a query that could match more than the named record.'
    );
  }
  if (value && QUERY_METACHARS.test(value)) {
    throw new Error(
      `Unsafe identifier for exact-match lookup: contains ServiceNow query characters (^ = < > ~ ! ,). ` +
      `Refusing to build a query that could match more than the named record.`
    );
  }
}

/**
 * Shared interactive list helper with search-as-you-type.
 * All list commands that want an interactive TTY picker should use this.
 *
 * @param {object} opts
 * @param {App} opts.app
 * @param {string} opts.table — ServiceNow table name
 * @param {string} opts.singular — e.g. "script include", "log entry"
 * @param {string[]} opts.columns — default display columns
 * @param {number} opts.limit — max records (default 20)
 * @param {string} opts.query — optional encoded query, folded into every
 *   request (browse pages, search-as-you-type, and the aggregate count)
 * @param {Function} opts.formatLabel — (record) => string for the picker display
 * @param {string} opts.labelField — field used to match selection (default: 'name')
 * @param {string} [opts.message] — picker prompt message
 *   (default: "Select a <singular>")
 * @param {Function} [opts.formatValue] — (record) => value for the choice;
 *   defaults to returning the full record on selection
 * @param {Function} [opts.promptFn] — test seam: replaces paginatedSearch;
 *   injecting it also bypasses the TTY/canPrompt gate (the test drives the
 *   interactive path explicitly)
 * @returns {Promise<*|null|undefined>} the selected record (or formatValue
 *   result), undefined when the user cancelled, null when non-interactive
 */
export async function interactiveList({ app, table, singular, columns, limit = 50, query = '', formatLabel, labelField = 'name', message, formatValue, promptFn }) {
  const prompt = promptFn || paginatedSearch;
  app.requireInstance();
  const effectiveFormat = app.output.getFormat() === FormatAuto ? (isTTY(process.stdout) ? FormatAuto : FormatAuto) : app.output.getFormat();
  if (!promptFn && (effectiveFormat !== FormatAuto || !canPrompt())) {
    return null; // not interactive — caller should fall back to text/table
  }

  const pickerColumns = ['sys_id', labelField, ...columns.filter(c => c !== labelField && c !== 'sys_id' && c !== '*')];
  const pickerFields = pickerColumns.join(',');
  const baseQuery = query ? query + '^' : '';

  // Get total count
  let totalCount;
  try {
    totalCount = await app.sdk.aggregateCount(table, query || '');
  } catch {
    totalCount = 0;
  }
  if (totalCount === 0) return null;

  // Paginated source adapter: (term, offset, { signal }) => choices[]
  async function serverSource(term, offset, { signal: _signal } = {}) {
    try {
      const params = new URLSearchParams();
      params.set('sysparm_limit', String(limit));
      params.set('sysparm_display_value', 'all');
      if (pickerFields) params.set('sysparm_fields', pickerFields);
      if (term) {
        params.set('sysparm_query', `${baseQuery}${labelField}LIKE${term}^ORDERBYDESCsys_updated_on`);
      } else {
        params.set('sysparm_query', baseQuery + 'ORDERBYDESCsys_updated_on');
        params.set('sysparm_offset', String(offset));
      }
      const records = await app.sdk.list(table, params);
      if (!Array.isArray(records)) {
        console.error('SDK non-array:', typeof records);
        return [];
      }
      return records.map(r => ({
        name: formatLabel ? formatLabel(r) : (getStringField(r, labelField) || getStringField(r, 'sys_id')),
        value: formatValue ? formatValue(r) : r,
      }));
    } catch (err) {
      console.error('serverSource error:', err.message || err);
      return [];
    }
  }

  const selected = await prompt({
    message: message || `Select ${singular === 'flow' ? 'a flow' : `a ${singular}`}`,
    pageSize: 10,
    totalCount,
    source: serverSource,
  });

  return selected?.value; // unwrap {name, value}, undefined on cancel
}

/**
 * Maps table name → array of field names that are computed by the platform.
 * When a create/update payload contains these, a warning is emitted.
 */
export const DERIVED_FIELDS = {
  sys_ws_operation: ['operation_uri'],
  sys_ws_definition: ['base_uri'],
  incident: ['sys_created_on', 'sys_updated_on', 'sys_created_by', 'sys_updated_by', 'sys_mod_count'],
  change_request: ['sys_created_on', 'sys_updated_on', 'sys_created_by', 'sys_updated_by', 'sys_mod_count'],
  // Generic — all sys_ fields are system-managed
};

/**
 * Check a data payload for fields that appear to be derived/read-only.
 * Returns an array of warning objects ({field, hint}) for any matches.
 * @param {string} table - Table name (e.g. 'sys_ws_operation')
 * @param {object} data - The JSON payload being sent
 * @returns {Array<{field: string, hint: string}>}
 */
export function checkDerivedFields(table, data) {
  if (!data || typeof data !== 'object') return [];
  const warnings = [];

  // Check explicitly known derived fields for this table
  const knownFields = DERIVED_FIELDS[table] || [];
  for (const field of knownFields) {
    if (field in data && data[field] != null) {
      warnings.push({
        field,
        hint: `${field} is a derived/read-only field. Setting it directly will be ignored.`,
      });
    }
  }

  // Warn about any sys_* fields that look like system-managed metadata
  // (but be careful — not all sys_ fields are read-only)
  if (data.sys_created_on) {
    warnings.push({
      field: 'sys_created_on',
      hint: 'sys_created_on is a system-managed field. Setting it directly will be ignored.',
    });
  }
  if (data.sys_updated_on) {
    warnings.push({
      field: 'sys_updated_on',
      hint: 'sys_updated_on is a system-managed field. Setting it directly will be ignored.',
    });
  }

  return warnings;
}

/**
 * Parse --data, --data-file, or --data-stdin into a JSON object.
 * Priority: --data-file > --data-stdin > --data
 * Throws if none is provided or JSON is invalid.
 */
export function parseDataArg(argv) {
  let raw;
  if (argv['data-file']) {
    raw = fs.readFileSync(argv['data-file'], 'utf-8');
    // Strip UTF-8 BOM (\\ufeff) which some editors (Windows/PowerShell) add
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  } else if (argv['data-stdin']) {
    raw = fs.readFileSync(process.stdin.fd, 'utf-8');
  } else if (argv.data) {
    raw = argv.data;
  } else {
    throw new Error('--data, --data-file, or --data-stdin is required');
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON: ${e.message}\n\nHint: Use --data-file for multiline payloads to avoid shell escaping issues.\nRaw value: ${raw.substring(0, 200)}`, { cause: e });
  }
}

/**
 * Translate human-readable type names to ServiceNow item_option_new type IDs.
 * Maps common names like "date", "select", "multilinetext" to their integer IDs.
 * Passes through numeric values unchanged.
 */
const ITEM_OPTION_TYPE_NAMES = {
  '1': 1, 'yesno': 1, 'yes/no': 1, 'boolean': 1,
  '2': 2, 'multilinetext': 2, 'textarea': 2, 'multiline': 2,
  '3': 3, 'multiplechoice': 3,
  '4': 4, 'numericscale': 4, 'rating': 4,
  '5': 5, 'select': 5, 'dropdown': 5, 'choice': 5, 'selectbox': 5,
  '6': 6, 'string': 6, 'text': 6, 'singlelinetext': 6,
  '7': 7, 'checkbox': 7, 'check': 7,
  '8': 8, 'reference': 8, 'lookup': 8,
  '9': 9, 'date': 9,
  '10': 10, 'datetime': 10, 'date/time': 10,
  '11': 11, 'label': 11,
  '14': 14, 'custom': 14,
  '18': 18, 'lookupselect': 18, 'lookupselectbox': 18,
  '20': 20, 'containerstart': 20,
  '21': 21, 'listcollector': 21,
  '23': 23, 'html': 23,
  '26': 26, 'email': 26,
  '29': 29, 'duration': 29,
  '31': 31, 'requestedfor': 31,
  '32': 32, 'richtextlabel': 32, 'richtext': 32,
};

export function resolveItemOptionType(type) {
  if (type == null) return 6; // default: Single Line Text
  if (typeof type === 'number') return type;
  const lower = String(type).toLowerCase().replace(/[\s_-]/g, '');
  if (ITEM_OPTION_TYPE_NAMES[lower] != null) return ITEM_OPTION_TYPE_NAMES[lower];
  const asNum = parseInt(String(type), 10);
  if (!isNaN(asNum) && asNum > 0 && asNum < 100) return asNum;
  return 6; // fallback to Single Line Text
}
