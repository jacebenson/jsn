import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('getStringField', () => {
  let getStringField;

  it('extracts simple string fields', async () => {
    ({ getStringField } = await import('../src/helpers.js'));
    assert.strictEqual(getStringField({ number: 'INC001' }, 'number'), 'INC001');
  });

  it('extracts display_value from reference fields', async () => {
    ({ getStringField } = await import('../src/helpers.js'));
    assert.strictEqual(getStringField({ assigned_to: { display_value: 'John Smith', value: 'abc123' } }, 'assigned_to'), 'John Smith');
  });

  it('falls back to value when display_value is absent', async () => {
    ({ getStringField } = await import('../src/helpers.js'));
    assert.strictEqual(getStringField({ category: { value: 'network' } }, 'category'), 'network');
  });

  it('returns empty string for null/undefined', async () => {
    ({ getStringField } = await import('../src/helpers.js'));
    assert.strictEqual(getStringField({}, 'missing'), '');
    assert.strictEqual(getStringField(null, 'field'), '');
    assert.strictEqual(getStringField({ x: null }, 'x'), '');
  });
});

describe('formatRecordForDisplay', () => {
  let formatRecordForDisplay;

  it('extracts simple string fields from records', async () => {
    ({ formatRecordForDisplay } = await import('../src/helpers.js'));
    const record = { sys_id: 'abc123', number: 'INC001', short_description: 'Test incident', priority: '1' };
    const result = formatRecordForDisplay(record, ['number', 'short_description', 'priority']);
    assert.strictEqual(result.number, 'INC001');
    assert.strictEqual(result.short_description, 'Test incident');
    assert.strictEqual(result.priority, '1');
    assert.strictEqual(result.sys_id, 'abc123');
  });

  it('extracts display values from reference fields', async () => {
    ({ formatRecordForDisplay } = await import('../src/helpers.js'));
    const record = {
      sys_id: 'abc123',
      number: { display_value: 'INC001', value: 'sysid1' },
      assigned_to: { display_value: 'John Smith', value: 'user123' },
    };
    const result = formatRecordForDisplay(record, ['number', 'assigned_to']);
    assert.strictEqual(result.number, 'INC001');
    assert.strictEqual(result.assigned_to, 'John Smith');
  });

  it('handles empty records', async () => {
    ({ formatRecordForDisplay } = await import('../src/helpers.js'));
    const result = formatRecordForDisplay({}, ['number']);
    assert.strictEqual(result.number, '');
  });
});

describe('truncateString', () => {
  it('returns short strings unchanged', async () => {
    const { truncateString } = await import('../src/helpers.js');
    assert.strictEqual(truncateString('hello', 10), 'hello');
  });

  it('truncates long strings', async () => {
    const { truncateString } = await import('../src/helpers.js');
    const result = truncateString('This is a very long description', 20);
    assert.strictEqual(result.length, 20);
    assert.ok(result.endsWith('...'));
  });

  it('returns undefined for undefined input', async () => {
    const { truncateString } = await import('../src/helpers.js');
    assert.strictEqual(truncateString(undefined, 10), undefined);
  });
});

describe('isHexString', () => {
  it('detects hex strings', async () => {
    const { isHexString } = await import('../src/helpers.js');
    assert.strictEqual(isHexString('abc123def456'), true);
    assert.strictEqual(isHexString('ABC123'), true);
    assert.strictEqual(isHexString('xyz'), false);
    assert.strictEqual(isHexString(''), false);
  });
});

describe('extractProfileName', () => {
  it('extracts profile name from instance URL', async () => {
    const { extractProfileName } = await import('../src/helpers.js');
    assert.strictEqual(extractProfileName('https://dev12345.service-now.com'), 'dev12345');
    assert.strictEqual(extractProfileName('dev12345.service-now.com'), 'dev12345');
  });
});

describe('buildQuerySuffix', () => {
  it('builds query suffix', async () => {
    const { buildQuerySuffix } = await import('../src/helpers.js');
    assert.strictEqual(buildQuerySuffix('active=true'), ' --query "active=true"');
    assert.strictEqual(buildQuerySuffix(''), '');
  });
});

describe('parseDataArg', () => {
  let tmpDir, tmpFile;

  it('parses inline JSON', async () => {
    const { parseDataArg } = await import('../src/helpers.js');
    const result = parseDataArg({ data: '{"key": "value", "num": 42}' });
    assert.deepStrictEqual(result, { key: 'value', num: 42 });
  });

  it('reads JSON from file', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsn-test-'));
    tmpFile = path.join(tmpDir, 'payload.json');
    fs.writeFileSync(tmpFile, '{"from": "file", "active": true}');
    const { parseDataArg } = await import('../src/helpers.js');
    const result = parseDataArg({ 'data-file': tmpFile });
    assert.deepStrictEqual(result, { from: 'file', active: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws when no data or data-file', async () => {
    const { parseDataArg } = await import('../src/helpers.js');
    assert.throws(() => parseDataArg({}), /--data, --data-file, or --data-stdin is required/);
  });

  it('throws on invalid JSON', async () => {
    const { parseDataArg } = await import('../src/helpers.js');
    assert.throws(() => parseDataArg({ data: '{invalid}' }), /Invalid JSON/);
  });
});

describe('verifyWriteBack', () => {
  it('reports fields that were dropped server-side', async () => {
    const { verifyWriteBack } = await import('../src/helpers.js');
    const app = {
      sdk: {
        list: async () => [{
          sys_id: 'rec123',
          ui_policy: { display_value: '', value: '' },
          mandatory: 'true',
        }],
      },
    };
    const mismatches = await verifyWriteBack(app, 'catalog_ui_policy_action', 'rec123', {
      ui_policy: 'pol456',
      mandatory: 'true',
    });
    assert.strictEqual(mismatches.length, 1);
    assert.strictEqual(mismatches[0].field, 'ui_policy');
    assert.strictEqual(mismatches[0].sent, 'pol456');
    assert.strictEqual(mismatches[0].got, '');
  });

  it('passes when all fields persisted', async () => {
    const { verifyWriteBack } = await import('../src/helpers.js');
    const app = {
      sdk: {
        list: async () => [{
          sys_id: 'rec123',
          catalog_variable: { display_value: 'IO:var789', value: 'IO:var789' },
          mandatory: 'true',
        }],
      },
    };
    const mismatches = await verifyWriteBack(app, 'catalog_ui_policy_action', 'rec123', {
      catalog_variable: 'IO:var789',
      mandatory: 'true',
    });
    assert.strictEqual(mismatches.length, 0);
  });

  it('normalizes {"value": ...} supplied objects', async () => {
    const { verifyWriteBack } = await import('../src/helpers.js');
    const app = {
      sdk: {
        list: async () => [{
          sys_id: 'rec123',
          assigned_to: { display_value: 'John Smith', value: 'user456' },
        }],
      },
    };
    const mismatches = await verifyWriteBack(app, 'incident', 'rec123', {
      assigned_to: { value: 'user456' },
    });
    assert.strictEqual(mismatches.length, 0);
  });

  it('skips sys_* fields (system-managed)', async () => {
    const { verifyWriteBack } = await import('../src/helpers.js');
    const app = {
      sdk: {
        list: async () => [{ sys_id: 'rec123', sys_updated_on: '2026-01-01' }],
      },
    };
    const mismatches = await verifyWriteBack(app, 'incident', 'rec123', {
      sys_updated_on: '2026-01-01',
    });
    assert.strictEqual(mismatches.length, 0);
  });

  it('returns empty for missing sys_id', async () => {
    const { verifyWriteBack } = await import('../src/helpers.js');
    const app = { sdk: { list: async () => [] } };
    const mismatches = await verifyWriteBack(app, 'incident', '', { short_description: 'x' });
    assert.strictEqual(mismatches.length, 0);
  });

  it('reports GET failure without throwing', async () => {
    const { verifyWriteBack } = await import('../src/helpers.js');
    const app = {
      sdk: {
        list: async () => { throw new Error('network down'); },
      },
    };
    const mismatches = await verifyWriteBack(app, 'incident', 'rec123', { short_description: 'x' });
    assert.strictEqual(mismatches.length, 1);
    assert.ok(mismatches[0].got.includes('write-back check failed'));
  });

  it('reports record not found after write', async () => {
    const { verifyWriteBack } = await import('../src/helpers.js');
    const app = { sdk: { list: async () => [] } };
    const mismatches = await verifyWriteBack(app, 'incident', 'rec123', { short_description: 'x' });
    assert.strictEqual(mismatches.length, 1);
    assert.ok(mismatches[0].got.includes('record not found'));
  });
});
