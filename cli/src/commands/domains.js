// Domain separation commands — list/show/current/set
//
// Domain separation (plugin) adds a `domain` table holding the domain
// hierarchy. Each domain-separated table's rows carry `sys_domain` +
// `sys_domain_path`, and queries are auto-filtered to the session domain
// plus its children. There is NO durable platform-side "current domain"
// preference a CLI can write (the picker sets the in-memory session only,
// and `sys_user.domain` is write-protected even for admin). So jsn stores
// the chosen domain in the active profile and sends it on every request
// via the `X-Now-Domain` header — the same scoping the platform applies
// to its own picker sessions.

import { getStringField, interactiveList, assertSafeExactMatch } from '../helpers.js';
import { declareCapabilities } from '../capabilities.js';

// `domains set` writes the chosen domain into the profile config.
declareCapabilities('domains', { mutationSubcommands: ['set'] });

const DETAIL_FIELDS = 'sys_id,name,parent,sys_domain_path,description,active,sys_created_on,sys_updated_on';

/**
 * Gate: domain separation must be installed. The `domain` table only
 * exists on instances with the plugin. A single cheap query detects it;
 * on non-DS instances the API returns "Invalid table domain".
 */
export async function isDomainSeparationInstalled(app) {
  try {
    const params = new URLSearchParams();
    params.set('sysparm_limit', '1');
    params.set('sysparm_fields', 'sys_id,name');
    await app.sdk.list('domain', params);
    return true;
  } catch {
    return false;
  }
}

async function requireDomainSeparation(app) {
  if (!(await isDomainSeparationInstalled(app))) {
    const e = new Error('Domain separation is not installed on this instance — the `domain` table does not exist. Install the Domain Separation plugin to use these commands.');
    e.name = 'NotSupported';
    throw e;
  }
}

/**
 * Resolve a domain name or sys_id to its sys_id. Throws when not found.
 */
export async function resolveDomainSysId(app, domainArg) {
  assertSafeExactMatch(domainArg);
  const params = new URLSearchParams();
  params.set('sysparm_query', `name=${domainArg}`);
  params.set('sysparm_limit', '1');
  params.set('sysparm_fields', 'sys_id,name');
  let records = await app.sdk.list('domain', params);
  if (records.length === 0) {
    const p2 = new URLSearchParams();
    p2.set('sysparm_query', `sys_id=${domainArg}`);
    p2.set('sysparm_limit', '1');
    p2.set('sysparm_fields', 'sys_id,name');
    records = await app.sdk.list('domain', p2);
  }
  if (records.length === 0) {
    throw new Error(`Domain not found: ${domainArg}`);
  }
  return getStringField(records[0], 'sys_id');
}

/**
 * Interactive domain picker — returns the chosen domain's sys_id, or null
 * when the user cancels. Used by `domains set` and the setup/modify flows.
 */
export async function pickDomain(app) {
  const picked = await interactiveList({
    app, table: 'domain', singular: 'domain', columns: ['name', 'sys_domain_path'], labelField: 'name',
    formatLabel: formatDomainLabel,
  });
  if (!picked) return null;
  return getStringField(picked, 'sys_id');
}

/** Format a picker label: "Name (path)". */
export function formatDomainLabel(r) {
  const path = getStringField(r, 'sys_domain_path');
  return `${getStringField(r, 'name')}${path ? ` (${path})` : ''}`;
}

/** Build a rich detail view for a domain record. */
export async function formatDomainDetail(app, record) {
  const sysID = getStringField(record, 'sys_id');
  const name = getStringField(record, 'name');
  const instance = app.getEffectiveInstance();
  const link = `${instance}/domain.do?sys_id=${sysID}`;

  // Fetch full record for fields not present on the picked row
  const params = new URLSearchParams();
  params.set('sysparm_query', `sys_id=${sysID}`);
  params.set('sysparm_limit', '1');
  params.set('sysparm_display_value', 'all');
  params.set('sysparm_fields', DETAIL_FIELDS);
  const full = await app.sdk.list('domain', params);
  const rec = full[0] || record;

  const parent = getStringField(rec, 'parent');
  const path = getStringField(rec, 'sys_domain_path');

  const lines = [
    `Domain:   ${name}`,
    `Path:     ${path || '(root)'}`,
    `Parent:   ${parent || '(none)'}`,
    `Active:   ${getStringField(rec, 'active') || 'true'}`,
    `Created:  ${getStringField(rec, 'sys_created_on')}`,
    `Updated:  ${getStringField(rec, 'sys_updated_on')}`,
    `Link:     ${link}`,
  ];

  const desc = getStringField(rec, 'description');
  if (desc) lines.splice(1, 0, `Desc:     ${desc}`);

  return {
    sys_id: sysID,
    name,
    parent,
    sys_domain_path: path,
    _formatted: lines.join('\n'),
  };
}

export function domainsCmd(wrap) {
  return {
    command: 'domains [subcommand]',
    aliases: ['domain', 'dom'],
    describe: 'Manage domains (domain separation)',
    builder: (yargs) => {
      return yargs
        .command({
          command: 'list',
          aliases: ['ls'],
          describe: 'List domains (hierarchy + paths)',
          builder: (y) => y
            .option('query', { type: 'string', describe: 'Encoded query (e.g. "nameLIKEACME")' })
            .option('columns', { alias: ['c', 'fields'], type: 'string', describe: 'Comma-separated columns' })
            .option('limit', { alias: 'l', type: 'number', default: 50, describe: 'Max records' }),
          handler: wrap(async (argv, app) => {
            await requireDomainSeparation(app);
            const columns = argv.columns ? argv.columns.split(',') : ['name', 'parent', 'sys_domain_path'];
            const query = argv.query || '';

            const picked = await interactiveList({
              app, table: 'domain', singular: 'domain', columns, limit: argv.limit, query, labelField: 'name',
              formatLabel: formatDomainLabel,
            });
            if (picked === undefined) return; // user cancelled
            if (picked) {
              const detail = await formatDomainDetail(app, picked);
              return app.ok(detail, { summary: `Domain: ${getStringField(picked, 'name')}` });
            }

            const params = new URLSearchParams();
            params.set('sysparm_limit', String(argv.limit));
            params.set('sysparm_display_value', 'all');
            params.set('sysparm_fields', ['sys_id', ...columns].join(','));
            const q = argv.query ? argv.query + '^ORDERBYsys_domain_path' : 'ORDERBYsys_domain_path';
            params.set('sysparm_query', q);
            const records = await app.sdk.list('domain', params);
            app.ok({
              table: 'domain',
              count: records.length,
              columns,
              records: records.map(r => formatDomainListRecord(r, columns)),
              context: { instance_url: app.getEffectiveInstance() },
            }, { summary: `${records.length} domain(s)` });
          }),
        })
        .command({
          command: 'show <domain>',
          aliases: ['get'],
          describe: 'Show a domain by name or sys_id',
          builder: (y) => y
            .positional('domain', {
              describe: 'Domain name (e.g. ACME) or sys_id',
              type: 'string',
            }),
          handler: wrap(async (argv, app) => {
            await requireDomainSeparation(app);
            assertSafeExactMatch(argv.domain);
            let records;
            // Try by name first, then by sys_id
            for (const queryField of ['name', 'sys_id']) {
              const params = new URLSearchParams();
              params.set('sysparm_query', `${queryField}=${argv.domain}`);
              params.set('sysparm_limit', '1');
              params.set('sysparm_display_value', 'all');
              records = await app.sdk.list('domain', params);
              if (records.length > 0) break;
            }
            if (!records || records.length === 0) {
              throw new Error(`Domain not found: ${argv.domain}`);
            }
            const detail = await formatDomainDetail(app, records[0]);
            app.ok(detail, { summary: `Domain ${argv.domain}` });
          }),
        })
        .command({
          command: 'current',
          describe: 'Show the configured domain for this profile',
          handler: wrap(async (argv, app) => {
            await requireDomainSeparation(app);
            const domain = app._profileDomain(app.config);
            if (!domain) {
              app.ok({ domain: '', scoping: 'none' }, {
                summary: 'No domain configured — requests are not domain-scoped',
              });
              return;
            }
            // Resolve the configured value to a display name if it's a sys_id
            let label = domain;
            try {
              const params = new URLSearchParams();
              params.set('sysparm_query', `sys_id=${domain}`);
              params.set('sysparm_limit', '1');
              params.set('sysparm_fields', 'sys_id,name');
              const records = await app.sdk.list('domain', params);
              if (records.length > 0) label = `${getStringField(records[0], 'name')} (${domain})`;
            } catch { /* non-fatal — show raw value */ }
            app.ok({ domain, scoping: 'X-Now-Domain header' }, {
              summary: `Configured domain: ${label}`,
            });
          }),
        })
        .command({
          command: 'set [domain]',
          describe: 'Set the configured domain for this profile (interactive picker when run bare; omit to clear)',
          handler: wrap(async (argv, app) => {
            await requireDomainSeparation(app);
            let domainArg = argv.domain;
            if (!domainArg) {
              const picked = await pickDomain(app);
              if (!picked) return; // cancelled or non-interactive
              domainArg = picked;
            } else if (domainArg.toLowerCase() === 'none' || domainArg.toLowerCase() === 'clear') {
              app.setDomain('');
              app.ok({ domain: '' }, { summary: 'Domain cleared — requests are no longer domain-scoped' });
              return;
            }

            const sysID = await resolveDomainSysId(app, domainArg);
            app.setDomain(sysID);
            app.ok({ domain: sysID, name: domainArg }, {
              summary: `Configured domain: ${domainArg} — all requests scoped to it`,
            });
          }),
        });
    },
    handler: async (argv) => {
      if (!argv._[1]) {
        const app = argv.app;
        let installed = false;
        try {
          if (app && app.sdk) installed = await isDomainSeparationInstalled(app);
        } catch {
          installed = false;
        }
        if (!installed) {
          if (app && app.sdk) {
            console.log('Domain separation is not installed on this instance.');
            console.log('Install the Domain Separation plugin to manage domains.');
          } else {
            console.log('No instance configured — run "jsn auth login <instance>" first.');
          }
          return;
        }
        console.log('Manage ServiceNow domains (domain separation).\n');
        console.log('Commands:');
        console.log('  list            List domains (hierarchy + paths)');
        console.log('  show <domain>   Show a domain');
        console.log('  current         Show the configured domain for this profile');
        console.log('  set  [domain]   Configure the domain for this profile (picker when bare; "clear" to unset)');
        console.log('\nDomains are applied per-request via the X-Now-Domain header —');
        console.log('the platform filters every query to the domain and its children.');
        console.log('Run "jsn domains <command> --help" for details.');
      }
    },
  };
}

/** Flat display record for list mode (keeps the JSON payload small). */
function formatDomainListRecord(r, columns) {
  const out = {};
  for (const c of columns) {
    const v = getStringField(r, c);
    out[c] = v;
  }
  out.sys_id = getStringField(r, 'sys_id');
  return out;
}
