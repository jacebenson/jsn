import { quoteShellArg, truncateString } from '../helpers.js';
import { errUsage } from '../errors.js';
import {
  STORE_TABS, listApplications, showApplication, operationStatus, boundedLimit, boundedOffset,
} from '../store.js';

const hint = (action, cmd, description) => ({ action, cmd, description });

// Styled views. The generic renderer only prints `data.records` or a flat
// record, so a store payload (`apps[]` / nested installed+available blocks)
// rendered as nothing but its summary line. `_formatted` is the documented
// escape hatch; it is non-enumerable, so --json/--csv are unchanged.
const cell = (value, width) => truncateString(String(value ?? ''), width).padEnd(width);

function attachFormatted(data, text) {
  Object.defineProperty(data, '_formatted', { value: text, enumerable: false, configurable: true });
  return data;
}

function styledApplications(page) {
  const lines = [
    `${page.count} Store application${page.count === 1 ? '' : 's'} (${page.tab}${page.term ? `, search "${page.term}"` : ''})${page.page_full ? '; page full, more may exist' : ''}`,
    '',
  ];
  if (!page.apps.length) {
    lines.push('  (no applications reported for this tab)');
    return lines.join('\n');
  }
  lines.push(`${cell('NAME', 34)} ${cell('SCOPE', 22)} ${cell('INSTALLED', 9)} ${cell('LATEST', 9)} FLAGS`);
  for (const app of page.apps) {
    const blocked = (app.indicators || []).find(item => item.type === 'error');
    const flags = [
      app.installed ? 'installed' : 'not installed',
      app.update_available ? 'update' : '',
      app.blocked ? `blocked${blocked?.message ? `: ${blocked.message}` : ''}` : '',
    ].filter(Boolean).join(', ');
    lines.push(`${cell(app.name, 34)} ${cell(app.scope, 22)} ${cell(app.version || '-', 9)} ${cell(app.latest_version || '-', 9)} ${flags}`);
  }
  return lines.join('\n');
}

function styledApplication(data) {
  const line = (label, value) => `  ${label.padEnd(12)} ${value}`;
  const lines = [
    `${data.name || data.sys_id}${data.scope ? `  (${data.scope})` : ''}`,
    data.installed ? `  installed ${data.installed.version || 'version unknown'}` : '  not installed on this instance',
    '',
  ];
  if (data.installed) {
    lines.push(line('active', data.installed.active === null ? 'unknown' : String(data.installed.active)));
    if (data.installed.install_date) lines.push(line('installed on', data.installed.install_date));
    if (data.installed.update_date) lines.push(line('updated on', data.installed.update_date));
  }
  if (data.available) {
    lines.push(line('latest', data.available.latest_version || 'unknown'));
    lines.push(line('update', data.available.update_available ? 'available' : 'none reported'));
    lines.push(line('versions', data.available.versions?.length ? data.available.versions.join(', ') : 'none reported'));
    if (data.available.compatibilities) lines.push(line('compatible', String(data.available.compatibilities)));
  } else {
    lines.push(line('store data', `unavailable (${data.detail_unavailable || 'no detail returned'})`));
  }
  if (data.entitlement) {
    lines.push(line('installable', data.entitlement.can_install_or_upgrade === null ? 'not reported' : String(data.entitlement.can_install_or_upgrade)));
    if (data.entitlement.price_type) lines.push(line('price', data.entitlement.price_type));
  }
  if (data.blocked) {
    const reasons = (data.indicators || []).map(item => item.message || item.tooltip).filter(Boolean).join('; ');
    lines.push(line('blocked', reasons || 'yes'));
  }
  if (data.dependencies) lines.push(line('depends on', String(data.dependencies)));
  for (const note of data.notes || []) lines.push('', `  note: ${note}`);
  return lines.join('\n');
}

function styledTracker(data) {
  const line = (label, value) => `  ${label.padEnd(10)} ${value}`;
  const lines = [
    `Tracker ${data.tracker_id}`,
    line('status', `${data.status_label || data.status || 'unknown'}${data.status ? ` (${data.status})` : ''}`),
    line('progress', data.percent_complete === null ? 'unknown' : `${data.percent_complete}%`),
  ];
  if (data.status_message) lines.push(line('message', data.status_message));
  if (data.error) lines.push(line('error', data.error));
  if (data.status_detail) lines.push(line('detail', data.status_detail));
  lines.push(line('finished', data.terminal ? 'yes' : 'no'));
  return lines.join('\n');
}

function report(app, argv, data, options) {
  const connection = argv.profile ? ` --profile ${quoteShellArg(argv.profile)}`
    : argv.instance ? ` --instance ${quoteShellArg(argv.instance)}` : '';
  app.ok(data, { ...options, breadcrumbs: (options.breadcrumbs || []).map(item => ({ ...item, cmd: item.cmd + connection })) });
}

const tabOption = p => p.option('tab', { type: 'string', default: 'available', choices: Object.keys(STORE_TABS), describe: 'Store tab context' });
const pageOptions = p => p.option('limit', { type: 'number', default: 20, describe: 'Maximum applications (1–200)' })
  .option('offset', { type: 'number', default: 0, describe: 'Pagination offset' });
// The positional is NOT named `app`: cli.js attaches the command's App context
// as argv.app on every command, so a positional called `app` is overwritten
// before the handler runs and every identifier arrives as the context object.
const appOption = p => p.positional('application', { type: 'string', describe: 'Application name, scope, or sys_id' });
function listHints(page) {
  const base = page.term ? `jsn store search ${quoteShellArg(page.term)}` : 'jsn store list';
  return [
    ...page.apps.slice(0, 5).map(app => hint('show', `jsn store show ${quoteShellArg(app.scope || app.sys_id)}`, `Inspect ${app.name || app.sys_id}`)),
    ...(page.page_full ? [hint('next', `${base} --tab ${page.tab} --offset ${page.offset + page.limit} --limit ${page.limit}`, 'Next page')] : []),
    hint('updates', 'jsn store list --tab updates', 'List applications with an available update'),
  ];
}

function emitList(app, argv, page) {
  report(app, argv, attachFormatted(page, styledApplications(page)), {
    summary: `${page.count} Store application${page.count === 1 ? '' : 's'} (${page.tab}${page.term ? `, search "${page.term}"` : ''})${page.page_full ? '; page full, more may exist' : ''}`,
    breadcrumbs: listHints(page),
  });
}

export function storeCmd(wrap) {
  return {
    command: 'store [subcommand]',
    describe: 'Discover ServiceNow Store applications and inspect their versions, entitlement and block reasons (read-only)',
    builder: y => y
      .command({
        command: 'list',
        describe: 'List Store applications for a tab (read-only)',
        builder: p => pageOptions(tabOption(p)),
        handler: wrap(async (argv, app) => {
          const limit = boundedLimit(argv.limit);
          const offset = boundedOffset(argv.offset);
          emitList(app, argv, await listApplications(app.sdk, { tab: argv.tab, limit, offset }));
        }),
      })
      .command({
        command: 'search <term>',
        describe: 'Search Store applications for this instance by term (read-only)',
        builder: p => pageOptions(tabOption(p)).positional('term', { type: 'string', describe: 'Search term' }),
        handler: wrap(async (argv, app) => {
          const term = String(argv.term ?? '').trim();
          if (!term) throw errUsage('Provide a nonempty search term.');
          const limit = boundedLimit(argv.limit);
          const offset = boundedOffset(argv.offset);
          emitList(app, argv, await listApplications(app.sdk, { tab: argv.tab, term, limit, offset }));
        }),
      })
      .command({
        command: 'show <application>',
        describe: 'Inspect installed version, available versions, entitlement, dependencies and compatibility (read-only)',
        builder: appOption,
        handler: wrap(async (argv, app) => {
          const data = await showApplication(app.sdk, argv.application);
          attachFormatted(data, styledApplication(data));
          report(app, argv, data, {
            summary: `Store application: ${data.name || data.sys_id}${data.installed ? ` (installed ${data.installed.version || 'version unknown'})` : ' (not installed)'}`,
            breadcrumbs: [
              hint('show', `jsn store show ${quoteShellArg(data.scope || data.sys_id)}`, 'Inspect this application'),
              hint('list', 'jsn store list --tab updates', 'List applications with an available update'),
            ],
          });
        }),
      })
      .command({
        command: 'status <tracker>',
        describe: 'Read asynchronous install/update progress (read-only)',
        builder: p => p.positional('tracker', { type: 'string', describe: 'Tracker sys_id reported by install/update' }),
        handler: wrap(async (argv, app) => {
          const data = await operationStatus(app.sdk, argv.tracker);
          attachFormatted(data, styledTracker(data));
          report(app, argv, data, {
            summary: `Tracker ${data.tracker_id}: ${data.status_label || data.status || 'unknown'}${data.percent_complete === null ? '' : ` ${data.percent_complete}%`}${data.terminal ? '' : ' (running)'}${data.status_message ? ` — ${data.status_message}` : data.error ? ` — ${data.error}` : ''}`,
            breadcrumbs: [
              ...(data.terminal ? [] : [hint('status', `jsn store status ${data.tracker_id}`, 'Read progress again')]),
              hint('list', 'jsn store list --tab updates', 'List applications with an available update'),
            ],
          });
        }),
      }),
    handler: wrap(async (argv, app) => {
      report(app, argv, { commands: ['search', 'list', 'show', 'status'] }, {
        summary: 'ServiceNow Store applications',
        breadcrumbs: [hint('list', 'jsn store list --tab installed', 'List installed applications'),
          hint('search', 'jsn store search "<term>"', 'Search applications available to this instance'),
          hint('show', 'jsn store show <application>', 'Inspect one application'),
          hint('status', 'jsn store status <tracker>', 'Read install/update progress')],
      });
    }),
  };
}
