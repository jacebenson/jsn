// Approvals commands — top-level `jsn approvals`
//
// Surface (mirrors the atf command set):
//   list                    List approval requests (default: pending, state=requested)
//   approve <sys_id>        Approve a pending request (mutation, confirm required)
//   reject <sys_id>         Reject a pending request (mutation, confirm required)
//   submit <table> <sys-id> Request approval on a record (sets approval=requested)
//   history <record>        Show approval progression for a record (number or sys_id)
//
// Data model: sysapproval_approver rows. Each row is one approver's decision on
// one record. The record side lives on the task tables (approval field holds the
// rollup state: not requested/requested/approved/rejected/cancelled).
//
// state raw values (sys_choice, verified live on dev227772):
//   not requested / requested / approved / rejected / cancelled / not_required / not_entitled
// Encoded queries must use the RAW value (display shows "Requested").
//
// approve/reject are mutations → confirmDelete + registered in MUTATION_COMMANDS.

import {
  getStringField, interactiveList,
  resolveFieldsParam, assertSafeExactMatch, confirmDelete,
} from '../helpers.js';
import { errUsage, errNotFound } from '../errors.js';
import { declareCapabilities } from '../capabilities.js';

// approve/reject/submit change approval state on records.
declareCapabilities('approvals', { mutationSubcommands: ['approve', 'reject', 'submit'] });

// Raw sysapproval_approver.state values (verified live).
const APPROVAL_STATES = [
  'not requested', 'requested', 'approved', 'rejected',
  'cancelled', 'not_required', 'not_entitled',
];

const DEFAULT_COLUMNS = ['state', 'approver', 'document_id', 'comments', 'sys_updated_on'];

/**
 * Map a user-supplied state label to the raw stored value. Accepts display
 * labels ("Requested"), raw values ("requested"), or abbreviated forms
 * ("approved", "rej"). Returns '' for "any", throws for unknown.
 */
export function normalizeApprovalState(input) {
  if (!input) return '';
  const s = String(input).trim().toLowerCase();
  if (!s || s === 'any' || s === 'all') return '';
  if (s === 'pending') return 'requested';
  if (s === 'no longer required') return 'not_required';
  if (s === 'not requested' || s === 'not-entitled' || s === 'not_entitled') {
    return s.replace(/-/g, '_');
  }
  const exact = APPROVAL_STATES.find((v) => v === s);
  if (exact) return exact;
  // prefix match (e.g. "rej" → rejected, "not req" → not requested)
  const match = APPROVAL_STATES.find((v) => v.startsWith(s));
  if (match) return match;
  throw errUsage(`Unknown approval state "${input}". Valid: ${APPROVAL_STATES.join(', ')}, pending, any`);
}

/**
 * Build the encoded query for the approvals list.
 * @param {object} opts
 * @param {string} opts.state — raw state value ('' = any)
 * @param {string} opts.mineSysID — current user's sys_id for approver filter ('' = skip)
 * @param {string} opts.recordSysID — sys_id of the record being approved ('' = skip)
 * @param {string} opts.userQuery — additional encoded query ANDed on top
 */
export function buildApproverQuery({ state = '', mineSysID = '', recordSysID = '', userQuery = '' }) {
  const parts = [];
  if (state) parts.push(`state=${state}`);
  if (mineSysID) parts.push(`approver=${mineSysID}`);
  if (recordSysID) parts.push(`document_id=${recordSysID}`);
  if (userQuery) parts.push(userQuery);
  return parts.join('^');
}

/**
 * Resolve a record (number like CHG0000082, or 32-hex sys_id) via the task
 * superclass. Works for any task-derived table (change, incident, sc_req_item…).
 * @returns {Promise<object>} raw task record
 */
export async function resolveTaskRecord(app, identifier, label = 'record') {
  assertSafeExactMatch(identifier);
  const isSysID = /^[0-9a-fA-F]{32}$/.test(identifier);
  const params = new URLSearchParams();
  params.set('sysparm_query', isSysID ? `sys_id=${identifier}` : `number=${identifier}`);
  params.set('sysparm_limit', '1');
  params.set('sysparm_display_value', 'all');
  const records = await app.sdk.list('task', params);
  if (!records || records.length === 0) throw errNotFound(label, identifier);
  return records[0];
}

/**
 * Fetch the approval rows for a record (the "approval progression").
 */
export async function approvalRowsForRecord(app, recordSysID) {
  const params = new URLSearchParams();
  params.set('sysparm_query', `document_id=${recordSysID}`);
  params.set('sysparm_limit', '100');
  params.set('sysparm_display_value', 'all');
  params.set('sysparm_fields', 'state,approver,comments,order,sys_updated_on,reassignment_count');
  return app.sdk.list('sysapproval_approver', params);
}

/**
 * Approve/reject an approver row.
 * @returns {Promise<object>} updated row
 */
export async function setApprovalState(app, approverSysID, state, comments = '') {
  const data = { state };
  if (comments) data.comments = comments;
  const updated = await app.sdk.update('sysapproval_approver', approverSysID, data);
  if (!updated) throw errUsage('Approval update returned no record');
  return updated;
}

/**
 * Request approval on a record (sets its approval field to "requested").
 * @returns {Promise<object>} updated record
 */
export async function submitForApproval(app, table, sysID) {
  const updated = await app.sdk.update(table, sysID, { approval: 'requested' });
  if (!updated) throw errUsage('Submit-for-approval returned no record');
  return updated;
}

/** Current profile username ('' when no profile configured). */
export function currentUsername(app) {
  return app?.context?.username || '';
}

/**
 * Resolve the current session user's sys_id for `--mine` filtering.
 * Ladder: /api/now/ui/me (modern instances) → profile username → env username.
 * Throws with a clear hint when the user cannot be resolved — never silently
 * returns '' (which would drop the filter and list every approver).
 *
 * Reads the username fresh from the auth manager (config live-read) rather
 * than app.context, which is snapshotted at App construction and goes stale
 * when --profile switches the active profile mid-command.
 */
export async function resolveCurrentUserSysID(app) {
  // 1) ui/me — the platform "who am I" endpoint (missing on older instances)
  try {
    const resp = await app.sdk.request(`${app.sdk.baseURL}/api/now/ui/me`, { method: 'GET' });
    const me = resp?.result;
    const sysID = me?.userID || me?.sys_id || me?.value || '';
    if (sysID) return String(sysID);
  } catch { /* fall through */ }

  // 2) profile username (fresh read) → sys_user lookup
  const username = app.auth?._activeUsername?.() || currentUsername(app) || process.env.SN_USERNAME;
  if (username) {
    const params = new URLSearchParams();
    params.set('sysparm_query', `user_name=${username}`);
    params.set('sysparm_limit', '1');
    params.set('sysparm_fields', 'sys_id');
    const users = await app.sdk.list('sys_user', params);
    if (users && users.length > 0) {
      const id = getStringField(users[0], 'sys_id');
      if (id) return id;
    }
  }

  throw errUsage(
    'Cannot resolve the current user for --mine. ' +
    'Set a username on the profile (jsn auth login) or pass --query "approver=<sys_id>" explicitly.'
  );
}

export function approvalsCmd(wrap) {
  return {
    command: 'approvals [subcommand]',
    describe: 'Manage approval requests (list, approve, reject, submit, history)',
    builder: (yargs) => {
      return yargs
        .command({
          command: 'list',
          aliases: ['ls'],
          describe: 'List approval requests (default: pending, state=requested)',
          builder: (y) => y
            .option('state', { type: 'string', describe: `State filter (default pending). One of: ${APPROVAL_STATES.join(', ')}, pending, any` })
            .option('mine', { type: 'boolean', default: false, describe: 'Only approvals assigned to the current user' })
            .option('for', { type: 'string', describe: 'Only approvals for this record (number or sys_id)' })
            .option('query', { type: 'string', describe: 'Additional encoded query (ANDed)' })
            .option('columns', { alias: ['c', 'fields'], type: 'string', describe: 'Comma-separated columns' })
            .option('limit', { alias: 'l', type: 'number', default: 50, describe: 'Max records' }),
          handler: wrap(async (argv, app) => {
            app.requireInstance();
            const state = normalizeApprovalState(argv.state);
            let recordSysID = '';
            if (argv.for) {
              const rec = await resolveTaskRecord(app, argv.for, 'record');
              recordSysID = getStringField(rec, 'sys_id');
            }
            let mineSysID = '';
            if (argv.mine) mineSysID = await resolveCurrentUserSysID(app);
            const query = buildApproverQuery({
              state: state || (argv.state === undefined ? 'requested' : ''),
              mineSysID,
              recordSysID,
              userQuery: argv.query,
            });
            const columns = argv.columns ? argv.columns.split(',') : DEFAULT_COLUMNS;

            const picked = await interactiveList({
              app, table: 'sysapproval_approver', singular: 'approval', columns, limit: argv.limit,
              query, labelField: 'sys_id',
              formatLabel: (r) => {
                const doc = getStringField(r, 'document_id') || getStringField(r, 'sysapproval') || '?';
                const approver = getStringField(r, 'approver');
                return `${doc} — ${getStringField(r, 'state')}${approver ? ` (${approver})` : ''}`;
              },
            });
            if (picked === undefined) return; // user cancelled
            if (picked) {
              const sysID = getStringField(picked, 'sys_id');
              const pending = getStringField(picked, 'state') === 'Requested';
              return app.ok(picked, {
                summary: `Approval: ${getStringField(picked, 'document_id') || sysID}`,
                breadcrumbs: [
                  ...(pending ? [
                    { action: 'approve', cmd: `jsn approvals approve ${sysID}`, description: 'Approve this request' },
                    { action: 'reject', cmd: `jsn approvals reject ${sysID}`, description: 'Reject this request' },
                  ] : []),
                  { action: 'history', cmd: `jsn approvals history ${getStringField(picked, 'document_id') || sysID}`, description: 'Show approval progression' },
                ].filter(Boolean),
              });
            }

            const params = new URLSearchParams();
            params.set('sysparm_limit', String(argv.limit));
            params.set('sysparm_display_value', 'all');
            const fields = resolveFieldsParam(columns);
            if (fields) params.set('sysparm_fields', fields);
            if (query) params.set('sysparm_query', query);
            const records = await app.sdk.list('sysapproval_approver', params);
            app.ok({
              table: 'sysapproval_approver',
              count: records.length,
              columns,
              records,
              context: { instance_url: app.getEffectiveInstance() },
            }, { summary: `${records.length} approval(s)` });
          }),
        })
        .command({
          command: 'approve <sys-id>',
          describe: 'Approve a pending approval request. Mutation — requires confirmation',
          builder: (y) => y
            .positional('sys-id', { describe: 'Approval request sys_id (from approvals list)', type: 'string' })
            .option('comments', { type: 'string', describe: 'Approval comments' })
            .option('force', { type: 'boolean', default: false, describe: 'Skip confirmation' }),
          handler: wrap(async (argv, app) => {
            app.requireInstance();
            await confirmDelete(app, argv, `Approve approval request ${argv['sys-id']}?`);
            assertSafeExactMatch(argv['sys-id']);
            const updated = await setApprovalState(app, argv['sys-id'], 'approved', argv.comments || '');
            app.ok(updated, {
              summary: `Approved ${getStringField(updated, 'document_id') || argv['sys-id']}`,
              breadcrumbs: [
                { action: 'history', cmd: `jsn approvals history ${getStringField(updated, 'document_id') || argv['sys-id']}`, description: 'Show approval progression' },
              ],
            });
          }),
        })
        .command({
          command: 'reject <sys-id>',
          describe: 'Reject a pending approval request. Mutation — requires confirmation',
          builder: (y) => y
            .positional('sys-id', { describe: 'Approval request sys_id (from approvals list)', type: 'string' })
            .option('comments', { type: 'string', describe: 'Rejection comments' })
            .option('force', { type: 'boolean', default: false, describe: 'Skip confirmation' }),
          handler: wrap(async (argv, app) => {
            app.requireInstance();
            await confirmDelete(app, argv, `Reject approval request ${argv['sys-id']}?`);
            assertSafeExactMatch(argv['sys-id']);
            const updated = await setApprovalState(app, argv['sys-id'], 'rejected', argv.comments || '');
            app.ok(updated, {
              summary: `Rejected ${getStringField(updated, 'document_id') || argv['sys-id']}`,
              breadcrumbs: [
                { action: 'history', cmd: `jsn approvals history ${getStringField(updated, 'document_id') || argv['sys-id']}`, description: 'Show approval progression' },
              ],
            });
          }),
        })
        .command({
          command: 'submit <table> <sys-id>',
          describe: 'Request approval on a record (sets approval=requested). Mutation — requires confirmation',
          builder: (y) => y
            .positional('table', { describe: 'Record table (e.g. change_request, incident)', type: 'string' })
            .positional('sys-id', { describe: 'Record sys_id', type: 'string' })
            .option('force', { type: 'boolean', default: false, describe: 'Skip confirmation' }),
          handler: wrap(async (argv, app) => {
            app.requireInstance();
            await confirmDelete(app, argv, `Submit ${argv.table} ${argv['sys-id']} for approval?`);
            assertSafeExactMatch(argv['sys-id']);
            const updated = await submitForApproval(app, argv.table, argv['sys-id']);
            app.ok(updated, {
              summary: `Submitted ${argv.table} ${argv['sys-id']} for approval`,
              breadcrumbs: [
                { action: 'list', cmd: 'jsn approvals list', description: 'See the generated approval requests' },
              ],
            });
          }),
        })
        .command({
          command: 'history <record>',
          describe: 'Show approval progression for a record (number or sys_id)',
          builder: (y) => y
            .positional('record', { describe: 'Record number (CHG0000082) or sys_id', type: 'string' }),
          handler: wrap(async (argv, app) => {
            app.requireInstance();
            const rec = await resolveTaskRecord(app, argv.record, 'record');
            const sysID = getStringField(rec, 'sys_id');
            const rows = await approvalRowsForRecord(app, sysID);
            app.ok({
              record: {
                number: getStringField(rec, 'number'),
                table: getStringField(rec, 'sys_class_name'),
                approval: getStringField(rec, 'approval'),
                state: getStringField(rec, 'state'),
              },
              approvals: rows,
              count: rows.length,
              context: { instance_url: app.getEffectiveInstance() },
            }, {
              summary: `${getStringField(rec, 'number')}: approval=${getStringField(rec, 'approval') || '-'}, ${rows.length} approver row(s)`,
              breadcrumbs: rows.length ? [
                { action: 'list', cmd: `jsn approvals list --for ${getStringField(rec, 'number')}`, description: 'List approval requests for this record' },
              ] : [],
            });
          }),
        });
    },
    handler: (argv) => {
      if (argv._[1]) return; // a subcommand ran — its own handler handled it
      console.log('Manage ServiceNow approval requests.\n');
      console.log('Commands:');
      console.log('  list                 List approval requests (--mine, --for <record>, --state)');
      console.log('  approve <sys-id>     Approve a request (mutation)');
      console.log('  reject <sys-id>      Reject a request (mutation)');
      console.log('  submit <table> <id>  Request approval on a record (mutation)');
      console.log('  history <record>     Show approval progression (number or sys_id)');
      console.log('\nRun "jsn approvals <command> --help" for details.');
      console.log('\napprove/reject/submit are mutations: confirm when prompted, or pass --force / profile skip_confirmations.');
    },
  };
}
