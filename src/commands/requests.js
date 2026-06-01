import { buildTicketCommands } from './_ticket.js';
import { getStringField } from '../helpers.js';

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
      handler: wrap(enrichedShowHandler),
    });
  };

  return baseCmd;
}

async function enrichedShowHandler(argv, app) {
  const number = argv.number;
  const params = new URLSearchParams();
  params.set('sysparm_query', `number=${number}`);
  params.set('sysparm_display_value', 'all');
  params.set('sysparm_limit', '1');
  const records = await app.sdk.list('sc_req_item', params);
  if (records.length === 0) {
    throw new Error(`Request not found: ${number}`);
  }
  const record = records[0];
  const sysID = getStringField(record, 'sys_id');

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
      { action: 'update', cmd: `jsn req update ${number} --data '{...}'`, description: 'Update this request' },
      { action: 'list', cmd: `jsn req list`, description: 'Back to all requests' },
    ],
  });
}
