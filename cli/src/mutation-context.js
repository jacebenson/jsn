// Capture-context approval is independent of delete confirmation preferences.
import process from 'node:process';
import { collectCapabilities } from './capabilities.js';
import { isMutationCommand } from './mutations.js';
import { getCurrentUser, getCurrentApplication, getCurrentUpdateSet } from './context.js';
import { canUsePicker, getStringField, quoteShellArg } from './helpers.js';
import { confirm } from './prompts.js';
import { AppError, CodeConfirmationRequired, errUsageHint } from './errors.js';

export function needsMutationContext(argv) {
  if (!isMutationCommand(argv)) return false;
  const caps = collectCapabilities().get(argv._?.[0]) || {};
  if (caps.mutationContextReadMethods?.includes(String(argv.method || 'GET').toUpperCase())) return false;
  return !caps.mutationContextExemptSubcommands?.some(sub =>
    sub.split(' ').every((part, index) => argv._?.[index + 1] === part));
}

function diagnostic(code, message, command, severity = 'warning') {
  return { code, severity, message, remediation: { command } };
}

export async function guardMutationContext(app, argv, { ask = confirm, rawArgs = process.argv.slice(2) } = {}) {
  if (!needsMutationContext(argv) || !app.sdk) return null;
  let application, updateSet;
  try {
    const user = await getCurrentUser(app.sdk);
    if (user?.sys_id) [application, updateSet] = await Promise.all([
      getCurrentApplication(app.sdk, user.sys_id, { unknownWhenMissing: true }),
      getCurrentUpdateSet(app.sdk, user.sys_id),
    ]);
  } catch {
    // Failed reads are unknown context, never evidence of Global + Default.
  }
  const context = { scope: application?.scope || null, application_id: application?.appSysId || null,
    update_set: updateSet ? { name: updateSet.name, sys_id: updateSet.sys_id, state: updateSet.state || null } : null,
    diagnostics: [], approval_required: false, approved: false };
  if (!context.scope || !updateSet) context.diagnostics.push(diagnostic('capture_context_unknown',
    'Capture context could not be determined. Identify the intended scope and update set before development changes.', 'jsn updatesets list'));
  const appId = getStringField(updateSet || {}, 'application');
  const rawAppId = updateSet?.application?.value || appId;
  if (application?.appSysId && rawAppId && application.appSysId !== rawAppId) {
    context.diagnostics.push(diagnostic('update_set_scope_mismatch',
      `Selected scope ${context.scope} and update set ${updateSet.name} belong to different applications; changes may not be captured in this set.`,
      `jsn scopes set ${quoteShellArg(rawAppId)}`));
  }
  if (updateSet?.state && !['in progress', 'in_progress'].includes(updateSet.state.toLowerCase())) {
    context.diagnostics.push(diagnostic('update_set_not_in_progress', `Selected update set ${updateSet.name} is ${updateSet.state}; select an in-progress capture set.`, 'jsn updatesets set', 'error'));
    const error = errUsageHint('Selected capture update set is not in progress.', 'Run: jsn updatesets set');
    error.context = context; throw error;
  }
  const globalDefault = context.scope?.toLowerCase() === 'global' && updateSet?.name?.toLowerCase() === 'default';
  if (globalDefault) {
    context.approval_required = true;
    context.diagnostics.push(diagnostic('global_default_update_set',
      'Global scope + Default update set can capture customization in the wrong place or leave changes untracked. Select or create a dedicated update set; not all record changes are update-set tracked.',
      'jsn updatesets create --name "My Feature"'));
    if (argv.force) context.approved = true;
    else if (canUsePicker(app, argv)) {
      context.approved = await ask({ message: `Scope: Global; update set: Default. ${context.diagnostics.at(-1).message} Approve this exact mutation: ${['jsn', ...rawArgs].map(quoteShellArg).join(' ')}?`, default: false });
    }
    if (!context.approved) {
      const target = app.session?.profileName ? ` --profile ${quoteShellArg(app.session.profileName)}` : '';
      const rerun = ['jsn', ...rawArgs.filter(arg => arg !== '--force')].map(quoteShellArg).join(' ') + (rawArgs.includes('--profile') ? '' : target);
      const error = new AppError(CodeConfirmationRequired, 'Mutation in Global scope + Default update set requires explicit approval.',
        `Select a dedicated set: jsn updatesets set; or jsn updatesets create --name "My Feature". Ask the user to approve this exact operation, then rerun: ${rerun} --force`);
      error.context = context; throw error;
    }
  }
  if (canUsePicker(app, argv)) {
    process.stderr.write(`Mutation context: scope ${context.scope || 'unknown'}; update set ${updateSet?.name || 'unknown'}${updateSet?.sys_id ? ` (${updateSet.sys_id})` : ''}.\n`);
    for (const item of context.diagnostics) process.stderr.write(`Warning (${item.code}): ${item.message} Run: ${item.remediation.command}\n`);
  }
  return context;
}
