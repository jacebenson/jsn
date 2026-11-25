// jsn access-analyzer check: can this user read, write or delete this record, and what stops
// them? Three sources: the Access Analyzer's live ACL evaluation (a background script that saves
// nothing), the active before-query business rules on the table and its parents (the b4rules
// filter), and a read of the record as that user. Nothing missing or malformed reads as allowed.
import { AppError, CodeAPI, errNotFound, errNotFoundHint, errUsage } from './errors.js';
import { findUser } from './impersonation.js';
import { isSysId } from './resolve-record.js';

const OPERATIONS = ['read', 'write', 'delete'];
const MARK = 'JSN_ACCESS_CHECK:';
const RULE_LIMIT = 50;
const malformed = () => new AppError(CodeAPI, 'The access evaluation returned no readable result.');

export function parseCheckOptions({ user, table, record, operations = 'read,write,delete' }) {
  const name = typeof user === 'string' ? user.trim() : '';
  if (!name || /^-|[\^\p{Cc}]/u.test(name)) throw errUsage('--user must be a user_name or sys_id.');
  if (typeof table !== 'string' || !/^[a-z0-9_]{1,80}$/.test(table)) throw errUsage('--table must be a table name, such as incident.');
  if (!isSysId(record)) throw errUsage('--record must be the record\'s 32-character sys_id.');
  const ops = [...new Set(String(operations).split(',').map(op => op.trim().toLowerCase()))];
  if (ops.some(op => !OPERATIONS.includes(op))) throw errUsage('--operations takes read, write and delete, separated by commas.');
  return { user: name, table, record: record.toLowerCase(), operations: ops };
}

// Inputs are validated above (table [a-z0-9_], record and user hex), so they are safe inside quotes.
// The analyzer's answer embeds HTML, which script output strips, so only the fields used are printed.
function evaluationScript(userSysId, { table, record, operations }) {
  return `(function () {
  var out = {}, gr = new GlideRecord('${table}');
  if (!gr.isValid()) out.missing = 'table';
  else if (!gr.get('${record}')) out.missing = 'record';
  else if (typeof sn_access_analyzer == 'undefined' || !sn_access_analyzer.CrossScopeGetDebugLogsAPI) out.missing = 'analyzer';
  else {
    out.tables = String(new GlideTableHierarchy('${table}').getTables()).split(',');
    var r = JSON.parse(new sn_access_analyzer.CrossScopeGetDebugLogsAPI().getDebugLogs({ entitySysId: '${userSysId}', entityType: 'User',
      targetResource: 'record', targetName: '${table}', targetRecord: '${record}', targetOperations: ${JSON.stringify(operations)}, shouldPersistResult: false }));
    out.error = r.error; out.errorMessage = r.errorMessage; out.ops = {};
    for (var op in r.securityDebug) {
      var d = r.securityDebug[op], rules = [], acls = [];
      (d.debugLogs || []).forEach(function (l) {
        if (l.logType == 'BusinessRuleInfo') rules.push(String(l.sysId));
        if (l.logType == 'SecurityRulesInfo') (l.acls || []).forEach(function (a) {
          acls.push({ sys_id: a.sysId, path: a.path, decision_type: a.aclDecisionType, roles: a.roles, checks: { applies_to: a.appliesToConditionResult,
            roles: a.rolesResult, condition: a.conditionResult, script: a.scriptResult, security_attribute: a.securityAttributeResult,
            reference: a.controlledByReference && a.controlledByReference.evalResult } });
        });
      });
      out.ops[op] = { status: d.status, rules: rules, acls: acls };
    }
  }
  gs.print('${MARK}' + JSON.stringify(out));
})();`;
}

function aclResult(checks) {
  const failed = Object.keys(checks).filter(key => checks[key] === 'FALSE');
  if (failed.length) return { result: 'failed', failed_checks: failed };
  return { result: Object.values(checks).includes('TRUE') ? 'passed' : 'not_evaluated', failed_checks: [] };
}

function verdict(name, operations, visible, rules) {
  const read = operations.find(op => op.operation === 'read');
  if (!read) return visible ? `A read as ${name} returns this record.` : `A read as ${name} does not return this record.`;
  if (read.allowed && visible) return `${name} can read this record.`;
  if (!read.allowed && !visible) return `ACLs block ${name} from reading this record.`;
  if (!read.allowed) return `The ACL evaluation blocks ${name} from reading this record, yet a read as ${name} returned it.`;
  return rules.length
    ? `ACLs allow ${name} to read this record, but a read as ${name} does not return it; a before-query rule listed is the likely cause.`
    : `ACLs allow ${name} to read this record, but a read as ${name} does not return it, and no active before-query rule is on these tables.`;
}

// asUser(userSysId, read) runs read(sdk) as that user and returns its result.
export async function checkAccess(sdk, input, { asUser }) {
  const options = parseCheckOptions(input);
  const { table, record } = options;
  const user = await findUser(sdk, `${isSysId(options.user) ? 'sys_id' : 'user_name'}=${options.user}`, options.user);

  const output = await sdk.executeScript(evaluationScript(user.sys_id, options), 'global');
  const line = String(output).match(/JSN_ACCESS_CHECK:(\{[^\r\n]*\})/);
  if (!line) throw malformed();
  let out;
  try { out = JSON.parse(line[1]); } catch { throw malformed(); }
  if (out.missing === 'table') throw errNotFound('table', table);
  if (out.missing === 'record') throw errNotFound(`${table} record`, record);
  if (out.missing === 'analyzer') throw errNotFoundHint('Access Analyzer API', 'sn_access_analyzer.CrossScopeGetDebugLogsAPI', 'Install the Access Analyzer application (sn_access_analyzer) on the instance.');
  if (out.error !== 0) throw new AppError(CodeAPI, `Access Analyzer could not evaluate access: ${out.errorMessage || 'no reason given'}.`);
  if (!Array.isArray(out.tables) || !out.tables.length || out.tables.some(name => !/^[a-z0-9_]{1,80}$/.test(name))) throw malformed();
  const operations = options.operations.map(op => {
    const d = out.ops?.[op];
    if (!d || typeof d.status !== 'boolean' || !Array.isArray(d.acls) || !Array.isArray(d.rules)) throw malformed();
    if (d.acls.some(acl => !acl || !isSysId(acl.sys_id) || !acl.checks || typeof acl.checks !== 'object')) throw malformed();
    return { operation: op, allowed: d.status, acls: d.acls.map(acl => ({ ...acl, ...aclResult(acl.checks) })) };
  });

  // A query rule on global runs for every table.
  const ruleRows = await sdk.listStrict('sys_script', new URLSearchParams({
    sysparm_query: `when=before^action_query=true^active=true^collectionIN${[...out.tables, 'global'].join(',')}^ORDERBYorder^ORDERBYname`,
    sysparm_fields: 'sys_id,name,collection,order,condition', sysparm_limit: String(RULE_LIMIT + 1), sysparm_display_value: 'false',
  }));
  if (ruleRows.some(row => !row || !isSysId(row.sys_id))) throw malformed();
  const ran = new Set(options.operations.flatMap(op => out.ops[op].rules));
  const rules = ruleRows.slice(0, RULE_LIMIT).map(row => ({ ...row, ran_in_evaluation: ran.has(row.sys_id) }));

  const rows = await asUser(user.sys_id, as => as.listStrict(table, new URLSearchParams({ sysparm_query: `sys_id=${record}`, sysparm_fields: 'sys_id', sysparm_limit: '1', sysparm_display_value: 'false' }))
    // A refused read is the answer: the record is not visible to them.
    .catch(error => { if (error?.status === 403) return []; throw error; }));
  if (!Array.isArray(rows) || (rows.length && rows[0]?.sys_id !== record)) throw malformed();
  const visible = rows.length === 1;

  return {
    user, table, record, tables: out.tables, operations,
    before_query_rules: rules, before_query_rules_more: ruleRows.length > RULE_LIMIT,
    visible_as_user: visible,
    verdict: verdict(user.user_name, operations, visible, rules),
  };
}

export function formatAccessCheck(data) {
  const lines = [`Live access check for ${data.user.user_name} on ${data.table} ${data.record} (nothing saved)`];
  for (const op of data.operations) {
    lines.push(`${op.operation}: ${op.allowed ? 'allowed' : 'blocked'} by ACL`);
    for (const acl of op.acls) {
      const roles = Array.isArray(acl.roles) && acl.roles.length ? `, roles ${acl.roles.join(', ')}` : '';
      const result = acl.result === 'failed' ? `failed on ${acl.failed_checks.join(', ')}` : acl.result.replace('_', ' ');
      lines.push(`  ${acl.decision_type} ${acl.path}${roles}: ${result} [${acl.sys_id}]`);
    }
  }
  lines.push(`Active before-query rules on ${[...data.tables, 'global'].join(', ')}: ${data.before_query_rules.length ? '' : 'none'}`.trimEnd());
  for (const rule of data.before_query_rules) lines.push(`  ${rule.name} (${rule.collection}, order ${rule.order})${rule.ran_in_evaluation ? ', ran during the evaluation' : ''} [${rule.sys_id}]`);
  if (data.before_query_rules_more) lines.push(`  More than ${RULE_LIMIT}; see jsn b4rules list.`);
  lines.push(`Read as ${data.user.user_name}: the record was ${data.visible_as_user ? '' : 'not '}returned`);
  lines.push(data.verdict);
  return lines.join('\n');
}
