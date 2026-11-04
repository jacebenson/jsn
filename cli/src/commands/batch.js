// `jsn batch` — manifest-based create/update orchestration for related artifacts.
//
//   jsn batch plan --file manifest.json    read-only plan (zero writes)
//   jsn batch apply --file manifest.json   apply in dependency order
//
// The shared engine (src/batch-engine.js) and schema (src/batch-manifest.js)
// are domain-neutral. Artifact domains register adapters; the catalog item +
// variables slice lives in src/batch-adapters/catalog.js. Unsupported types
// fail validation instead of falling back to unconstrained table writes.

import fs from 'node:fs';
import process from 'node:process';
import { declareCapabilities } from '../capabilities.js';
import { errUsageHint } from '../errors.js';
import { formatCommandList } from '../helpers.js';
import { makeAdapterRegistry, parseBatchManifest } from '../batch-manifest.js';
import { applyBatch, planBatch } from '../batch-engine.js';
import { catalogBatchAdapters } from '../batch-adapters/catalog.js';

declareCapabilities('batch', { mutationSubcommands: ['apply'] });

const BATCH_ADAPTERS = makeAdapterRegistry(catalogBatchAdapters);

const EXAMPLES = [
  'jsn batch plan --file manifest.json',
  'jsn batch apply --file manifest.json --json',
  'jsn batch plan --file - --json --get "data.steps[0].payload"',
].join('\n  ');

function readManifest(argv) {
  const file = argv.file;
  if (!file) throw errUsageHint('jsn batch needs --file <manifest.json> (or --file - for stdin).', 'See docs/batch-manifest.md.');
  let text;
  try {
    text = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw errUsageHint(`Could not read manifest ${file}: ${error.message}`, 'Pass a readable JSON file or - for stdin.');
  }
  return parseBatchManifest(text, BATCH_ADAPTERS);
}

export function formatBatchPlan(result) {
  const lines = [
    `Instance: ${result.instance || '(none)'}`,
    `Capture context: scope ${result.context?.scope || 'unknown'}, update set ${result.context?.update_set?.name || 'unknown'}`,
    `Order: ${result.order.join(' -> ')}`,
    `Plan: ${result.counts.steps} step(s) — ${result.counts.creates} create, ${result.counts.updates} update; 0 writes.`,
    '',
  ];
  for (const step of result.steps) {
    const target = step.target?.mode === 'update'
      ? `update ${step.target.sys_id}${step.target.matched ? ` (${step.target.matched})` : ''}`
      : 'create';
    lines.push(`${step.name} [${step.type}] ${target}`);
    if (step.depends_on.length) lines.push(`  depends on: ${step.depends_on.join(', ')}`);
    for (const [field, value] of Object.entries(step.payload)) {
      lines.push(`  ${field}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);
    }
    for (const note of step.notes) lines.push(`  note: ${note}`);
    for (const ref of step.pending_refs) lines.push(`  pending ${ref.location}: ${ref.ref}`);
  }
  lines.push('', 'No writes performed. Run `jsn batch apply --file <manifest.json>` to apply.');
  return lines.join('\n');
}

export function formatBatchResult(result) {
  const lines = [
    `Instance: ${result.instance || '(none)'}`,
    `Capture context: scope ${result.context?.scope || 'unknown'}, update set ${result.context?.update_set?.name || 'unknown'}`,
    `Result: ${result.counts.created} created, ${result.counts.updated} updated, ${result.counts.failed} failed, ${result.counts.skipped} skipped.`,
    '',
  ];
  for (const step of result.steps) {
    const id = step.sys_id ? ` ${step.sys_id}` : '';
    const reason = step.skipped_reason ? ` (${step.skipped_reason})` : '';
    const error = step.error ? ` — ${step.error.code}: ${step.error.message}` : '';
    lines.push(`${step.name} [${step.type}] ${step.status}${reason}${id}${error}`);
  }
  for (const change of result.context_changes || []) {
    lines.push('', `Context changed before step ${change.step}: scope ${change.before?.scope} / ${change.before?.update_set?.name} -> ${change.after?.scope} / ${change.after?.update_set?.name}`);
  }
  if (result.stopped) lines.push('', `Stopped: ${result.stopped.message}`, `Hint: ${result.stopped.hint}`);
  if (result.partial) {
    lines.push('', 'Partial batch — not an atomic transaction and not rolled back:');
    for (const line of result.recovery) lines.push(`  ${line}`);
  }
  return lines.join('\n');
}

export function batchCmd(wrap) {
  return {
    command: 'batch [subcommand]',
    describe: 'Plan or apply a manifest of related artifact creates/updates',
    builder: (yargs) => yargs
      .usage('Usage: jsn batch <plan|apply> --file <manifest.json>')
      .command({
        command: 'plan',
        describe: 'Validate a manifest and show targets, dependency order and payloads; performs zero writes',
        builder: (y) => y
          .option('file', { alias: 'f', type: 'string', demandOption: true, describe: 'Manifest JSON path, or - for stdin' })
          .epilogue(`Plan is read-only and allowed on read-only profiles. It resolves update targets, so it needs an instance.\nExamples:\n  ${EXAMPLES}\nManifest schema, reference syntax and supported types: docs/batch-manifest.md`),
        handler: wrap(async (argv, app) => {
          app.requireInstance();
          const manifest = readManifest(argv);
          const result = await planBatch({
            sdk: app.sdk,
            manifest,
            instance: app.getEffectiveInstance(),
          });
          const formatted = formatBatchPlan(result);
          app.ok({ ...result, _formatted: formatted }, {
            summary: `Plan: ${result.counts.steps} step(s) — ${result.counts.creates} create, ${result.counts.updates} update; 0 writes`,
            breadcrumbs: [{ action: 'apply', cmd: `jsn batch apply --file ${argv.file}`, description: 'Apply this manifest' }],
          });
        }),
      })
      .command({
        command: 'apply',
        describe: 'Apply a manifest in dependency order through domain operations; reports per-step status and partial results',
        builder: (y) => y
          .option('file', { alias: 'f', type: 'string', demandOption: true, describe: 'Manifest JSON path, or - for stdin' })
          .epilogue(`Apply validates the whole manifest and resolves every update target before the first write.\nA batch is not an atomic transaction: completed steps remain, dependents of a failed step are skipped, and nothing is rolled back or retried automatically.\nRepeat runs: convert completed creates into update steps using the reported sys_ids before re-running.\nExamples:\n  ${EXAMPLES}\nSupported artifact types: catalog_item, catalog_variable. See docs/batch-manifest.md`),
        handler: wrap(async (argv, app) => {
          app.requireInstance();
          const manifest = readManifest(argv);
          const result = await applyBatch({
            sdk: app.sdk,
            manifest,
            app,
            argv,
            initialContext: app.mutationContext || null,
          });
          const formatted = formatBatchResult(result);
          const summary = result.partial
            ? `PARTIAL: ${result.counts.created} created, ${result.counts.updated} updated, ${result.counts.failed} failed, ${result.counts.skipped} skipped`
            : `Applied: ${result.counts.created} created, ${result.counts.updated} updated`;
          app.ok({ ...result, _formatted: formatted }, { summary });
          if (result.partial) process.exitCode = 1;
        }),
      }),
    handler: wrap(async (argv, app) => app.ok({
      subcommands: argv.subcommands || [],
      supported_types: BATCH_ADAPTERS.types(),
      _formatted: formatCommandList({
        title: 'Batch manifests',
        commands: argv.subcommands || [],
        footer: `Plan is read-only; apply writes in dependency order. Supported types: ${BATCH_ADAPTERS.types().join(', ')}.\nSee docs/batch-manifest.md.\n\nExamples:\n  ${EXAMPLES}`,
      }),
    }, { summary: 'Manifest-based batch create/update orchestration' })),
  };
}
