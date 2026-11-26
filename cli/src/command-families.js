// Lightweight family identity and safety declarations. Implementations reuse these
// objects: aliases, root help and mutation policy never depend on loading a handler.
import { createRequire } from 'node:module';
import { declareCapabilities } from './capabilities.js';
import { AUDIT_MUTATION_PATHS } from './audit-verbs.js';
import { profileCommandCapabilities, profileCommandDefinition } from './profile-command-definitions.js';
import profiles from './record-command-profiles.js';

// Node >=24 supports synchronous require(ESM). These implementation graphs must
// remain synchronous (no top-level await); this preserves the synchronous adapter
// and complete-discovery API without pre-parsing argv or a generated catalog.
const require = createRequire(import.meta.url);

export const accessAnalyzerCmdDefinition = {
  command: 'access-analyzer [subcommand]',
  describe: 'Inspect saved Access Analyzer requests, outcomes and checks, or check a user\'s access live (read-only)',
};
declareCapabilities('access-analyzer', { queryTable: 'sn_access_analyzer_request', mutationSubcommands: [], noImpersonateSubcommands: ['check'] });
export const accessAnalyzerCmd = wrap => ({ ...accessAnalyzerCmdDefinition, load: () => require('./commands/access-analyzer.js').accessAnalyzerCmd(wrap) });

export const flowsCmdDefinition = {
  command: 'flows [subcommand]',
  aliases: ['flow'],
  describe: 'Manage Flow Designer flows',
};
declareCapabilities('flows', { queryTable: argv => argv._?.[1] === 'executions' ? 'sys_flow_context' : 'sys_hub_flow', transactionScopeOption: 'scope', mutationContextExemptSubcommands: ['test', 'unlock', 'settings'], mutationSubcommands: ['clone', 'copy', 'create', 'update', 'edit', 'delete', 'publish', 'test', 'unlock', 'settings'] });
export const flowsCmd = wrap => ({ ...flowsCmdDefinition, load: () => require('./commands/flows.js').flowsCmd(wrap) });

export const workflowsCmdDefinition = {
  command: 'workflows [subcommand]',
  aliases: ['workflow'],
  describe: 'Inspect legacy Workflow Editor workflows (read-only)',
};
declareCapabilities('workflows', { queryTable: 'wf_workflow', mutationSubcommands: [] });
export const workflowsCmd = wrap => ({ ...workflowsCmdDefinition, load: () => require('./commands/workflows.js').workflowsCmd(wrap) });

export const midserversCmdDefinition = {
  command: 'midservers [subcommand]',
  aliases: ['midserver', 'mid'],
  describe: 'Manage ServiceNow MID Servers and run commands through them',
};
declareCapabilities('midservers', { queryTable: 'ecc_agent', mutationContext: 'operational', mutationSubcommands: ['add', 'remove', 'execute', 'start', 'stop', 'validate'] });
export const midserversCmd = wrap => ({ ...midserversCmdDefinition, load: () => require('./commands/midservers.js').midserversCmd(wrap) });

export const subscriptionsCmdDefinition = {
  command: 'subscriptions [subcommand]', describe: 'Inspect subscription evidence, local schedules and illustrative ITOM populations',
};
declareCapabilities('subscriptions', { noInstance: true, skipDailyChecks: true, mutationSubcommands: [] });
export const subscriptionsCmd = wrap => ({ ...subscriptionsCmdDefinition, load: () => require('./commands/subscriptions.js').subscriptionsCmd(wrap) });

export const customizationsCmdDefinition = {
  command: 'customizations [subcommand]',
  describe: 'Capture and compare customization evidence locally, or revert an application\'s customised files',
};
declareCapabilities('customizations', { noInstance: true, skipDailyChecks: true, mutationSubcommands: ['revert'] });
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
  describe: 'Capture and compare performance summaries and rank slow pattern logs (read-only)',
};

export const perfCmd = wrap => ({ ...perfCmdDefinition, load: () => require('./commands/perf.js').perfCmd(wrap) });

/**
 * A family whose identity and capabilities derive from its record profile.
 * `module`/`exportName` locate the implementation factory that loads on use.
 */
function profileFamily(name, module, exportName, extra = {}) {
  const capabilities = profileCommandCapabilities(profiles[name]);
  return {
    definition: profileCommandDefinition(name),
    capabilities: { ...capabilities, ...extra, mutationSubcommands: [...new Set([...(capabilities.mutationSubcommands || []), ...(extra.mutationSubcommands || [])])] },
    module, exportName,
  };
}


// One declaration per family. Identity and capability policy are authoritative
// here: help, aliases, discovery and the mutation guard read them before any
// handler loads, and the implementation module spreads the same object instead
// of publishing a second signature/alias/description of its own.
const deferredFamilies = {
// Profile-backed families: identity and capability policy derive from
// record-command-profiles.js; nothing restates their signature or aliases.

  incidents: profileFamily("incidents", "./commands/incidents.js", "incidentsCmd"),
  changes: profileFamily("changes", "./commands/changes.js", "changesCmd"),
  requests: profileFamily("requests", "./commands/requests.js", "requestsCmd"),
  tasks: profileFamily("tasks", "./commands/tasks.js", "tasksCmd"),
  includes: profileFamily("includes", "./commands/_simple.js", "includesCmd"),
  rules: profileFamily("rules", "./commands/_simple.js", "rulesCmd"),
  clientscripts: profileFamily("clientscripts", "./commands/_simple.js", "clientScriptsCmd"),
  uiactions: profileFamily("uiactions", "./commands/_simple.js", "uiActionsCmd"),
  tables: profileFamily("tables", "./commands/_simple.js", "tablesCmd", {
    mutationSubcommands: AUDIT_MUTATION_PATHS,
  }),
  sppages: profileFamily("sppages", "./commands/_simple.js", "spPagesCmd"),
  spwidgets: profileFamily("spwidgets", "./commands/_simple.js", "spWidgetsCmd"),
  uipages: profileFamily("uipages", "./commands/_simple.js", "uiPagesCmd"),
  appmenu: profileFamily("appmenu", "./commands/_simple.js", "appMenuCmd"),
  acls: profileFamily("acls", "./commands/_simple.js", "aclsCmd"),
  roles: profileFamily("roles", "./commands/_simple.js", "rolesCmd"),
  properties: profileFamily("properties", "./commands/_simple.js", "propertiesCmd"),
  relationships: profileFamily("relationships", "./commands/_simple.js", "relationshipsCmd"),
  appmodules: profileFamily("appmodules", "./commands/_simple.js", "appmodulesCmd"),
  listcontrols: profileFamily("listcontrols", "./commands/_simple.js", "listcontrolsCmd"),
  views: profileFamily("views", "./commands/_simple.js", "viewsCmd"),
  privileges: profileFamily("privileges", "./commands/_simple.js", "privilegesCmd"),
  uxscripts: profileFamily("uxscripts", "./commands/_simple.js", "uxscriptsCmd"),
  catalogscripts: profileFamily("catalogscripts", "./commands/_simple.js", "catalogscriptsCmd"),
  cataloguipolicies: profileFamily("cataloguipolicies", "./commands/_simple.js", "cataloguipoliciesCmd"),
  uipolicies: profileFamily("uipolicies", "./commands/_simple.js", "uipoliciesCmd"),
  scriptactions: profileFamily("scriptactions", "./commands/_simple.js", "scriptactionsCmd"),
  scheduledjobs: profileFamily("scheduledjobs", "./commands/_simple.js", "scheduledjobsCmd"),
  asyncrules: profileFamily("asyncrules", "./commands/_simple.js", "asyncrulesCmd"),
  triggers: profileFamily("triggers", "./commands/_simple.js", "triggersCmd"),
  assignments: profileFamily("assignments", "./commands/_simple.js", "assignmentsCmd"),
  email: profileFamily("email", "./commands/_simple.js", "emailCmd"),
  notifications: profileFamily("notifications", "./commands/_simple.js", "notificationsCmd"),
  uimacros: profileFamily("uimacros", "./commands/_simple.js", "uimacrosCmd"),
  uxlists: profileFamily("uxlists", "./commands/_simple.js", "uxlistsCmd"),
  uxapplicability: profileFamily("uxapplicability", "./commands/_simple.js", "uxapplicabilityCmd"),

// Hand-written families declare their root identity here, once. The command
// module spreads this same object instead of publishing a second copy.

  "tower": {
    definition: {
      command: "tower",
      describe: "Sweep the instance from the AI control tower",
      hidden: true,
    },
    capabilities: {
      mutationSubcommands: [],
    },
    module: "./commands/tower.js", exportName: "towerCmd",
  },
  "setup": {
    definition: {
      command: "setup",
      describe: "Set up JSN defaults and manage ServiceNow connections (interactive)",
      summary: "Connect to ServiceNow and manage profiles",
    },
    capabilities: {
      noInstance: true,
      skipContextHeader: true,
    },
    module: "./commands/setup.js", exportName: "setupCmd",
  },
  "auth": {
    definition: {
      command: "auth [subcommand]",
      describe: "Manage authentication (OAuth, Basic, or browser session)",
    },
    capabilities: {
      noInstance: true,
      skipContextHeader: true,
    },
    module: "./commands/auth.js", exportName: "authCmd",
  },
  "records": {
    definition: {
      command: "records [subcommand]",
      describe: "Query and manage records in any table (e.g. \"records list --table incident --query priority=1\")",
      summary: "Query any table when no specialized command fits",
    },
    capabilities: {
      queryTable: argv => argv._?.[1] === "deleted" ? "sys_audit_delete" : argv.table,
      mutationContext: "table",
      filteredMutationSubcommands: ["delete-many", "bulk"],
      mutationSubcommands: ["create", "update", "delete", "delete-many", "bulk", "undelete", "revert", "import"],
      mutationContextExemptSubcommands: ["import"],
      localPreviewSubcommands: ["import"],
      noImpersonateSubcommands: ["watch"],
    },
    module: "./commands/records.js", exportName: "recordsCmd",
  },
  "attachments": {
    definition: {
      command: "attachments [subcommand]",
      aliases: ["attachment"],
      describe: "List, download and upload files attached to any record",
    },
    capabilities: {
      mutationContext: "operational",
      mutationSubcommands: ["upload", "add"],
    },
    module: "./commands/attachments.js", exportName: "attachmentsCmd",
  },
  "cmdb": {
    definition: {
      command: "cmdb [subcommand]",
      describe: "Query the Configuration Management Database (CMDB) — CIs and relationship traversal (read-only)",
    },
    capabilities: {
      queryTable: "cmdb_ci",
    },
    module: "./commands/cmdb.js", exportName: "cmdbCmd",
  },
  "knowledge": {
    definition: {
      command: "knowledge [subcommand]",
      aliases: ["kb"],
      describe: "Search and read knowledge articles through the Knowledge API",
      summary: "Search and read knowledge articles",
    },
    module: "./commands/knowledge.js", exportName: "knowledgeCmd",
  },
  "snippets": {
    definition: {
      command: "snippets [subcommand]",
      describe: "Save and re-run named query snippets (stored locally, no instance contact except run)",
    },
    module: "./commands/snippets.js", exportName: "snippetsCmd",
  },
  "users": {
    definition: {
      command: "users [subcommand]",
      aliases: ["user"],
      describe: "Manage ServiceNow users",
    },
    capabilities: {
      queryTable: "sys_user",
      mutationContext: "operational",
      mutationSubcommands: ["create", "update", "delete"],
    },
    module: "./commands/users.js", exportName: "usersCmd",
  },
  "groups": {
    definition: {
      command: "groups [subcommand]",
      aliases: ["group"],
      describe: "Manage ServiceNow groups",
    },
    capabilities: {
      queryTable: "sys_user_group",
      mutationContext: "operational",
      mutationSubcommands: ["create", "update", "delete"],
    },
    module: "./commands/groups.js", exportName: "groupsCmd",
  },
  "groupmembers": {
    definition: {
      command: "groupmembers [subcommand]",
      aliases: ["groupmember", "gmember", "gm"],
      describe: "Manage group memberships",
    },
    capabilities: {
      queryTable: "sys_user_grmember",
      mutationContext: "operational",
      mutationSubcommands: ["add", "remove"],
    },
    module: "./commands/groupmembers.js", exportName: "groupMembersCmd",
  },
  "grouproles": {
    definition: {
      command: "grouproles [subcommand]",
      aliases: ["grouprole", "grole", "gr"],
      describe: "Manage group roles",
    },
    capabilities: {
      queryTable: "sys_group_has_role",
      mutationContext: "operational",
      mutationSubcommands: ["add", "remove"],
    },
    module: "./commands/grouproles.js", exportName: "groupRolesCmd",
  },
  "tickets": {
    definition: {
      command: "tickets [subcommand]",
      aliases: ["ticket"],
      describe: "Query generic tickets (e.g. \"tickets list --query active=true\")",
    },
    capabilities: {
      queryTable: "task",
      mutationContext: "operational",
      mutationSubcommands: ["create", "update", "delete"],
    },
    module: "./commands/tickets.js", exportName: "ticketsCmd",
  },
  "cases": {
    definition: {
      command: "cases [subcommand]",
      aliases: ["case"],
      describe: "List, show or search service and HR cases visible to the connected account",
    },
    capabilities: {
    },
    module: "./commands/cases.js", exportName: "casesCmd",
  },
  "transactions": {
    definition: {
      command: "transactions",
      describe: "Summarize syslog_transaction response times by transaction type",
    },
    capabilities: {
      queryTable: "syslog_transaction",
      mutationContext: "operational",
      mutationSubcommands: ["kill"],
    },
    module: "./commands/transactions.js", exportName: "transactionsCmd",
  },
  "platform": {
    definition: {
      command: "platform",
      describe: "Inspect read-only platform health and node statistics",
    },
    capabilities: {
      mutationSubcommands: [],
    },
    module: "./commands/platform.js", exportName: "platformCmd",
  },
  "codesearch": {
    definition: {
      command: "codesearch [subcommand]",
      describe: "Search code across ServiceNow artifacts with read-only GraphQL queries",
    },
    module: "./commands/codesearch.js", exportName: "codesearchCmd",
  },
  "upgrade": {
    definition: {
      command: "upgrade",
      aliases: ["update"],
      describe: "Upgrade jsn through npm (preserves the installed release channel)",
    },
    capabilities: {
      noInstance: true,
      skipDailyChecks: true,
    },
    module: "./commands/upgrade.js", exportName: "upgradeCmd",
  },
  "document": {
    definition: {
      command: "document",
      describe: "Create bounded read-only instance configuration documentation",
    },
    capabilities: {
      mutationSubcommands: [],
      skipDailyChecks: true,
    },
    module: "./commands/document.js", exportName: "documentCmd",
  },
  "actions": {
    definition: {
      command: "actions [subcommand]",
      aliases: ["action"],
      describe: "Flow Designer actions: create, edit full definitions, and test with outputs",
    },
    capabilities: {
      transactionScopeOption: "scope",
      mutationContextExemptSubcommands: ["test"],
      mutationSubcommands: ["create", "update", "edit", "delete", "test"],
    },
    module: "./commands/_simple.js", exportName: "actionsCmd",
  },
  "columns": {
    definition: {
      command: "columns [subcommand]",
      aliases: ["column", "col"],
      describe: "Manage columns (e.g. \"columns list --query nameLIKEincident\")",
    },
    capabilities: {
      mutationContext: "table",
      table: "sys_dictionary",
      mutationSubcommands: ["create", "update", "delete"],
    },
    module: "./commands/_simple.js", exportName: "columnsCmd",
  },
  "import": {
    definition: {
      command: "import [subcommand]",
      aliases: ["imports", "imp"],
      describe: "Manage import (e.g. \"import list --query nameLIKEincident\")",
    },
    capabilities: {
      mutationContext: "operational",
      queryTable: "sys_import_set",
      mutationSubcommands: ["load", "transform"],
    },
    module: "./commands/_simple.js", exportName: "importCmd",
  },
  "aliases": {
    definition: {
      command: "aliases [subcommand]",
      aliases: ["alias", "als"],
      describe: "Manage aliases (e.g. \"aliases list --query nameLIKEincident\")",
    },
    capabilities: {
      mutationContext: "table",
      table: "sys_alias",
      mutationSubcommands: ["create", "update", "delete"],
    },
    module: "./commands/_simple.js", exportName: "aliasesCmd",
  },
  "restmessage": {
    definition: {
      command: "restmessage [subcommand]",
      aliases: ["rm", "restmsg"],
      describe: "Manage restmessage (e.g. \"restmessage list --query nameLIKEincident\")",
    },
    capabilities: {
      mutationContext: "table",
      table: "sys_rest_message",
      mutationSubcommands: ["create", "update", "delete"],
    },
    module: "./commands/_simple.js", exportName: "restmessageCmd",
  },
  "soapmessages": {
    definition: {
      command: "soapmessages [subcommand]",
      aliases: ["soapmsg"],
      describe: "Manage soapmessages (e.g. \"soapmessages list --query nameLIKEincident\")",
    },
    capabilities: {
      mutationContext: "table",
      table: "sys_soap_message",
      mutationSubcommands: ["create", "update", "delete"],
    },
    module: "./commands/_simple.js", exportName: "soapmessagesCmd",
  },
  "decisiontables": {
    definition: {
      command: "decisiontables [subcommand]",
      aliases: ["decisiontable"],
      describe: "Manage decision tables",
    },
    capabilities: {
      queryTable: "sys_decision",
      mutationSubcommands: ["create", "update", "delete"],
    },
    module: "./commands/decisiontables.js", exportName: "decisiontablesCmd",
  },
  "forms": {
    definition: {
      command: "forms [subcommand]",
      aliases: ["form", "f"],
      describe: "Manage UI Forms",
    },
    module: "./commands/forms.js", exportName: "formsCmd",
  },
  "lists": {
    definition: {
      command: "lists [subcommand]",
      aliases: ["list-layout", "l"],
      describe: "List views for a table",
    },
    module: "./commands/lists.js", exportName: "listsCmd",
  },
  "updatesets": {
    definition: {
      command: "updatesets [subcommand]",
      aliases: ["updateset", "us"],
      describe: "Manage update sets. Global + Default mutations require approval (--force only after user approval); create/set remain available to select a dedicated capture set. Scope mismatches warn; completed capture sets block writes.",
    },
    capabilities: {
      queryTable: "sys_update_set",
      mutationSubcommands: ["create", "set", "complete", "ignore", "parent", "import", "reopen", "preview", "commit"],
      mutationContextExemptSubcommands: ["create", "set", "import", "reopen", "preview", "commit"],
      skipContextHeaderSubcommands: ["diff"],
      noImpersonateSubcommands: ["diff"],
      localPreviewSubcommands: ["import"],
    },
    module: "./commands/updatesets.js", exportName: "updateSetsCmd",
  },
  "scopes": {
    definition: {
      command: "scopes [subcommand]",
      aliases: ["scope", "sc"],
      describe: "Manage application scopes",
    },
    capabilities: {
      queryTable: "sys_scope",
      mutationSubcommands: ["create", "set"],
      mutationContextExemptSubcommands: ["set"],
    },
    module: "./commands/scopes.js", exportName: "scopesCmd",
  },
  "domains": {
    definition: {
      command: "domains [subcommand]",
      aliases: ["domain", "dom"],
      describe: "Manage domains (domain separation)",
    },
    capabilities: {
      queryTable: "domain",
      mutationContext: "operational",
      mutationSubcommands: ["set", "session-set", "session-reset"],
    },
    module: "./commands/domains.js", exportName: "domainsCmd",
  },
  "eval": {
    definition: {
      command: "eval",
      describe: "Execute background scripts on the instance (--repl for interactive mode)",
    },
    capabilities: {
      transactionScopeOption: "scope",
      mutationSubcommands: [""],
      mutationContextReadOnlyFlags: ["sandbox"],
    },
    module: "./commands/eval.js", exportName: "evalCmd",
  },
  "rest": {
    definition: {
      command: "rest [endpoint]",
      describe: "Make raw REST API calls",
    },
    capabilities: {
      encodedQuery: false,
      mutationSubcommands: [""],
      mutationContextReadMethods: ["GET", "HEAD", "OPTIONS"],
    },
    module: "./commands/rest.js", exportName: "restCmd",
  },
  "logs": {
    definition: {
      command: "logs [subcommand]",
      aliases: ["log"],
      describe: "Query system logs",
    },
    capabilities: {
      queryTable: "syslog",
      noImpersonateSubcommands: ["follow"],
    },
    module: "./commands/logs.js", exportName: "logsCmd",
  },
  "scrapi": {
    definition: {
      command: "scrapi [subcommand]",
      aliases: ["scripted-rest", "rest-api"],
      describe: "Manage Scripted REST APIs (list, show, create) and search every REST API and its OpenAPI spec",
    },
    capabilities: {
      queryTable: "sys_ws_operation",
      transactionScopeOption: "scope",
      mutationSubcommands: ["create"],
    },
    module: "./commands/scrapi.js", exportName: "scrapiCmd",
  },
  "b4rules": {
    definition: {
      command: "b4rules [subcommand]",
      aliases: ["b4rule"],
      describe: "Inspect before-query business rules that can filter record reads",
    },
    capabilities: {
      mutationContext: "table",
      table: "sys_script",
      mutationSubcommands: ["create", "update", "delete"],
    },
    module: "./commands/b4rules.js", exportName: "b4rulesCmd",
  },
  "scan": {
    definition: {
      command: "scan [subcommand]",
      describe: "Instance Scan checks, suites, explicit targets, progress and findings",
    },
    capabilities: {
      mutationSubcommands: ["checks create", "checks update", "checks delete", "checks activate", "checks deactivate", "suites create", "suites update", "suites delete", "suites activate", "suites deactivate", "suites add-check", "suites remove-check", "run", "cancel"],
    },
    module: "./commands/scan.js", exportName: "scanCmd",
  },
  "store": {
    definition: {
      command: "store [subcommand]",
      describe: "Discover ServiceNow Store applications, inspect versions and entitlement, and request explicit installs/updates",
    },
    capabilities: {
      skipContextHeaderSubcommands: ["compare"],
      noImpersonateSubcommands: ["compare"],
      mutationSubcommands: ["install", "update"],
      mutationContextExemptSubcommands: ["install", "update"],
    },
    module: "./commands/store.js", exportName: "storeCmd",
  },
  "plugins": {
    definition: {
      command: "plugins",
      describe: "Inspect platform plugin differences across instances",
    },
    capabilities: {
      skipContextHeader: true,
      noImpersonateSubcommands: ["compare"],
    },
    module: "./commands/plugins.js", exportName: "pluginsCmd",
  },
  "compare": {
    definition: {
      command: "compare",
      describe: "Compare plugins AND Store apps; report how to align --target to desired --source (read-only)",
    },
    capabilities: {
      skipContextHeader: true,
      noImpersonateSubcommands: [""],
    },
    module: "./commands/compare.js", exportName: "compareCmd",
  },
  "approvals": {
    definition: {
      command: "approvals [subcommand]",
      describe: "Manage approval requests (list, approve, reject, submit, history)",
      summary: "List, approve, or reject approval requests",
    },
    capabilities: {
      queryTable: "sysapproval_approver",
      mutationContext: "operational",
      mutationSubcommands: ["approve", "reject", "submit"],
    },
    module: "./commands/approvals.js", exportName: "approvalsCmd",
  },
  "diff": {
    definition: {
      command: "diff [subcommand]",
      describe: "Compare records across configured profiles (read-only)",
    },
    capabilities: {
      noImpersonateSubcommands: ["record"],
    },
    module: "./commands/diff.js", exportName: "diffCmd",
  },
  "graphql": {
    definition: {
      command: "graphql [document]",
      describe: "Execute a GraphQL document against ServiceNow Now GraphQL",
    },
    capabilities: {
      encodedQuery: false,
      mutationSubcommands: [""],
    },
    module: "./commands/graphql.js", exportName: "graphqlCmd",
  },
  "catalogitems": {
    definition: {
      command: "catalogitems [subcommand]",
      aliases: ["ci"],
      describe: "Manage Service Catalog items",
    },
    capabilities: {
      queryTable: "sc_cat_item",
      mutationSubcommands: ["create", "order"],
      mutationContextExemptSubcommands: ["order"],
      localPreviewSubcommands: ["order"],
    },
    module: "./commands/catalog.js", exportName: "catalogCmd",
  },
  "atf": {
    definition: {
      command: "atf [subcommand]",
      describe: "Automated Test Framework (list, suites, run, results)",
    },
    capabilities: {
      queryTable: argv => argv._?.[1] === 'suites' ? 'sys_atf_test_suite' : 'sys_atf_test',
      mutationContext: "operational",
      mutationSubcommands: ["run", "run-suite"],
    },
    module: "./commands/atf.js", exportName: "atfCmd",
  },
};

/**
 * Identity for a deferred family. Command modules spread this object so their
 * builders and handlers never restate a signature, alias or description.
 */
export function deferredFamilyDefinition(name) {
  const family = deferredFamilies[name];
  if (!family) throw new Error(`Unknown deferred command family: ${name}`);
  return family.definition;
}

for (const [name, family] of Object.entries(deferredFamilies)) {
  // A family with no declaration keeps no entry, exactly as before: the
  // capability registry only carries policy a module actually states.
  if (family.capabilities) declareCapabilities(name, { ...family.capabilities });
}

// `upgrade` also declares the legacy `update` alias policy. No command is
// registered under that name, but the registry carried the entry before the
// implementation became deferred, so it stays declared here.
declareCapabilities('update', { noInstance: true, skipDailyChecks: true });

/**
 * Register a deferred family by name. Identity comes from the table above; the
 * factory supplies only builders and handlers.
 */
export function deferredFamily(name, wrap) {
  const family = deferredFamilies[name];
  if (!family) throw new Error(`Unknown deferred command family: ${name}`);
  return { ...family.definition, load: () => require(family.module)[family.exportName](wrap) };
}
