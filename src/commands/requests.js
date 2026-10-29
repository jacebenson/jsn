import { enrichRelatedLists, relatedListOptions } from '../related-lists.js';
import { getRecord, recordOptions } from '../records-engine.js';
import { unwrapSysId } from '../resolve-record.js';
import { buildProfileCommand } from '../record-profiles.js';


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

  await enrichRelatedLists(record, { table: 'sc_req_item', argv, app });
  app.ok(record, {
    summary: `Request ${number}`,
    breadcrumbs: [
      { action: 'update', cmd: `jsn req update ${number} -f state=2`, description: 'Update this request' },
      { action: 'list', cmd: `jsn req list`, description: 'Back to all requests' },
    ],
  });
}
