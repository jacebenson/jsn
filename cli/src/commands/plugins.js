import { deferredFamilyDefinition } from '../command-families.js';
import { inventoryCompareCommand } from '../instance-inventory.js';
import { readDependencyTree, formatPluginTree, planActivation, activatePlugin, formatActivation, listPlans, showPlan, formatPlans, formatPlan } from '../plugins.js';
import { boundedPoll, boundedTimeout } from '../store.js';
import { buildRerunCommand } from '../helpers.js';
import { AppError, errUsage } from '../errors.js';

const showCommand = wrap => ({
  command: 'show <id>', describe: 'Show a plugin and every plugin it requires, nested (read-only)',
  builder: p => p.strict().positional('id', { type: 'string', describe: 'Plugin id, such as com.snc.incident' })
    .epilogue('jsn plugins show com.glide.ui.ng.amb\njsn plugins show com.snc.pa.premium --json\njsn plugins show com.snc.pa.premium --get data.inactive\nA required id v_plugin does not list is reported as not listed, never as missing; a plugin id it does not list is not found. Cycles are named and not followed.'),
  handler: wrap(async (argv, app) => {
    app.requireInstance();
    const data = await readDependencyTree(app.sdk, argv.id);
    Object.defineProperty(data, '_formatted', { value: formatPluginTree(data), enumerable: false });
    app.ok(data, { summary: `${data.plugin.id}: ${data.count} dependencies, ${data.inactive.length} inactive${data.complete ? '' : ' (incomplete)'}` });
  }),
});

const installCommand = wrap => ({
  command: 'install <ids..>', describe: 'Activate one plugin and the plugins it requires; preview by default',
  builder: p => p.strict().positional('ids', { type: 'string', array: true, describe: 'Plugin id; several ids preview one plan and never send' })
    .option('yes', { type: 'boolean', default: false, describe: 'Activate the one plugin named; without it nothing is sent' })
    .option('timeout', { type: 'number', default: 1800, describe: 'Seconds to wait for the activation tracker (1 to 14400)' })
    .option('poll-interval', { type: 'number', default: 5, describe: 'Seconds between tracker reads (0 to 300)' })
    .epilogue('jsn plugins install com.snc.pa.premium\njsn plugins install com.snc.pa.premium com.snc.sla.timeline\njsn plugins install com.glide.web_service_aggregate --yes\n'
      + 'Without --yes, reads each dependency tree and lists the inactive plugins activation would pull in, required plugins first, and any refusal.\n'
      + 'With --yes and one id: POST /api/sn_cicd/plugin/<id>/activate, waits on its tracker, then reads every listed plugin back from v_plugin.\n'
      + 'Refused before anything is sent: an active plugin, a blocked install, an incomplete tree, or more than one id. Activation cannot be undone here.'),
  handler: wrap(async (argv, app) => {
    // Every check that can refuse runs before the first request.
    const ids = (argv.ids ?? []).map(String);
    if (argv.yes && new Set(ids).size > 1) throw errUsage('--yes activates one plugin at a time; several ids preview a plan only. Nothing was sent.');
    const timeoutMs = boundedTimeout(argv.timeout) * 1000, pollIntervalMs = boundedPoll(argv.pollInterval) * 1000;
    app.requireInstance();
    const plan = await planActivation(app.sdk, ids);
    const refused = plan.refusals.map(r => `${r.id}: ${r.reason}`).join('; ');
    // Hints re-pin --profile/--instance so following one cannot activate on another instance.
    const pinned = (...tokens) => buildRerunCommand(argv, { rerun: ['plugins', ...tokens] });
    if (!argv.yes) {
      const rerun = plan.requested.length === 1 && !plan.refusals.length ? pinned('install', plan.requested[0], '--yes') : null;
      const data = { dry_run: true, sent: false, ...plan, rerun };
      Object.defineProperty(data, '_formatted', { value: formatActivation(data), enumerable: false });
      return app.ok(data, { summary: refused ? `Dry run: nothing can be activated; refused: ${refused}; nothing sent` : `Dry run: ${plan.plugins.length} plugin(s) would be activated; nothing sent`,
        breadcrumbs: rerun ? [{ action: 'install', cmd: rerun, description: 'Activate it' }] : [] });
    }
    if (plan.refusals.length) throw errUsage(`Not activated: ${refused}. Nothing was sent.`);
    const data = await activatePlugin(app.sdk, plan, { pollIntervalMs, timeoutMs, rerun: tokens => buildRerunCommand(argv, { rerun: tokens }) });
    Object.defineProperty(data, '_formatted', { value: formatActivation(data), enumerable: false });
    const [id] = plan.requested;
    if (!data.wait_timed_out && !data.succeeded) {
      throw new AppError('plugin_activation_failed', `Activation of ${id} failed (tracker ${data.tracker_id}): ${data.status_message || data.status_label || data.error || 'the tracker reported failure'}.`,
        `Read ${pinned('show', id)}; some required plugins may already be active. jsn never resends an activation.`);
    }
    if (data.still_inactive?.length) {
      throw new AppError('plugin_verification_failed', `Tracker ${data.tracker_id} reported success, but v_plugin still shows ${data.still_inactive.join(', ')} inactive.`,
        `Read ${pinned('show', id)}; a reported success is not a completed activation.`);
    }
    app.ok(data, { summary: data.wait_timed_out ? `Activation of ${id} still running after ${argv.timeout}s (tracker ${data.tracker_id}); not verified` : `Activated ${id} and ${data.plugins.length - 1} required plugin(s); verified on v_plugin`,
      breadcrumbs: [{ action: 'show', cmd: pinned('show', id), description: 'Read the plugin and its tree again' }, ...(data.wait_timed_out ? [{ action: 'status', cmd: buildRerunCommand(argv, { rerun: ['store', 'status', data.tracker_id] }), description: 'Read the tracker again' }] : [])] });
    if (data.wait_timed_out) process.exitCode = 1;
  }),
});

const plansCommand = wrap => ({
  command: 'plans [plan]', describe: 'List batch install plans, or show one plan and its items (read-only)',
  builder: p => p.strict().positional('plan', { type: 'string', describe: 'Plan name or sys_id; without it, the newest plans are listed' })
    .option('limit', { type: 'number', default: 20, describe: 'Plans to list (1 to 200)' })
    .epilogue('jsn plugins plans\njsn plugins plans auto-upgrade-1795233217607\njsn plugins plans 2d579537c328931068353eec050131fe --get data.failed\n'
      + 'Reads sys_batch_install_plan and its sys_batch_install_item rows, joined on the plan sys_id. Each item keeps its state, reason and status message.'),
  handler: wrap(async (argv, app) => {
    app.requireInstance();
    if (argv.plan === undefined) {
      const data = await listPlans(app.sdk, { limit: argv.limit });
      Object.defineProperty(data, '_formatted', { value: formatPlans(data), enumerable: false });
      return app.ok(data, { summary: `${data.count} batch install plan(s)${data.pagination.hasMore ? '; more exist' : ''}` });
    }
    const data = await showPlan(app.sdk, argv.plan);
    Object.defineProperty(data, '_formatted', { value: formatPlan(data), enumerable: false });
    app.ok(data, { summary: `${data.plan.name ?? data.plan.sys_id}: ${data.plan.state ?? 'state unknown'}, ${data.count ? `${data.count} item(s)` : 'no items this profile can read'}, ${data.failed.length} failed or invalid${data.complete ? '' : ' (incomplete)'}` });
  }),
});

export const pluginsCmd = wrap => ({
  ...deferredFamilyDefinition('plugins'),
  builder: p => p.command(inventoryCompareCommand(wrap, 'plugins')).command(showCommand(wrap)).command(installCommand(wrap)).command(plansCommand(wrap)),
  handler: wrap(async (_argv, app) => app.ok({ commands: ['compare', 'show', 'install', 'plans'] }, { summary: 'jsn plugins show <id> for a plugin and its nested dependencies; jsn plugins install <id> to preview activating it; jsn plugins plans for batch install plans; jsn plugins compare --source pdi --target vendor for plugins only; jsn compare for plugins and Store apps' })),
});
