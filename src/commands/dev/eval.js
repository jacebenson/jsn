import fs from 'node:fs';

export function evalCmd(wrap) {
  return {
    command: 'eval',
    describe: 'Execute background scripts on the instance',
    builder: (yargs) => {
      return yargs
        .option('script', { alias: 's', type: 'string', describe: "JavaScript code to execute (single-quote the script, double quotes inside: --script 'gs.log(\"Hello\")')" })
        .option('file', { alias: 'f', type: 'string', describe: 'Read script from file (avoids shell quoting issues)' });
    },
    handler: wrap(async (argv, app) => {
      let script;

      if (argv.file) {
        script = fs.readFileSync(argv.file, 'utf-8');
      } else if (argv.script) {
        script = argv.script;
      } else {
        throw new Error('--script or --file is required');
      }

      const output = await app.sdk.executeScript(script);
      app.ok({
        script,
        output,
        instance: app.getEffectiveInstance(),
      }, {
        summary: 'Script executed',
        breadcrumbs: [{
          action: 'eval',
          cmd: 'jsn dev eval --script \'...\'',
          description: 'Execute a background script on the ServiceNow instance',
        }],
      });
    }),
  };
}
