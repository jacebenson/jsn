// jsn access-analyzer check: can this user read, write or delete this record, and what stops
// them? Three sources: the Access Analyzer's live ACL evaluation (a background script that saves
// nothing), the active before-query business rules on the table and its parents (the b4rules
// filter), and a read of the record as that user. Nothing missing or malformed reads as allowed.
import { AppError, CodeAPI, errNotFound, errNotFoundHint, errUsage, errUsageHint } from './errors.js';
import { findUser } from './impersonation.js';
import { isSysId } from './resolve-record.js';

const OPERATIONS = ['read', 'write', 'delete'];
const ACL_RESULTS = ['passed', 'blocked', 'skipped', 'undefined'];
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
    var h = new TableUtils('${table}').getTables(); out.tables = [];
    for (var i = 0; i < h.size(); i++) out.tables.push(String(h.get(i)));
    var r = JSON.parse(new sn_access_analyzer.CrossScopeGetDebugLogsAPI().getDebugLogs({ entitySysId: '${userSysId}', entityType: 'User',
      targetResource: 'record', targetName: '${table}', targetRecord: '${record}', targetOperations: ${JSON.stringify(operations)}, shouldPersistResult: false }));
    out.error = r.error; out.errorMessage = r.errorMessage; out.ops = {};
    for (var op in r.securityDebug) {
      var d = r.securityDebug[op], results = [], rules = [], acls = [];
      (d.debugLogs || []).forEach(function (l) {
        if (l.logType == 'BusinessRuleInfo') rules.push(String(l.sysId));
        if (l.logType == 'SecurityRulesInfo') results.push(String(l.returnCodeDisplayValue));
        if (l.logType == 'SecurityRulesInfo') (l.acls || []).forEach(function (a) {
          acls.push({ sys_id: a.sysId, path: a.path, decision_type: a.aclDecisionType, roles: a.roles, checks: { applies_to: a.appliesToConditionResult,
            roles: a.rolesResult, condition: a.conditionResult, script: a.scriptResult, security_attribute: a.securityAttributeResult,
            reference: a.controlledByReference && a.controlledByReference.evalResult } });
        });
      });
      out.ops[op] = { status: d.status, results: results, rules: rules, acls: acls };
    }
  }
  gs.print('${MARK}' + JSON.stringify(out));
})();`;
}

function aclResult(checks) {
  if (checks.applies_to === 'FALSE') return { result: 'not_applicable', failed_checks: [] };
  const failed = Object.keys(checks).filter(key => checks[key] === 'FALSE');
  if (failed.length) return { result: 'failed', failed_checks: failed };
  return { result: Object.values(checks).includes('TRUE') ? 'passed' : 'not_evaluated', failed_checks: [] };
}

// The analyzer's overall status also counts query rules, so ACL claims rest on its ACL result alone.
function verdict(name, operations, read, rules) {
  const acl = operations.find(op => op.operation === 'read');
  if (!acl) return { returned: `A read as ${name} returns this record.`, not_returned: `A read as ${name} does not return this record.`, refused: `The instance refused a read as ${name}.` }[read];
  if (acl.acl_result === 'blocked') return read === 'returned' ? `ACLs block ${name} from reading this record, yet a read as ${name} returned it.` : `ACLs block ${name} from reading this record.`;
  if (read === 'returned') return `${name} can read this record.`;
  if (acl.acl_result !== 'passed') {
    return read === 'refused'
      ? `The analyzer did not decide the ACLs (${acl.acl_result}), and the instance refused a read as ${name}.`
      : `The analyzer did not decide the ACLs (${acl.acl_result}), and a read as ${name} does not return this record; check the before-query rules listed.`;
  }
  // A query rule filters rows and never refuses, so a refusal points elsewhere.
  if (read === 'refused') return `ACLs allow ${name} to read this record, but the instance refused a read as ${name}.`;
  return rules.length
    ? `ACLs allow ${name} to read this record, but a read as ${name} does not return it; a before-query rule listed is the likely cause.`
    : `ACLs allow ${name} to read this record, but a read as ${name} does not return it, and no active before-query rule is on these tables.`;
}

// Resolve the identity to analyze. Both live commands run a server-side evaluation
// as --user, which a browser-session profile cannot do without a UI session of its own.
export async function resolveAnalyzedUser(sdk, options, verb) {
  if ((await sdk.authProvider?.getCredentials())?.auth_method === 'gck') throw errUsageHint(`access-analyzer ${verb} cannot use a browser-session profile: it evaluates access as --user on a UI session of its own.`, `Use a basic or OAuth profile: jsn --profile <name> access-analyzer ${verb} ...`);
  return findUser(sdk, `${isSysId(options.user) ? 'sys_id' : 'user_name'}=${options.user}`, options.user);
}

// asUser(userSysId, read) runs read(sdk) as that user and returns its result.
export async function checkAccess(sdk, input, { asUser }) {
  const options = parseCheckOptions(input);
  const { table, record } = options;
  const user = await resolveAnalyzedUser(sdk, options, 'check');

  const output = await sdk.executeScript(evaluationScript(user.sys_id, options), 'global', { rollback: false });
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
    const results = Array.isArray(d.results) ? d.results.map(result => String(result).toLowerCase()) : [];
    if (!results.length || results.some(result => !ACL_RESULTS.includes(result))) throw malformed();
    if (d.acls.some(acl => !acl || !isSysId(acl.sys_id) || !acl.checks || typeof acl.checks !== 'object')) throw malformed();
    // Any block decides; passed needs every entry passed; otherwise the analyzer left the ACLs undecided.
    const aclState = results.includes('blocked') ? 'blocked' : results.find(result => result !== 'passed') || 'passed';
    return { operation: op, allowed: d.status, acl_result: aclState, acls: d.acls.map(acl => ({ ...acl, ...aclResult(acl.checks) })) };
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
    .catch(error => { if (error?.status === 403) return null; throw error; }));
  if (rows !== null && (!Array.isArray(rows) || (rows.length && rows[0]?.sys_id !== record))) throw malformed();
  const read = rows === null ? 'refused' : rows.length ? 'returned' : 'not_returned';

  return {
    user, table, record, tables: out.tables, operations,
    before_query_rules: rules, before_query_rules_more: ruleRows.length > RULE_LIMIT,
    read_as_user: read,
    verdict: verdict(user.user_name, operations, read, rules),
  };
}

export function formatAccessCheck(data) {
  const lines = [`Live access check for ${data.user.user_name} on ${data.table} ${data.record} (no analysis saved)`];
  for (const op of data.operations) {
    const state = { blocked: 'blocked by ACL', passed: op.allowed ? 'allowed' : 'denied by the analyzer, though no ACL blocks it' }[op.acl_result]
      ?? `${op.allowed ? 'allowed' : 'denied'} by the analyzer, ACL check ${op.acl_result}`;
    lines.push(`${op.operation}: ${state}`);
    for (const acl of op.acls) {
      const roles = Array.isArray(acl.roles) && acl.roles.length ? `, roles ${acl.roles.join(', ')}` : '';
      const result = acl.result === 'failed' ? `failed on ${acl.failed_checks.join(', ')}` : acl.result.replace('_', ' ');
      lines.push(`  ${acl.decision_type} ${acl.path}${roles}: ${result} [${acl.sys_id}]`);
    }
  }
  lines.push(`Active before-query rules on ${[...data.tables, 'global'].join(', ')}: ${data.before_query_rules.length ? '' : 'none'}`.trimEnd());
  for (const rule of data.before_query_rules) lines.push(`  ${rule.name} (${rule.collection}, order ${rule.order})${rule.ran_in_evaluation ? ', ran during the evaluation' : ''} [${rule.sys_id}]`);
  if (data.before_query_rules_more) lines.push(`  More than ${RULE_LIMIT}; see jsn b4rules list.`);
  lines.push(`Read as ${data.user.user_name}: ${{ returned: 'the record was returned', not_returned: 'the record was not returned', refused: 'refused (HTTP 403)' }[data.read_as_user]}`);
  lines.push(data.verdict);
  return lines.join('\n');
}
