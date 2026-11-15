// Closed-field private recovery evidence; never copy provider payloads or env.
import fs from 'node:fs';
import path from 'node:path';
const id = value => typeof value === 'string' && /^(global|[a-f0-9]{32})$/.test(value) ? value : null;
const word = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(value) ? value : null;
export function preserveRecovery(ctx, output, target) {
  let journal = {}, journalStatus = 'unavailable';
  try { journal = JSON.parse(fs.readFileSync(path.join(ctx.outputDir, 'artifacts.json'))); journalStatus = 'read'; } catch { /* Preserve state even without a readable journal. */ }
  const original = ctx.state.get('workflows.originalContext');
  const snapshot = original ? { application: id(original.application), updateset: id(original.updateset) } : null;
  const rows = Array.isArray(journal.artifacts) ? journal.artifacts : [];
  const intents = Array.isArray(journal.writeIntents) ? journal.writeIntents : [];
  const recovery = {
    schemaVersion: 1, runKey: word(ctx.runKey), target: word(target), journalStatus,
    originalSnapshot: snapshot,
    sessionRestoration: original ? (ctx.state.has('workflows.context') ? 'unresolved' : 'verified-by-provider-readback') : 'not-established',
    captureId: id(ctx.state.get('workflows.context')?.captureId),
    artifacts: rows.map(a => ({ table: word(a.table), id: id(a.id), kind: word(a.kind), cleaned: a.cleaned === true })),
    writeIntents: intents.map(i => ({ table: word(i.table), action: word(i.action), id: id(i.id), captureId: id(i.captureId), status: word(i.status) })),
    diagnostics: ctx.state.has('safety.flowDiagnostic') ? { stage: word(ctx.state.get('safety.flowDiagnostic')?.stage), reason: word(ctx.state.get('safety.flowDiagnostic')?.reason) } : null,
  };
  const file = path.join(output, 'recovery-manifest.json');
  fs.writeFileSync(file, JSON.stringify(recovery, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return recovery;
}
