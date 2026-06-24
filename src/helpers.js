// Shared helper utilities

import fs from 'node:fs';
import search from '@inquirer/search';
import { isTTY, FormatAuto } from './output.js';

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
 * @param {string} opts.query — optional encoded query
 * @param {Function} opts.formatLabel — (record) => string for the picker display
 * @param {string} opts.labelField — field used to match selection (default: 'name')
 * @returns {Promise<void>|null} null if no selection made or non-interactive
 */
export async function interactiveList({ app, table, singular, columns, limit = 20, query = '', formatLabel, labelField = 'name' }) {
  const effectiveFormat = app.output.getFormat() === FormatAuto ? (isTTY(process.stdout) ? FormatAuto : FormatAuto) : app.output.getFormat();
  if (effectiveFormat !== FormatAuto || !isTTY(process.stdout) || !isTTY(process.stdin) || query) {
    return null; // not interactive — caller should fall back to text/table
  }

  const pickerColumns = ['sys_id', labelField, ...columns.filter(c => c !== labelField && c !== 'sys_id' && c !== '*')];
  const params = new URLSearchParams();
  params.set('sysparm_limit', String(limit));
  params.set('sysparm_display_value', 'all');
  const pickerFields = pickerColumns.join(',');
  if (pickerFields) params.set('sysparm_fields', pickerFields);
  params.set('sysparm_query', 'ORDERBYDESCsys_updated_on');

  const records = await app.sdk.list(table, params);
  if (records.length === 0) return null;

  const choices = records.map(r => ({
    name: formatLabel ? formatLabel(r) : (getStringField(r, labelField) || getStringField(r, 'sys_id')),
    value: r,
  }));

  try {
    const selected = await search({
      message: `Select ${vowelArticle(singular)} ${singular}:`,
      source: async (input) => {
        if (!input) return choices;
        const term = input.toLowerCase();
        return choices.filter(c => c.name.toLowerCase().includes(term));
      },
    });
    return selected; // the record object
  } catch (err) {
    if (err.name === 'ExitPromptError' || (err.message && err.message.includes('force closed'))) {
      return null;
    }
    throw err;
  }
}

function vowelArticle(word) {
  const first = word.charAt(0).toLowerCase();
  return first === 'a' || first === 'e' || first === 'i' || first === 'o' || first === 'u' ? 'an' : 'a';
}

/**
 * Parse --data or --data-file into a JSON object.
 * If --data-file is given, reads the file. Otherwise parses --data directly.
 * Throws if neither is provided or JSON is invalid.
 */
export function parseDataArg(argv) {
  let raw;
  if (argv['data-file']) {
    raw = fs.readFileSync(argv['data-file'], 'utf-8');
  } else if (argv.data) {
    raw = argv.data;
  } else {
    throw new Error('--data or --data-file is required');
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON: ${e.message}\n\nHint: On Windows PowerShell, use --data-file instead of --data to avoid quote mangling.\nRaw value: ${raw.substring(0, 200)}`, { cause: e });
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
