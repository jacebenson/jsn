// Versioned harness-only scenario adapter. Producer bytes remain immutable.
// Published v5.5.5 updatesets set resolves names, not IDs; restoration uses
// the trusted SDK's official picker contract instead, never candidate argv.
import fs from 'node:fs';
import path from 'node:path';
import { setCurrentApplication, setCurrentUpdateSet } from '../../../cli/src/context.js';
// Trusted harness operation, not evidence of candidate updatesets-set support.
export async function restoreOriginalContext(sdk, snapshot) {
  if (!snapshot || !/^(global|[a-f0-9]{32})$/.test(snapshot.application) || !/^[a-f0-9]{32}$/.test(snapshot.updateset || '')) refuse('Invalid original restoration identity');
  await setCurrentApplication(sdk, null, snapshot.application);
  await setCurrentUpdateSet(sdk, null, snapshot.updateset);
}
const ID = /^[a-f0-9]{32}$/;
const raw = value => value?.value ?? value;
const refuse = message => { throw Object.assign(new Error(message), { status: 'blocked-prerequisite' }); };
async function command(ctx, args) {
  const result = await ctx.command(args);
  if (result.exitCode !== 0 || result.json?.ok !== true) refuse('Context command failed');
  return result.json.data;
}
async function picker(ctx, kind) {
  return (await command(ctx, ['rest', `/api/now/ui/concoursepicker/${kind}`, '--method', 'GET', '--json']))?.result?.current;
}
async function validate(ctx, snapshot) {
  if (!snapshot || !/^(global|[a-f0-9]{32})$/.test(snapshot.application) || !ID.test(snapshot.updateset || '')) refuse('Original effective application/update-set cannot be restored exactly; no context writes performed');
  const result = await ctx.read('sys_update_set', { id: snapshot.updateset, fields: ['sys_id', 'application', 'state'] });
  const row = Array.isArray(result) ? result.length === 1 ? result[0] : null : result;
  if (raw(row?.sys_id) !== snapshot.updateset || raw(row?.application) !== snapshot.application || raw(row?.state) !== 'in progress') refuse('Original update-set name, scope or state cannot be restored exactly; no context writes performed');
}
export function contextAdapterV1(scenario, restore) {
  return { ...scenario, commandPaths: scenario.commandPaths.filter(p => p !== 'updatesets set'),
    async run(ctx) {
      if (ctx.mode !== 'pdi' || !ctx.allowWrites || typeof restore !== 'function') refuse('Context adapter requires approved writes and trusted exact-ID restoration');
      const snapshot = { application: await picker(ctx, 'application'), updateset: (await picker(ctx, 'updateset'))?.sysId };
      await validate(ctx, snapshot);
      fs.writeFileSync(path.join(ctx.outputDir, 'workflow-context.json'), JSON.stringify(snapshot), { flag: 'wx', mode: 0o600 });
      ctx.state.set('workflows.originalContext', snapshot);
      const name = `jsn_acceptance_${ctx.runKey}_capture`;
      const created = await command(ctx, ['updatesets', 'create', '--name', name, '--scope', 'global', '--json']);
      const captureId = raw(created?.sys_id);
      if (!ID.test(captureId || '')) refuse('Context create returned no valid allocation');
      ctx.registerArtifact({ table: 'sys_update_set', id: captureId, kind: 'capture-set', dependsOn: [], cleanupArgs: ['records', 'delete', '--table', 'sys_update_set', '--sys-id', captureId, '--force', '--json'] });
      ctx.state.set('workflows.context', { captureId, scope: 'global', name });
      const capture = await ctx.read('sys_update_set', { id: captureId, fields: ['sys_id', 'application', 'state'] });
      const row = Array.isArray(capture) ? capture[0] : capture;
      if (raw(row?.sys_id) !== captureId || raw(row?.application) !== 'global' || raw(row?.state) !== 'in progress' || await picker(ctx, 'application') !== 'global' || (await picker(ctx, 'updateset'))?.sysId !== captureId) refuse('Owned capture selection could not be verified');
      return { verified: ['context-adapter-v1', 'context-snapshot', 'candidate-capture-create', 'session-selection'] };
    },
    async cleanup(ctx) {
      const snapshot = ctx.state.get('workflows.originalContext');
      if (!snapshot) return;
      if (ctx.state.get('writes.unresolved') || ctx.state.get('cleanup.unresolvedChildren')) refuse('Unresolved writes or children; retain capture context for read-only reconciliation');
      await validate(ctx, snapshot);
      // Only this exact original ID may cross the trusted restore seam.
      await restore(Object.freeze({ ...snapshot }));
      if (await picker(ctx, 'application') !== snapshot.application || (await picker(ctx, 'updateset'))?.sysId !== snapshot.updateset) refuse('Exact context restoration could not be verified');
      ctx.state.delete('workflows.context');
    },
  };
}
