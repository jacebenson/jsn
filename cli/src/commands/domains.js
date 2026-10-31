// Domain separation commands. Profile configuration sends X-Now-Domain;
// explicit session-* commands manage the server-side browser session instead.
// Header effectiveness depends on the instance and is not a session switch.

import { getStringField, interactiveList, assertSafeExactMatch } from '../helpers.js';
import { declareCapabilities } from '../capabilities.js';

// `domains set` writes the chosen domain into the profile config.
declareCapabilities('domains', { mutationSubcommands: ['set', 'session-set', 'session-reset'] });

const DETAIL_FIELDS = 'sys_id,name,parent,sys_domain_path,description,active,sys_created_on,sys_updated_on';

async function sessionRequest(app, path, options = {}) {
  const credentials = await app.sdk.authProvider?.getCredentials();
  if (credentials?.auth_method !== 'gck') {
    throw new Error('Session domain commands require browser-session (gck) credentials. Use domains set for profile header configuration.');
  }
  return app.sdk.request(`${app.sdk.baseURL}${path}`, { ...options, domain: '' });
}

export async function readSessionDomain(app) {
  const response = await sessionRequest(app, '/api/now/ui/concoursepicker/current');
  const current = response?.result?.currentDomain;
  if (!current || typeof current.value !== 'string' || !current.value) {
    throw new Error('Invalid session domain response: expected result.currentDomain.value.');
  }
  return current;
}

export async function listSessionDomains(app, { search = '', offset = 0, limit = 20 } = {}) {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('Picker offset must be a nonnegative integer and limit must be between 1 and 100.');
  }
  const contains = search.startsWith('*');
  const term = contains ? search.slice(1) : search;
  if (term) assertSafeExactMatch(term);
  const response = await sessionRequest(app, '/angular.do?sysparm_type=ref_list_data', {
    method: 'POST',
    body: JSON.stringify({
      sysparm_domain: 'picker', table: 'domain', sysparm_for_impersonation: false,
      qualifier: 'active=true', count: limit, start: offset,
      p: `domain;q:name${contains ? 'CONTAINS' : 'STARTSWITH'}${term}^nameISNOTEMPTY;r:active=true`,
    }),
  });
  const items = response?.items ?? response?.result?.items;
  if (!Array.isArray(items)) throw new Error('Invalid domain picker response: expected items array.');
  return { items, offset, limit, next_offset: items.length === limit ? offset + items.length : null };
}

export async function switchSessionDomain(app, value) {
  if (value !== 'global' && !/^[a-f0-9]{32}$/i.test(value)) {
    throw new Error('Supply a domain sys_id from session-list; use session-reset for global.');
  }
  // Probe before changing anything, so authentication/readback failures occur early.
  await readSessionDomain(app);
  await sessionRequest(app, '/api/now/ui/concoursepicker/domain', {
    method: 'PUT', ...(value === 'global' ? {} : { body: JSON.stringify({ value }) }),
  });
  let current;
  try {
    current = await readSessionDomain(app);
  } catch (err) {
    err.message += ' The session may have changed; inspect domains session-current before retrying.';
    throw err;
  }
  if (current.value !== value) {
    throw new Error(`Session domain verification failed: expected ${value}, received ${current.value}. The session may have changed; inspect domains session-current before retrying.`);
  }
  return current;
}

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
  } catch (err) {
    // Only the platform's explicit invalid-table response establishes absence.
    // Authentication, ACL, transport, and unrelated 404 errors must surface.
    if ((!err.status || [400, 404].includes(err.status)) && /invalid table(?:\s+|:\s*)["'`]?domain\b/i.test(err.message)) return false;
    throw err;
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
            const domain = app.session.domain;
            if (!domain) {
              app.ok({ domain: '', scoping: 'none' }, {
                summary: 'No domain header configured — server session scoping may still apply',
              });
              return;
            }
            // Resolve the configured value to a display name if it's a sys_id
            let label = domain;
            {
              const params = new URLSearchParams();
              params.set('sysparm_query', `sys_id=${domain}`);
              params.set('sysparm_limit', '1');
              params.set('sysparm_fields', 'sys_id,name');
              const records = await app.sdk.list('domain', params);
              if (records.length > 0) label = `${getStringField(records[0], 'name')} (${domain})`;
            }
            app.ok({ domain, scoping: 'X-Now-Domain header' }, {
              summary: `Configured domain: ${label}`,
            });
          }),
        })
        .command({
          command: 'session-current',
          describe: 'Read actual browser-session domain (separate from profile configuration)',
          handler: wrap(async (argv, app) => {
            const current = await readSessionDomain(app);
            app.ok({ configured_domain: app.session.domain, session_domain: current }, {
              summary: `Session domain: ${current.displayValue || current.value}`,
            });
          }),
        })
        .command({
          command: 'session-list',
          describe: 'List picker-visible session domains; reset explicitly to global for cross-branch selection',
          builder: y => y
            .option('search', { type: 'string', default: '', describe: 'Name prefix; leading * searches by substring' })
            .option('offset', { type: 'number', default: 0, describe: 'Picker page offset' })
            .option('limit', { type: 'number', default: 20, describe: 'Picker page size' }),
          handler: wrap(async (argv, app) => {
            const page = await listSessionDomains(app, argv);
            app.ok(page, { summary: `${page.items.length} picker-visible domain(s)` });
          }),
        })
        .command({
          command: 'session-set <domain>',
          describe: 'Switch shared browser session to a picker domain sys_id and verify (may affect your browser)',
          builder: y => y.positional('domain', { type: 'string', describe: 'Exact picker sys_id; use session-reset for global' }),
          handler: wrap(async (argv, app) => {
            if (!/^[a-f0-9]{32}$/i.test(argv.domain)) throw new Error('Supply a domain sys_id from session-list; use session-reset for global.');
            const current = await switchSessionDomain(app, argv.domain);
            app.ok({ session_domain: current }, { summary: `Session domain: ${current.displayValue || current.value}` });
          }),
        })
        .command({
          command: 'session-reset',
          describe: 'Reset shared browser session to global and verify (may affect your browser)',
          handler: wrap(async (argv, app) => {
            const current = await switchSessionDomain(app, 'global');
            app.ok({ session_domain: current }, { summary: 'Session domain reset to global' });
          }),
        })
        .command({
          command: 'set [domain]',
          describe: 'Set the profile domain header (picker when bare; "clear" to unset)',
          handler: wrap(async (argv, app) => {
            await requireDomainSeparation(app);
            let domainArg = argv.domain;
            if (!domainArg) {
              const picked = await pickDomain(app);
              if (!picked) return; // cancelled or non-interactive
              domainArg = picked;
            } else if (domainArg.toLowerCase() === 'none' || domainArg.toLowerCase() === 'clear') {
              app.setDomain('');
              app.ok({ domain: '' }, { summary: 'Domain header cleared — server session scoping may still apply' });
              return;
            }

            const sysID = await resolveDomainSysId(app, domainArg);
            app.setDomain(sysID);
            app.ok({ domain: sysID, name: domainArg }, {
              summary: `Configured domain: ${domainArg} — X-Now-Domain header configured`,
            });
          }),
        });
    },
    handler: wrap(async (argv, app) => {
      if (!argv._[1]) {
        let installed = false;
        if (app && app.sdk) installed = await isDomainSeparationInstalled(app);
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
        console.log('header effectiveness depends on the instance.');
        console.log('Use session-current/list/set/reset for browser-session domains.');
        console.log('Session changes may affect a browser sharing these credentials.');
        console.log('Run "jsn domains <command> --help" for details.');
      }
    }),
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
