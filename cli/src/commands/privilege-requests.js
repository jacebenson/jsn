import { readPrivilegeRequests, formatPrivilegeRequests, privilegeRequestsSummary } from '../privilege-requests.js';

export function withPrivilegeRequests(command, wrap) {
  const originalBuilder = command.builder;
  command.builder = (yargs) => originalBuilder(yargs).command({
    command: 'requests',
    describe: 'Restricted Caller Access requests (sys_restricted_caller_access): requested, denied, invalidated or allowed, and the scope and script each came from',
    discoveryTasks: [{
      phrases: ['cross-scope access refused', 'caller restriction', 'restricted caller access', 'rca request', 'blocked cross-scope call', 'must declare a restricted caller access privilege'],
      args: ['--json'],
      description: 'List the Restricted Caller Access requests that block cross-scope calls, and where each came from',
    }],
    builder: (y) => y.strict()
      .option('status', { type: 'string', array: true, describe: 'requested, denied, allowed, invalidated or all; repeat or comma-separate (default: all but allowed)' })
      .option('source-scope', { type: 'string', describe: 'Calling application: scope (x_acme_app), name or sys_id' })
      .option('target-scope', { type: 'string', describe: 'Called application: scope, name or sys_id' })
      .option('limit', { alias: 'l', type: 'number', default: 20, describe: 'Max requests, newest first (1-1000)' })
      .epilogue('A call blocked by Restricted Caller Access files one request row, which stays at Requested until the target application\'s admin allows it.\n'
        + 'Those rows are separate from the cross-scope privileges in sys_scope_privilege that `jsn privileges list` reads; allowing a privilege leaves the request blocked.'),
    handler: wrap(async (argv, app) => {
      app.requireInstance();
      const data = await readPrivilegeRequests(app.sdk, { status: argv.status, sourceScope: argv.sourceScope, targetScope: argv.targetScope, limit: argv.limit });
      Object.defineProperty(data, '_formatted', { value: formatPrivilegeRequests(data), enumerable: false });
      app.ok(data, { summary: privilegeRequestsSummary(data) });
    }),
  });
  if (Array.isArray(command.discovery?.benefits)) {
    command.discovery.benefits.push('Restricted Caller Access requests blocking a cross-scope call: jsn privileges requests [--status requested] [--target-scope <scope>]');
  }
  return command;
}
