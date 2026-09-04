import fs from 'node:fs';
import { getCurrentUser, getCurrentApplication } from '../context.js';
import { declareCapabilities } from '../capabilities.js';

// The whole command is a mutation surface (runs arbitrary server-side JS) —
// declared as `['']` so the root `jsn eval` command are gated.
declareCapabilities('eval', { mutationSubcommands: [''] });

export function evalCmd(wrap) {
  return {
    command: 'eval',
    describe: 'Execute background scripts on the instance',
    builder: (yargs) => {
      return yargs
        .option('script', { alias: 's', type: 'string', describe: 'JavaScript code to execute (single-quote the script, double quotes inside: --script \'gs.log("Hello")\')' })
        .option('file', { alias: 'f', type: 'string', describe: 'Read script from file (avoids shell quoting issues)' })
        .option('stdin', { type: 'boolean', describe: 'Read script from stdin (pipe-friendly, e.g. cat script.js | jsn eval --stdin)' })
        .option('scope', { alias: null, type: 'string', describe: 'Scope name or sys_id to run the script under (default: active scope from banner)' })
        // Script-mode flags (issue #177) — map to the Script Background form checkboxes
        .option('rollback', { type: 'boolean', default: true, describe: 'Record rollback context (--no-rollback to skip)' })
        .option('sandbox', { type: 'boolean', default: false, describe: 'Sandbox mode (KittyScript evaluator, single expression only — no DB writes)' })
        .option('scriptlet', { type: 'boolean', default: false, describe: 'Run as scriptlet with global server-side objects' })
        .option('quota-managed-transaction', { type: 'boolean', default: true, describe: 'Managed transaction limits (--no-quota-managed-transaction to skip)' });
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

      // Sandbox mode uses the KittyScript evaluator, which only accepts a
      // single expression — multi-statement scripts fail server-side. Warn
      // early, on the user's raw script (before the $scopeSysId prepend).
      if (argv.sandbox) {
        const statements = script.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//'));
        const multiLine = statements.length > 1;
        const hasTerminator = /;[\s\S]*\S/.test(script);
        if (multiLine || hasTerminator) {
          process.stderr.write('Warning: --sandbox runs a single expression (KittyScript). Multi-statement scripts will fail.\n\n');
        }
      }

      if (scopeSysId) {
        script = `var $scopeSysId = '${scopeSysId}';\n${script}`;
      }

      const warning = scopeSysId
        ? ` ⚠️ Records without explicit sys_scope will land in global. Use $scopeSysId variable.`
        : '';
      // Pass the resolved sys_id (not the name) — sys.scripts.do only
      // honors selectable scope values, which are sys_ids.
      const output = await app.sdk.executeScript(script, scopeSysId || '', {
        rollback: argv.rollback,
        quotaManagedTransaction: argv.quotaManagedTransaction,
        sandbox: argv.sandbox,
        scriptlet: argv.scriptlet,
      });
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
