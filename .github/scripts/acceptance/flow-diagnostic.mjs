// Closed diagnostics: no provider message, argv, hostname or credential is retained.
const REASONS = [
  ['Flow trigger insert returned no trigger identity', 'trigger.insert.missing-identity'],
  ['Created trigger identity was not preserved in ProcessFlow read-back', 'trigger.readback.identity-mismatch'],
  ['Flow trigger/action patch failed:', 'trigger-action.patch.provider-rejection'],
  ['Flow creation refused before any content write:', 'capture.preflight-refusal'],
  ['Flow creation response did not include a Flow ID', 'parent.create.missing-identity'],
  ['confirmation_required', 'confirmation-required'],
];
export function flowCommandDiagnostic(args, result) {
  const text = `${result.stdout || ''}\n${result.stderr || ''}`;
  const code = result.json?.error?.code;
  return {
    stage: ['flows','properties','records','rest'].includes(args[0]) && ['create','show','update','unlock','publish','status','test','executions','schemas','list'].includes(args[1]) ? args.slice(0,2).join('.') : 'fixture.read',
    outcome: result.exitCode === 0 ? 'cli-success' : 'cli-failure',
    exitCode: result.exitCode,
    jsonPresent: !!result.json,
    ok: typeof result.json?.ok === 'boolean' ? result.json.ok : null,
    dataKeys: Object.keys(result.json?.data || {}).filter(k => ['flow','trigger','actions','version','processflow','preview','context_id','success','sys_id','records','result'].includes(k)),
    errorCode: ['confirmation_required','forbidden','unauthorized','validation_error','flow_create_failed','internal_error'].includes(code) ? code : null,
    reason: REASONS.find(([literal]) => text.includes(literal))?.[1] || (result.exitCode === 0 ? null : 'cli.failure.unclassified'),
  };
}
