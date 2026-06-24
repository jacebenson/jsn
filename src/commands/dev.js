// Parent dev command

import {
  actionsCmd, includesCmd, rulesCmd,
  clientScriptsCmd, uiActionsCmd, uiPoliciesCmd,
  tablesCmd, columnsCmd, importCmd,
  spPagesCmd, spWidgetsCmd, uiPagesCmd, appMenuCmd, scRAPICmd,
  aclsCmd, rolesCmd, propertiesCmd,
  relationshipsCmd, appmodulesCmd, listcontrolsCmd, viewsCmd,
  privilegesCmd, securitytypesCmd, uxscriptsCmd, aliasesCmd,
  catalogscriptsCmd, cataloguipoliciesCmd,
} from './dev/_simple.js';
import { flowsCmd } from './dev/flows.js';
import { formsCmd } from './dev/forms.js';
import { listsCmd } from './dev/lists.js';
import { updateSetsCmd } from './dev/updatesets.js';
import { scopesCmd } from './dev/scopes.js';
import { evalCmd } from './dev/eval.js';
import { restCmd } from './dev/rest.js';
import { logsCmd } from './dev/logs.js';

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
        .command(scRAPICmd(wrap))
        .command(aclsCmd(wrap))
        .command(rolesCmd(wrap))
        .command(updateSetsCmd(wrap))
        .command(scopesCmd(wrap))
        .command(propertiesCmd(wrap))
        .command(relationshipsCmd(wrap))
        .command(appmodulesCmd(wrap))
        .command(listcontrolsCmd(wrap))
        .command(viewsCmd(wrap))
        .command(privilegesCmd(wrap))
        .command(securitytypesCmd(wrap))
        .command(uxscriptsCmd(wrap))
        .command(aliasesCmd(wrap))
        .command(catalogscriptsCmd(wrap))
        .command(cataloguipoliciesCmd(wrap))
        .command(logsCmd(wrap))
        .command(evalCmd(wrap))
        .command(restCmd(wrap));
    },
    handler: () => {},
  };
}
