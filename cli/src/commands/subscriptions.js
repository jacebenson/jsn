import { subscriptionsCmdDefinition } from '../command-families.js';
import { subscriptionEvidence, formatSubscriptionEvidence, evidenceLimit } from '../subscription-evidence.js';
import { refreshSchedules } from '../schedule-cache.js';
import { loadSchedule, scheduleCatalog, scheduleSnapshot, formatSchedule, estimateSubscription, formatEstimate } from '../subscriptions.js';


export function subscriptionsCmd(wrap) {
  const local = (argv, app) => {
    const snapshot = scheduleSnapshot();
    const schedules = scheduleCatalog({ product: argv.product, sku: argv.sku, id: argv.id, snapshot });
    const data = { provenance: snapshot.provenance, schedules, coverage: { index_documents: new Set(snapshot.schedules.map(s => s.source_url)).size, archive: 'unavailable', sku_mapping: 'only explicitly normalized codes; empty results do not establish absence of rights' } };
    Object.defineProperty(data, '_formatted', { value: [
      `Local catalog snapshot (${data.provenance.source}; ${data.provenance.freshness}; revision ${data.provenance.revision || 'bundled'}; retrieved ${data.provenance.retrieved_at || 'bundled'}; stale ${data.provenance.stale}); contractual applicability unverified. Archive unavailable.`,
      ...schedules.flatMap(s => [
        `${s.id} | ${s.product} | ${s.effective_date || s.source_version || 'date unverified'} | ${s.normalization_status || 'not specified'}`,
        s.source_url,
        `Measurement: ${s.measurement || 'not specified; inspection only'}. SKU mapping: ${(s.skus || []).join(', ') || 'unverified'}`,
        ...(s.unknowns || s.limitations || []),
        ...(argv.id ? [formatSchedule(s)] : []),
      ]),
    ].join('\n') });
    app.ok(data, { summary: 'Local dated metering schedules, not purchased rights' });
  };
  return {
    ...subscriptionsCmdDefinition,
    builder: y => y.command({ command: 'evidence', describe: 'Show subscription evidence and installed-app hints (read-only)',
      builder: b => b.option('limit', { type: 'number', default: 50, describe: 'Maximum observations per source (integer 1–200)' }),
      handler: wrap(async (argv, app) => {
        const limit = evidenceLimit(argv.limit);
        app.requireInstance();
        const report = await subscriptionEvidence(app.sdk, { limit });
        Object.defineProperty(report, '_formatted', { value: formatSubscriptionEvidence(report) });
        app.ok(report, { summary: 'Bounded instance evidence; contractual authority and completeness unverified' });
      }),
    }).command({ command: 'refresh', describe: 'Explicitly download and validate schedule catalog; retain last-good on failure', builder: b => b.option('manifest-url', { type: 'string' }), handler: wrap(async (argv, app) => {
      const origin = process.env.JSN_DOCS_URL || app.config?.docs?.url;
      const manifest = argv.manifestUrl || process.env.JSN_SCHEDULES_MANIFEST_URL || app.config?.docs?.schedule_manifest_url || (origin ? new URL('/subscription-schedules/v1/manifest.json', origin).href : undefined);
      const provenance = await refreshSchedules(manifest);
      app.ok({ provenance }, { summary: 'Validated schedule cache refreshed' });
    }) }).command({ command: 'schedules', describe: 'Inspect validated cache or bundled source-backed schedules offline', builder: b => b.option('product', { type: 'string' }).option('sku', { type: 'string' }).option('id', { type: 'string' }), handler: wrap(local) })
      .command({ command: 'estimate <product>', describe: 'Read-only ITOM population comparison, not billing or a 90-day meter',
        builder: b => b.positional('product', { type: 'string', describe: 'ITOM; arbitrary SKUs and HRSD unsupported' })
          .option('schedule', { type: 'string', describe: 'Explicit dated schedule ID from subscriptions schedules' })
          .option('assume-eligible', { type: 'boolean', default: false, describe: 'Hypothetically treat mapped populations as managed and component-eligible, exclusions unknown' }),
        handler: wrap(async (argv, app) => {
          // Validate unsupported selections before requesting an instance.
          const selected = loadSchedule(argv.schedule);
          if (String(argv.product).toUpperCase() !== 'ITOM' || selected.measurement !== 'illustrative-population') await estimateSubscription(null, argv.product, { schedule: argv.schedule });
          app.requireInstance();
          const report = await estimateSubscription(app.sdk, argv.product, { schedule: argv.schedule, assumeEligible: argv.assumeEligible });
          Object.defineProperty(report, '_formatted', { value: formatEstimate(report) });
          app.ok(report, { summary: 'Incomplete illustrative ITOM population comparison; no authoritative total' });
        }),
      }),
    handler: wrap(local),
  };
}
