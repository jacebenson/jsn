import { parseDataArg, confirmDelete, quoteShellArg } from '../helpers.js';
import { errAPI, errUsage } from '../errors.js';
import { CATALOG_API, readCatalogApiItem, shapeVariables } from './catalog/enrich.js';

const ID = /^[a-f0-9]{32}$/i;
const API = CATALOG_API;
const RITM = '/api/now/table/sc_req_item';
const MAX_REQUESTED_ITEMS = 10;
const object = v => v && typeof v === 'object' && !Array.isArray(v);

function emit(app, argv, data, summary, breadcrumbs = []) {
  const connection = argv.profile ? ` --profile ${quoteShellArg(argv.profile)}` : argv.instance ? ` --instance ${quoteShellArg(argv.instance)}` : '';
  app.ok(data, { summary, breadcrumbs: breadcrumbs.map(h => ({ ...h, cmd: h.cmd + connection })) });
}
function requireId(id) { if (!ID.test(id || '')) throw errUsage('Use the full catalog item sys_id; find it with catalogitems search.'); }

/**
 * Item definition plus flattened question definitions.
 *
 * This is the request side of the catalog, not a second view command: the
 * questions and the order come from the same payload, so `order` can never
 * disagree with what `catalogitems show` printed. Items the catalog API cannot
 * serve (record producers whose server scripts throw, non-catalog records)
 * fail here rather than submitting against guessed definitions.
 */
async function inspect(app, id) {
  const item = await readCatalogApiItem(app.sdk, id);
  const variables = shapeVariables(item.variables);
  return { item, variables, variablesReported: Array.isArray(item.variables) };
}

function isAnswered(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * Compare supplied variables against the item's own question definitions.
 * The server remains the authority; this only refuses an obviously incomplete
 * submission before a confirmation prompt or a POST.
 */
function reviewVariables(variables, supplied) {
  const required = variables.filter(v => v.mandatory && !v.instance_supplied);
  return {
    requiredVariables: required.map(v => v.name),
    missing: required.filter(v => !isAnswered(supplied[v.name])).map(v => v.name),
    unknown: variables.length ? Object.keys(supplied).filter(name => !variables.some(v => v.name === name)) : [],
  };
}

function itemHints(id) {
  return [{ action: 'show', cmd: `jsn catalogitems show ${id}`, description: 'Read the item, its questions and required answers' },
    { action: 'preview', cmd: `jsn catalogitems order ${id} --dry-run --variables-file variables.json`, description: 'Preview an order without submitting' }];
}

/**
 * Read the requested item(s) a submitted order produced. Failure here is
 * reported, never retried, and never turns a placed order into an error.
 */
async function findRequestedItems(app, requestId) {
  const params = new URLSearchParams({ sysparm_query: `request=${requestId}`, sysparm_fields: 'sys_id,number,cat_item', sysparm_limit: String(MAX_REQUESTED_ITEMS) });
  try {
    const response = await app.sdk.request(`${app.sdk.baseURL}${RITM}?${params}`, { method: 'GET' });
    if (!Array.isArray(response?.result)) return { items: [], readable: false, error: 'unsupported response' };
    return {
      items: response.result.filter(r => object(r) && ID.test(r.sys_id || ''))
        .map(r => ({ sys_id: r.sys_id, number: typeof r.number === 'string' ? r.number : null })),
      readable: true,
    };
  } catch (error) {
    return { items: [], readable: false, error: error?.status ? `HTTP ${error.status}` : 'read failed' };
  }
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
    { command: 'order <id>', describe: 'Submit a catalog order with explicit confirmation',
      builder: y => y.positional('id', { type: 'string' })
        .option('variables', { type: 'string', describe: 'JSON object of catalog variable names/values' })
        .option('variables-file', { type: 'string', describe: 'Read the variables object from a JSON file' })
        .option('quantity', { type: 'number', default: 1, describe: 'Positive integer quantity (max 1000)' })
        .option('requested-for', { type: 'string', describe: 'User sys_id; instance delegation rules still apply' })
        .option('dry-run', { type: 'boolean', default: false, describe: 'Read item details and preview variables; no order is submitted' })
        .epilogue('Use describe to inspect variables and their types first. Requested for is supplied by the instance unless you pass --requested-for, so it is reported separately and never blocks an order. A preview only reads; submitting needs a write-enabled profile and an explicit confirmation (or --force). Server-side rules still validate the order, so a preview does not prove submission will succeed. Existing create/list/show commands manage definitions. Orders need no application/update-set selection.'),
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

        const { item, variables: definitions, variablesReported } = await inspect(app, argv.id);
        if (item.sys_class_name && item.sys_class_name !== 'sc_cat_item') throw errUsage('order supports standard catalog items; record producers and order guides need their own submission workflows.');
        if (item.active === false || item.active === 'false' || item.can_order === false) throw errUsage('This item is not currently orderable.');

        // Only refuse on local evidence: an unreadable variable list is not
        // proof that an item has no mandatory inputs.
        const review = variablesReported ? reviewVariables(definitions, variables) : null;
        if (review?.missing.length) {
          throw errUsage(`Missing required catalog variable(s): ${review.missing.join(', ')}. Inspect them with: jsn catalogitems describe ${argv.id}`);
        }

        const plan = {
          item_id: argv.id, name: item.name || item.short_description, quantity: argv.quantity,
          requested_for: requestedFor || null, variable_names: Object.keys(variables),
          required_variables: review ? review.requiredVariables : [],
          ...(review?.unknown.length ? { unknown_variable_names: review.unknown } : {}),
        };
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
        if (!object(result) || result.error || result.errMsg) throw errAPI(200, 'Catalog response did not confirm an order identity. Inspect your requests before retrying; do not resubmit automatically.');
        // order_now answers with the request header (REQ); the requested item
        // (RITM) identity is only knowable by reading the request's items.
        const requestId = result.request_id || (result.table === 'sc_request' ? result.sys_id : undefined);
        const requestNumber = result.request_number || (result.table === 'sc_request' ? result.number : undefined);
        if (!ID.test(requestId || '') || typeof requestNumber !== 'string' || !requestNumber.trim()) throw errAPI(200, 'Catalog response did not confirm an order identity. Inspect your requests before retrying; do not resubmit automatically.');

        const requested = await findRequestedItems(app, requestId);
        emit(app, argv, {
          item_id: argv.id, quantity: argv.quantity, request_id: requestId, request_number: requestNumber,
          requested_items: requested.items,
          requested_items_readable: requested.readable,
          ...(requested.error ? { requested_items_error: requested.error } : {}),
          ...(review?.unknown.length ? { unknown_variable_names: review.unknown } : {}),
          submitted: true,
        }, `Ordered: ${requestNumber}`, [
          { action: 'request', cmd: `jsn records get --table sc_request --sys-id ${requestId}`, description: 'Read the request header' },
          ...requested.items.filter(i => i.number).map(i => ({ action: 'item', cmd: `jsn requests show ${i.number}`, description: 'Read the requested item' })),
          { action: 'items', cmd: `jsn requests list --query ${quoteShellArg(`request=${requestId}`)}`, description: 'Track the request\'s items' },
        ]);
      }) },
  ];
}
