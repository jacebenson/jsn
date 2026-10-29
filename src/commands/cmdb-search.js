import { assertSafeExactMatch, quoteShellArg } from '../helpers.js';
import { errAPI, errUsage } from '../errors.js';

const FIELDS = ['name', 'fqdn', 'ip_address', 'serial_number'];
const raw = v => v && typeof v === 'object' ? v.value : v;

export function cmdbSearchCmd(wrap) {
  return { command: 'search <text>', describe: 'Find CIs by name, FQDN, IP address, or serial number',
    builder: y => y.positional('text', { type: 'string', describe: 'Literal text; quote multiple words' })
      .option('class', { type: 'string', describe: 'Exact CI class name (not descendants)' })
      .option('limit', { type: 'number', default: 20, describe: 'Maximum CIs (1–100)' })
      .option('offset', { type: 'number', default: 0, describe: 'Starting result offset' }),
    handler: wrap(async (argv, app) => {
      if (typeof argv.text !== 'string' || !argv.text.trim()) throw errUsage('Provide nonempty CI search text.');
      const text = argv.text.trim();
      assertSafeExactMatch(text);
      if ([...text].some(c => c.codePointAt(0) < 32 || c.codePointAt(0) === 127) || /javascript:/i.test(text)) throw errUsage('Search text must not contain query scripts or control characters.');
      if (argv.class !== undefined && !/^[a-z][a-z0-9_]*$/.test(argv.class)) throw errUsage('--class must be an exact CI table name.');
      if (!Number.isInteger(argv.limit) || argv.limit < 1 || argv.limit > 100) throw errUsage('--limit must be from 1 to 100.');
      if (!Number.isInteger(argv.offset) || argv.offset < 0) throw errUsage('--offset must be a nonnegative integer.');
      // Repeat the class restriction in each OR branch: no branch may escape it.
      const query = FIELDS.map(f => `${f}LIKE${text}${argv.class ? `^sys_class_name=${argv.class}` : ''}`).join('^NQ') + '^ORDERBYname^ORDERBYsys_id';
      const params = new URLSearchParams({ sysparm_query: query, sysparm_limit: String(argv.limit + 1), sysparm_offset: String(argv.offset),
        sysparm_fields: 'sys_id,name,sys_class_name,fqdn,ip_address,serial_number', sysparm_display_value: 'all' });
      const rows = await app.sdk.listStrict('cmdb_ci', params);
      if (!Array.isArray(rows) || rows.some(r => !r || typeof r !== 'object' || Array.isArray(r))) throw errAPI(200, 'CMDB search returned no valid record list.');
      const hasMore = rows.length > argv.limit, records = rows.slice(0, argv.limit);
      const connection = argv.profile ? ` --profile ${quoteShellArg(argv.profile)}` : argv.instance ? ` --instance ${quoteShellArg(argv.instance)}` : '';
      const breadcrumbs = records.flatMap(r => /^[a-f0-9]{32}$/i.test(raw(r.sys_id) || '') ? [
        { action: 'show', cmd: `jsn cmdb show ${raw(r.sys_id)}`, description: String(raw(r.name) || 'Inspect CI') },
        { action: 'relationships', cmd: `jsn cmdb relationships --ci ${raw(r.sys_id)}`, description: 'Inspect CI dependencies' },
      ] : []);
      if (hasMore) breadcrumbs.push({ action: 'next', cmd: `jsn cmdb search ${quoteShellArg(text)} --limit ${argv.limit} --offset ${argv.offset + argv.limit}${argv.class ? ` --class ${argv.class}` : ''}`, description: 'Next matching CIs' });
      app.ok({ table: 'cmdb_ci', search: text, fields: FIELDS, records, count: records.length,
        pagination: { limit: argv.limit, offset: argv.offset, has_more: hasMore } },
      { summary: `${records.length} matching CI(s)`, breadcrumbs: breadcrumbs.map(h => ({ ...h, cmd: h.cmd + connection })) });
    }) };
}
