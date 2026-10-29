import { parseDataArg, confirmDelete, quoteShellArg } from '../helpers.js';
import { errAPI, errUsage } from '../errors.js';

const ID = /^[a-f0-9]{32}$/i;
const API = '/api/sn_sc/servicecatalog/items';
const object = v => v && typeof v === 'object' && !Array.isArray(v);

function emit(app, argv, data, summary, breadcrumbs = []) {
  const connection = argv.profile ? ` --profile ${quoteShellArg(argv.profile)}` : argv.instance ? ` --instance ${quoteShellArg(argv.instance)}` : '';
  app.ok(data, { summary, breadcrumbs: breadcrumbs.map(h => ({ ...h, cmd: h.cmd + connection })) });
}
function requireId(id) { if (!ID.test(id || '')) throw errUsage('Use the full catalog item sys_id; find it with catalogitems search.'); }
async function describe(app, id) {
  requireId(id);
  const response = await app.sdk.request(`${app.sdk.baseURL}${API}/${id}`, { method: 'GET' });
  if (!object(response?.result) || response.result.sys_id !== id) throw errAPI(200, 'Catalog API returned no readable item with the requested identity.');
  return response.result;
}
function itemHints(id) {
  return [{ action: 'describe', cmd: `jsn catalogitems describe ${id}`, description: 'Inspect catalog inputs and pricing' },
    { action: 'preview', cmd: `jsn catalogitems order ${id} --dry-run --variables-file variables.json`, description: 'Preview an order without submitting' }];
}

export function catalogOrderCommands(wrap) {
  return [
    { command: 'search <text>', describe: 'Find requestable items through the Service Catalog API',
      builder: y => y.positional('text', { type: 'string' }).option('limit', { type: 'number', default: 20, describe: 'Maximum items (1–100)' }),
      handler: wrap(async (argv, app) => {
        if (typeof argv.text !== 'string' || !argv.text.trim()) throw errUsage('Provide nonempty catalog search text.');
        if (!Number.isInteger(argv.limit) || argv.limit < 1 || argv.limit > 100) throw errUsage('--limit must be from 1 to 100.');
        const params = new URLSearchParams({ sysparm_text: argv.text.trim(), sysparm_limit: String(argv.limit) });
        const response = await app.sdk.request(`${app.sdk.baseURL}${API}?${params}`, { method: 'GET' });
        if (!Array.isArray(response?.result) || response.result.some(i => !object(i) || !ID.test(i.sys_id || ''))) throw errAPI(200, 'Catalog API returned no valid item list.');
        emit(app, argv, { items: response.result, count: response.result.length, limit: argv.limit,
          possibly_truncated: response.result.length === argv.limit }, `${response.result.length} catalog item(s)`,
        response.result.flatMap(i => itemHints(i.sys_id).slice(0, 1)));
      }) },
    { command: 'describe <id>', aliases: ['inputs'], describe: 'Read requestable item details, pricing and variable definitions',
      builder: y => y.positional('id', { type: 'string' }),
      handler: wrap(async (argv, app) => {
        const item = await describe(app, argv.id);
        emit(app, argv, item, item.name || item.short_description || argv.id, itemHints(argv.id));
      }) },
    { command: 'order <id>', describe: 'Submit a catalog order with explicit confirmation',
      builder: y => y.positional('id', { type: 'string' })
        .option('variables', { type: 'string', describe: 'JSON object of catalog variable names/values' })
        .option('variables-file', { type: 'string', describe: 'Read the variables object from a JSON file' })
        .option('quantity', { type: 'number', default: 1, describe: 'Positive integer quantity (max 1000)' })
        .option('requested-for', { type: 'string', describe: 'User sys_id; instance delegation rules still apply' })
        .option('dry-run', { type: 'boolean', default: false, describe: 'Read item details and preview variable names; no order is submitted' })
        .epilogue('Use describe to inspect variables first. Server-side rules validate the order; a preview does not prove submission will succeed. Existing create/list/show commands manage definitions. Orders require a write-enabled profile, including dry runs. No application/update-set selection is needed.'),
      handler: wrap(async (argv, app) => {
        requireId(argv.id);
        if (!Number.isInteger(argv.quantity) || argv.quantity < 1 || argv.quantity > 1000) throw errUsage('--quantity must be an integer from 1 to 1000.');
        const requestedFor = argv.requestedFor ?? argv['requested-for'];
        if (requestedFor !== undefined && !ID.test(requestedFor)) throw errUsage('--requested-for requires a user sys_id.');
        const file = argv.variablesFile ?? argv['variables-file'];
        if (argv.variables !== undefined && file !== undefined) throw errUsage('Choose --variables or --variables-file, not both.');
        const variables = argv.variables !== undefined || file !== undefined
          ? parseDataArg({ data: argv.variables, 'data-file': file }) : {};
        if (!object(variables)) throw errUsage('Catalog variables must be a JSON object.');
        const item = await describe(app, argv.id);
        if (item.sys_class_name && item.sys_class_name !== 'sc_cat_item') throw errUsage('order supports standard catalog items; record producers and order guides need their own submission workflows.');
        if (item.active === false || item.active === 'false' || item.can_order === false) throw errUsage('This item is not currently orderable.');
        const plan = { item_id: argv.id, name: item.name || item.short_description, quantity: argv.quantity,
          requested_for: requestedFor || null, variable_names: Object.keys(variables) };
        if (argv.dryRun ?? argv['dry-run']) return emit(app, argv, { ...plan, submitted: false, server_validation: 'not performed' }, 'Catalog order preview; nothing submitted', itemHints(argv.id));
        const rerun = ['catalogitems', 'order', argv.id, '--quantity', String(argv.quantity),
          ...(requestedFor ? ['--requested-for', requestedFor] : []),
          ...(file ? ['--variables-file', file] : Object.keys(variables).length ? ['--variables-file', '<variables.json>'] : [])];
        try {
          await confirmDelete(app, argv, `Order ${argv.quantity} × ${plan.name || argv.id}${requestedFor ? ` for ${requestedFor}` : ''}?`, { rerun });
        } catch (error) {
          if (error.message === 'Deletion cancelled') throw errUsage('Catalog order cancelled.');
          throw error;
        }
        const body = { sysparm_quantity: argv.quantity, variables, ...(requestedFor ? { sysparm_requested_for: requestedFor } : {}) };
        let response;
        try {
          response = await app.sdk.request(`${app.sdk.baseURL}${API}/${argv.id}/order_now`, { method: 'POST', body: JSON.stringify(body) });
        } catch (error) {
          if (error.status >= 400 && error.status < 500 && error.status !== 408) throw errAPI(error.status, 'Catalog order was rejected. Check item access, required variables and requested-for eligibility.');
          throw errAPI(error.status || 0, 'Catalog submission did not return a confirmed order. Inspect your requests before retrying; the order may have been placed.');
        }
        const result = response?.result;
        const requestId = result?.request_id || result?.sys_id, number = result?.request_number || result?.number;
        if (!object(result) || result.error || !ID.test(requestId || '') || typeof number !== 'string' || !number.trim()) throw errAPI(200, 'Catalog response did not confirm an order identity. Inspect your requests before retrying; do not resubmit automatically.');
        emit(app, argv, { item_id: argv.id, quantity: argv.quantity, request_id: requestId, request_number: number, submitted: true },
          `Ordered: ${number}`, [{ action: 'request', cmd: `jsn records get --table sc_request --sys-id ${requestId}`, description: 'Read the request header' },
            { action: 'items', cmd: `jsn requests list --query ${quoteShellArg(`request=${requestId}`)}`, description: 'Track the requested items' }]);
      }) },
  ];
}
