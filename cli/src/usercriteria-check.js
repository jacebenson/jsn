// jsn usercriteria check: can this user see this catalog item, and which of its Available for and
// Not available for criteria match them? Criteria scripts only run on the server, so one background
// script asks the evaluators the platform's User Criteria Diagnostics uses. The script only reads.
import { AppError, CodeAPI, errNotFound, errUsage } from './errors.js';
import { findUser } from './impersonation.js';
import { isSysId } from './resolve-record.js';

const MARK = 'JSN_UC_CHECK:';
const LIMIT = 100;
const LISTS = [['available_for', 'sc_cat_item_user_criteria_mtom'], ['not_available_for', 'sc_cat_item_user_criteria_no_mtom']];
const malformed = () => new AppError(CodeAPI, 'The user criteria check returned no readable result.');

export function parseCheckArgs({ user, item }) {
  const clean = value => typeof value === 'string' ? value.trim() : '';
  const who = clean(user), what = clean(item);
  if (!who || /^-|[\^\p{Cc}]/u.test(who)) throw errUsage('<user> must be a user_name or sys_id.');
  if (!what || /^-|[\^\p{Cc}]/u.test(what)) throw errUsage('<item> must be a catalog item name or sys_id.');
  return { user: who, item: what };
}

// The ids are validated sys_ids, so they are safe inside quotes. ES5, as background scripts run.
// Only active criteria count, as in User Criteria Diagnostics; canViewCheck is the platform's verdict.
function checkScript(userSysId, itemSysId) {
  return `(function () {
  var out = { lists: {} }, ids = [], lists = ${JSON.stringify(LISTS)};
  var user = GlideUser.getUserByID('${userSysId}');
  out.guest = !!user.isDefault();
  out.can_view = !!GlideappCatalogItem.get('${itemSysId}').canViewCheck(false, null, user);
  for (var l = 0; l < lists.length; l++) {
    var rows = [], gr = new GlideRecord(lists[l][1]);
    gr.addQuery('sc_cat_item', '${itemSysId}');
    gr.addNotNullQuery('user_criteria');
    gr.addQuery('user_criteria.active', true);
    gr.orderBy('user_criteria.name');
    gr.setLimit(${LIMIT + 1});
    gr.query();
    while (gr.next()) {
      rows.push({ sys_id: gr.getValue('user_criteria'), name: gr.getDisplayValue('user_criteria') });
      if (rows.length <= ${LIMIT}) ids.push(gr.getValue('user_criteria'));
    }
    out.lists[lists[l][0]] = rows;
  }
  var matched = ids.length ? SNC.UserCriteriaLoader.getMatchingCriteria('${userSysId}', ids) : [];
  out.matched = [];
  for (var i = 0; matched && i < matched.length; i++) out.matched.push(String(matched[i]));
  gs.print('${MARK}' + JSON.stringify(out));
})();`;
}

function verdict(user, item, canView, available, notAvailable, guest, more) {
  const names = rows => rows.filter(row => row.matched).map(row => row.name).join(', ');
  const blocked = names(notAvailable), allowed = names(available);
  const reason = blocked ? `${user} matches Not available for: ${blocked}, which overrides Available for.`
    : allowed ? `${user} matches Available for: ${allowed}.`
      : available.length ? `${user} matches none of the Available for criteria.`
        : 'The item has no active Available for criteria.';
  const lines = [`${user} ${canView ? 'can' : 'cannot'} see ${item.name}.`, reason];
  const threw = [...available, ...notAvailable].filter(row => row.script_error).map(row => row.name).join(', ');
  if (threw) lines.push(`The script of ${threw} threw an error, which the platform counts as no match.`);
  if (!item.active) lines.push('The item is inactive.');
  // As User Criteria Diagnostics does: a guest with no criteria is denied by default, so no hint.
  const criteriaAllow = !blocked && (Boolean(allowed) || !available.length);
  if (!more && !(guest && !available.length && !notAvailable.length) && criteriaAllow !== canView) {
    lines.push(`User criteria alone would ${criteriaAllow ? 'allow' : 'deny'} this, so something other than user criteria ${canView ? 'allows' : 'denies'} it.`);
  }
  return lines.join(' ');
}

export async function checkUserCriteria(sdk, input) {
  const options = parseCheckArgs(input);
  const user = await findUser(sdk, `${isSysId(options.user) ? 'sys_id' : 'user_name'}=${options.user}`, options.user);
  const items = await sdk.listStrict('sc_cat_item', new URLSearchParams({ sysparm_query: `${isSysId(options.item) ? 'sys_id' : 'name'}=${options.item}`,
    sysparm_fields: 'sys_id,name,active', sysparm_limit: '2', sysparm_display_value: 'false' }));
  if (!items.length) throw errNotFound('catalog item', options.item);
  if (items.length > 1) throw errUsage(`More than one catalog item is named "${options.item}"; give its sys_id.`);
  const [row] = items;
  if (!isSysId(row?.sys_id) || typeof row.name !== 'string') throw malformed();
  const item = { sys_id: row.sys_id, name: row.name, active: row.active === 'true' || row.active === true };

  const output = String(await sdk.executeScript(checkScript(user.sys_id, item.sys_id), 'global', { rollback: false, finished: /JSN_UC_CHECK:\{/ }));
  const line = output.match(/JSN_UC_CHECK:(\{[^\r\n]*\})/);
  if (!line) throw malformed();
  let out;
  try { out = JSON.parse(line[1]); } catch { throw malformed(); }
  const rowsOk = rows => Array.isArray(rows) && rows.every(r => r && isSysId(r.sys_id) && typeof r.name === 'string');
  if (typeof out.can_view !== 'boolean' || typeof out.guest !== 'boolean' || !LISTS.every(([name]) => rowsOk(out.lists?.[name]))
    || !Array.isArray(out.matched) || !out.matched.every(isSysId)) throw malformed();

  // The platform logs a criteria script that throws and counts that criteria as no match.
  // Any other error the platform logged (a broken business rule on a table read) still fails the check, as before.
  const stray = output.match(/^Script execution error: (?!Script Identifier: user_criteria\.[0-9a-f]{32})[^\n]*/m);
  if (stray) throw new Error(`Background script failed: ${stray[0]}`);
  const matched = new Set(out.matched), threw = new Set([...output.matchAll(/Script Identifier: user_criteria\.([0-9a-f]{32})/g)].map(m => m[1]));
  const [available, notAvailable] = LISTS.map(([name]) => out.lists[name].slice(0, LIMIT).map(r => ({ sys_id: r.sys_id, name: r.name, matched: matched.has(r.sys_id),
    ...(threw.has(r.sys_id) ? { script_error: true } : {}) })));
  const more = LISTS.some(([name]) => out.lists[name].length > LIMIT);
  return { user, item, can_view: out.can_view, available_for: available, not_available_for: notAvailable, more,
    verdict: verdict(user.user_name, item, out.can_view, available, notAvailable, out.guest, more) };
}

export function formatUserCriteriaCheck(data) {
  const list = (label, rows) => [`${label}: ${rows.length ? '' : 'none'}`.trimEnd(),
    ...rows.map(row => `  ${row.matched ? 'matches' : row.script_error ? 'script error' : 'no match'}: ${row.name} [${row.sys_id}]`)];
  return [`User criteria check for ${data.user.user_name} on ${data.item.name} [${data.item.sys_id}] (read-only background script)`,
    ...list('Available for', data.available_for), ...list('Not available for', data.not_available_for),
    ...(data.more ? [`  More than ${LIMIT} criteria in a list; only the first ${LIMIT} of each were evaluated.`] : []),
    data.verdict].join('\n');
}
