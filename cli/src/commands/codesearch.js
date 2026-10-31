// jsn codesearch — search across ServiceNow code artifacts (script includes,
// business rules, client scripts, UI actions, ...) via the sn_codesearch
// plugin REST API. Issue #180.

import { errUsage } from '../errors.js';

const DEFAULT_SEARCH_GROUP = 'sn_devstudio.Studio Search Group';

// Flatten the API's nested shape into one row per record/field so the output
// controller can render it as a table / CSV / JSON.
//
// API shape:
//   result: [ { recordType, hits: [ { name, className, tableLabel,
//     matches: [ { field, fieldLabel,
//       lineMatches: [ { line, context, escaped } ] } ] } ] } ] }
// NOTE: with ?table=<t> the API returns a single object, not an array.
export function flattenHits(result) {
  const groups = Array.isArray(result) ? result : (result ? [result] : []);
  const rows = [];
  for (const group of groups) {
    for (const hit of group.hits || []) {
      for (const match of hit.matches || []) {
        const lines = (match.lineMatches || []).filter((lm) => lm.context);
        rows.push({
          table: hit.className || group.recordType,
          name: hit.name,
          field: match.field,
          lines: lines.map((lm) => lm.line).join(','),
          matches: lines.length,
          context: lines[0]?.context?.trim() || '',
          sys_id: hit.sys_id || hit.sysId || '',
        });
      }
    }
  }
  return rows;
}

// Pre-rendered text view for styled/terminal output (output.js uses
// data._formatted when present).
function renderFormatted(rows, term) {
  if (rows.length === 0) return `No code matches for "${term}".\n`;
  const out = [];
  for (const r of rows) {
    out.push(`${r.table}  ${r.name}  .${r.field}  (lines ${r.lines})`);
    if (r.context) out.push(`    ${r.context}`);
  }
  return out.join('\n') + '\n';
}

export function codesearchCmd(wrap) {
  return {
    command: 'codesearch [subcommand]',
    aliases: ['codesearch'],
    describe: 'Search code across ServiceNow artifacts (script includes, business rules, client scripts, ...)',
    builder: (yargs) => yargs
      .command({
        command: 'search <term>',
        describe: 'Search code for a term (e.g. "codesearch search GlideAjax")',
        builder: (y) => y
          .positional('term', { type: 'string', describe: 'Search term' })
          .option('limit', { alias: 'l', type: 'number', default: 100, describe: 'Max results' })
          .option('table', { alias: 't', type: 'string', describe: 'Restrict to one source table (e.g. sys_script_include)' })
          .option('scope', { alias: 's', type: 'string', describe: 'Restrict to an app scope (e.g. x_my_app)' })
          .option('search-group', { type: 'string', default: DEFAULT_SEARCH_GROUP, describe: 'Search group to use' })
          .option('all-scopes', { type: 'boolean', default: true, describe: 'Search across all scopes (default true)' }),
        handler: wrap(async (argv, app) => {
          if (!argv.term || !argv.term.trim()) {
            throw errUsage('A search term is required', 'Example: jsn codesearch search GlideAjax');
          }

          const params = new URLSearchParams();
          params.set('term', argv.term);
          params.set('limit', String(argv.limit));
          params.set('search_group', argv.searchGroup);
          params.set('search_all_scopes', String(argv.allScopes));
          if (argv.table) params.set('table', argv.table);
          if (argv.scope) params.set('scope', argv.scope);

          const url = `${app.getEffectiveInstance()}/api/sn_codesearch/code_search/search?${params.toString()}`;
          let payload;
          try {
            payload = await app.sdk.request(url);
          } catch (err) {
            if (err.code === 'api_error' && /404/.test(err.message)) {
              err.message += '\n\nHint: the sn_codesearch plugin may not be active on this instance.';
            }
            throw err;
          }

          const result = payload?.result || [];
          const rows = flattenHits(result);

          app.ok(
            { term: argv.term, count: rows.length, records: rows, _formatted: renderFormatted(rows, argv.term) },
            { summary: `${rows.length} code match(es) for "${argv.term}"` },
          );
        }),
      })
      .demandCommand(1, 'Specify a subcommand: search'),
    handler: () => {},
  };
}
