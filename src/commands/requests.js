import { getRecord, recordOptions } from '../records-engine.js';
import { unwrapSysId } from '../resolve-record.js';
import { buildTicketCommands } from './_ticket.js';

const requestDefaultColumns = ['number', 'short_description', 'stage', 'assigned_to'];

export function requestsCmd(wrap) {
  // Get the base command definition from the shared ticket builder
  const baseCmd = buildTicketCommands('sc_req_item', 'requests', 'req', requestDefaultColumns, {}, null, wrap);

  // Override the builder to inject our enriched show handler.
  // yargs allows re-registration — the last .command() call wins the slot.
  const originalBuilder = baseCmd.builder;
  baseCmd.builder = (yargs) => {
    const y = originalBuilder(yargs);
    return y.command({
      command: 'show <number>',
      aliases: ['get'],
      describe: 'Show a specific request with attachments and catalog variables',
      builder: y => recordOptions(y),
      handler: wrap(enrichedShowHandler),
    });
  };

  return baseCmd;
}

async function enrichedShowHandler(argv, app) {
  const number = argv.number;
  const record = await getRecord(app.sdk, { table: 'sc_req_item', identifier: number, matchField: 'number', identifierField: argv.identifierField, displayValues: argv.displayValues, resource: 'Request' });
  const sysID = unwrapSysId(record);

  // Fetch attachments and catalog variables in parallel
  const [attachments, variables] = await Promise.all([
    app.sdk.fetchAttachments('sc_req_item', sysID).catch(() => []),
    app.sdk.fetchCatalogVariables(sysID).catch(() => []),
  ]);

  record._attachments = attachments;
  record._variables = variables;
  record._context = {
    instance_url: app.getEffectiveInstance(),
    table: 'sc_req_item',
  };

  app.ok(record, {
    summary: `Request ${number}`,
    breadcrumbs: [
      { action: 'update', cmd: `jsn req update ${number} -f state=2`, description: 'Update this request' },
      { action: 'list', cmd: `jsn req list`, description: 'Back to all requests' },
    ],
  });
}
