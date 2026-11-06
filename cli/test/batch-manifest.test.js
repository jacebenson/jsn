// Manifest schema, reference syntax and dependency-order validation.
// These are pure: no SDK, no instance, no writes.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MANIFEST_VERSION,
  makeAdapterRegistry,
  parseBatchManifest,
  readRef,
  validateBatchManifest,
} from '../src/batch-manifest.js';
import { catalogBatchAdapters } from '../src/batch-adapters/catalog.js';

const registry = makeAdapterRegistry(catalogBatchAdapters);

function validManifest() {
  return {
    version: MANIFEST_VERSION,
    steps: [
      {
        name: 'laptop',
        type: 'catalog_item',
        operation: 'create',
        fields: { name: 'Laptop', short_description: 'Standard laptop', category: 'Hardware' },
      },
      {
        name: 'cpu',
        type: 'catalog_variable',
        operation: 'create',
        fields: { cat_item: { $ref: 'steps.laptop.sys_id' }, label: 'CPU', type: 'string', mandatory: true },
      },
      {
        name: 'ram',
        type: 'catalog_variable',
        operation: 'create',
        fields: { cat_item: { $ref: 'steps.laptop.sys_id' }, label: 'RAM', type: 'select' },
      },
    ],
  };
}

function issuesOf(fn) {
  try {
    fn();
  } catch (error) {
    assert.equal(error.code, 'usage_error', error.message);
    assert.ok(Array.isArray(error.issues) && error.issues.length > 0, 'error carries issues');
    return error.issues;
  }
  assert.fail('expected a manifest validation error');
}

describe('batch manifest validation', () => {
  it('accepts a valid manifest and orders dependents after their producer', () => {
    const parsed = validateBatchManifest(validManifest(), registry);
    assert.deepEqual(parsed.order, ['laptop', 'cpu', 'ram']);
    assert.deepEqual(parsed.byName.get('cpu').dependsOn, ['laptop']);
    assert.deepEqual(parsed.byName.get('cpu').pendingRefs.map(ref => ref.path), ['steps.laptop.sys_id']);
  });

  it('keeps declaration order for independent steps', () => {
    const manifest = validManifest();
    manifest.steps.push({ name: 'first', type: 'catalog_item', operation: 'create', fields: { name: 'First' } });
    const parsed = validateBatchManifest(manifest, registry);
    assert.deepEqual(parsed.order, ['laptop', 'cpu', 'ram', 'first']);
  });

  it('rejects a manifest that is not a JSON object', () => {
    assert.throws(() => validateBatchManifest([], registry), /must be a JSON object/);
    assert.throws(() => parseBatchManifest('{not json', registry), /not valid JSON/);
  });

  it('rejects an unsupported manifest version', () => {
    const issues = issuesOf(() => validateBatchManifest({ ...validManifest(), version: 2 }, registry));
    assert.ok(issues.some(issue => issue.path === 'version'));
  });

  it('names supported types when a step type is unsupported', () => {
    const manifest = validManifest();
    manifest.steps[1].type = 'catalog_ui_policy';
    const issues = issuesOf(() => validateBatchManifest(manifest, registry));
    const issue = issues.find(item => item.path === 'steps[1].type');
    assert.ok(issue, JSON.stringify(issues));
    assert.match(issue.message, /Unsupported step type "catalog_ui_policy"/);
    assert.match(issue.message, /catalog_item, catalog_variable/);
  });

  it('rejects fields the adapter does not support instead of forwarding them', () => {
    const manifest = validManifest();
    manifest.steps[0].fields.workflow = 'x';
    const issues = issuesOf(() => validateBatchManifest(manifest, registry));
    assert.ok(issues.some(issue => issue.path === 'steps[0].fields.workflow' && /Unsupported catalog_item field/.test(issue.message)));
  });

  it('requires adapter-declared create fields', () => {
    const manifest = validManifest();
    delete manifest.steps[0].fields.name;
    const issues = issuesOf(() => validateBatchManifest(manifest, registry));
    assert.ok(issues.some(issue => issue.path === 'steps[0].fields.name' && /requires field "name"/.test(issue.message)));
  });

  it('requires an explicit target for updates and rejects one for creates', () => {
    const createWithTarget = validManifest();
    createWithTarget.steps[0].target = { sys_id: 'a'.repeat(32) };
    assert.ok(issuesOf(() => validateBatchManifest(createWithTarget, registry))
      .some(issue => /Create steps must not name a target/.test(issue.message)));

    const updateWithoutTarget = validManifest();
    updateWithoutTarget.steps[0].operation = 'update';
    assert.ok(issuesOf(() => validateBatchManifest(updateWithoutTarget, registry))
      .some(issue => issue.path === 'steps[0].target' && /require an explicit target/.test(issue.message)));
  });

  it('rejects a malformed target sys_id and an unsupported matchField', () => {
    const manifest = validManifest();
    manifest.steps[0].operation = 'update';
    manifest.steps[0].target = { sys_id: 'not-a-sys-id' };
    assert.ok(issuesOf(() => validateBatchManifest(manifest, registry))
      .some(issue => issue.path === 'steps[0].target.sys_id'));

    const byField = validManifest();
    byField.steps[0].operation = 'update';
    byField.steps[0].target = { identifier: 'Laptop', matchField: 'short_description' };
    assert.ok(issuesOf(() => validateBatchManifest(byField, registry))
      .some(issue => issue.path === 'steps[0].target.matchField'));

    const sysIdWithScope = validManifest();
    sysIdWithScope.steps[0].operation = 'update';
    sysIdWithScope.steps[0].target = { sys_id: 'a'.repeat(32), scope: { active: 'true' } };
    assert.ok(issuesOf(() => validateBatchManifest(sysIdWithScope, registry))
      .some(issue => /only apply to identifier targets/.test(issue.message)));
  });

  it('rejects references to unknown steps, unknown outputs and wrong step types', () => {
    const unknownStep = validManifest();
    unknownStep.steps[1].fields.cat_item = { $ref: 'steps.nope.sys_id' };
    assert.ok(issuesOf(() => validateBatchManifest(unknownStep, registry))
      .some(issue => /unknown step "nope"/.test(issue.message)));

    const unknownOutput = validManifest();
    unknownOutput.steps[1].fields.cat_item = { $ref: 'steps.laptop.name' };
    assert.ok(issuesOf(() => validateBatchManifest(unknownOutput, registry))
      .some(issue => /does not expose "name"/.test(issue.message)));

    const wrongType = validManifest();
    wrongType.steps.push({
      name: 'third', type: 'catalog_variable', operation: 'create',
      fields: { cat_item: { $ref: 'steps.cpu.sys_id' }, label: 'Third' },
    });
    assert.ok(issuesOf(() => validateBatchManifest(wrongType, registry))
      .some(issue => /accepts references to catalog_item; step "cpu" is catalog_variable/.test(issue.message)));
  });

  it('rejects self references and template-looking strings', () => {
    const selfRef = validManifest();
    selfRef.steps[1].fields.cat_item = { $ref: 'steps.cpu.sys_id' };
    assert.ok(issuesOf(() => validateBatchManifest(selfRef, registry))
      .some(issue => /cannot reference its own output/.test(issue.message)));

    const template = validManifest();
    template.steps[0].fields.name = '${steps.laptop.sys_id}';
    assert.ok(issuesOf(() => validateBatchManifest(template, registry))
      .some(issue => /Template interpolation is unsupported/.test(issue.message)));
  });

  it('rejects arbitrary objects in field values and references on non-string fields', () => {
    const object = validManifest();
    object.steps[1].fields.cat_item = { ref: 'steps.laptop.sys_id' };
    assert.ok(issuesOf(() => validateBatchManifest(object, registry))
      .some(issue => /single-key/.test(issue.message)));

    const booleanRef = validManifest();
    booleanRef.steps[1].fields.mandatory = { $ref: 'steps.laptop.sys_id' };
    assert.ok(issuesOf(() => validateBatchManifest(booleanRef, registry))
      .some(issue => /references are only allowed on string fields/.test(issue.message)));
  });

  it('rejects duplicate step names and invalid names', () => {
    const duplicate = validManifest();
    duplicate.steps[2].name = 'cpu';
    assert.ok(issuesOf(() => validateBatchManifest(duplicate, registry))
      .some(issue => /Duplicate step name/.test(issue.message)));

    const badName = validManifest();
    badName.steps[0].name = '1st step';
    assert.ok(issuesOf(() => validateBatchManifest(badName, registry))
      .some(issue => /Step name must match/.test(issue.message)));
  });

  it('rejects unknown top-level and step fields', () => {
    const top = validManifest();
    top.rollback = true;
    assert.ok(issuesOf(() => validateBatchManifest(top, registry))
      .some(issue => /Unsupported top-level field "rollback"/.test(issue.message)));

    const step = validManifest();
    step.steps[0].after = 'laptop';
    assert.ok(issuesOf(() => validateBatchManifest(step, registry))
      .some(issue => /Unsupported step field "after"/.test(issue.message)));
  });

  it('rejects dependency cycles before anything runs', () => {
    const link = {
      type: 'link', table: 'link', outputs: ['sys_id'], targetField: 'name',
      fields: { name: { type: 'string', requiredOnCreate: true }, parent: { type: 'string', ref: ['link'] } },
    };
    const cyclic = makeAdapterRegistry([link]);
    const issues = issuesOf(() => validateBatchManifest({
      version: MANIFEST_VERSION,
      steps: [
        { name: 'a', type: 'link', operation: 'create', fields: { name: 'A', parent: { $ref: 'steps.b.sys_id' } } },
        { name: 'b', type: 'link', operation: 'create', fields: { name: 'B', parent: { $ref: 'steps.a.sys_id' } } },
      ],
    }, cyclic));
    assert.ok(issues.some(issue => /Dependency cycle detected among steps: a, b/.test(issue.message)), JSON.stringify(issues));
  });

  it('reports every problem in one error instead of only the first', () => {
    const manifest = validManifest();
    manifest.steps[0].fields.nope = 'x';
    manifest.steps[1].type = 'made_up';
    const error = (() => {
      try { validateBatchManifest(manifest, registry); } catch (caught) { return caught; }
      assert.fail('expected failure');
    })();
    assert.ok(error.issues.length >= 2, JSON.stringify(error.issues));
    assert.match(error.message, /and 1 more issue/);
    assert.deepEqual(error.details.issues, error.issues);
  });

  it('readRef only accepts the single-key constrained shape', () => {
    assert.deepEqual(readRef({ $ref: 'steps.a.sys_id' }), 'steps.a.sys_id');
    assert.equal(readRef('plain'), null);
    assert.equal(readRef({ $ref: 'steps.a.sys_id', extra: 1 }), undefined);
    assert.equal(readRef({ value: 'steps.a.sys_id' }), undefined);
  });
});
