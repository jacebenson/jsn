// Shared manifest-based batch engine.
//
// The engine owns what is common to every artifact domain: dependency-ordered
// execution, constrained reference resolution, per-step status, partial
// results and the safety checks that must hold for *every* applied step.
// Adapters own domain payloads and the actual create/update call.
//
// Nothing here is catalog-specific. A new domain is an adapter plus a
// manifest `type`, not a second orchestration path.
//
// Guarantees:
//   - plan() performs GET-only reads and zero writes.
//   - apply() resolves every explicit update target before the first write,
//     so an ambiguous/missing target cannot leave a half-applied batch.
//   - a batch is not an atomic ServiceNow transaction; there is no automatic
//     rollback or replay.
//   - the capture context is re-read before every step; if it becomes a
//     blocked context (or the profile is read-only) the batch stops before
//     that step and reports completed work plus skipped dependents.

import { readCaptureContext } from './mutation-context.js';
import { assertSafeExactMatch, getStringField } from './helpers.js';
import { unwrapSysId } from './resolve-record.js';
import { AppError, CodeAmbiguous, CodeConfirmationRequired, CodeNotFound, errUsage } from './errors.js';
import { parseRefPath, readRef } from './batch-manifest.js';

const COMPLETED_STATES = ['complete', 'completed'];

function stepError(step, error) {
  error.message = `Step "${step.name}" (${step.type}): ${error.message}`;
  return error;
}

function notFound(table, label, identifier) {
  const error = new AppError(CodeNotFound, `${label} not found: ${identifier}`,
    'Update steps must name an existing artifact; create it in a create step or correct the target.');
  error.resolution = { table, field: 'identifier', mode: 'exact', matches: 0 };
  return error;
}

/**
 * Resolve an explicit update target to a sys_id.
 *
 * Targets accept a full sys_id, or an exact identifier (plus optional
 * allowlisted `scope` constraints). Exact-only matching: there is no partial
 * sys_id or display-name guessing. Multiple matches are ambiguous and fail.
 */
export async function resolveUpdateTarget(sdk, step) {
  const { adapter, target } = step;
  if (!target) throw errUsage(`Step "${step.name}" has no target.`);
  if (target.sys_id) {
    let record;
    try {
      record = await sdk.get(adapter.table, target.sys_id);
    } catch (error) {
      throw stepError(step, error);
    }
    if (!record) throw stepError(step, notFound(adapter.table, adapter.label, target.sys_id));
    return {
      sys_id: target.sys_id,
      match_field: 'sys_id',
      matched: getStringField(record, adapter.targetField || 'name') || null,
    };
  }
  try {
    assertSafeExactMatch(target.identifier);
  } catch (error) {
    throw stepError(step, errUsage(error.message));
  }
  const clauses = [];
  for (const [field, value] of Object.entries(target.scope || {})) {
    try {
      assertSafeExactMatch(value);
    } catch (error) {
      throw stepError(step, errUsage(`${error.message} (target.scope.${field})`));
    }
    clauses.push(`${field}=${value}`);
  }
  const matchField = target.matchField;
  clauses.push(`${matchField}=${target.identifier}`);
  const params = new URLSearchParams();
  params.set('sysparm_query', clauses.join('^'));
  params.set('sysparm_limit', '2');
  params.set('sysparm_fields', ['sys_id', adapter.targetField, ...Object.keys(target.scope || {})].filter(Boolean).join(','));
  let rows;
  try {
    rows = await sdk.list(adapter.table, params);
  } catch (error) {
    throw stepError(step, error);
  }
  if (!Array.isArray(rows)) {
    throw stepError(step, errUsage(`Malformed ${adapter.table} target lookup: expected an array of records; treat the target as unresolved.`));
  }
  if (rows.length === 0) throw stepError(step, notFound(adapter.table, adapter.label, target.identifier));
  if (rows.length > 1) {
    const error = new AppError(CodeAmbiguous,
      `Multiple ${adapter.label.toLowerCase()}s match ${matchField} "${target.identifier}"` +
      (Object.keys(target.scope || {}).length ? ` within the supplied scope.` : '.'),
      'Supply target.sys_id, or narrow with target.scope / a longer exact identifier.');
    error.resolution = { table: adapter.table, field: matchField, mode: 'exact', matches: 2, at_least: true };
    throw stepError(step, error);
  }
  const sysId = unwrapSysId(rows[0]);
  if (!sysId) throw stepError(step, errUsage('The matched record has no readable sys_id; check field ACLs.'));
  return { sys_id: sysId, match_field: matchField, matched: getStringField(rows[0], adapter.targetField) || null };
}

/** Substitute resolved step outputs into a field value (or return it as-is). */
export function resolveReference(value, outputs, location = 'value') {
  const ref = readRef(value);
  if (ref === null) return value;
  if (ref === undefined) throw errUsage(`${location}: only a single-key {"$ref": "steps.<name>.<output>"} object is supported.`);
  const parsed = parseRefPath(ref);
  if (!parsed) throw errUsage(`${location}: invalid reference "${ref}"; expected "steps.<step-name>.<output>".`);
  const produced = outputs[parsed.step];
  if (!produced || produced[parsed.output] === undefined || produced[parsed.output] === null) {
    throw errUsage(`${location}: reference "${ref}" did not resolve; step "${parsed.step}" produced no "${parsed.output}".`);
  }
  return produced[parsed.output];
}

function resolvedFields(step, outputs) {
  const fields = {};
  for (const [name, value] of Object.entries(step.fields)) {
    fields[name] = resolveReference(value, outputs, `steps.${step.name}.fields.${name}`);
  }
  return fields;
}

function pendingReferences(step) {
  const refs = [];
  for (const [field, value] of Object.entries(step.fields)) {
    const ref = readRef(value);
    if (typeof ref === 'string') refs.push({ location: `fields.${field}`, ref });
  }
  return refs;
}

function contextKey(context) {
  if (!context) return 'unknown';
  return `${context.scope || 'unknown'}|${context.update_set?.sys_id || 'unknown'}|${context.update_set?.state || 'unknown'}`;
}

function contextSummary(context) {
  if (!context) return null;
  return {
    scope: context.scope || null,
    update_set: context.update_set ? {
      name: context.update_set.name || null,
      sys_id: context.update_set.sys_id || null,
      state: context.update_set.state || null,
    } : null,
    approval_required: context.approval_required === true,
    approved: context.approved === true,
  };
}

/**
 * Classify a capture context as blocked for a write. Returns a stop reason
 * (never prompts) — the command-level guard owns interactive approval.
 */
export function blockedContextReason(context, { force = false, approved = false } = {}) {
  if (!context) return null;
  const state = context.update_set?.state?.toLowerCase();
  if (state && COMPLETED_STATES.includes(state)) {
    return { code: 'update_set_not_in_progress',
      message: `Selected update set ${context.update_set.name} is ${context.update_set.state}; select an in-progress capture set.`,
      hint: 'Run: jsn updatesets set' };
  }
  if (context.scope?.toLowerCase() === 'global' && context.update_set?.name?.toLowerCase() === 'default'
    && !force && !approved) {
    return { code: CodeConfirmationRequired,
      message: 'Capture context changed to Global scope + Default update set; the remaining batch requires explicit approval.',
      hint: 'Ask the user to approve this exact batch, then rerun with --force, or select a dedicated update set.' };
  }
  return null;
}

/**
 * Plan a manifest. Read-only: resolves update targets and adapter payloads
 * (which may GET reference metadata) but never calls create/update.
 */
export async function planBatch({ sdk, manifest, instance = '', readContext = readCaptureContext }) {
  const steps = [];
  for (const name of manifest.order) {
    const step = manifest.byName.get(name);
    const target = step.target
      ? { mode: 'update', ...(await resolveUpdateTarget(sdk, step)) }
      : { mode: 'create' };
    let prepared;
    try {
      prepared = await step.adapter.prepare({ sdk, operation: step.operation, fields: step.fields });
    } catch (error) {
      throw stepError(step, error);
    }
    steps.push({
      name: step.name,
      type: step.type,
      table: step.adapter.table,
      operation: step.operation,
      status: 'planned',
      depends_on: [...step.dependsOn],
      target,
      payload: prepared.payload,
      pending_refs: pendingReferences(step),
      produces: (step.adapter.outputs || []).map(output => `steps.${step.name}.${output}`),
      notes: prepared.notes || [],
    });
  }
  let context = null;
  if (sdk) {
    try { context = await readContext(sdk); } catch { context = null; }
  }
  return {
    command: 'batch plan',
    instance: instance || null,
    manifest: { version: manifest.version, description: manifest.description, steps: manifest.steps.length },
    context: contextSummary(context),
    context_diagnostics: context?.diagnostics || [],
    order: [...manifest.order],
    counts: {
      steps: steps.length,
      creates: steps.filter(step => step.operation === 'create').length,
      updates: steps.filter(step => step.operation === 'update').length,
      writes: 0,
    },
    partial: false,
    writes_performed: false,
    steps,
  };
}

/**
 * Apply a manifest in dependency order.
 *
 * @param {object} options
 * @param {object} options.sdk
 * @param {object} options.manifest — validated manifest
 * @param {object} [options.app] — App (session read-only check + instance)
 * @param {object} [options.argv] — accepts `force` for capture-context approval
 * @param {object|null} [options.initialContext] — context approved at command start
 * @param {Function} [options.readContext] — injectable context reader
 * @returns {Promise<object>} result with per-step statuses, resolved IDs, counts
 */
export async function applyBatch({
  sdk, manifest, app = null, argv = {}, initialContext = null,
  readContext = readCaptureContext,
}) {
  const steps = [];
  const outputs = {};
  const failed = new Set();
  const skipped = new Set();
  const contextChanges = [];
  let stop = null;
  const baseline = initialContext || null;
  let lastContext = baseline;

  // Preflight: every explicit update target must resolve before any write.
  const targets = new Map();
  for (const name of manifest.order) {
    const step = manifest.byName.get(name);
    if (!step.target) continue;
    targets.set(name, await resolveUpdateTarget(sdk, step));
  }

  for (const name of manifest.order) {
    const step = manifest.byName.get(name);
    const dependsOnUnfinished = step.dependsOn.find(dep => failed.has(dep) || skipped.has(dep));
    if (dependsOnUnfinished) {
      skipped.add(name);
      steps.push(baseStep(step, { status: 'skipped',
        skipped_reason: `dependency "${dependsOnUnfinished}" did not complete` }));
      continue;
    }

    // Safety is evaluated for the step about to write, not just once per run.
    const safety = await checkSafety({ sdk, app, argv, baseline, readContext });
    if (safety.context && contextKey(safety.context) !== contextKey(lastContext)) {
      contextChanges.push({
        step: name,
        before: contextSummary(lastContext),
        after: contextSummary(safety.context),
      });
      lastContext = safety.context;
    }
    if (safety.stop) {
      stop = safety.stop;
      skipped.add(name);
      steps.push(baseStep(step, { status: 'skipped', skipped_reason: `safety stop: ${stop.code}` }));
      continue;
    }

    let fields;
    try {
      fields = resolvedFields(step, outputs);
    } catch (error) {
      failed.add(name);
      steps.push(baseStep(step, { status: 'failed', error: { code: error.code || 'usage_error', message: error.message } }));
      continue;
    }

    let prepared;
    try {
      prepared = await step.adapter.prepare({ sdk, operation: step.operation, fields });
    } catch (error) {
      failed.add(name);
      steps.push(baseStep(step, { status: 'failed', error: { code: error.code || 'api_error', message: error.message } }));
      continue;
    }

    try {
      let record;
      if (step.operation === 'create') {
        record = await step.adapter.create({ sdk, payload: prepared.payload, step });
      } else {
        const resolved = targets.get(name);
        record = await step.adapter.update({ sdk, sysId: resolved.sys_id, payload: prepared.payload, step });
      }
      const sysId = unwrapSysId(record) || (step.operation === 'update' ? targets.get(name)?.sys_id : '') || '';
      if (!sysId) {
        throw errUsage('The write returned no readable sys_id; treat this step as unverified and inspect the instance before retrying.');
      }
      outputs[name] = { sys_id: sysId };
      steps.push(baseStep(step, {
        status: step.operation === 'create' ? 'created' : 'updated',
        sys_id: sysId,
        target: step.operation === 'update' ? targets.get(name) : undefined,
        payload: prepared.payload,
        notes: prepared.notes || [],
      }));
    } catch (error) {
      failed.add(name);
      steps.push(baseStep(step, {
        status: 'failed',
        target: step.operation === 'update' ? targets.get(name) : undefined,
        payload: prepared.payload,
        error: { code: error.code || 'api_error', message: error.message },
      }));
    }
  }

  const counts = {
    total: steps.length,
    created: steps.filter(step => step.status === 'created').length,
    updated: steps.filter(step => step.status === 'updated').length,
    failed: steps.filter(step => step.status === 'failed').length,
    skipped: steps.filter(step => step.status === 'skipped').length,
  };
  const partial = counts.failed > 0 || counts.skipped > 0 || Boolean(stop);
  return {
    command: 'batch apply',
    instance: app?.getEffectiveInstance?.() || null,
    manifest: { version: manifest.version, description: manifest.description, steps: manifest.steps.length },
    context: contextSummary(baseline),
    context_diagnostics: baseline?.diagnostics || [],
    context_changes: contextChanges,
    order: [...manifest.order],
    counts,
    partial,
    writes_performed: counts.created + counts.updated > 0,
    stopped: stop,
    steps,
    recovery: partial ? recoveryGuidance(counts, stop) : [],
  };
}

function baseStep(step, extra) {
  return {
    name: step.name,
    type: step.type,
    table: step.adapter.table,
    operation: step.operation,
    depends_on: [...step.dependsOn],
    ...extra,
  };
}

async function checkSafety({ sdk, app, argv, baseline, readContext }) {
  if (app?.session?.readOnly === true) {
    return { stop: { code: 'read_only', message: `Profile "${app.session.profileName}" is read-only; the batch stopped before the next write.`,
      hint: 'Switch to a write-enabled profile first: jsn auth switch <name>' } };
  }
  if (!sdk) return {};
  let context;
  try {
    context = await readContext(sdk);
  } catch {
    // An unreadable context stays unknown; it is not evidence of an unsafe
    // context and does not by itself block a write (matching the guard).
    return {};
  }
  const blocked = blockedContextReason(context, {
    force: argv.force === true,
    approved: baseline?.approved === true,
  });
  if (blocked) return { stop: blocked, context };
  return { context };
}

function recoveryGuidance(counts, stop) {
  const lines = [
    'A batch is not an atomic ServiceNow transaction: successful steps remain in place and are not rolled back.',
    'Re-run recovery rule: remove or convert the completed steps before re-running (a retry must not recreate them).',
    'Use each step\'s resolved sys_id below to reconcile or convert successful steps into explicit update steps.',
  ];
  if (counts.failed) lines.push('Inspect failed steps on the instance before retrying; no automatic retry or replay was attempted.');
  if (counts.skipped) lines.push('Skipped steps made no change; retry them only after their dependency succeeds.');
  if (stop) lines.push(`The batch stopped early (${stop.code}): ${stop.message}`);
  return lines;
}
