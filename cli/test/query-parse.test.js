import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEncodedQuery } from '../src/query-parse.js';

const clause = (query, index = 0) => parseEncodedQuery(query).terms[index];

test('parser keeps the original query byte-identical', () => {
  const query = 'active=true^nameSTARTSWITHinc^ORpriority=1^NQstate=2^ORDERBYDESCnumber';
  const parsed = parseEncodedQuery(query);
  assert.equal(parsed.original, query);
  assert.equal(parsed.terms.map(t => t.raw).join('^OR'), parsed.terms.map(t => t.raw).join('^OR'));
});

test('parser recognises canonical operators and values without rewriting', () => {
  assert.deepEqual(
    { field: clause('nameLIKEinc').field, operator: clause('nameLIKEinc').operator, value: clause('nameLIKEinc').value },
    { field: 'name', operator: 'LIKE', value: 'inc' });
  assert.equal(clause('active=true').operator, '=');
  assert.equal(clause('priority>=2').operator, '>=');
  assert.equal(clause('assigned_toISEMPTY').operator, 'ISEMPTY');
  assert.equal(clause('sys_idIN1,2').operator, 'IN');
  assert.equal(clause('caller_in=abel').field, 'caller_in');
});

test('operator typo is reported with a canonical suggestion, not silently fixed', () => {
  const parsed = parseEncodedQuery('nameSTARTWITHfoo');
  assert.equal(parsed.invalid, true);
  const diagnostic = parsed.diagnostics.find(d => d.code === 'missing_operator');
  assert.ok(diagnostic, 'missing_operator diagnostic');
  assert.ok(diagnostic.suggestions.includes('STARTSWITH'));
  assert.equal(parsed.original, 'nameSTARTWITHfoo');
});

test('AND/OR/NQ connectors, directives and escaped carets are preserved', () => {
  const parsed = parseEncodedQuery('short_description=has^^caret^ORactive=true^NQstate=1^ORDERBYnumber');
  const clauses = parsed.terms.filter(t => t.kind === 'clause');
  assert.equal(clauses.length, 3);
  assert.equal(clauses[1].connector, 'OR');
  assert.equal(clauses[2].connector, 'NQ');
  assert.equal(clauses[0].value, 'has^caret');
  const directives = parsed.terms.filter(t => t.kind === 'directive');
  assert.equal(directives.length, 1);
  assert.equal(directives[0].directive, 'ORDERBY');
});

test('dot-walk paths tokenize without resolving here', () => {
  const term = clause('assigned_to.department.name=Support');
  assert.deepEqual(term.path, ['assigned_to', 'department', 'name']);
  assert.equal(term.value, 'Support');
});

test('dynamic javascript queries are unsupported, never invalid', () => {
  const parsed = parseEncodedQuery('user_name=javascript:gs.getUserName()');
  assert.equal(parsed.unsupported, true);
  assert.equal(parsed.invalid, false);
  assert.equal(parsed.terms[0].kind, 'unsupported');
});

test('empty queries parse to no terms', () => {
  assert.deepEqual(parseEncodedQuery('').terms, []);
  assert.deepEqual(parseEncodedQuery('   ').terms, []);
});
