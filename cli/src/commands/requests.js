import { enrichRelatedLists, relatedListOptions } from '../related-lists.js';
import { getRecord, recordOptions } from '../records-engine.js';
import { unwrapSysId } from '../resolve-record.js';
import { buildProfileCommand } from '../record-profiles.js';

const VARIABLE_LIMIT = 100;
const MULTI_ROW_LIMIT = 500;

export function requestsCmd(wrap) {
  // Get the base command definition from the shared ticket builder
  const baseCmd = buildProfileCommand('requests', wrap);

  // Override the builder to inject our enriched show handler.
  // yargs allows re-registration — the last .command() call wins the slot.
  const originalBuilder = baseCmd.builder;
  baseCmd.builder = (yargs) => {
    const y = originalBuilder(yargs);
    return y.command({
      command: 'show <number>',
      aliases: ['get'],
      describe: 'Show a specific request with attachments and catalog variables',
      builder: y => relatedListOptions(recordOptions(y)),
      handler: wrap(enrichedShowHandler),
    });
  };

  return baseCmd;
}

async function enrichedShowHandler(argv, app) {
  const number = argv.number;
  const record = await getRecord(app.sdk, { table: 'sc_req_item', identifier: number, matchField: 'number', identifierField: argv.identifierField, displayValues: argv.displayValues, resource: 'Request' });
  const sysID = unwrapSysId(record);

  // Fetch attachments, catalog variables and multi-row variable sets in parallel
  const warnings = [];
  const [attachments, variables, variableSets] = await Promise.all([
    app.sdk.fetchAttachments('sc_req_item', sysID).catch(() => []),
    app.sdk.fetchCatalogVariables(sysID, VARIABLE_LIMIT).then(result => {
      if (result.truncated) warnings.push(`Showing the first ${VARIABLE_LIMIT} catalog variables; more exist. List the rest: jsn records list --table sc_item_option_mtom --query "request_item=${sysID}^ORDERBYsc_item_option.order" --fields sc_item_option.item_option_new,sc_item_option.value --offset ${VARIABLE_LIMIT} --limit 1000 --json`);
      return result.variables;
    }, error => {
      warnings.push(`Catalog variables were not read: ${error.message}`);
      return null;
    }),
    app.sdk.fetchMultiRowVariables(sysID, MULTI_ROW_LIMIT).then(result => {
      if (result.truncated) warnings.push(`Showing the first ${MULTI_ROW_LIMIT} multi-row variable answers; more exist. List the rest: jsn records list --table sc_multi_row_question_answer --query "parent_id=${sysID}^ORDERBYvariable_set^ORDERBYrow_index^ORDERBYitem_option_new.order" --fields variable_set,row_index,item_option_new,value --offset ${MULTI_ROW_LIMIT} --limit 1000 --json`);
      return result.sets;
    }, error => {
      warnings.push(`Multi-row variable sets were not read: ${error.message}`);
      return null;
    }),
  ]);

  record._attachments = attachments;
  record._variables = variables;
  record._variable_sets = variableSets;
  record._context = {
    instance_url: app.getEffectiveInstance(),
    table: 'sc_req_item',
  };

  await enrichRelatedLists(record, { table: 'sc_req_item', argv, app });
  app.ok(record, {
    summary: `Request ${number}`,
    breadcrumbs: [
      { action: 'update', cmd: `jsn req update ${number} -f state=2`, description: 'Update this request' },
      { action: 'list', cmd: `jsn req list`, description: 'Back to all requests' },
    ],
    ...(warnings.length ? { meta: { warnings } } : {}),
  });
}
