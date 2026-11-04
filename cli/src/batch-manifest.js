// Batch manifest schema, reference syntax and dependency validation.
//
// A manifest describes a set of related artifact steps. This module is pure:
// it parses and validates the document, resolves the constrained `$ref`
// syntax into dependency edges, and returns a dependency-ordered step list.
// It performs no SDK calls and never writes — the engine and adapters own
// transport.
//
// Reference syntax (deliberately not a template language):
//
//   { "$ref": "steps.<step-name>.<output>" }
//
// Only an output declared by the referenced step's adapter is addressable.
// There is no string interpolation, no `${...}`, no JavaScript evaluation and
// no expression language. A string that looks like a template is a validation
// error rather than a silent literal.

import { errUsage, AppError, CodeUsage } from './errors.js';
import { isSysId } from './resolve-record.js';

export const MANIFEST_VERSION = 1;
export const REF_PREFIX = 'steps.';
const STEP_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const FIELD_NAME = /^[a-z][a-z0-9_]*$/;
const REF_PATH = /^steps\.([A-Za-z][A-Za-z0-9_-]{0,63})\.([a-z][a-z0-9_]*)$/;
const TEMPLATE = /\$\{|\{\{/;

const TOP_LEVEL_KEYS = new Set(['version', 'steps', 'description']);
const STEP_KEYS = new Set(['name', 'type', 'operation', 'fields', 'target']);
const TARGET_KEYS = new Set(['sys_id', 'identifier', 'matchField', 'scope']);

/**
 * Build the adapter registry the validator and engine share.
 * Adapters are keyed by their manifest `type` string.
 *
 * @param {Array<object>} adapters
 * @returns {{get: (type: string) => object|undefined, types: () => string[], adapters: Array<object>}}
 */
export function makeAdapterRegistry(adapters) {
  if (!Array.isArray(adapters)) throw new Error('Batch adapters must be an array');
  const map = new Map();
  for (const adapter of adapters) {
    if (!adapter || typeof adapter.type !== 'string' || !adapter.type) throw new Error('Each batch adapter needs a type');
    if (map.has(adapter.type)) throw new Error(`Duplicate batch adapter type: ${adapter.type}`);
    map.set(adapter.type, adapter);
  }
  return { get: (type) => map.get(type), types: () => [...map.keys()], adapters };
}

/**
 * A constrained reference object, or a marker describing why it is invalid.
 * Returns null for non-objects, undefined for objects that are not exactly
 * one `$ref` key, and the reference string otherwise.
 */
export function readRef(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === '$ref') return value.$ref;
  return undefined;
}

/** Parse "steps.<name>.<output>"; returns {step, output} or null. */
export function parseRefPath(value) {
  const match = typeof value === 'string' && REF_PATH.exec(value);
  return match ? { step: match[1], output: match[2] } : null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate and normalize a manifest.
 *
 * @param {object} input — parsed JSON manifest
 * @param {ReturnType<typeof makeAdapterRegistry>} registry
 * @returns {{version: number, description: string, steps: Array<object>, order: string[], byName: Map<string, object>}}
 * @throws {AppError} code usage_error, `.issues` holds every problem found
 */
export function validateBatchManifest(input, registry) {
  const issues = [];
  const add = (path, message) => issues.push({ path, message });

  if (!isPlainObject(input)) {
    throw new AppError(CodeUsage, 'Batch manifest must be a JSON object.', manifestHint(), 0, null);
  }
  for (const key of Object.keys(input)) {
    if (!TOP_LEVEL_KEYS.has(key)) add(key, `Unsupported top-level field "${key}"; supported: version, steps, description.`);
  }
  if (input.version !== MANIFEST_VERSION) {
    add('version', `Manifest version must be ${MANIFEST_VERSION}.`);
  }
  if (input.description !== undefined && typeof input.description !== 'string') {
    add('description', 'description must be a string.');
  }
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    add('steps', 'steps must be a nonempty array.');
    throw invalidManifest(issues);
  }

  const supported = registry.types();
  const steps = [];
  const byName = new Map();

  for (const [index, raw] of input.steps.entries()) {
    const path = `steps[${index}]`;
    if (!isPlainObject(raw)) {
      add(path, 'Each step must be an object.');
      continue;
    }
    for (const key of Object.keys(raw)) {
      if (!STEP_KEYS.has(key)) add(`${path}.${key}`, `Unsupported step field "${key}"; supported: name, type, operation, fields, target.`);
    }
    if (typeof raw.name !== 'string' || !STEP_NAME.test(raw.name)) {
      add(`${path}.name`, 'Step name must match [A-Za-z][A-Za-z0-9_-]* (max 64 chars).');
      continue;
    }
    if (byName.has(raw.name)) {
      add(`${path}.name`, `Duplicate step name "${raw.name}"; step names are the reference namespace and must be unique.`);
      continue;
    }
    const adapter = registry.get(raw.type);
    if (typeof raw.type !== 'string' || !adapter) {
      add(`${path}.type`, `Unsupported step type "${raw.type}"; supported types: ${supported.join(', ')}.`);
      continue;
    }
    if (raw.operation !== 'create' && raw.operation !== 'update') {
      add(`${path}.operation`, 'operation must be "create" or "update".');
      continue;
    }
    if (raw.fields !== undefined && !isPlainObject(raw.fields)) {
      add(`${path}.fields`, 'fields must be an object.');
      continue;
    }
    const fields = raw.fields || {};
    if (raw.operation === 'create' && Object.keys(fields).length === 0) {
      add(`${path}.fields`, 'A create step needs at least one field.');
    }
    if (raw.operation === 'update' && Object.keys(fields).length === 0) {
      add(`${path}.fields`, 'An update step must change at least one field.');
    }

    const step = {
      name: raw.name,
      type: raw.type,
      operation: raw.operation,
      fields,
      target: null,
      adapter,
      dependsOn: [],
      index,
    };

    // Field names/types are adapter-declared. Unknown fields fail loudly
    // instead of being forwarded as unconstrained table writes.
    for (const [field, value] of Object.entries(fields)) {
      const spec = adapter.fields?.[field];
      if (!spec) {
        add(`${path}.fields.${field}`, `Unsupported ${raw.type} field "${field}"; supported: ${Object.keys(adapter.fields || {}).join(', ')}.`);
        continue;
      }
      if (raw.operation === 'create' && spec.updateOnly === true) {
        add(`${path}.fields.${field}`, `Field "${field}" is update-only for ${raw.type}.`);
        continue;
      }
      if (raw.operation === 'update' && spec.createOnly === true) {
        add(`${path}.fields.${field}`, `Field "${field}" is create-only for ${raw.type}.`);
        continue;
      }
      const ref = readRef(value);
      if (ref !== null) {
        if (ref === undefined) {
          add(`${path}.fields.${field}`, 'Only a single-key {"$ref": "steps.<name>.<output>"} object is supported; arbitrary objects are not.');
          continue;
        }
        if (spec.type !== 'string') {
          add(`${path}.fields.${field}`, `Field "${field}" is ${spec.type}; references are only allowed on string fields.`);
          continue;
        }
        if (!spec.ref) {
          add(`${path}.fields.${field}`, `Field "${field}" does not accept references; supply a literal value.`);
          continue;
        }
        const match = typeof ref === 'string' && REF_PATH.exec(ref);
        if (!match) {
          add(`${path}.fields.${field}`, `Invalid reference "${ref}"; expected "steps.<step-name>.<output>".`);
          continue;
        }
        step.pendingRefs = step.pendingRefs || [];
        step.pendingRefs.push({ location: `${path}.fields.${field}`, field, path: ref, step: match[1], output: match[2], types: spec.ref });
        continue;
      }
      if (TEMPLATE.test(String(value))) {
        add(`${path}.fields.${field}`, 'Template interpolation is unsupported; use a {"$ref": ...} object or a literal string.');
        continue;
      }
      if (!fieldValueMatches(value, spec.type)) {
        add(`${path}.fields.${field}`, `Field "${field}" must be ${spec.type}.`);
      }
    }

    if (raw.operation === 'create') {
      for (const [field, spec] of Object.entries(adapter.fields || {})) {
        if (spec.requiredOnCreate && fields[field] === undefined) {
          add(`${path}.fields.${field}`, `Creating ${raw.type} requires field "${field}".`);
        }
      }
      if (raw.target !== undefined) {
        add(`${path}.target`, 'Create steps must not name a target; existing artifacts must use operation "update" with an explicit target.');
      }
    } else {
      if (raw.target === undefined) {
        add(`${path}.target`, 'Update steps require an explicit target (sys_id, or identifier with matchField).');
      } else {
        step.target = validateTarget(raw.target, adapter, path, add);
      }
    }

    if (adapter.validate) {
      const problem = adapter.validate({ operation: raw.operation, fields });
      if (problem) add(`${path}.fields`, problem);
    }

    steps.push(step);
    byName.set(step.name, step);
  }

  // Reference targets need every step name known, so this is a second pass.
  for (const step of steps) {
    for (const ref of step.pendingRefs || []) {
      const target = byName.get(ref.step);
      if (!target) {
        add(ref.location, `Reference "${ref.path}" names unknown step "${ref.step}".`);
        continue;
      }
      if (target === step) {
        add(ref.location, `Step "${step.name}" cannot reference its own output.`);
        continue;
      }
      if (!target.adapter.outputs?.includes(ref.output)) {
        add(ref.location, `Step "${ref.step}" (${target.type}) does not expose "${ref.output}"; available: ${(target.adapter.outputs || []).join(', ')}.`);
        continue;
      }
      if (!ref.types.includes(target.type)) {
        add(ref.location, `Field "${ref.field}" accepts references to ${ref.types.join(', ')}; step "${ref.step}" is ${target.type}.`);
        continue;
      }
      if (!step.dependsOn.includes(target.name)) step.dependsOn.push(target.name);
    }
  }

  const order = dependencyOrder(steps, add);
  if (issues.length) throw invalidManifest(issues);
  return { version: MANIFEST_VERSION, description: input.description || '', steps, order, byName };
}

function validateTarget(raw, adapter, path, add) {
  if (!isPlainObject(raw)) {
    add(`${path}.target`, 'target must be an object.');
    return null;
  }
  for (const key of Object.keys(raw)) {
    if (!TARGET_KEYS.has(key)) add(`${path}.target.${key}`, `Unsupported target field "${key}"; supported: sys_id, identifier, matchField, scope.`);
  }
  const target = { sys_id: null, identifier: null, matchField: null, scope: {} };
  const hasSysId = raw.sys_id !== undefined;
  const hasIdentifier = raw.identifier !== undefined;
  if (hasSysId === hasIdentifier) {
    add(`${path}.target`, 'target needs exactly one of sys_id or identifier.');
    return target;
  }
  if (hasSysId) {
    if (!isSysId(raw.sys_id)) add(`${path}.target.sys_id`, 'target.sys_id must be a 32-character hex sys_id.');
    else target.sys_id = raw.sys_id;
    if (raw.matchField !== undefined || raw.scope !== undefined) {
      add(`${path}.target`, 'matchField and scope only apply to identifier targets, not a sys_id target.');
    }
  } else {
    if (typeof raw.identifier !== 'string' || !raw.identifier.trim()) {
      add(`${path}.target.identifier`, 'target.identifier must be a nonempty string.');
    } else {
      target.identifier = raw.identifier;
    }
    const matchField = raw.matchField ?? adapter.targetField;
    if (!matchField || !FIELD_NAME.test(matchField)) {
      add(`${path}.target.matchField`, `${adapter.type} updates need an explicit matchField.`);
    } else if (!(adapter.targetMatchFields || [adapter.targetField]).includes(matchField)) {
      add(`${path}.target.matchField`, `Unsupported matchField "${matchField}" for ${adapter.type}; supported: ${(adapter.targetMatchFields || [adapter.targetField]).join(', ')}.`);
    } else {
      target.matchField = matchField;
    }
  }
  if (raw.scope !== undefined) {
    if (!isPlainObject(raw.scope)) {
      add(`${path}.target.scope`, 'target.scope must be an object of field: value constraints.');
    } else {
      for (const [field, value] of Object.entries(raw.scope)) {
        if (!(adapter.targetScopeFields || []).includes(field)) {
          add(`${path}.target.scope.${field}`, `Unsupported scope field "${field}" for ${adapter.type}; supported: ${(adapter.targetScopeFields || []).join(', ') || '(none)'}.`);
          continue;
        }
        if (field === target.matchField) {
          add(`${path}.target.scope.${field}`, 'scope must not repeat the matchField.');
          continue;
        }
        // Targets are resolved before any write, so scope values must be
        // literal. Generated IDs belong in fields, not in target selection.
        if (typeof value !== 'string' || !value.trim()) {
          add(`${path}.target.scope.${field}`, `scope.${field} must be a nonempty literal string; references are not allowed in targets.`);
          continue;
        }
        target.scope[field] = value;
      }
    }
  }
  return target;
}

function fieldValueMatches(value, type) {
  if (type === 'string') return typeof value === 'string';
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'integer') return Number.isInteger(value);
  return false;
}

function dependencyOrder(steps, add) {
  const indegree = new Map(steps.map((step) => [step.name, step.dependsOn.length]));
  const dependents = new Map(steps.map((step) => [step.name, []]));
  for (const step of steps) {
    for (const dependency of step.dependsOn) dependents.get(dependency).push(step.name);
  }
  // Declaration order keeps independent steps predictable between runs:
  // a newly-ready dependent is inserted by its manifest position, not
  // appended behind unrelated steps that were already ready.
  const index = new Map(steps.map((step) => [step.name, step.index]));
  const ready = steps.filter((step) => indegree.get(step.name) === 0).map((step) => step.name);
  const insert = (name) => {
    ready.push(name);
    ready.sort((a, b) => index.get(a) - index.get(b));
  };
  const order = [];
  while (ready.length) {
    const name = ready.shift();
    order.push(name);
    for (const dependent of dependents.get(name)) {
      indegree.set(dependent, indegree.get(dependent) - 1);
      if (indegree.get(dependent) === 0) insert(dependent);
    }
  }
  if (order.length !== steps.length) {
    const blocked = steps.filter((step) => indegree.get(step.name) > 0).map((step) => step.name);
    add('steps', `Dependency cycle detected among steps: ${blocked.join(', ')}. References must form a directed acyclic graph.`);
  }
  return order;
}

function manifestHint() {
  return 'See docs/batch-manifest.md for the manifest schema and reference syntax.';
}

function invalidManifest(issues) {
  const first = issues[0];
  const count = issues.length;
  const error = new AppError(
    CodeUsage,
    `Invalid batch manifest: ${first.path ? `${first.path}: ` : ''}${first.message}${count > 1 ? ` (and ${count - 1} more issue${count > 2 ? 's' : ''})` : ''}`,
    manifestHint(),
  );
  error.issues = issues;
  error.details = { issues };
  return error;
}

/** Convenience for callers that only need the parsed/validated document text. */
export function parseBatchManifest(text, registry) {
  let input;
  try {
    input = JSON.parse(text);
  } catch (error) {
    throw errUsage(`Batch manifest is not valid JSON: ${error.message}`);
  }
  return validateBatchManifest(input, registry);
}
