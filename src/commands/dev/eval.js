import fs from 'node:fs';

export function evalCmd(wrap) {
  return {
    command: 'eval',
    describe: 'Execute background scripts on the instance',
    builder: (yargs) => {
      return yargs
        .option('script', { alias: 's', type: 'string', describe: "JavaScript code to execute (single-quote the script, double quotes inside: --script 'gs.log(\"Hello\")')" })
        .option('file', { alias: 'f', type: 'string', describe: 'Read script from file (avoids shell quoting issues)' })
        .option('scope', { alias: null, type: 'string', describe: 'Scope name or sys_id to run the script under (default: global)' });
    },
    handler: wrap(async (argv, app) => {
      let script;
      let scopeSysId = null;

      if (argv.scope) {
        scopeSysId = await app.sdk.resolveScope(argv.scope);
        if (!scopeSysId) {
          throw new Error(`Scope not found: ${argv.scope}`);
        }
      }

      if (argv.file) {
        script = fs.readFileSync(argv.file, 'utf-8');
      } else if (argv.script) {
        script = argv.script;
      } else {
        throw new Error('--script or --file is required');
      }

      if (scopeSysId) {
        script = `var $scopeSysId = '${scopeSysId}';\n${script}`;
      }

      const warning = scopeSysId
        ? ` ⚠️ Records without explicit sys_scope will land in global. Use $scopeSysId variable.`
        : '';
      const output = await app.sdk.executeScript(script, argv.scope);
      app.ok({
        script,
        output,
        instance: app.getEffectiveInstance(),
      }, {
        summary: 'Script executed' + warning,
        breadcrumbs: [{
          action: 'eval',
          cmd: 'jsn dev eval --script \'...\'',
          description: 'Execute a background script on the ServiceNow instance',
        }],
      });
    }),
  };
}
