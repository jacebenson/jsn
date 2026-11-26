// `fixscripts run`: run a stored fix script now, as the platform's Run Fix Script
// action does by hand, through the background-script path `jsn eval` uses.

import process from 'node:process';
import { getRecord } from '../records-engine.js';
import { unwrapSysId } from '../resolve-record.js';
import { assertMutationScope } from '../intended-context.js';
import { guardExit, errUsage, CodeUsage } from '../errors.js';
import { buildRerunCommand } from '../helpers.js';

const raw = value => value?.value ?? value;
// The terminal view shows the script on a preview and what it printed on a run; --json keeps the data as it is.
const withText = (data, summary, text) => Object.defineProperty(data, '_formatted', { value: `${summary}\n\n${text}`, enumerable: false });
const EPILOGUE = [
  'Without --yes, reads the fix script and shows what would run, without running it. With --yes, runs its stored script unchanged as a background script, in the fix script\'s own scope, with a rollback context when the record has Record for rollback ticked.',
  'It is a customization write: it needs --expect-scope and --expect-update-set, and the fix script\'s scope must be that scope. Customizations the script writes are captured in that update set, as with jsn eval, whatever the record\'s Unloadable setting says.',
  'jsn cancels the script on the instance after --timeout seconds or on Ctrl-C. When it ran with a rollback context, undo what it wrote with jsn eval rollback <execution>.',
  'This does not start the platform\'s Run Fix Script worker, so no progress worker or fix script log is written; the run is in the background script execution history.',
].join('\n');

export function withFixScriptRun(command, wrap) {
  const originalBuilder = command.builder;
  command.builder = yargs => originalBuilder(yargs).command({
    command: 'run <identifier>',
    describe: 'Run a fix script now, in its own scope; preview by default',
    discoveryTasks: [{ phrases: ['run fix script', 'run a data fix'], args: [], description: 'Preview running a fix script; --yes runs it' }],
    builder: y => y.strict()
      // Checked before the write-context guard, as eval does, so a bad value reads nothing.
      .middleware(argv => { if (!(Number.isInteger(argv.timeout) && argv.timeout >= 1 && argv.timeout <= 86400)) guardExit(argv, { code: CodeUsage, message: '--timeout must be a whole number of seconds from 1 to 86400. Nothing was run.' }); })
      .positional('identifier', { type: 'string', describe: 'Fix script name or sys_id' })
      .option('yes', { type: 'boolean', default: false, describe: 'Run it; without --yes, preview only' })
      .option('timeout', { type: 'number', default: 30, describe: 'Seconds to wait before jsn cancels the script on the instance (Ctrl-C cancels it too)' })
      .epilogue(EPILOGUE),
    handler: wrap(async (argv, app) => {
      app.requireInstance();
      const record = await getRecord(app.sdk, { table: 'sys_script_fix', identifier: argv.identifier, matchField: 'name', resource: 'fix script', fields: ['name', 'script', 'sys_scope', 'record_for_rollback', 'unloadable'], displayValues: 'raw' });
      const sysId = unwrapSysId(record), name = raw(record.name), script = raw(record.script);
      // A Global record stores an empty sys_scope; the verified context names it 'global'.
      const scope = raw(record.sys_scope) || 'global';
      assertMutationScope(app.mutationContext, scope, 'Fix script');
      if (typeof script !== 'string' || !script.trim()) throw errUsage(`Fix script ${name} has no script to run. Nothing was run.`);
      const plan = { sys_id: sysId, name, scope, record_for_rollback: raw(record.record_for_rollback) === 'true', unloadable: raw(record.unloadable) === 'true', script };
      if (!argv.yes) {
        const rerun = buildRerunCommand(argv, { rerun: ['fixscripts', 'run', sysId, '--yes'] });
        const summary = `Dry run: would run fix script ${name} (${sysId}) in its scope, ${plan.record_for_rollback ? 'with' : 'without'} a rollback context`;
        return app.ok(withText({ ...plan, dry_run: true }, summary, script), {
          summary,
          breadcrumbs: [{ action: 'run', cmd: rerun, description: 'Run this fix script' }],
        });
      }
      // Ctrl-C stops the script on the instance too, as in jsn eval.
      const controller = new AbortController();
      const interrupt = () => {
        process.stderr.write('\nCancelling the fix script on the instance...\n');
        controller.abort();
      };
      process.once('SIGINT', interrupt);
      process.once('SIGTERM', interrupt);
      let result;
      try {
        result = await app.sdk.runBackgroundScript(script, scope, { rollback: plan.record_for_rollback, quotaManagedTransaction: true, sandbox: false, scriptlet: false, timeout: argv.timeout * 1000, signal: controller.signal });
      } finally {
        process.removeListener('SIGINT', interrupt);
        process.removeListener('SIGTERM', interrupt);
      }
      const execution = result.execution_id;
      const summary = `Ran fix script ${name}`;
      app.ok(withText({ ...plan, output: result.output, execution }, summary, result.output || 'The script printed nothing.'), {
        summary,
        breadcrumbs: plan.record_for_rollback && execution ? [{ action: 'rollback', cmd: `jsn eval rollback ${execution}`, description: 'Preview undoing what this fix script wrote' }] : [],
      });
    }),
  });
  return command;
}
