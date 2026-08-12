// Parent dev command

import {
  actionsCmd, includesCmd, rulesCmd,
  clientScriptsCmd, uiActionsCmd, uiPoliciesCmd,
  tablesCmd, columnsCmd, importCmd,
  spPagesCmd, spWidgetsCmd, uiPagesCmd, appMenuCmd,
  aclsCmd, rolesCmd, propertiesCmd,
  relationshipsCmd, appmodulesCmd, listcontrolsCmd, viewsCmd,
  privilegesCmd, uxscriptsCmd, aliasesCmd,
  catalogscriptsCmd, cataloguipoliciesCmd,
} from './dev/_simple.js';
import { flowsCmd } from './dev/flows.js';
import { formsCmd } from './dev/forms.js';
import { listsCmd } from './dev/lists.js';
import { updateSetsCmd } from './dev/updatesets.js';
import { scopesCmd } from './dev/scopes.js';
import { domainsCmd } from './dev/domains.js';
import { evalCmd } from './dev/eval.js';
import { restCmd } from './dev/rest.js';
import { logsCmd } from './dev/logs.js';
import { scrapiCmd } from './dev/scrapi.js';

export function devCmd(wrap) {
  return {
    command: 'dev [subcommand]',
    describe: 'Manage ServiceNow development artifacts',
    builder: (yargs) => {
      return yargs
        .command(flowsCmd(wrap))
        .command(actionsCmd(wrap))
        .command(includesCmd(wrap))
        .command(rulesCmd(wrap))
        .command(clientScriptsCmd(wrap))
        .command(uiActionsCmd(wrap))
        .command(uiPoliciesCmd(wrap))
        .command(tablesCmd(wrap))
        .command(columnsCmd(wrap))
        .command(formsCmd(wrap))
        .command(listsCmd(wrap))
        .command(importCmd(wrap))
        .command(spPagesCmd(wrap))
        .command(spWidgetsCmd(wrap))
        .command(uiPagesCmd(wrap))
        .command(appMenuCmd(wrap))
        .command(scrapiCmd(wrap))
        .command(aclsCmd(wrap))
        .command(rolesCmd(wrap))
        .command(updateSetsCmd(wrap))
        .command(scopesCmd(wrap))
        .command(domainsCmd(wrap))
        .command(propertiesCmd(wrap))
        .command(relationshipsCmd(wrap))
        .command(appmodulesCmd(wrap))
        .command(listcontrolsCmd(wrap))
        .command(viewsCmd(wrap))
        .command(privilegesCmd(wrap))
        .command(uxscriptsCmd(wrap))
        .command(aliasesCmd(wrap))
        .command(catalogscriptsCmd(wrap))
        .command(cataloguipoliciesCmd(wrap))
        .command(logsCmd(wrap))
        .command(evalCmd(wrap))
        .command(restCmd(wrap));
    },
    handler: (argv) => {
      if (argv._[1]) return; // a subcommand ran — its own handler handled it
      console.log('Manage ServiceNow development artifacts.');
      console.log('');
      console.log('Most dev commands are also available at the top level:');
      console.log('  flows, actions, rules, clientscripts, uiactions, uipolicies,');
      console.log('  tables, columns, forms, lists, import, sppages, spwidgets,');
      console.log('  uipages, appmenu, scrapi, acls, roles, properties,');
      console.log('  relationships, appmodules, listcontrols, views, privileges,');
      console.log('  uxscripts, aliases, catalogscripts, cataloguipolicies, logs,');
      console.log('  updatesets, scopes, eval, rest');
      console.log('');
      console.log('Run "jsn dev <command> --help" or "jsn <command> --help" for details.');
    },
  };
}
