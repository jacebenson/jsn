import fs from 'node:fs';
import { getCurrentUser, getCurrentApplication } from '../../context.js';

export function evalCmd(wrap) {
  return {
    command: 'eval',
    describe: 'Execute background scripts on the instance',
    builder: (yargs) => {
      return yargs
        .option('script', { alias: 's', type: 'string', describe: "JavaScript code to execute (single-quote the script, double quotes inside: --script 'gs.log(\"Hello\")')" })
        .option('file', { alias: 'f', type: 'string', describe: 'Read script from file (avoids shell quoting issues)' })
        .option('stdin', { type: 'boolean', describe: 'Read script from stdin (pipe-friendly, e.g. cat script.js | jsn eval --stdin)' })
        .option('scope', { alias: null, type: 'string', describe: 'Scope name or sys_id to run the script under (default: active scope from banner)' });
    },
    handler: wrap(async (argv, app) => {
      let script;
      let scopeSysId = null;

      // Resolve execution scope: explicit --scope wins; otherwise use the
      // active scope from apps.current_app (same source as the banner);
      // fall back to global only when no active scope exists.
      let scope = argv.scope || '';
      if (!scope) {
        try {
          const user = await getCurrentUser(app.sdk);
          if (user && user.sys_id) {
            const currentApp = await getCurrentApplication(app.sdk, user.sys_id);
            if (currentApp && currentApp.scope && currentApp.scope !== 'global') {
              scope = currentApp.scope;
            }
          }
        } catch {
          // ignore — fall back to global
        }
      }

      if (scope) {
        scopeSysId = await app.sdk.resolveScope(scope);
        if (!scopeSysId) {
          throw new Error(`Scope not found: ${scope}`);
        }
      }

      if (argv.file) {
        script = fs.readFileSync(argv.file, 'utf-8');
      } else if (argv.stdin) {
        script = await new Promise((resolve, reject) => {
          let data = '';
          process.stdin.setEncoding('utf-8');
          process.stdin.on('data', (chunk) => { data += chunk; });
          process.stdin.on('end', () => resolve(data));
          process.stdin.on('error', reject);
        });
      } else if (argv.script) {
        script = argv.script;
      } else {
        throw new Error('--script, --file, or --stdin is required');
      }

      if (scopeSysId) {
        script = `var $scopeSysId = '${scopeSysId}';\n${script}`;
      }

      const warning = scopeSysId
        ? ` ⚠️ Records without explicit sys_scope will land in global. Use $scopeSysId variable.`
        : '';
      // Pass the resolved sys_id (not the name) — sys.scripts.do only
      // honors selectable scope values, which are sys_ids.
      const output = await app.sdk.executeScript(script, scopeSysId || '');
      app.ok({
        script,
        output,
        scope: scope || 'global',
        instance: app.getEffectiveInstance(),
      }, {
        summary: 'Script executed' + warning,
        breadcrumbs: [{
          action: 'eval',
          cmd: 'jsn eval --script \'...\'',
          description: 'Execute a background script on the ServiceNow instance',
        }],
      });
    }),
  };
}
