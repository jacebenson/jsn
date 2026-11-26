import { checkUserCriteria, formatUserCriteriaCheck } from '../usercriteria-check.js';

export function withUserCriteriaCheck(command, wrap) {
  const originalBuilder = command.builder;
  command.builder = (yargs) => originalBuilder(yargs).command({
    command: 'check <user> <item>',
    describe: 'Whether a user can see a catalog item, and which Available for and Not available for criteria matched',
    builder: (y) => y
      .positional('user', { type: 'string', describe: 'user_name or sys_id' })
      .positional('item', { type: 'string', describe: 'Catalog item name or sys_id' })
      .epilogue([
        'Read-only: one background script reads the item\'s active Available for and Not available for criteria and asks the platform\'s evaluators, as User Criteria Diagnostics does, whether each matches and whether the user can see the item. The script writes nothing and records no rollback context; the instance logs the run in its script execution history, as it does every background script. Needs a profile that can run background scripts.',
        'Not available for overrides Available for. Criteria scripts that read the session (gs.getUserID()) instead of user_id evaluate as you, not as <user>.',
        'Category and catalog criteria are not checked: a category\'s criteria do not apply to the items in it. Knowledge articles are not covered.',
      ].join('\n')),
    handler: wrap(async (argv, app) => {
      app.requireInstance();
      const data = await checkUserCriteria(app.sdk, argv);
      Object.defineProperty(data, '_formatted', { value: formatUserCriteriaCheck(data), enumerable: false });
      app.ok(data, { summary: data.verdict });
    }),
  });
  return command;
}
