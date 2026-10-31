import { describe, it } from 'node:test';
import assert from 'node:assert';
import { isHexString } from '../src/helpers.js';

describe('inspectRecord', () => {
  it('should detect 32-char hex string as sys_id', () => {
    const id = 'ac912768839d4710f7bfc670ceaad358';
    assert.ok(isHexString(id));
    assert.strictEqual(id.length, 32);
  });

  it('should not treat a number as sys_id', () => {
    assert.strictEqual(isHexString('INC0010001'), false);
  });

  it('should export inspectRecord function', async () => {
    const { inspectRecord } = await import('../src/records/inspect.js');
    assert.strictEqual(typeof inspectRecord, 'function');
  });

  it('should export resolveIdentifier function', async () => {
    const { resolveIdentifier } = await import('../src/records/inspect.js');
    assert.strictEqual(typeof resolveIdentifier, 'function');
  });

  it('should format inspect output for empty data', async () => {
    const { formatInspectOutput } = await import('../src/records/inspect.js');
    const result = formatInspectOutput({ table: 'incident', sys_id: 'abc123', history: [], businessRules: [], flows: [] });
    assert.ok(result.includes('incident'));
    assert.ok(result.includes('HISTORY'));
    assert.ok(result.includes('BUSINESS RULES'));
    assert.ok(result.includes('RUNNING FLOWS'));
  });
});
