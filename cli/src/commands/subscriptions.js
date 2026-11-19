import { declareCapabilities } from '../capabilities.js';
import { loadSchedule, estimateSubscription, formatEstimate } from '../subscriptions.js';

declareCapabilities('subscriptions', { noInstance: true, skipDailyChecks: true, mutationSubcommands: [] });
export function subscriptionsCmd(wrap) {
  const local = (_argv, app) => {
    const schedule = loadSchedule();
    const data = { schedules: [schedule] };
    Object.defineProperty(data, '_formatted', { value: [
      `${schedule.id}: ${schedule.source_version}`,
      schedule.source_url,
      `Fetched: ${schedule.fetched_at}. ${schedule.retrieval}`,
      ...schedule.categories.map(c => `${c.id}: ${c.resources_per_su} resources/SU; ${c.classes.join(', ') || 'unsupported source'}`),
      schedule.definitions.provenance,
      schedule.unresolved_mapping,
      ...schedule.limitations,
    ].join('\n') });
    app.ok(data, { summary: 'Bundled dated metering schedules, not purchased rights' });
  };
  return {
    command: 'subscriptions [subcommand]', describe: 'Inspect local metering schedules and compare illustrative ITOM populations',
    builder: y => y.command({ command: 'schedules', describe: 'Inspect bundled source-backed schedules offline', handler: wrap(local) })
      .command({ command: 'estimate <product>', describe: 'Read-only ITOM population comparison, not billing or a 90-day meter',
        builder: b => b.positional('product', { type: 'string', describe: 'ITOM; arbitrary SKUs and HRSD unsupported' })
          .option('schedule', { type: 'string', describe: 'Explicit dated schedule ID from subscriptions schedules' })
          .option('assume-eligible', { type: 'boolean', default: false, describe: 'Hypothetically treat mapped populations as managed and component-eligible, exclusions unknown' }),
        handler: wrap(async (argv, app) => {
          // Validate unsupported selections before requesting an instance.
          loadSchedule(argv.schedule);
          if (String(argv.product).toUpperCase() !== 'ITOM') await estimateSubscription(null, argv.product);
          app.requireInstance();
          const report = await estimateSubscription(app.sdk, argv.product, { schedule: argv.schedule, assumeEligible: argv.assumeEligible });
          Object.defineProperty(report, '_formatted', { value: formatEstimate(report) });
          app.ok(report, { summary: 'Incomplete illustrative ITOM population comparison; no authoritative total' });
        }),
      }),
    handler: wrap(local),
  };
}
