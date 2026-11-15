// Adapter boundary only: pinned producer source is never edited.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import profiles from '../../../cli/src/record-command-profiles.js';
const ID = /^[a-f0-9]{32}$/;
const raw = x => x?.value ?? x;
const block = reason => { throw Object.assign(new Error(reason), { status: 'blocked-prerequisite' }); };
export function scenarioPolicy(s) {
  if (s.id === 'workflows.update-set-transfer') return 'Native import/commit changes global properties and historical capture records; no approved scoped import adapter';
  if (s.id === 'workflows.catalog-fulfillment') return 'Needs provider-verified catalog task recipe and bounded fulfillment side-effect review; no guessed recipe or existing-item order';
  return null;
}
export function fullPlan(scenarios, mode = 'pdi') {
  return { schemaVersion: 1, mode, liveExecution: false, producerMode: mode, mutationWarning: mode === 'pdi',
    selection: 'full immutable catalog; mode applicability is explicit',
    cleanup: 'Exact current-run IDs only; retain capture sets and unsupported flow graphs. Never delete historical captures or existing business records.',
    tables: ['sys_update_set', ...['properties','views','includes','rules','clientscripts','uiactions','scheduledjobs','uipolicies'].map(k => profiles[k].table), 'sys_hub_flow', 'sys_hub_trigger_instance_v2', 'sys_hub_action_instance', 'sys_hub_flow_version', 'sys_flow_context', 'sys_user', 'sys_user_has_role', 'sys_properties'].filter((v,i,a) => a.indexOf(v) === i).sort(),
    scenarios: scenarios.map(s => ({ id: s.id, mutates: s.mutates, applicable: s.modes.includes(mode), requires: s.requires, commands: s.commandPaths, blockedReason: scenarioPolicy(s) })) };
}
// Closed vocabulary only: never retain provider messages, names, hosts or argv.
export async function runContextScenario(ctx, run) {
  const command = ctx.command, read = ctx.read;
  let stage = 'context.snapshot.application';
  ctx.command = async (args, opts) => {
    if (args[0] === 'rest') stage = args[1].endsWith('/application') ? 'context.snapshot.application' : 'context.snapshot.updateset';
    else if (args[0] === 'updatesets' && args[1] === 'create') stage = 'context.capture.create-select';
    return command(args, opts);
  };
  ctx.read = async (table, query) => {
    if (table === 'sys_update_set' && !ctx.state.has('workflows.originalContext')) stage = query.id ? 'context.restore.record' : 'context.restore.unique-name';
    const result = await read(table, query);
    if (table === 'sys_update_set' && query.id && query.fields?.includes('name') && !ctx.state.has('workflows.originalContext')) {
      const row = Array.isArray(result) ? result[0] : result;
      ctx.state.set('safety.restoreName', raw(row?.name));
    }
    return result;
  };
  try { return await run(ctx); }
  catch (error) {
    const reasons = new Map([
      ['Original effective application/update-set cannot be restored exactly; no context writes performed', 'context.snapshot.invalid'],
      ['Original update-set name, scope or state cannot be restored exactly; no context writes performed', 'context.restore.invalid-record'],
      ['Original update-set name is ambiguous or unreadable; no context writes performed', 'context.restore.ambiguous-name'],
      ['Only exact snapshotted session restoration is permitted', 'context.guard.unapproved-transition'],
      ['Provider denied access', 'provider.access-denied'],
      ['Provider capability unavailable', 'provider.capability-unavailable'],
    ]);
    ctx.state.set('safety.contextDiagnostic', { stage, reason: reasons.get(error.message) || 'context.operation.failed' });
    throw error;
  } finally { ctx.command = command; ctx.read = read; }
}
export function guardFullContext(ctx, { inventory, receiptFile, target }) {
  const original = ctx.command;
  const owned = new Map();
  const allocated = new Map();
  const option = (args, flag) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
  const tableFor = args => option(args, '--table') || (args[0] === 'users' ? 'sys_user' : profiles[args[0]]?.table) || ({ updatesets: 'sys_update_set', flows: 'sys_hub_flow' })[args[0]];
  const register = ctx.registerArtifact;
  ctx.registerArtifact = artifact => {
    if (!allocated.has(`${artifact.table}:${artifact.id}`)) block('Artifact registration lacks a current-run allocation acknowledgement');
    const result = register(artifact); owned.set(`${artifact.table}:${artifact.id}`, artifact); return result;
  };
  const createTables = new Set(['sys_update_set', ...['properties','views','includes','rules','clientscripts','uiactions','scheduledjobs','uipolicies'].map(k => profiles[k].table), 'sys_user', 'sys_user_has_role']);
  ctx.command = async (args, opts = {}) => {
    const registration = inventory.entries.filter(e => !e.path.includes('<') && e.path.split(' ').every((v,i) => args[i] === v)).sort((a,b) => b.path.length-a.path.length)[0];
    const action = args[1], table = tableFor(args), id = option(args, '--sys-id') || args[2];
    const mutation = registration?.declaredMutation && !args.includes('--help') && !['auth','rest'].includes(args[0]);
    if (mutation) {
      if (['scopes','updatesets'].includes(args[0]) && action === 'set') {
        const snapshot = ctx.state.get('workflows.originalContext');
        if (!snapshot || (args[0] === 'scopes' ? id !== snapshot.application : id !== snapshot.updateset)) block('Only exact snapshotted session restoration is permitted');
      } else if (action === 'create') {
        if (args[0] === 'flows') {
          const data = JSON.parse(option(args, '--data') || '{}');
          const name = `jsn_acceptance_${ctx.runKey}_flow`;
          if (data.name !== name || data.scope !== 'global' || data.trigger?.table !== 'sys_properties' || data.trigger?.condition !== `name=${name}` || data.actions?.length !== 1 || data.actions[0].type !== 'Log') block('Only the inspected run-owned Log-only flow is allowed');
        } else {
          if (!createTables.has(table)) block('Table has no reviewed inert create fixture');
          let data = option(args, '--data') ? JSON.parse(option(args, '--data')) : null;
          if (option(args, '--data-file')) {
            const file = fs.realpathSync(option(args, '--data-file'));
            if (!file.startsWith(`${fs.realpathSync(ctx.outputDir)}${path.sep}`)) block('Create payload must stay within current private run');
            data = JSON.parse(fs.readFileSync(file));
          }
          const name = option(args, '--name') || data?.name || data?.user_name || data?.short_description;
          const marker = name?.includes(ctx.runKey) || name?.startsWith(`jsn_acc_${ctx.runKey.slice(-16)}_`) || (table === 'sys_user' && data?.first_name === `acceptance_${ctx.runKey}`) || opts.writeIdentity?.name?.startsWith(ctx.runKey) || (table === 'sys_properties' && name === `jsn_acceptance_${createHash('sha256').update(ctx.runKey).digest('hex').slice(0,20)}` && data?.description === 'JSN acceptance owned fixture');
          if (!marker) block('Create must carry a current-run fixture marker');
          if (table === 'sys_user_has_role' && !owned.has(`sys_user:${data?.user}`)) block('Role assignment requires a current-run owned user');
          if (['sys_script','sys_script_include','sys_script_client','sys_ui_action','sysauto_script','sys_ui_policy'].includes(table) && data?.active !== false) block('Executable fixtures must be inactive');
        }
      } else {
        if (!owned.has(`${table}:${id}`)) block('Mutation of unowned identity refused');
        if (!['update','delete','unlock','publish','test'].includes(action)) block('Mutation action lacks bounded ownership policy');
        if (action === 'test' && !owned.has(`sys_properties:${option(args,'--record')}`)) block('Flow test requires owned trigger record');
      }
    }
    const result = await original(args, opts);
    if (mutation && action === 'create' && result.exitCode === 0 && result.json?.ok === true) {
      const data = result.json.data;
      const createdId = raw(data?.sys_id) || data?.flow?.id;
      if (ID.test(createdId || '')) allocated.set(`${table}:${createdId}`, true);
      if (args[0] === 'flows') {
        for (const [t, value] of [['sys_hub_trigger_instance_v2', data.trigger?.id], ['sys_hub_flow_version', raw(data.version?.sys_id)], ...(data.actions || []).map(a => ['sys_hub_action_instance', raw(a.sys_id ?? a.sysId ?? a.id)])]) if (ID.test(value || '')) allocated.set(`${t}:${value}`, true);
      }
    }
    if (mutation && action === 'test' && result.exitCode === 0 && ID.test(result.json?.data?.context_id || '')) allocated.set(`sys_flow_context:${result.json.data.context_id}`, true);
    return result;
  };
  // The pinned context's closure journals all writes. Cleanup remains exact-ID,
  // but unsupported graph deletion is deliberately retained, not a failure to
  // erase history and not permission to prevent restoration of session context.
  ctx.cleanup = async () => {
    const failures = [];
    if (await ctx.reconcileWrites()) return ['unresolved-write-intent'];
    const manifest = JSON.parse(fs.readFileSync(path.join(ctx.outputDir, 'artifacts.json')));
    for (const a of [...manifest.artifacts].reverse()) {
      if (a.cleaned) continue;
      if (!a.cleanupArgs || a.kind === 'capture-set' || a.kind.startsWith('flow-')) { continue; }
      try {
        const result = await ctx.command(a.cleanupArgs);
        const saved = JSON.parse(fs.readFileSync(path.join(ctx.outputDir, 'artifacts.json')));
        if (result.exitCode !== 0 || !saved.artifacts.find(row => row.table === a.table && row.id === a.id)?.cleaned) throw Error('Cleanup absence unproven');
      } catch { failures.push(`owned-cleanup:${a.table}`); ctx.state.set('cleanup.unresolvedChildren', true); }
    }
    const current = JSON.parse(fs.readFileSync(path.join(ctx.outputDir, 'artifacts.json')));
    const rows = current.artifacts.map(a => ({ table:a.table, id:a.id, kind:a.kind, ownership:'current-run', status:a.cleaned ? 'deleted' : 'retained' }));
    fs.writeFileSync(receiptFile, JSON.stringify({ runKey:ctx.runKey, target, created:rows.length, deleted:rows.filter(a=>a.status==='deleted').length, retained:rows.filter(a=>a.status==='retained').length, artifacts:rows, failures },null,2), {mode:0o600});
    return failures;
  };
  return ctx;
}
