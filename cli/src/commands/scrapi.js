// Custom scraPI command: list/show individual operations + one-shot API definition creation
//
// The 'create' subcommand lets you build a full Scripted REST API in one call:
//   jsn scrapi create \
//     --name "SL Managed Services" --service-id managed_services --namespace slapi \
//     --resource create=POST:/create:./create.js \
//     --resource comment=POST:/comment:./comment.js

import fs from 'node:fs';
import path from 'node:path';
import { formatRecordForDisplay, getStringField, isHexString } from '../helpers.js';
import { errUsage, errUsageHint } from '../errors.js';
import { declareCapabilities } from '../capabilities.js';
import { levenshtein } from '../query-parse.js';

// `scrapi create` builds a full Scripted REST API in one call (list/show/search/spec are
// reads). Registered at the root.
declareCapabilities('scrapi', { queryTable: 'sys_ws_operation', transactionScopeOption: 'scope', mutationSubcommands: ['create'] });

// The REST API Explorer catalogue: doc/services answers {result: {namespace: {title: api}}} for the
// whole instance, or one namespace with ?namespace=, and an unknown namespace with 200 {"result":{}}.
const DOC = 'api/now/doc';
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const lower = v => typeof v === 'string' ? v.toLowerCase() : '';
const malformed = message => Object.assign(new Error(message), { code: 'malformed_response' });
const text = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) throw errUsage(`${label} must not be empty.`);
  return value.trim();
};
const catalogueApis = catalogue => Object.entries(catalogue).flatMap(([namespace, apis]) =>
  Object.entries(isObject(apis) ? apis : {}).map(([name, api]) => ({ namespace, name, api: isObject(api) ? api : {} })));

async function readCatalogue(app, namespace) {
  const base = app.getEffectiveInstance();
  const body = await app.sdk.request(`${base}/${DOC}/services${namespace ? `?${new URLSearchParams({ namespace })}` : ''}`, { method: 'GET', readOnly: true });
  if (!isObject(body?.result)) throw malformed('Malformed REST API catalogue response: expected a JSON envelope with a result object');
  if (Object.keys(body.result).length) return body.result;
  if (!namespace) throw new Error('The REST API catalogue came back empty; this user may not have access to the REST API Explorer.');
  const names = await app.sdk.request(`${base}/${DOC}/namespaces`, { method: 'GET', readOnly: true });
  const known = Array.isArray(names?.result) ? names.result.filter(n => typeof n === 'string') : [];
  if (known.includes(namespace)) throw errUsage(`Namespace "${namespace}" exists but publishes no REST APIs on this instance.`);
  const wanted = namespace.toLowerCase();
  const [nearest] = known.map(n => [n, (n.toLowerCase().includes(wanted) ? 0 : 1000) + levenshtein(wanted, n.toLowerCase())]).sort((a, b) => a[1] - b[1]);
  throw errUsageHint(`No REST API namespace "${namespace}" on this instance.`, nearest ? `Did you mean --namespace ${nearest[0]}?` : 'Search without --namespace to see every namespace.');
}

function searchRows(catalogue, term, method) {
  const wanted = term.toLowerCase();
  const has = v => lower(v).includes(wanted);
  const rows = [];
  for (const { namespace, name, api } of catalogueApis(catalogue)) {
    // A hit on the API itself matches every endpoint it serves. Every route and apiName
    // starts with its namespace, so the namespace needs no match of its own.
    const apiHit = has(name) || has(api.apiName) || has(api.description);
    for (const [version, entry] of Object.entries(isObject(api.versions) ? api.versions : {})) {
      for (const r of Array.isArray(entry?.resources) ? entry.resources : []) {
        if (!isObject(r) || typeof r.route !== 'string' || typeof r.httpMethod !== 'string') throw malformed(`Malformed REST API catalogue entry: ${namespace}/${name} ${version}`);
        if (method && r.httpMethod.toUpperCase() !== method) continue;
        if (apiHit || has(r.route) || has(r.description)) rows.push({ namespace, api: name, version, method: r.httpMethod, route: `/api${r.route}`, description: typeof r.description === 'string' ? r.description : '' });
      }
    }
  }
  return rows;
}

/**
 * Parse a --resource flag value of the form:
 *   name=METHOD:/path:./script.js
 * Returns { name, method, relativePath, scriptFile } or null.
 */
function parseResourceArg(raw) {
  if (!raw || typeof raw !== 'string') return null;

  // Split on first '=' to get name and the rest
  const eqIdx = raw.indexOf('=');
  if (eqIdx === -1) return null;
  const name = raw.slice(0, eqIdx).trim();
  const rest = raw.slice(eqIdx + 1).trim();

  // Rest should be METHOD:/path:./script.js
  // Split on first ':' to separate METHOD from the path:file part
  const colonIdx = rest.indexOf(':');
  if (colonIdx === -1) return null;
  const method = rest.slice(0, colonIdx).trim().toUpperCase();
  const pathFile = rest.slice(colonIdx + 1).trim();

  // Split pathAndFile on last ':' to separate relative_path from script file
  const lastColon = pathFile.lastIndexOf(':');
  if (lastColon === -1) return null;
  const relativePath = pathFile.slice(0, lastColon).trim();
  const scriptFile = pathFile.slice(lastColon + 1).trim();

  if (!relativePath.startsWith('/')) {
    return null; // relative_path must start with /
  }

  return { name, method, relativePath, scriptFile };
}

/**
 * Read script content from a file path (relative to cwd or absolute).
 */
function readScriptFile(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw errUsageHint(
      `Script file not found: ${filePath}`,
      `Checked: ${resolved}`
    );
  }
  return fs.readFileSync(resolved, 'utf-8');
}

export function scrapiCmd(wrap) {
  return {
    command: 'scrapi [subcommand]',
    aliases: ['scripted-rest', 'rest-api'],
    describe: 'Manage Scripted REST APIs (list/show operations, create full APIs with resources)',
    builder: (yargs) => {
      return yargs
        // ── list ──
        .command({
          command: 'list',
          aliases: ['ls'],
          describe: 'List API operations',
          builder: (y) => y
            .option('query', { type: 'string', describe: 'Encoded query (e.g. "nameLIKEincident")' })
            .option('columns', { alias: ['c', 'fields'], type: 'string', describe: 'Comma-separated columns' })
            .option('limit', { alias: 'l', type: 'number', default: 50, describe: 'Max records' }),
          handler: wrap(async (argv, app) => {
            const columns = argv.columns ? argv.columns.split(',') : ['name', 'sys_ws_definition', 'http_method', 'relative_path', 'sys_scope'];
            const query = argv.query || '';
            const limit = argv.limit;

            const params = new URLSearchParams();
            params.set('sysparm_limit', String(limit));
            params.set('sysparm_display_value', 'all');
            params.set('sysparm_fields', ['sys_id', ...columns].join(','));
            const q = query ? query + '^ORDERBYDESCsys_updated_on' : 'ORDERBYDESCsys_updated_on';
            params.set('sysparm_query', q);
            const records = await app.sdk.list('sys_ws_operation', params);

            app.ok({
              table: 'sys_ws_operation',
              count: records.length,
              columns,
              records: records.map(r => formatRecordForDisplay(r, columns)),
              context: { instance_url: app.getEffectiveInstance() },
            }, {
              summary: `${records.length} operation(s)`,
              breadcrumbs: [
                { action: 'create', cmd: 'jsn scrapi create --name "My API" --service-id my-api --namespace myapp --resource get=GET:/items:./script.js', description: 'Create a new REST API' },
                { action: 'show', cmd: 'jsn scrapi show <name>', description: 'Show operation details' },
              ],
            });
          }),
        })
        // ── show ──
        .command({
          command: 'show <identifier>',
          aliases: ['get'],
          describe: 'Show an API definition or operation by service_id, name, or sys_id — includes child resources',
          handler: wrap(async (argv, app) => {
            const id = argv.identifier;
            const isSysId = isHexString(id) && id.length === 32;

            // 1. Try to find a sys_ws_operation by name or sys_id
            const opParams = new URLSearchParams();
            opParams.set('sysparm_query', `${isSysId ? 'sys_id' : 'name'}=${id}`);
            opParams.set('sysparm_limit', '1');
            opParams.set('sysparm_display_value', 'all');
            let records = await app.sdk.list('sys_ws_operation', opParams);

            if (records.length > 0) {
              // Found an operation — show it directly
              records[0]._context = {
                instance_url: app.getEffectiveInstance(),
                table: 'sys_ws_operation',
              };
              return app.ok(records[0], {
                summary: `Operation: ${getStringField(records[0], 'name') || id}`,
                breadcrumbs: [
                  { action: 'list', cmd: 'jsn scrapi list', description: 'Back to all operations' },
                ],
              });
            }

            // 2. Try to find a sys_ws_definition by service_id, name, or sys_id
            const defQuery = isSysId
              ? `sys_id=${id}`
              : `service_id=${id}^ORname=${id}`;
            const defParams = new URLSearchParams();
            defParams.set('sysparm_query', defQuery);
            defParams.set('sysparm_limit', '1');
            defParams.set('sysparm_display_value', 'all');
            const defRecords = await app.sdk.list('sys_ws_definition', defParams);

            if (defRecords.length === 0) {
              throw new Error(`No API or operation found matching: ${id}`);
            }

            const definition = defRecords[0];
            const defName = getStringField(definition, 'name');
            const defSysId = definition.sys_id?.value || definition.sys_id;

            // 3. Fetch child operations for this definition
            const childParams = new URLSearchParams();
            childParams.set('sysparm_query', `web_service_definition=${defSysId}`);
            childParams.set('sysparm_limit', '50');
            childParams.set('sysparm_display_value', 'all');
            childParams.set('sysparm_fields', 'sys_id,name,http_method,relative_path,active');
            const childOps = await app.sdk.list('sys_ws_operation', childParams);

            // Build a formatted display
            const instanceURL = app.getEffectiveInstance();
            const defLink = `${instanceURL}/sys_ws_definition.do?sys_id=${defSysId}`;

            let formatted = `\n${defName} (Scripted REST API)\n`;
            formatted += `${'─'.repeat(defName.length + 22)}\n\n`;
            formatted += `  service_id:     ${getStringField(definition, 'service_id')}\n`;
            formatted += `  namespace:      ${getStringField(definition, 'namespace')}\n`;
            formatted += `  scope:          ${getStringField(definition, 'sys_scope')}\n`;
            formatted += `  base_uri:       ${getStringField(definition, 'base_uri')}\n`;
            formatted += `  description:    ${(getStringField(definition, 'description') || '(none)').slice(0, 60)}\n`;
            formatted += `\n  Link: ${defLink}\n`;

            if (childOps.length > 0) {
              formatted += `\n  ── Resources (${childOps.length}) ──\n\n`;
              for (const op of childOps) {
                const opName = getStringField(op, 'name');
                const method = getStringField(op, 'http_method');
                const relPath = getStringField(op, 'relative_path');
                const active = getStringField(op, 'active');
                formatted += `    ${(method + '  ').slice(0, 7)} ${relPath.padEnd(30)} ${opName}${active !== 'true' ? ' (inactive)' : ''}\n`;
              }
            } else {
              formatted += `\n  (no resources — run jsn scrapi create --resource ... to add some)\n`;
            }

            app.ok({
              _formatted: formatted,
              definition: {
                sys_id: defSysId,
                name: defName,
                service_id: getStringField(definition, 'service_id'),
                namespace: getStringField(definition, 'namespace'),
                base_uri: getStringField(definition, 'base_uri'),
                scope: getStringField(definition, 'sys_scope'),
                description: getStringField(definition, 'description'),
                link: defLink,
              },
              resources: childOps.map(op => ({
                name: getStringField(op, 'name'),
                method: getStringField(op, 'http_method'),
                relative_path: getStringField(op, 'relative_path'),
                active: getStringField(op, 'active'),
              })),
              _context: { instance_url: instanceURL, table: 'sys_ws_definition' },
            }, {
              summary: `API: ${defName} — ${childOps.length} resource(s)`,
              breadcrumbs: [
                { action: 'create', cmd: 'jsn scrapi create --name "..." --service-id ... --namespace ... --resource ...', description: 'Create a new API' },
                { action: 'list', cmd: 'jsn scrapi list', description: 'Back to all operations' },
              ],
            });
          }),
        })
        // ── search (REST API Explorer catalogue) ──
        .command({
          command: 'search <term>',
          describe: 'Search every REST endpoint on the instance, out of the box and scripted, by namespace, API name, route or description',
          builder: (y) => y
            .positional('term', { type: 'string', describe: 'Case-insensitive text to find' })
            .option('namespace', { alias: 'n', type: 'string', describe: 'Only this namespace (e.g. now); reads just that namespace' })
            .option('method', { alias: 'm', type: 'string', describe: `Only endpoints with this HTTP method (${METHODS.join(', ')})` })
            .option('limit', { alias: 'l', type: 'number', default: 50, describe: 'Max endpoints to show' })
            .strict(),
          handler: wrap(async (argv, app) => {
            const term = text(argv.term, 'Search term');
            const namespace = argv.namespace === undefined ? undefined : text(argv.namespace, '--namespace');
            const method = argv.method === undefined ? undefined : String(argv.method).toUpperCase();
            if (method !== undefined && !METHODS.includes(method)) throw errUsage(`--method must be one of ${METHODS.join(', ')}.`);
            if (!Number.isSafeInteger(argv.limit) || argv.limit < 1) throw errUsage('--limit must be a positive integer.');
            app.requireInstance();
            const rows = searchRows(await readCatalogue(app, namespace), term, method);
            const records = rows.slice(0, argv.limit);
            const summary = `${records.length} of ${rows.length} REST endpoints matching "${term}"${rows.length > records.length ? '; raise --limit or narrow with --namespace or --method' : ''}`;
            const width = Math.min(60, Math.max(0, ...records.map(r => r.route.length)));
            const data = { term, namespace: namespace ?? null, method: method ?? null, total: rows.length, count: records.length, records };
            Object.defineProperty(data, '_formatted', { value: [summary, '', ...records.map(r => `${r.method.padEnd(7)}${r.route.padEnd(width)}  ${r.namespace} · ${r.api} · ${r.version}`)].join('\n') });
            const first = records[0];
            app.ok(data, {
              summary,
              breadcrumbs: first ? [
                { action: 'spec', cmd: `jsn scrapi spec "${first.api}" --namespace ${first.namespace}`, description: 'OpenAPI document for this API' },
                { action: 'call', cmd: `jsn rest ${first.route}`, description: 'Call the endpoint (fill in any {placeholders})' },
              ] : [],
            });
          }),
        })
        // ── spec (OpenAPI 3 export) ──
        .command({
          command: 'spec <api>',
          describe: "Print an API's OpenAPI 3 document, JSON by default; the name or a unique part of it",
          builder: (y) => y
            .positional('api', { type: 'string', describe: 'API name as search shows it (e.g. "Table API"), its apiName (now/table), or a unique part' })
            .option('namespace', { alias: 'n', type: 'string', describe: 'Namespace that owns the API, to pick between same-named APIs' })
            .option('yaml', { type: 'boolean', describe: 'Print the document as YAML' })
            .strict(),
          handler: wrap(async (argv, app) => {
            const wanted = text(argv.api, 'API name');
            const namespace = argv.namespace === undefined ? undefined : text(argv.namespace, '--namespace');
            app.requireInstance();
            const apis = catalogueApis(await readCatalogue(app, namespace));
            const name = wanted.toLowerCase();
            let hits = [];
            for (const match of [a => lower(a.name) === name, a => lower(a.api.apiName) === name, a => lower(a.name).includes(name) || lower(a.api.apiName).includes(name)]) {
              hits = apis.filter(match);
              if (hits.length) break;
            }
            if (!hits.length) throw errUsageHint(`No REST API matches "${wanted}"${namespace ? ` in namespace ${namespace}` : ''}.`, `Run: jsn scrapi search ${JSON.stringify(wanted)}`);
            // Not errAmbiguous: renderAppError drops its hint and its JSON envelope, which would hide the candidates.
            if (hits.length > 1) throw errUsageHint(`${hits.length} REST APIs match "${wanted}".`, `Did you mean one of: ${[...hits.slice(0, 10).map(h => `"${h.name}" --namespace ${h.namespace}`), ...(hits.length > 10 ? [`${hits.length - 10} more`] : [])].join(', ')}?`);
            const [{ namespace: ns, name: api }] = hits;
            const format = argv.yaml ? 'yaml' : 'json';
            // oas_3 answers Accept: application/json with 406; it serves the document as octet-stream.
            const body = await app.sdk.rawRequest(`${app.getEffectiveInstance()}/${DOC}/oas_3?${new URLSearchParams({ namespace: ns, name: api, format })}`, { method: 'GET', headers: { Accept: '*/*' } });
            let spec = body;
            if (format === 'json') { try { spec = JSON.parse(body); } catch { spec = null; } }
            if (typeof body !== 'string' || (format === 'json' ? typeof spec?.openapi !== 'string' : !/^openapi:/m.test(body))) throw malformed(`The instance did not return an OpenAPI document for ${ns}/${api}.`);
            if (argv.format === 'json') return app.ok({ namespace: ns, api, format, spec }, { summary: `OpenAPI document for ${ns}/${api}` });
            // The document itself, as updatesets export does, so it pipes to a file.
            app.output.writer.write(body.endsWith('\n') ? body : `${body}\n`);
          }),
        })
        // ── create (one-shot API + operations) ──
        .command({
          command: 'create',
          describe: 'Create a new Scripted REST API with operations in one command',
          builder: (y) => y
            .option('name', { type: 'string', demandOption: true, describe: 'API name (e.g. "SL Managed Services")' })
            .option('service-id', { type: 'string', demandOption: true, describe: 'Service ID (e.g. "managed_services")' })
            .option('namespace', { type: 'string', demandOption: true, describe: 'API namespace (e.g. "slapi")' })
            .option('resource', {
              type: 'string',
              array: true,
              demandOption: true,
              describe: 'Resource definition: name=METHOD:/path:./script.js (can be repeated)',
            })
            .option('description', { type: 'string', describe: 'API description' })
            .option('scope', { type: 'string', describe: 'Scope name or sys_id (default: current scope)' }),
          handler: wrap(async (argv, app) => {
            if (!app.sdk) throw new Error('Not connected to a ServiceNow instance');

            // 1. Parse and validate all resources first
            const resources = [];
            for (const raw of argv.resource) {
              const parsed = parseResourceArg(raw);
              if (!parsed) {
                throw errUsageHint(
                  `Invalid --resource format: ${raw}`,
                  'Expected: name=METHOD:/path:./script.js  e.g. create=POST:/create:./create.js'
                );
              }
              const script = readScriptFile(parsed.scriptFile);
              resources.push({ ...parsed, script });
            }

            const apiName = argv.name;
            const serviceId = argv['service-id'];
            const namespace = argv.namespace;
            const description = argv.description || '';

            // 2. Resolve scope if provided
            let scopeSysId = app.mutationContext?.application_id || null;
            if (argv.scope) {
              scopeSysId = await app.sdk.resolveScope(argv.scope);
              if (!scopeSysId) {
                throw new Error(`Scope not found: ${argv.scope}`);
              }
            }

            // 3. Create the API definition (sys_ws_definition)
            const definitionData = {
              name: apiName,
              service_id: serviceId,
              namespace,
              description,
            };
            if (scopeSysId) {
              definitionData.sys_scope = scopeSysId;
            }

            const definition = await app.sdk.create('sys_ws_definition', definitionData);
            const defSysId = definition?.sys_id?.value || definition?.sys_id;
            if (!defSysId) {
              throw new Error('API definition creation returned no sys_id — check for validation errors');
            }

            // 4. Create each operation (sys_ws_operation)
            const operations = [];
            for (const res of resources) {
              const opData = {
                name: res.name,
                http_method: res.method,
                relative_path: res.relativePath,
                operation_script: res.script,
                web_service_definition: defSysId,
              };
              // Set the scope so the operation inherits the API's scope
              if (scopeSysId) {
                opData.sys_scope = scopeSysId;
              }
              const operation = await app.sdk.create('sys_ws_operation', opData);
              operations.push(operation?.result || operation);
            }

            // 5. Report
            const instanceURL = app.getEffectiveInstance();
            const apiURL = `${instanceURL}/sys_ws_definition.do?sys_id=${defSysId}`;

            app.ok({
              api_definition: {
                sys_id: defSysId,
                name: apiName,
                service_id: serviceId,
                namespace,
                link: apiURL,
              },
              operations: operations.map((op, i) => ({
                name: resources[i].name,
                method: resources[i].method,
                relative_path: resources[i].relativePath,
              })),
            }, {
              summary: `Created API "${apiName}" with ${operations.length} operation(s)`,
              notice: `View API: ${apiURL}`,
              breadcrumbs: [
                { action: 'show', cmd: `jsn scrapi list --query "web_service_definition=${defSysId}"`, description: 'List operations for this API' },
                { action: 'add', cmd: `jsn scrapi add-resource --api "${serviceId}" --name <name>=METHOD:/path:./script.js`, description: 'Add another resource' },
              ],
            });
          }),
        });
    },
    // Default handler when no subcommand matches
    handler: () => {
      console.log('Manage Scripted REST APIs.');
      console.log('');
      console.log('Available subcommands:');
      console.log('  list        List API operations');
      console.log('  show        Show an operation by name or sys_id');
      console.log('  create      Create a new API with operations (one-shot)');
      console.log('  search      Search every REST endpoint on the instance');
      console.log('  spec        Print an API\'s OpenAPI 3 document');
      console.log('');
      console.log('Examples:');
      console.log('  jsn scrapi search attachment --method POST');
      console.log('  jsn scrapi spec "Table API" --yaml');
      console.log('  jsn scrapi list');
      console.log('  jsn scrapi show my_operation');
      console.log('  jsn scrapi create \\');
      console.log('    --name "My API" --service-id my-api --namespace myapp \\');
      console.log('    --resource "create=POST:/create:./create.js" \\');
      console.log('    --resource "list=GET:/list:./list.js"');
    },
  };
}
