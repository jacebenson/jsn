// Lightweight family identity and safety declarations. Implementations reuse these
// objects: aliases, root help and mutation policy never depend on loading a handler.
import { createRequire } from 'node:module';
import { declareCapabilities } from './capabilities.js';

// Node >=24 supports synchronous require(ESM). These implementation graphs must
// remain synchronous (no top-level await); this preserves the synchronous adapter
// and complete-discovery API without pre-parsing argv or a generated catalog.
const require = createRequire(import.meta.url);

export const flowsCmdDefinition = {
  command: 'flows [subcommand]',
  aliases: ['flow'],
  describe: 'Manage Flow Designer flows',
};
declareCapabilities('flows', { transactionScopeOption: 'scope', mutationContextExemptSubcommands: ['test', 'unlock'], mutationSubcommands: ['clone', 'copy', 'create', 'update', 'edit', 'delete', 'publish', 'test', 'unlock'] });
export const flowsCmd = wrap => ({ ...flowsCmdDefinition, load: () => require('./commands/flows.js').flowsCmd(wrap) });

export const workflowsCmdDefinition = {
  command: 'workflows [subcommand]',
  aliases: ['workflow'],
  describe: 'Inspect legacy Workflow Editor workflows (read-only)',
};
declareCapabilities('workflows', { mutationSubcommands: [] });
export const workflowsCmd = wrap => ({ ...workflowsCmdDefinition, load: () => require('./commands/workflows.js').workflowsCmd(wrap) });

export const midserversCmdDefinition = {
  command: 'midservers [subcommand]',
  aliases: ['midserver', 'mid'],
  describe: 'Manage ServiceNow MID Servers and run commands through them',
};
declareCapabilities('midservers', { mutationContext: 'operational', mutationSubcommands: ['add', 'remove', 'execute', 'start', 'stop', 'validate'] });
export const midserversCmd = wrap => ({ ...midserversCmdDefinition, load: () => require('./commands/midservers.js').midserversCmd(wrap) });

export const subscriptionsCmdDefinition = {
  command: 'subscriptions [subcommand]', describe: 'Inspect local metering schedules and compare illustrative ITOM populations',
};
declareCapabilities('subscriptions', { noInstance: true, skipDailyChecks: true, mutationSubcommands: [] });
export const subscriptionsCmd = wrap => ({ ...subscriptionsCmdDefinition, load: () => require('./commands/subscriptions.js').subscriptionsCmd(wrap) });

export const customizationsCmdDefinition = {
  command: 'customizations [subcommand]',
  describe: 'Capture and compare read-only customization evidence locally',
};
declareCapabilities('customizations', { noInstance: true, skipDailyChecks: true, mutationSubcommands: [] });
export const customizationsCmd = wrap => ({ ...customizationsCmdDefinition, load: () => require('./commands/customizations.js').customizationsCmd(wrap) });

export const skippedUpdatesCmdDefinition = {
  command: 'skipped-updates', describe: 'Review and process existing unresolved skipped updates across all upgrade history',
};
declareCapabilities('skipped-updates', { mutationSubcommands: ['process'] });
export const skippedUpdatesCmd = wrap => ({ ...skippedUpdatesCmdDefinition, load: () => require('./commands/skipped-updates.js').skippedUpdatesCmd(wrap) });

export const docsCmdDefinition = {
  command: 'docs [query..]',
  defaultPositionals: true,
  describe: 'Search ServiceNow documentation (hosted by default; configure your service in setup)',
};
declareCapabilities('docs', { noInstance: true, skipDailyChecks: true });
export const docsCmd = wrap => ({ ...docsCmdDefinition, load: () => require('./commands/docs/docs.js').docsCmd(wrap) });

export const perfCmdDefinition = {
  command: 'perf [subcommand]',
  aliases: ['performance'],
  describe: 'Capture and compare read-only ServiceNow performance summaries',
};

export const perfCmd = wrap => ({ ...perfCmdDefinition, load: () => require('./commands/perf.js').perfCmd(wrap) });
