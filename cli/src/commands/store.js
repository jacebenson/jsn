import { confirmDelete, quoteShellArg, truncateString } from '../helpers.js';
import { declareCapabilities } from '../capabilities.js';
import { AppError, errUsage } from '../errors.js';
import {
  STORE_TABS, listApplications, showApplication, operationStatus, prepareInstall, prepareUpdate,
  dispatchOperation, waitForOperation, verifyInstalledVersion, boundedLimit, boundedOffset,
  boundedPoll, boundedTimeout,
} from '../store.js';

// Only the lifecycle verbs mutate. search/list/show/status are discovery and
// inspection: they send no mutation even though the App Client search endpoint
// is POST-shaped.
//
// Install/update are exempt from development capture-context approval for the
// same reason as catalog ordering: they hand a runtime install request to the
// App Client, which writes installed-application state rather than capturing
// metadata into the selected application/update set.
declareCapabilities('store', {
  mutationSubcommands: ['install', 'update'],
  mutationContextExemptSubcommands: ['install', 'update'],
});

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
const waitOptions = p => p.option('wait', { type: 'boolean', default: false, describe: 'Poll the tracker until it finishes' })
  .option('timeout', { type: 'number', default: 1800, describe: 'Maximum wait in seconds (1–14400); expiry does not cancel the operation' })
  .option('poll-interval', { type: 'number', default: 5, describe: 'Seconds between progress reads (0–300)' })
  .option('dry-run', { type: 'boolean', default: false, describe: 'Resolve and report the intended operation; send nothing' });

function appHints(app) {
  const name = app.scope || app.sys_id;
  return [
    hint('show', `jsn store show ${quoteShellArg(name)}`, 'Inspect installed version, available versions, entitlement and dependencies'),
    hint('status', `jsn store status <tracker-id>`, 'Read operation progress after a submission'),
  ];
}

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

async function runLifecycle(argv, app, operation) {
  const prepare = operation === 'install' ? prepareInstall : prepareUpdate;
  const plan = await prepare(app.sdk, argv.application, operation === 'install'
    ? { version: argv.version, demoData: argv.demoData === true }
    : { version: argv.version });
  const publicPlan = {
    operation: plan.operation,
    app: plan.app,
    requested_version: plan.requested_version,
    ...(plan.from_version ? { from_version: plan.from_version } : {}),
    ...(plan.operation === 'install' ? { demo_data: plan.demo_data } : {}),
    versions: plan.versions,
    installable_checked: plan.installable_checked,
    detail_unavailable: plan.detail_unavailable,
  };
  if (argv.dryRun) {
    report(app, argv, { ...publicPlan, dry_run: true, dispatched: false }, {
      summary: `Would ${operation} ${plan.app.name || plan.app.sys_id} version ${plan.requested_version}; nothing was sent`,
      breadcrumbs: appHints(plan.app),
    });
    return;
  }
  const action = operation === 'install' ? 'Install' : `Update ${plan.app.name || plan.app.sys_id}${plan.from_version ? ` from ${plan.from_version}` : ''} to`;
  await confirmDelete(app, argv, `${action} ServiceNow Store application "${plan.app.name || plan.app.sys_id}" version ${plan.requested_version}?`);
  const started = await dispatchOperation(app.sdk, plan);
  const data = { ...publicPlan, ...started, terminal: false, succeeded: null, verification: null };
  if (!argv.wait) {
    report(app, argv, data, {
      summary: `${operation === 'install' ? 'Installation' : 'Update'} submitted: tracker ${started.tracker_id} — not a completed ${operation === 'install' ? 'installation' : 'update'}`,
      breadcrumbs: [hint('status', `jsn store status ${started.tracker_id}`, 'Poll the tracker'), ...appHints(plan.app)],
    });
    return;
  }
  const timeoutMs = boundedTimeout(argv.timeout) * 1000;
  const pollIntervalMs = boundedPoll(argv.pollInterval) * 1000;
  let progress;
  try {
    progress = await waitForOperation(app.sdk, started.tracker_id, { pollIntervalMs, timeoutMs });
  } catch (error) {
    throw new AppError('store_progress_unavailable',
      `${operation === 'install' ? 'Installation' : 'Update'} ${started.tracker_id} was submitted but progress could not be read: ${error.message}. It may still be running.`,
      `Check jsn store status ${started.tracker_id} before doing anything else; do not resubmit automatically.`);
  }
  Object.assign(data, progress);
  if (data.wait_timed_out) {
    report(app, argv, data, {
      summary: `${operation === 'install' ? 'Installation' : 'Update'} ${started.tracker_id}: still running after ${argv.timeout}s (${data.percent_complete ?? 'unknown'}%); not verified`,
      breadcrumbs: [hint('status', `jsn store status ${started.tracker_id}`, 'Read progress again'), ...appHints(plan.app)],
    });
    return;
  }
  if (!data.succeeded) {
    throw new AppError('store_operation_failed',
      `${operation === 'install' ? 'Installation' : 'Update'} ${started.tracker_id} failed: ${data.status_label || data.status_message || data.error || 'the tracker reported failure'}.`,
      `Read jsn store status ${started.tracker_id} for progress and the application's upgrade history. The application may be partially installed; do not resubmit automatically.`);
  }
  // Readback can lag the tracker. Reuse the operator's poll interval, capped at
  // the module default, so a fast poll also shortens verification.
  const verification = await verifyInstalledVersion(app.sdk, plan.app, plan.requested_version, {
    intervalMs: pollIntervalMs === 0 ? 0 : Math.min(pollIntervalMs, 2000),
  });
  data.verification = verification;
  if (verification.verified === false) {
    throw new AppError('store_verification_failed',
      `${operation === 'install' ? 'Installation' : 'Update'} ${started.tracker_id} reported success, but sys_store_app reads back version ${verification.installed_version ?? '(none)'} instead of ${plan.requested_version}.`,
      `Inspect the application with jsn store show ${quoteShellArg(plan.app.scope || plan.app.sys_id)} and its upgrade history before retrying; a reported success is not a completed ${operation === 'install' ? 'installation' : 'update'}.`);
  }
  const verifiedText = verification.verified === true
    ? `version ${plan.requested_version} verified on sys_store_app`
    : `version not verified (${verification.reason})`;
  report(app, argv, data, {
    summary: `${operation === 'install' ? 'Installed' : 'Updated'} ${plan.app.name || plan.app.sys_id} ${plan.requested_version}; ${verifiedText}`,
    breadcrumbs: [hint('show', `jsn store show ${quoteShellArg(plan.app.scope || plan.app.sys_id)}`, 'Inspect the installed application'), ...appHints(plan.app)],
  });
}

export function storeCmd(wrap) {
  return {
    command: 'store [subcommand]',
    describe: 'Discover ServiceNow Store applications, inspect versions and entitlement, and request explicit installs/updates',
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
              ...(data.installed
                ? [hint('update', `jsn store update ${quoteShellArg(data.scope || data.sys_id)} --version <version> --dry-run`, 'Resolve an exact update without sending it')]
                : [hint('install', `jsn store install ${quoteShellArg(data.scope || data.sys_id)} --version <version> --dry-run`, 'Resolve an exact install without sending it')]),
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
          report(app, argv, data, {
            summary: `Tracker ${data.tracker_id}: ${data.status_label || data.status || 'unknown'}${data.percent_complete === null ? '' : ` ${data.percent_complete}%`}${data.terminal ? '' : ' (running)'}${data.error ? ` — ${data.error}` : ''}`,
            breadcrumbs: [
              ...(data.terminal ? [] : [hint('status', `jsn store status ${data.tracker_id}`, 'Read progress again')]),
              hint('list', 'jsn store list --tab updates', 'List applications with an available update'),
            ],
          });
        }),
      })
      .command({
        command: 'install <application>',
        describe: 'Install an exact Store application version (declared mutation; unverified against a live Store)',
        builder: p => waitOptions(appOption(p))
          .option('version', { type: 'string', describe: 'Exact version to install (required)' })
          .option('demo-data', { type: 'boolean', default: false, describe: 'Load demo data during installation' }),
        handler: wrap(async (argv, app) => runLifecycle(argv, app, 'install')),
      })
      .command({
        command: 'update <application>',
        describe: 'Update an installed Store application to an exact version (declared mutation; unverified against a live Store)',
        builder: p => waitOptions(appOption(p))
          .option('version', { type: 'string', describe: 'Exact target version; defaults to the reported latest_version' }),
        handler: wrap(async (argv, app) => runLifecycle(argv, app, 'update')),
      }),
    handler: wrap(async (argv, app) => {
      report(app, argv, { commands: ['search', 'list', 'show', 'status', 'install', 'update'] }, {
        summary: 'ServiceNow Store applications',
        breadcrumbs: [hint('list', 'jsn store list --tab installed', 'List installed applications'),
          hint('search', 'jsn store search "<term>"', 'Search applications available to this instance'),
          hint('show', 'jsn store show <app>', 'Inspect one application'),
          hint('status', 'jsn store status <tracker>', 'Read install/update progress')],
      });
    }),
  };
}
