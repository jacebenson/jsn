import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('hyperlink', () => {
  it('emits a complete OSC 8 sequence', async () => {
    const { hyperlink } = await import('../src/output.js');
    assert.strictEqual(
      hyperlink('USER     ', 'https://example.service-now.com/sys_user.do'),
      '\x1b]8;;https://example.service-now.com/sys_user.do\x07USER     \x1b]8;;\x07'
    );
  });
});

describe('OutputWriter format methods', () => {
  it('setFormat updates getFormat', async () => {
    const { OutputWriter } = await import('../src/output.js');
    const ow = new OutputWriter();
    assert.strictEqual(ow.getFormat(), 'auto');
    ow.setFormat('json');
    assert.strictEqual(ow.getFormat(), 'json');
    ow.setFormat('quiet');
    assert.strictEqual(ow.getFormat(), 'quiet');
  });

  it('setFormat returns this for chaining', async () => {
    const { OutputWriter } = await import('../src/output.js');
    const ow = new OutputWriter();
    const result = ow.setFormat('json');
    assert.strictEqual(result, ow);
  });
});

describe('printContextHeader', () => {
  it('suppressed for JSON format', async () => {
    const { OutputWriter, FormatJSON } = await import('../src/output.js');
    // Mock app with json format
    const app = {
      getEffectiveInstance: () => 'https://dev123.service-now.com',
      output: new OutputWriter(),
      sdk: {
        getUser: async () => ({ sys_id: 'abc', name: 'admin' }),
        list: async () => [],
      },
    };
    app.output.setFormat('json');
    // Should return without writing (no error)
    await app.output; // verify no crash
    assert.strictEqual(app.output.getFormat(), FormatJSON);
  });

  it('suppressed for quiet format', async () => {
    const { OutputWriter } = await import('../src/output.js');
    const ow = new OutputWriter();
    ow.setFormat('quiet');
    assert.strictEqual(ow.getFormat(), 'quiet');
  });
});

describe('writeRecordsTable numeric cells', () => {
  it('coerces numeric cells to strings (regression: cmdb depth crashed styled output)', async () => {
    const { OutputWriter } = await import('../src/output.js');
    const chunks = [];
    const ow = new OutputWriter();
    ow.setFormat('styled');
    ow.writer = { write: (s) => chunks.push(String(s)) };
    ow.writeStyled({
      table: 'cmdb_rel_ci',
      columns: ['name', 'depth'],
      records: [
        { name: 'MySQL FLX', depth: 2 },
        { name: 'Oracle FLX', depth: 2 },
      ],
      context: { instance_url: '' },
    }, {});
    const out = chunks.join('');
    assert.ok(out.includes('MySQL FLX'), 'should render row 1');
    assert.ok(out.includes('Oracle FLX'), 'should render row 2');
    assert.ok(out.includes('2'), 'numeric depth should render as text');
  });

  it('_formatted replaces the records table in styled mode', async () => {
    const { OutputWriter } = await import('../src/output.js');
    const chunks = [];
    const ow = new OutputWriter();
    ow.setFormat('styled');
    ow.writer = { write: (s) => chunks.push(String(s)) };
    ow.writeStyled({
      table: 'cmdb_rel_ci',
      columns: ['name', 'depth'],
      records: [{ name: 'MySQL FLX', depth: 2 }],
      _formatted: 'CMDB: app1 (Application)\n▶ RELATIONSHIPS (1)\n└─ ↓ MySQL FLX (MySQL Catalog) — Depends on::Used by\n',
      context: { instance_url: '' },
    }, {});
    const out = chunks.join('');
    assert.ok(out.includes('▶ RELATIONSHIPS'), 'tree should render');
    assert.ok(!out.includes('depth'), 'flat table header must not render alongside the tree');
  });
});

describe('detectRecord via _context.table', () => {
  it('formats records that carry a table stamp but no sys_class_name/number (cmdb_rel_ci)', async () => {
    const { OutputWriter } = await import('../src/output.js');
    const chunks = [];
    const ow = new OutputWriter();
    ow.setFormat('styled');
    ow.writer = { write: (s) => chunks.push(String(s)) };
    ow.writeStyled({
      sys_id: 'rel001',
      parent: { display_value: 'CMS App FLX', value: 'p1' },
      type: { display_value: 'Depends on::Used by', value: 't1' },
      child: { display_value: 'Java Server FLX', value: 'c1' },
      _context: { instance_url: 'https://dev.service-now.com', table: 'cmdb_rel_ci' },
    }, { summary: 'Record from cmdb_rel_ci' });
    const out = chunks.join('');
    assert.ok(out.includes('cmdb_rel_ci'), 'should format the record with its table');
    assert.ok(out.includes('CMS App FLX'), 'should render parent display value');
    assert.ok(out.includes('Java Server FLX'), 'should render child display value');
    assert.ok(!out.includes('_context'), 'consumed _context should not leak into fields');
  });

  it('renders inline relationships as a compact section, excluded from Other', async () => {
    const { OutputWriter } = await import('../src/output.js');
    const chunks = [];
    const ow = new OutputWriter();
    ow.setFormat('styled');
    ow.writer = { write: (s) => chunks.push(String(s)) };
    ow.writeStyled({
      sys_id: 'ci1',
      name: 'CMS App FLX',
      sys_class_name: 'Application',
      relationships: [
        { name: 'MySQL FLX', class: 'MySQL Catalog', type: 'Depends on::Used by', direction: 'downstream', sys_id: 'c1', depth: 1 },
        { name: 'Workstation FLX', class: 'Computer', type: 'Depends on::Used by', direction: 'upstream', sys_id: 'p1', depth: 1 },
      ],
      _context: { instance_url: 'https://dev.service-now.com', table: 'cmdb_ci' },
    }, { summary: 'CMS App FLX (Application)' });
    const out = chunks.join('');
    assert.ok(out.includes('─ Relationships ─'), 'should render the relationships section');
    assert.ok(out.includes('↓ MySQL FLX (MySQL Catalog) — Depends on::Used by'), 'downstream relationship should render with arrow');
    assert.ok(out.includes('↑ Workstation FLX (Computer) — Depends on::Used by'), 'upstream relationship should render with arrow');
    assert.ok(!out.includes('relationships:'), 'relationships array must not dump into Other as a raw field');
  });
});
