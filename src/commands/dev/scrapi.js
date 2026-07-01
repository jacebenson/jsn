// Custom scraPI command: list/show individual operations + one-shot API definition creation
//
// The 'create' subcommand lets you build a full Scripted REST API in one call:
//   jsn dev scrapi create \
//     --name "SL Managed Services" --service-id managed_services --namespace slapi \
//     --resource create=POST:/create:./create.js \
//     --resource comment=POST:/comment:./comment.js

import fs from 'node:fs';
import path from 'node:path';
import { formatRecordForDisplay, getStringField, isHexString } from '../../helpers.js';
import { errUsageHint } from '../../errors.js';

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
            .option('limit', { alias: 'l', type: 'number', default: 20, describe: 'Max records' }),
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
                { action: 'create', cmd: 'jsn dev scrapi create --name "My API" --service-id my-api --namespace myapp --resource get=GET:/items:./script.js', description: 'Create a new REST API' },
                { action: 'show', cmd: 'jsn dev scrapi show <name>', description: 'Show operation details' },
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
                  { action: 'list', cmd: 'jsn dev scrapi list', description: 'Back to all operations' },
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
              formatted += `\n  (no resources — run jsn dev scrapi create --resource ... to add some)\n`;
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
                { action: 'create', cmd: 'jsn dev scrapi create --name "..." --service-id ... --namespace ... --resource ...', description: 'Create a new API' },
                { action: 'list', cmd: 'jsn dev scrapi list', description: 'Back to all operations' },
              ],
            });
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
            let scopeSysId = null;
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
                { action: 'show', cmd: `jsn dev scrapi list --query "web_service_definition=${defSysId}"`, description: 'List operations for this API' },
                { action: 'add', cmd: `jsn dev scrapi add-resource --api "${serviceId}" --name <name>=METHOD:/path:./script.js`, description: 'Add another resource' },
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
      console.log('');
      console.log('Examples:');
      console.log('  jsn dev scrapi list');
      console.log('  jsn dev scrapi show my_operation');
      console.log('  jsn dev scrapi create \\');
      console.log('    --name "My API" --service-id my-api --namespace myapp \\');
      console.log('    --resource "create=POST:/create:./create.js" \\');
      console.log('    --resource "list=GET:/list:./list.js"');
    },
  };
}
