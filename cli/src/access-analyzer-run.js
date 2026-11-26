// jsn access-analyzer run: run one live Access Analyzer evaluation and print
// every ACL and business rule the provider checked, with the overall verdict
// per operation. Distinct from `check`: no impersonated read, no before-query
// rule sweep, and no saved evidence unless --save.
import { AppError, CodeAPI, errNotFound, errNotFoundHint, errUsage } from './errors.js';
import { isSysId } from './resolve-record.js';
import { parseCheckOptions, resolveAnalyzedUser } from './access-check.js';
import { formatCheckDetail, formatCheckLine, rawAccessValue, recentAnalysisRequests } from './access-analyzer.js';

const MARK = 'JSN_ACCESS_RUN:';
const CHECK_LIMIT = 100;
const malformed = () => new AppError(CodeAPI, 'The access evaluation returned no readable result.');

export function parseRunOptions({ user, table, record, operations, field, save } = {}) {
  const options = parseCheckOptions({ user, table, record, operations });
  const name = field === undefined || field === null ? '' : String(field).trim();
  if (name && !/^[a-z0-9_]{1,80}$/.test(name)) throw errUsage('--field must be a field name on --table, such as state.');
  return { ...options, field: name, save: save === true };
}

// The request shape follows the installed Access Analyzer executor
// (sn_access_analyzer.AccessAnalyzeExecutor), which passes entitySysId,
// entityType, targetName, targetResource, targetField, targetMethod,
// targetRecord and targetOperations to the provider. Instances of the older
// release expose CrossScopeGetDebugLogsAPI().getDebugLogs with the same keys
// plus shouldPersistResult; the newer release exposes
// CrossScopeEvaluateAccessAPI().evaluateAccess. The script picks whichever the
// instance publishes and reports the provider's own refusal when neither works
// — it never substitutes a weaker local check.
function evaluationScript(userSysId, { table, record, field, operations, save }) {
  return `(function () {
  var out = {}, gr = new GlideRecord('${table}');
  if (!gr.isValid()) { out.missing = 'table'; }
  else if (!gr.get('${record}')) { out.missing = 'record'; }
  else {
    var api = null;
    if (typeof sn_access_analyzer != 'undefined' && sn_access_analyzer.CrossScopeGetDebugLogsAPI) { api = new sn_access_analyzer.CrossScopeGetDebugLogsAPI(); out.api = 'getDebugLogs'; }
    else if (typeof sn_access_analyzer != 'undefined' && sn_access_analyzer.CrossScopeEvaluateAccessAPI) { api = new sn_access_analyzer.CrossScopeEvaluateAccessAPI(); out.api = 'evaluateAccess'; }
    if (!api) { out.missing = 'analyzer'; }
    else {
      var request = { entitySysId: '${userSysId}', entityType: 'User', targetResource: 'record', targetName: '${table}',
        targetField: ${JSON.stringify(field)}, targetMethod: '', targetRecord: '${record}',
        targetOperations: ${JSON.stringify(operations)}, shouldPersistResult: ${save ? 'true' : 'false'} };
      var raw;
      try { raw = out.api === 'getDebugLogs' ? api.getDebugLogs(request) : api.evaluateAccess(request); }
      catch (error) { out.thrown = String(error); }
      if (raw !== undefined && raw !== null) {
        var response;
        if (typeof raw === 'object' && (raw.securityDebug !== undefined || raw.error !== undefined)) { response = raw; }
        else { try { response = JSON.parse(String(raw)); } catch (parseError) { out.unreadable = String(raw).slice(0, 500); } }
        if (response) { out.response = reduceResponse(response); }
      }
    }
  }
  function clean(value) { return value === null || value === undefined ? '' : String(value).replace(/<[^>]*>/g, '').replace(/[\\r\\n\\t]+/g, ' '); }
  function reduceOperation(operation) {
    operation = operation || {};
    var checks = [], logs = operation.debugLogs || [], total = 0, i, j;
    for (i = 0; i < logs.length; i++) {
      var log = logs[i] || {}, acls = log.acls || [];
      total += log.logType === 'SecurityRulesInfo' ? acls.length : 1;
      if (log.logType === 'SecurityRulesInfo') {
        for (j = 0; j < acls.length && checks.length < ${CHECK_LIMIT}; j++) {
          var acl = acls[j] || {};
          checks.push({ kind: 'ACL', sys_id: clean(acl.sysId || acl.recordRef), path: clean(acl.path), decision_type: clean(acl.aclDecisionType),
            status: clean(acl.status), return_code: clean(log.returnCode), return_code_display_value: clean(log.returnCodeDisplayValue),
            roles: clean(Array.isArray(acl.roles) ? acl.roles.join(', ') : acl.roles), roles_result: clean(acl.rolesResult), condition_result: clean(acl.conditionResult),
            script_result: clean(acl.scriptResult), security_attribute: clean(acl.securityAttributeResult), applies_to: clean(acl.appliesTo),
            applies_to_condition_result: clean(acl.appliesToConditionResult), controlled_by_references_result: clean(acl.controlledByReferencesResult),
            has_script: acl.hasScript === true, app: clean(acl.app), customized: acl.isCustomized === true });
        }
      } else if (checks.length < ${CHECK_LIMIT}) {
        checks.push({ kind: log.logType === 'BusinessRuleInfo' ? 'Business Rule' : (clean(log.logType) || 'Check'),
          sys_id: clean(log.sysId || log.recordRef), path: clean(log.path), status: clean(log.status), table: clean(log.logTableName),
          return_code: clean(log.returnCode), return_code_display_value: clean(log.returnCodeDisplayValue), applies_to: clean(log.appliesTo) });
      }
    }
    return { status: operation.status === true || operation.status === false ? operation.status : clean(operation.status),
      acl_result: clean(operation.aclResult), access_handler_result: clean(operation.accessHandlerResult),
      data_filtration_result: clean(operation.datafiltrationResult), overall_access: clean(operation.overallAccess),
      insights: clean(operation.insights), checks: checks, checks_total: total, checks_truncated: total > checks.length };
  }
  function reduceResponse(response) {
    var reduced = { error: response.error, errorMessage: clean(response.errorMessage), pass: response.pass, detail: {}, securityDebug: {} };
    var detail = response.detail || {};
    for (var key in detail) { if (Object.prototype.hasOwnProperty.call(detail, key)) reduced.detail[key] = clean(detail[key]); }
    var securityDebug = response.securityDebug || {};
    for (var op in securityDebug) { if (Object.prototype.hasOwnProperty.call(securityDebug, op)) reduced.securityDebug[op] = reduceOperation(securityDebug[op]); }
    return reduced;
  }
  gs.print('${MARK}' + JSON.stringify(out));
})();`;
}

function decision(status, aclResult) {
  if (status === true) return 'allowed';
  if (status === false) return 'blocked';
  const value = String(status ?? '').toLowerCase();
  if (['true', 'passed', 'allowed'].includes(value)) return 'allowed';
  if (['false', 'blocked', 'denied'].includes(value)) return 'blocked';
  if (['skipped', 'not_evaluated', 'not evaluated'].includes(value)) return 'skipped';
  if (value === 'undefined') return 'undefined';
  // No overall status: the ACL verdict alone may still say blocked. It never
  // says allowed unless the provider positively passed it.
  if (!value) {
    if (aclResult === 'blocked') return 'blocked';
    if (aclResult === 'passed') return 'allowed';
    return aclResult === 'skipped' ? 'skipped' : 'undefined';
  }
  throw malformed();
}

const FAILURE_CHECKS = {
  roles: 'roles_result', condition: 'condition_result', script: 'script_result',
  security_attribute: 'security_attribute', reference: 'controlled_by_references_result',
};
function aclOutcome(check) {
  if (String(check.applies_to_condition_result).toLowerCase() === 'false') return { result: 'not_applicable', failed_checks: [] };
  const failed = Object.keys(FAILURE_CHECKS).filter(name => ['false', 'blocked'].includes(String(check[FAILURE_CHECKS[name]] || '').toLowerCase()));
  if (failed.length) return { result: 'failed', failed_checks: failed };
  const values = Object.values(FAILURE_CHECKS).map(key => String(check[key] || '').toLowerCase());
  return { result: values.includes('true') ? 'passed' : 'not_evaluated', failed_checks: [] };
}

function operationResult(operation, name) {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation) || !Array.isArray(operation.checks)) throw malformed();
  const aclResult = String(operation.acl_result || '').toLowerCase();
  if (aclResult && !['passed', 'blocked', 'skipped', 'undefined'].includes(aclResult)) throw malformed();
  const checks = operation.checks.map(check => {
    if (!check || typeof check !== 'object' || !check.kind) throw malformed();
    if (check.kind === 'ACL' && !isSysId(check.sys_id)) throw malformed();
    return { ...check, ...(check.kind === 'ACL' ? aclOutcome(check) : { result: 'observed', failed_checks: [] }) };
  });
  const state = decision(operation.status, aclResult);
  return {
    operation: name,
    decision: state, allowed: state === 'allowed',
    acl_result: aclResult || 'undefined',
    access_handler_result: operation.access_handler_result || '',
    data_filtration_result: operation.data_filtration_result || '',
    overall_access: operation.overall_access || '',
    insights: operation.insights || '',
    checks, checks_total: Number(operation.checks_total) || checks.length,
    checks_truncated: operation.checks_truncated === true,
  };
}

function marker(output) {
  const match = String(output).match(/JSN_ACCESS_RUN:(\{[^\r\n]*\})/);
  if (!match) throw malformed();
  try { return JSON.parse(match[1]); } catch { throw malformed(); }
}

export async function runAccessAnalysis(sdk, input) {
  const options = parseRunOptions(input);
  const user = await resolveAnalyzedUser(sdk, options, 'run');
  const filter = { user: rawAccessValue(user.sys_id), table: options.table, record: options.record };
  // Capture existing request ids before the evaluation so a save is proven by a
  // row that appeared during this run, not by an older analysis that matches.
  const before = options.save ? await recentAnalysisRequests(sdk, filter) : [];
  const output = await sdk.executeScript(evaluationScript(user.sys_id, options), 'global', { rollback: false });
  const out = marker(output);

  if (out.missing === 'table') throw errNotFound('table', options.table);
  if (out.missing === 'record') throw errNotFound(`${options.table} record`, options.record);
  if (out.missing === 'analyzer') {
    throw errNotFoundHint('Access Analyzer API', 'sn_access_analyzer.CrossScopeGetDebugLogsAPI or sn_access_analyzer.CrossScopeEvaluateAccessAPI', 'This instance has no public live-evaluation API from the Access Analyzer application. Install or upgrade the Access Analyzer application (sn_access_analyzer) and retry; jsn does not substitute a weaker local check.');
  }
  if (out.thrown) throw new AppError(CodeAPI, `Access Analyzer threw while evaluating access: ${out.thrown}.`);
  if (out.unreadable !== undefined) throw new AppError(CodeAPI, `Access Analyzer returned an unreadable response: ${out.unreadable}.`);
  if (!out.response || typeof out.response !== 'object') throw malformed();

  const response = out.response;
  const error = response.error;
  if (![0, '0', false, null, undefined].includes(error)) {
    throw new AppError(CodeAPI, `Access Analyzer could not evaluate access: ${response.errorMessage || 'no reason given'}.`);
  }
  const securityDebug = response.securityDebug;
  if (!securityDebug || typeof securityDebug !== 'object' || Array.isArray(securityDebug)) throw malformed();
  const operations = options.operations.map(name => {
    const operation = securityDebug[name] ?? securityDebug[name.toUpperCase()];
    if (operation === undefined) {
      const returned = Object.keys(securityDebug);
      throw new AppError(CodeAPI, `Access Analyzer returned no result for ${name}${returned.length ? ` (returned: ${returned.join(', ')})` : ''}. The operation may not be supported for this target.`);
    }
    return operationResult(operation, name);
  });

  const data = {
    user, table: options.table, record: options.record, field: options.field || '',
    api: out.api || '', operations, saved: false,
    notes: [options.save
      ? 'The provider saved this analysis; read it back later with jsn access-analyzer show <request-id>. An evaluation is evidence, not a guarantee: it ran as the target identity with the platform\'s current rules.'
      : 'Live evaluation; nothing was saved. An evaluation is evidence, not a guarantee: it ran as the target identity with the platform\'s current rules.'],
  };
  if (options.save) {
    const after = await recentAnalysisRequests(sdk, filter);
    const known = new Set(before.map(row => rawAccessValue(row.sys_id)));
    const created = after.filter(row => !known.has(rawAccessValue(row.sys_id)));
    if (!created.length) {
      // Not "saved nothing": the row may be keyed by user name or hidden by an ACL,
      // so the honest outcome is unverified, and a blind retry could save twice.
      throw new AppError(CodeAPI, `Access Analyzer evaluated access, but no new analysis request is visible for user ${filter.user}. Either this build does not persist through its public evaluation API, or the request row is keyed differently or hidden from this identity. Do not assume nothing was saved: check jsn access-analyzer list before retrying.`);
    }
    if (created.length > 1) {
      throw new AppError(CodeAPI, `${created.length} new analysis requests appeared during this run; refuse to guess which is this one. Inspect them with: jsn access-analyzer list --limit 5`);
    }
    data.saved = true;
    data.analysis_request = created[0];
    data.summary = `${operations.map(op => `${op.operation} ${op.decision}`).join(', ')}; saved ${rawAccessValue(created[0].sys_id)}`;
  } else {
    data.summary = operations.map(op => `${op.operation} ${op.decision}`).join(', ');
  }
  return data;
}

function verdictLine(operation) {
  const name = operation.operation;
  if (operation.decision === 'allowed') return `${name}: allowed`;
  if (operation.decision === 'blocked') return operation.acl_result === 'blocked' ? `${name}: blocked by ACL` : `${name}: denied by the analyzer, though no ACL is reported blocked`;
  if (operation.decision === 'skipped') return `${name}: skipped by the analyzer, so access is undecided`;
  return `${name}: undefined, no rule found for this operation`;
}

export function formatAccessRun(data) {
  const target = data.field ? `${data.table}.${data.field}` : data.table;
  const lines = [`Live access evaluation for ${data.user.user_name} on ${target} ${data.record} (${data.saved ? `saved ${rawAccessValue(data.analysis_request.sys_id)}` : 'nothing saved'})`];
  for (const operation of data.operations) {
    lines.push(verdictLine(operation));
    if (operation.acl_result && operation.acl_result !== 'undefined') lines.push(`  ACL: ${operation.acl_result}; access handler: ${operation.access_handler_result || '(not reported)'}; data filtration: ${operation.data_filtration_result || '(not reported)'}`);
    if (operation.insights) lines.push(`  Insight: ${operation.insights}`);
    let index = 0;
    for (const check of operation.checks) {
      index += 1;
      const row = {
        log_sequence: index, type: check.kind, path: check.path || check.table || '', status: check.status,
        sys_id: check.sys_id, return_code: check.return_code, return_code_display_value: check.return_code_display_value,
        roles: check.roles, roles_result: check.roles_result, condition_result: check.condition_result,
        script_result: check.script_result, security_attribute: check.security_attribute, decision_type: check.decision_type,
      };
      const failed = check.result === 'failed' ? `; failed on ${check.failed_checks.join(', ')}` : '';
      lines.push(formatCheckLine(row) + failed);
      if (check.kind === 'ACL' || ['roles', 'condition_result', 'script_result', 'security_attribute', 'decision_type'].some(key => check[key])) {
        lines.push(formatCheckDetail(row));
      }
    }
    if (operation.checks_truncated) lines.push(`  ${operation.checks_total} checks ran; the first ${operation.checks.length} are listed. Saved evidence reads them all.`);
  }
  lines.push(...data.notes);
  return lines.join('\n');
}
