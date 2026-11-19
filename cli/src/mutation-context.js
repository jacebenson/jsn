// Capture-context approval is independent of delete confirmation preferences.
import process from 'node:process';
import { collectCapabilities } from './capabilities.js';
import { isMutationCommand } from './mutations.js';
import { canUsePicker, quoteShellArg } from './helpers.js';
import { confirm } from './prompts.js';
import { AppError, CodeConfirmationRequired } from './errors.js';
import { contextFailure, exactContextRecord, intendedContext, readWriteContext } from './intended-context.js';

export function needsMutationContext(argv) {
  if (!isMutationCommand(argv)) return false;
  const caps = collectCapabilities().get(argv._?.[0]) || {};
  if (caps.mutationContext === 'operational') return false;
  if (caps.mutationContextReadMethods?.includes(String(argv.method || 'GET').toUpperCase())) return false;
  return !caps.mutationContextExemptSubcommands?.some(sub =>
    sub.split(' ').every((part, index) => argv._?.[index + 1] === part));
}

// Table ancestry, not a command-name heuristic, decides generic record writes.
async function isCustomizationTable(sdk, table) {
  if (!table) throw contextFailure('Cannot classify a write without its table.');
  const seen = new Set();
  let row = await exactContextRecord(sdk, 'sys_db_object', 'name', table);
  for (let depth = 0; depth < 32; depth++) {
    const name = row.name?.value ?? row.name;
    if (!name || seen.has(name)) throw contextFailure('Table ancestry is incomplete or cyclic.');
    if (name === 'sys_metadata') return true;
    seen.add(name);
    if (!Object.hasOwn(row, 'super_class')) throw contextFailure('Table ancestry is unreadable.');
    const parent = row.super_class?.value ?? row.super_class;
    if (!parent) return false;
    row = await sdk.get('sys_db_object', parent);
    if (!row) throw contextFailure('Table ancestry is unreadable.');
  }
  throw contextFailure('Table ancestry exceeds the verification bound.');
}

export async function guardMutationContext(app, argv, { ask = confirm, rawArgs = process.argv.slice(2) } = {}) {
  if (!needsMutationContext(argv) || !app.sdk) return null;
  const caps = collectCapabilities().get(argv._?.[0]) || {};
  if (caps.mutationContext === 'table' && !await isCustomizationTable(app.sdk, caps.table || argv.table)) return null;
  const expected = intendedContext(app, argv);
  const interactive = canUsePicker(app, argv);
  if (!interactive && (!expected.scope || !expected.update_set)) throw contextFailure('Noninteractive customization writes require intended scope and update set.');
  // Header application is not an established effective-domain provider contract.
  if (expected.domain !== undefined || app.session?.domain || app.session?.profile?.domain_separation || app.sdk.domain) {
    throw contextFailure('Effective domain cannot be proven for customization writes. X-Now-Domain propagation does not verify domain selection; domain-scoped writes are not supported by this guard.');
  }
  let context;
  try { context = await readWriteContext(app.sdk); }
  catch (error) { throw contextFailure(`Cannot verify capture context: ${error.message}`); }
  if (app.session?.username && context.user.user_name !== app.session.username) throw contextFailure('Current user differs from the selected profile.');
  const fail = message => { const error = contextFailure(message); error.context = context; throw error; };
  if (context.application_id !== context.update_set.application_id) fail('Selected scope and update set belong to different applications.');
  if (!['in progress', 'in_progress'].includes(context.update_set.state.toLowerCase())) fail('Selected capture update set is not in progress.');
  if (expected.scope !== undefined) {
    const scope = await exactContextRecord(app.sdk, 'sys_scope', 'scope', expected.scope);
    if ((scope.sys_id?.value ?? scope.sys_id) !== context.application_id) fail('Intended scope does not match fresh selected scope.');
  }
  if (caps.transactionScopeOption && argv[caps.transactionScopeOption] !== undefined) {
    const scope = await exactContextRecord(app.sdk, 'sys_scope', 'scope', argv[caps.transactionScopeOption]);
    if ((scope.sys_id?.value ?? scope.sys_id) !== context.application_id) fail('Command transaction scope differs from verified intended scope.');
  }
  if (expected.update_set !== undefined) {
    const set = await exactContextRecord(app.sdk, 'sys_update_set', 'name', expected.update_set);
    if ((set.sys_id?.value ?? set.sys_id) !== context.update_set.sys_id) fail('Intended update set does not match fresh selected update set.');
  }
  // Never align/switch a session implicitly. Persisted and effective selections
  // are independent evidence; both must agree before customization can proceed.
  const [scopeResponse, setResponse] = await Promise.all([
    app.sdk.request(`${app.sdk.baseURL}/api/now/ui/concoursepicker/application`, { method: 'GET', readOnly: true }),
    app.sdk.request(`${app.sdk.baseURL}/api/now/ui/concoursepicker/updateset`, { method: 'GET', readOnly: true }),
  ]);
  if (scopeResponse?.result?.current !== context.application_id || setResponse?.result?.current?.sysId !== context.update_set.sys_id) fail('Effective session context is unknown or differs from the selected preferences. No context was switched.');
  context.verified = true;
  if (caps.mutationContext === 'table') context.table = caps.table || argv.table;
  context.source = 'fresh_preferences_and_session';
  context.expected = expected;
  context.diagnostics = [];
  context.approval_required = context.scope.toLowerCase() === 'global' && context.update_set.name.toLowerCase() === 'default';
  context.approved = false;
  if (interactive && (!expected.scope || !expected.update_set) && !context.approval_required) {
    if (!await ask({ message: `Confirm customization in scope ${context.scope}; update set ${context.update_set.name} (${context.update_set.sys_id})?`, default: false })) fail('Customization context was not confirmed.');
    context.approved = true;
  }
  if (context.approval_required) {
    context.diagnostics.push({ code: 'global_default_update_set', severity: 'warning', message: 'Global + Default requires approval for this exact operation.' });
    if (argv.force) context.approved = true;
    else if (interactive) context.approved = await ask({ message: `Scope: Global; update set: Default. Approve this exact mutation: ${['jsn', ...rawArgs].map(quoteShellArg).join(' ')}?`, default: false });
    if (!context.approved) {
      const error = new AppError(CodeConfirmationRequired, 'Mutation in Global scope + Default update set requires explicit approval.', 'Select a dedicated set or obtain user approval for this exact operation, then rerun with --force and explicit expectations.');
      error.context = context; throw error;
    }
  }
  if (interactive) process.stderr.write(`Mutation context: scope ${context.scope}; update set ${context.update_set.name} (${context.update_set.sys_id}); user ${context.user.user_name}.\n`);
  return context;
}
