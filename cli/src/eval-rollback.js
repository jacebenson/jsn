// Roll back a background script execution from the rollback context it recorded.
// The Rollback Script Execution UI action starts AJAXRollbackWorker, a client-callable
// processor with no REST API in front of it, so this calls it through xmlhttp.do as
// scan.js calls its processor, then follows the execution tracker it returns.
import { SaxesParser } from 'saxes';
import { errAPI, errNotFound, errUsage } from './errors.js';
import { isSysId } from './resolve-record.js';
import { raw, requireId } from './scan.js';

const TRACKER = { '0': 'pending', '1': 'running', '2': 'successful', '3': 'failed', '4': 'cancelled',
  pending: 'pending', running: 'running', successful: 'successful', failed: 'failed', cancelled: 'cancelled' };
const TERMINAL = new Set(['successful', 'failed', 'cancelled']);
const display = value => value && typeof value === 'object' ? (value.display_value ?? '') : (value ?? '');

async function readRow(sdk, table, id, fields) {
  const [row] = await sdk.listStrict(table, new URLSearchParams({ sysparm_query: `sys_id=${id}`, sysparm_fields: fields, sysparm_display_value: 'all', sysparm_limit: '1' }));
  if (!row) throw errNotFound(table, id);
  if (raw(row.sys_id) !== id) throw errUsage(`The ${table} row returned is not ${id}. Nothing was rolled back.`);
  return row;
}

const readContext = (sdk, id) => readRow(sdk, 'sys_rollback_context', id, 'sys_id,number,state,type');

function decodeAnswer(xml) {
  let answer;
  const parser = new SaxesParser();
  parser.on('doctype', () => { throw new Error('doctype'); });
  parser.on('opentag', node => { if (node.name === 'xml') answer = node.attributes.answer; });
  try { parser.write(String(xml)).close(); } catch { return undefined; }
  return answer;
}

export async function previewRollback(sdk, id) {
  requireId(id);
  const run = await readRow(sdk, 'sys_script_execution_history', id, 'sys_id,script,executed_by,started,rollback_context');
  const contextId = raw(run.rollback_context);
  if (!contextId) throw errUsage(`Execution ${id} has no rollback context: the script wrote nothing, ran with --no-rollback, or its context expired (the platform keeps them for 10 days). Nothing was rolled back.`);
  requireId(contextId, 'the rollback context');
  const context = await readContext(sdk, contextId);
  const number = display(context.number);
  if (raw(context.type) !== 'scripts_bg') throw errUsage(`Rollback context ${number} is not a background script's (type ${raw(context.type) || 'unknown'}). Nothing was rolled back.`);
  if (raw(context.state) !== 'recorded') throw errUsage(`Rollback context ${number} is ${display(context.state) || 'in an unknown state'}, not Finished recording, so it cannot be rolled back.`);
  const { groups = [] } = await sdk.aggregate('sys_rollback_sequence', { query: `context=${contextId}`, groupBy: ['target_class_name', 'operation'] }) || {};
  const operations = groups.map(group => {
    const field = name => group?.groupby_fields?.find(entry => entry.field === name)?.value ?? '';
    return { table: field('target_class_name'), operation: field('operation'), count: Number(group?.stats?.count) };
  });
  if (operations.some(op => !op.table || !op.operation || !Number.isSafeInteger(op.count) || op.count < 1)) throw errAPI(200, `Unreadable operation counts for rollback context ${number}. Nothing was rolled back.`);
  if (!operations.length) throw errUsage(`Rollback context ${number} recorded no operations. Nothing was rolled back.`);
  return { execution: id, started: display(run.started), executed_by: display(run.executed_by), script: raw(run.script),
    rollback_context: { sys_id: contextId, number, state: raw(context.state) }, operations,
    total: operations.reduce((sum, op) => sum + op.count, 0) };
}

export async function runRollback(sdk, plan, { timeoutMs = 120000, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const { sys_id: contextId, number } = plan.rollback_context;
  requireId(contextId, 'the rollback context');
  // The Rollback Script Execution action shows only to admins; the processor itself checks nothing.
  const admin = await sdk.listStrict('sys_user_has_role', new URLSearchParams({ sysparm_query: 'user=javascript:gs.getUserID()^role.name=admin', sysparm_fields: 'sys_id', sysparm_limit: '1' }));
  if (!admin.length) throw errUsage('Rolling back needs the admin role, as the Rollback Script Execution action does. Nothing was rolled back.');
  const check = `jsn records get --table sys_rollback_context --sys-id ${contextId}`;
  const progressId = decodeAnswer(await sdk.rawRequest(`${sdk.baseURL}/xmlhttp.do?${new URLSearchParams({ sysparm_processor: 'AJAXRollbackWorker', sysparm_name: 'start', sysparm_ajax_processor_context_id: contextId })}`, { method: 'POST' }));
  if (!isSysId(progressId)) throw new Error(`Starting the rollback of ${number} returned no progress id, so its outcome is unknown. Check ${check} before retrying.`);
  let status = 'pending', message;
  for (const deadline = Date.now() + timeoutMs; ; await pause(2000)) {
    let tracker = null;
    try { tracker = await sdk.get('sys_execution_tracker', progressId); }
    catch (error) { if (error.code !== 'not_found' && error.status !== 404) throw error; }
    // The processor can answer before its tracker is readable.
    if (tracker) {
      status = raw(tracker.sys_id) === progressId && TRACKER[raw(tracker.state)] || 'unknown';
      message = raw(tracker.message) || '';
      if (status === 'unknown') throw new Error(`The rollback of ${number} has an unreadable execution tracker (progress ${progressId}). Check ${check} and do not rerun it.`);
      if (TERMINAL.has(status)) break;
    }
    if (Date.now() > deadline) throw new Error(`The rollback of ${number} is still ${status} after ${timeoutMs / 1000}s (progress ${progressId}). It carries on in the background: check ${check} and do not rerun it.`);
  }
  const after = await readContext(sdk, contextId);
  if (status !== 'successful' || raw(after.state) !== 'rolled_back') throw new Error(`The rollback of ${number} ended ${status}${message ? ` (${message})` : ''} and the context reads ${display(after.state) || 'nothing'}, not Rolled back. Check ${check}.`);
  return { ...plan, rollback_context: { ...plan.rollback_context, state: 'rolled_back' }, progress_id: progressId, rolled_back: true };
}
